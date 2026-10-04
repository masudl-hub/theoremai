// Each type is paired with a zod schema checked against it (`Equals`), so a field in one and
// not the other fails the build. Schemas are plain `z.object`, never `.strict()`: an unlisted
// field is dropped. An unmapped provider step is `evidence` of kind `provider_step`.

import { z } from 'zod';
import {
  type ErrorCopies,
  errorCopiesSchema,
  errorKindSchema,
  type GuardrailEvent,
  guardrailEventSchema,
} from '../guardrails/event-schemas.ts';
import type { ErrorKind } from '../guardrails/theorem-error.ts';
import {
  AWAITING_USER_INPUT_STATUS,
  COMPACTION_METERS,
  COMPACTION_OUTCOMES,
  type CompactionMeter,
  type CompactionOutcome,
  MEDIA_INPUT_KIND_VALUES,
  type MediaInputKind,
  PROVIDERS,
  type Provider,
  STAGE_APPLY_WARNING_CODES,
  type StageApplyWarningCode,
  TOOL_AUTH_TYPES,
  TOOL_PERMISSION,
  type ToolAuthType,
  type ToolPermission,
  TURN_STAGES,
  TURN_STOP_KINDS,
  type TurnStage,
  type TurnStopKind,
} from './schema.ts';
import type { Equals } from './util/exact-type.ts';

export type { ErrorCopies, ErrorKind, GuardrailEvent };

const jsonObject = z.record(z.string(), z.unknown());

const nonEmptyText = z.string().trim().min(1);

/** A text part of a history message. */
export interface InteractionTextPart {
  type: 'text';
  text: string;
}
const interactionTextPart = z.object({ type: z.literal('text'), text: z.string() });
true satisfies Equals<z.infer<typeof interactionTextPart>, InteractionTextPart>;

/** A media part of a history message, carried inline as base64. */
export interface InteractionMediaPart {
  type: MediaInputKind;
  mimeType: string;
  data: string;
}
const interactionMediaPart = z.object({
  type: z.enum(MEDIA_INPUT_KIND_VALUES),
  mimeType: z.string(),
  data: z.string(),
});
true satisfies Equals<z.infer<typeof interactionMediaPart>, InteractionMediaPart>;

/** The host owns the upload and cleanup; THEOREM only carries the reference. */
export interface InteractionMediaRefPart {
  type: MediaInputKind;
  mimeType: string;
  uri: string;
}
const interactionMediaRefPart = z.object({
  type: z.enum(MEDIA_INPUT_KIND_VALUES),
  mimeType: z.string(),
  uri: z.string(),
});
true satisfies Equals<z.infer<typeof interactionMediaRefPart>, InteractionMediaRefPart>;

/** A part of a history message: text or media. */
export type InteractionPart = InteractionTextPart | InteractionMediaPart | InteractionMediaRefPart;
const interactionPart = z.union([
  interactionTextPart,
  interactionMediaPart,
  interactionMediaRefPart,
]);
true satisfies Equals<z.infer<typeof interactionPart>, InteractionPart>;
export const interactionPartSchema: z.ZodType<InteractionPart> = interactionPart;

/** One message of a conversation history the host replays into a turn. */
export interface TurnHistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  parts?: InteractionPart[];
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /** The call's `ToolCallRequest.thoughtSignature`, replayed with it. */
    thoughtSignature?: string;
  }[];
  tool_call_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}
const turnHistoryMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().optional(),
  parts: z.array(interactionPart).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
        thoughtSignature: z.string().optional(),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  metadata: jsonObject.optional(),
});
true satisfies Equals<z.infer<typeof turnHistoryMessage>, TurnHistoryMessage>;
/** The schema a history message parses against. */
export const turnHistoryMessageSchema: z.ZodType<TurnHistoryMessage> = turnHistoryMessage;

/** Why a turn or live utterance ended. */
export interface TurnStop {
  kind: TurnStopKind;
  native?: string;
}
const turnStop = z.object({ kind: z.enum(TURN_STOP_KINDS), native: z.string().optional() });
true satisfies Equals<z.infer<typeof turnStop>, TurnStop>;

const TURN_TOKEN_SIDES = ['input', 'output'] as const;
/** Whether tokens were counted on the way in or the way out. */
export type TurnTokenSide = (typeof TURN_TOKEN_SIDES)[number];

/** What a turn cost, as the provider reports it. */
export interface TurnCost {
  /** What the provider charged, in US dollars. */
  usd: number;
  /** What the upstream model vendor charged the provider, when reported (OpenRouter). */
  upstreamUsd?: number;
  /**
   * Set on a sum (`sumTokens`) when some summed calls reported a cost and
   * others did not: `usd` covers only the calls that did.
   */
  partial?: true;
}
const turnCost = z.object({
  usd: z.number(),
  upstreamUsd: z.number().optional(),
  partial: z.literal(true).optional(),
});
true satisfies Equals<z.infer<typeof turnCost>, TurnCost>;

