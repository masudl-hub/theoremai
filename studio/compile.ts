import { jsonObjectSchema } from '../mod.ts';
import {
  type DecisionEntry,
  type DecisionQuestion,
  defineProfile,
  describeError,
  type ImageProfileDefinition,
  type LabelKey,
  type LabelOverrides,
  type LiveProfileDefinition,
  liveIngressChannelDefault,
  type ProfileDefinitionBase,
  type ProfileGuardrailsSpec,
  type ProfileObservabilitySpec,
  type ProfileTurnBehaviourSpec,
  type SpeechProfileDefinition,
  type TextProfileDefinition,
  TheoremError,
} from '../mod.ts';
import { validateLabelOverrides } from '../src/guardrails/labels.ts';
import { BOUNDARIES, type Boundary, TOOL_BOUNDARIES } from '../src/guardrails/boundaries.ts';
import {
  DETECT_DEFAULTS,
  DETECTOR_META,
  DETECTORS,
  type Detector,
  type DetectorConfig,
  type DetectorRule,
  type DetectSpec,
  detectProblem,
  type HostDetectorConfig,
  hintProblem,
  type NameAllow,
  type UrlAllow,
  type UrlDetector,
} from '../src/guardrails/detectors.ts';
import { type HostPattern, patternListProblem } from '../src/guardrails/host-patterns.ts';
import type {
  DecisionProfileDefinition,
  HostProfileDefinition,
  ProfileDefinition,
} from '../src/kernel/mod.ts';
import { outOfScopeFields } from '../src/kernel/profile-scope.ts';
import { mimeAllowed } from '../src/kernel/registry/catalog.ts';
import {
  HTTP_METHODS,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  PROFILE_HANDLE_MAX_CHARS,
  PROFILE_ID_MAX_CHARS,
} from '../src/kernel/schema.ts';
import { systemPromptProblem } from '../src/kernel/system-parts.ts';
import { activityLabelProblem } from '../src/kernel/tools/activity-label.ts';
import { agentToolInputFor, agentToolOutput } from '../src/kernel/tools/agent.ts';
import { jsonSchemaFromZod } from '../src/kernel/tools/schema.ts';
import type {
  LiveContextCompressionSpec,
  LiveInputsSpec,
  ModelBinding,
  ProfileContextSpec,
  ProfileImageSpec,
  ProfileInputsSpec,
  ProfileLiveSpec,
  ProfileItemRule,
  ProfileOutputsSpec,
  ProfileSpeechSpec,
  SystemPrompt,
} from '../src/kernel/types.ts';
import { resolveObservabilityPolicy } from '../src/observability/mod.ts';
import { isCredentialName, MASK } from '../src/surface/mod.ts';
import { GOOGLE_SPEECH_FORMATS, GOOGLE_THINKING_LEVELS } from '../src/presets/google.ts';
import { STUDIO_KEY_SLOT_CAP } from './browser-connection.ts';
import type {
  DecisionDraft,
  GuardrailsDraft,
  ImageDraft,
  ImageReferenceDraft,
  InputsDraft,
  LiveDraft,
  ModelBindingDraft,
  ObservabilityDraft,
  OutputsDraft,
  OwnDetectorDraft,
  PatternDraft,
  PatternSourceDraft,
  StudioDraft,
  StudioProfileType,
  StudioTurnProfileType,
  SpeechDraft,
  ToolSpecDraft,
  TurnBehaviourDraft,
  UrlAllowDraft,
} from './draft.ts';
import { STUDIO_TOOL_TYPE_MESSAGE, STUDIO_TOOL_TYPES } from './types.ts';
import {
  COMPACTION_DRAFT_DEFAULTS,
  draftAllows,
  draftFacets,
  INLINE_LABELS,
  takesContinueInstruction,
} from './draft.ts';
import type { LentKeys, StudioRunsOn } from './lent-keys.ts';
import { isGoogleRoute, isOpenRouterRoute, isProviderBuiltinId, modelBindingViolation } from './policy.ts';
import {
  LOCAL_PROVIDER_ID,
  type ModelRoute,
  modelCapabilities,
  modelRoute,
  servesProfileType,
  type StudioProvider,
} from './providers.ts';
import type {
  StudioToolLabels,
  StructuredRegistration,
  ToolRegistration,
} from './registrations.ts';
import {
  bindingSlots,
  defaultEffortRequired,
  defaultModelRequired,
  inputLimitsRequired,
  keySlotRequired,
} from './requirements.ts';
import { parseSystemMarkup, type SystemMarkup } from './system-markup.ts';
import { parseJsonSchema } from './tool-schema.ts';
import { modelBindingNodeId, toolSpecNodeId } from './tree.ts';

export type StudioProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition
  | DecisionProfileDefinition
  | HostProfileDefinition;

/** A profile that runs a model turn: every studio type but decision and host. */
export type StudioTurnProfileDefinition = Exclude<
  StudioProfileDefinition,
  DecisionProfileDefinition | HostProfileDefinition
>;

/**
 * `field` is the draft key at fault on that node (e.g. `handle`, `defaultEffort`) and `index`
 * the list entry; issues about the node as a whole have neither.
 */
export interface StudioIssue {
  nodeId: string;
  message: string;
  field?: string;
  index?: number;
}

export interface CompiledStudio {
  agentId: string;
  profile: StudioProfileDefinition;
  customTools: ToolRegistration[];
  structured?: StructuredRegistration;
  /** A decision's questions, by id. */
  questions?: Record<string, DecisionQuestion>;
  /** The providers its models can name, each with its adapter. */
  providers: readonly StudioProvider[];
}

export type StudioCompileResult =
  | ({ ok: true } & CompiledStudio)
  | { ok: false; issues: StudioIssue[] };

type Report = (nodeId: string, message: string, field?: string, index?: number) => void;

/**
 * The agent id another agent of the workspace has, by its draft key; `undefined` when
 * none has that key. A single draft names no other agent.
 */
export type AgentIdOf = (key: string) => string | undefined;

const NO_AGENTS: AgentIdOf = () => undefined;

/**
 * What a tool that runs another agent of the workspace takes, by that agent's draft key;
 * `undefined` when none has that key or an agent tool can't run it.
 */
export type AgentToolInputOf = (key: string) => Record<string, unknown> | undefined;

const NO_AGENT_INPUTS: AgentToolInputOf = () => undefined;

function cleanList(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((item) => item.trim()).filter(Boolean);
}

/** Reports `field`, captioned `label`, unless `value` is unset or a whole number ≥ `min`. */
function checkWhole(
  report: Report,
  nodeId: string,
  field: string,
  label: string,
  value: number | null,
  min: 0 | 1,
): void {
  if (value === null || (Number.isInteger(value) && value >= min)) return;
  report(nodeId, `${label} must be a ${min ? 'positive' : 'non-negative'} whole number.`, field);
}

const NAME_LIMITS = {
  agentId: { label: 'Profile id', max: PROFILE_ID_MAX_CHARS },
  handle: { label: 'Handle', max: PROFILE_HANDLE_MAX_CHARS },
} as const;

/** A name is set, and fits the kernel's limit for it. */
function checkName(report: Report, field: keyof typeof NAME_LIMITS, name: string): void {
  const { label, max } = NAME_LIMITS[field];
  if (!name.trim()) {
    report('identity', `${label} is required.`, field);
  } else if (Array.from(name).length > max) {
    report('identity', `${label} is at most ${max} characters.`, field);
  }
}

function checkIdentity(draft: StudioDraft, report: Report): void {
  checkName(report, 'agentId', draft.identity.agentId);
  // A host has no agent identity: it runs no model.
  if (draft.identity.profileType !== 'host') {
    checkName(report, 'handle', draft.identity.handle);
  }
}

/** The model's provider is one the workspace has, and its adapter serves this kind of agent with the model. */
function checkBindingRoute(
  binding: ModelBindingDraft,
  type: Exclude<StudioProfileType, 'host'>,
  providers: readonly StudioProvider[],
  report: Report,
): ModelRoute {
  const nodeId = modelBindingNodeId(binding.key);
  const route = modelRoute(providers, type, { provider: binding.provider, apiId: binding.apiId.trim() });
  if (!providers.some((provider) => provider.id === binding.provider)) {
    report(nodeId, `No provider is defined as ${binding.provider}.`, 'provider');
  } else if (!servesProfileType(route.adapter, type)) {
    report(nodeId, `${binding.provider} doesn't serve ${type} agents.`, 'provider');
  } else if (route.apiId && !servesProfileType(route.adapter, type, route.apiId)) {
    report(nodeId, `${route.apiId} doesn't serve ${type} agents.`, 'apiId');
  }
  if (!route.apiId) {
    report(nodeId, 'Wire model id is required.', 'apiId');
  }
  return route;
}

/** The binding's efforts, keyed by alias, and its default; each problem is reported on the binding. */
function compileEfforts(
  binding: ModelBindingDraft,
  route: ModelRoute,
  nodeId: string,
  report: Report,
): {
  efforts: Record<string, ModelBindingDraft['efforts'][number]['level']>;
  defaultEffort: string;
} {
  const efforts: Record<string, ModelBindingDraft['efforts'][number]['level']> = {};
  binding.efforts.forEach(({ alias, level }, index) => {
    const name = alias.trim();
    if (!name) report(nodeId, 'Every effort needs an alias.', 'efforts', index);
    else if (name in efforts) {
      report(nodeId, `Effort alias '${name}' is used twice.`, 'efforts', index);
    } else efforts[name] = level;
    if (isGoogleRoute(route) && !(GOOGLE_THINKING_LEVELS as readonly string[]).includes(level)) {
      report(
        nodeId,
        `${binding.provider} doesn't take the ${level} thinking level.`,
        'efforts',
        index,
      );
    }
  });
  if (binding.allowEffortSelect && Object.keys(efforts).length < 2) {
    report(nodeId, 'Effort select needs at least two efforts.', 'allowEffortSelect');
  }
  const defaultEffort = binding.defaultEffort.trim();
  if (!defaultEffort && defaultEffortRequired(binding)) {
    report(nodeId, 'Pick a default effort — there is more than one.', 'defaultEffort');
  } else if (defaultEffort && !(defaultEffort in efforts)) {
    report(nodeId, `Default effort '${defaultEffort}' is not one of the efforts.`, 'defaultEffort');
  }
  return { efforts, defaultEffort };
}

