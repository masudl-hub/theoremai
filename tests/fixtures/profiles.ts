import type { Profile, Provider, TurnProfileModelSpec } from '../../src/kernel/types.ts';

/** Minimal typed profile for provider / probe tests (no casts). */
export function stubProfile(opts: {
  protocol: 'geminiInteractions' | 'openAi';
  provider: Provider;
  role?: 'text' | 'speech' | 'image';
  id?: string;
}): Profile {
  const role = opts.role ?? 'text';
  const id = opts.id ?? 'test-profile';
  const model: TurnProfileModelSpec = {
    protocol: opts.protocol,
    provider: opts.provider,
    allow: [],
    config: {},
  };
  const guardrails = {
    canary: true,
    sanitizeInput: true,
    redactSensitive: true,
    quota: { perDay: 1 },
  } as const;

  if (role === 'speech') {
    return {
      type: 'speech',
      id,
      identity: { handle: id },
      model,
      speech: { voice: 'Kore', format: 'pcm' },
      guardrails,
    };
  }
  if (role === 'image') {
    return {
      type: 'image',
      id,
      identity: { handle: id },
      model,
      image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/png' },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails,
    };
  }
  return {
    type: 'text',
    id,
    identity: { handle: id },
    model,
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: null },
    guardrails,
  };
}
