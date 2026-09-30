import { errorKind } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { fetchGuarded, type ResolveHost } from '../../guardrails/network.ts';
import type { ErrorKind } from '../../guardrails/theorem-error.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import type { ToolCredentialSource } from '../auth/credential-source.ts';
import { refreshOAuthToken, tokenAudienceCovers } from '../auth/oauth.ts';
import type { AuthScopeRefused } from '../auth/scope-refusal.ts';
import type { OAuth2Credential, OAuthTransportOptions, ToolCredential } from '../auth/types.ts';
import { mapStrings } from '../engine/tree.ts';
import type { AuthUnauthenticatedPolicy } from '../schema.ts';
import type { InteractionPart, ToolWarning } from '../turn-events.ts';
import type { TurnEvent } from '../types.ts';
import {
  guardToolTarget,
  messageOf,
  networkBlocked,
  networkBlockedEvent,
  type RequestChecks,
  requestChecks,
  startToolExecution,
  type ToolCallBase,
  toolEvent,
  toolNetworkPolicy,
} from './events.ts';
import { checkPermission } from './permission.ts';
import { assertFixedEndpointOrigin } from './schema.ts';
import { runPreToolPipeline, type ToolStageSupport } from './stage-run.ts';
import type {
  HttpToolDef,
  McpToolDef,
  ModelToolResult,
  ToolAuthConfig,
  ToolBodyOutcome,
  ToolContext,
  ToolFailure,
  ToolGate,
} from './types.ts';

export type AuthResolveResult = {
  headers: Record<string, string>;
  /** The response is stripped of this before anyone reads it. */
  secret?: string;
  /** RFC 8707 resource an OAuth token was issued for; it goes nowhere else. */
  audience?: string;
  unauthenticated?: boolean;
  modelMessage?: string;
  gate?: ToolGate;
};

function authHeaderPair(
  authConfig: ToolAuthConfig,
  value: string,
  defaults: { headerName: string; headerPrefix: string },
): Record<string, string> {
  const headerName = authConfig.headerName ?? defaults.headerName;
  const headerPrefix = authConfig.headerPrefix ?? defaults.headerPrefix;
  return { [headerName]: `${headerPrefix}${value}` };
}

function buildAuthGate(
  toolName: string,
  authConfig: ToolAuthConfig,
  message: string,
  extras?: { issuer?: string; resource?: string },
): ToolGate {
  return {
    kind: 'auth',
    tool: toolName,
    authChallenge: {
      slot: authConfig.slot,
      authType: authConfig.type,
      service: authConfig.service,
      message,
      issuer: extras?.issuer ?? authConfig.preResolved?.issuer,
      resource: extras?.resource ?? authConfig.preResolved?.resource,
      requiredScopes: authConfig.scopes,
    },
  };
}

function unauthenticatedResult(
  toolName: string,
  authConfig: ToolAuthConfig,
  message: string,
  policy: AuthUnauthenticatedPolicy,
  extras?: { issuer?: string; resource?: string },
): AuthResolveResult & { gate?: ToolGate } {
  if (policy === 'gate') {
    // The caller emits the gate through emitGateSettlement, so `pre_tool` runs first.
    const gate = buildAuthGate(toolName, authConfig, message, extras);
    return { headers: {}, unauthenticated: true, gate };
  }
  return { headers: {}, unauthenticated: true, modelMessage: message };
}

function resolveStaticCredential(
  credential: ToolCredential,
  authConfig: ToolAuthConfig,
): AuthResolveResult | undefined {
  if (credential.type === 'bearer') {
    return {
      headers: authHeaderPair(authConfig, credential.token, {
        headerName: 'Authorization',
        headerPrefix: 'Bearer ',
      }),
      secret: credential.token,
    };
  }
  if (credential.type === 'api_key') {
    const headerName = credential.headerName ?? authConfig.headerName ?? 'Authorization';
    const headerPrefix = credential.headerPrefix ?? authConfig.headerPrefix ?? '';
    return {
      headers: { [headerName]: `${headerPrefix}${credential.key}` },
      secret: credential.key,
    };
  }
  return undefined;
}

/**
 * Refreshes in flight, by grant. Calls that find the same expired token share
 * one refresh: with rotating refresh tokens a second request would present a
 * spent token, which a server may treat as theft and revoke the whole grant.
 */
const refreshesInFlight = new Map<string, Promise<OAuth2Credential>>();

