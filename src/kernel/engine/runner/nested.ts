import type { ErrorKind } from '../../../guardrails/error.ts';
import { TheoremError, throwIfAborted } from '../../../guardrails/error.ts';
import { lexiconText } from '../../../guardrails/lexicon.ts';
import type { SpanHandle } from '../../../observability/trace-span.ts';
import {
  nestedRegisteredProvider,
  resolveRegisteredTurnProvider,
} from '../../provider-dispatch.ts';
import type { KernelRegistry } from '../../registry/kernel-registry.ts';
import {
  type AgentCaller,
  type AgentRun,
  agentProfileProblem,
  agentToolOutputOf,
} from '../../tools/agent.ts';
import type { AgentCallRequest, ToolFailure } from '../../tools/types.ts';
import type {
  ModelBinding,
  ModelProvider,
  Profile,
  TurnEvent,
  TurnEventOf,
  TurnRequest,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import { sumEventTokens } from '../usage.ts';

/** Errors only the host can fix: a nested turn throws them rather than failing quietly every call. */
const NESTED_THROWS: ReadonlySet<ErrorKind> = new Set(['config', 'request', 'auth', 'internal']);

function turnError(events: readonly TurnEvent[]): TurnEventOf<'error'> | undefined {
  return events.find((e): e is TurnEventOf<'error'> => e.type === 'error');
}

/** Runs one turn of a profile under a parent span, sharing the parent's record and canaries. */
type RunNestedTurn = (args: {
  req: TurnRequest;
  provider: ModelProvider;
  parent: SpanHandle;
  agentDepth: number;
}) => AsyncGenerator<TurnEvent>;

/**
 * Agent tool calls for one turn. `own` is the turn's model binding: its
 * provider runs a called agent on the same provider and protocol, and the
 * host's hook supplies any other. Without `own` (an invoke) the provider is
 * the host's own choice and runs as given.
 */
function createAgentCaller(args: {
  registry: KernelRegistry;
  req: Pick<TurnRequest, 'onAgentCall' | 'metadata'>;
  provider: ModelProvider | undefined;
  own: ModelBinding | undefined;
  /** 0 for the host's own turn or invoke. */
  depth: number;
  runNested: RunNestedTurn;
}): AgentCaller {
  const calls = new Map<string, number>();
  const { registry, req } = args;
  return {
    async *run({ tool, callId, input, caller, span, signal }): AsyncGenerator<TurnEvent, AgentRun> {
      const lexicon = caller.lexicon;
      const settled = (code: string, kind: ToolFailure['kind'], message: string): AgentRun => ({
        failure: { code, kind, message },
      });
      const made = calls.get(tool.name) ?? 0;
      if (tool.maxCallsPerTurn !== undefined && made >= tool.maxCallsPerTurn) {
        return settled(
          'call_limit',
          'declined',
          lexiconText('tool.agent_call_limit', { tool: tool.name }, lexicon),
        );
      }
      calls.set(tool.name, made + 1);

      const profile = registry.profiles.get(tool.profile);
      const problem = agentProfileProblem(profile, (name) => registry.tools.get(name));
      if (problem) {
        throw new TheoremError(
          'config',
          `Agent tool "${tool.name}" can't run '${tool.profile}': ${problem}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }

      const shaped = await req.onAgentCall?.({
        tool: tool.name,
        callId,
        profile: tool.profile,
        input,
        caller: caller.id,
        depth: args.depth + 1,
        ...(req.metadata ? { metadata: req.metadata } : {}),
        ...(signal ? { signal } : {}),
      });
      if (shaped && 'refuse' in shaped) {
        return settled('refused_by_host', 'declined', shaped.refuse);
      }
      const { provider: hostProvider, ...fields }: AgentCallRequest = shaped ?? {};
      const provider = hostProvider
        ? resolveRegisteredTurnProvider(args.registry, profile.id, fields.model, hostProvider)
        : args.provider
          ? nestedRegisteredProvider(args.provider, profile.id, fields.model)
          : resolveRegisteredTurnProvider(args.registry, profile.id, fields.model, {});
      if (!span) {
        throw new TheoremError('internal', `Agent tool "${tool.name}" ran without a span`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }

      const events: TurnEvent[] = [];
      for await (const event of args.runNested({
        req: {
          ...fields,
          profile: tool.profile,
          input: fields.input ?? { text: input.text },
          ...(signal ? { signal } : {}),
          ...(req.onAgentCall ? { onAgentCall: req.onAgentCall } : {}),
        },
        provider,
        parent: span,
        agentDepth: args.depth + 1,
      })) {
        events.push(event);
        yield event;
      }
      throwIfAborted(signal);
      return agentRunOf(events, tool.name, tool.profile, lexicon);
    },
  };
}

/** The agent's reply, or why there is none. Errors only the host can fix are thrown. */
function agentRunOf(
  events: readonly TurnEvent[],
  toolName: string,
  profileId: string,
  lexicon: Profile['lexicon'],
): AgentRun {
  const done = findLast(events, (e): e is TurnEventOf<'done'> => e.type === 'done');
  const tokens = done?.tokens ?? sumEventTokens(events);
  const usage = tokens ? { tokens } : {};
  const reported = turnError(events);
  if (reported && NESTED_THROWS.has(reported.errorKind)) {
    throw new TheoremError(
      reported.errorKind,
      `Agent '${profileId}' failed: ${reported.errorInternal ?? reported.error}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const stop = done?.stop.kind;
  if (stop !== 'completed' || reported) {
    return {
      failure: {
        code: 'agent_failed',
        kind: reported?.errorKind ?? 'failed',
        message: lexiconText('tool.agent_failed', { tool: toolName }, lexicon),
        details: { agent: profileId, ...(stop ? { stop } : {}) },
      },
      ...usage,
    };
  }
  return { output: agentToolOutputOf(events), ...usage };
}

export type { RunNestedTurn };
export { createAgentCaller, NESTED_THROWS, turnError };
