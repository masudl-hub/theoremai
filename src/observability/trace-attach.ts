import { providerCompleteRequest } from '../kernel/registry/provider-request.ts';
import type { Protocol } from '../kernel/schema.ts';
import type { ResolvedGeneration, TurnEvent, TurnRequest } from '../kernel/types.ts';
import { tapeUpstream } from '../providers/shared/upstream-tape.ts';
import type { TraceRecord } from './trace-record.ts';
import { httpStatus, openAiFinishReason, tokensFromEvents } from './trace-usage.ts';

function attachResolved(
  record: TraceRecord,
  args: {
    safe: TurnRequest;
    model?: string;
    bucket?: string;
    generation?: ResolvedGeneration;
  },
): void {
  const { safe, model, bucket, generation } = args;
  if (safe.projectId) {
    record.projectId = safe.projectId;
  }
  if (safe.select) {
    record.select = safe.select;
  }
  if (safe.thinking !== undefined) {
    record.thinking = safe.thinking;
  }
  if (safe.metadata) {
    record.metadata = safe.metadata;
  }
  if (model) {
    record.model = {
      id: model,
      apiId: generation?.apiId ?? model,
    };
  }
  if (bucket) {
    record.bucket = bucket;
  }
  if (generation) {
    const traceGeneration = {
      thinking: generation.thinking,
      summaries: generation.summaries,
      temperature: generation.temperature,
      maxOutputTokens: generation.maxOutputTokens,
      builtins: generation.builtins,
      visibleTools: generation.tools.visible,
      structured: generation.structured,
      image: generation.image,
    };
    record.generation = traceGeneration;
  }
}

async function attachTape(
  record: TraceRecord,
  args: {
    upstream?: unknown;
    canary?: string;
    system?: string;
    generation?: ResolvedGeneration;
    protocol?: Protocol;
  },
): Promise<void> {
  const { upstream, canary, system, generation, protocol } = args;
  if (upstream !== undefined) {
    record.upstreamLog = await tapeUpstream(upstream, canary ?? '');
  }
  if (generation && system !== undefined && protocol === 'geminiInteractions') {
    const { toInteractionsBody } = await import('../providers/google/interactions/framing.ts');
    record.wire = await tapeUpstream(
      toInteractionsBody(providerCompleteRequest(generation, system)),
      canary ?? '',
    );
  }
}

function attachUsageTokens(
  record: TraceRecord,
  done: Record<string, unknown> | undefined,
  events?: TurnEvent[],
): void {
  if (done?.usage !== undefined) {
    record.usage = done.usage;
    return;
  }
  if (!events) {
    return;
  }
  const tokens = tokensFromEvents(events);
  if (tokens) {
    record.usage = tokens;
  }
}

function attachUpstreamSummary(
  record: TraceRecord,
  upstream: unknown,
  done: Record<string, unknown> | undefined,
): void {
  const upStatus = httpStatus(upstream);
  const finishReason = openAiFinishReason(upstream);
  if (upStatus === undefined && !done && finishReason === undefined) {
    return;
  }
  record.upstream = {
    status: upStatus,
    id: done?.id,
    finish: done?.status ?? finishReason,
    serviceTier: done?.service_tier ?? done?.serviceTier,
  };
}

function attachUsage(
  record: TraceRecord,
  upstream: unknown,
  done: Record<string, unknown> | undefined,
  events?: TurnEvent[],
): void {
  attachUsageTokens(record, done, events);
  attachUpstreamSummary(record, upstream, done);
}

export { attachResolved, attachTape, attachUsage };
