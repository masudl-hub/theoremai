import { errorKind, throwIfAborted } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { fetchGuarded, type ResolveHost } from '../../guardrails/network.ts';
import { type ErrorKind, TheoremError } from '../../guardrails/theorem-error.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import { retryTransient } from '../../providers/shared/retry.ts';
import { isSealedSource, type SealedCredentialSource } from '../auth/credential-source.ts';
import { tokenAudienceCovers } from '../auth/oauth.ts';
import type { AuthScopeRefused } from '../auth/scope-refusal.ts';
import { mapStrings } from '../engine/tree.ts';
import { hookCrashFailure, hookFailed } from '../hook-failure.ts';
import { isTextFile, modelTextFile } from '../registry/attachments.ts';
import { mediaKindForMime } from '../registry/catalog.ts';
import type { AuthUnauthenticatedPolicy } from '../schema.ts';
import type { InteractionPart, ToolOutputPart, ToolWarning } from '../turn-events.ts';
import type { TurnEvent } from '../types.ts';
import {
  credentialId,
  credentialOmitter,
  credentialSender,
  readyCredential,
} from './credential-send.ts';
import {
  dispatchToolBody,
  guardToolTarget,
  type HandOff,
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
import type { HandlerEvents } from './handler-events.ts';
import { answeredIn, type LimitFull, takeLimitPlace } from './http-limit.ts';
import {
  createMcpSessionCache,
  isMcpSessionId,
  type McpSession,
  type McpSessionCache,
  type McpSessionUse,
  mcpSessionKey,
} from './mcp-sessions.ts';
import { outputForModel } from './model-view.ts';
import type { ToolOperationClaim } from './operation.ts';
import { checkPermission, gateDetails } from './permission.ts';
import { assertFixedEndpointOrigin, type JsonSchema } from './schema.ts';
import { issuePath, type SchemaIssue, schemaIssueDetails } from './schema-issues.ts';
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

/** A call's credential, ready to go: a sender for its origin's hops, never the credential itself. */
export type SignedInSend = {
  /** Sends one hop with the credential placed, never following a redirect; the call's own origin only, after its checks. */
  send: typeof fetch;
  /** A stable name for the credential (a digest of it), so MCP sessions are kept per credential. */
  credentialId: string;
  /** Where the credential may go: an OAuth token's resource (RFC 8707), or a sealed slot's. */
  audience?: string;
  /**
   * Replaces the credential wherever a text holds it. Set when the run holds the credential (a
   * source that is not sealed), so a tool's output and failure are cleared of it too; a sealed
   * credential never reaches the run, and its sender clears what the service sends back.
   */
  omit?: (text: string) => string;
};

/** Why a call is not signed in, settled per the tool's `onUnauthenticated`. */
export type UnauthenticatedResult = { auth: 'unauthenticated' } & (
  | { gate: ToolGate }
  | { modelMessage: string }
  /** Why the call fails, under `onUnauthenticated: 'fail'`. */
  | { failureMessage: string }
);

/**
 * How a call's sign-in resolved: the tool signs in to nothing, it is signed in, it is not, or the
 * host's credential source threw (`failed`, reported as `hook_failed`; the call does not start).
 */
export type AuthResolveResult =
  | { auth: 'none' }
  | { auth: 'signed_in'; signedIn: SignedInSend }
  | { auth: 'failed'; failure: ToolFailure }
  | UnauthenticatedResult;

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
): UnauthenticatedResult {
  if (policy === 'gate') {
    // why: The caller emits the gate through emitGateSettlement, so `pre_tool` runs first.
    return { auth: 'unauthenticated', gate: buildAuthGate(toolName, authConfig, message, extras) };
  }
  if (policy === 'fail') return { auth: 'unauthenticated', failureMessage: message };
  return { auth: 'unauthenticated', modelMessage: message };
}

/** Why a stored credential cannot go, told as the tool's `onUnauthenticated` says. */
function* unusableResult(
  toolName: string,
  authConfig: ToolAuthConfig,
  unusable: { reason: 'no_resource' | 'expired' | 'refresh_failed'; detail?: string },
  bound: { issuer?: string; resource?: string },
  base: ToolCallBase,
): Generator<TurnEvent, UnauthenticatedResult> {
  const slot = authConfig.slot;
  const policy = authConfig.onUnauthenticated ?? 'gate';
  if (unusable.reason === 'no_resource') {
    const message = `OAuth credential for '${toolName}' (slot: '${slot}') does not name the resource it was issued for.`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy, bound);
  }
  if (unusable.reason === 'expired') {
    const message = `OAuth token expired for '${toolName}' (slot: '${slot}') and no refresh token is available.`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy, bound);
  }
  // invariant: The server's own words are untrusted text: they go to the host as
  // `errorInternal`, never to the model or the client.
  yield {
    ...toolEvent(base, { phase: 'progress', data: { kind: 'auth_token_refresh_failed', slot } }),
    ...(unusable.detail === undefined ? {} : { errorInternal: unusable.detail }),
  };
  const message = `Failed to refresh OAuth token for '${toolName}' (slot: '${slot}').`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return unauthenticatedResult(toolName, authConfig, message, policy, bound);
}

