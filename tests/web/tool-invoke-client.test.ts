import { assertEquals } from '@std/assert';
import {
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  type InterfaceTurnSession,
  interfaceFromProfile,
} from '../../src/interface/mod.ts';
import { registerTools } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import {
  resumeForAnswer,
  sessionPermissionsAfterApproval,
} from '../../src/kernel/tools/gate-answer.ts';
import { checkPermission } from '../../src/kernel/tools/permission.ts';
import type { ToolGate } from '../../src/kernel/tools/types.ts';
import type { ModelBinding } from '../../src/kernel/types.ts';
import { GOOGLE_BUILTIN_TOOLS } from '../../studio/cookbooks/providers.ts';
import { filesToPending } from '../../web/src/client/encode-files.ts';
import { continueGatedToolInvocation } from '../../web/src/client/tool-resume.ts';
import {
  theoremInvokeRequestSchema,
  theoremTurnRequestSchema,
} from '../../web/src/client/transport.ts';
import { buildInvokeRequest, buildTurnRequest } from '../../web/src/client/turn-client.ts';
import { CHAT_MEDIA_LIMITS, HOST_BINDINGS } from '../fixtures/models.ts';
import { checkpointFixture } from '../fixtures/provider-checkpoint.ts';

registerTools(GOOGLE_BUILTIN_TOOLS);
const DELETE_GATE: ToolGate = {
  kind: 'permission',
  tool: 'delete_resource',
  permission: 'session_consent',
};
function session(patch: Partial<InterfaceTurnSession> = {}): InterfaceTurnSession {
  return { ...emptyInterfaceTurnSession(), ...patch };
}
function textInterface(
  id: string,
  models: Record<string, ModelBinding>,
  extra: {
    allowModelSelect?: boolean;
    defaultModel?: string;
  } = {},
): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id,
      type: 'text',
      identity: { handle: 'invoke_bot', system: 'You reply.' },
      models,
      ...extra,
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
    defaultKernelScope.tools,
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  return iface;
}
const fast = HOST_BINDINGS.gemini35FlashLite;
const smart = HOST_BINDINGS.gemini31ProPreview;
Deno.test('approving a session_consent tool grants it for the session, once', () => {
  const once = sessionPermissionsAfterApproval([], 'delete_resource', 'session_consent');
  assertEquals(once, ['delete_resource']);
  assertEquals(checkPermission('delete_resource', 'session_consent', once), null);
  assertEquals(sessionPermissionsAfterApproval(once, 'delete_resource', 'session_consent'), [
    'delete_resource',
  ]);
});
Deno.test('approving any other gate grants this call only', () => {
  const existing = ['search'];
  for (const permission of [undefined, 'auto', 'always_confirm'] as const) {
    assertEquals(sessionPermissionsAfterApproval(existing, 'delete_resource', permission), [
      'search',
    ]);
  }
});
Deno.test('an approved always_confirm tool still gates on its next call', () => {
  const after = sessionPermissionsAfterApproval([], 'wire_money', 'always_confirm');
  assertEquals(checkPermission('wire_money', 'always_confirm', after)?.kind, 'permission');
  assertEquals(
    checkPermission(
      'wire_money',
      'always_confirm',
      after,
      resumeForAnswer({ decision: 'approve' }),
    ),
    null,
  );
});
Deno.test('session grants never touch other tools, add a wildcard or mutate the input', () => {
  const existing = Object.freeze(['search']) as readonly string[];
  const next = sessionPermissionsAfterApproval(existing, 'delete_resource', 'session_consent');
  assertEquals(next, ['search', 'delete_resource']);
  assertEquals(existing, ['search']);
  assertEquals(next.includes('*'), false);
});
Deno.test('continueGatedToolInvocation denies without new permissions', () => {
  assertEquals(
    continueGatedToolInvocation({
      toolName: 'delete_resource',
      gate: DELETE_GATE,
      sessionPermissions: ['search'],
      resolution: { action: 'deny' },
    }),
    { decision: 'deny' },
  );
});
Deno.test('continueGatedToolInvocation approves a sign-in with the typed secret, once', () => {
  assertEquals(
    continueGatedToolInvocation({
      toolName: 'fetch_report',
      gate: {},
      sessionPermissions: [],
      resolution: { action: 'auth', secret: 't0k' },
    }),
    { decision: 'approve', secret: 't0k', sessionPermissions: [] },
  );
  // After an OAuth callback there is nothing to send: the server holds the token.
  assertEquals(
    continueGatedToolInvocation({
      toolName: 'fetch_report',
      gate: {},
      sessionPermissions: [],
      resolution: { action: 'auth' },
    }),
    { decision: 'approve', sessionPermissions: [] },
  );
});
Deno.test('continueGatedToolInvocation approves with the permissions the host will hold', () => {
  assertEquals(
    continueGatedToolInvocation({
      toolName: 'delete_resource',
      gate: DELETE_GATE,
      sessionPermissions: ['search'],
      resolution: { action: 'allow' },
    }),
    { decision: 'approve', sessionPermissions: ['search', 'delete_resource'] },
  );
  for (const gate of [{ permission: 'always_confirm' }, {}] as const) {
    assertEquals(
      continueGatedToolInvocation({
        toolName: 'send_email',
        gate,
        sessionPermissions: ['search'],
        resolution: { action: 'allow' },
      }),
      { decision: 'approve', sessionPermissions: ['search'] },
    );
  }
});
Deno.test('buildTurnRequest sends the message, its scope, and session permissions, never the conversation', () => {
  const iface = textInterface('react.invoke.turn', { fast });
  const body = buildTurnRequest(
    iface,
    session({
      history: [{ role: 'user', content: 'earlier' }],
      providerState: checkpointFixture,
      sessionPermissions: ['search'],
    }),
    { text: 'hello' },
    { conversation: 'ref-1', turnId: 't1' },
  );
  assertEquals('providerState' in body, false);
  assertEquals(body.conversation, 'ref-1');
  assertEquals(body.turnId, 't1');
  assertEquals(body.replay, { sessionPermissions: ['search'] });
  assertEquals(body.input, { text: 'hello' });
});
Deno.test('buildTurnRequest forwards the selected model; a locked profile is sent only a pick off its default, which it refuses', () => {
  const models = { fast, smart };
  const locked = textInterface('react.invoke.locked', models, { defaultModel: 'fast' });
  assertEquals(buildTurnRequest(locked, session({ selectedModel: 'smart' }), {}).model, 'smart');
  assertEquals(buildTurnRequest(locked, session({ selectedModel: 'fast' }), {}).model, undefined);
  const selectable = textInterface('react.invoke.select', models, {
    allowModelSelect: true,
    defaultModel: 'fast',
  });
  assertEquals(
    buildTurnRequest(selectable, session({ selectedModel: 'smart' }), {}).model,
    'smart',
  );
  assertEquals(buildTurnRequest(selectable, session(), {}).model, 'fast');
});
Deno.test('buildTurnRequest forwards effort; a model without effort select is sent only a pick off its default, which it refuses', () => {
  const iface = textInterface(
    'react.invoke.effort',
    {
      fast,
      fixed: { ...fast, allowEffortSelect: false },
    },
    { allowModelSelect: true, defaultModel: 'fast' },
  );
  assertEquals(
    buildTurnRequest(iface, session({ selectedModel: 'fast', selectedEffort: 'high' }), {}).effort,
    'high',
  );
  assertEquals(buildTurnRequest(iface, session({ selectedModel: 'fast' }), {}).effort, 'normal');
  assertEquals(
    buildTurnRequest(iface, session({ selectedModel: 'fixed', selectedEffort: 'high' }), {}).effort,
    'high',
  );
  assertEquals(
    buildTurnRequest(iface, session({ selectedModel: 'fixed', selectedEffort: 'normal' }), {})
      .effort,
    undefined,
  );
});
Deno.test('buildInvokeRequest replays the snapshot, promoted tools, and selected model', () => {
  const iface = textInterface(
    'react.invoke.replay',
    { fast, smart },
    {
      allowModelSelect: true,
      defaultModel: 'fast',
    },
  );
  const snapshot = {
    builtins: [],
    wire: [],
    gated: ['search'],
    visible: ['search'],
    executable: ['search'],
  };
  const body = buildInvokeRequest(
    iface,
    session({
      selectedModel: 'smart',
      sessionPermissions: ['search'],
      promotedToolIds: ['search', 'book'],
      toolSnapshot: snapshot,
      inputTokens: 5,
    }),
    {
      gateId: 'call-1',
      operationId: 'call-1',
      decision: 'approve',
      name: 'search',
      input: { q: 'hotels' },
    },
  );
  assertEquals(body.gateId, 'call-1');
  assertEquals(body.decision, 'approve');
  assertEquals('secret' in body, false);
  assertEquals(body.replay?.name, 'search');
  assertEquals(body.replay?.input, { q: 'hotels' });
  assertEquals(body.replay?.snapshot, snapshot);
  assertEquals(body.replay?.promoted, ['search', 'book']);
  assertEquals(body.replay?.model, 'smart');
  assertEquals(body.replay?.sessionPermissions, ['search']);
  // The host keeps the conversation: the history and its meters never ride along.
  assertEquals('turnInput' in (body.replay ?? {}), false);
});
Deno.test('buildInvokeRequest prefers explicit permissions and omits empty replay fields', () => {
  const iface = textInterface('react.invoke.explicit', { fast });
  const body = buildInvokeRequest(iface, session({ sessionPermissions: ['search'] }), {
    gateId: 'call-2',
    operationId: 'call-2',
    decision: 'approve',
    name: 'fetch_report',
    input: {},
    sessionPermissions: ['search', 'fetch_report'],
    secret: 't0k',
  });
  assertEquals(body.secret, 't0k');
  assertEquals(body.replay?.sessionPermissions, ['search', 'fetch_report']);
  assertEquals('snapshot' in (body.replay ?? {}), false);
  assertEquals('promoted' in (body.replay ?? {}), false);
  assertEquals('model' in (body.replay ?? {}), false);
});
Deno.test('filesToPending keeps name, size, and a fallback mime type', () => {
  assertEquals(
    filesToPending([
      new File(['abc'], 'a.png', { type: 'image/png' }),
      new File(['hello'], 'notes'),
    ]),
    [
      { name: 'a.png', mimeType: 'image/png', sizeBytes: 3 },
      { name: 'notes', mimeType: 'application/octet-stream', sizeBytes: 5 },
    ],
  );
});

Deno.test('operation identity is mandatory for browser approval and abandonment', () => {
  assertEquals(
    theoremInvokeRequestSchema.safeParse({ gateId: 'call', decision: 'approve' }).success,
    false,
  );
  assertEquals(
    theoremInvokeRequestSchema.safeParse({
      gateId: 'call',
      operationId: 'issued',
      decision: 'approve',
    }).success,
    true,
  );
  assertEquals(
    theoremTurnRequestSchema.safeParse({ input: { text: 'stop' }, abandon: ['call'] }).success,
    false,
  );
  assertEquals(
    theoremTurnRequestSchema.safeParse({
      input: { text: 'stop' },
      abandon: [{ callId: 'call', operationId: 'issued' }],
    }).success,
    true,
  );
});