/** A built-in tool is its provider's: one left on a model whose provider does not offer it would fail the run. */
function checkBuiltInTools(binding: ModelBindingDraft, route: ModelRoute, nodeId: string, report: Report): void {
  const offered = modelCapabilities(route.adapter, route.apiId)?.builtins;
  if (!offered) return;
  for (const tool of binding.builtInTools.filter((id) => !offered.includes(id))) {
    report(nodeId, `${binding.provider} doesn't offer the built-in tool ${tool}.`, 'builtInTools');
  }
}

function compileBinding(
  binding: ModelBindingDraft,
  type: Exclude<StudioProfileType, 'host'>,
  providers: readonly StudioProvider[],
  report: Report,
  agentIdOf: AgentIdOf,
): ModelBinding {
  const nodeId = modelBindingNodeId(binding.key);
  const route = checkBindingRoute(binding, type, providers, report);
  const { apiId } = route;
  const chained = onGoogleInteractions(route, type);
  const { efforts, defaultEffort } = compileEfforts(binding, route, nodeId, report);
  const effortCount = Object.keys(efforts).length;
  checkWhole(report, nodeId, 'maxOutputTokens', 'Max output tokens', binding.maxOutputTokens, 1);
  if (
    binding.temperature !== null &&
    !(Number.isFinite(binding.temperature) && binding.temperature >= 0)
  ) {
    report(nodeId, 'Temperature must be zero or more.', 'temperature');
  }
  if (chained && binding.persistViaInteractionId && binding.store === false) {
    report(nodeId, 'Chaining needs Google storage on.', 'persistViaInteractionId');
  }
  checkBuiltInTools(binding, route, nodeId, report);
  const cache = compileCache(binding, route, nodeId, report);
  const compaction = compileCompaction(binding, type, nodeId, report, agentIdOf);
  const server = binding.provider === LOCAL_PROVIDER_ID ? binding.server?.trim() : undefined;

  return {
    provider: binding.provider,
    apiId,
    ...(binding.keySlot ? { keySlot: binding.keySlot } : {}),
    ...(binding.fallbackKeySlot ? { fallbackKeySlot: binding.fallbackKeySlot } : {}),
    ...(effortCount ? { efforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(binding.allowEffortSelect ? { allowEffortSelect: true } : {}),
    ...(binding.summaries !== null ? { summaries: binding.summaries } : {}),
    ...(binding.maxOutputTokens !== null ? { maxOutputTokens: binding.maxOutputTokens } : {}),
    ...(binding.temperature !== null ? { temperature: binding.temperature } : {}),
    ...(binding.builtInTools.length ? { builtInTools: [...binding.builtInTools] } : {}),
    providerOptions: jsonObjectSchema.parse({
      ...(cache ? { cache } : {}),
      ...(server ? { server } : {}),
      ...(chained
        ? {
            ...(binding.store !== null ? { store: binding.store } : {}),
            // Unset is off to the kernel, so only on is written.
            ...(binding.persistViaInteractionId ? { persistViaInteractionId: true } : {}),
          }
        : {}),
    }),
    ...(compaction ? { compaction } : {}),
  };
}

/** Prompt caching runs only on OpenRouter's openAi route. */
function compileCache(
  binding: ModelBindingDraft,
  route: ModelRoute,
  nodeId: string,
  report: Report,
): import('../src/kernel/types.ts').CacheSpec | undefined {
  if (!binding.cacheMode) return undefined;
  // A provider on an adapter the studio does not hold is the project's to judge.
  if (route.adapter !== undefined && !isOpenRouterRoute(route)) {
    report(nodeId, 'Prompt caching runs only on OpenRouter.', 'cacheMode');
  }
  return { mode: binding.cacheMode, ...(binding.cacheTtl ? { ttl: binding.cacheTtl } : {}) };
}

/** The agent compacts its own history, or another agent of the workspace writes the summary. */
function compileCompaction(
  binding: ModelBindingDraft,
  type: StudioProfileType,
  nodeId: string,
  report: Report,
  agentIdOf: AgentIdOf,
): ModelBinding['compaction'] {
  const timing = binding.compactTiming;
  if (!timing) return undefined;
  if (type !== 'text') {
    report(nodeId, 'Only a text agent compacts its own history.', 'compactTiming');
  }
  const maxTokens = binding.compactMaxTokens ?? null;
  const compactAt = binding.compactAt ?? COMPACTION_DRAFT_DEFAULTS.compactAt;
  const keep = binding.compactKeep ?? null;
  if (maxTokens === null) report(nodeId, 'Compaction needs a budget.', 'compactMaxTokens');
  checkWhole(report, nodeId, 'compactMaxTokens', 'Budget', maxTokens, 1);
  if (!(compactAt > 0 && compactAt < 1)) {
    report(nodeId, 'Compaction must start between 0 and 1 of the budget.', 'compactAt');
  }
  const keepValid =
    keep !== null &&
    (keep === 0 || (Number.isInteger(keep) && keep >= 1) || (keep > 0 && keep < compactAt));
  if (!keepValid) {
    report(
      nodeId,
      'Keep a whole number of exchanges, a fraction of the budget below where compaction starts, or 0.',
      'compactKeep',
    );
  }
  const compactWith = binding.compactWith ?? '';
  const profile = compactWith ? agentIdOf(compactWith) : undefined;
  if (compactWith && !profile) {
    report(
      nodeId,
      'The agent that summarised is gone. Pick another, or this agent.',
      'compactWith',
    );
  }
  return {
    maxTokens: maxTokens ?? 0,
    compactAt,
    ...(profile ? { profile } : {}),
    previousExchanges: keep ?? 0,
    timing,
    ...(binding.compactMeter ? { meter: binding.compactMeter } : {}),
  };
}

/** A turn model on Google: the kind that can store its interactions and chain from them. */
function onGoogleInteractions(route: ModelRoute, type: StudioProfileType): boolean {
  return isGoogleRoute(route) && type !== 'live';
}

function validateModelPolicy(
  draft: StudioDraft,
  models: Record<string, ModelBinding>,
  report: Report,
): string {
  const { models: policy, modelBindings } = draft;
  if (!modelBindings.length) report('models', 'Add at least one model.');
  const defaultModel = policy.defaultModel.trim();
  if (defaultModel && !(defaultModel in models)) {
    report('models', `Default model '${defaultModel}' is not one of the models.`, 'defaultModel');
  } else if (!defaultModel && defaultModelRequired(draft)) {
    report('models', 'Pick a default model — there is more than one.', 'defaultModel');
  }
  if (policy.maxSteps !== null && !Number.isInteger(policy.maxSteps)) {
    report('models', 'Max steps must be a whole number.', 'maxSteps');
  }
  if (keySlotRequired(draft) && !policy.key) {
    report('models', 'Choose a key slot.', 'key');
  }

  return defaultModel;
}

function compileModels(
  draft: StudioDraft,
  type: Exclude<StudioProfileType, 'host'>,
  report: Report,
  agentIdOf: AgentIdOf,
): Pick<
  ProfileDefinitionBase,
  'models' | 'defaultModel' | 'allowModelSelect' | 'maxSteps' | 'providerContinuation'
> {
  const { models: policy, modelBindings } = draft;
  const models: Record<string, ModelBinding> = {};
  for (const binding of modelBindings) {
    const compiled = compileBinding(
      {
        ...binding,
        keySlot: binding.keySlot || policy.key || undefined,
        fallbackKeySlot: binding.fallbackKeySlot || policy.fallbackKey || undefined,
      },
      type,
      draft.providers,
      report,
      agentIdOf,
    );
    const modelId = binding.modelId.trim();
    const nodeId = modelBindingNodeId(binding.key);
    if (!modelId) report(nodeId, 'Model id is required.', 'modelId');
    else if (modelId in models) {
      report(nodeId, `Model id '${modelId}' is used twice.`, 'modelId');
    } else models[modelId] = compiled;
  }

  const defaultModel = validateModelPolicy(draft, models, report);

  const heldElsewhere =
    policy.providerHistory === 'provider' || policy.providerHistory === 'stateless'
      ? policy.providerHistory
      : undefined;
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(policy.providerStateMismatch === 'error' || heldElsewhere
      ? {
          providerContinuation: {
            onMismatch: policy.providerStateMismatch ?? ('rebuild' as const),
            ...(heldElsewhere ? { history: heldElsewhere } : {}),
          },
        }
      : {}),
    ...(policy.allowModelSelect ? { allowModelSelect: true } : {}),
    ...(policy.maxSteps !== null ? { maxSteps: policy.maxSteps } : {}),
  };
}

/**
 * A JSON object typed in a field: `undefined` when blank or empty, `null` when it isn't an
 * object or a value fails `isValue`.
 */
function parseRecord<T>(
  raw: string | undefined,
  isValue: (value: unknown) => value is T,
): Record<string, T> | undefined | null {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (!entries.every(([, value]) => isValue(value))) return null;
  return entries.length ? (Object.fromEntries(entries) as Record<string, T>) : undefined;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isAny = (_value: unknown): _value is unknown => true;

function parseHeaders(raw: string | undefined): Record<string, string> | undefined | null {
  return parseRecord(raw, isString);
}

const isSystemPrompt = (value: unknown): value is SystemPrompt =>
  systemPromptProblem(value, 'system') === undefined;

/** Each role's text takes `{private: …}` sections like the system prompt; a list of parts passes as written. */
function compileSystemByRole(
  raw: string,
  report: (message: string) => void,
): Record<string, SystemPrompt> | undefined {
  const byRole = parseRecord(raw, isSystemPrompt);
  if (byRole === null) {
    report(
      'Instructions by role must be a JSON object of text, or of lists of text and { "private": text }.',
    );
    return undefined;
  }
  if (!byRole) return undefined;
  const compiled: Record<string, SystemPrompt> = {};
  for (const [role, prompt] of Object.entries(byRole)) {
    if (typeof prompt !== 'string') {
      compiled[role] = prompt;
      continue;
    }
    const parsed = parseSystemMarkup(prompt);
    if (!parsed.ok) {
      report(`${role}: ${parsed.message}`);
      return undefined;
    }
    if (parsed.prompt !== undefined) compiled[role] = parsed.prompt;
  }
  return compiled;
}

/** A record field's value, reporting `message` on `field` when it doesn't parse. */
function recordField<T>(
  raw: string,
  isValue: (value: unknown) => value is T,
  report: () => void,
): Record<string, T> | undefined {
  const parsed = parseRecord(raw, isValue);
  if (parsed === null) report();
  return parsed ?? undefined;
}

function compileAuth(
  tool: ToolSpecDraft,
  fail: Fail,
): Extract<ToolRegistration, { type: 'http' }>['auth'] {
  if (!tool.authType || tool.authType === 'none') return undefined;
  const service = tool.authService?.trim() ?? '';
  if (!service) fail('Service is required.', 'authService');
  const scopes = cleanList(tool.authScopes);
  const queryParam = tool.authType === 'api_key' ? tool.authQueryParam?.trim() : undefined;
  if (queryParam && cleanList(tool.queryParams).includes(queryParam)) {
    fail(`${queryParam} is also one of the query parameters the model fills.`, 'authQueryParam');
  }
  const placement = queryParam
    ? { queryParam }
    : {
        ...(tool.authHeaderName?.trim() ? { headerName: tool.authHeaderName.trim() } : {}),
        ...(tool.authHeaderPrefix !== undefined ? { headerPrefix: tool.authHeaderPrefix } : {}),
      };
  return {
    slot: tool.authSlot?.trim() || 'default',
    type: tool.authType,
    service,
    ...placement,
    onUnauthenticated: tool.authUnauthenticated ?? 'gate',
    ...(scopes.length ? { scopes } : {}),
    ...(tool.authClientId?.trim() ? { clientId: tool.authClientId.trim() } : {}),
    ...(tool.authRedirectUri?.trim() ? { redirectUri: tool.authRedirectUri.trim() } : {}),
  };
}

function isUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

type Fail = (message: string, field: keyof ToolSpecDraft) => void;

function checkToolName(name: string, fail: Fail): void {
  if (!name) fail('Tool name is required.', 'toolName');
  else if (isProviderBuiltinId(name)) {
    fail(
      `${name} is a provider builtin — turn it on under the model's built-in tools.`,
      'toolName',
    );
  }
}

function toolCommon(tool: ToolSpecDraft, fail: Fail, agentInputOf: AgentToolInputOf) {
  const name = tool.toolName.trim();
  checkToolName(name, fail);
  const description = tool.description.trim();
  if (!description) fail('Description is required.', 'description');
  const schemas =
    tool.toolType === 'agent'
      ? {
          inputSchema: agentInputOf(tool.agentKey ?? '') ?? AGENT_TOOL_TEXT_INPUT,
          outputSchema: AGENT_TOOL_OUTPUT,
        }
      : toolSchemas(tool, fail);
  const paths = cleanList(tool.paths);
  return {
    name,
    description,
    category: tool.category.trim() || 'studio',
    access: tool.access,
    permission: tool.permission,
    loadTier: tool.loadTier,
    paths: paths.length ? paths : ['*'],
    ...schemas,
  };
}

function toolSchemas(tool: ToolSpecDraft, fail: Fail) {
  const input = parseJsonSchema(tool.inputJson, 'Input');
  if (!input.ok) fail(input.error, 'inputJson');
  const output = parseJsonSchema(tool.outputJson, 'Output');
  if (!output.ok) fail(output.error, 'outputJson');
  return {
    inputSchema: input.ok ? input.schema : {},
    outputSchema: output.ok ? output.schema : {},
  };
}

/** Every agent tool takes text; what else it takes is the called agent's `inputs`. */
const AGENT_TOOL_TEXT_INPUT = jsonSchemaFromZod(agentToolInputFor({ type: 'text' }), 'input');

/** An agent tool returns the agent's reply: the kernel fixes it. */
const AGENT_TOOL_OUTPUT = jsonSchemaFromZod(agentToolOutput, 'output');

/** What a tool that runs this draft's agent takes, as the kernel derives it from the agent's inputs. */
export function agentToolInputSchema(draft: StudioDraft): Record<string, unknown> | undefined {
  const type = draft.identity.profileType;
  if (type !== 'text' && type !== 'image' && type !== 'speech') return undefined;
  const inputs =
    type !== 'speech' && draftFacets(draft).includes('inputs')
      ? compileInputs(draft.inputs, type, () => {})
      : undefined;
  return jsonSchemaFromZod(agentToolInputFor({ type, ...(inputs ? { inputs } : {}) }), 'input');
}

type ToolCommon = ReturnType<typeof toolCommon>;

/** The lines of a label as its box holds them: one line of wording, or a list with a line each. */
function labelLines(label: string | undefined): string[] {
  return (label ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function toolLabels(
  tool: ToolSpecDraft,
  common: ToolCommon,
  fail: Fail,
): StudioToolLabels | undefined {
  const labels: StudioToolLabels = {};
  const schemas = {
    activity: { input: common.inputSchema },
    activityPast: { input: common.inputSchema, output: common.outputSchema },
    activityFailed: { input: common.inputSchema },
    request: { input: common.inputSchema },
  };
  for (const field of ['activity', 'activityPast', 'activityFailed', 'request'] as const) {
    const lines = labelLines(tool[field]);
    const [only] = lines;
    if (only === undefined) continue;
    const label = lines.length === 1 ? only : lines;
    const problem = activityLabelProblem(label, schemas[field]);
    if (problem) {
      fail(problem, field);
      continue;
    }
    labels[field] = label;
  }
  return Object.keys(labels).length ? labels : undefined;
}

// Headers are saved in the draft, sent on every run and written into the export; a secret there outlives the call.
/** Why these headers can't be saved, when one of them looks like a credential. */
export function credentialHeaderProblem(
  headers: Record<string, string> | undefined,
): string | undefined {
  // A masked one is the project's own: its value never came to the page, and the project fills it in.
  const name = Object.entries(headers ?? {}).find(
    ([header, value]) => isCredentialName(header) && value !== MASK,
  )?.[0];
  return name
    ? `${name} looks like a credential. Put it under Auth instead: Auth asks for it when a call runs and nothing saves it.` // labels-exempt: builder diagnostic
    : undefined;
}

/**
 * Why a tool's URL can't be saved, when a query parameter in it looks like a credential. A masked
 * one is the project's own; a new one goes under Auth, which can send an API key in the URL.
 */
export function credentialUrlProblem(url: string | undefined): string | undefined {
  if (!url || !URL.canParse(url)) return undefined;
  const name = [...new URL(url).searchParams].find(
    ([param, value]) => isCredentialName(param) && value && value !== MASK,
  )?.[0];
  return name
    ? `${name} in the URL looks like a credential. Put it under Auth instead, as an API key with ${name} as its query parameter: Auth asks for it when a call runs and nothing saves it.` // labels-exempt: builder diagnostic
    : undefined;
}

function remoteToolFields(tool: ToolSpecDraft, fail: Fail) {
  const headers = parseHeaders(tool.headersJson);
  if (headers === null) {
    fail(
      'Headers must be a JSON object of strings. Until they are, a reload brings back the headers as they started.',
      'headersJson',
    );
  }
  const credential = credentialHeaderProblem(headers ?? undefined);
  if (credential) fail(credential, 'headersJson');
  const field = tool.toolType === 'mcp' ? 'serverUrl' : 'endpoint';
  const inUrl = credentialUrlProblem(tool[field]?.trim());
  if (inUrl) fail(inUrl, field);
  const auth = compileAuth(tool, fail);
  return { ...(headers ? { headers } : {}), ...(auth ? { auth } : {}) };
}

function checkUrl(
  tool: ToolSpecDraft,
  field: 'endpoint' | 'serverUrl',
  label: string,
  fail: Fail,
): string {
  const url = tool[field]?.trim() ?? '';
  if (!url) fail(`${label} is required.`, field);
  else if (!isUrl(url)) fail(`${label} must be a full URL.`, field);
  return url;
}

function httpTool(tool: ToolSpecDraft, common: ToolCommon, fail: Fail): ToolRegistration {
  const endpoint = checkUrl(tool, 'endpoint', 'Endpoint URL', fail);
  const pathParams = cleanList(tool.pathParams);
  const queryParams = cleanList(tool.queryParams);
  const bodyParam = tool.bodyParam?.trim();
  const mapping = {
    ...(pathParams.length ? { pathParams } : {}),
    ...(queryParams.length ? { queryParams } : {}),
    ...(bodyParam ? { bodyParam } : {}),
  };
  return {
    type: 'http',
    ...common,
    endpoint,
    method: tool.method ?? HTTP_METHODS[0],
    ...remoteToolFields(tool, fail),
    ...(Object.keys(mapping).length ? { mapping } : {}),
  };
}

function mcpTool(tool: ToolSpecDraft, common: ToolCommon, fail: Fail): ToolRegistration {
  const serverUrl = checkUrl(tool, 'serverUrl', 'MCP server URL', fail);
  const mcpToolName = tool.mcpToolName?.trim() ?? '';
  if (!mcpToolName) fail('MCP tool name is required.', 'mcpToolName');
  return {
    type: 'mcp',
    ...common,
    serverUrl,
    mcpToolName,
    ...remoteToolFields(tool, fail),
  };
}

function functionTool(tool: ToolSpecDraft, common: ToolCommon, fail: Fail): ToolRegistration {
  const page = tool.answeredBy === 'page' ? { answeredBy: 'page' as const } : {};
  if (!tool.stubOutputJson?.trim()) return { type: 'function', ...common, ...page };
  const stub = parseJsonSchema(tool.stubOutputJson, 'Stub output');
  if (!stub.ok) fail(stub.error.replace(' JSON Schema', ''), 'stubOutputJson');
  return {
    type: 'function',
    ...common,
    ...page,
    ...(stub.ok ? { stubResponse: stub.schema } : {}),
  };
}

function agentTool(
  tool: ToolSpecDraft,
  common: ToolCommon,
  fail: Fail,
  agentIdOf: AgentIdOf,
): ToolRegistration {
  const key = tool.agentKey ?? '';
  const profile = key ? agentIdOf(key) : undefined;
  if (!key) fail('Pick the agent this tool runs.', 'agentKey');
  else if (!profile) fail('The agent this tool ran is gone. Pick another.', 'agentKey');
  const max = tool.maxCallsPerTurn ?? null;
  if (max !== null && !(Number.isInteger(max) && max >= 1)) {
    fail('Calls per turn must be a positive whole number.', 'maxCallsPerTurn');
  }
  return {
    type: 'agent',
    ...common,
    profile: profile ?? '',
    ...(max !== null ? { maxCallsPerTurn: max } : {}),
  };
}

const TOOL_COMPILERS = {
  http: httpTool,
  mcp: mcpTool,
  function: functionTool,
  agent: agentTool,
};

function isCompiledToolType(type: string): type is keyof typeof TOOL_COMPILERS {
  return (STUDIO_TOOL_TYPES as readonly string[]).includes(type);
}

function compileTool(
  tool: ToolSpecDraft,
  report: Report,
  agentIdOf: AgentIdOf,
  agentInputOf: AgentToolInputOf,
): ToolRegistration | undefined {
  const nodeId = toolSpecNodeId(tool.key);
  if (!isCompiledToolType(tool.toolType)) {
    report(nodeId, STUDIO_TOOL_TYPE_MESSAGE, 'toolType');
    return undefined;
  }
  let failed = false;
  const fail: Fail = (message, field) => {
    failed = true;
    report(nodeId, message, field);
  };
  const common = toolCommon(tool, fail, agentInputOf);
  const labels = toolLabels(tool, common, fail);
  const compiled = TOOL_COMPILERS[tool.toolType](tool, common, fail, agentIdOf);
  return failed ? undefined : { ...compiled, ...(labels ? { labels } : {}) };
}

function compileTools(
  draft: StudioDraft,
  withLoader: boolean,
  report: Report,
  agentIdOf: AgentIdOf,
  agentInputOf: AgentToolInputOf,
) {
  const customTools: ToolRegistration[] = [];
  const names = new Set<string>();
  for (const tool of draft.toolSpecs) {
    const compiled = compileTool(tool, report, agentIdOf, agentInputOf);
    if (!compiled) continue;
    if (names.has(compiled.name)) {
      report(toolSpecNodeId(tool.key), `Tool name '${compiled.name}' is used twice.`, 'toolName');
      continue;
    }
    names.add(compiled.name);
    customTools.push(compiled);
  }
  const allow = customTools.map((tool) => tool.name);
  const t2Loader = withLoader ? draft.tools.t2Loader.trim() : '';
  if (t2Loader && !names.has(t2Loader)) {
    report('tools', `T2 loader '${t2Loader}' must be one of the custom tools.`, 't2Loader');
  }
  return { customTools, tools: { allow, ...(t2Loader ? { t2Loader } : {}) } };
}

function compileInputs(
  inputs: InputsDraft,
  type: StudioProfileType,
  report: Report,
): ProfileInputsSpec {
  const outside =
    type === 'image'
      ? inputs.attachmentsAccept.filter((rule) => !mimeAllowed(IMAGE_ATTACHMENT_ACCEPT_MIMES, rule))
      : [];
  if (outside.length) {
    report(
      'inputs',
      `An image profile takes images, video and PDF only, not ${outside.join(', ')}.`,
      'attachmentsAccept',
    );
  }
  if (!inputs.text && !inputs.attachmentsAccept.length && !inputs.voiceAccept.length) {
    report(
      'inputs',
      'Take text, files or voice notes: with none, the agent can be sent nothing.',
      'text',
    );
  }
  if (inputLimitsRequired(inputs)) {
    const limits = [
      ['maxFiles', 'Max files', inputs.maxFiles],
      ['maxBytes', 'Max bytes', inputs.maxBytes],
      ['maxTurnBytes', 'Max turn bytes', inputs.maxTurnBytes],
    ] as const;
    for (const [field, label, value] of limits) {
      if (value !== null) continue;
      report('inputs', `${label} is required with attachments or voice.`, field);
    }
  }
  checkWhole(report, 'inputs', 'maxFiles', 'Max files', inputs.maxFiles, 1);
  checkWhole(report, 'inputs', 'maxBytes', 'Max bytes', inputs.maxBytes, 1);
  checkWhole(report, 'inputs', 'maxTurnBytes', 'Max turn bytes', inputs.maxTurnBytes, 1);
  const limitsByMime = recordField(inputs.limitsByMimeJson, isPositiveWhole, () => {
    report(
      'inputs',
      'Limits by type must be a JSON object of positive whole numbers.',
      'limitsByMimeJson',
    );
  });
  const slots = compileSlots(inputs, report);
  const context = compileContext(inputs, report);
  return {
    ...(inputs.text ? {} : { text: false }),
    ...(inputs.attachmentsAccept.length
      ? { attachments: { accept: [...inputs.attachmentsAccept] } }
      : {}),
    ...(inputs.voiceAccept.length ? { voice: { accept: [...inputs.voiceAccept] } } : {}),
    ...(inputs.maxFiles !== null ? { maxFiles: inputs.maxFiles } : {}),
    ...(inputs.maxBytes !== null ? { maxBytes: inputs.maxBytes } : {}),
    ...(inputs.maxTurnBytes !== null ? { maxTurnBytes: inputs.maxTurnBytes } : {}),
    ...(limitsByMime ? { limitsByMime } : {}),
    ...(slots ? { slots } : {}),
    ...(context ? { context } : {}),
  };
}

/** Context is on when a sender is listed; then it needs its limit. */
function compileContext(inputs: InputsDraft, report: Report): ProfileContextSpec | undefined {
  if (!inputs.contextFrom.length) return undefined;
  if (inputs.contextMaxChars === null) {
    report('inputs', 'Max characters is required with context.', 'contextMaxChars');
  }
  checkWhole(report, 'inputs', 'contextMaxChars', 'Max characters', inputs.contextMaxChars, 1);
  return { from: [...inputs.contextFrom], maxChars: inputs.contextMaxChars ?? 0 };
}

function compileSlots(inputs: InputsDraft, report: Report): Record<string, string[]> | undefined {
  return recordField(inputs.slotsJson, isValueList, () => {
    report('inputs', 'Slots must be a JSON object of lists of text.', 'slotsJson');
  });
}

/** A call profile's inputs are its slots and context, and are left out when it has neither. */
function compileLiveInputs(inputs: InputsDraft, report: Report): { inputs?: LiveInputsSpec } {
  const slots = compileSlots(inputs, report);
  const context = compileContext(inputs, report);
  if (!slots && !context) return {};
  return { inputs: { ...(slots ? { slots } : {}), ...(context ? { context } : {}) } };
}

const isPositiveWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const isValueList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'string' && item.trim() !== '');

/** `shaped`: the type takes a structured reply and its validation (text only). */
function compileOutputs(
  outputs: OutputsDraft,
  shaped: boolean,
  report: Report,
): { outputs?: ProfileOutputsSpec; structured?: StructuredRegistration } {
  let structured: StructuredRegistration | undefined;
  const validationEnabled = shaped && outputs.validationEnabled;
  if (shaped && outputs.mode === 'structured') {
    const id = outputs.schemaId.trim();
    if (!id) {
      report('outputs', 'Structured output needs a schema id.', 'schemaId');
    }
    const schema = parseJsonSchema(outputs.schemaJson, 'Structured output');
    if (!schema.ok) report('outputs', schema.error, 'schemaJson');
    if (id && schema.ok) {
      structured = { id, spec: { jsonSchema: schema.schema } };
    }
  }
  if (validationEnabled) {
    checkWhole(report, 'outputs', 'maxRetries', 'Validation max retries', outputs.maxRetries, 0);
  }
  // why: a rule's check is the project's code; a run and Save lay this over the rule as registered.
  const items = Object.fromEntries(
    Object.entries(outputs.itemRules).map(([list, onFail]) => [list, { onFail } as ProfileItemRule]),
  );
  const validation = validationEnabled
    ? {
        ...(outputs.maxRetries !== null ? { maxRetries: outputs.maxRetries } : {}),
        ...(Object.keys(items).length ? { items } : {}),
      }
    : {};
  const streaming = {
    ...(outputs.streamMode ? { mode: outputs.streamMode } : {}),
    ...(outputs.streamThoughts ? {} : { streamThoughts: false }),
  };
  const spec: ProfileOutputsSpec = {
    ...(structured ? { structured: structured.id } : {}),
    ...(Object.keys(validation).length ? { validation } : {}),
    ...(Object.keys(streaming).length ? { streaming } : {}),
  };
  return {
    ...(Object.keys(spec).length ? { outputs: spec } : {}),
    ...(structured ? { structured } : {}),
  };
}

function compileResumption(turn: TurnBehaviourDraft, report: Report) {
  // "Never" is written out, both lists: left out, the kernel offers every kind and continues two itself.
  if (!turn.resumeEnabled) return { allowContinue: [], autoContinue: [] };
  checkWhole(report, 'turnBehaviour', 'maxContinues', 'Max continues', turn.maxContinues, 1);
  return {
    // Both always written: left out, the kernel continues all three kinds and
    // auto-continues length and stream_incomplete.
    allowContinue: [...turn.allowContinue],
    autoContinue: [...turn.autoContinue],
    ...(turn.maxContinues !== null ? { maxContinues: turn.maxContinues } : {}),
  };
}

function compileTurnBehaviour(
  turn: TurnBehaviourDraft,
  withResumption: boolean,
  report: Report,
): ProfileTurnBehaviourSpec | undefined {
  const resumption = withResumption ? compileResumption(turn, report) : undefined;
  const spec: ProfileTurnBehaviourSpec = {
    ...(resumption ? { resumption } : {}),
    ...(turn.allowSteering ? {} : { allowSteering: false }),
    ...(turn.atStepLimit === 'answer' ? { atStepLimit: turn.atStepLimit } : {}),
  };
  return Object.keys(spec).length ? spec : undefined;
}

/**
 * Each line is checked by the kernel's labels rules and reported on the node that owns it. A line
 * edited beside a setting is written whenever it is worded and the profile's type takes it, with
 * the setting on or off: the kernel holds it either way, and so does a project's file.
 */
function compileLabels(
  draft: StudioDraft,
  facets: ReadonlySet<string>,
  allows: (path: string) => boolean,
  report: Report,
): LabelOverrides | undefined {
  const entries: Array<[nodeId: string, field: string, key: LabelKey, template: string]> = [];
  const shown = (facet: string) => facets.has(facet) || facets.has('labels');
  const { turnBehaviour: turn, guardrails, outputs } = draft;
  if (shown('turnBehaviour') && takesContinueInstruction(draft)) {
    entries.push(['turnBehaviour', 'continueInstruction', 'continue.instruction', turn.continueInstruction.trim()]);
  }
  if (shown('guardrails') && allows('identity.system')) {
    entries.push(['guardrails', 'canaryBindNote', 'canary.bind_note', guardrails.canaryBindNote.trim()]);
  }
  if (shown('guardrails') && allows('guardrails.quota')) {
    entries.push(['guardrails', 'quotaMessage', 'quota.exhausted', guardrails.quotaMessage.trim()]);
  }
  if (shown('outputs') && allows('outputs.validation')) {
    entries.push(['outputs', 'repairGuidance', 'repair.default_guidance', outputs.repairGuidance.trim()]);
  }
  if (shown('guardrails') && allows('guardrails.blockedReply')) {
    entries.push(['guardrails', 'egressRepairGuidance', 'egress.default_repair_guidance', guardrails.egressRepairGuidance.trim()]);
    entries.push(['guardrails', 'egressRefusal', 'egress.refusal', guardrails.egressRefusal.trim()]);
  }
  if (facets.has('labels')) {
    for (const [key, template] of Object.entries(draft.labels) as [LabelKey, string][]) {
      if (!INLINE_LABELS[key]) entries.push(['labels', key, key, template.trim()]);
    }
  }
  const labels: LabelOverrides = {};
  for (const [nodeId, field, key, template] of entries) {
    if (!template) continue;
    try {
      validateLabelOverrides({ [key]: template }, 'Profile labels');
      labels[key] = template;
    } catch (err) {
      report(nodeId, describeError(err), field);
    }
  }
  return Object.keys(labels).length ? labels : undefined;
}

function compileQuota(guardrails: GuardrailsDraft, report: Report): ProfileGuardrailsSpec['quota'] {
  if (!guardrails.quotaEnabled) return undefined;
  if (guardrails.quotaPerDay === null) {
    report('guardrails', 'Quota needs turns per day.', 'quotaPerDay');
    return undefined;
  }
  checkWhole(report, 'guardrails', 'quotaPerDay', 'Quota per day', guardrails.quotaPerDay, 1);
  return { perDay: guardrails.quotaPerDay };
}

function compileBlockedReply(
  guardrails: GuardrailsDraft,
  report: Report,
): ProfileGuardrailsSpec['blockedReply'] {
  checkWhole(
    report,
    'guardrails',
    'blockedReplyMaxRetries',
    'Blocked reply max retries',
    guardrails.blockedReplyMaxRetries,
    0,
  );
  const spec = {
    ...(guardrails.blockedReplyOnBlock ? { onBlock: guardrails.blockedReplyOnBlock } : {}),
    ...(guardrails.blockedReplyMaxRetries !== null
      ? { maxRetries: guardrails.blockedReplyMaxRetries }
      : {}),
  };
  return Object.keys(spec).length ? spec : undefined;
}

function compileNetwork(
  guardrails: GuardrailsDraft,
  report: Report,
): ProfileGuardrailsSpec['network'] {
  const hosts = guardrails.allowedHosts.map((host) => host.trim());
  const blank = hosts.indexOf('');
  if (blank !== -1) {
    report('guardrails', 'Allowed hosts cannot be blank.', 'allowedHosts', blank);
  }
  const schemes = cleanList(guardrails.allowedSchemes);
  if (!guardrails.allowPrivateNetworks && !hosts.length && !schemes.length) return undefined;
  return {
    ...(guardrails.allowPrivateNetworks ? { allowPrivateNetworks: true } : {}),
    ...(hosts.length ? { allowedHosts: hosts } : {}),
    ...(schemes.length ? { allowedSchemes: schemes } : {}),
  };
}

/** What the detector lets through, where it differs from the kernel's: omitted when it does not. */
function compileUrlAllow(
  detector: UrlDetector,
  allow: UrlAllowDraft,
  report: Report,
): UrlAllow | undefined {
  const hosts = allow.hosts.map((host) => host.trim());
  const blank = hosts.indexOf('');
  if (blank !== -1) {
    report('guardrails', 'Allowed hosts cannot be blank.', `allow.${detector}.hosts`, blank);
  }
  const named = hosts.filter(Boolean);
  const spec: UrlAllow = {
    ...(named.length ? { hosts: named } : {}),
    ...(allow.fromTools ? {} : { fromTools: false }),
  };
  return Object.keys(spec).length ? spec : undefined;
}

/**
 * What is wrong with the builder's patterns, as the builder reads it: a pattern by its place in
 * the list, where the kernel names it by its path in the profile.
 */
function patternIssue(
  drafts: readonly PatternDraft[],
  patterns: readonly HostPattern[],
): string | undefined {
  for (const [index, draft] of drafts.entries()) {
    const which = `Pattern ${index + 1}`;
    if (!draft.name.trim()) return `${which} needs a name.`;
    if (draft.kind === 'words') {
      if (!cleanList(draft.words).length) return `${which} needs a word to match.`;
    } else if (!draft.pattern) return `${which} needs a regular expression.`;
  }
  const problem = patternListProblem('', patterns);
  if (problem === undefined) return undefined;
  const at = /^\.patterns\[(\d+)\](?:\.(\w+))?:? (.*)$/s.exec(problem);
  if (!at) return problem.replace(/^\.patterns/, 'This');
  const [, index, setting, rest] = at;
  return `Pattern ${Number(index) + 1}${setting ? `, ${setting}` : ''}: ${rest}`;
}

/** The builder's patterns as the kernel takes them; what is wrong with one is reported at `field`. */
function compilePatterns(
  drafts: readonly PatternDraft[],
  field: string,
  report: Report,
): HostPattern[] {
  const patterns = drafts.map((draft): HostPattern => {
    const name = draft.name.trim();
    if (draft.kind === 'words') return { name, words: cleanList(draft.words) };
    const flags = draft.flags.trim();
    return { name, pattern: draft.pattern, ...(flags ? { flags } : {}) };
  });
  const problem = patternIssue(drafts, patterns);
  if (problem !== undefined) report('guardrails', problem, field);
  return patterns;
}

/** Whose patterns `detector` reads with, where that differs from Theorem's alone. */
function compileSource(
  detector: Detector,
  source: PatternSourceDraft | undefined,
  report: Report,
): Pick<DetectorConfig, 'theorem' | 'patterns' | 'hint'> {
  if (!source || !DETECTOR_META[detector].patterns) return {};
  const hint = compileHint(source.hint, `sources.${detector}.hint`, report);
  const patterns = compilePatterns(source.patterns, `sources.${detector}.patterns`, report);
  return {
    ...(source.theorem ? {} : { theorem: false }),
    ...(patterns.length ? { patterns } : {}),
    // A hint speaks for the builder's patterns, so it goes only beside some.
    ...(patterns.length && hint ? { hint } : {}),
  };
}

/** A hint as the kernel takes it, or `undefined` when the builder wrote none. */
function compileHint(draft: string, field: string, report: Report): string | undefined {
  const hint = draft.trim();
  if (!hint) return undefined;
  const problem = hintProblem('The retry hint', hint);
  if (problem !== undefined) report('guardrails', `${problem}.`, field);
  return hint;
}

/** What is wrong with the key of one of the builder's detectors; the kernel judges its form. */
function ownKeyIssue(key: string, boundaries: readonly Boundary[]): string | undefined {
  if (!key) return 'Give this detector a key, such as acme.codenames.';
  const sound = { label: key, action: 'flag', find: PATTERNS_PENDING };
  return detectProblem('Detect', { [key]: sound }, boundaries) === undefined
    ? undefined
    : 'A key is a namespace, a dot and a name, in lower case letters, digits and _, such as acme.codenames.';
}

/** The builder's own detectors, each read at the boundaries of the profile it sets above `ignore`. */
function compileOwnDetectors(
  own: readonly OwnDetectorDraft[],
  boundaries: readonly Boundary[],
  report: Report,
): Record<string, HostDetectorConfig> {
  const spec: Record<string, HostDetectorConfig> = {};
  for (const [index, detector] of own.entries()) {
    const key = detector.key.trim();
    if (Object.hasOwn(spec, key)) {
      report('guardrails', `Detector ${key} is listed twice.`, 'own', index);
      continue;
    }
    const read = boundaries.filter((boundary) => detector.at[boundary] !== 'ignore');
    const hint = compileHint(detector.hint, `own.${index}.hint`, report);
    const patterns = compilePatterns(detector.patterns, `own.${index}.patterns`, report);
    const label = detector.label.trim();
    const keyed = ownKeyIssue(key, boundaries);
    if (keyed !== undefined) report('guardrails', keyed, 'own', index);
    if (!label) report('guardrails', 'Give this detector a name.', `own.${index}.label`);
    if (!read.length) {
      report('guardrails', 'Pick what a match does. It is ignored now.', `own.${index}.at`);
    }
    // Each is said above in the builder's words, so the kernel is not asked to say it again.
    if (keyed !== undefined || !label || !read.length) continue;
    spec[key] = {
      label,
      at: Object.fromEntries(read.map((boundary) => [boundary, detector.at[boundary]])),
      patterns,
      ...(hint ? { hint } : {}),
    };
  }
  return spec;
}

/** A `find` that stands for patterns not yet compiled, while the rest of a detector is checked. */
const PATTERNS_PENDING = () => [];

/**
 * `detect` as it can be checked before its patterns are compiled: the run's server compiles them
 * as it registers the profile, so here each list is left out and checked on its own.
 */
function withoutPatterns(detect: DetectSpec | undefined): DetectSpec | undefined {
  if (detect === undefined || typeof detect === 'string') return detect;
  return Object.fromEntries(
    Object.entries(detect as Record<string, DetectorRule | HostDetectorConfig>).map(
      ([key, rule]) => {
        if (typeof rule === 'string' || rule.patterns === undefined) return [key, rule];
        const { patterns: _patterns, ...rest } = rule;
        if (key.includes('.')) return [key, { ...rest, find: PATTERNS_PENDING }];
        // A hint goes with the patterns left out, and `compileHint` has checked it.
        const { hint: _hint, ...settings } = rest;
        return [key, settings];
      },
    ),
  ) as DetectSpec;
}

/** `profile` as it can be defined here, before the run's server compiles its patterns. */
export function uncompiled<P extends ProfileDefinition>(profile: P): P {
  const { guardrails } = profile;
  if (!guardrails || !('detect' in guardrails) || guardrails.detect === undefined) return profile;
  return {
    ...profile,
    guardrails: { ...guardrails, detect: withoutPatterns(guardrails.detect) },
  };
}

/**
 * The actions that differ from the defaults, at the boundaries the profile has; what each URL
 * detector that reads one of them lets through; whose patterns each detector reads with; and the
 * builder's own detectors.
 */
function compileDetect(
  guardrails: Pick<GuardrailsDraft, 'detect' | 'allow' | 'innocentNames' | 'sources' | 'own'>,
  boundaries: readonly Boundary[],
  report: Report,
): DetectSpec | undefined {
  const { detect } = guardrails;
  const spec: Record<string, DetectorConfig | HostDetectorConfig> = {};
  for (const detector of DETECTORS) {
    const changed = boundaries.filter(
      (boundary) => detect[detector][boundary] !== DETECT_DEFAULTS[detector][boundary],
    );
    const reads = boundaries.some((boundary) => detect[detector][boundary] !== 'ignore');
    const allow = reads ? compileAllow(detector, guardrails, report) : undefined;
    const source = compileSource(detector, guardrails.sources[detector], report);
    if (!changed.length && !allow && !Object.keys(source).length) continue;
    spec[detector] = {
      ...(changed.length
        ? {
            at: Object.fromEntries(
              changed.map((boundary) => [boundary, detect[detector][boundary]]),
            ),
          }
        : {}),
      ...source,
      ...(allow ? { allow } : {}),
    };
  }
  Object.assign(spec, compileOwnDetectors(guardrails.own, boundaries, report));
  const problem = detectProblem('Detect', withoutPatterns(spec as DetectSpec), boundaries);
  if (problem !== undefined) report('guardrails', problem, 'detect');
  return Object.keys(spec).length ? (spec as DetectSpec) : undefined;
}

/** What `detector` lets through: addresses, names, or for most detectors nothing. */
function compileAllow(
  detector: Detector,
  guardrails: Pick<GuardrailsDraft, 'allow' | 'innocentNames'>,
  report: Report,
): UrlAllow | NameAllow | undefined {
  if (isUrlDetector(detector)) return compileUrlAllow(detector, guardrails.allow[detector], report);
  if (DETECTOR_META[detector].allow !== 'names') return undefined;
  const names = guardrails.innocentNames.map((name) => name.trim());
  const blank = names.indexOf('');
  if (blank !== -1) report('guardrails', 'Allowed names cannot be blank.', 'innocentNames', blank);
  const named = names.filter(Boolean);
  return named.length ? { names: named } : undefined;
}

function isUrlDetector(detector: Detector): detector is UrlDetector {
  return DETECTOR_META[detector].allow === 'urls';
}

function compileTaint(guardrails: GuardrailsDraft): ProfileGuardrailsSpec['taint'] {
  const { taintAfterRemoteRead: afterRemoteRead, taintRemoteDestination: remoteDestination } =
    guardrails;
  if (!afterRemoteRead && !remoteDestination) return undefined;
  return {
    ...(afterRemoteRead ? { afterRemoteRead } : {}),
    ...(remoteDestination ? { remoteDestination } : {}),
  };
}

function compileGuardrails(
  guardrails: GuardrailsDraft,
  report: Report,
  boundaries: readonly Boundary[] = BOUNDARIES,
): ProfileGuardrailsSpec | undefined {
  const parts: ProfileGuardrailsSpec = {
    detect: compileDetect(guardrails, boundaries, report),
    quota: compileQuota(guardrails, report),
    blockedReply: compileBlockedReply(guardrails, report),
    network: compileNetwork(guardrails, report),
    taint: compileTaint(guardrails),
  };
  const spec = Object.fromEntries(
    Object.entries(parts).filter(([, value]) => value !== undefined),
  ) as ProfileGuardrailsSpec;
  return Object.keys(spec).length ? spec : undefined;
}

function compileObservability(
  observability: ObservabilityDraft,
  report: Report,
): ProfileObservabilitySpec | undefined {
  // why: a profile that writes this block is read with the kernel's defaults for one that does.
  const defaults = resolveObservabilityPolicy({});
  const { writeTo } = observability;
  const { sampleRate } = observability;
  if (!(Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1)) {
    report('observability', 'Sample rate must be between 0 and 1.', 'sampleRate');
  }
  if (observability.retainForDays !== null && !Number.isFinite(observability.retainForDays)) {
    report('observability', 'Retain for days must be a number.', 'retainForDays');
  }
  if (
    observability.rotateAfterMiB !== null &&
    !(Number.isFinite(observability.rotateAfterMiB) && observability.rotateAfterMiB > 0)
  ) {
    report('observability', 'Rotate after MiB must be more than zero.', 'rotateAfterMiB');
  }
  const resource = recordField(observability.resourceJson, isAny, () => {
    report('observability', 'Resource must be a JSON object.', 'resourceJson');
  });

  const include = Object.fromEntries(
    Object.entries(observability.include).filter(
      ([name, on]) => on !== defaults.include[name as keyof typeof defaults.include],
    ),
  );
  const scrub = Object.fromEntries(
    Object.entries(observability.scrub).filter(
      ([name, on]) => on !== defaults.scrub[name as keyof typeof defaults.scrub],
    ),
  );
  const spec: ProfileObservabilitySpec = {
    writeTo,
    ...(sampleRate !== defaults.sampleRate ? { sampleRate } : {}),
    ...(Object.keys(include).length ? { include } : {}),
    ...(Object.keys(scrub).length ? { scrub } : {}),
    ...(observability.retainForDays !== null ? { retainForDays: observability.retainForDays } : {}),
    ...(observability.rotateAfterMiB !== null
      ? { rotateAfterMiB: observability.rotateAfterMiB }
      : {}),
    ...(resource
      ? { resource: resource as NonNullable<ProfileObservabilitySpec['resource']> }
      : {}),
  };
  return Object.keys(spec).length ? spec : undefined;
}

/** The image types a reference link may name, by its file extension. */
const REFERENCE_LINK_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** A link's image type, from its path's extension; undefined unless it is an http(s) image link. */
function referenceLinkMime(uri: string): string | undefined {
  if (!URL.canParse(uri)) return undefined;
  const url = new URL(uri);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const extension = url.pathname.split('.').pop()?.toLowerCase() ?? '';
  return REFERENCE_LINK_MIMES[extension];
}

type PinnedReference = NonNullable<ProfileImageSpec['references']>[number];

function compileReferences(
  references: readonly ImageReferenceDraft[],
  report: Report,
): PinnedReference[] {
  return references.flatMap((reference, index): PinnedReference[] => {
    if ('data' in reference) {
      if (reference.mimeType.startsWith('image/') && reference.data) {
        return [{ mimeType: reference.mimeType, data: reference.data, name: reference.name }];
      }
      report('image', `${reference.name || 'A reference'} is not an image.`, 'references', index);
      return [];
    }
    const uri = reference.uri.trim();
    const mimeType = referenceLinkMime(uri);
    if (mimeType) return [{ mimeType, uri, ...(reference.name ? { name: reference.name } : {}) }];
    report(
      'image',
      uri
        ? 'Link to a .png, .jpg, .webp or .gif image over http(s).'
        : 'Add a link or remove the reference.',
      'references',
      index,
    );
    return [];
  });
}

function compileImage(image: ImageDraft, report: Report): ProfileImageSpec {
  checkWhole(report, 'image', 'n', 'Images per request', image.n, 1);
  checkWhole(report, 'image', 'seed', 'Seed', image.seed, 0);
  checkWhole(report, 'image', 'outputCompression', 'Compression', image.outputCompression, 0);
  if (image.outputCompression !== null && image.outputCompression > 100) {
    report('image', 'Compression goes from 0 to 100.', 'outputCompression');
  }
  const references = compileReferences(image.references, report);
  return {
    ...(image.aspectRatio.trim() ? { aspectRatio: image.aspectRatio.trim() } : {}),
    ...(image.resolution.trim() ? { resolution: image.resolution.trim() } : {}),
    ...(image.mimeType.trim() ? { mimeType: image.mimeType.trim() } : {}),
    ...(image.quality.trim() ? { quality: image.quality.trim() } : {}),
    ...(image.background.trim() ? { background: image.background.trim() } : {}),
    ...(image.n !== null ? { n: image.n } : {}),
    ...(image.seed !== null ? { seed: image.seed } : {}),
    ...(image.outputCompression !== null ? { outputCompression: image.outputCompression } : {}),
    ...(image.includeText ? { includeText: true } : {}),
    ...(references.length ? { references } : {}),
  };
}

function compileSpeech(
  speech: SpeechDraft,
  draft: StudioDraft,
  report: Report,
): ProfileSpeechSpec {
  const { format } = speech;
  if (format) {
    const refused = draft.modelBindings.find(
      (binding) =>
        isGoogleRoute(modelRoute(draft.providers, 'speech', binding)) &&
        !(GOOGLE_SPEECH_FORMATS as readonly string[]).includes(format),
    );
    if (refused) {
      report(
        'speech',
        `Google doesn't make ${format}; ${refused.modelId} is on ${refused.provider}.`,
        'format',
      );
    }
  }
  const { speed } = speech;
  return {
    ...(speech.voice.trim() ? { voice: speech.voice.trim() } : {}),
    ...(speech.style.trim() ? { style: speech.style.trim() } : {}),
    ...(speed !== null ? { speed } : {}),
    ...(format ? { format } : {}),
  };
}

/** What a resumed call opens with; it needs resumption on, and the wait needs a prompt. */
function compileResumed(live: LiveDraft, report: Report): ProfileLiveSpec['resumed'] {
  checkWhole(report, 'live', 'resumedAfterMs', 'Away for', live.resumedAfterMs, 0);
  const prompt = live.resumedPrompt.trim();
  if (prompt && !live.sessionResumption) {
    report('live', 'A resume prompt needs Resumption on.', 'resumedPrompt');
  }
  if (!prompt) {
    if (live.resumedAfterMs !== null) {
      report('live', 'Away for needs a resume prompt.', 'resumedAfterMs');
    }
    return undefined;
  }
  return { prompt, ...(live.resumedAfterMs !== null ? { afterMs: live.resumedAfterMs } : {}) };
}

function compileLive(
  live: LiveDraft,
  report: Report,
  on: StudioRunsOn,
): ProfileLiveSpec {
  if (!live.ingressAudio && !live.ingressVideo && !live.ingressText) {
    report('live', 'Turn on at least one ingress channel.');
  }
  checkWhole(
    report,
    'live',
    'vadPrefixPaddingMs',
    'VAD prefix padding',
    live.vadPrefixPaddingMs,
    0,
  );
  checkWhole(
    report,
    'live',
    'vadSilenceDurationMs',
    'VAD silence duration',
    live.vadSilenceDurationMs,
    0,
  );

  if (live.contextCompression) checkCompression(live, report, on.mode === 'demo' ? on.keys.liveInputTokens : undefined);
  const resumed = compileResumed(live, report);

  const channels = {
    audio: live.ingressAudio,
    video: live.ingressVideo,
    text: live.ingressText,
  };
  const ingress = Object.fromEntries(
    Object.entries(channels).filter(
      ([channel, on]) => on !== liveIngressChannelDefault(channel as keyof typeof channels),
    ),
  );
  const vad = {
    ...(live.vadActivityHandling ? { activityHandling: live.vadActivityHandling } : {}),
    ...(live.vadStartSensitivity ? { startSensitivity: live.vadStartSensitivity } : {}),
    ...(live.vadEndSensitivity ? { endSensitivity: live.vadEndSensitivity } : {}),
    ...(live.vadPrefixPaddingMs !== null ? { prefixPaddingMs: live.vadPrefixPaddingMs } : {}),
    ...(live.vadSilenceDurationMs !== null ? { silenceDurationMs: live.vadSilenceDurationMs } : {}),
  };
  const transcription = {
    ...(live.transcriptionInput ? { input: true } : {}),
    ...(live.transcriptionOutput ? { output: true } : {}),
  };
  return {
    ...(Object.keys(ingress).length ? { ingress } : {}),
    ...(live.voice.trim() ? { voice: live.voice.trim() } : {}),
    ...(Object.keys(vad).length ? { vad } : {}),
    ...(live.sessionResumption ? { sessionResumption: true } : {}),
    ...(live.greeting.trim() ? { greeting: live.greeting.trim() } : {}),
    ...(resumed ? { resumed } : {}),
    ...(live.contextCompression ? { contextCompression: contextCompression(live) } : {}),
    ...(Object.keys(transcription).length ? { transcription } : {}),
  };
}

/** Whole numbers, the target below the trigger, and on lent keys both within the session they hold. */
function checkCompression(live: LiveDraft, report: Report, held: number | undefined): void {
  checkWhole(
    report,
    'live',
    'compressionTriggerTokens',
    'Compression trigger',
    live.compressionTriggerTokens,
    1,
  );
  checkWhole(
    report,
    'live',
    'compressionTargetTokens',
    'Compression target',
    live.compressionTargetTokens,
    1,
  );
  const trigger = live.compressionTriggerTokens;
  const target = live.compressionTargetTokens;
  const cap = held?.toLocaleString('en-US');
  if (held !== undefined && trigger !== null && trigger > held) {
    report(
      'live',
      `Compression trigger can't exceed the ${cap} input tokens a session holds on these keys.`,
      'compressionTriggerTokens',
    );
  }
  if (
    target !== null &&
    ((trigger !== null && target >= trigger) || (held !== undefined && trigger === null && target >= held))
  ) {
    report(
      'live',
      trigger !== null
        ? 'Compression target must be below the trigger.'
        : `Compression target must be below the ${cap} input tokens a session holds on these keys.`,
      'compressionTargetTokens',
    );
  }
}

/** A blank number is left to the provider. */
function contextCompression(live: LiveDraft): LiveContextCompressionSpec {
  const trigger = live.compressionTriggerTokens;
  const target = live.compressionTargetTokens;
  return {
    ...(trigger !== null ? { triggerTokens: trigger } : {}),
    slidingWindow: target !== null ? { targetTokens: target } : {},
  };
}

/** `root` without the value at `segments`; its parents stay, even if left empty. */
function withoutPath(
  root: Record<string, unknown>,
  segments: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = segments;
  const { [head]: child, ...others } = root;
  if (!rest.length || child === null || typeof child !== 'object') {
    return others;
  }
  return { ...others, [head]: withoutPath(child as Record<string, unknown>, rest) };
}

/** Drop what the type may not set (`PROFILE_FIELD_SCOPE`); the draft keeps it across type changes. */
function omitOutOfScope(profile: Record<string, unknown> & { type: StudioProfileType }) {
  let out: Record<string, unknown> = profile;
  for (const { path } of outOfScopeFields(profile)) {
    out = withoutPath(out, path.split('.'));
  }
  return out as StudioProfileDefinition;
}

/** The draft's decision questions, each problem reported on the Decision facet. */
function compileQuestions(
  decision: DecisionDraft,
  report: Report,
): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = Object.create(null);
  if (!decision.questions.length) {
    report('decision', 'Add at least one question.', 'questions');
  }
  decision.questions.forEach((question, index) => {
    const fail = (message: string) => report('decision', message, 'questions', index);
    const id = question.id.trim();
    const instructions = question.instructions.trim();
    if (!id) fail('Each question needs an id.');
    else if (Object.hasOwn(questions, id)) {
      fail(`Question id '${id}' is used twice.`);
    }
    if (!instructions) fail(`Question '${id || index + 1}' needs instructions.`);
    const rows = question.criteria.map((row) => ({
      label: row.label.trim(),
      text: row.text.trim(),
    }));
    if (!id || !instructions) return;
    if (question.type === 'score') {
      if (rows.length < 2 || rows.some((row) => !row.text)) {
        fail(`Score '${id}' needs at least two levels, each described.`);
      }
      questions[id] = {
        type: 'score',
        instructions,
        criteria: rows.map((row) => row.text),
      };
      return;
    }
    const labelled: Record<string, DecisionEntry> = Object.create(null);
    for (const row of rows) {
      if (!row.label) fail(`Every option of '${id}' needs a label.`);
      else if (Object.hasOwn(labelled, row.label)) {
        fail(`Option '${row.label}' of '${id}' is used twice.`);
      } // A label says enough on its own; its description, when given, says when to pick it.
      else labelled[row.label] = row.text || row.label;
    }
    if (question.type === 'choice') {
      if (rows.length < 2) fail(`Choice '${id}' needs at least two options.`);
      questions[id] = { type: 'choice', instructions, criteria: labelled };
    } else {
      questions[id] = {
        type: 'noul',
        instructions,
        ...(rows.length ? { criteria: labelled } : {}),
      };
    }
  });
  return questions;
}

function compileProfileOptions(
  draft: StudioDraft,
  facets: Set<string>,
  report: Report,
): Pick<ProfileDefinitionBase, 'observability' | 'labels'> {
  const observability = facets.has('observability')
    ? compileObservability(draft.observability, report)
    : undefined;
  const labels = compileLabels(draft, facets, (path) => draftAllows(draft, path), report);
  return {
    ...(observability ? { observability } : {}),
    ...(labels ? { labels } : {}),
  };
}

function checkDecisionIdentity(draft: StudioDraft, report: Report): string {
  const { decision } = draft;
  const contract = decision.contract.trim();
  if (!contract) report('decision', 'Contract is required.', 'contract');
  return contract;
}

/** What a decision may hold on lent keys, each limit reported on the field it bounds. */
function checkLentDecision(
  draft: StudioDraft,
  questions: Record<string, DecisionQuestion>,
  keys: LentKeys,
  report: Report,
): void {
  const limits = keys.decision;
  const { decision, identity } = draft;
  const over = (text: string, most: number) => text.trim().length > most;
  if (over(decision.contract, limits.idChars)) {
    report('decision', `Contract is limited to ${limits.idChars} characters on these keys.`, 'contract');
  }
  if (over(identity.agentId, limits.idChars)) {
    report('identity', `Profile id is limited to ${limits.idChars} characters on these keys.`, 'agentId');
  }
  if (over(identity.handle, limits.nameChars)) {
    report('identity', `Handle is limited to ${limits.nameChars} characters on these keys.`, 'handle');
  }
  const binding = draft.modelBindings[0];
  if (binding) {
    const nodeId = modelBindingNodeId(binding.key);
    if (binding.timeoutMs !== null && binding.timeoutMs > limits.timeoutMs) {
      report(nodeId, `Timeout is limited to ${limits.timeoutMs} ms on these keys.`, 'timeoutMs');
    }
    if (over(binding.modelId, limits.nameChars)) {
      report(nodeId, `Model id is limited to ${limits.nameChars} characters on these keys.`, 'modelId');
    }
    if (over(binding.apiId, limits.idChars)) {
      report(nodeId, `API model is limited to ${limits.idChars} characters on these keys.`, 'apiId');
    }
  }
  if (decision.maxStateBytes !== null && decision.maxStateBytes > limits.stateBytes) {
    report('decision', `These keys take at most ${limits.stateBytes} bytes of state.`, 'maxStateBytes');
  }
  if (decision.questions.length > limits.questions) {
    report('decision', `These keys ask at most ${limits.questions} questions.`, 'questions');
  }
  decision.questions.forEach((question, index) => {
    const fail = (message: string) => report('decision', message, 'questions', index);
    if (over(question.id, limits.nameChars)) {
      fail(`Question ids are limited to ${limits.nameChars} characters on these keys.`);
    }
    if (over(question.instructions, limits.instructionsChars)) {
      fail(`Instructions are limited to ${limits.instructionsChars} characters on these keys.`);
    }
    if (question.criteria.length > limits.criteria) {
      fail(`A question has at most ${limits.criteria} options or levels on these keys.`);
    }
    if (question.criteria.some((row) => over(row.text, limits.criterionChars))) {
      fail(`Each option or level is limited to ${limits.criterionChars} characters on these keys.`);
    }
    if (question.criteria.some((row) => over(row.label, limits.nameChars))) {
      fail(`Option labels are limited to ${limits.nameChars} characters on these keys.`);
    }
    const compiled = questions[question.id.trim()];
    const violation = binding && compiled &&
      keys.questionViolation(modelRoute(draft.providers, 'decision', binding), compiled);
    if (violation) fail(violation);
  });
}

function compileDecision(
  draft: StudioDraft,
  report: Report,
  on: StudioRunsOn,
): Omit<CompiledStudio, 'agentId' | 'providers'> {
  const { decision } = draft;
  const facets = new Set<string>(draftFacets(draft));
  const contract = checkDecisionIdentity(draft, report);
  if (draft.modelBindings.length !== 1) {
    report('models', 'A decision needs exactly one model binding.');
  }
  const binding = draft.modelBindings[0];
  const nodeId = binding ? modelBindingNodeId(binding.key) : 'models';
  if (binding) {
    checkBindingRoute(binding, 'decision', draft.providers, report);
    if (!binding.modelId.trim()) {
      report(nodeId, 'Model id is required.', 'modelId');
    }
    checkWhole(report, nodeId, 'timeoutMs', 'Timeout', binding.timeoutMs, 1);
  }
  checkWhole(report, 'decision', 'maxStateBytes', 'Max state', decision.maxStateBytes, 1);
  const questions = compileQuestions(decision, report);
  if (on.mode === 'demo') checkLentDecision(draft, questions, on.keys, report);
  if (keySlotRequired(draft) && !draft.models.key) {
    report('models', 'Choose a key slot.', 'key');
  }
  const profile: DecisionProfileDefinition = {
    type: 'decision',
    id: draft.identity.agentId.trim(),
    identity: { handle: draft.identity.handle.trim() },
    models: binding
      ? {
          [binding.modelId.trim()]: {
            provider: binding.provider,
            apiId: binding.apiId.trim(),
            ...(binding.keySlot || draft.models.key
              ? { keySlot: binding.keySlot || draft.models.key }
              : {}),
            ...(binding.fallbackKeySlot ? { fallbackKeySlot: binding.fallbackKeySlot } : {}),
            ...(binding.timeoutMs !== null ? { timeoutMs: binding.timeoutMs } : {}),
          },
        }
      : {},
    inputs: {
      state: 'json',
      ...(decision.maxStateBytes !== null ? { maxStateBytes: decision.maxStateBytes } : {}),
    },
    decision: { contract },
    ...compileProfileOptions(draft, facets, report),
  };
  return { profile, customTools: [], questions };
}

/** A host: its custom tools, called directly, and the guardrails, trace and labels a host keeps. */
function compileHost(
  draft: StudioDraft,
  report: Report,
  agentIdOf: AgentIdOf,
  agentInputOf: AgentToolInputOf,
): Omit<CompiledStudio, 'agentId' | 'providers'> {
  const facets = new Set<string>(draftFacets(draft));
  const { customTools, tools } = compileTools(draft, false, report, agentIdOf, agentInputOf);
  if (!customTools.length) {
    report('tools', 'Add at least one tool: a host runs only its tools.');
  }
  const guardrails = facets.has('guardrails')
    ? compileGuardrails(draft.guardrails, report, TOOL_BOUNDARIES)
    : undefined;
  const profile = omitOutOfScope({
    type: 'host',
    id: draft.identity.agentId.trim(),
    tools,
    ...(guardrails ? { guardrails } : {}),
    ...compileProfileOptions(draft, facets, report),
  });
  return { profile, customTools };
}

function assemble(
  draft: StudioDraft,
  type: StudioTurnProfileType,
  report: Report,
  on: StudioRunsOn,
  agentIdOf: AgentIdOf,
  agentInputOf: AgentToolInputOf,
): Omit<CompiledStudio, 'agentId' | 'providers'> {
  const facets = new Set<string>(draftFacets(draft));
  const allows = (path: string) => draftAllows(draft, path);
  const parsedSystem: SystemMarkup =
    typeof draft.identity.system === 'string'
      ? parseSystemMarkup(draft.identity.system)
      : { ok: false, message: 'The system prompt must be text.' };
  if (!parsedSystem.ok) report('identity', parsedSystem.message, 'system');
  const system = parsedSystem.ok ? parsedSystem.prompt : undefined;
  const systemByRole = compileSystemByRole(draft.identity.systemByRoleJson, (message) => {
    report('identity', message, 'systemByRoleJson');
  });
  const modelFields = compileModels(draft, type, report, agentIdOf);
  const { outputs, structured } = facets.has('outputs')
    ? compileOutputs(draft.outputs, allows('outputs.structured'), report)
    : {};
  const { customTools, tools } = facets.has('tools')
    ? compileTools(draft, allows('tools.t2Loader'), report, agentIdOf, agentInputOf)
    : { customTools: [] };
  const turnBehaviour = facets.has('turnBehaviour')
    ? compileTurnBehaviour(draft.turnBehaviour, allows('turnBehaviour.resumption'), report)
    : undefined;
  const guardrails = facets.has('guardrails')
    ? compileGuardrails(draft.guardrails, report)
    : undefined;

  const profile = omitOutOfScope({
    type,
    id: draft.identity.agentId.trim(),
    identity: {
      handle: draft.identity.handle.trim(),
      ...(system ? { system } : {}),
      ...(systemByRole ? { systemByRole } : {}),
    },
    ...modelFields,
    ...(facets.has('image') ? { image: compileImage(draft.image, report) } : {}),
    ...(facets.has('speech') ? { speech: compileSpeech(draft.speech, draft, report) } : {}),
    ...(facets.has('live') ? { live: compileLive(draft.live, report, on) } : {}),
    ...(tools ? { tools } : {}),
    ...(!facets.has('inputs')
      ? {}
      : type === 'live'
        ? compileLiveInputs(draft.inputs, report)
        : { inputs: compileInputs(draft.inputs, type, report) }),
    ...(outputs ? { outputs } : {}),
    ...(turnBehaviour ? { turnBehaviour } : {}),
    ...(guardrails ? { guardrails } : {}),
    ...compileProfileOptions(draft, facets, report),
  });
  return { profile, customTools, ...(structured ? { structured } : {}) };
}

/**
 * Every issue is reported, not just the first. `agentIdOf` and `agentInputOf` resolve the
 * agents a workspace draft names.
 */
export function compileStudio(
  draft: StudioDraft,
  on: StudioRunsOn,
  agentIdOf: AgentIdOf = NO_AGENTS,
  agentInputOf: AgentToolInputOf = NO_AGENT_INPUTS,
): StudioCompileResult {
  const issues: StudioIssue[] = [];
  const report: Report = (nodeId, message, field, index) => {
    issues.push({
      nodeId,
      message,
      ...(field !== undefined ? { field } : {}),
      ...(index !== undefined ? { index } : {}),
    });
  };

  checkIdentity(draft, report);
  const keySlots = new Set(
    [
      draft.models.key,
      draft.models.fallbackKey,
      ...draft.modelBindings.flatMap((binding) => {
        const { keySlot, fallbackKeySlot } = bindingSlots(draft, binding);
        return [keySlot, fallbackKeySlot];
      }),
    ].filter(Boolean),
  );
  if (keySlots.size > STUDIO_KEY_SLOT_CAP) {
    report('models', 'The studio supports up to 32 key slots.', 'key');
  }
  if (draft.identity.profileType !== 'host') {
    for (const binding of draft.modelBindings) {
      if (!binding.apiId.trim()) continue;
      const violation = modelBindingViolation(
        { ...modelRoute(draft.providers, draft.identity.profileType, binding), builtInTools: binding.builtInTools },
        on,
      );
      if (violation) {
        report(modelBindingNodeId(binding.key), violation.message, violation.field);
      }
    }
  }
  const type = draft.identity.profileType;
  if (!type) {
    report('identity', 'Pick a profile type.', 'profileType');
    return { ok: false, issues };
  }
  const compiled =
    type === 'decision'
      ? compileDecision(draft, report, on)
      : type === 'host'
        ? compileHost(draft, report, agentIdOf, agentInputOf)
        : assemble(draft, type, report, on, agentIdOf, agentInputOf);
  if (issues.length) return { ok: false, issues };

  try {
    defineProfile(uncompiled(compiled.profile));
  } catch (err) {
    if (!(err instanceof TheoremError)) throw err;
    return {
      ok: false,
      issues: [{ nodeId: 'identity', message: err.message }],
    };
  }
  return { ok: true, agentId: compiled.profile.id, providers: draft.providers, ...compiled };
}