/** A sealed source's send as a fetch: the request goes across as plain data, its body as text. */
function sealedSender(source: SealedCredentialSource, slot: string): typeof fetch {
  return (input, init) => {
    const body = init?.body ?? undefined;
    if (input instanceof Request || (body !== undefined && typeof body !== 'string')) {
      throw new TheoremError('internal', 'A sealed request is a URL with a text body'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    return source.send(slot, String(input), {
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(body === undefined ? {} : { body }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  };
}

/** Only the slot is named, so no token rides the stream. */
function refreshedEvent(base: ToolCallBase, slot: string): TurnEvent {
  return toolEvent(base, { phase: 'progress', data: { kind: 'auth_token_refreshed', slot } });
}

/**
 * Readies the call's credential from the host's source for the tool's slot, refreshing an OAuth
 * token when needed, and answers with a sender that carries it; with no usable credential it
 * answers with a gate or a message for the model, per the tool's `onUnauthenticated`. A sealed
 * source readies and sends on its own side, so the credential never reaches the run.
 */
export async function* resolveToolAuth(
  toolName: string,
  authConfig: ToolAuthConfig | undefined,
  ctx: ToolContext,
  base: ToolCallBase,
  span?: SpanHandle,
): AsyncGenerator<TurnEvent, AuthResolveResult> {
  try {
    return yield* readToolAuth(toolName, authConfig, ctx, base);
  } catch (err) {
    throwIfAborted(ctx.signal);
    // invariant: a host hook that throws never ends the turn; the call fails as not started.
    yield hookFailed('credentials', err, { callId: base.callId, span });
    return { auth: 'failed', failure: hookCrashFailure(err, ctx.profile.labels) };
  }
}

async function* readToolAuth(
  toolName: string,
  authConfig: ToolAuthConfig | undefined,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, AuthResolveResult> {
  if (!authConfig) return { auth: 'none' };
  const slot = authConfig.slot;
  const source = ctx.credentials;
  const missing = () => {
    const message = `Authentication required for '${toolName}' (auth slot: '${slot}').`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(
      toolName,
      authConfig,
      message,
      authConfig.onUnauthenticated ?? 'gate',
    );
  };
  if (!source) return missing();

  if (isSealedSource(source)) {
    const sealed = await source.prepare(slot);
    if (sealed.state === 'absent') return missing();
    const bound = {
      ...(sealed.issuer === undefined ? {} : { issuer: sealed.issuer }),
      ...(sealed.resource === undefined ? {} : { resource: sealed.resource }),
    };
    if (sealed.state === 'unusable') {
      return yield* unusableResult(toolName, authConfig, sealed, bound, base);
    }
    if (sealed.refreshed) yield refreshedEvent(base, slot);
    return {
      auth: 'signed_in',
      signedIn: {
        send: sealedSender(source, slot),
        credentialId: sealed.id,
        audience: sealed.resource,
      },
    };
  }

  const stored = await source.get(slot);
  if (!stored) return missing();
  const bound =
    stored.type === 'oauth2' ? { issuer: stored.issuer, resource: stored.resource } : {};
  const ready = await readyCredential(slot, stored, source, {
    network: toolNetworkPolicy(ctx),
    resolveHost: ctx.resolveHost,
  });
  if (ready.state === 'unusable') {
    return yield* unusableResult(toolName, authConfig, ready, bound, base);
  }
  if (ready.refreshed) yield refreshedEvent(base, slot);
  const { credential } = ready;
  return {
    auth: 'signed_in',
    signedIn: {
      send: credentialSender(credential, authConfig, ctx.fetch),
      credentialId: await credentialId(credential),
      ...(credential.type === 'oauth2' ? { audience: credential.resource } : {}),
      omit: credentialOmitter(credential),
    },
  };
}

export type HttpToolMapping = NonNullable<HttpToolDef['mapping']>;

/**
 * One path parameter, encoded. `encodeURIComponent` leaves `.` and `..` as they
 * are and a URL resolves them, walking the endpoint's path; they are refused.
 */
function pathSegment(param: string, value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`Path parameter "${param}" cannot be "${value}"`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return encodeURIComponent(value);
}

export type HttpToolTarget = {
  url: string;
  body?: string;
};

/** The URL and, for anything but GET, the JSON body of an HTTP tool call: path parameters fill the endpoint, query parameters go on the URL, and the rest of the input (or `bodyParam`) is the body; throws when a path parameter is missing. */
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
      `Missing required path parameter "${unreplacedMatch[1]}" for endpoint "${endpoint}"`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
    ) => { success: true; data: T } | { success: false; error: { issues: readonly SchemaIssue[] } };
  },
  responseData: unknown,
): { success: true; data: T } | { success: false; error: { issues: readonly SchemaIssue[] } } {
  let checked = schema.safeParse(responseData);
  if (!checked.success && typeof responseData === 'string' && responseData.trim().length > 0) {
    try {
      const jsonParsed = JSON.parse(responseData);
      const retryChecked = schema.safeParse(jsonParsed);
      if (retryChecked.success) {
        checked = retryChecked;
      }
    } catch {
      // why: Not JSON: the schema's first result stands.
    }
  }
  return checked;
}

/**
 * Not repeated as `data`, which `composeToolText` would append a second time. A field the tool's
 * output schema marks `exposeToModel: false` is left out.
 */
export function modelResultFromOutput(
  data: unknown,
  outputSchema: JsonSchema | undefined,
): ModelToolResult {
  const seen = outputForModel(outputSchema, data);
  return { finding: typeof seen === 'string' ? seen : JSON.stringify(seen) };
}

/**
 * The result with the media a tool returned beside its value, when it returned any: `media` as the
 * tool returned it, and `parts`, what the model reads of it. The one place the model's parts are
 * made: a reference never becomes one, and `sent` is not passed on.
 */
export function withMedia(
  result: ModelToolResult,
  media: readonly ToolOutputPart[] | undefined,
): ModelToolResult {
  if (!media?.length) return result;
  const parts = readParts(media);
  return { ...result, media: [...media], ...(parts.length ? { parts } : {}) };
}

/** What the model reads of a tool's media: text and bytes, never a reference. */
function readParts(media: readonly ToolOutputPart[]): InteractionPart[] {
  return media.flatMap((part): InteractionPart[] => {
    if (part.type === 'text') return [part];
    if (!('data' in part)) return [];
    const file = isTextFile(part.mimeType) ? modelTextFile(part.mimeType, part.data) : part;
    return [{ type: part.type, mimeType: file.mimeType, data: file.data }];
  });
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

function remoteParseAndPermit(
  tool: HttpToolDef | McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
): { ok: true; input: unknown } | { ok: false; outcome: ToolBodyOutcome } {
  const started = startToolExecution(tool, rawInput, ctx);
  if (!started.ok) {
    return { ok: false, outcome: failureOutcome(started.failure, true) };
  }
  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
    gateDetails(tool, started.data),
  );
  if (permissionGate) {
    return { ok: false, outcome: { kind: 'gated', gate: permissionGate } };
  }
  return { ok: true, input: started.data };
}

/** `sent`: the service refused a request the call already sent, so the call has started. */
export function outcomeFromUnauth(authRes: UnauthenticatedResult, sent = false): ToolBodyOutcome {
  if ('gate' in authRes) return { kind: 'gated', gate: authRes.gate };
  if ('modelMessage' in authRes) {
    return {
      kind: 'ok',
      modelResult: { finding: authRes.modelMessage },
      outputRaw: { unauthenticated: true, message: authRes.modelMessage },
      unauthenticated: true,
    };
  }
  return failureOutcome(
    { code: 'not_authorized', kind: 'auth', message: authRes.failureMessage },
    !sent,
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
 * asked against what is declared. Any other refusal is the call's failure. `carried` says the
 * request went with a credential, in a header or in the URL.
 */
export function* refusedCredentialOutcome(
  tool: { name: string; auth?: ToolAuthConfig },
  refusal: CredentialRefusal | undefined,
  carried: boolean,
  ctx: ToolContext,
  base: ToolCallBase,
): Generator<TurnEvent, ToolBodyOutcome | undefined> {
  const auth = tool.auth;
  if (!auth || !refusal || !carried) return undefined;
  const policy = auth.onUnauthenticated ?? 'gate';
  if (refusal.status === 401) {
    const message = `The credential for '${tool.name}' (slot: '${auth.slot}') was refused.`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return outcomeFromUnauth(unauthenticatedResult(tool.name, auth, message, policy), true);
  }
  const challenge = bearerChallenge(refusal.challenge);
  if (challenge.error !== 'insufficient_scope') return undefined;
  const declared = auth.scopes ?? [];
  const requested = challenge.scopes;
  if (requested.length > 0 && requested.every((scope) => declared.includes(scope))) {
    const message = `'${tool.name}' needs scopes its credential (slot: '${auth.slot}') does not carry.`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return outcomeFromUnauth(unauthenticatedResult(tool.name, auth, message, policy), true);
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
      message: labelText('sign_in.out_of_scope', { service: auth.service }, ctx.profile.labels),
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
  { ok: true; input: unknown; signedIn?: SignedInSend } | ToolBodyOutcome
> {
  const authRes = yield* resolveToolAuth(
    args.tool.name,
    args.tool.auth,
    args.ctx,
    args.base,
    args.stages?.span,
  );
  if (authRes.auth === 'unauthenticated') return outcomeFromUnauth(authRes);
  if (authRes.auth === 'failed') return failureOutcome(authRes.failure, true);

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
    ...(authRes.auth === 'signed_in' ? { signedIn: authRes.signedIn } : {}),
  };
}

/** A thrown request's code: a kind with a code of its own, else `request_failed`. */
const THROWN_CODES: Partial<Record<ErrorKind, string>> = {
  network: 'network_error',
  cancelled: 'cancelled',
  timeout: 'timeout',
};

function* thrownOutcome(
  err: unknown,
  checks: RequestChecks,
): Generator<TurnEvent, ToolBodyOutcome> {
  if (errorKind(err) === 'blocked') {
    const blocked = networkBlockedEvent();
    checks.record(blocked);
    return failureOutcome(yield* networkBlocked(err, blocked), false);
  }
  const kind = errorKind(err);
  return failureOutcome(
    { code: THROWN_CODES[kind] ?? 'request_failed', kind, message: messageOf(err) },
    false,
  );
}

/** The most of an error or unparseable body quoted back in a failure message. */
const MAX_QUOTED_BODY_CHARS = 2000;

/** A body's text as it arrives, up to `maxBytes` when set; returns `false` when it runs past, with the rest left unread. */
async function* cappedPieces(
  response: Response,
  maxBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<string, boolean> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  if (!response.body) {
    yield await response.text();
    return true;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return false;
    }
    const piece = decoder.decode(value, { stream: true });
    if (piece) yield piece;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
  return true;
}

/** A body, read up to `maxBytes` when set; `undefined` when it runs past, with the rest left unread. */
export async function readCappedText(
  response: Response,
  maxBytes: number | undefined,
): Promise<string | undefined> {
  const pieces = cappedPieces(response, maxBytes);
  let text = '';
  for (;;) {
    const next = await pieces.next();
    if (next.done) return next.value ? text : undefined;
    text += next.value;
  }
}

/**
 * A body read as `readCappedText` reads it, shown as drafts while it arrives. A credential the
 * service echoed is already replaced: its sender reads it out of the body as the body arrives.
 * Drafts that ran before the body ran past its cap stay sent.
 */
async function* readCappedTextShowing(
  response: Response,
  shown: HandlerEvents,
  maxBytes: number | undefined,
): AsyncGenerator<TurnEvent, string | undefined> {
  const pieces = cappedPieces(response, maxBytes);
  let text = '';
  for (;;) {
    const next = await pieces.next();
    if (next.done) {
      if (!next.value) return undefined;
      yield* shown.end();
      return text;
    }
    text += next.value;
    yield* shown.show({ kind: 'draft', text: next.value });
  }
}

/** A body quoted in a failure message, cut short when long. */
function quotedBody(text: string): string {
  return text.length > MAX_QUOTED_BODY_CHARS ? `${text.slice(0, MAX_QUOTED_BODY_CHARS)}…` : text;
}

/** The failure for a body past the tool's `maxResponseBytes`. */
function tooLargeFailure(host: string, maxBytes: number | undefined): ToolFailure {
  return {
    code: 'response_too_large',
    kind: 'bad_response',
    message: `Response from ${host} is larger than ${maxBytes} bytes`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}

/** Why a credential bound to `audience` may not go to `url` (RFC 8707), or `undefined` when it may. */
export function audienceMismatch(audience: string | undefined, url: URL): string | undefined {
  if (!audience || tokenAudienceCovers(audience, url)) return undefined;
  return `The credential for "${audience}" cannot be sent to "${url.origin}${url.pathname}"`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

/** A failure's message and details with the credential replaced. */
export function failureWithoutSecret(
  failure: ToolFailure,
  omit: (text: string) => string,
): ToolFailure {
  return {
    ...failure,
    message: omit(failure.message),
    ...(failure.details === undefined ? {} : { details: mapStrings(failure.details, omit) }),
  };
}

/** An echo endpoint or debug page can repeat the credential; it must never reach the model, trace, or client. */
function withoutSecret(
  outcome: ToolBodyOutcome,
  omit: ((text: string) => string) | undefined,
  outputSchema: JsonSchema,
): ToolBodyOutcome {
  if (!omit) return outcome;
  if (outcome.kind === 'ok') {
    const outputRaw = mapStrings(outcome.outputRaw, omit);
    return {
      ...outcome,
      outputRaw,
      modelResult: withMedia(
        modelResultFromOutput(outputRaw, outputSchema),
        outcome.modelResult.media,
      ),
    };
  }
  if (outcome.kind === 'failed') {
    return { ...outcome, failure: failureWithoutSecret(outcome.failure, omit) };
  }
  return outcome;
}

/**
 * A credential goes only to where it is bound (an OAuth token's resource, RFC 8707, or a sealed
 * slot's); any other target gets no request. `send` gets the URL after the target's checks.
 */
async function* sendWithCredential(
  signedIn: SignedInSend | undefined,
  outputSchema: JsonSchema,
  url: URL,
  send: (url: URL) => AsyncGenerator<TurnEvent, ToolBodyOutcome>,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const mismatch = audienceMismatch(signedIn?.audience, url);
  if (mismatch) {
    return failureOutcome(
      { code: 'credential_audience_mismatch', kind: 'config', message: mismatch },
      true,
    );
  }
  return withoutSecret(yield* send(url), signedIn?.omit, outputSchema);
}

/**
 * Order: schema → permission → auth → preTool/host stages → body. `shown` takes the body while it
 * arrives, as a function tool's drafts.
 */
export async function* executeHttpTool(
  tool: HttpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  stages?: ToolStageSupport,
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
  shown?: HandlerEvents,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const parsed = remoteParseAndPermit(tool, rawInput, ctx);
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
  const handOff = yield* dispatchToolBody(tool, input, ctx, base, beginBody);
  return yield* sendWithCredential(prepared.signedIn, tool.outputSchema, guarded.url, (url) =>
    sendHttpRequest(
      tool,
      url,
      target.body,
      prepared.signedIn,
      ctx,
      base,
      stages?.span,
      shown,
      handOff,
    ),
  );
}

/** A body that is text, read so far: what a successful call's drafts show. */
function isDraftable(response: Response): boolean {
  if (!response.ok) return false;
  const type = response.headers.get('content-type') ?? '';
  return type === '' || type.startsWith('text/') || /[/+]json\b/.test(type);
}

/** An HTTP tool's body; a successful text body shows as drafts while it arrives, any other reads whole. */
async function* readHttpBody(
  response: Response,
  shown: HandlerEvents | undefined,
  maxBytes: number | undefined,
): AsyncGenerator<TurnEvent, string | undefined> {
  if (!shown || !isDraftable(response)) return await readCappedText(response, maxBytes);
  return yield* readCappedTextShowing(response, shown, maxBytes);
}

/** The headers an HTTP tool's request is sent with, before its own and its credential's. */
export function httpRequestHeaders(method: HttpToolDef['method']): Record<string, string> {
  return method === 'GET'
    ? { Accept: 'application/json' }
    : { Accept: 'application/json', 'Content-Type': 'application/json' };
}

/** The headers every MCP request is sent with, before the tool's own and its credential's. */
export const MCP_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/** A read changes nothing, so a busy or briefly down service is asked again, as a model call is; a write is never sent twice. */
function readRetried(tool: HttpToolDef, send: typeof fetch): typeof fetch {
  return tool.access === 'read-only' ? retryTransient(send) : send;
}

async function* sendHttpRequest(
  tool: HttpToolDef,
  targetUrl: URL,
  body: string | undefined,
  signedIn: SignedInSend | undefined,
  ctx: ToolContext,
  base: ToolCallBase,
  span: SpanHandle | undefined,
  shown: HandlerEvents | undefined,
  handOff: HandOff,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const checks = requestChecks(span);
  const headers = httpRequestHeaders(tool.method);

  let timedOut: AbortSignal | undefined;
  try {
    const place = tool.limit
      ? await takeLimitPlace(tool, tool.limit, ctx.signal, ctx.limitWait)
      : undefined;
    if (place && 'full' in place) return failureOutcome(limitFullFailure(tool, place), false);
    // why: the timeout starts at send, so a call's wait for a place is not counted against it.
    timedOut = tool.timeoutMs === undefined ? undefined : AbortSignal.timeout(tool.timeoutMs);
    const signal =
      timedOut && ctx.signal ? AbortSignal.any([ctx.signal, timedOut]) : (timedOut ?? ctx.signal);
    const response = await answeredIn(
      place,
      fetchGuarded(
        targetUrl.href,
        { method: tool.method, headers, body, signal },
        {
          policy: toolNetworkPolicy(ctx),
          followRedirects: true,
          fetchFn: readRetried(tool, ctx.fetch ?? fetch),
          ...(signedIn ? { originFetchFn: readRetried(tool, signedIn.send) } : {}),
          originBoundHeaders: { ...tool.headers },
          resolveHost: ctx.resolveHost,
          onCheck: checks.onCheck,
          beforeSend: async () => {
            await handOff.claim();
          },
        },
      ),
    );

    const text = yield* readHttpBody(response, shown, tool.maxResponseBytes);
    if (text === undefined) {
      return failureOutcome(tooLargeFailure(targetUrl.hostname, tool.maxResponseBytes), false);
    }

    if (!response.ok) {
      const refused = yield* refusedCredentialOutcome(
        tool,
        credentialRefusal(response),
        signedIn !== undefined,
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
        message: 'HTTP response did not match tool output schema', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: schemaIssueDetails(checked.error.issues),
      };
      return failureOutcome(failure, false);
    }

    return {
      kind: 'ok',
      modelResult: modelResultFromOutput(checked.data, tool.outputSchema),
      outputRaw: checked.data,
    };
  } catch (err) {
    handOff.rethrowClaimFailure();
    if (tool.timeoutMs !== undefined && timedOut?.aborted && !ctx.signal?.aborted) {
      return failureOutcome(timeoutFailure(targetUrl.hostname, tool.timeoutMs), false);
    }
    return yield* thrownOutcome(err, checks);
  } finally {
    checks.record();
  }
}

/** The service did not answer within the tool's `timeoutMs`. */
function timeoutFailure(hostname: string, timeoutMs: number): ToolFailure {
  return {
    code: 'timeout',
    kind: 'timeout',
    message: `${hostname} did not answer within ${timeoutMs} ms`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}

/** Preferred first. */
export const MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

/**
 * The `_meta` an MCP request carries. Stateless servers (2026-07-28) read the client's revision and
 * capabilities from each request, not from an initialize, and refuse one without both.
 */
export function mcpRequestMeta(protocolVersion: string): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

/** An MCP protocol version the client can speak. */
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/** A JSON-RPC message from an MCP server: a result or an error. */
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
      // why: Pings and other non-JSON payloads.
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.result !== undefined && msg.method === undefined) return msg;
  }

  const last = messages.at(-1);
  if (!last) {
    throw new Error(`MCP server returned non-JSON response: ${text}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return last;
}

/** True when an MCP error says the server does not accept the protocol version sent. */
export function isUnsupportedMcpProtocolError(error: McpRpcResponse['error']): boolean {
  if (!error) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('unsupported protocol version') || // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    message.includes('inconsistent mcp protocol version') // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function unsupportedProtocolFromHttpBody(text: string): McpRpcResponse['error'] | undefined {
  try {
    const rpcResponse = parseMcpRpcResponse(text);
    if (rpcResponse.error && isUnsupportedMcpProtocolError(rpcResponse.error)) {
      return rpcResponse.error;
    }
  } catch {
    // why: A non-JSON error page falls through to the raw-text check.
  }
  // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (text.toLowerCase().includes('unsupported protocol version')) {
    return { code: -32600, message: text };
  }
  return undefined;
}

type McpFetchOutcome =
  | { kind: 'rpc'; response: McpRpcResponse }
  | { kind: 'retry' }
  | { kind: 'protocol_retry'; error: McpRpcResponse['error'] }
  | { kind: 'session_required' }
  | { kind: 'session_expired' }
  | { kind: 'failure'; failure: ToolFailure; refusal?: CredentialRefusal; answer?: McpAnswer };

/** What the server answered when it was not a JSON-RPC message: its status and body. */
export type McpAnswer = { status: number; body: string };

/** One JSON-RPC request: a tool call names its tool, a list names none. */
export type McpRpcCall = {
  id: string | number;
  method: 'tools/call' | 'tools/list';
  params: Record<string, unknown>;
  /** The tool a `tools/call` names, sent as `Mcp-Name`. */
  name?: string;
};

/** A `tools/call` for `mcpToolName` with `input`. */
function mcpToolCall(rpcId: string | number, mcpToolName: string, input: unknown): McpRpcCall {
  return {
    id: rpcId,
    method: 'tools/call',
    params: { name: mcpToolName, arguments: input },
    name: mcpToolName,
  };
}

export type McpTransport = {
  url: string;
  /** Sent on every hop. */
  headers: Record<string, string>;
  /** Host headers: sent to the configured origin only. */
  originBoundHeaders: Record<string, string>;
  /** Sends the configured origin's hops with the call's credential; set when the call carries one. */
  originFetch?: typeof fetch;
  policy?: NetworkGuardrailSpec;
  resolveHost?: ResolveHost;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onCheck?: (ms: number) => void;
  maxResponseBytes?: number;
  /** Takes the call's claim before its first `tools/call` is sent; never before a session opens. */
  beforeSend?: () => Promise<void>;
};

async function fetchMcpProtocolAttempt(
  transport: McpTransport,
  call: McpRpcCall,
  protocolVersion: string,
): Promise<McpFetchOutcome> {
  const jsonRpcPayload = {
    jsonrpc: '2.0',
    id: call.id,
    method: call.method,
    params: { ...call.params, _meta: mcpRequestMeta(protocolVersion) },
  };

  const response = await fetchGuarded(
    transport.url,
    {
      method: 'POST',
      headers: {
        ...transport.headers,
        'MCP-Protocol-Version': protocolVersion,
        'Mcp-Method': call.method,
        ...(call.name === undefined ? {} : { 'Mcp-Name': call.name }),
      },
      body: JSON.stringify(jsonRpcPayload),
      signal: transport.signal,
    },
    {
      policy: transport.policy,
      followRedirects: true,
      originBoundHeaders: transport.originBoundHeaders,
      resolveHost: transport.resolveHost,
      fetchFn: transport.fetch,
      ...(transport.originFetch ? { originFetchFn: transport.originFetch } : {}),
      onCheck: transport.onCheck,
      ...(transport.beforeSend ? { beforeSend: transport.beforeSend } : {}),
    },
  );

  const text = await readCappedText(response, transport.maxResponseBytes);
  if (text === undefined) {
    const host = new URL(transport.url).hostname;
    return { kind: 'failure', failure: tooLargeFailure(host, transport.maxResponseBytes) };
  }

  if (!response.ok) {
    const sessionSent = SESSION_HEADER in transport.originBoundHeaders;
    if (sessionSent && response.status === 404) return { kind: 'session_expired' };
    if (!sessionSent && response.status === 400 && /mcp-session-id/i.test(text)) {
      return { kind: 'session_required' };
    }
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
      answer: { status: response.status, body: text },
      failure: {
        code: `mcp_http_${response.status}`,
        kind: kindOfToolHttpStatus(response.status),
        message: `MCP server error HTTP ${response.status} from ${new URL(transport.url).hostname}: ${quotedBody(text)}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      answer: { status: response.status, body: text },
      failure: {
        code: 'invalid_response',
        kind: 'bad_response',
        message: `MCP server returned non-JSON response: ${quotedBody(text)}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
    };
  }
}

export type McpNegotiated = {
  rpc?: McpRpcResponse;
  /** The protocol version `rpc` was answered under. */
  protocolVersion?: string;
  failure?: ToolFailure;
  refusal?: CredentialRefusal;
  /** The server's status and body, when it answered with something other than JSON-RPC. */
  answer?: McpAnswer;
  lastProtocolError?: McpRpcResponse['error'];
  /** The server refused a call without a session. */
  sessionRequired?: boolean;
};

export async function negotiateMcpRpc(
  transport: McpTransport,
  call: McpRpcCall,
): Promise<McpNegotiated> {
  let lastProtocolError: McpRpcResponse['error'];
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    const outcome = await fetchMcpProtocolAttempt(transport, call, protocolVersion);
    if (outcome.kind === 'retry' || outcome.kind === 'protocol_retry') {
      if (outcome.kind === 'protocol_retry') lastProtocolError = outcome.error;
      continue;
    }
    if (outcome.kind === 'failure') return failureNegotiated(outcome);
    if (outcome.kind !== 'rpc') return { sessionRequired: true };
    return { rpc: outcome.response, protocolVersion };
  }
  return { lastProtocolError };
}

function failureNegotiated(
  outcome: Extract<McpFetchOutcome, { kind: 'failure' }>,
  sessionId?: string,
): McpNegotiated {
  // why: A server can echo the session ID in its error; it goes no further than the server.
  const hidden = (text: string) => (sessionId ? text.replaceAll(sessionId, '[session]') : text);
  return {
    failure: { ...outcome.failure, message: hidden(outcome.failure.message) },
    ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    ...(outcome.answer
      ? { answer: { status: outcome.answer.status, body: hidden(outcome.answer.body) } }
      : {}),
  };
}

const SESSION_HEADER = 'Mcp-Session-Id';
/** The newest revision that has sessions; 2026-07-28 is stateless. */
const SESSION_PROTOCOL_VERSION = '2025-11-25';

class McpSessionFailure extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.message);
  }
}

function sessionFailure(code: string, message: string): McpSessionFailure {
  return new McpSessionFailure({ code, kind: 'failed', message });
}

/**
 * Opens a session: initialize, then the initialized notification. Only the session ID and version
 * are read back; the server's `instructions` would be a prompt-injection channel. Redirects are not
 * followed, so a session can only come from the configured server.
 */
async function openMcpSession(transport: McpTransport): Promise<McpSession> {
  const post = (body: unknown, headers: Record<string, string>, originBound = {}) =>
    fetchGuarded(
      transport.url,
      {
        method: 'POST',
        headers: { ...transport.headers, ...headers },
        body: JSON.stringify(body),
        signal: transport.signal,
      },
      {
        policy: transport.policy,
        followRedirects: false,
        originBoundHeaders: { ...transport.originBoundHeaders, ...originBound },
        resolveHost: transport.resolveHost,
        fetchFn: transport.fetch,
        ...(transport.originFetch ? { originFetchFn: transport.originFetch } : {}),
        onCheck: transport.onCheck,
      },
    );
  const response = await post(
    {
      jsonrpc: '2.0',
      id: 'initialize',
      method: 'initialize',
      params: {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'theorem', version: '1' },
      },
    },
    { 'Mcp-Method': 'initialize' },
  );
  const text = await readCappedText(response, transport.maxResponseBytes);
  if (text === undefined) {
    const host = new URL(transport.url).hostname;
    throw new McpSessionFailure(tooLargeFailure(host, transport.maxResponseBytes));
  }
  if (!response.ok) {
    throw sessionFailure(
      `mcp_session_http_${response.status}`,
      `MCP server ${new URL(transport.url).hostname} refused to open a session: HTTP ${response.status}: ${quotedBody(text)}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const id = response.headers.get(SESSION_HEADER);
  if (!isMcpSessionId(id)) {
    throw sessionFailure(
      'mcp_session_invalid',
      'MCP server required a session but sent no usable session ID', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  let version: unknown;
  try {
    version = parseMcpRpcResponse(text).result?.protocolVersion;
  } catch {
    version = undefined;
  }
  if (!MCP_PROTOCOL_VERSIONS.some((known) => known === version)) {
    throw sessionFailure(
      'mcp_protocol_error',
      'MCP server opened a session on a protocol version Theorem does not speak', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const protocolVersion = String(version);
  const initialized = await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'MCP-Protocol-Version': protocolVersion, 'Mcp-Method': 'notifications/initialized' },
    { [SESSION_HEADER]: id },
  );
  await initialized.body?.cancel().catch(() => {});
  return { id, protocolVersion };
}

/** The call in a session: an expired one is reopened once, so a server can't loop us. */
export async function negotiateInSession(
  transport: McpTransport,
  call: McpRpcCall,
  sessions: { cache: McpSessionCache; key: string; use: McpSessionUse; cached?: McpSession },
): Promise<McpNegotiated> {
  let session = sessions.cached;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) {
      try {
        session = await sessions.cache.open(sessions.key, sessions.use, () =>
          openMcpSession(transport),
        );
      } catch (err) {
        if (err instanceof McpSessionFailure) return { failure: err.failure };
        throw err;
      }
    }
    const outcome = await fetchMcpProtocolAttempt(
      {
        ...transport,
        originBoundHeaders: { ...transport.originBoundHeaders, [SESSION_HEADER]: session.id },
      },
      call,
      session.protocolVersion,
    );
    if (outcome.kind === 'session_expired') {
      sessions.cache.drop(sessions.key, session.id);
      session = undefined;
      continue;
    }
    if (outcome.kind === 'rpc') {
      return { rpc: outcome.response, protocolVersion: session.protocolVersion };
    }
    if (outcome.kind === 'failure') return failureNegotiated(outcome, session.id);
    return {
      lastProtocolError: outcome.kind === 'protocol_retry' ? outcome.error : undefined,
    };
  }
  return {
    failure: {
      code: 'mcp_session_expired',
      kind: 'failed',
      message: 'MCP server ended the session again right after it was reopened', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    },
  };
}

/** A limited tool with no place in its window within the wait budget: nothing was sent. */
function limitFullFailure(tool: HttpToolDef, full: LimitFull): ToolFailure {
  const { requests, windowMs } = full.limit;
  // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const opens =
    full.opensInMs === undefined
      ? 'every one is still unanswered'
      : `the next place opens in ${Math.ceil(full.opensInMs)} ms`;
  return {
    code: 'rate_limit_window',
    kind: 'rate_limit',
    message: `${tool.name} is at its limit of ${requests} requests per ${windowMs} ms; ${opens}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}

/** The failure kind for a tool server's HTTP status: 401, 402 and 403 are `auth`, as a provider's are; 429 `rate_limit`; the rest `failed`. */
function kindOfToolHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  return 'failed';
}

type McpContent = NonNullable<NonNullable<McpRpcResponse['result']>['content']>[number];

/**
 * A content block as text: its text, an embedded resource's text, or a linked resource's URI. A
 * link that is media is a reference the model never reads, so its URI is no text.
 */
function mcpContentText(block: McpContent): string | undefined {
  if (block.type === 'text') return block.text;
  const resource = block.resource as { text?: unknown } | null | undefined;
  if (block.type === 'resource' && typeof resource?.text === 'string') return resource.text;
  if (block.type === 'resource_link' && typeof block.uri === 'string' && !mcpMedia(block)) {
    return block.uri;
  }
  return undefined;
}

/**
 * A content block as tool media: an image or audio block the model reads, `sent` when the server
 * names the user in its audience; a `resource_link` with a MIME type as a reference the person is
 * shown and the model never reads.
 */
function mcpMedia(block: McpContent): ToolOutputPart | undefined {
  const { mimeType } = block;
  if (typeof mimeType !== 'string' || !mimeType.trim()) return undefined;
  if (block.type === 'resource_link') {
    const { uri } = block;
    if (typeof uri !== 'string' || !uri) return undefined;
    return { type: mediaKindForMime(mimeType) ?? 'document', mimeType, uri };
  }
  if (block.type !== 'image' && block.type !== 'audio') return undefined;
  const { data } = block;
  if (typeof data !== 'string' || !data) return undefined;
  return { type: block.type, mimeType, data, ...(forUser(block) ? { sent: true as const } : {}) };
}

/** Whether a block's `annotations.audience` names the user. */
function forUser(block: McpContent): boolean {
  const annotations = block.annotations;
  if (!annotations || typeof annotations !== 'object') return false;
  const audience = (annotations as { audience?: unknown }).audience;
  return Array.isArray(audience) && audience.includes('user');
}

/**
 * A tool result's value, read the way the spec layers it: the structured
 * content when the server sends one and it fits the tool's declared output,
 * else the text blocks. Images, audio and resource links come back as media, not
 * flattened away.
 */
function extractMcpOutput(
  tool: McpToolDef,
  result: McpRpcResponse['result'],
): {
  checked: ReturnType<typeof parseToolOutput>;
  parts?: ToolOutputPart[];
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
function structuredMismatch(issues: readonly SchemaIssue[]): ToolWarning {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issuePath(issue.path) || '(root)'}: ${issue.message}`);
  const more = issues.length > 3 ? ` (+${String(issues.length - 3)} more)` : '';
  return {
    code: 'mcp_structured_mismatch',
    severity: 'warning',
    message: `structuredContent does not match the output schema, so the text content was used. ${shown.join('; ')}${more}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      message: result.content?.map((c) => c.text ?? '').join('\n') ?? 'MCP Tool execution error', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
  | { ok: true; data: unknown; parts?: ToolOutputPart[]; warning?: ToolWarning }
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
        message: negotiated.lastProtocolError?.message ?? 'MCP protocol negotiation failed', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
        message: 'MCP output schema validation failed', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: schemaIssueDetails(checked.error.issues),
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
  /** The scope's sessions; without them a session lasts one call. */
  sessions: McpSessionCache = createMcpSessionCache(),
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const permitted = remoteParseAndPermit(tool, rawInput, ctx);
  if (!permitted.ok) return permitted.outcome;

  const guarded = yield* guardToolTarget(tool.serverUrl, ctx, stages?.span);
  if (!guarded.ok) return failureOutcome(guarded.failure, true);

  const prepared = yield* remoteAuthAndPreBody({ tool, input: permitted.input, ctx, base, stages });
  if (!('ok' in prepared)) return prepared;
  const handOff = yield* dispatchToolBody(tool, prepared.input, ctx, base, beginBody);
  return yield* sendWithCredential(prepared.signedIn, tool.outputSchema, guarded.url, (url) =>
    sendMcpRequest(
      tool,
      url,
      prepared.input,
      prepared.signedIn,
      ctx,
      base,
      stages?.span,
      sessions,
      handOff,
    ),
  );
}

async function* sendMcpRequest(
  tool: McpToolDef,
  url: URL,
  input: unknown,
  signedIn: SignedInSend | undefined,
  ctx: ToolContext,
  base: ToolCallBase,
  span: SpanHandle | undefined,
  sessions: McpSessionCache,
  handOff: HandOff,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const checks = requestChecks(span);
  try {
    const transport: McpTransport = {
      url: url.href,
      headers: { ...MCP_REQUEST_HEADERS },
      originBoundHeaders: { ...tool.headers },
      ...(signedIn ? { originFetch: signedIn.send } : {}),
      policy: toolNetworkPolicy(ctx),
      resolveHost: ctx.resolveHost,
      fetch: ctx.fetch,
      signal: ctx.signal,
      onCheck: checks.onCheck,
      ...(tool.maxResponseBytes === undefined ? {} : { maxResponseBytes: tool.maxResponseBytes }),
      beforeSend: async () => {
        await handOff.claim();
      },
    };
    const key = await mcpSessionKey(url.href, transport.originBoundHeaders, signedIn?.credentialId);
    const use: McpSessionUse = { tool: tool.name, ...tool.session };
    const call = mcpToolCall(base.callId, tool.mcpToolName, input);
    const cached = sessions.get(key, use);
    const first = cached
      ? await negotiateInSession(transport, call, { cache: sessions, key, use, cached })
      : await negotiateMcpRpc(transport, call);
    const negotiated = first.sessionRequired
      ? await negotiateInSession(transport, call, { cache: sessions, key, use })
      : first;
    const refused = yield* refusedCredentialOutcome(
      tool,
      negotiated.refusal,
      signedIn !== undefined,
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
      modelResult: withMedia(
        modelResultFromOutput(interpreted.data, tool.outputSchema),
        interpreted.parts,
      ),
      outputRaw: interpreted.data,
    };
  } catch (err) {
    handOff.rethrowClaimFailure();
    return yield* thrownOutcome(err, checks);
  } finally {
    checks.record();
  }
}
