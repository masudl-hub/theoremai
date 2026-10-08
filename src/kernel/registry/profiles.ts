import type { z } from 'zod';
import { TOOL_BOUNDARIES } from '../../guardrails/boundaries.ts';
import { detectProblem } from '../../guardrails/detectors.ts';
import { TheoremError } from '../../guardrails/error.ts';
import {
  type LexiconOverrides,
  lexiconText,
  validateLexiconOverrides,
} from '../../guardrails/lexicon.ts';
import {
  BLOCKED_REPLY_ON_BLOCK,
  type BlockedReplySpec,
  type DecisionGuardrailsSpec,
  type HostGuardrailsSpec,
  type ProfileGuardrailsSpec,
} from '../../guardrails/types.ts';
import { resolveObservabilityPolicy } from '../../observability/resolve-policy.ts';
import type { ProfileObservabilitySpec } from '../../observability/types.ts';
import { assertLiveIngressConfigured } from '../engine/live-ingress.ts';
import { schemaReaches } from '../engine/runner/schema-validation.ts';
import { outOfScopeFields, profileTypesForField } from '../profile-scope.ts';
import {
  decisionModelBindingSchema,
  modelBindingSchema,
  type ProviderRegistry,
  providerContinuationSchema,
  validateProviderModel,
} from '../provider-contract.ts';
import {
  CONTEXT_SENDERS,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  PROFILE_FIELDS,
  PROFILE_HANDLE_MAX_CHARS,
  PROFILE_ID_MAX_CHARS,
  PROFILE_TYPES,
  type ProfileType,
  THINKING_LEVELS,
} from '../schema.ts';
import {
  DEFAULT_ALLOW_CONTINUE,
  isContinueStopKind,
  type ProfileTurnResumptionSpec,
} from '../stop.ts';
import { assertSystemPrompt } from '../system-parts.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { profileToolAllow, profileToolsSpec } from '../tools/resolve.ts';
import type {
  CompactionSpec,
  DecisionModelBinding,
  DecisionProfile,
  HostProfile,
  HostProfileToolsSpec,
  ImageInputsSpec,
  ImageProfile,
  LiveContextCompressionSpec,
  LiveProfile,
  LiveProfileToolsSpec,
  MediaTurnBehaviourSpec,
  ModelBinding,
  ModelId,
  ModelProfile,
  Profile,
  ProfileIdentity,
  ProfileImageSpec,
  ProfileInputsSpec,
  ProfileModelFields,
  ProfileOutputsSpec,
  ProfileToolsSpec,
  ProfileTurnBehaviourSpec,
  ProfileValidationSpec,
  SpeechProfile,
  TextProfile,
} from '../types.ts';
import { isTurnMediaRef } from './attachments.ts';
import { mediaKindForMime, mimeAllowed, profileInputs } from './catalog.ts';
import type { SchemaRegistry } from './schemas.ts';
import { soleModelId } from './sole-model.ts';

