import { assertEquals } from '@std/assert';
import { filesToPending } from '../../react/src/client/encode-files.ts';
import {
  buildInvokeToolResume,
  continueGatedToolInvocation,
  sessionPermissionsAfterApproval,
} from '../../react/src/client/tool-resume.ts';
import {
  buildInvokeRequest,
  buildTurnRequest,
  turnInputFromSession,
} from '../../react/src/client/turn-client.ts';
import {
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  type InterfaceTurnSession,
  interfaceFromProfile,
} from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { checkPermission } from '../../src/kernel/tools/permission.ts';
import type { ToolGate } from '../../src/kernel/tools/types.ts';
import type { ModelBinding } from '../../src/kernel/types.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { CHAT_MEDIA_LIMITS, HOST_BINDINGS } from '../fixtures/models.ts';

registerGooglePreset();

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
  extra: { allowModelSelect?: boolean; defaultModel?: string } = {},
): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id,
      type: 'text',
      identity: { handle: 'invoke_bot', system: 'You reply.' },
      models,
      key: 'slotA',
      ...extra,
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  return iface;
}

const fast = HOST_BINDINGS.gemini35FlashLite;
const smart = HOST_BINDINGS.gemini31ProPreview;

// --- session permissions: the registrant's tier decides how long an approval lasts ---

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
    checkPermission('wire_money', 'always_confirm', after, buildInvokeToolResume()),
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

// --- gate resume ---

Deno.test('buildInvokeToolResume always resumes with granted: true', () => {
  for (const kind of [undefined, 'confirmation', 'permission', 'auth'] as const) {
    assertEquals(buildInvokeToolResume(kind), { granted: true });
  }
});

Deno.test('continueGatedToolInvocation denies without a resume or new permissions', () => {
  assertEquals(
    continueGatedToolInvocation({
      toolName: 'delete_resource',
      gate: DELETE_GATE,
      sessionPermissions: ['search'],
      resolution: { action: 'deny' },
    }),
    { kind: 'denied' },
  );
});

Deno.test('continueGatedToolInvocation passes auth credentials through without granting', () => {
  const credentials = { api: { type: 'bearer', token: 't0k' } } as const;
  assertEquals(
    continueGatedToolInvocation({
      toolName: 'fetch_report',
      gate: { kind: 'auth' },
      sessionPermissions: [],
      resolution: { action: 'auth', credentials },
    }),
    { kind: 'auth', credentials },
  );
});

Deno.test('continueGatedToolInvocation continues with the granted resume', () => {
  const sessionConsent = continueGatedToolInvocation({
    toolName: 'delete_resource',
    gate: DELETE_GATE,
    sessionPermissions: ['search'],
    resolution: { action: 'allow' },
  });
  assertEquals(sessionConsent, {
    kind: 'continue',
    sessionPermissions: ['search', 'delete_resource'],
    resume: { granted: true },
  });

  for (const gate of [
    { kind: 'permission', permission: 'always_confirm' },
    { kind: 'confirmation' },
  ] as const) {
    assertEquals(
      continueGatedToolInvocation({
        toolName: 'send_email',
        gate,
        sessionPermissions: ['search'],
        resolution: { action: 'allow' },
      }),
      { kind: 'continue', sessionPermissions: ['search'], resume: { granted: true } },
    );
  }
});

// --- turn and invoke requests ---

Deno.test('turnInputFromSession carries history and token counters', () => {
  const history = [{ role: 'user', content: 'hi' }] as InterfaceTurnSession['history'];
  assertEquals(
    turnInputFromSession(session({ history, inputTokens: 3, historyTokens: 12 }), {
      text: 'next',
    }),
    { text: 'next', history, inputTokens: 3, historyTokens: 12 },
  );
  assertEquals(turnInputFromSession(session()), { history: [] });
});

Deno.test('buildTurnRequest sends session permissions and the interaction id', () => {
  const iface = textInterface('react.invoke.turn', { fast });
  const body = buildTurnRequest(
    iface,
    session({ previousInteractionId: 'ix-1', sessionPermissions: ['search'] }),
    { text: 'hello' },
    { turnId: 't1' },
  );
  assertEquals(body.previousInteractionId, 'ix-1');
  assertEquals(body.turnId, 't1');
  assertEquals(body.replay, { sessionPermissions: ['search'] });
  assertEquals(body.input, { text: 'hello' });
});

Deno.test('buildTurnRequest forwards the selected model only with allowModelSelect', () => {
  const models = { fast, smart };
  const locked = textInterface('react.invoke.locked', models, { defaultModel: 'fast' });
  assertEquals(buildTurnRequest(locked, session({ selectedModel: 'smart' }), {}).model, undefined);

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

Deno.test('buildTurnRequest forwards effort only when the model allows effort select', () => {
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
    undefined,
  );
});

Deno.test('buildInvokeRequest replays the snapshot, promoted tools and selected model', () => {
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
    { gateId: 'call-1', name: 'search', input: { q: 'hotels' } },
  );
  assertEquals(body.gateId, 'call-1');
  assertEquals(body.credentials, undefined);
  assertEquals(body.replay?.name, 'search');
  assertEquals(body.replay?.input, { q: 'hotels' });
  assertEquals(body.replay?.snapshot, snapshot);
  assertEquals(body.replay?.promoted, ['search', 'book']);
  assertEquals(body.replay?.model, 'smart');
  assertEquals(body.replay?.sessionPermissions, ['search']);
  assertEquals(body.replay?.turnInput, { history: [], inputTokens: 5 });
});

Deno.test('buildInvokeRequest prefers explicit permissions and omits empty replay fields', () => {
  const iface = textInterface('react.invoke.explicit', { fast });
  const credentials = { api: { type: 'bearer', token: 't0k' } } as const;
  const body = buildInvokeRequest(iface, session({ sessionPermissions: ['search'] }), {
    gateId: 'call-2',
    name: 'fetch_report',
    input: {},
    resume: { granted: true },
    sessionPermissions: ['search', 'fetch_report'],
    credentials,
  });
  assertEquals(body.credentials, credentials);
  assertEquals(body.replay?.resume, { granted: true });
  assertEquals(body.replay?.sessionPermissions, ['search', 'fetch_report']);
  assertEquals('snapshot' in (body.replay ?? {}), false);
  assertEquals('promoted' in (body.replay ?? {}), false);
  assertEquals('model' in (body.replay ?? {}), false);
});

// --- files ---

Deno.test('filesToPending keeps name, size and a fallback mime type', () => {
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
