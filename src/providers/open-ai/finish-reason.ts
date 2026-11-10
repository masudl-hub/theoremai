import type { TurnStop } from '../../kernel/turn-events.ts';

/** OpenAI-compatible normalized `finish_reason` (+ optional `native_finish_reason`). */
export function turnStopFromOpenAiFinishReason(
  finishReason: string | null | undefined,
  nativeFinishReason?: string | null,
): TurnStop {
  const native = nativeFinishReason?.trim() || finishReason?.trim() || undefined;
  const effective = (nativeFinishReason || finishReason || '').toLowerCase();
  if (!effective) return { kind: 'stream_incomplete', native };
  if (effective === 'network_error' || effective.includes('network')) {
    return { kind: 'provider_error', native };
  }
  return openAiFinishKind((finishReason || '').toLowerCase(), effective, native);
}

function openAiFinishKind(finish: string, effective: string, native: string | undefined): TurnStop {
  if (finish === 'stop') {
    return /error|fail/.test(effective)
      ? { kind: 'provider_error', native }
      : { kind: 'completed', native };
  }
  // probed 2026-11-04: OpenRouter ends a call the output limit cut off with `tool_calls`; only the upstream's own reason says `length`.
  if (finish === 'length' || effective === 'length') return { kind: 'length', native };
  if (finish === 'tool_calls' || finish === 'tool-calls') return { kind: 'tool', native };
  if (finish === 'content_filter' || finish === 'content-filter') {
    return { kind: 'filtered', native };
  }
  return { kind: 'provider_error', native };
}