/** Not shared by host profiles, which invoke tools without a model turn. */
export type ProfileDefinitionBase = {
  id: Profile['id'];
  identity: ProfileIdentity;
  models: Record<ModelId, ModelBinding>;
  providerContinuation?: import('../provider-contract.ts').ProviderContinuationPolicy;
  defaultModel?: ModelId;
  allowModelSelect?: boolean;
  maxSteps?: number;
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

/** What a host writes to define a text profile. */
export type TextProfileDefinition = ProfileDefinitionBase & {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnBehaviour?: ProfileTurnBehaviourSpec;
};

/** What a host writes to define an image profile. */
export type ImageProfileDefinition = ProfileDefinitionBase & {
  type: 'image';
  image: NonNullable<ImageProfile['image']>;
  tools: ProfileToolsSpec;
  inputs: ImageInputsSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
};

/** What a host writes to define a speech profile. */
export type SpeechProfileDefinition = Omit<ProfileDefinitionBase, 'identity'> & {
  type: 'speech';
  identity: SpeechProfile['identity'];
  speech: NonNullable<SpeechProfile['speech']>;
  turnBehaviour?: MediaTurnBehaviourSpec;
};

/** What a host writes to define a live profile. */
export type LiveProfileDefinition = ProfileDefinitionBase & {
  type: 'live';
  live: NonNullable<LiveProfile['live']>;
  inputs?: LiveProfile['inputs'];
  tools: LiveProfileToolsSpec;
  /** Inject gate only — resumption is `live.sessionResumption`. */
  turnBehaviour?: Pick<ProfileTurnBehaviourSpec, 'allowSteering'>;
};

/** What a host writes to define a decision profile. */
export type DecisionProfileDefinition = {
  type: 'decision';
  id: Profile['id'];
  identity: Pick<ProfileIdentity, 'handle'>;
  /** Exactly one model. */
  models: Record<ModelId, DecisionModelBinding>;
  inputs: DecisionProfile['inputs'];
  decision: DecisionProfile['decision'];
  guardrails?: DecisionGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

/** What a host writes to define a host profile, which runs tools and no model. */
export type HostProfileDefinition = {
  type: 'host';
  id: Profile['id'];
  tools: HostProfileToolsSpec;
  /** Only the guards that fire on the `invokeTool` path. */
  guardrails?: HostGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

/** Any profile definition, discriminated by `type`. */
export type ProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition
  | DecisionProfileDefinition
  | HostProfileDefinition;

function assertModelRoute(
  _profileId: string,
  _modelId: string,
  binding: Pick<ModelBinding, 'provider' | 'apiId'>,
  _type?: ProfileType,
): void {
  if (!binding.provider?.trim() || !binding.apiId?.trim())
    throw new TheoremError('config', lexiconText('provider.binding_identity'));
}

function assertBindingData(
  profileId: string,
  modelId: string,
  binding: unknown,
  schema: z.ZodType,
): void {
  const parsed = schema.safeParse(binding);
  if (!parsed.success)
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}': ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
}

function validateDecisionBinding(
  profileId: string,
  modelId: string,
  binding: DecisionModelBinding,
): void {
  assertBindingData(profileId, modelId, binding, decisionModelBindingSchema);
  assertModelRoute(profileId, modelId, binding, 'decision');
  if ('retry' in binding) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic
      `Profile ${profileId} model '${modelId}': decision retry configuration is unsupported; POSTs are never retried`,
    );
  }
  if (
    binding.timeoutMs !== undefined &&
    (!Number.isFinite(binding.timeoutMs) || binding.timeoutMs <= 0)
  ) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' timeoutMs must be > 0`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function validateDecisionModel(input: DecisionProfileDefinition): void {
  const modelId = input.models ? soleModelId(input.models) : undefined;
  if (!modelId) {
    throw new TheoremError(
      'config',
      `Profile ${input.id}: type 'decision' must declare exactly one model`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  validateDecisionBinding(input.id, modelId, input.models[modelId]);
}

function validateDecisionConfig(input: DecisionProfileDefinition): void {
  if (input.inputs.state !== 'json') {
    throw new TheoremError('config', `Profile ${input.id}: decision inputs.state must be 'json'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const cap = input.inputs.maxStateBytes;
  if (cap !== undefined && !(Number.isInteger(cap) && cap > 0)) {
    throw new TheoremError(
      'config',
      `Profile ${input.id}: decision inputs.maxStateBytes must be a positive integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!input.decision.contract.trim()) {
    throw new TheoremError('config', `Profile ${input.id}: decision.contract must be non-empty`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function defineDecisionProfile(input: DecisionProfileDefinition): DecisionProfile {
  validateDecisionModel(input);
  validateDecisionConfig(input);
  assertObservability(input.id, input.observability);
  return { ...input, identity: { handle: input.identity.handle } };
}

function defineHostProfile(input: HostProfileDefinition): HostProfile {
  assertHostTools(input.id, input.tools);
  assertObservability(input.id, input.observability);
  return {
    type: 'host',
    id: input.id,
    tools: { allow: input.tools.allow },
    guardrails: input.guardrails,
    observability: input.observability,
    lexicon: input.lexicon,
  } satisfies HostProfile;
}

function assertHostTools(profileId: string, tools: HostProfileToolsSpec): void {
  if (!Array.isArray(tools.allow)) {
    throw new TheoremError('config', `Profile ${profileId}: type 'host' must set tools.allow`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertModelsNonEmpty(profileId: string, models: Record<ModelId, ModelBinding>): void {
  if (Object.keys(models).length === 0) {
    throw new TheoremError('config', `Profile ${profileId} must declare at least one model`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function resolveDefaultModel(profileId: string, input: ProfileDefinitionBase): ModelId {
  const ids = Object.keys(input.models);
  const inferred = input.defaultModel ?? soleModelId(input.models);
  if (!inferred) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} must set defaultModel when more than one model is declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!input.models[inferred]) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} defaultModel '${inferred}' is not declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (input.allowModelSelect && ids.length < 2) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} allowModelSelect requires at least two models`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return inferred;
}

function assertModelBinding(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  assertModelEfforts(profileId, modelId, binding);
  assertBindingData(profileId, modelId, binding, modelBindingSchema);
  assertModelEfforts(profileId, modelId, binding);
}

function assertModelEfforts(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  const efforts = binding.efforts;
  if (!efforts || Object.keys(efforts).length === 0) {
    if (binding.defaultEffort || binding.allowEffortSelect) {
      throw new TheoremError(
        'config',
        `Profile ${profileId} model '${modelId}': defaultEffort and allowEffortSelect require efforts`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return;
  }
  for (const [alias, level] of Object.entries(efforts)) {
    if (!THINKING_LEVELS.includes(level)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId} model '${modelId}' effort '${alias}': '${level}' is not a thinking level (${THINKING_LEVELS.join(', ')})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  const keys = Object.keys(efforts);
  const defaultAlias = binding.defaultEffort ?? (keys.length === 1 ? keys[0] : undefined);
  if (!defaultAlias) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' must set defaultEffort when more than one effort is declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!efforts[defaultAlias]) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' defaultEffort '${defaultAlias}' is not declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (binding.allowEffortSelect && keys.length < 2) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' allowEffortSelect requires at least two efforts`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function profileModelFields(input: ProfileDefinitionBase): ProfileModelFields {
  return {
    providerContinuation: input.providerContinuation
      ? providerContinuationSchema.parse(input.providerContinuation)
      : { onMismatch: 'rebuild' },
    models: input.models,
    defaultModel: resolveDefaultModel(input.id, input),
    allowModelSelect: input.allowModelSelect,
    maxSteps: input.maxSteps,
  };
}

function assertContinueKindList(
  profileId: string,
  path: 'allowContinue' | 'autoContinue',
  kinds: readonly string[] | undefined,
): void {
  if (!kinds?.length) return;
  for (const kind of kinds) {
    if (!isContinueStopKind(kind)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: turnBehaviour.resumption.${path} may only include ContinueStopKind ` + // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          `(length | stream_incomplete | provider_error); got '${kind}'`,
      );
    }
  }
}

function assertResumption(
  profileId: string,
  resumption: ProfileTurnResumptionSpec | undefined,
): void {
  if (!resumption) return;
  assertContinueKindList(profileId, 'allowContinue', resumption.allowContinue);
  assertContinueKindList(profileId, 'autoContinue', resumption.autoContinue);
  const allowed: readonly string[] = resumption.allowContinue ?? DEFAULT_ALLOW_CONTINUE;
  const unallowed = resumption.autoContinue?.filter((kind) => !allowed.includes(kind)) ?? [];
  if (unallowed.length) {
    throw new TheoremError(
      'config',
      `Profile ${profileId}: turnBehaviour.resumption.autoContinue has ${unallowed.join(', ')}, which allowContinue leaves out`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `*` spans a map's entries; a path through an absent parent yields nothing. */
function valuesAt(root: Record<string, unknown>, path: readonly string[]): unknown[] {
  let level: unknown[] = [root];
  for (const key of path) {
    level = level.flatMap((value) => {
      if (!isRecord(value)) return [];
      return key === '*' ? Object.values(value) : [value[key]];
    });
  }
  return level;
}

const REQUIRED_PATHS: readonly (readonly [string, readonly ProfileType[] | undefined])[] =
  Object.entries(PROFILE_FIELDS)
    .filter(([, meta]) => meta.required === true)
    .map(([path, meta]) => [path, meta.profileTypes] as const)
    .sort(([a], [b]) => a.split('.').length - b.split('.').length);

/** A definition may come over the network (a studio draft), so its shape is checked before anything reads it. */
function assertProfileShape(input: unknown): asserts input is ProfileDefinition {
  if (!isRecord(input)) {
    throw new TheoremError('config', 'Profile definition must be an object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const id = typeof input.id === 'string' && input.id.trim() ? input.id : undefined;
  if (!id) {
    throw new TheoremError('config', 'Profile definition must set id'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const type = PROFILE_TYPES.find((known) => known === input.type);
  if (!type) {
    throw new TheoremError(
      'config',
      `Profile ${id}: type must be one of ${PROFILE_TYPES.join(', ')}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A profile's id and its handle each fit their limit. */
function assertNameLengths(input: ProfileDefinition): void {
  const handle = (input as { identity?: { handle?: unknown } }).identity?.handle;
  const names = [
    ['id', input.id, PROFILE_ID_MAX_CHARS],
    ['identity.handle', typeof handle === 'string' ? handle : '', PROFILE_HANDLE_MAX_CHARS],
  ] as const;
  for (const [path, name, max] of names) {
    if (Array.from(name).length <= max) continue;
    throw new TheoremError(
      'config',
      `Profile ${input.id.slice(0, PROFILE_ID_MAX_CHARS)}: ${path} must be at most ${max} characters`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A field under an optional parent the definition leaves out is not required. */
function assertRequiredFields(input: ProfileDefinition): void {
  const { id, type } = input;
  const root = input as unknown as Record<string, unknown>;
  for (const [path, profileTypes] of REQUIRED_PATHS) {
    if (profileTypes && !profileTypes.includes(type)) continue;
    const keys = path.split('.');
    const parents = valuesAt(root, keys.slice(0, -1));
    const last = keys[keys.length - 1];
    const missing = parents.some((parent) => {
      if (!isRecord(parent)) return false;
      const value = parent[last];
      return value === undefined || value === null || value === '';
    });
    if (missing) {
      throw new TheoremError(
        'config',
        `Profile ${id}: type '${type}' must set ${path}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** `inputs` is optional on a live profile only, where it holds slots and context and nothing else. */
function assertInputsSet(input: ProfileDefinition): void {
  const { id, type } = input;
  if (type === 'live' || !profileTypesForField('inputs').includes(type)) return;
  const inputs = (input as { inputs?: unknown }).inputs;
  if (inputs === undefined || inputs === null) {
    throw new TheoremError('config', `Profile ${id}: type '${type}' must set inputs`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

/** Covers untyped hosts that the definition types can't stop. */
function assertFieldScope(input: ProfileDefinition): void {
  const [field] = outOfScopeFields(input);
  if (!field) return;
  const { offValue, reason } = field.scope;
  const allowed = offValue === undefined ? '' : ` (other than ${offValue})`;
  throw new TheoremError(
    'config',
    `Profile ${input.id}: type '${input.type}' must not set ${field.path}${allowed} — ${reason}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function assertTurnBehaviour(
  profileId: string,
  input: Exclude<ProfileDefinition, HostProfileDefinition | DecisionProfileDefinition>,
): void {
  const tb = input.turnBehaviour as ProfileTurnBehaviourSpec | undefined;
  assertResumption(profileId, tb?.resumption);
}

function assertValidation(profileId: string, validation: ProfileValidationSpec | undefined): void {
  const fail = (message: string) => new TheoremError('config', `Profile ${profileId}: ${message}`);
  const retries = validation?.maxRetries;
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
    throw fail('outputs.validation.maxRetries must be a non-negative integer'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertGuardrails(profileId: string, guardrails: ProfileGuardrailsSpec | undefined): void {
  const fail = (message: string) => new TheoremError('config', `Profile ${profileId}: ${message}`);
  // why: A key this does not read would be a check the builder believes is on.
  const unknown = Object.keys(guardrails ?? {}).find((key) => !GUARDRAIL_KEYS.includes(key));
  if (unknown !== undefined) {
    throw fail(`guardrails.${unknown} is not a setting; it takes ${GUARDRAIL_KEYS.join(', ')}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  assertBlockedReply(guardrails?.blockedReply, fail);
}

const GUARDRAIL_KEYS: readonly string[] = [
  'quota',
  'detect',
  'blockedReply',
  'network',
  'taint',
] satisfies (keyof ProfileGuardrailsSpec)[];
const BLOCKED_REPLY_KEYS: readonly string[] = ['onBlock', 'maxRetries'];

function assertBlockedReply(
  blockedReply: BlockedReplySpec | undefined,
  fail: (message: string) => TheoremError,
): void {
  if (blockedReply === undefined) return;
  const unknown = Object.keys(blockedReply).find((key) => !BLOCKED_REPLY_KEYS.includes(key));
  if (unknown !== undefined) {
    throw fail(
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `guardrails.blockedReply.${unknown} is not a setting; it takes onBlock and maxRetries`,
    );
  }
  const { onBlock, maxRetries } = blockedReply;
  if (onBlock !== undefined && !BLOCKED_REPLY_ON_BLOCK.includes(onBlock)) {
    throw fail(
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `guardrails.blockedReply.onBlock must be one of ${BLOCKED_REPLY_ON_BLOCK.join(', ')}`,
    );
  }
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw fail('guardrails.blockedReply.maxRetries must be a non-negative integer'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

/** A host profile runs no model turn, so the tool boundaries are the only ones it has. */
function assertDetect(input: ProfileDefinition): void {
  const spec = (input.guardrails as ProfileGuardrailsSpec | undefined)?.detect;
  const problem =
    input.type === 'host'
      ? detectProblem('guardrails.detect', spec, TOOL_BOUNDARIES)
      : detectProblem('guardrails.detect', spec);
  if (problem !== undefined) throw new TheoremError('config', `Profile ${input.id}: ${problem}`);
}

function assertObservability(profileId: string, spec: ProfileObservabilitySpec | undefined): void {
  try {
    const policy = resolveObservabilityPolicy(spec);
    if (!Number.isFinite(policy.retainForDays)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: observability.retainForDays must be a finite number`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    if (policy.rotateAfterMiB <= 0 || !Number.isFinite(policy.rotateAfterMiB)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: observability.rotateAfterMiB must be a positive number`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  } catch (err) {
    if (err instanceof TheoremError && err.message.startsWith('Profile ')) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new TheoremError('config', `Profile ${profileId}: ${message}`);
  }
}

function assertIdentitySystem(input: ProfileDefinition): void {
  if (input.type === 'host' || input.type === 'decision' || input.type === 'speech') return;
  const { system, systemByRole } = input.identity;
  if (system !== undefined) assertSystemPrompt(system, `Profile ${input.id} identity.system`);
  for (const [role, prompt] of Object.entries(systemByRole ?? {})) {
    assertSystemPrompt(prompt, `Profile ${input.id} identity.systemByRole.${role}`);
  }
}

/** Validate a definition and return the profile; throws on a malformed one. */
function defineProfile(input: TextProfileDefinition): TextProfile;
/** Validate an image definition and return the profile. */
function defineProfile(input: ImageProfileDefinition): ImageProfile;
/** Validate a speech definition and return the profile. */
function defineProfile(input: SpeechProfileDefinition): SpeechProfile;
/** Validate a live definition and return the profile. */
function defineProfile(input: LiveProfileDefinition): LiveProfile;
/** Validate a decision definition and return the profile. */
function defineProfile(input: DecisionProfileDefinition): DecisionProfile;
/** Validate a host definition and return the profile. */
function defineProfile(input: HostProfileDefinition): HostProfile;
/** Validate a definition of any type except live and host, and return the profile. */
function defineProfile(
  input: Exclude<ProfileDefinition, LiveProfileDefinition | HostProfileDefinition>,
): Exclude<Profile, LiveProfile | HostProfile>;
/** Validate any definition and return the profile. */
function defineProfile(input: ProfileDefinition): Profile;
/** Validate any definition and return the profile. */
function defineProfile(input: ProfileDefinition): Profile {
  assertProfileShape(input);
  for (const field of ['key', 'fallbackKey', 'protocol', 'provider'])
    if (field in input)
      throw new TheoremError(
        'config',
        lexiconText('provider.profile_configuration', { profile: input.id, field }),
      );
  assertFieldScope(input);
  assertInputsSet(input);
  assertRequiredFields(input);
  assertNameLengths(input);
  if (input.lexicon) validateLexiconOverrides(input.lexicon, `Profile ${input.id}`);
  assertIdentitySystem(input);
  assertDetect(input);
  if (input.type === 'host') {
    return defineHostProfile(input);
  }
  if (input.type === 'decision') {
    return defineDecisionProfile(input);
  }
  assertModelsNonEmpty(input.id, input.models);
  assertTurnBehaviour(input.id, input);
  assertGuardrails(input.id, input.guardrails as ProfileGuardrailsSpec | undefined);
  if (input.type === 'text') assertValidation(input.id, input.outputs?.validation);
  assertObservability(input.id, input.observability);
  for (const [modelId, binding] of Object.entries(input.models)) {
    assertModelBinding(input.id, modelId, binding);
  }

  const identity: ProfileIdentity =
    input.type === 'speech'
      ? { handle: input.identity.handle }
      : {
          handle: input.identity.handle,
          system: input.identity.system,
          systemByRole: input.identity.systemByRole,
        };
  const guardrails = input.guardrails;
  const observability = input.observability;
  const lexicon = input.lexicon;
  const modelFields = profileModelFields(input);

  let profile: ModelProfile;
  switch (input.type) {
    case 'text':
      profile = {
        type: 'text',
        id: input.id,
        identity,
        ...modelFields,
        tools: input.tools,
        inputs: input.inputs,
        outputs: input.outputs,
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies TextProfile;
      break;
    case 'image':
      profile = {
        type: 'image',
        id: input.id,
        identity,
        ...modelFields,
        image: input.image,
        tools: input.tools,
        inputs: input.inputs,
        outputs: input.outputs,
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies ImageProfile;
      assertImageAccept(profile.id, profile.inputs.attachments?.accept);
      assertImagePinValues(profile.id, profile.image);
      break;
    case 'speech':
      profile = {
        type: 'speech',
        id: input.id,
        identity,
        ...modelFields,
        speech: input.speech,
        outputs: input.outputs,
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies SpeechProfile;
      break;
    case 'live': {
      profile = {
        type: 'live',
        id: input.id,
        identity,
        ...modelFields,
        live: input.live,
        inputs: input.inputs,
        tools: { allow: input.tools.allow },
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies LiveProfile;
      assertLiveIngressConfigured(profile);
      assertLiveCompression(profile.id, profile.live.contextCompression);
      assertLiveOpening(profile);
      break;
    }
    default: {
      const _exhaustive: never = input;
      throw new TheoremError('config', `Unknown profile type '${String(_exhaustive)}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  assertStructuredSlot(profile);
  assertMaxSteps(profile);
  return profile;
}

/** Only a positive whole number is a cap; left out, the turn gets `DEFAULT_MAX_STEPS`. */
function assertMaxSteps(profile: ModelProfile): void {
  const { maxSteps } = profile;
  if (maxSteps === undefined || (Number.isInteger(maxSteps) && maxSteps > 0)) return;
  throw new TheoremError(
    'config',
    `Profile ${profile.id}: maxSteps must be a whole number of 1 or more; leave it out for the default of 20`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

/** A turn can pass no value outside the slot's choices, so any other mapped key is dead. */
function assertStructuredSlot(profile: ModelProfile): void {
  if (profile.type === 'live') return;
  const structured = profile.outputs?.structured;
  if (!structured || typeof structured === 'string') return;
  const choices = profileInputs(profile)?.slots?.[structured.by];
  if (!choices) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: outputs.structured.by '${structured.by}' is not a slot in inputs.slots`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const unknown = Object.keys(structured.map).filter((value) => !choices.includes(value));
  if (unknown.length) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: outputs.structured.map maps ${unknown.join(', ')}, not a choice of slot '${structured.by}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

const IMAGE_PIN_RULES = {
  n: { ok: (v: number) => Number.isInteger(v) && v >= 1, rule: 'a whole number of 1 or more' }, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  seed: { ok: Number.isInteger, rule: 'a whole number' }, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  outputCompression: {
    ok: (v: number) => Number.isInteger(v) && v >= 0 && v <= 100,
    rule: 'a whole number from 0 to 100', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  },
} as const;

function assertImagePinValues(profileId: string, image: ProfileImageSpec) {
  for (const [name, { ok, rule }] of Object.entries(IMAGE_PIN_RULES)) {
    const value = image[name as keyof typeof IMAGE_PIN_RULES];
    if (value !== undefined && !ok(value)) {
      throw new TheoremError('config', `Profile ${profileId}: image.${name} must be ${rule}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  image.references?.forEach((reference, index) => {
    const where = `Profile ${profileId}: image.references[${index}]`;
    if (mediaKindForMime(reference.mimeType) !== 'image') {
      throw new TheoremError('config', `${where} must be an image, not '${reference.mimeType}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    const source = isTurnMediaRef(reference) ? reference.uri : reference.data;
    if (!source) {
      throw new TheoremError('config', `${where} needs its bytes or its uri`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  });
}

function assertImageAccept(profileId: string, accept: string[] | undefined) {
  const outside = accept?.filter((rule) => !mimeAllowed(IMAGE_ATTACHMENT_ACCEPT_MIMES, rule));
  if (!outside?.length) return;
  throw new TheoremError(
    'config',
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    `Profile ${profileId}: an image profile's attachments take images, video and PDF only, ` +
      `not ${outside.join(', ')}`,
  );
}

/** A greeting is a prompt, and a resume prompt needs the handles that make a resume. */
function assertLiveOpening(profile: LiveProfile): void {
  const { greeting, resumed, sessionResumption } = profile.live;
  const tag = `Profile ${profile.id} live`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (greeting !== undefined && (typeof greeting !== 'string' || !greeting.trim())) {
    throw new TheoremError('config', `${tag}.greeting must be a prompt; leave it out to wait`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!resumed) return;
  if (typeof resumed.prompt !== 'string' || !resumed.prompt.trim()) {
    throw new TheoremError('config', `${tag}.resumed.prompt must be a prompt`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const { afterMs } = resumed;
  if (afterMs !== undefined && !(Number.isFinite(afterMs) && afterMs >= 0)) {
    throw new TheoremError('config', `${tag}.resumed.afterMs must be 0 or more milliseconds`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!sessionResumption) {
    throw new TheoremError(
      'config',
      `${tag}.resumed needs live.sessionResumption: without it no call resumes`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertLiveCompression(profileId: string, spec: LiveContextCompressionSpec | undefined) {
  if (!spec) return;
  const tag = `Profile ${profileId} live.contextCompression`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const trigger = spec.triggerTokens;
  const target = spec.slidingWindow.targetTokens;
  assertWholeTokens(`${tag}.triggerTokens`, trigger);
  assertWholeTokens(`${tag}.slidingWindow.targetTokens`, target);
  if (trigger !== undefined && target !== undefined && target >= trigger) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `${tag}: slidingWindow.targetTokens must be below triggerTokens`,
    );
  }
}

function assertWholeTokens(tag: string, value: number | undefined) {
  if (value === undefined || (Number.isInteger(value) && value > 0)) return;
  throw new TheoremError('config', `${tag} must be a whole number above 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

function assertCompactionSpec(
  registered: ReadonlyMap<string, Profile>,
  owner: Profile,
  modelId: ModelId,
  spec: CompactionSpec,
): void {
  const tag = `Profile ${owner.id} model ${modelId} compaction`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  assertCompactionBudget(tag, spec);
  assertCompactionRetain(tag, spec);
  if (spec.meter != null && spec.meter !== 'history' && spec.meter !== 'input') {
    throw new TheoremError('config', `${tag}: meter must be 'history' or 'input'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (spec.profile === undefined) {
    if (owner.type !== 'text' || owner.inputs.text === false) {
      throw new TheoremError(
        'config',
        `${tag}: a profile that compacts itself must be a text profile that takes text`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return;
  }
  const compactor = registered.get(spec.profile);
  if (!compactor) {
    throw new TheoremError(
      'config',
      `${tag}: compaction profile '${spec.profile}' must be registered before '${owner.id}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (compactor.type !== 'text' || compactor.inputs.text === false) {
    throw new TheoremError(
      'config',
      `${tag}: compaction profile '${spec.profile}' must be a text profile that takes text`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertCompactionBudget(tag: string, spec: CompactionSpec): void {
  if (spec.maxTokens <= 0) {
    throw new TheoremError('config', `${tag}: maxTokens must be > 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (spec.compactAt <= 0 || spec.compactAt >= 1) {
    throw new TheoremError('config', `${tag}: compactAt must be in (0, 1)`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertCompactionRetain(tag: string, spec: CompactionSpec): void {
  if (spec.previousExchanges < 0) {
    throw new TheoremError('config', `${tag}: previousExchanges must be >= 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (spec.previousExchanges < 1 && spec.previousExchanges >= spec.compactAt) {
    throw new TheoremError(
      'config',
      `${tag}: previousExchanges as fraction (${spec.previousExchanges}) must be < compactAt (${spec.compactAt})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (spec.previousExchanges > 1 && !Number.isInteger(spec.previousExchanges)) {
    throw new TheoremError('config', `${tag}: previousExchanges >= 1 must be an integer`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertCustomToolsOnly(tools: ToolRegistry, profile: Profile): void {
  for (const id of profileToolAllow(profile)) {
    const tool = tools.get(id);
    if (tool?.type === 'agent' && profile.type === 'live') {
      throw new TheoremError(
        'config',
        `Profile ${profile.id} lists agent tool '${id}' in tools.allow — a live session can't run an agent tool`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    if (tool?.type === 'builtin') {
      throw new TheoremError(
        'config',
        profile.type === 'host'
          ? `Profile ${profile.id} lists builtin '${id}' in tools.allow — type 'host' never runs a model` // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          : `Profile ${profile.id} lists builtin '${id}' in tools.allow — declare it on models.*.builtInTools instead`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

function assertProfileToolLoader(tools: ToolRegistry, profile: Profile): void {
  const loaderId = profileToolsSpec(profile)?.t2Loader;
  if (!loaderId) {
    return;
  }
  if (!profileToolAllow(profile).includes(loaderId)) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must also be listed in tools.allow`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const tool = tools.get(loaderId);
  if (tool?.type !== 'function') {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must be a registered type: 'function' tool`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function* modelBuiltinIds(profile: ModelProfile): Generator<{ modelId: string; id: string }> {
  for (const [modelId, binding] of Object.entries(profile.models)) {
    for (const id of binding.builtInTools ?? []) {
      yield { modelId, id };
    }
  }
}

function assertModelBuiltInTools(tools: ToolRegistry, profile: ModelProfile): void {
  for (const { modelId, id } of modelBuiltinIds(profile)) {
    const tool = tools.get(id);
    if (tool?.type !== 'builtin') {
      throw new TheoremError(
        'config',
        `Profile ${profile.id} model '${modelId}' lists '${id}' in builtInTools — not a registered builtin`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** The schema ids `outputs.structured` can pick, by slot and fallback. */
function structuredIds(profile: ModelProfile): string[] {
  const structured = profile.type === 'text' ? profile.outputs?.structured : undefined;
  if (!structured) return [];
  if (typeof structured === 'string') return [structured];
  return [...new Set([...Object.values(structured.map), structured.fallback])];
}

/**
 * Every schema `outputs.structured` names is registered, and every
 * `outputs.validation.fields` path reaches a property of one of them.
 */
function assertStructuredSchemas(schemas: SchemaRegistry, profile: ModelProfile): void {
  const specs = structuredIds(profile).map((id) => {
    const spec = schemas.find(id);
    if (!spec) {
      throw new TheoremError(
        'config',
        `Profile ${profile.id}: outputs.structured names '${id}', which is not a registered schema; register it before the profile`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return spec;
  });
  const fields = Object.keys(
    (profile.type === 'text' ? profile.outputs?.validation?.fields : undefined) ?? {},
  );
  if (!fields.length) return;
  if (!specs.length) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: outputs.validation.fields checks a structured reply, so it needs outputs.structured`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const unreached = fields.filter(
    (path) => !specs.some((spec) => schemaReaches(spec.jsonSchema, path)),
  );
  if (unreached.length) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: outputs.validation.fields has ${unreached.join(', ')}, which no structured schema reaches through object properties`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertContextSpec(profile: ModelProfile): void {
  const context = profileInputs(profile)?.context;
  if (!context) {
    return;
  }
  const senders: readonly string[] = CONTEXT_SENDERS;
  if (context.from.length === 0 || context.from.some((sender) => !senders.includes(sender))) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: inputs.context.from must list ${CONTEXT_SENDERS.join(' or ')}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!(Number.isInteger(context.maxChars) && context.maxChars > 0)) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: inputs.context.maxChars must be a positive integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertMediaLimits(profile: ModelProfile): void {
  const inputs = profileInputs(profile);
  if (!inputs) {
    return;
  }
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes, limitsByMime } = inputs;
  const limits: Record<string, number | undefined> = { maxFiles, maxBytes, maxTurnBytes };
  if ((attachments || voice) && Object.values(limits).some((value) => value === undefined)) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  for (const [mime, value] of Object.entries(limitsByMime ?? {})) {
    limits[`limitsByMime['${mime}']`] = value;
  }
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      throw new TheoremError(
        'config',
        `Profile ${profile.id}: inputs.${name} must be a positive integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** A set of registered profiles, kept by id. */
interface ProfileRegistry {
  register(profileInput: Profile | ProfileDefinition): void;
  registerMany(profilesList: Array<Profile | ProfileDefinition>): void;
  /** Throws when there is none. */
  get(id: string): Profile;
  find(id: string): Profile | undefined;
  has(id: string): boolean;
  list(): Profile[];
  clear(): void;
}

/** Profiles are checked against `tools` and `schemas`, so register a scope's tools and schemas before its profiles. */
function createProfileRegistry(
  tools: ToolRegistry,
  schemas: SchemaRegistry,
  providers?: ProviderRegistry,
): ProfileRegistry {
  const profiles = new Map<string, Profile>();
  const register = (profileInput: Profile | ProfileDefinition) => {
    const profile = defineProfile(profileInput as ProfileDefinition);
    if (providers && profile.type !== 'host') {
      for (const binding of Object.values(profile.models))
        validateProviderModel(providers.require(binding.provider), binding, profile.type);
    }
    assertCustomToolsOnly(tools, profile);
    assertProfileToolLoader(tools, profile);
    if (profile.type !== 'host' && profile.type !== 'decision') {
      assertModelBuiltInTools(tools, profile);
      assertMediaLimits(profile);
      assertContextSpec(profile);
      assertStructuredSchemas(schemas, profile);
      for (const [modelId, binding] of Object.entries(profile.models)) {
        if (binding.compaction) {
          assertCompactionSpec(profiles, profile, modelId, binding.compaction);
        }
      }
    }
    profiles.set(profile.id, profile);
  };
  return {
    register,
    registerMany(profilesList) {
      for (const p of profilesList) {
        register(p);
      }
    },
    get(id) {
      const profile = profiles.get(id);
      if (!profile) {
        throw new TheoremError('config', `Unknown profile '${id}'`);
      }
      return profile;
    },
    find: (id) => profiles.get(id),
    has: (id) => profiles.has(id),
    list: () => [...profiles.values()],
    clear: () => profiles.clear(),
  };
}

export type { ProfileRegistry };
export { createProfileRegistry, defineProfile };