/** One grounding tool's use in a call (Interactions `grounding_tool_count`). */
export interface TurnGroundingCount {
  type: string;
  count: number;
  /** Search queries the tool ran. Absent = not reported. */
  searchQueryCount?: number;
}
const turnGroundingCount = z.object({
  type: z.string(),
  count: z.number(),
  searchQueryCount: z.number().optional(),
});
true satisfies Equals<z.infer<typeof turnGroundingCount>, TurnGroundingCount>;

/**
 * Token accounting for one model call, one `tokens` event per call; on `done`,
 * the turn's sum (`sumTokens`).
 *
 * Meanings follow the OpenTelemetry GenAI conventions on every provider:
 * `input` counts everything the model read (cached prompt and provider
 * tool-use tokens included), `output` everything it wrote (reasoning
 * included), and `total` is `input + output`.
 */
export interface TurnTokens {
  input: number;
  output: number;
  /** Reasoning share of `output`. */
  thinking?: number;
  /** Provider tool-use share of `input` (Google code execution / URL context results). */
  toolUse?: number;
  /** Share of `input` read from provider cache (cache hit). */
  cached?: number;
  /** Share of `input` written into provider cache. */
  cacheWrite?: number;
  total: number;
  cost?: TurnCost;
  /**
   * Sides the provider did not report. The runner replaces each with the one
   * token estimator's count before the event reaches the host. Absent = both
   * sides provider-reported.
   */
  estimated?: TurnTokenSide[];
  /**
   * Media parts left out of an estimated side because no verified rule counts
   * them, per side. Absent when every part was counted.
   */
  unknownMedia?: { input?: number; output?: number };
  /**
   * Provider-reported shares of each side by modality (`text`, `image`,
   * `audio`, …, lower-case). Providers list only some modalities, so the
   * shares need not add up to the side. Absent = not reported.
   */
  byModality?: { input?: Record<string, number>; output?: Record<string, number> };
  grounding?: TurnGroundingCount[];
}
const turnTokens = z.object({
  input: z.number(),
  output: z.number(),
  thinking: z.number().optional(),
  toolUse: z.number().optional(),
  cached: z.number().optional(),
  cacheWrite: z.number().optional(),
  total: z.number(),
  cost: turnCost.optional(),
  estimated: z.array(z.enum(TURN_TOKEN_SIDES)).optional(),
  unknownMedia: z
    .object({ input: z.number().optional(), output: z.number().optional() })
    .optional(),
  byModality: z
    .object({
      input: z.record(z.string(), z.number()).optional(),
      output: z.record(z.string(), z.number()).optional(),
    })
    .optional(),
  grounding: z.array(turnGroundingCount).optional(),
});
true satisfies Equals<z.infer<typeof turnTokens>, TurnTokens>;

/** A provider response's identity, as the wire sent it. Live sends neither field. */
export interface TurnResponse {
  /** Provider response id (OpenAI-compatible `id`, Interactions `id`). */
  id?: string;
  model?: string;
}
const turnResponse = z.object({ id: z.string().optional(), model: z.string().optional() });
true satisfies Equals<z.infer<typeof turnResponse>, TurnResponse>;

