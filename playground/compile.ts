/**
 * Compile a playground draft into what the playground server registers: a
 * profile definition, its custom tools, and its structured-output schema.
 *
 * Validation runs first and reports every problem it finds, each keyed to the
 * tree node it belongs to (`tree.ts`). Only a draft with no issues is handed to
 * `defineProfile`, whose own checks are the last word.
 *
 * The compiled profile holds the kernel's real `standardEgressEnforce` when
 * egress is on. A function does not survive JSON, so the playground server
 * puts it back after the run-tab handoff.
 *
 * @module
 */

import {
  defineProfile,
  type ImageProfileDefinition,
  liveIngressChannelDefault,
  type LiveProfileDefinition,
  type ProfileDefinitionBase,
  type ProfileGuardrailsSpec,
  type ProfileObservabilitySpec,
  type ProfileTurnBehaviourSpec,
  resolveGuardrailPolicy,
  type SpeechProfileDefinition,
  standardEgressEnforce,
  type TextProfileDefinition,
  describeError,
  type LexiconKey,
  type LexiconOverrides,
  TheoremError,
} from '../mod.ts';
import { validateLexiconOverrides } from '../src/guardrails/lexicon.ts';
import {
  HTTP_METHODS,
  isValidPair,
  isValidProfileProtocol,
  protocolsForProfileType,
  speechFormatsForProtocol,
} from '../src/kernel/schema.ts';
import type {
  ModelBinding,
  ProfileImageSpec,
  ProfileInputsSpec,
  ProfileLiveSpec,
  ProfileOutputsSpec,
  ProfileSpeechSpec,
} from '../src/kernel/types.ts';
import { outOfScopeFields, profileTypesForField } from '../src/kernel/profile-scope.ts';
import { CONTINUE_INSTRUCTION_TYPES } from '../src/kernel/stop.ts';
import { resolveObservabilityPolicy } from '../src/observability/mod.ts';
import type {
  GuardrailsDraft,
  ImageDraft,
  InputsDraft,
  LiveDraft,
  ModelBindingDraft,
  ObservabilityDraft,
  OutputsDraft,
  PlaygroundDraft,
  PlaygroundProfileType,
  SpeechDraft,
  ToolSpecDraft,
  TurnBehaviourDraft,
} from './draft.ts';
import { draftFacets } from './draft.ts';
import { isGoogleTransport, isProviderBuiltinId, modelBindingViolation } from './policy.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { parseJsonSchema } from './tool-schema.ts';
import { modelBindingNodeId, toolSpecNodeId } from './tree.ts';

/** A profile definition the playground authors. */
export type PlaygroundProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition;

/**
 * One problem with the draft, on the tree node it belongs to. `field` names the
 * draft field at fault (a key of that node's draft, e.g. `handle` on identity or
 * `defaultEffort` on a model binding) when one field is; `index` is the entry
 * when that field is a list. Issues about the node as a whole have neither.
 */
export interface PlaygroundIssue {
  nodeId: string;
  message: string;
  field?: string;
  index?: number;
}

/** What the playground server registers for a run. */
export interface CompiledPlayground {
  agentId: string;
  profile: PlaygroundProfileDefinition;
  customTools: ToolRegistration[];
  structured?: StructuredRegistration;
}

export type PlaygroundCompileResult =
  | ({ ok: true } & CompiledPlayground)
  | { ok: false; issues: PlaygroundIssue[] };

type Report = (nodeId: string, message: string, field?: string, index?: number) => void;

/** The list's entries, trimmed, without blanks. */
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

// ── identity ────────────────────────────────────────────────────────────────

function checkIdentity(draft: PlaygroundDraft, report: Report): void {
  if (!draft.identity.agentId.trim()) report('identity', 'Profile id is required.', 'agentId');
  if (!draft.identity.handle.trim()) report('identity', 'Handle is required.', 'handle');
}

// ── models ──────────────────────────────────────────────────────────────────

