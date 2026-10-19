import {
  isAbortError,
  TheoremError,
  toErrorEvent,
  withPublicLabels,
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
import { inStep, runSideBySide, stepOrder } from '../engine/runner/step-order.ts';
import { startToolTrace, type ToolCallEnd, toolSpanName } from '../engine/tool-trace.ts';
import { endThrownSpan, optional, traceLinks } from '../engine/turn-trace.ts';
import type { KernelRegistry } from '../registry/kernel-registry.ts';
import { pickModel } from '../registry/resolve.ts';
import { turnDoneOf } from '../turn-events.ts';
import type { Profile, TurnEvent, TurnRequest } from '../types.ts';
import { coordinateTool } from './coordinate.ts';
import {
  failedActivity,
  failureEvent,
  newCallId,
  toolCallArguments,
  toolCallRequestEvent,
} from './events.ts';
import {
  authorizeToolReplay,
  executeRegisteredTool,
  type ToolExecuteSettlement,
} from './execute.ts';
import type { ToolOperationClaim } from './operation.ts';
import {
  cloneTurnToolSnapshot,
  prepareTurnToolSnapshot,
  profileToolsParallel,
  promoteLoadedTools,
} from './resolve.ts';
import { plainToolInput } from './schema.ts';
import type { ToolStageSupport } from './stage-run.ts';
import type { InvokeToolRequest, InvokeToolStepRequest, TurnToolSnapshot } from './types.ts';

function turnRequestFromInvoke(request: InvokeToolRequest | InvokeToolStepRequest): TurnRequest {
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
  request: InvokeToolRequest | InvokeToolStepRequest,
  profile: Profile,
): Promise<TurnToolSnapshot> {
  const req = turnRequestFromInvoke(request);
  if (profile.type === 'decision' || profile.type === 'embedding') {
    throw new TheoremError('request', `Profile ${profile.id}: type 'decision' cannot invoke tools`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const model = profile.type === 'host' ? undefined : pickModel(profile, request.model);
  return await prepareTurnToolSnapshot(registry.tools, profile, req, model);
}

type TraceTree = ReturnType<typeof startTrace>;

/**
 * One trace record around an invoke, written however it ends, including an early stop or a
 * failure before the tool. The profile's labels and guardrail policy shape every event. An unknown
 * profile is recorded under the standard observability policy: there is none to read.
 */
async function* invokeInTrace(
  registry: KernelRegistry,
  request: InvokeToolRequest | InvokeToolStepRequest,
  spanName: string,
  sinkOverride: TraceSink | undefined,
  run: {
    events: (tree: TraceTree, canaries: string[]) => AsyncGenerator<TurnEvent>;
    ended?: (tree: TraceTree) => void;
    failed: (tree: TraceTree, err: unknown) => void;
  },
): AsyncGenerator<TurnEvent> {
  const known = registry.profiles.find(request.profile);
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: known?.observability,
    guardrails: known?.guardrails,
  });
  const tree = startTrace(spanName, {
    attributes: {
      'gen_ai.agent.name': request.profile,
      ...optional('gen_ai.conversation.id', request.conversationId),
    },
    links: traceLinks(request.links),
    ...(request.traceparent ? { traceparent: request.traceparent } : {}),
  });
  // why: Agent tool calls run nested turns in this record; their canaries are scrubbed from it.
  const canaries: string[] = [];
  try {
    const labels = known?.labels;
    for await (const event of run.events(tree, canaries)) {
      // invariant: A match is the caught text itself; it leaves only when the profile asks for it.
      yield projectGuardrailTurnEvent(
        withPublicLabels(event, labels),
        policy.include.guardrailMatchPreview,
      );
    }
    run.ended?.(tree);
  } catch (err) {
    run.failed(tree, err);
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

/** Close the call's span for a failure before its tool ran. */
function failCallBeforeTool(
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  invoke: InvokeToolRequest,
  callId: string,
): (end: ToolCallEnd) => void {
  return (end) =>
    startToolTrace(openSpan, {
      name: invoke.name,
      callId,
      call: { arguments: toolCallArguments(plainToolInput(invoke.input)) },
    }).end(end);
}

/** The profile an invoke runs under, and its own copy of the tool snapshot. */
async function invokeSnapshot(
  registry: KernelRegistry,
  request: InvokeToolRequest | InvokeToolStepRequest,
): Promise<{ profile: Profile; snapshot: TurnToolSnapshot }> {
  const profile = registry.profiles.get(request.profile);
  const snapshot = request.snapshot
    ? cloneTurnToolSnapshot(request.snapshot)
    : await prepareInvokeSnapshot(registry, request, profile);
  return { profile, snapshot };
}

/** A call's name and the id it goes by, known before any of its events. */
export interface StartedCall {
  name: string;
  callId: string;
}

/** A started invoke: its call and its events. */
export interface StartedInvoke extends StartedCall {
  events: AsyncGenerator<TurnEvent>;
}

function invokeTool(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  return startInvoke(registry, request, sinkOverride).events;
}

function startInvoke(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): StartedInvoke {
  const callId = request.callId ?? newCallId(request.name);
  const invoke = {
    ...request,
    operationId: request.operationId ?? crypto.randomUUID(),
  };
  const openSpan = (tree: TraceTree) => (_name: string, attributes: TraceAttributes) => {
    tree.root.set(attributes);
    return tree.root;
  };
  const events = invokeInTrace(registry, invoke, toolSpanName(invoke.name), sinkOverride, {
    events: (tree, canaries) =>
      invokeTraced(
        registry,
        invoke,
        callId,
        openSpan(tree),
        failCallBeforeTool(openSpan(tree), invoke, callId),
        tree.root.traceparent(),
        canaries,
      ),
    failed: (tree, err) =>
      failCallBeforeTool(
        openSpan(tree),
        invoke,
        callId,
      )(isAbortError(err) ? { outcome: 'cancelled' } : { outcome: 'error', thrown: err }),
  });
  return { name: invoke.name, callId, events };
}

/**
 * Runs the host's calls as one step, the way a turn runs the model's. Every call the step names
 * itself is announced with the step's id before any runs. With `tools.parallel` they run side by
 * side, otherwise one at a time in the order given; a call whose `pre_tool` answers `waitFor`
 * starts once those calls in the step settle. Each call's events arrive as it gives them, and its
 * terminal `tool` event says it settled. The calls share one snapshot. A call that gates waits for
 * its own approval while the others run; the step then ends `gate`. One trace record holds a span
 * per call under the step's root, rooted under the host span when one is given.
 */
function invokeToolStep(
  registry: KernelRegistry,
  request: InvokeToolStepRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  return startInvokeStep(registry, request, sinkOverride).events;
}

/** One call of a started step: the id it goes by, and whether the step announces it. */
interface StepCall {
  callId: string;
  invoke: InvokeToolRequest;
  announce: boolean;
}

/** A started step: its calls in the order given, and the step's events. */
export interface StartedStep {
  calls: StartedCall[];
  events: AsyncGenerator<TurnEvent>;
}

function startInvokeStep(
  registry: KernelRegistry,
  request: InvokeToolStepRequest,
  sinkOverride?: TraceSink,
): StartedStep {
  const { calls: given, ...shared } = request;
  const calls = given.map((call): StepCall => {
    const callId = call.callId ?? newCallId(call.name);
    return {
      callId,
      invoke: {
        ...shared,
        name: call.name,
        input: call.input,
        callId,
        operationId: call.operationId ?? crypto.randomUUID(),
      },
      // why: A model's call was already announced by its turn; only a call the step names itself is announced here.
      announce: call.callId === undefined,
    };
  });
  const events = invokeInTrace(registry, request, `tool_step ${request.profile}`, sinkOverride, {
    events: (tree, canaries) =>
      invokeStepTraced(
        registry,
        request,
        calls,
        (name, attributes) => tree.root.child(name, { attributes }),
        tree.root.traceparent(),
        canaries,
      ),
    ended: (tree) => tree.root.end({ code: 'OK' }),
    failed: (tree, err) => {
      if (isAbortError(err)) tree.root.end();
      else endThrownSpan(tree.root, err);
    },
  });
  return {
    calls: calls.map(({ callId, invoke }) => ({ name: invoke.name, callId })),
    events,
  };
}

async function* invokeStepTraced(
  registry: KernelRegistry,
  request: InvokeToolStepRequest,
  calls: StepCall[],
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  traceparent: string,
  canaries: string[],
): AsyncGenerator<TurnEvent> {
  const { profile, snapshot } = await invokeSnapshot(registry, request);
  const stepId = crypto.randomUUID();
  for (const { callId, invoke, announce } of calls) {
    if (!announce) continue;
    yield toolCallRequestEvent(
      { name: invoke.name, callId, operationId: invoke.operationId },
      toolCallArguments(invoke.input),
      { stepId, stepCallCount: calls.length },
    );
  }
  const order = stepOrder(
    calls.map(({ callId }) => callId),
    profileToolsParallel(profile) === true,
    request.signal,
  );
  const step: InvokeStep = {
    stepCalls: calls.map(({ callId, invoke }) => ({
      callId,
      tool: invoke.name,
      input: toolCallArguments(invoke.input),
    })),
    wait: order.wait,
  };
  let gated = false;
  try {
    // why: As in a turn's step, one call that throws ends the step; the others are closed.
    const settlements = yield* runSideBySide(
      calls.map(({ callId, invoke }) =>
        inStep(order, callId, () =>
          runCall(
            registry,
            invoke,
            profile,
            snapshot,
            callId,
            openSpan,
            failCallBeforeTool(openSpan, invoke, callId),
            canaries,
            step,
          ),
        ),
      ),
    );
    gated = settlements.some((settlement) => settlement?.gated !== undefined);
  } catch (err) {
    yield toErrorEvent(err);
  }
  yield turnDoneOf(
    {
      stop: { kind: gated ? 'gate' : 'completed' },
      traceparent,
    },
    snapshot,
  );
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
  const { profile, snapshot } = await invokeSnapshot(registry, request);

  // why: A model's call was already announced by its turn.
  if (request.callId === undefined) {
    yield toolCallRequestEvent(
      { name: request.name, callId, operationId: request.operationId },
      toolCallArguments(request.input),
    );
  }

  let gated = false;
  try {
    const settlement = yield* runCall(
      registry,
      request,
      profile,
      snapshot,
      callId,
      openSpan,
      failBeforeTool,
      canaries,
    );
    gated = settlement.gated !== undefined;
  } catch (err) {
    yield toErrorEvent(err);
  }
  yield turnDoneOf(
    {
      stop: { kind: gated ? 'gate' : 'completed' },
      traceparent,
    },
    snapshot,
  );
}

/** The step a call runs in: the calls `pre_tool` sees and the wait its `waitFor` holds on. */
type InvokeStep = Pick<ToolStageSupport, 'stepCalls' | 'wait'>;

/** One call, coordinated: replayed when its operation already ran, else executed. */
function runCall(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  profile: Profile,
  snapshot: TurnToolSnapshot,
  callId: string,
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  failBeforeTool: (end: ToolCallEnd) => void,
  canaries: string[],
  step?: InvokeStep,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  return coordinateTool(
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
        step,
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
  step?: InvokeStep,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  if (request.promoted?.length) {
    const { failure } = promoteLoadedTools(registry.tools, snapshot, request.promoted, profile);
    if (failure) {
      failBeforeTool({ outcome: 'error', failure });
      yield failureEvent(
        {
          name: request.name,
          callId,
          operationId: request.operationId,
          activityFailed: failedActivity(request.name, profile.labels),
        },
        failure,
      );
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
      ...step,
    },
  });
}

export { invokeTool, invokeToolStep, startInvoke, startInvokeStep };