const SOURCE_TYPES = ['web', 'maps'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** A source a grounded answer cites. */
export interface Source {
  title: string;
  uri: string;
  type: SourceType;
  /** Google Place id when the source is a Maps place / place_citation. */
  placeId?: string;
}
const source = z.object({
  title: z.string(),
  uri: z.string(),
  type: z.enum(SOURCE_TYPES),
  placeId: z.string().optional(),
});
true satisfies Equals<z.infer<typeof source>, Source>;
export const sourceSchema: z.ZodType<Source> = source;

/** Google grounding search metadata. Sources travel as `citation` events. */
export interface GroundingEvent {
  metadata?: Record<string, unknown>;
  chunks?: unknown[];
  searchHtml?: string;
}
const groundingEvent = z.object({
  metadata: jsonObject.optional(),
  chunks: z.array(z.unknown()).optional(),
  searchHtml: z.string().optional(),
});
true satisfies Equals<z.infer<typeof groundingEvent>, GroundingEvent>;

export interface EvidenceBase {
  provider: Provider;
  /** The provider's own payload, for the builder: `forClient` strips it unless `includeEvidenceRaw`. */
  raw?: Record<string, unknown>;
  /**
   * The provider started this step and never finished it (the stream ended
   * first). `raw` holds what arrived. A partial tool call is evidence only and
   * never runs.
   */
  partial?: boolean;
}
const evidenceBase = {
  provider: z.enum(PROVIDERS),
  raw: jsonObject.optional(),
  partial: z.boolean().optional(),
};

/** What a provider returned beside the answer, such as code it ran or search results it used. */
export type ProviderEvidence =
  | (EvidenceBase & {
      kind: 'code_execution_call';
      /** Generated source from `code_execution_call.arguments.code`. */
      code: string;
      /** Language of `code` when the API supplies it (typically `python`). */
      language?: string;
      id: string;
    })
  | (EvidenceBase & {
      kind: 'code_execution_result';
      result?: string;
      isError?: boolean;
      /** Links a result to its call (`code_execution_result.call_id`). */
      callId?: string;
    })
  | (EvidenceBase & {
      kind: 'input_transcription' | 'output_transcription';
      /** Partial/interim chunk (vs final transcription delta). Text rides on the event. */
      interim?: boolean;
    })
  | (EvidenceBase & { kind: 'voice_activity' | 'url_context' })
  | (EvidenceBase & {
      kind: 'session_resumption';
      /** Whether the handle (on the event) may be used to resume. */
      resumable: boolean;
    })
  | (EvidenceBase & {
      kind: 'provider_step';
      /** The provider's own step type, e.g. `google_search_call`. */
      step: string;
    });
const providerEvidence = z.discriminatedUnion('kind', [
  z.object({
    ...evidenceBase,
    kind: z.literal('code_execution_call'),
    code: z.string(),
    language: z.string().optional(),
    id: z.string(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('code_execution_result'),
    result: z.string().optional(),
    isError: z.boolean().optional(),
    callId: z.string().optional(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.enum(['input_transcription', 'output_transcription']),
    interim: z.boolean().optional(),
  }),
  z.object({ ...evidenceBase, kind: z.enum(['voice_activity', 'url_context']) }),
  z.object({ ...evidenceBase, kind: z.literal('session_resumption'), resumable: z.boolean() }),
  z.object({ ...evidenceBase, kind: z.literal('provider_step'), step: z.string() }),
]);
true satisfies Equals<z.infer<typeof providerEvidence>, ProviderEvidence>;

/** A session the provider ended after warning it would. */
export interface SessionEnded {
  /** The provider warned first (Gemini `goAway`). */
  cause: 'go_away';
  code: number;
  /** Milliseconds from the last warning to the close; compare with `timeLeftMs`. */
  closedAfterMs: number;
  /** What the close code means as a failure, when it is not a normal close (1000). */
  errorKind?: ErrorKind;
}
const sessionEnded = z.object({
  cause: z.literal('go_away'),
  code: z.number(),
  closedAfterMs: z.number(),
  errorKind: errorKindSchema.optional(),
});
true satisfies Equals<z.infer<typeof sessionEnded>, SessionEnded>;

/**
 * Live session control signal.
 *
 * - `closing_soon` — the provider will end the session; `timeLeftMs` is the
 *   drain window when it gave one.
 * - `ended` — the provider ended the session after warning it would; the last
 *   event of the session, not a failure. `message` is what the user reads
 *   (the profile's `live.session_ended` wording).
 * - `turn_complete` — one spoken response ended; the server may still be working.
 * - `working` — server is reasoning or awaiting async tool results.
 * - `idle` — server finished all processing; conversational cycle boundary.
 */
export type SessionEvent =
  | { kind: 'closing_soon'; timeLeftMs?: number }
  | { kind: 'ended'; timeLeftMs?: number; ended: SessionEnded; message: string }
  | { kind: 'waiting_for_input' | 'turn_complete' | 'working' | 'idle' };
/** The kind of a live session event. */
export type SessionEventKind = SessionEvent['kind'];
/** The live session event of kind `K`. */
export type SessionEventOf<K extends SessionEventKind> = Extract<SessionEvent, { kind: K }>;
const sessionEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('closing_soon'), timeLeftMs: z.number().optional() }),
  z.object({
    kind: z.literal('ended'),
    timeLeftMs: z.number().optional(),
    ended: sessionEnded,
    message: z.string(),
  }),
  z.object({ kind: z.enum(['waiting_for_input', 'turn_complete', 'working', 'idle']) }),
]);
true satisfies Equals<z.infer<typeof sessionEvent>, SessionEvent>;

/** Why a tool call failed, for the builder and for the user. */
export interface ToolFailure {
  /** What went wrong, for the builder. Stable per failure site. */
  code: string;
  /** What kind of failure it is; the user's wording (`error.<kind>`) follows from it. */
  kind: ErrorKind;
  /** What the model reads in the tool result. */
  message: string;
  /** User-safe wording, added where the event reaches the host. Never sent to the model. */
  error?: string;
  details?: unknown;
}
const toolFailure = z.object({
  code: z.string(),
  kind: errorKindSchema,
  message: z.string(),
  error: z.string().optional(),
  details: z.unknown().optional(),
});
true satisfies Equals<z.infer<typeof toolFailure>, ToolFailure>;

