import { z } from 'zod';
import { BOUNDARIES, recordOf } from '../guardrails/boundaries.ts';
import { DETECT_ACTIONS, DETECTORS } from '../guardrails/detectors.ts';
import { LEXICON_KEYS } from '../guardrails/lexicon.ts';
import { BLOCKED_REPLY_ON_BLOCK } from '../guardrails/types.ts';
import {
  CACHE_MODES,
  CACHE_TTLS,
  COMPACTION_METERS,
  COMPACTION_TIMINGS,
  CONTEXT_SENDERS,
  CONTINUE_STOP_KINDS,
  KEY_SLOT_NAME,
  LIVE_ACTIVITY_HANDLINGS,
  LIVE_END_SENSITIVITIES,
  LIVE_START_SENSITIVITIES,
  PROTOCOLS,
  PROVIDERS,
  SPEECH_AUDIO_FORMATS,
  STREAM_MODES,
  THINKING_LEVELS,
} from '../kernel/schema.ts';
import type { Equals } from '../kernel/util/exact-type.ts';
import { traceAttributesSchema } from '../observability/trace-schema.ts';
import type { ProfileInterface } from './types.ts';

const modelBinding = z.object({
  protocol: z.enum(PROTOCOLS),
  provider: z.enum(PROVIDERS),
  apiId: z.string(),
  efforts: z.record(z.string(), z.enum(THINKING_LEVELS)).optional(),
  defaultEffort: z.string().optional(),
  allowEffortSelect: z.boolean().optional(),
  summaries: z.boolean().optional(),
  maxOutputTokens: z.number().optional(),
  temperature: z.number().optional(),
  builtInTools: z.array(z.string()).optional(),
  key: z.string().regex(KEY_SLOT_NAME).optional(),
  fallbackKey: z.string().regex(KEY_SLOT_NAME).optional(),
  compaction: z
    .object({
      maxTokens: z.number(),
      compactAt: z.number(),
      previousExchanges: z.number(),
      profile: z.string().optional(),
      timing: z.enum(COMPACTION_TIMINGS),
      meter: z.enum(COMPACTION_METERS).optional(),
    })
    .optional(),
  cache: z.object({ mode: z.enum(CACHE_MODES), ttl: z.enum(CACHE_TTLS).optional() }).optional(),
  store: z.boolean().optional(),
  persistViaInteractionId: z.boolean().optional(),
  server: z.string().optional(),
});

const outputs = z.object({
  structured: z
    .union([
      z.string(),
      z.object({ by: z.string(), map: z.record(z.string(), z.string()), fallback: z.string() }),
      z.null(),
    ])
    .optional(),
  streaming: z
    .object({ mode: z.enum(STREAM_MODES).optional(), streamThoughts: z.boolean().optional() })
    .optional(),
});

const actions = z.object(recordOf(BOUNDARIES, () => z.enum(DETECT_ACTIONS)));

const detect = z.object(recordOf(DETECTORS, () => actions));

const hostDetector = z.object({
  id: z.string(),
  label: z.string(),
  actions,
  names: z.array(z.string()),
  find: z.boolean(),
});

const urlAllow = z.object({ hosts: z.array(z.string()), fromTools: z.boolean() });

const guardrails = z.object({
  quota: z.object({ perDay: z.number() }).optional(),
  detect,
  patterns: z
    .partialRecord(
      z.enum(DETECTORS),
      z.object({ theorem: z.boolean(), names: z.array(z.string()) }),
    )
    .optional(),
  host: z.array(hostDetector).optional(),
  allow: z.object({ ungiven_images: urlAllow, ungiven_links: urlAllow }),
  blockedReply: z.object({ onBlock: z.enum(BLOCKED_REPLY_ON_BLOCK), maxRetries: z.number() }),
});

const scrubSwitch = z.union([z.boolean(), z.object({ theorem: z.boolean(), host: z.boolean() })]);

const observability = z.object({
  record: z.boolean(),
  writeTo: z.union([z.literal(false), z.string()]).optional(),
  sampleRate: z.number(),
  include: z.object({
    upstreamLog: z.boolean(),
    outboundWire: z.boolean(),
    evidenceRaw: z.boolean(),
    usage: z.boolean(),
    guardrailDecisions: z.boolean(),
    guardrailMatchPreview: z.boolean(),
  }),
  scrub: z.object({ sensitive: scrubSwitch, injection: scrubSwitch, canary: scrubSwitch }),
  resource: traceAttributesSchema,
  retainForDays: z.number(),
  rotateAfterMiB: z.number(),
  hasOnWriteError: z.boolean(),
});

