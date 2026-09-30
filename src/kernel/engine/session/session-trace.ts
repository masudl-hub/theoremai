import { errorKind, isAbortError, TheoremError } from '../../../guardrails/error.ts';
import { resolveTraceWriter } from '../../../observability/policy.ts';
import { writeTrace } from '../../../observability/trace.ts';
import { buildRecord } from '../../../observability/trace-record.ts';
import type { TraceSink } from '../../../observability/trace-sink.ts';
import {
  type SpanHandle,
  startTrace,
  type TraceAttributes,
  type TraceSpan,
  type TraceTree,
  traceJson,
} from '../../../observability/trace-span.ts';
import type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
} from '../../../observability/types.ts';
import { liveFrameInput } from '../../../providers/google/live/framing.ts';
import { LIVE_FALLBACK_ROW } from '../../../providers/google/live/session.ts';
import type { SessionQueueItem } from '../../../providers/google/live/stream.ts';
import type { ProviderEvent, TurnEventOf } from '../../turn-events.ts';
import type {
  InteractionPart,
  ModelBinding,
  ProviderCompleteRequest,
  ResolvedGeneration,
  SessionRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnStop,
  TurnTokens,
} from '../../types.ts';
import { base64ToBytes, bytesToBase64 } from '../../util/base64.ts';
import { asRecord } from '../record.ts';
import {
  type CallUsage,
  callTokensEvent,
  heldAfter,
  observeCallEvent,
  startCallUsage,
} from '../runner/usage.ts';
import type { MediaTokenFamily, TokenCount } from '../token-estimate.ts';
import {
  type CallTrace,
  guardrailAttributes,
  guardrailCheckAttributes,
  OutputFold,
  optional,
  recordException,
  startCallTrace,
  traceLinks,
  usageAttributes,
} from '../turn-trace.ts';
import { sumTokens } from '../usage.ts';

type LiveCloser = 'host' | 'provider' | 'theorem';

/** Events that are the model's output: they mark a response as answering. */
const OUTPUT_EVENTS = new Set<ProviderEvent['type']>(['text', 'thought', 'media', 'tool']);
const MS_PER_S = 1000;

interface LiveTraceBinding {
  request: ProviderCompleteRequest;
  generation: ResolvedGeneration;
  binding: ModelBinding | undefined;
  family: MediaTokenFamily | undefined;
  /** The system prompt as sent, canary bound. */
  system: string;
  canary: string;
}

/** A frame sent before the response it belongs to opened. */
interface PendingFrame {
  timeUnixNano: string;
  body: Record<string, unknown>;
}

interface AudioRun {
  mimeType: string;
  chunks: string[];
}

/** One user message holding exactly one inline audio part: a realtime audio chunk. */
function audioChunk(msg: TurnHistoryMessage): { mimeType: string; data: string } | undefined {
  const [part, ...rest] = msg.parts ?? [];
  if (msg.role !== 'user' || msg.content || rest.length > 0) return undefined;
  return part?.type === 'audio' && 'data' in part ? part : undefined;
}