function refreshOnce(
  credential: OAuth2Credential,
  refreshToken: string,
  transport: OAuthTransportOptions,
  clientSecret: string | undefined,
): Promise<OAuth2Credential> {
  const grant = `${credential.tokenEndpoint}\n${refreshToken}`;
  const inFlight = refreshesInFlight.get(grant);
  if (inFlight) return inFlight;
  const refresh = refreshOAuthToken({
    refreshToken,
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.clientId,
    resource: credential.resource,
    scope: credential.scope,
    issuer: credential.issuer,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...transport,
  }).then((result) => result.credential);
  refreshesInFlight.set(grant, refresh);
  const settle = () => refreshesInFlight.delete(grant);
  refresh.then(settle, settle);
  return refresh;
}

async function* resolveOAuth2Credential(
  toolName: string,
  authConfig: ToolAuthConfig,
  credential: OAuth2Credential,
  source: ToolCredentialSource,
  ctx: ToolContext,
  base: ToolCallBase,
  policy: AuthUnauthenticatedPolicy,
): AsyncGenerator<TurnEvent, AuthResolveResult> {
  const slot = authConfig.slot;
  const bound = { issuer: credential.issuer, resource: credential.resource };
  // A token goes only to the resource it was issued for; one that names none
  // has nowhere it may go, so the user signs in again.
  if (typeof credential.resource !== 'string' || credential.resource.length === 0) {
    const message = `OAuth credential for '${toolName}' (slot: '${slot}') does not name the resource it was issued for.`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy, bound);
  }
  let active = credential;
  const isExpired =
    credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + 30000;

  if (isExpired && credential.refreshToken) {
    try {
      active = await refreshOnce(
        credential,
        credential.refreshToken,
        { network: toolNetworkPolicy(ctx), resolveHost: ctx.resolveHost },
        await source.clientSecret?.(credential.clientId),
      );
    } catch (err) {
      // The server's own words are untrusted text: they go to the host as
      // `errorInternal`, never to the model or the client.
      yield {
        ...toolEvent(base, {
          phase: 'progress',
          data: { kind: 'auth_token_refresh_failed', slot },
        }),
        errorInternal: messageOf(err),
      };
      const message = `Failed to refresh OAuth token for '${toolName}' (slot: '${slot}').`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return unauthenticatedResult(toolName, authConfig, message, policy, bound);
    }
    // The host persists the refreshed credential before the call goes on; the
    // event only names the slot, so no token rides the stream.
    await source.set(slot, active);
    yield toolEvent(base, {
      phase: 'progress',
      data: { kind: 'auth_token_refreshed', slot },
    });
  } else if (isExpired) {
    const message = `OAuth token expired for '${toolName}' (slot: '${slot}') and no refresh token is available.`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy, bound);
  }

  return {
    headers: authHeaderPair(authConfig, active.accessToken, {
      headerName: 'Authorization',
      headerPrefix: 'Bearer ',
    }),
    secret: active.accessToken,
    audience: credential.resource,
  };
}

export async function* resolveToolAuth(
  toolName: string,
  authConfig: ToolAuthConfig | undefined,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, AuthResolveResult> {
  if (!authConfig) {
    return { headers: {} };
  }

  const source = ctx.credentials;
  const credential = source ? await source.get(authConfig.slot) : undefined;
  const policy = authConfig.onUnauthenticated ?? 'gate';

  if (!source || !credential) {
    const message = `Authentication required for '${toolName}' (auth slot: '${authConfig.slot}').`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy);
  }

  const staticResolved = resolveStaticCredential(credential, authConfig);
  if (staticResolved) {
    return staticResolved;
  }

  if (credential.type === 'oauth2') {
    return yield* resolveOAuth2Credential(
      toolName,
      authConfig,
      credential,
      source,
      ctx,
      base,
      policy,
    );
  }

  return { headers: {} };
}

export type HttpToolMapping = NonNullable<HttpToolDef['mapping']>;

/**
 * One path parameter, encoded. `encodeURIComponent` leaves `.` and `..` as they
 * are and a URL resolves them, walking the endpoint's path; they are refused.
 */
function pathSegment(param: string, value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`Path parameter "${param}" cannot be "${value}"`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return encodeURIComponent(value);
}

export type HttpToolTarget = {
  url: string;
  body?: string;
};