export interface ToolAuthChallenge {
  slot: string;
  authType: ToolAuthType;
  /** The service the person signs in to, from the tool's auth config. */
  service: string;
  /** Why the tool needs it; never blank. */
  message: string;
  authorizationUrl?: string;
  state?: string;
  issuer?: string;
  resource?: string;
  requiredScopes?: string[];
}
const toolAuthChallenge = z.object({
  slot: nonEmptyText,
  authType: z.enum(TOOL_AUTH_TYPES),
  service: nonEmptyText,
  message: nonEmptyText,
  authorizationUrl: z.string().optional(),
  state: z.string().optional(),
  issuer: z.string().optional(),
  resource: z.string().optional(),
  requiredScopes: z.array(nonEmptyText).optional(),
});
true satisfies Equals<z.infer<typeof toolAuthChallenge>, ToolAuthChallenge>;

/** Fields every gate carries. `tool` and `summary` are trimmed and never blank. */
export interface ToolGateBase {
  tool: string;
  permission?: ToolPermission;
  summary?: string;
}
const toolGateBase = {
  tool: nonEmptyText,
  permission: z.enum(TOOL_PERMISSION).optional(),
  summary: nonEmptyText.optional(),
};

/**
 * Confirm-to-run / permission / sign-in gate: the tool's body did not run.
 * A sign-in gate (`auth`) carries the challenge that says where.
 */
export type ToolGate =
  | (ToolGateBase & { kind: 'confirmation' | 'permission' })
  | (ToolGateBase & { kind: 'auth'; authChallenge: ToolAuthChallenge });
const toolGate = z.discriminatedUnion('kind', [
  z.object({ ...toolGateBase, kind: z.enum(['confirmation', 'permission']) }),
  z.object({ ...toolGateBase, kind: z.literal('auth'), authChallenge: toolAuthChallenge }),
]);
true satisfies Equals<z.infer<typeof toolGate>, ToolGate>;
/** The schema a tool gate parses against. */
export const toolGateSchema: z.ZodType<ToolGate> = toolGate;

export interface ToolWarning {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}
const toolWarning = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']).optional(),
});
true satisfies Equals<z.infer<typeof toolWarning>, ToolWarning>;

export interface ToolTraceStep {
  name: string;
  kind: string;
  status: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}
const toolTraceStep = z.object({
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  inputs: jsonObject.optional(),
  outputs: jsonObject.optional(),
});
true satisfies Equals<z.infer<typeof toolTraceStep>, ToolTraceStep>;

/**
 * A tool completed by asking the user something (`docs/contracts/stages.md`).
 * `prompt` and every option are trimmed and never blank; a `choice` offers at
 * least one option.
 */
export type AwaitingUserInput = {
  status: typeof AWAITING_USER_INPUT_STATUS;
  prompt: string;
} & ({ kind: 'confirm' | 'text'; options?: string[] } | { kind: 'choice'; options: string[] });
const awaitingBase = { status: z.literal(AWAITING_USER_INPUT_STATUS), prompt: nonEmptyText };
const awaitingUserInput = z.discriminatedUnion('kind', [
  z.object({
    ...awaitingBase,
    kind: z.enum(['confirm', 'text']),
    options: z.array(nonEmptyText).optional(),
  }),
  z.object({ ...awaitingBase, kind: z.literal('choice'), options: z.array(nonEmptyText).min(1) }),
]);
true satisfies Equals<z.infer<typeof awaitingUserInput>, AwaitingUserInput>;
/** The schema a pause for user input parses against. */
export const awaitingUserInputSchema: z.ZodType<AwaitingUserInput> = awaitingUserInput;

/** A function tool as it is sent to the model. */
export interface WireFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
const wireFunctionTool = z.object({
  type: z.literal('function'),
  name: z.string(),
  description: z.string(),
  parameters: jsonObject,
});
true satisfies Equals<z.infer<typeof wireFunctionTool>, WireFunctionTool>;

/** The tools a turn was offered: provider builtins, gated ids and the wire definitions. */
export interface TurnToolSnapshot {
  builtins: string[];
  /** Tool ids eligible this turn (custom: allow + path; builtin: model builtInTools + path). */
  gated: string[];
  /** Schemas sent to the provider (respects loadTier + t2Loader promotion). */
  visible: string[];
  /** Kernel-executable tools: eligible, visible, and loaded (excludes builtins). */
  executable: string[];
  path?: string;
  sessionPermissions?: string[];
  wire: WireFunctionTool[];
}
const turnToolSnapshot = z.object({
  builtins: z.array(z.string()),
  gated: z.array(z.string()),
  visible: z.array(z.string()),
  executable: z.array(z.string()),
  path: z.string().optional(),
  sessionPermissions: z.array(z.string()).optional(),
  wire: z.array(wireFunctionTool),
});
true satisfies Equals<z.infer<typeof turnToolSnapshot>, TurnToolSnapshot>;
/** The schema a tool snapshot parses against. */
export const turnToolSnapshotSchema: z.ZodType<TurnToolSnapshot> = turnToolSnapshot;

