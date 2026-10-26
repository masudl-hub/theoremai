import './test-host.ts';
import { TOOL_KINDS, toolBoundary } from '../../src/guardrails/boundaries.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { requireModelProfile } from '../../src/kernel/registry/resolve.ts';
import { TAKE_OUT_INBOUND } from './take-out.ts';

/** What a profile that stops what it must not give away sets: a reply carrying it is stopped, a thought loses it. */
export const STOP_LEAKS = {
  canary_leak: { action: 'block', at: { thought: 'redact' } },
  prompt_leak: {
    action: 'block',
    at: {
      thought: 'redact',
      ...Object.fromEntries(
        TOOL_KINDS.map((kind) => [toolBoundary('tool_arguments', kind), 'flag']),
      ),
    },
  },
  marker_leak: { action: 'block', at: { thought: 'redact' } },
  ungiven_images: { action: 'block', at: { thought: 'redact' } },
} as const satisfies DetectSpec;

/** What a profile that takes out what it must not give away sets: each leak is replaced where it is written. */
export const TAKE_OUT_LEAKS = {
  canary_leak: 'redact',
  prompt_leak: { action: 'redact', at: STOP_LEAKS.prompt_leak.at },
  marker_leak: 'redact',
  ungiven_images: 'redact',
} as const satisfies DetectSpec;

/** The test host's `chat` under `detect`, registered as `id`. */
export function chatWith(id: string, detect: DetectSpec): string {
  const chat = requireModelProfile(getProfile('chat'), 'test');
  registerProfile(defineProfile({ ...chat, id, guardrails: { ...chat.guardrails, detect } }));
  return id;
}

/** `chat` taking out data and injection on the way in (`TAKE_OUT_INBOUND`). */
export const CHAT_TAKES_OUT_INBOUND = chatWith('chat_takes_out_inbound', TAKE_OUT_INBOUND);
/** `chat` stopping what it must not give away (`STOP_LEAKS`). */
export const CHAT_STOPS_LEAKS = chatWith('chat_stops_leaks', STOP_LEAKS);
/** `chat` taking out what it must not give away (`TAKE_OUT_LEAKS`). */
export const CHAT_TAKES_OUT_LEAKS = chatWith('chat_takes_out_leaks', TAKE_OUT_LEAKS);