export function buildHttpToolTarget(
  endpoint: string,
  method: HttpToolDef['method'],
  input: Record<string, unknown>,
  mapping?: HttpToolMapping,
): HttpToolTarget {
  assertFixedEndpointOrigin(endpoint);
  let urlStr = endpoint;
  const pathParams = mapping?.pathParams ?? [];
  for (const param of pathParams) {
    const val = input[param];
    if (val !== undefined) {
      urlStr = urlStr.replaceAll(`{${param}}`, pathSegment(param, String(val)));
    }
  }

  const unreplacedMatch = urlStr.match(/\{([a-zA-Z0-9_-]+)\}/);
  if (unreplacedMatch) {
    throw new Error(
      `Missing required path parameter "${unreplacedMatch[1]}" for endpoint "${endpoint}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  const targetUrl = new URL(urlStr);
  const queryParams = mapping?.queryParams ?? [];
  for (const param of queryParams) {
    const val = input[param];
    if (val !== undefined) {
      targetUrl.searchParams.set(param, String(val));
    }
  }

  if (method === 'GET') {
    return { url: targetUrl.toString() };
  }

  if (mapping?.bodyParam) {
    return { url: targetUrl.toString(), body: JSON.stringify(input[mapping.bodyParam]) };
  }

  const bodyObj: Record<string, unknown> = {};
  const excluded = new Set([...pathParams, ...queryParams]);
  for (const [k, v] of Object.entries(input)) {
    if (!excluded.has(k)) {
      bodyObj[k] = v;
    }
  }
  return { url: targetUrl.toString(), body: JSON.stringify(bodyObj) };
}

function parseHttpResponseData(contentType: string, text: string, status: number): unknown {
  if (contentType.includes('application/json') && text.trim().length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text.trim().length === 0 && status === 204) {
    return null;
  }
  return text;
}

export function parseToolOutput<T>(
  schema: {
    safeParse: (
      data: unknown,
    ) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } };
  },
  responseData: unknown,
): { success: true; data: T } | { success: false; error: { flatten: () => unknown } } {
  let checked = schema.safeParse(responseData);
  if (!checked.success && typeof responseData === 'string' && responseData.trim().length > 0) {
    try {
      const jsonParsed = JSON.parse(responseData);
      const retryChecked = schema.safeParse(jsonParsed);
      if (retryChecked.success) {
        checked = retryChecked;
      }
    } catch {
      // Not JSON: the schema's first result stands.
    }
  }
  return checked;
}

/** Not repeated as `data`, which `composeToolText` would append a second time. */
export function modelResultFromOutput(data: unknown): ModelToolResult {
  return { finding: typeof data === 'string' ? data : JSON.stringify(data) };
}

/** The result with the media a tool returned beside its value, when it returned any. */
export function withMedia(
  result: ModelToolResult,
  parts: InteractionPart[] | undefined,
): ModelToolResult {
  return parts?.length ? { ...result, parts } : result;
}

function failureOutcome(
  failure: ToolFailure,
  callNotStarted: boolean,
): Extract<ToolBodyOutcome, { kind: 'failed' }> {
  return { kind: 'failed', failure, callNotStarted };
}

async function* runRemotePreBodyStages(args: {
  tool: HttpToolDef | McpToolDef;
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  stages?: ToolStageSupport;
}): AsyncGenerator<TurnEvent, { ok: true; input: unknown } | ToolBodyOutcome> {
  const pre = yield* runPreToolPipeline(args);
  if (pre.ok) return pre;
  if (pre.kind === 'aborted') {
    return { kind: 'aborted', aborted: pre.aborted };
  }
  if (pre.kind === 'gated') {
    return { kind: 'gated', gate: pre.gate };
  }
  return { ...failureOutcome(pre.failure, true), ...(pre.denied ? { denied: true } : {}) };
}

async function* remoteParseAndPermit(
  tool: HttpToolDef | McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<
  TurnEvent,
  { ok: true; input: unknown } | { ok: false; outcome: ToolBodyOutcome }
> {
  const started = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!started.ok) {
    return {
      ok: false,
      outcome: failureOutcome(
        {
          code: 'invalid_input',
          kind: 'bad_response',
          message: lexiconText('tool.input_invalid', {}, ctx.profile.lexicon),
        },
        true,
      ),
    };
  }
  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
  );
  if (permissionGate) {
    return { ok: false, outcome: { kind: 'gated', gate: permissionGate } };
  }
  return { ok: true, input: started.data };
}

export function outcomeFromUnauth(authRes: {
  unauthenticated?: boolean;
  gate?: import('./types.ts').ToolGate;
  modelMessage?: string;
}): ToolBodyOutcome | undefined {
  if (!authRes.unauthenticated) return undefined;
  if (authRes.gate) return { kind: 'gated', gate: authRes.gate };
  if (authRes.modelMessage) {
    return {
      kind: 'ok',
      modelResult: { finding: authRes.modelMessage },
      outputRaw: { unauthenticated: true, message: authRes.modelMessage },
    };
  }
  return failureOutcome(
    { code: 'not_authorized', kind: 'auth', message: 'Tool authentication required' }, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    true,
  );
}

/** A 401 or 403 answer to a request that carried a credential. */
export type CredentialRefusal = { status: number; challenge: string | null };

export function credentialRefusal(response: Response): CredentialRefusal | undefined {
  return response.status === 401 || response.status === 403
    ? { status: response.status, challenge: response.headers.get('www-authenticate') }
    : undefined;
}

/** RFC 6750 §3: the characters a scope token may hold. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** A `Bearer` challenge's `error` and well-formed `scope` tokens (RFC 6750 §3). */
function bearerChallenge(header: string | null): { error?: string; scopes: string[] } {
  const param = (name: string) =>
    header?.match(new RegExp(`(?:^|[\\s,])${name}="([^"]*)"`, 'i'))?.[1];
  const scopes = (param('scope') ?? '').split(' ').filter((scope) => SCOPE_TOKEN.test(scope));
  const error = param('error');
  return error === undefined ? { scopes } : { error, scopes };
}