export interface ToolEventBase {
  name: string;
  /** Call id: the provider's own id when it sent one, else kernel-assigned. */
  callId: string;
}
const toolEventBase = { name: z.string(), callId: z.string() };

/**
 * The model's call, as the provider emitted it (no phase). It is the first
 * event of every call and the one owner of its arguments; phase events join
 * it by `callId`.
 */
export interface ToolCallRequest extends ToolEventBase {
  phase?: undefined;
  /**
   * The arguments the model sent, parsed. `{}` when they did not parse: the
   * `error` that follows (`malformed_arguments`) carries the raw text.
   */
  arguments: Record<string, unknown>;
  /**
   * Google's opaque signature for the thought that led to this call, when the
   * provider sent one. Only the first call of a step carries it: the model
   * thinks once before all of that step's calls. Replaying a call without it
   * fails on Google (probe 25/09/2026).
   */
  thoughtSignature?: string;
  /**
   * The model step that made this call: calls sharing it were made together,
   * in one model response, and replay as one assistant message. Unique within
   * the turn. Absent on a host's own call (`invokeTool` without a `callId`).
   */
  stepId?: string;
}
const toolCallRequest = z.object({
  ...toolEventBase,
  phase: z.undefined().optional(),
  arguments: jsonObject,
  thoughtSignature: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
});
true satisfies Equals<z.infer<typeof toolCallRequest>, ToolCallRequest>;

export interface ToolPhaseBase extends ToolEventBase {
  /** When the kernel emitted this phase (epoch ms). */
  at: number;
}
const toolPhaseBase = { ...toolEventBase, at: z.number() };

