import {
  isAbortError,
  TheoremError,
  toErrorEvent,
  withPublicWording,
} from '../../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../../guardrails/events.ts';
import { resolveTraceWriter } from '../../observability/policy.ts';
import { writeTrace } from '../../observability/trace.ts';
import { buildRecord } from '../../observability/trace-record.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import {
  type SpanHandle,
  startTrace,
  type TraceAttributes,
} from '../../observability/trace-span.ts';
import { invokeAgentCaller } from '../engine/runner/mod.ts';
import { startToolTrace, type ToolCallEnd, toolSpanName } from '../engine/tool-trace.ts';
import { optional, traceLinks } from '../engine/turn-trace.ts';
import type { KernelRegistry } from '../registry/kernel-registry.ts';
import { pickModel } from '../registry/resolve.ts';
import { turnDoneOf } from '../turn-events.ts';
import type { Profile, TurnEvent, TurnRequest } from '../types.ts';
import { coordinateTool } from './coordinate.ts';
import { failureEvent, newCallId, toolCallArguments, toolCallRequestEvent } from './events.ts';
import {
  authorizeToolReplay,
  executeRegisteredTool,
  type ToolExecuteSettlement,
} from './execute.ts';
import type { ToolOperationClaim } from './operation.ts';
import { cloneTurnToolSnapshot, prepareTurnToolSnapshot, promoteLoadedTools } from './resolve.ts';
import { plainToolInput } from './schema.ts';
import type { InvokeToolRequest, TurnToolSnapshot } from './types.ts';

function turnRequestFromInvoke(request: InvokeToolRequest): TurnRequest {
  return {
    profile: request.profile,
    path: request.path,
    sessionPermissions: request.sessionPermissions,
    input: request.turnInput,
    model: request.model,
    host: request.host,
  };
}

async function prepareInvokeSnapshot(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  profile: Profile,
): Promise<TurnToolSnapshot> {
  const req = turnRequestFromInvoke(request);
  if (profile.type === 'decision') {
    throw new TheoremError('request', `Profile ${profile.id}: type 'decision' cannot invoke tools`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const model = profile.type === 'host' ? undefined : pickModel(profile, request.model);
  return await prepareTurnToolSnapshot(registry.tools, profile, req, model);
}

/**
 * The trace record is written however the call ends, including an early stop or a failure before
 * the tool. An unknown profile is recorded under the standard observability policy: there is none to read.
 */
async function* invokeTool(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  const known = registry.profiles.find(request.profile);
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: known?.observability,
    guardrails: known?.guardrails,
  });
  const callId = request.callId ?? newCallId(request.name);
  request = { ...request, operationId: request.operationId ?? crypto.randomUUID() };
  const tree = startTrace(toolSpanName(request.name), {
    attributes: {
      'gen_ai.agent.name': request.profile,
      ...optional('gen_ai.conversation.id', request.conversationId),
    },
    links: traceLinks(request.links),
    ...(request.traceparent ? { traceparent: request.traceparent } : {}),
  });
  const openSpan = (_name: string, attributes: TraceAttributes) => {
    tree.root.set(attributes);
    return tree.root;
  };
  const failBeforeTool = (end: ToolCallEnd) =>
    startToolTrace(openSpan, {
      name: request.name,
      callId,
      call: { arguments: toolCallArguments(plainToolInput(request.input)) },
    }).end(end);
  // why: Agent tool calls run nested turns in this record; their canaries are scrubbed from it.
  const canaries: string[] = [];
  try {
    const lexicon = known?.lexicon;
    const traceparent = tree.root.traceparent();
    for await (const event of invokeTraced(
      registry,
      request,
      callId,
      openSpan,
      failBeforeTool,
      traceparent,
      canaries,
    )) {
      // invariant: A match is the caught text itself; it leaves only when the profile asks for it.
      yield projectGuardrailTurnEvent(
        withPublicWording(event, lexicon),
        policy.include.guardrailMatchPreview,
      );
    }
  } catch (err) {
    failBeforeTool(
      isAbortError(err) ? { outcome: 'cancelled' } : { outcome: 'error', thrown: err },
    );
    throw err;
  } finally {
    await writeTrace(
      sink,
      buildRecord({
        spans: tree.collect(),
        policy,
        canaries,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }),
      policy,
    );
  }
}

async function* invokeTraced(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  callId: string,
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  failBeforeTool: (end: ToolCallEnd) => void,
  traceparent: string,
  canaries: string[],
): AsyncGenerator<TurnEvent> {
  const profile = registry.profiles.get(request.profile);
  const snapshot = request.snapshot
    ? cloneTurnToolSnapshot(request.snapshot)
    : await prepareInvokeSnapshot(registry, request, profile);

  // why: A model's call was already announced by its turn.
  if (request.callId === undefined) {
    yield toolCallRequestEvent(
      { name: request.name, callId, operationId: request.operationId },
      toolCallArguments(request.input),
    );
  }

  let gated = false;
  try {
    const settlement = yield* coordinateTool(
      request.execution,
      {
        operationId: request.operationId ?? crypto.randomUUID(),
        callId,
        profileId: profile.id,
        toolId: request.name,
      },
      {
        input: request.input,
        resume: request.resume,
        snapshot,
        context: {
          model: request.model,
          turnInput: request.turnInput,
          promoted: request.promoted,
        },
      },
      request.signal,
      (beginBody) =>
        invokePrepared(
          registry,
          request,
          profile,
          snapshot,
          callId,
          openSpan,
          failBeforeTool,
          canaries,
          beginBody,
        ),
      (outcome) =>
        authorizeToolReplay({
          outcome,
          tools: registry.tools,
          profile,
          name: request.name,
          resume: request.resume,
          snapshot,
        }),
    );
    gated = settlement.gated !== undefined;
  } catch (err) {
    yield toErrorEvent(err);
  }
  yield turnDoneOf({ stop: { kind: gated ? 'gate' : 'completed' }, traceparent }, snapshot);
}

async function* invokePrepared(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  profile: Profile,
  snapshot: TurnToolSnapshot,
  callId: string,
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  failBeforeTool: (end: ToolCallEnd) => void,
  canaries: string[],
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  if (request.promoted?.length) {
    const { failure } = promoteLoadedTools(registry.tools, snapshot, request.promoted, profile);
    if (failure) {
      failBeforeTool({ outcome: 'error', failure });
      yield failureEvent({ name: request.name, callId, operationId: request.operationId }, failure);
      return { failure, callNotStarted: true };
    }
  }
  const handlers = request.onStage ? [request.onStage] : [];
  return yield* executeRegisteredTool({
    tools: registry.tools,
    beginBody,
    agents: invokeAgentCaller(registry, request, canaries),
    profile,
    name: request.name,
    input: request.input,
    callId,
    ctx: {
      operationId: request.operationId,
      sessionPermissions: request.sessionPermissions,
      credentials: request.credentials,
      resolveHost: request.resolveHost,
      path: request.path,
      signal: request.signal,
      resume: request.resume,
      page: request.page,
      pageExecution: request.pageExecution,
      host: request.host,
    },
    snapshot,
    openSpan,
    stages: {
      handlers,
      profile,
      step: 1,
      history: () => [],
      injectAllowed: false,
      host: request.host,
      signal: request.signal,
    },
  });
}

export { invokeTool };