/** A refusal that asks for a sign-in: 401, or 403 `insufficient_scope`. Any other 403 is the call's own failure. */
export function refusalAsksForSignIn(refusal: CredentialRefusal): boolean {
  return (
    refusal.status === 401 || bearerChallenge(refusal.challenge).error === 'insufficient_scope'
  );
}

/**
 * The service refused the credential it was sent. A 401 says it no longer works:
 * the person signs in again. A 403 `insufficient_scope` asks for more access: a
 * sign-in can grant scopes the tool declares, and nothing else, so a request
 * outside them fails with `sign_in.out_of_scope` and the trace records what was
 * asked against what is declared. Any other refusal is the call's failure.
 */
export function* refusedCredentialOutcome(
  tool: { name: string; auth?: ToolAuthConfig },
  refusal: CredentialRefusal | undefined,
  authHeaders: Record<string, string>,
  ctx: ToolContext,
  base: ToolCallBase,
): Generator<TurnEvent, ToolBodyOutcome | undefined> {
  const auth = tool.auth;
  if (!auth || !refusal || Object.keys(authHeaders).length === 0) return undefined;
  const policy = auth.onUnauthenticated ?? 'gate';
  if (refusal.status === 401) {
    const message = `The credential for '${tool.name}' (slot: '${auth.slot}') was refused.`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return outcomeFromUnauth(unauthenticatedResult(tool.name, auth, message, policy));
  }
  const challenge = bearerChallenge(refusal.challenge);
  if (challenge.error !== 'insufficient_scope') return undefined;
  const declared = auth.scopes ?? [];
  const requested = challenge.scopes;
  if (requested.length > 0 && requested.every((scope) => declared.includes(scope))) {
    const message = `'${tool.name}' needs scopes its credential (slot: '${auth.slot}') does not carry.`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return outcomeFromUnauth(unauthenticatedResult(tool.name, auth, message, policy));
  }
  const refused: AuthScopeRefused = {
    kind: 'auth_scope_refused',
    slot: auth.slot,
    requested,
    declared,
  };
  yield toolEvent(base, { phase: 'progress', data: refused });
  return failureOutcome(
    {
      code: 'out_of_scope',
      kind: 'auth',
      message: lexiconText('sign_in.out_of_scope', { service: auth.service }, ctx.profile.lexicon),
    },
    false,
  );
}

async function* remoteAuthAndPreBody(args: {
  tool: HttpToolDef | McpToolDef;
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  stages?: ToolStageSupport;
}): AsyncGenerator<
  TurnEvent,
  | {
      ok: true;
      input: unknown;
      authHeaders: Record<string, string>;
      secret?: string;
      audience?: string;
    }
  | ToolBodyOutcome
> {
  const authRes = yield* resolveToolAuth(args.tool.name, args.tool.auth, args.ctx, args.base);
  const unauth = outcomeFromUnauth(authRes);
  if (unauth) return unauth;

  const preBody = yield* runRemotePreBodyStages({
    tool: args.tool,
    input: args.input,
    ctx: args.ctx,
    base: args.base,
    stages: args.stages,
  });
  if (!('ok' in preBody)) return preBody;
  return {
    ok: true,
    input: preBody.input,
    authHeaders: authRes.headers ?? {},
    ...(authRes.secret ? { secret: authRes.secret } : {}),
    ...(authRes.audience ? { audience: authRes.audience } : {}),
  };
}

function* thrownOutcome(
  err: unknown,
  checks: RequestChecks,
): Generator<TurnEvent, ToolBodyOutcome> {
  if (errorKind(err) === 'blocked') {
    const blocked = networkBlockedEvent();
    checks.record(blocked);
    return failureOutcome(yield* networkBlocked(err, blocked), false);
  }
  return failureOutcome({ code: 'network_error', kind: 'network', message: messageOf(err) }, false);
}