/** The user edited the arguments before approving. */
export interface ToolCallEdit {
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

/**
 * One phase of the kernel's execution of a call:
 *
 * - `running` — the body started; `edited` when the user changed the arguments;
 *   `activity` is the tool's activity label filled from the call's input.
 * - `progress` / `trace` / `artifact` / `warning` — streamed while it ran.
 * - `complete` — `output`; `awaiting` when it asked the user something; `parts` for the
 *   media it returned beside its output (images, audio);
 *   `readBack` is the text the model reads back, after guardrails;
 *   `activityPast` is the tool's past activity label filled from its input and output.
 * - `gate` — confirmation, permission or sign-in held the call; the body did not run.
 *   A sign-in gate's `readBack` is what the model reads while the person signs in.
 * - `error` — the call failed or was refused (`failure.kind` `declined` · `blocked` · `cancelled` · …);
 *   `readBack` is the text the model reads back for it, after guardrails.
 * - `cancel` — cancelled in flight (e.g. live barge-in).
 */
export type ToolPhaseEvent = ToolPhaseBase &
  (
    | { phase: 'running'; edited?: ToolCallEdit; activity?: string }
    | { phase: 'progress'; data: unknown }
    | { phase: 'trace'; step: ToolTraceStep }
    | { phase: 'artifact'; artifact: unknown }
    | { phase: 'warning'; warning: ToolWarning }
    | {
        phase: 'complete';
        output: unknown;
        awaiting?: boolean;
        readBack?: string;
        parts?: InteractionPart[];
        activityPast?: string;
        /** An agent tool's call: the called agent's own usage, which the caller's `done.tokens` includes. */
        tokens?: TurnTokens;
      }
    | { phase: 'gate'; gate: ToolGate; readBack?: string }
    | {
        phase: 'error';
        failure: ToolFailure;
        readBack?: string;
        /** An agent tool's call: the called agent's own usage, as on `complete`. */
        tokens?: TurnTokens;
      }
    | { phase: 'cancel' }
  );
export type ToolCallPhase = ToolPhaseEvent['phase'];
const toolPhaseEvent = z.discriminatedUnion('phase', [
  z.object({
    ...toolPhaseBase,
    phase: z.literal('running'),
    edited: z.object({ from: jsonObject, to: jsonObject }).optional(),
    activity: z.string().optional(),
  }),
  z.object({ ...toolPhaseBase, phase: z.literal('progress'), data: z.unknown() }),
  z.object({ ...toolPhaseBase, phase: z.literal('trace'), step: toolTraceStep }),
  z.object({ ...toolPhaseBase, phase: z.literal('artifact'), artifact: z.unknown() }),
  z.object({ ...toolPhaseBase, phase: z.literal('warning'), warning: toolWarning }),
  z.object({
    ...toolPhaseBase,
    phase: z.literal('complete'),
    output: z.unknown(),
    awaiting: z.boolean().optional(),
    readBack: z.string().optional(),
    parts: z.array(interactionPart).optional(),
    activityPast: z.string().optional(),
    tokens: turnTokens.optional(),
  }),
  z.object({
    ...toolPhaseBase,
    phase: z.literal('gate'),
    gate: toolGate,
    readBack: z.string().optional(),
  }),
  z.object({
    ...toolPhaseBase,
    phase: z.literal('error'),
    failure: toolFailure,
    readBack: z.string().optional(),
    tokens: turnTokens.optional(),
  }),
  z.object({ ...toolPhaseBase, phase: z.literal('cancel') }),
]);
true satisfies Equals<z.infer<typeof toolPhaseEvent>, ToolPhaseEvent>;

/** A tool call event: the model's request or a phase of running it. */
export type ToolCallEvent = ToolCallRequest | ToolPhaseEvent;
const toolCallEvent = z.union([toolPhaseEvent, toolCallRequest]);
true satisfies Equals<z.infer<typeof toolCallEvent>, ToolCallEvent>;

/** A note that a stage handler's result was partly or wholly ignored, and why. */
export interface StageApplyWarning {
  code: StageApplyWarningCode;
  message: string;
  field: string;
}
const stageApplyWarning = z.object({
  code: z.enum(STAGE_APPLY_WARNING_CODES),
  message: z.string(),
  field: z.string(),
});
true satisfies Equals<z.infer<typeof stageApplyWarning>, StageApplyWarning>;

/** Compaction signal on `done` for `timing: 'after'` profiles. */
export interface CompactionSignal {
  needed: boolean;
  meter: CompactionMeter;
  tokens: number;
  /** Media parts not counted in `tokens` — no verified rule for this model. */
  unknownMedia: number;
  /** Full-prompt input tokens of this turn's last model call, when one completed. */
  promptTokens?: number;
  /** True when `promptTokens` is the token estimator's count — the provider reported none. */
  promptTokensEstimated?: boolean;
  history: TurnHistoryMessage[];
}
const compactionSignal = z.object({
  needed: z.boolean(),
  meter: z.enum(COMPACTION_METERS),
  tokens: z.number(),
  unknownMedia: z.number(),
  promptTokens: z.number().optional(),
  promptTokensEstimated: z.boolean().optional(),
  history: z.array(turnHistoryMessage),
});
true satisfies Equals<z.infer<typeof compactionSignal>, CompactionSignal>;

/** Why the compactor produced no summary. */
export interface CompactionFailure {
  /** How the compactor's turn ended; absent when it threw before it could end. */
  stop?: TurnStopKind;
  /** The error it reported, when it reported one. */
  error?: ErrorKind;
  /** It completed without a summary. */
  empty?: true;
  /** Nothing in `toCompact` was left for it to read, so it did not run. */
  unreadable?: true;
}
const compactionFailure = z.object({
  stop: z.enum(TURN_STOP_KINDS).optional(),
  error: errorKindSchema.optional(),
  empty: z.literal(true).optional(),
  unreadable: z.literal(true).optional(),
});
true satisfies Equals<z.infer<typeof compactionFailure>, CompactionFailure>;

/** What one compaction did. The host keeps `history` from now on, whatever the outcome. */
export interface CompactionResult {
  outcome: CompactionOutcome;
  /** The messages the split handed to the compactor. */
  toCompact: TurnHistoryMessage[];
  history: TurnHistoryMessage[];
  /** On `compacted`: the summary that replaced `toCompact`. */
  summary?: string;
  /** On `deferred` and `dropped`. */
  failure?: CompactionFailure;
  /** Media parts in `toCompact` the compactor's profile does not accept, left out of what it read. */
  droppedMedia: number;
  /** The compaction call's own usage. */
  tokens?: TurnTokens;
}

/**
 * Theorem ran the compactor before the turn. `after` is the host's to run with
 * `compactHistory`, signalled on `done.compaction`.
 */
export interface CompactionEvent extends Omit<CompactionResult, 'toCompact'> {
  timing: 'before';
  meter: CompactionMeter;
  tokensBefore: number;
  unknownMedia: number;
  messagesBefore: number;
  messagesAfter: number;
}

/** Stops that end a turn with tools pending; `done.tools` is present exactly on them. */
export type ToolSnapshotStopKind = Extract<TurnStopKind, 'tool' | 'gate'>;
const TOOL_SNAPSHOT_STOP_KINDS = [
  'tool',
  'gate',
] as const satisfies readonly ToolSnapshotStopKind[];

export interface DoneBase {
  /** The turn's summed usage (`sumTokens` over its `tokens` events). */
  tokens?: TurnTokens;
  /** The turn's root span as a W3C `traceparent`, for a later request's `links`. */
  traceparent?: string;
  compaction?: CompactionSignal;
  /** A user utterance interrupted an in-flight live response (barge-in). */
  interrupted?: boolean;
  interactionId?: string;
}

/**
 * The turn ended. On stop `tool` or `gate` it carries the turn's tool snapshot
 * for `invokeTool({ snapshot })`; on every other stop it carries none.
 */
export type DoneEvent = DoneBase &
  (
    | { stop: TurnStop & { kind: ToolSnapshotStopKind }; tools: TurnToolSnapshot }
    | { stop: TurnStop & { kind: Exclude<TurnStopKind, ToolSnapshotStopKind> }; tools?: undefined }
  );

/** Every event a host receives from `runTurn`, `invokeTool` or a live session. */
export type TurnEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  /** The profile's structured-output schema validates `structured`. */
  | { type: 'structured'; structured: unknown }
  | { type: 'media'; media: { mimeType: string; data: string } }
  | { type: 'grounding'; grounding: GroundingEvent }
  /** Sources a provider or a tool cited; `callId` names the tool call when a tool did. */
  | { type: 'citation'; sources: Source[]; callId?: string }
  | ({ type: 'compaction' } & CompactionEvent)
  | {
      type: 'evidence';
      evidence: ProviderEvidence;
      /** Transcription text. */
      text?: string;
      sessionResumptionHandle?: string;
    }
  | { type: 'tokens'; tokens: TurnTokens; interactionId?: string }
  | {
      type: 'session';
      session: SessionEvent;
      /** Raw close reason of an ended session, for the builder only. */
      errorInternal?: string;
    }
  /** A guardrail decision — rule identity and offsets, never content. */
  | { type: 'guardrail'; guardrail: GuardrailEvent }
  | {
      type: 'stage';
      stage: TurnStage;
      callId?: string;
      toolName?: string;
      /** `pre_tool` settled without running the body. */
      callNotStarted?: boolean;
      /** The tool completed with `awaiting_user_input`. */
      awaiting?: boolean;
      gate?: ToolGate;
      stop?: TurnStop;
      /** Stage result fields the kernel dropped. */
      stageWarnings?: StageApplyWarning[];
      /** The named injects (`StageResult.injectId`) that landed in the conversation at this stage. */
      injected?: { id: string }[];
    }
  | {
      type: 'tool';
      tool: ToolCallEvent;
      /** An untrusted server's own words about this call (a refused token refresh), for the builder only. */
      errorInternal?: string;
    }
  | ({ type: 'done' } & DoneEvent)
  | {
      type: 'error';
      errorKind: ErrorKind;
      /** Public-safe failure text for hosts to show users: the wording for `errorKind`. */
      error?: string;
      /** The lexicon key and parameters behind `error` when more specific than the kind's. */
      errorCopy?: ErrorCopies;
      /** Raw diagnostic detail for traces/logs; never surface to end users (`forClient` strips it). */
      errorInternal?: string;
    };

/** The `type` of a turn event. */
export type TurnEventType = TurnEvent['type'];

/** The turn event whose `type` is `K`. */
export type TurnEventOf<K extends TurnEventType> = Extract<TurnEvent, { type: K }>;

/**
 * How one model call ended, as a provider reports it. The runner reads it and
 * reports the turn's own `done`; a live session forwards it (`turnDoneOf`).
 */
export interface CallDone {
  stop: TurnStop;
  interactionId?: string;
  /** A user utterance interrupted the live response (barge-in). */
  interrupted?: boolean;
}

/**
 * What a provider yields: the host events, its call's `done`, and the
 * response's identity (`response`, recorded on the call's trace), which hosts
 * never receive.
 */
export type ProviderEvent =
  | Exclude<TurnEvent, { type: 'done' }>
  | ({ type: 'done' } & CallDone)
  | { type: 'response'; response: TurnResponse };

/** A `done` before its stop decides whether it carries the turn's tools. */
export type DoneFields = DoneBase & { stop: TurnStop };

/**
 * The host's `done` for a stop: the one place that decides whether it carries
 * the turn's tool snapshot (on `tool` and `gate`). Without a snapshot to give
 * (a live session forwarding a call's `done`), such a stop has no host `done`.
 */
export function turnDoneOf(done: DoneFields, tools: TurnToolSnapshot): TurnEventOf<'done'>;
/** Builds the `done` event from a model call's end, with the tools the turn was offered. */
export function turnDoneOf(done: DoneFields): TurnEventOf<'done'> | undefined;
/** Builds the `done` event from a model call's end, or `undefined` when it carries no stop. */
export function turnDoneOf(
  done: DoneFields,
  tools?: TurnToolSnapshot,
): TurnEventOf<'done'> | undefined {
  const { stop, ...rest } = done;
  const { kind } = stop;
  if (kind === 'tool' || kind === 'gate') {
    return tools ? { type: 'done', ...rest, stop: { ...stop, kind }, tools } : undefined;
  }
  return { type: 'done', ...rest, stop: { ...stop, kind } };
}

const snapshotStopKind = z.enum(TOOL_SNAPSHOT_STOP_KINDS);
const otherStopKind = z.enum(TURN_STOP_KINDS).exclude(TOOL_SNAPSHOT_STOP_KINDS);
const doneBase = {
  type: z.literal('done'),
  tokens: turnTokens.optional(),
  traceparent: z.string().optional(),
  compaction: compactionSignal.optional(),
  interrupted: z.boolean().optional(),
  interactionId: z.string().optional(),
};
const doneEvent = z.union([
  z.object({
    ...doneBase,
    stop: z.object({ kind: snapshotStopKind, native: z.string().optional() }),
    tools: turnToolSnapshot,
  }),
  z.object({
    ...doneBase,
    stop: z.object({ kind: otherStopKind, native: z.string().optional() }),
    tools: z.undefined().optional(),
  }),
]);

/** Each kind's own schema: a wire parser checks a line against its kind's alone, so a failure names the field that broke. */
const TURN_EVENTS = {
  text: z.object({ type: z.literal('text'), text: z.string() }),
  thought: z.object({ type: z.literal('thought'), text: z.string() }),
  structured: z.object({ type: z.literal('structured'), structured: z.unknown() }),
  media: z.object({
    type: z.literal('media'),
    media: z.object({ mimeType: z.string(), data: z.string() }),
  }),
  grounding: z.object({ type: z.literal('grounding'), grounding: groundingEvent }),
  citation: z.object({
    type: z.literal('citation'),
    sources: z.array(source),
    callId: z.string().optional(),
  }),
  compaction: z.object({
    type: z.literal('compaction'),
    timing: z.literal('before'),
    meter: z.enum(COMPACTION_METERS),
    tokensBefore: z.number(),
    unknownMedia: z.number(),
    messagesBefore: z.number(),
    messagesAfter: z.number(),
    outcome: z.enum(COMPACTION_OUTCOMES),
    history: z.array(turnHistoryMessage),
    summary: z.string().optional(),
    failure: compactionFailure.optional(),
    droppedMedia: z.number(),
    tokens: turnTokens.optional(),
  }),
  evidence: z.object({
    type: z.literal('evidence'),
    evidence: providerEvidence,
    text: z.string().optional(),
    sessionResumptionHandle: z.string().optional(),
  }),
  tokens: z.object({
    type: z.literal('tokens'),
    tokens: turnTokens,
    interactionId: z.string().optional(),
  }),
  session: z.object({
    type: z.literal('session'),
    session: sessionEvent,
    errorInternal: z.string().optional(),
  }),
  guardrail: z.object({ type: z.literal('guardrail'), guardrail: guardrailEventSchema }),
  stage: z.object({
    type: z.literal('stage'),
    stage: z.enum(TURN_STAGES),
    callId: z.string().optional(),
    toolName: z.string().optional(),
    callNotStarted: z.boolean().optional(),
    awaiting: z.boolean().optional(),
    gate: toolGate.optional(),
    stop: turnStop.optional(),
    stageWarnings: z.array(stageApplyWarning).optional(),
    injected: z
      .array(z.object({ id: z.string().regex(/\S/) }))
      .min(1)
      .optional(),
  }),
  tool: z.object({
    type: z.literal('tool'),
    tool: toolCallEvent,
    errorInternal: z.string().optional(),
  }),
  error: z.object({
    type: z.literal('error'),
    errorKind: errorKindSchema,
    error: z.string().optional(),
    errorCopy: errorCopiesSchema.optional(),
    errorInternal: z.string().optional(),
  }),
  done: doneEvent,
};

const turnEvent = z.union([
  z.discriminatedUnion('type', [
    TURN_EVENTS.text,
    TURN_EVENTS.thought,
    TURN_EVENTS.structured,
    TURN_EVENTS.media,
    TURN_EVENTS.grounding,
    TURN_EVENTS.citation,
    TURN_EVENTS.compaction,
    TURN_EVENTS.evidence,
    TURN_EVENTS.tokens,
    TURN_EVENTS.session,
    TURN_EVENTS.guardrail,
    TURN_EVENTS.stage,
    TURN_EVENTS.tool,
    TURN_EVENTS.error,
  ]),
  TURN_EVENTS.done,
]);
true satisfies Equals<z.infer<typeof turnEvent>, TurnEvent>;
/** The schema any turn event parses against. */
export const turnEventSchema: z.ZodType<TurnEvent> = turnEvent;

/** Every `TurnEvent` kind and its schema: a wire parser tells a kind it doesn't know from a malformed one it does. */
export const TURN_EVENT_SCHEMAS: { readonly [K in TurnEventType]: z.ZodType<TurnEventOf<K>> } =
  TURN_EVENTS;
