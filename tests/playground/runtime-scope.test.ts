import '../fixtures/test-host.ts';
import { assert, assertEquals } from '@std/assert';
import { compilePlayground, createExampleDraft } from '../../playground/mod.ts';
import {
  PLAYGROUND_TAINT_NOTE,
  type PlaygroundRuntime,
  playgroundNetworkNote,
  playgroundScope,
} from '../../playground/runtime-scope.ts';

function afterRemoteRead(guardrails: object | undefined): unknown {
  return guardrails && 'taint' in guardrails
    ? (guardrails.taint as { afterRemoteRead?: string } | undefined)?.afterRemoteRead
    : undefined;
}

async function runOn(runtime: PlaygroundRuntime) {
  const draft = createExampleDraft();
  draft.guardrails.allowPrivateNetworks = true;
  const compiled = compilePlayground(draft);
  assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
  const { profile } = await playgroundScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    runtime,
  );
  return { guardrails: profile.guardrails, note: playgroundNetworkNote(runtime) };
}

Deno.test("the Network note says what the playground's runtime does with the rules", async () => {
  const demo = await runOn({ mode: 'demo' });
  assertEquals(demo.guardrails?.network, undefined);
  assertEquals(demo.note, 'Playground server: public hosts only.');

  const browser = await runOn({ mode: 'byok' });
  assertEquals(browser.guardrails?.network?.allowPrivateNetworks, true);
  assertEquals(browser.note, 'Browser runs: rules as written.');

  const local = { baseUrl: 'http://127.0.0.1:11434' };
  const offline = await runOn({ mode: 'byok', providers: { local }, remoteTools: false });
  assertEquals(offline.guardrails?.network, { allowedSchemes: [] });
  assertEquals(offline.note, 'Remote tools off: no host reached.');

  const online = await runOn({ mode: 'byok', providers: { local }, remoteTools: true });
  assertEquals(online.guardrails?.network?.allowPrivateNetworks, true);
  assertEquals(online.note, browser.note);
});

Deno.test('the Taint note says playground runs refuse destructive calls after a remote read', async () => {
  assertEquals(afterRemoteRead((await runOn({ mode: 'demo' })).guardrails), 'destructive');
  assert(PLAYGROUND_TAINT_NOTE.includes('refuse destructive calls'));

  const draft = createExampleDraft();
  draft.guardrails.taintAfterRemoteRead = 'write';
  const compiled = compilePlayground(draft);
  assert(compiled.ok);
  const { profile } = await playgroundScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    {
      mode: 'demo',
    },
  );
  assertEquals(afterRemoteRead(profile.guardrails), 'write');
  assert(PLAYGROUND_TAINT_NOTE.includes('Stricter settings hold'));
});