/** A run's chunks as one part over their concatenated bytes; one part each when any is not base64. */
function audioRunParts(run: AudioRun): InteractionPart[] {
  try {
    const decoded = run.chunks.map(base64ToBytes);
    const merged = new Uint8Array(decoded.reduce((size, bytes) => size + bytes.byteLength, 0));
    let offset = 0;
    for (const bytes of decoded) {
      merged.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return [{ type: 'audio', mimeType: run.mimeType, data: bytesToBase64(merged) }];
  } catch {
    // Not base64: keep each chunk as sent, so the record labels what it holds.
    return run.chunks.map((data) => ({ type: 'audio', mimeType: run.mimeType, data }));
  }
}

/**
 * Input sent since the previous response opened; a tool response is input to the response after the
 * one that asked. Never the whole session: under sliding-window compression what the model read of
 * it is unknowable. Contiguous audio of one format is one message.
 */
class LiveInput {
  private readonly items: (TurnHistoryMessage | AudioRun)[] = [];
  private run?: AudioRun;

  add(messages: readonly TurnHistoryMessage[]): void {
    for (const msg of messages) {
      const chunk = audioChunk(msg);
      if (chunk && this.run?.mimeType === chunk.mimeType) {
        this.run.chunks.push(chunk.data);
        continue;
      }
      this.run = chunk ? { mimeType: chunk.mimeType, chunks: [chunk.data] } : undefined;
      this.items.push(this.run ?? msg);
    }
  }

  messages(): TurnHistoryMessage[] {
    return this.items.map((item) =>
      'chunks' in item ? { role: 'user', parts: audioRunParts(item) } : item,
    );
  }
}

/** A frame without its resumption handle: the handle is a credential. */
function withoutHandle(frame: Record<string, unknown>): Record<string, unknown> {
  const setup = asRecord(frame.setup);
  const resumption = asRecord(setup?.sessionResumption);
  if (setup && resumption && 'handle' in resumption) {
    const { handle: _handle, ...rest } = resumption;
    return { ...frame, setup: { ...setup, sessionResumption: rest } };
  }
  const update = asRecord(frame.sessionResumptionUpdate);
  if (update && 'newHandle' in update) {
    const { newHandle: _newHandle, ...rest } = update;
    return { ...frame, sessionResumptionUpdate: rest };
  }
  return frame;
}

function stringAttribute(key: string, value: unknown): TraceAttributes {
  return typeof value === 'string' ? { [key]: value } : {};
}

/** A provider session signal as `theorem.session` attributes, or `undefined` for a response event. */
function sessionSignal(event: ProviderEvent): TraceAttributes | undefined {
  if (event.type === 'session') {
    const { session } = event;
    if (session.kind === 'turn_complete') return undefined;
    return {
      kind: session.kind,
      ...('timeLeftMs' in session ? optional('time_left_ms', session.timeLeftMs) : {}),
    };
  }
  if (event.type !== 'evidence') return undefined;
  const { evidence } = event;
  if (evidence.kind === 'voice_activity') {
    const raw = asRecord(evidence.raw);
    return {
      kind: 'voice_activity',
      ...stringAttribute('activity', raw?.type),
      ...stringAttribute('audio_offset', raw?.audioOffset),
    };
  }
  if (evidence.kind === 'session_resumption') {
    return {
      kind: 'session_resumption',
      ...optional('resumable', evidence.resumable),
      handle_issued: Boolean(event.sessionResumptionHandle),
    };
  }
  return undefined;
}

/** A response between its first event and its `turnComplete`. */
interface OpenResponse {
  tree: TraceTree;
  call: CallTrace;
  usage: CallUsage;
  input: LiveInput;
  /** What the host received of its output, after guardrails. */
  delivered: OutputFold;
  /** The model has begun its output; later input transcription is for the next response. */
  answering: boolean;
  /** `interrupted` outranks `generation_complete`: output stopped before it ended. */
  stop?: TurnStop;
  /** Its `turnComplete` arrived; `settle` closes it. */
  complete: boolean;
}

interface LiveTraceEnd {
  /** Thrown out of the session (an abort is recorded as cancelled). */
  thrown?: unknown;
}

// Each record is written as soon as it is complete, so a long session never holds its whole trace.
class LiveTrace {
  readonly root: SpanHandle;
  private bound?: LiveTraceBinding;
  private response?: OpenResponse;
  private lastResponse?: SpanHandle;
  private pendingFrames: PendingFrame[] = [];
  private pendingInput = new LiveInput();
  private pendingHeard: ProviderEvent[] = [];
  /** What the provider holds from answered responses, for estimating unreported usage. */
  private held?: TokenCount;
  private readonly tokens: TurnTokens[] = [];
  private responses = 0;
  private readonly callParents = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  private failure?: Error;
  /** The provider closed the session after warning it would (`goAway`). */
  private endedByGoAway = false;
  private socketHasClosed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly tree: TraceTree,
    private readonly out: {
      sink: TraceSink;
      policy: ResolvedObservabilityPolicy;
      metadata?: Record<string, unknown>;
    },
    private readonly identity: TraceAttributes,
  ) {
    this.root = tree.root;
  }

  /** Attach the resolved request; frames are recorded from here on. */
  bind(binding: LiveTraceBinding): void {
    this.bound = binding;
  }

  /** The adapter's `tapUpstream`: every frame sent, as it is sent. */
  readonly sent = (row: Record<string, unknown>): void => {
    if (row.eventType === LIVE_FALLBACK_ROW) {
      this.keyFallback(row);
      return;
    }
    const frame = asRecord(row.body);
    if (!frame) return;
    const body = withoutHandle(frame);
    if ('setup' in frame) {
      this.root.event('theorem.wire.request', { body: traceJson(body) });
      return;
    }
    this.pendingInput.add(liveFrameInput(frame));
    this.pendingFrames.push({ timeUnixNano: this.root.nowUnixNano(), body });
  };

  /** The pinned key was refused for quota at setup; the session reopens on the fallback slot, which its responses name. */
  private keyFallback(row: Record<string, unknown>): void {
    const to = String(row.keySlot);
    this.root.event('theorem.session', {
      kind: 'key_fallback',
      key_slot: String(row.from),
      to_key_slot: to,
      'error.type': String(row.errorKind),
      error: String(row.error),
    });
    const bound = this.bound;
    if (bound) this.bound = { ...bound, request: { ...bound.request, keySlot: to } };
  }

  setup(frame: Record<string, unknown>): void {
    this.root.event('theorem.upstream.row', { row: traceJson(frame) });
    this.root.event('theorem.session', { kind: 'setup_complete' });
  }

  /** One received queue item, before guardrails. */
  receive(item: SessionQueueItem): void {
    switch (item.type) {
      case 'batch':
        for (const event of item.events) this.route(event);
        this.row(item.row);
        return;
      case 'row':
        this.row(item.row);
        return;
      case 'error':
        if (item.row) this.row(item.row);
        this.failure ??= item.error;
        return;
      case 'closed':
        this.socketClosed(item.code, item.reason, 'provider', item);
        // A close the provider warned of ends the session; it is not the session's failure.
        if (item.goAway) this.endedByGoAway = true;
        else this.failure ??= item.error;
        return;
    }
  }

  /**
   * One event as the host received it. Output reaches the host only after
   * `receive` opened its response, so every output part lands on the open one;
   * a transcript of the user's speech is input, recorded where it was heard.
   */
  delivered(event: TurnEvent): void {
    if (event.type === 'evidence' && event.evidence.kind === 'input_transcription') return;
    this.response?.delivered.add(event, this.root.nowUnixNano());
  }

  /** A guardrail decision on the model's output: on the open response. */
  outbound(event: TurnEventOf<'guardrail'>): void {
    if (this.response) this.response.call.guardrail(event.guardrail);
    else this.inbound(event);
  }

  /** A guardrail decision on the session (inbound text): on the session span. */
  inbound(event: TurnEventOf<'guardrail'>): void {
    this.root.event('theorem.guardrail', guardrailAttributes(event.guardrail));
  }

  /** One run of the gate on the model's output, on the open response: a decision after it is its. */
  outboundTime(ms: number): void {
    this.response?.call.guardTime('live_output', ms);
  }

  /** The check on text the host sent into the session, pass or decision, with its time. */
  inboundCheck(ms: number, event: TurnEventOf<'guardrail'> | undefined): void {
    this.root.event(
      'theorem.guardrail',
      guardrailCheckAttributes('live_input', ms, event?.guardrail, {
        stage: 'live_inbound',
        trust: 'untrusted',
      }),
    );
  }

  /**
   * Record the socket closing; the first close is the one that ended the
   * session. A provider close carries its warning (`goAway`) and what the code
   * means as a failure, so a warned close stays fully diagnosable.
   */
  socketClosed(
    code: number,
    reason: string,
    initiator: LiveCloser,
    provider?: Extract<SessionQueueItem, { type: 'closed' }>,
  ): void {
    if (this.socketHasClosed) return;
    this.socketHasClosed = true;
    const goAway = provider?.goAway;
    this.root.event('theorem.session', {
      kind: 'closed',
      code,
      reason,
      initiator,
      ...(provider?.error ? { 'error.type': errorKind(provider.error) } : {}),
      ...(goAway
        ? {
            cause: 'go_away',
            ...optional('time_left_ms', goAway.timeLeftMs),
            closed_after_ms: goAway.closedAfterMs,
          }
        : {}),
    });
  }

  /**
   * Close the response whose `turnComplete` arrived and write its record.
   * Returns its one `tokens` event, reported or estimated.
   */
  async settle(): Promise<TurnEvent | undefined> {
    return this.response?.complete ? await this.endResponse({}) : undefined;
  }

  /** The span a `done` ends: the open response, else the last one. */
  responseTraceparent(): string | undefined {
    return (this.response?.call.span ?? this.lastResponse)?.traceparent();
  }

  /**
   * Open the record for one `executeTool` call, under the response that asked
   * for it (the session when the call id is unknown). `finish` writes it.
   */
  toolRecord(callId: string): {
    open: (name: string, attributes: TraceAttributes) => SpanHandle;
    finish: () => void;
  } {
    let tree: TraceTree | undefined;
    return {
      open: (name, attributes) => {
        tree = startTrace(name, {
          attributes: { ...this.identity, ...attributes },
          traceparent: this.callParents.get(callId) ?? this.root.traceparent(),
          clock: this.tree.clock,
        });
        return tree.root;
      },
      finish: () => {
        if (tree) this.write(tree.collect());
      },
    };
  }

  /** End the session: close what is open, write the session record, wait for every write. */
  close(end: LiveTraceEnd): Promise<void> {
    this.closing ??= this.finish(end);
    return this.closing;
  }

  private async finish(end: LiveTraceEnd): Promise<void> {
    const aborted = end.thrown !== undefined && isAbortError(end.thrown);
    const thrown = aborted ? undefined : (end.thrown ?? this.failure);
    if (this.response) {
      await this.endResponse(thrown === undefined ? { cancelled: true } : { thrown });
    }
    // Sent after the last response: no response read it.
    for (const frame of this.pendingFrames) {
      this.root.event('theorem.wire.request', { body: traceJson(frame.body) }, frame.timeUnixNano);
    }
    this.pendingFrames = [];
    const tokens = sumTokens(this.tokens);
    this.root.set({
      ...(tokens ? usageAttributes(tokens) : {}),
      'theorem.steps': this.responses,
      ...(aborted ? { 'theorem.stop.kind': 'cancelled' } : {}),
      ...(!aborted && this.endedByGoAway ? { 'theorem.stop.kind': 'go_away' } : {}),
    });
    if (thrown !== undefined) {
      recordException(this.root, thrown);
      this.root.set({ 'error.type': errorKind(thrown) });
      this.root.end({ code: 'ERROR', message: errorKind(thrown) });
    } else {
      // A warned close is no verdict: neither failed nor known to be fine.
      this.root.end(aborted || this.endedByGoAway ? { code: 'UNSET' } : { code: 'OK' });
    }
    this.write(this.tree.collect());
    await this.writes;
  }

  private route(event: ProviderEvent): void {
    const signal = sessionSignal(event);
    if (signal) {
      this.root.event('theorem.session', signal);
      return;
    }
    if (event.type === 'tool' && event.tool.phase === 'cancel') {
      (this.response?.call.span ?? this.root).event('theorem.tool.cancel', {
        'gen_ai.tool.call.id': event.tool.callId,
        'gen_ai.tool.name': event.tool.name,
      });
      return;
    }
    const kind = event.type === 'evidence' ? event.evidence.kind : undefined;
    if (kind === 'input_transcription' && !(this.response && !this.response.answering)) {
      // Heard after the model began answering: input for the next response.
      this.pendingHeard.push(event);
      return;
    }
    const response = this.open();
    if (event.type === 'session') {
      response.complete = true;
      return;
    }
    observeCallEvent(response.usage, event);
    response.call.observe(event);
    if (!response.answering && (OUTPUT_EVENTS.has(event.type) || kind === 'output_transcription')) {
      // The reply's first chunk, from the response's first input frame: what a person waited.
      response.call.span.set({
        'gen_ai.response.time_to_first_chunk': response.call.span.msSinceStart() / MS_PER_S,
      });
      response.answering = true;
    }
    if (event.type === 'tool' && event.tool.phase === undefined) {
      this.callParents.set(event.tool.callId, response.call.span.traceparent());
    }
    if (event.type === 'done' && response.stop?.kind !== 'interrupted') {
      response.stop = event.stop;
    }
  }

  private row(row: Record<string, unknown>): void {
    const span = this.response?.call.span ?? this.root;
    span.event('theorem.upstream.row', { row: traceJson(withoutHandle(row)) });
  }

  private open(): OpenResponse {
    if (this.response) return this.response;
    const bound = this.bound;
    if (!bound) {
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      throw new TheoremError('internal', 'Live trace received a response before it was bound');
    }
    const usage = startCallUsage(bound.system, { history: [], input: [] }, this.held);
    // A response starts at its first input frame, so its duration includes the model's listening time.
    const startTimeUnixNano = this.pendingFrames[0]?.timeUnixNano;
    let tree: TraceTree | undefined;
    const call = startCallTrace(
      (name, options) => {
        tree = startTrace(name, {
          ...options,
          // Each record stands alone (the session record may never be written): it names its agent.
          attributes: { ...this.identity, ...options.attributes },
          traceparent: this.root.traceparent(),
          clock: this.tree.clock,
          ...(startTimeUnixNano ? { startTimeUnixNano } : {}),
        });
        return tree.root;
      },
      {
        req: bound.request,
        usage,
        binding: bound.binding,
        transport: bound.generation.transport,
        step: this.responses + 1,
      },
    );
    if (!tree) {
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      throw new TheoremError('internal', 'Live response span was not opened');
    }
    // A Live response streams over the session socket; no HTTP try says so.
    call.span.set({ 'gen_ai.request.stream': true });
    for (const frame of this.pendingFrames) {
      call.span.event('theorem.wire.request', { body: traceJson(frame.body) }, frame.timeUnixNano);
    }
    const response: OpenResponse = {
      tree,
      call,
      usage,
      input: this.pendingInput,
      delivered: new OutputFold(),
      answering: false,
      complete: false,
    };
    for (const heard of this.pendingHeard) call.observe(heard);
    this.pendingFrames = [];
    this.pendingInput = new LiveInput();
    this.pendingHeard = [];
    this.response = response;
    return response;
  }

  /**
   * Close the open response and write its record. A response ended by the
   * session closing has no usage event: what was billed is unknown.
   */
  private async endResponse(end: {
    thrown?: unknown;
    cancelled?: boolean;
  }): Promise<TurnEvent | undefined> {
    const response = this.response;
    const bound = this.bound;
    if (!(response && bound)) return undefined;
    this.response = undefined;
    this.responses += 1;
    response.usage.conversation = { history: response.input.messages(), input: [] };
    const answered = end.thrown === undefined && !end.cancelled;
    const tokens = answered
      ? await callTokensEvent(response.usage, bound.generation, bound.family)
      : undefined;
    if (answered) this.held = await heldAfter(response.usage, bound.family);
    // Beside `output.messages` (what the model produced): what the host received of it.
    response.call.span.set({
      'theorem.output.delivered': [{ role: 'assistant', parts: response.delivered.parts }],
    });
    response.call.end({
      ...(tokens?.tokens ? { tokens: tokens.tokens } : {}),
      stop: end.cancelled ? { kind: 'cancelled' } : response.stop,
      ...(end.thrown === undefined ? {} : { thrown: end.thrown }),
    });
    if (tokens?.tokens) this.tokens.push(tokens.tokens);
    this.lastResponse = response.call.span;
    this.write(response.tree.collect());
    return tokens;
  }

  /** Build and write one record, after every earlier write. */
  private write(spans: TraceSpan[]): void {
    const record = buildRecord({
      spans,
      policy: this.out.policy,
      canaries: this.bound ? [this.bound.canary] : [],
      ...(this.out.metadata ? { metadata: this.out.metadata } : {}),
    });
    this.writes = this.writes.then(() => writeTrace(this.out.sink, record, this.out.policy));
  }
}

/**
 * Open a session's trace: its `invoke_agent` span under the host's `traceparent`,
 * written under `observability`, the session's profile's block.
 */
function startLiveTrace(
  req: SessionRequest,
  observability: ProfileObservabilitySpec | undefined,
  sinkOverride?: TraceSink,
): LiveTrace {
  const { sink, policy } = resolveTraceWriter({ override: sinkOverride, observability });
  const identity: TraceAttributes = {
    'gen_ai.agent.name': req.profile,
    ...optional('gen_ai.conversation.id', req.conversationId),
  };
  const tree = startTrace(`invoke_agent ${req.profile}`, {
    kind: 'INTERNAL',
    attributes: { 'gen_ai.operation.name': 'invoke_agent', ...identity },
    links: traceLinks(req.links),
    ...(req.traceparent ? { traceparent: req.traceparent } : {}),
  });
  return new LiveTrace(
    tree,
    { sink, policy, ...(req.metadata ? { metadata: req.metadata } : {}) },
    identity,
  );
}

export type { LiveCloser, LiveTrace, LiveTraceBinding, LiveTraceEnd };
export { startLiveTrace };
