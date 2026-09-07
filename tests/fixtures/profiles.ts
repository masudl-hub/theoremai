import type { ModelBinding, Profile, Provider } from '../../src/kernel/types.ts';

/** Minimal typed profile for provider / probe tests (no casts). */
export function stubProfile(opts: {
  protocol: 'geminiInteractions' | 'openAi' | 'geminiLive';
  provider: Provider;
  role?: 'text' | 'speech' | 'image' | 'live';
  id?: string;
}): Profile {
  const role = opts.role ?? 'text';
  const id = opts.id ?? 'test-profile';
  const binding: ModelBinding = {
    protocol: opts.protocol,
    provider: opts.provider,
    apiId: 'stub-model',
    efforts: { normal: 'minimal' },
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
      models: { stub: binding },
      speech: { voice: 'Kore', format: 'pcm' },
      guardrails,
    };
  }
  if (role === 'image') {
    return {
      type: 'image',
      id,
      identity: { handle: id },
      models: { stub: binding },
      image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/png' },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails,
    };
  }
  if (role === 'live') {
    return {
      type: 'live',
      id,
      identity: { handle: id },
      models: { stub: binding },
      live: { voice: 'Aoede' },
      tools: { allow: [] },
      guardrails,
    };
  }
  return {
    type: 'text',
    id,
    identity: { handle: id },
    models: { stub: binding },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: null },
    guardrails,
  };
}