function compileBinding(
  binding: ModelBindingDraft,
  type: PlaygroundProfileType,
  report: Report,
): ModelBinding {
  const nodeId = modelBindingNodeId(binding.key);
  if (!isValidProfileProtocol(type, binding.protocol)) {
    const legal = protocolsForProfileType(type).join(' or ');
    report(nodeId, `${type} profiles can't use ${binding.protocol} — use ${legal}.`, 'protocol');
  } else if (!isValidPair(binding.protocol, binding.provider)) {
    report(nodeId, `${binding.protocol} doesn't run on ${binding.provider}.`, 'provider');
  }
  const apiId = binding.apiId.trim();
  if (!apiId) {
    report(nodeId, 'Wire model id is required.', 'apiId');
  } else {
    const violation = modelBindingViolation(binding);
    if (violation) report(nodeId, violation.message, violation.field);
  }

  const efforts: Record<string, ModelBindingDraft['efforts'][number]['level']> = {};
  binding.efforts.forEach(({ alias, level }, index) => {
    const name = alias.trim();
    if (!name) report(nodeId, 'Every effort needs an alias.', 'efforts', index);
    else if (name in efforts) {
      report(nodeId, `Effort alias '${name}' is used twice.`, 'efforts', index);
    } else efforts[name] = level;
  });
  const effortCount = Object.keys(efforts).length;
  if (binding.allowEffortSelect && effortCount < 2) {
    report(nodeId, 'Effort select needs at least two efforts.', 'allowEffortSelect');
  }
  const defaultEffort = binding.defaultEffort.trim();
  if (!defaultEffort && Object.keys(efforts).length > 1) {
    report(nodeId, 'Pick a default effort — there is more than one.', 'defaultEffort');
  } else if (defaultEffort && !(defaultEffort in efforts)) {
    report(nodeId, `Default effort '${defaultEffort}' is not one of the efforts.`, 'defaultEffort');
  }
  checkWhole(report, nodeId, 'maxOutputTokens', 'Max output tokens', binding.maxOutputTokens, 1);
  if (
    binding.temperature !== null &&
    !(Number.isFinite(binding.temperature) && binding.temperature >= 0)
  ) {
    report(nodeId, 'Temperature must be zero or more.', 'temperature');
  }

  return {
    protocol: binding.protocol,
    provider: binding.provider,
    apiId,
    ...(effortCount ? { efforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(binding.allowEffortSelect ? { allowEffortSelect: true } : {}),
    ...(binding.summaries ? { summaries: true } : {}),
    ...(binding.maxOutputTokens !== null ? { maxOutputTokens: binding.maxOutputTokens } : {}),
    ...(binding.temperature !== null ? { temperature: binding.temperature } : {}),
    ...(binding.builtInTools.length ? { builtInTools: [...binding.builtInTools] } : {}),
  };
}

function compileModels(
  draft: PlaygroundDraft,
  type: PlaygroundProfileType,
  report: Report,
): Pick<
  ProfileDefinitionBase,
  'models' | 'defaultModel' | 'allowModelSelect' | 'maxSteps' | 'key'
> {
  const { models: policy, modelBindings } = draft;
  const models: Record<string, ModelBinding> = {};
  for (const binding of modelBindings) {
    const compiled = compileBinding(binding, type, report);
    const modelId = binding.modelId.trim();
    const nodeId = modelBindingNodeId(binding.key);
    if (!modelId) report(nodeId, 'Model id is required.', 'modelId');
    else if (modelId in models) {
      report(nodeId, `Model id '${modelId}' is used twice.`, 'modelId');
    } else models[modelId] = compiled;
  }

  if (!modelBindings.length) report('models', 'Add at least one model.');
  const defaultModel = policy.defaultModel.trim();
  if (defaultModel && !(defaultModel in models)) {
    report('models', `Default model '${defaultModel}' is not one of the models.`, 'defaultModel');
  } else if (!defaultModel && modelBindings.length > 1) {
    report('models', 'Pick a default model — there is more than one.', 'defaultModel');
  }
  if (policy.allowModelSelect && modelBindings.length < 2) {
    report('models', 'Model select needs at least two models.', 'allowModelSelect');
  }
  if (policy.maxSteps !== null && !Number.isInteger(policy.maxSteps)) {
    report('models', 'Max steps must be a whole number.', 'maxSteps');
  }
  const usesGoogle = modelBindings.some((binding) =>
    isGoogleTransport(binding.protocol, binding.provider)
  );
  if (usesGoogle && !policy.key) report('models', 'Google models need a key slot.', 'key');

  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(policy.allowModelSelect ? { allowModelSelect: true } : {}),
    ...(policy.maxSteps !== null ? { maxSteps: policy.maxSteps } : {}),
    ...(policy.key ? { key: policy.key } : {}),
  };
}

// ── tools ───────────────────────────────────────────────────────────────────

function parseHeaders(raw: string | undefined): Record<string, string> | undefined | null {
  if (!raw?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') return null;
      headers[name] = value;
    }
    return Object.keys(headers).length ? headers : undefined;
  } catch {
    return null;
  }
}