const OMIT_CREDENTIAL = '[omitted - credential]';

/** The most of a tool's response body the kernel reads; past it the call fails instead of exhausting the host's memory. */
export const MAX_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The most of an error or unparseable body quoted back in a failure message. */
const MAX_QUOTED_BODY_CHARS = 2000;

/** A body, read up to `maxBytes`; `undefined` when it runs past, with the rest left unread. */
async function readCappedText(
  response: Response,
  maxBytes = MAX_TOOL_RESPONSE_BYTES,
): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A body quoted in a failure message, cut short when long. */
function quotedBody(text: string): string {
  return text.length > MAX_QUOTED_BODY_CHARS ? `${text.slice(0, MAX_QUOTED_BODY_CHARS)}…` : text;
}

/** The failure for a body past MAX_TOOL_RESPONSE_BYTES. */
function tooLargeFailure(host: string): ToolFailure {
  return {
    code: 'response_too_large',
    kind: 'bad_response',
    message: `Response from ${host} is larger than ${MAX_TOOL_RESPONSE_BYTES} bytes`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}

/** The text with the credential replaced. */
function omitSecretText(text: string, secret: string): string {
  return text.replaceAll(secret, OMIT_CREDENTIAL);
}

/** Every string in `value` with the credential replaced. */
export function omitSecret(value: unknown, secret: string): unknown {
  return mapStrings(value, (text) => omitSecretText(text, secret));
}

/** A failure's message and details with the credential replaced. */
export function failureWithoutSecret(failure: ToolFailure, secret: string): ToolFailure {
  return {
    ...failure,
    message: omitSecretText(failure.message, secret),
    ...(failure.details === undefined ? {} : { details: omitSecret(failure.details, secret) }),
  };
}

/** An echo endpoint or debug page can repeat the credential; it must never reach the model, trace or client. */
function withoutSecret(outcome: ToolBodyOutcome, secret: string | undefined): ToolBodyOutcome {
  if (!secret) return outcome;
  if (outcome.kind === 'ok') {
    const outputRaw = omitSecret(outcome.outputRaw, secret);
    return {
      kind: 'ok',
      outputRaw,
      modelResult: withMedia(modelResultFromOutput(outputRaw), outcome.modelResult.parts),
    };
  }
  if (outcome.kind === 'failed') {
    return { ...outcome, failure: failureWithoutSecret(outcome.failure, secret) };
  }
  return outcome;
}

/** Why an OAuth token issued for `audience` may not go to `url` (RFC 8707), or `undefined` when it may. */
export function audienceMismatch(audience: string | undefined, url: URL): string | undefined {
  if (!audience || tokenAudienceCovers(audience, url)) return undefined;
  return `The OAuth token for "${audience}" cannot be sent to "${url.origin}${url.pathname}"`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

/** An OAuth token goes only to the resource it was issued for (RFC 8707); any other target gets no request. */
async function* sendWithCredential(
  prepared: { audience?: string; secret?: string },
  url: URL,
  send: () => AsyncGenerator<TurnEvent, ToolBodyOutcome>,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const mismatch = audienceMismatch(prepared.audience, url);
  if (mismatch) {
    return failureOutcome(
      { code: 'credential_audience_mismatch', kind: 'config', message: mismatch },
      true,
    );
  }
  return withoutSecret(yield* send(), prepared.secret);
}

/** Order: schema → permission → auth → preTool/host stages → body. */
export async function* executeHttpTool(
  tool: HttpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const parsed = yield* remoteParseAndPermit(tool, rawInput, ctx, base);
  if (!parsed.ok) return parsed.outcome;
  let input: unknown = parsed.input as Record<string, unknown>;

  const prepared = yield* remoteAuthAndPreBody({ tool, input, ctx, base, stages });
  if (!('ok' in prepared)) return prepared;
  input = prepared.input as Record<string, unknown>;

  let target: HttpToolTarget;
  try {
    target = buildHttpToolTarget(
      tool.endpoint,
      tool.method,
      input as Record<string, unknown>,
      tool.mapping,
    );
  } catch (err) {
    const failure: ToolFailure = {
      code: 'invalid_input',
      kind: 'bad_response',
      message: messageOf(err),
    };
    return failureOutcome(failure, true);
  }

  const guarded = yield* guardToolTarget(target.url, ctx, stages?.span);
  if (!guarded.ok) return failureOutcome(guarded.failure, true);
  return yield* sendWithCredential(prepared, guarded.url, () =>
    sendHttpRequest(tool, guarded.url, target.body, prepared.authHeaders, ctx, base, stages?.span),
  );
}

async function* sendHttpRequest(
  tool: HttpToolDef,
  targetUrl: URL,
  body: string | undefined,
  authHeaders: Record<string, string>,
  ctx: ToolContext,
  base: ToolCallBase,
  span: SpanHandle | undefined,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const checks = requestChecks(span);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (tool.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetchGuarded(
      targetUrl.href,
      { method: tool.method, headers, body, signal: ctx.signal },
      {
        policy: toolNetworkPolicy(ctx),
        followRedirects: true,
        originBoundHeaders: { ...tool.headers, ...authHeaders },
        resolveHost: ctx.resolveHost,
        onCheck: checks.onCheck,
      },
    );

    const text = await readCappedText(response);
    if (text === undefined) return failureOutcome(tooLargeFailure(targetUrl.hostname), false);

    if (!response.ok) {
      const refused = yield* refusedCredentialOutcome(
        tool,
        credentialRefusal(response),
        authHeaders,
        ctx,
        base,
      );
      if (refused) return refused;
      const failure: ToolFailure = {
        code: `http_${response.status}`,
        kind: kindOfToolHttpStatus(response.status),
        message: `HTTP ${response.status} from ${targetUrl.hostname}: ${quotedBody(text)}`,
      };
      return failureOutcome(failure, false);
    }

    const responseData = parseHttpResponseData(
      response.headers.get('content-type') ?? '',
      text,
      response.status,
    );
    const checked = parseToolOutput(tool.output, responseData);
    if (!checked.success) {
      const failure: ToolFailure = {
        code: 'invalid_output',
        kind: 'bad_response',
        message: 'HTTP response did not match tool output schema', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: checked.error.flatten(),
      };
      return failureOutcome(failure, false);
    }

    return {
      kind: 'ok',
      modelResult: modelResultFromOutput(checked.data),
      outputRaw: checked.data,
    };
  } catch (err) {
    return yield* thrownOutcome(err, checks);
  } finally {
    checks.record();
  }
}

/** Preferred first. */
export const MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export type McpRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: {
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: unknown;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
  method?: string;
};

/** Accepts a JSON body or an SSE (`data:`) stream. */
export function parseMcpRpcResponse(text: string): McpRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as McpRpcResponse;
  }

  const messages: McpRpcResponse[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload) as McpRpcResponse);
    } catch {
      // Pings and other non-JSON payloads.
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.result !== undefined && msg.method === undefined) return msg;
  }

  const last = messages.at(-1);
  if (!last) {
    throw new Error(`MCP server returned non-JSON response: ${text}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return last;
}

export function isUnsupportedMcpProtocolError(error: McpRpcResponse['error']): boolean {
  if (!error) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('unsupported protocol version') || // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    message.includes('inconsistent mcp protocol version') // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function unsupportedProtocolFromHttpBody(text: string): McpRpcResponse['error'] | undefined {
  try {
    const rpcResponse = parseMcpRpcResponse(text);
    if (rpcResponse.error && isUnsupportedMcpProtocolError(rpcResponse.error)) {
      return rpcResponse.error;
    }
  } catch {
    // A non-JSON error page falls through to the raw-text check.
  }
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (text.toLowerCase().includes('unsupported protocol version')) {
    return { code: -32600, message: text };
  }
  return undefined;
}

type McpFetchOutcome =
  | { kind: 'rpc'; response: McpRpcResponse }
  | { kind: 'retry' }
  | { kind: 'protocol_retry'; error: McpRpcResponse['error'] }
  | { kind: 'failure'; failure: ToolFailure; refusal?: CredentialRefusal };

type McpTransport = {
  url: string;
  /** Sent on every hop. */
  headers: Record<string, string>;
  /** Host headers and credentials: sent to the configured origin only. */
  originBoundHeaders: Record<string, string>;
  policy?: NetworkGuardrailSpec;
  resolveHost?: ResolveHost;
  signal?: AbortSignal;
  onCheck?: (ms: number) => void;
};

async function fetchMcpProtocolAttempt(
  transport: McpTransport,
  rpcId: string | number,
  mcpToolName: string,
  input: unknown,
  protocolVersion: string,
): Promise<McpFetchOutcome> {
  const jsonRpcPayload = {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'tools/call',
    params: {
      name: mcpToolName,
      arguments: input,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
      },
    },
  };

  const response = await fetchGuarded(
    transport.url,
    {
      method: 'POST',
      headers: { ...transport.headers, 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify(jsonRpcPayload),
      signal: transport.signal,
    },
    {
      policy: transport.policy,
      followRedirects: true,
      originBoundHeaders: transport.originBoundHeaders,
      resolveHost: transport.resolveHost,
      onCheck: transport.onCheck,
    },
  );

  const text = await readCappedText(response);
  if (text === undefined) {
    return { kind: 'failure', failure: tooLargeFailure(new URL(transport.url).hostname) };
  }

  if (!response.ok) {
    const acceptRejected =
      response.status === 406 &&
      text.toLowerCase().includes('accept') &&
      protocolVersion !== MCP_PROTOCOL_VERSIONS.at(-1);
    if (acceptRejected) return { kind: 'retry' };
    const protocolError = unsupportedProtocolFromHttpBody(text);
    if (protocolError) return { kind: 'protocol_retry', error: protocolError };
    const refusal = credentialRefusal(response);
    return {
      kind: 'failure',
      ...(refusal ? { refusal } : {}),
      failure: {
        code: `mcp_http_${response.status}`,
        kind: kindOfToolHttpStatus(response.status),
        message: `MCP server error HTTP ${response.status}: ${quotedBody(text)}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
    };
  }

  try {
    const rpcResponse = parseMcpRpcResponse(text);
    if (rpcResponse.error && isUnsupportedMcpProtocolError(rpcResponse.error)) {
      return { kind: 'protocol_retry', error: rpcResponse.error };
    }
    return { kind: 'rpc', response: rpcResponse };
  } catch {
    return {
      kind: 'failure',
      failure: {
        code: 'invalid_response',
        kind: 'bad_response',
        message: `MCP server returned non-JSON response: ${quotedBody(text)}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
    };
  }
}

async function negotiateMcpRpc(
  transport: McpTransport,
  rpcId: string | number,
  mcpToolName: string,
  input: unknown,
): Promise<{
  rpc?: McpRpcResponse;
  failure?: ToolFailure;
  refusal?: CredentialRefusal;
  lastProtocolError?: McpRpcResponse['error'];
}> {
  let lastProtocolError: McpRpcResponse['error'];
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    const outcome = await fetchMcpProtocolAttempt(
      transport,
      rpcId,
      mcpToolName,
      input,
      protocolVersion,
    );
    if (outcome.kind === 'retry' || outcome.kind === 'protocol_retry') {
      if (outcome.kind === 'protocol_retry') lastProtocolError = outcome.error;
      continue;
    }
    if (outcome.kind === 'failure') {
      return { failure: outcome.failure, ...(outcome.refusal ? { refusal: outcome.refusal } : {}) };
    }
    return { rpc: outcome.response };
  }
  return { lastProtocolError };
}

function kindOfToolHttpStatus(status: number): ErrorKind {
  return status === 401 || status === 403 ? 'auth' : 'failed';
}

type McpContent = NonNullable<NonNullable<McpRpcResponse['result']>['content']>[number];

/** A content block as text: its text, an embedded resource's text, or a linked resource's URI. */
function mcpContentText(block: McpContent): string | undefined {
  if (block.type === 'text') return block.text;
  const resource = block.resource as { text?: unknown } | null | undefined;
  if (block.type === 'resource' && typeof resource?.text === 'string') return resource.text;
  if (block.type === 'resource_link' && typeof block.uri === 'string') return block.uri;
  return undefined;
}

/** An image or audio block as media; the spec gives both as base64 `data` and a `mimeType`. */
function mcpMedia(block: McpContent): InteractionPart | undefined {
  if (block.type !== 'image' && block.type !== 'audio') return undefined;
  const { data, mimeType } = block;
  if (typeof data !== 'string' || !data || typeof mimeType !== 'string' || !mimeType.trim()) {
    return undefined;
  }
  return { type: block.type, mimeType, data };
}

/**
 * A tool result's value, read the way the spec layers it: the structured
 * content when the server sends one and it fits the tool's declared output,
 * else the text blocks. Images and audio come back as media, not flattened
 * away.
 */
function extractMcpOutput(
  tool: McpToolDef,
  result: McpRpcResponse['result'],
): {
  checked: ReturnType<typeof parseToolOutput>;
  parts?: InteractionPart[];
  warning?: ToolWarning;
} {
  const content = Array.isArray(result?.content) ? result.content : undefined;
  const media = content?.flatMap((block) => mcpMedia(block) ?? []);
  const withParts = media?.length ? { parts: media } : {};
  let warning: ToolWarning | undefined;
  if (result?.structuredContent !== undefined) {
    const structured = tool.output.safeParse(result.structuredContent);
    if (structured.success) return { checked: structured, ...withParts };
    warning = structuredMismatch(structured.error.issues);
  }
  const text = content
    ? content.flatMap((block) => mcpContentText(block) ?? []).join('\n')
    : result;
  return {
    checked: parseToolOutput(tool.output, text),
    ...withParts,
    ...(warning ? { warning } : {}),
  };
}

/** Otherwise the text fallback hides why the tool's declared fields never arrive. */
function structuredMismatch(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): ToolWarning {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
  const more = issues.length > 3 ? ` (+${String(issues.length - 3)} more)` : '';
  return {
    code: 'mcp_structured_mismatch',
    severity: 'warning',
    message: `structuredContent does not match the output schema, so the text content was used. ${shown.join('; ')}${more}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}

function mcpResultFailure(rpcResponse: McpRpcResponse): ToolFailure | undefined {
  if (rpcResponse.error) {
    return {
      code: `mcp_rpc_error_${rpcResponse.error.code}`,
      kind: 'failed',
      message: rpcResponse.error.message,
      details: rpcResponse.error.data,
    };
  }
  const result = rpcResponse.result;
  if (result?.isError) {
    return {
      code: 'mcp_tool_execution_failed',
      kind: 'failed',
      message: result.content?.map((c) => c.text ?? '').join('\n') ?? 'MCP Tool execution error', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    };
  }
  return undefined;
}

function interpretMcpRpc(
  tool: McpToolDef,
  negotiated: {
    rpc?: McpRpcResponse;
    failure?: ToolFailure;
    lastProtocolError?: McpRpcResponse['error'];
  },
):
  | { ok: true; data: unknown; parts?: InteractionPart[]; warning?: ToolWarning }
  | { ok: false; failure: ToolFailure; warning?: ToolWarning } {
  if (negotiated.failure) {
    return { ok: false, failure: negotiated.failure };
  }
  const rpcResponse = negotiated.rpc;
  if (!rpcResponse) {
    return {
      ok: false,
      failure: {
        code: 'mcp_protocol_error',
        kind: 'failed',
        message: negotiated.lastProtocolError?.message ?? 'MCP protocol negotiation failed', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: negotiated.lastProtocolError?.data,
      },
    };
  }
  const resultFailure = mcpResultFailure(rpcResponse);
  if (resultFailure) {
    return { ok: false, failure: resultFailure };
  }
  const { checked, parts, warning } = extractMcpOutput(tool, rpcResponse.result);
  const withWarning = warning ? { warning } : {};
  if (!checked.success) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        kind: 'bad_response',
        message: 'MCP output schema validation failed', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: checked.error.flatten(),
      },
      ...withWarning,
    };
  }
  return { ok: true, data: checked.data, ...(parts ? { parts } : {}), ...withWarning };
}

