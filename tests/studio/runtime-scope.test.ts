import '../fixtures/test-host.ts';
import { assert, assertEquals } from '@std/assert';
import { compileStudio, createExampleDraft } from '../../studio/mod.ts';
import {
  STUDIO_TAINT_NOTE,
  type StudioRuntime,
  studioNetworkNote,
  studioScope,
} from '../../studio/runtime-scope.ts';

function afterRemoteRead(guardrails: object | undefined): unknown {
  return guardrails && 'taint' in guardrails
    ? (guardrails.taint as { afterRemoteRead?: string } | undefined)?.afterRemoteRead
    : undefined;
}

async function runOn(runtime: StudioRuntime) {
  const draft = createExampleDraft();
  draft.guardrails.allowPrivateNetworks = true;
  const compiled = compileStudio(draft);
  assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
  const { profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    runtime,
  );
  return { guardrails: profile.guardrails, note: studioNetworkNote(runtime) };
}

Deno.test("the Network note says what the studio's runtime does with the rules", async () => {
  const demo = await runOn({ mode: 'demo' });
  assertEquals(demo.guardrails?.network, undefined);
  assertEquals(demo.note, 'Studio server: public hosts only.');

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

Deno.test('the Taint note says studio runs refuse destructive calls after a remote read', async () => {
  assertEquals(afterRemoteRead((await runOn({ mode: 'demo' })).guardrails), 'destructive');
  assert(STUDIO_TAINT_NOTE.includes('refuse destructive calls'));

  const draft = createExampleDraft();
  draft.guardrails.taintAfterRemoteRead = 'write';
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  const { profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    {
      mode: 'demo',
    },
  );
  assertEquals(afterRemoteRead(profile.guardrails), 'write');
  assert(STUDIO_TAINT_NOTE.includes('Stricter settings hold'));
});