function compileAuth(tool: ToolSpecDraft): Extract<ToolRegistration, { type: 'http' }>['auth'] {
  if (!tool.authType || tool.authType === 'none') return undefined;
  const scopes = cleanList(tool.authScopes);
  return {
    slot: tool.authSlot?.trim() || 'default',
    type: tool.authType,
    ...(tool.authHeaderName?.trim() ? { headerName: tool.authHeaderName.trim() } : {}),
    ...(tool.authHeaderPrefix !== undefined ? { headerPrefix: tool.authHeaderPrefix } : {}),
    onUnauthenticated: tool.authUnauthenticated ?? 'pause',
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

/** Reports a problem with one of the tool draft's fields. */
type Fail = (message: string, field: keyof ToolSpecDraft) => void;

function checkToolName(name: string, fail: Fail): void {
  if (!name) fail('Tool name is required.', 'toolName');
  else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    fail(
      `Tool name '${name}' must be letters, digits, and underscores, starting with a letter.`,
      'toolName',
    );
  } else if (isProviderBuiltinId(name)) {
    fail(
      `${name} is a provider builtin — turn it on under the model's built-in tools.`,
      'toolName',
    );
  }
}

/** The fields every tool type shares. */
function toolCommon(tool: ToolSpecDraft, fail: Fail) {
  const name = tool.toolName.trim();
  checkToolName(name, fail);
  const description = tool.description.trim();
  if (!description) fail('Description is required.', 'description');
  const input = parseJsonSchema(tool.inputJson, 'Input');
  if (!input.ok) fail(input.error, 'inputJson');
  const output = parseJsonSchema(tool.outputJson, 'Output');
  if (!output.ok) fail(output.error, 'outputJson');
  const paths = cleanList(tool.paths);
  return {
    name,
    description,
    category: tool.category.trim() || 'playground',
    access: tool.access,
    permission: tool.permission,
    loadTier: tool.loadTier,
    paths: paths.length ? paths : ['*'],
    inputSchema: input.ok ? input.schema : {},
    outputSchema: output.ok ? output.schema : {},
  };
}

type ToolCommon = ReturnType<typeof toolCommon>;

/** Headers and auth, which HTTP and MCP tools share. */
function remoteToolFields(tool: ToolSpecDraft, fail: Fail) {
  const headers = parseHeaders(tool.headersJson);
  if (headers === null) fail('Headers must be a JSON object of strings.', 'headersJson');
  const auth = compileAuth(tool);
  return { ...(headers ? { headers } : {}), ...(auth ? { auth } : {}) };
}

/** A URL field: required, and a full URL. */
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
  return { type: 'mcp', ...common, serverUrl, mcpToolName, ...remoteToolFields(tool, fail) };
}

function functionTool(tool: ToolSpecDraft, common: ToolCommon, fail: Fail): ToolRegistration {
  if (!tool.stubOutputJson?.trim()) return { type: 'function', ...common };
  const stub = parseJsonSchema(tool.stubOutputJson, 'Stub output');
  if (!stub.ok) fail(stub.error.replace(' JSON Schema', ''), 'stubOutputJson');
  return { type: 'function', ...common, ...(stub.ok ? { stubResponse: stub.schema } : {}) };
}

const TOOL_COMPILERS = { http: httpTool, mcp: mcpTool, function: functionTool };

function compileTool(tool: ToolSpecDraft, report: Report): ToolRegistration | undefined {
  const nodeId = toolSpecNodeId(tool.key);
  let failed = false;
  const fail: Fail = (message, field) => {
    failed = true;
    report(nodeId, message, field);
  };
  const compiled = TOOL_COMPILERS[tool.toolType](tool, toolCommon(tool, fail), fail);
  return failed ? undefined : compiled;
}