/** Streamable HTTP, spec revision 2026-07-28. Order: schema → permission → auth → preTool/host stages → body. */
export async function* executeMcpTool(
  tool: McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const permitted = yield* remoteParseAndPermit(tool, rawInput, ctx, base);
  if (!permitted.ok) return permitted.outcome;

  const guarded = yield* guardToolTarget(tool.serverUrl, ctx, stages?.span);
  if (!guarded.ok) return failureOutcome(guarded.failure, true);

  const prepared = yield* remoteAuthAndPreBody({ tool, input: permitted.input, ctx, base, stages });
  if (!('ok' in prepared)) return prepared;
  return yield* sendWithCredential(prepared, guarded.url, () =>
    sendMcpRequest(
      tool,
      guarded.url,
      prepared.input,
      prepared.authHeaders,
      ctx,
      base,
      stages?.span,
    ),
  );
}

async function* sendMcpRequest(
  tool: McpToolDef,
  url: URL,
  input: unknown,
  authHeaders: Record<string, string>,
  ctx: ToolContext,
  base: ToolCallBase,
  span: SpanHandle | undefined,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const checks = requestChecks(span);
  try {
    const negotiated = await negotiateMcpRpc(
      {
        url: url.href,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        originBoundHeaders: { ...tool.headers, ...authHeaders },
        policy: toolNetworkPolicy(ctx),
        resolveHost: ctx.resolveHost,
        signal: ctx.signal,
        onCheck: checks.onCheck,
      },
      base.callId,
      tool.mcpToolName,
      input,
    );
    const refused = yield* refusedCredentialOutcome(
      tool,
      negotiated.refusal,
      authHeaders,
      ctx,
      base,
    );
    if (refused) return refused;
    const interpreted = interpretMcpRpc(tool, negotiated);
    if (interpreted.warning) {
      yield toolEvent(base, { phase: 'warning', warning: interpreted.warning });
    }
    if (!interpreted.ok) {
      return failureOutcome(interpreted.failure, false);
    }
    return {
      kind: 'ok',
      modelResult: withMedia(modelResultFromOutput(interpreted.data), interpreted.parts),
      outputRaw: interpreted.data,
    };
  } catch (err) {
    return yield* thrownOutcome(err, checks);
  } finally {
    checks.record();
  }
}