const inputs = z.object({
  text: z.boolean(),
  attachments: z.object({ accept: z.array(z.string()), acceptAttr: z.string() }).nullable(),
  voice: z.object({ accept: z.array(z.string()) }).nullable(),
  maxFiles: z.number().optional(),
  maxBytes: z.number().optional(),
  maxTurnBytes: z.number().optional(),
  limitsByMime: z.record(z.string(), z.number()).optional(),
  slots: z.record(z.string(), z.array(z.string())).optional(),
  context: z.object({ from: z.array(z.enum(CONTEXT_SENDERS)), maxChars: z.number() }).optional(),
});

const resumption = z.object({
  allowContinue: z.array(z.enum(CONTINUE_STOP_KINDS)).optional(),
  autoContinue: z.array(z.enum(CONTINUE_STOP_KINDS)).optional(),
  maxContinues: z.number().optional(),
});

const mediaTurnBehaviour = z.object({ resumption: resumption.optional() });

const tools = z.object({
  allow: z.array(z.string()),
  page: z.array(z.string()),
  t2Loader: z.string().optional(),
});

const common = {
  id: z.string(),
  models: z.record(z.string(), modelBinding),
  defaultModel: z.string(),
  allowModelSelect: z.boolean().optional(),
  maxSteps: z.number().optional(),
  key: z.string().regex(KEY_SLOT_NAME).optional(),
  fallbackKey: z.string().regex(KEY_SLOT_NAME).optional(),
  lexicon: z.partialRecord(z.enum(LEXICON_KEYS), z.string()),
  guardrails: guardrails.optional(),
  observability: observability.optional(),
};

const systemPrompt = z.union([
  z.string(),
  z
    .array(z.union([z.string(), z.strictObject({ private: z.string().min(1) })]))
    .min(1)
    .readonly(),
]);

const identity = z.object({
  handle: z.string(),
  system: systemPrompt.optional(),
  systemByRole: z.record(z.string(), systemPrompt).optional(),
});

const profileInterface = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('text'),
    identity,
    outputs: outputs.optional(),
    inputs,
    tools,
    turnBehaviour: z
      .object({ resumption: resumption.optional(), allowSteering: z.boolean().optional() })
      .optional(),
    canStop: z.literal(true),
    allowSteering: z.boolean(),
  }),
  z.object({
    ...common,
    type: z.literal('image'),
    identity,
    outputs: outputs.optional(),
    image: z.object({
      aspectRatio: z.string().optional(),
      resolution: z.string().optional(),
      mimeType: z.string().optional(),
      quality: z.string().optional(),
      background: z.string().optional(),
      n: z.number().int().min(1).optional(),
      seed: z.number().int().optional(),
      outputCompression: z.number().int().min(0).max(100).optional(),
      references: z
        .array(
          z.union([
            z.object({ mimeType: z.string(), data: z.string(), name: z.string().optional() }),
            z.object({ mimeType: z.string(), uri: z.string(), name: z.string().optional() }),
          ]),
        )
        .optional(),
      includeText: z.boolean().optional(),
    }),
    inputs,
    tools,
    turnBehaviour: mediaTurnBehaviour.optional(),
    canStop: z.literal(true),
  }),
  z.object({
    ...common,
    type: z.literal('speech'),
    identity: z.object({ handle: z.string() }),
    outputs: outputs.optional(),
    speech: z.object({
      voice: z.string().optional(),
      format: z.enum(SPEECH_AUDIO_FORMATS).optional(),
    }),
    inputs,
    turnBehaviour: mediaTurnBehaviour.optional(),
    canStop: z.literal(true),
  }),
  z.object({
    ...common,
    type: z.literal('live'),
    identity,
    inputs: inputs.pick({ slots: true, context: true }).optional(),
    live: z.object({
      ingress: z
        .object({
          audio: z.boolean().optional(),
          video: z.boolean().optional(),
          text: z.boolean().optional(),
        })
        .optional(),
      voice: z.string().optional(),
      vad: z
        .object({
          activityHandling: z.enum(LIVE_ACTIVITY_HANDLINGS).optional(),
          startSensitivity: z.enum(LIVE_START_SENSITIVITIES).optional(),
          endSensitivity: z.enum(LIVE_END_SENSITIVITIES).optional(),
          prefixPaddingMs: z.number().optional(),
          silenceDurationMs: z.number().optional(),
        })
        .optional(),
      sessionResumption: z.boolean().optional(),
      contextCompression: z
        .object({
          triggerTokens: z.number().optional(),
          slidingWindow: z.object({ targetTokens: z.number().optional() }),
        })
        .optional(),
      transcription: z
        .object({ input: z.boolean().optional(), output: z.boolean().optional() })
        .optional(),
    }),
    tools: tools.pick({ allow: true, page: true }),
    turnBehaviour: z.object({ allowSteering: z.boolean().optional() }).optional(),
  }),
]);
true satisfies Equals<z.infer<typeof profileInterface>, ProfileInterface>;
/** `ProfileInterface`, checked: unnamed fields are dropped, a malformed one fails. */
export const profileInterfaceSchema: z.ZodType<ProfileInterface> = profileInterface;