function compileTools(draft: PlaygroundDraft, withLoader: boolean, report: Report) {
  const customTools: ToolRegistration[] = [];
  const names = new Set<string>();
  for (const tool of draft.toolSpecs) {
    const compiled = compileTool(tool, report);
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

// ── sections ────────────────────────────────────────────────────────────────

function compileInputs(inputs: InputsDraft, report: Report): ProfileInputsSpec {
  checkWhole(report, 'inputs', 'maxFiles', 'Max files', inputs.maxFiles, 1);
  checkWhole(report, 'inputs', 'maxBytes', 'Max bytes', inputs.maxBytes, 1);
  checkWhole(report, 'inputs', 'maxTurnBytes', 'Max turn bytes', inputs.maxTurnBytes, 1);
  return {
    ...(inputs.text ? {} : { text: false }),
    ...(inputs.attachmentsAccept.length
      ? { attachments: { accept: [...inputs.attachmentsAccept] } }
      : {}),
    ...(inputs.voiceAccept.length ? { voice: { accept: [...inputs.voiceAccept] } } : {}),
    ...(inputs.maxFiles !== null ? { maxFiles: inputs.maxFiles } : {}),
    ...(inputs.maxBytes !== null ? { maxBytes: inputs.maxBytes } : {}),
    ...(inputs.maxTurnBytes !== null ? { maxTurnBytes: inputs.maxTurnBytes } : {}),
  };
}

function compileOutputs(
  outputs: OutputsDraft,
  report: Report,
): { outputs?: ProfileOutputsSpec; structured?: StructuredRegistration } {
  let structured: StructuredRegistration | undefined;
  if (outputs.mode === 'structured') {
    const id = outputs.schemaId.trim();
    if (!id) report('outputs', 'Structured output needs a schema id.', 'schemaId');
    const schema = parseJsonSchema(outputs.schemaJson, 'Structured output');
    if (!schema.ok) report('outputs', schema.error, 'schemaJson');
    if (id && schema.ok) structured = { id, spec: { jsonSchema: schema.schema } };
  }
  if (outputs.validationEnabled) {
    checkWhole(report, 'outputs', 'maxRetries', 'Validation max retries', outputs.maxRetries, 0);
  }
  const validation = outputs.validationEnabled && outputs.maxRetries !== null
    ? { maxRetries: outputs.maxRetries }
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
  if (!turn.resumeEnabled) return undefined;
  checkWhole(report, 'turnBehaviour', 'maxContinues', 'Max continues', turn.maxContinues, 1);
  return {
    ...(turn.allowContinue.length ? { allowContinue: [...turn.allowContinue] } : {}),
    ...(turn.autoContinue.length ? { autoContinue: [...turn.autoContinue] } : {}),
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
  };
  return Object.keys(spec).length ? spec : undefined;
}

function compileCanary(guardrails: GuardrailsDraft): ProfileGuardrailsSpec['canary'] {
  return guardrails.canary !== resolveGuardrailPolicy(undefined).canary
    ? guardrails.canary
    : undefined;
}

/**
 * The profile's wording: the drafts' continue instruction, canary bind note,
 * quota message, and repair guidance, each checked by the kernel's own lexicon rules and reported on the
 * node that owns it.
 */
function compileLexicon(
  draft: PlaygroundDraft,
  facets: ReadonlySet<string>,
  allows: (path: string) => boolean,
  report: Report,
): LexiconOverrides | undefined {
  const entries: Array<[nodeId: string, field: string, key: LexiconKey, template: string]> = [];
  const turn = draft.turnBehaviour;
  const type = draft.identity.profileType;
  const takesInstruction = type !== '' && CONTINUE_INSTRUCTION_TYPES.includes(type);
  if (facets.has('turnBehaviour') && takesInstruction && turn.resumeEnabled) {
    entries.push([
      'turnBehaviour',
      'continueInstruction',
      'continue.instruction',
      turn.continueInstruction.trim(),
    ]);
  }
  const { guardrails } = draft;
  if (facets.has('guardrails') && allows('guardrails.canary') && guardrails.canary) {
    entries.push([
      'guardrails',
      'canaryBindNote',
      'canary.bind_note',
      guardrails.canaryBindNote.trim(),
    ]);
  }
  if (facets.has('guardrails') && allows('guardrails.quota') && guardrails.quotaEnabled) {
    entries.push(['guardrails', 'quotaMessage', 'quota.exhausted', guardrails.quotaMessage.trim()]);
  }
  const { outputs } = draft;
  if (facets.has('outputs') && outputs.validationEnabled) {
    entries.push([
      'outputs',
      'repairGuidance',
      'repair.default_guidance',
      outputs.repairGuidance.trim(),
    ]);
  }
  if (facets.has('guardrails') && allows('guardrails.egress') && guardrails.egressEnabled) {
    entries.push([
      'guardrails',
      'egressRepairGuidance',
      'egress.default_repair_guidance',
      guardrails.egressRepairGuidance.trim(),
    ]);
  }
  const lexicon: LexiconOverrides = {};
  for (const [nodeId, field, key, template] of entries) {
    if (!template) continue;
    try {
      validateLexiconOverrides({ [key]: template }, 'Profile lexicon');
      lexicon[key] = template;
    } catch (err) {
      report(nodeId, describeError(err), field);
    }
  }
  return Object.keys(lexicon).length ? lexicon : undefined;
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

function compileEgress(
  guardrails: GuardrailsDraft,
  report: Report,
): ProfileGuardrailsSpec['egress'] {
  if (!guardrails.egressEnabled) return undefined;
  checkWhole(
    report,
    'guardrails',
    'egressMaxRetries',
    'Egress max retries',
    guardrails.egressMaxRetries,
    0,
  );
  checkWhole(
    report,
    'guardrails',
    'egressHoldback',
    'Egress holdback',
    guardrails.egressHoldback,
    0,
  );
  return {
    enforce: standardEgressEnforce,
    ...(guardrails.egressOnBlock ? { onBlock: guardrails.egressOnBlock } : {}),
    ...(guardrails.egressMaxRetries !== null ? { maxRetries: guardrails.egressMaxRetries } : {}),
    ...(guardrails.egressHoldback !== null ? { holdback: guardrails.egressHoldback } : {}),
  };
}

function compileNetwork(
  guardrails: GuardrailsDraft,
  report: Report,
): ProfileGuardrailsSpec['network'] {
  const hosts = guardrails.allowedHosts.map((host) => host.trim());
  const blank = hosts.indexOf('');
  if (blank !== -1) report('guardrails', 'Allowed hosts cannot be blank.', 'allowedHosts', blank);
  if (!guardrails.allowPrivateNetworks && !hosts.length) return undefined;
  return {
    ...(guardrails.allowPrivateNetworks ? { allowPrivateNetworks: true } : {}),
    ...(hosts.length ? { allowedHosts: hosts } : {}),
  };
}

function compileGuardrails(
  guardrails: GuardrailsDraft,
  report: Report,
): ProfileGuardrailsSpec | undefined {
  const defaults = resolveGuardrailPolicy(undefined);
  const parts: ProfileGuardrailsSpec = {
    canary: compileCanary(guardrails),
    sanitizeInput: guardrails.sanitizeInput !== defaults.sanitizeInput
      ? guardrails.sanitizeInput
      : undefined,
    redactSensitive: guardrails.redactSensitive !== defaults.redactSensitive
      ? guardrails.redactSensitive
      : undefined,
    quota: compileQuota(guardrails, report),
    egress: compileEgress(guardrails, report),
    network: compileNetwork(guardrails, report),
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
  const defaults = resolveObservabilityPolicy(undefined);
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
  };
  return Object.keys(spec).length ? spec : undefined;
}

function compileImage(image: ImageDraft, report: Report): ProfileImageSpec {
  checkWhole(report, 'image', 'maxInputImages', 'Max input images', image.maxInputImages, 1);
  return {
    ...(image.aspectRatio.trim() ? { aspectRatio: image.aspectRatio.trim() } : {}),
    ...(image.size.trim() ? { size: image.size.trim() } : {}),
    ...(image.mimeType.trim() ? { mimeType: image.mimeType.trim() } : {}),
    ...(image.maxInputImages !== null ? { maxInputImages: image.maxInputImages } : {}),
    ...(image.includeText ? { includeText: true } : {}),
  };
}

function compileSpeech(
  speech: SpeechDraft,
  draft: PlaygroundDraft,
  report: Report,
): ProfileSpeechSpec {
  const { format } = speech;
  if (format) {
    const refused = draft.modelBindings.find(
      (binding) => !speechFormatsForProtocol(binding.protocol).includes(format),
    );
    if (refused) {
      report(
        'speech',
        `${format} output needs every model on openAi; ${refused.modelId} is ${refused.protocol}.`,
        'format',
      );
    }
  }
  return {
    ...(speech.voice.trim() ? { voice: speech.voice.trim() } : {}),
    ...(format ? { format } : {}),
  };
}

function compileLive(live: LiveDraft, report: Report): ProfileLiveSpec {
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

  const channels = { audio: live.ingressAudio, video: live.ingressVideo, text: live.ingressText };
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
    ...(live.contextCompression ? { contextCompression: live.contextCompression } : {}),
    ...(live.proactiveAudio ? { proactiveAudio: true } : {}),
    ...(Object.keys(transcription).length ? { transcription } : {}),
  };
}

// ── assemble ────────────────────────────────────────────────────────────────

/** `root` without the value at `segments`; its parents stay, even if left empty. */
function withoutPath(
  root: Record<string, unknown>,
  segments: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = segments;
  const { [head]: child, ...others } = root;
  if (!rest.length || child === null || typeof child !== 'object') return others;
  return { ...others, [head]: withoutPath(child as Record<string, unknown>, rest) };
}

/**
 * Drop what the profile type may not set (`PROFILE_FIELD_SCOPE`). A draft keeps
 * every section's values across type changes; the schema decides which compile.
 */
function omitOutOfScope(profile: Record<string, unknown> & { type: PlaygroundProfileType }) {
  let out: Record<string, unknown> = profile;
  for (const { path } of outOfScopeFields(profile)) out = withoutPath(out, path.split('.'));
  return out as PlaygroundProfileDefinition;
}

function assemble(
  draft: PlaygroundDraft,
  type: PlaygroundProfileType,
  report: Report,
): Omit<CompiledPlayground, 'agentId'> {
  const facets = new Set<string>(draftFacets(draft));
  const allows = (path: string) => profileTypesForField(path).includes(type);
  const system = draft.identity.system.trim();
  const modelFields = compileModels(draft, type, report);
  const { outputs, structured } = facets.has('outputs')
    ? compileOutputs(draft.outputs, report)
    : {};
  const { customTools, tools } = facets.has('tools')
    ? compileTools(draft, allows('tools.t2Loader'), report)
    : { customTools: [] };
  const turnBehaviour = facets.has('turnBehaviour')
    ? compileTurnBehaviour(draft.turnBehaviour, allows('turnBehaviour.resumption'), report)
    : undefined;
  const guardrails = facets.has('guardrails')
    ? compileGuardrails(draft.guardrails, report)
    : undefined;
  const lexicon = compileLexicon(draft, facets, allows, report);
  const observability = facets.has('observability')
    ? compileObservability(draft.observability, report)
    : undefined;

  const profile = omitOutOfScope({
    type,
    id: draft.identity.agentId.trim(),
    identity: { handle: draft.identity.handle.trim(), ...(system ? { system } : {}) },
    ...modelFields,
    ...(facets.has('image') ? { image: compileImage(draft.image, report) } : {}),
    ...(facets.has('speech') ? { speech: compileSpeech(draft.speech, draft, report) } : {}),
    ...(facets.has('live') ? { live: compileLive(draft.live, report) } : {}),
    ...(tools ? { tools } : {}),
    ...(facets.has('inputs') ? { inputs: compileInputs(draft.inputs, report) } : {}),
    ...(outputs ? { outputs } : {}),
    ...(turnBehaviour ? { turnBehaviour } : {}),
    ...(guardrails ? { guardrails } : {}),
    ...(observability ? { observability } : {}),
    ...(lexicon ? { lexicon } : {}),
  });
  return { profile, customTools, ...(structured ? { structured } : {}) };
}

/** Validate the draft and compile it; every issue is reported, not just the first. */
export function compilePlayground(draft: PlaygroundDraft): PlaygroundCompileResult {
  const issues: PlaygroundIssue[] = [];
  const report: Report = (nodeId, message, field, index) => {
    issues.push({
      nodeId,
      message,
      ...(field !== undefined ? { field } : {}),
      ...(index !== undefined ? { index } : {}),
    });
  };

  checkIdentity(draft, report);
  const type = draft.identity.profileType;
  if (!type) {
    report('identity', 'Pick a profile type.', 'profileType');
    return { ok: false, issues };
  }
  const compiled = assemble(draft, type, report);
  if (issues.length) return { ok: false, issues };

  try {
    defineProfile(compiled.profile);
  } catch (err) {
    if (!(err instanceof TheoremError)) throw err;
    return { ok: false, issues: [{ nodeId: 'identity', message: err.message }] };
  }
  return { ok: true, agentId: compiled.profile.id, ...compiled };
}
