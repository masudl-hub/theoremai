import { assert, assertEquals, assertMatch, assertNotMatch } from '@std/assert';
import ts from 'typescript';
import {
  addAgent,
  agentDraft,
  type CompiledWorkspace,
  compileWorkspace,
  createBlankDraft,
  createExampleDraft,
  createSpanExampleDraft,
  defaultToolSpec,
  type StudioWorkspace,
  setProfileType,
  withAgentDraft,
  workspaceFromDraft,
} from '../mod.ts';
import { exportFiles, exportText, llmBrief } from '../ui/lib/export-agent.ts';
import { zipFiles } from '../ui/lib/zip.ts';

/** The concierge, calling a helper through an agent tool. */
function conciergeAndHelper(): StudioWorkspace {
  const blank = setProfileType(createBlankDraft(), 'text');
  const helper = {
    ...blank,
    identity: { ...blank.identity, agentId: 'travel.helper', handle: 'helper' },
  };
  const workspace = addAgent(workspaceFromDraft(createExampleDraft()), helper);
  const [concierge, added] = workspace.agents;
  assert(concierge && added);
  const draft = agentDraft(workspace, concierge.key);
  assert(draft);
  const tool = defaultToolSpec({
    toolName: 'ask_helper',
    toolType: 'agent',
    description: 'Asks the helper.',
    agentKey: added.key,
  });
  return withAgentDraft(workspace, concierge.key, {
    ...draft,
    toolSpecs: [...draft.toolSpecs, tool],
  });
}

function compiled(workspace: StudioWorkspace): CompiledWorkspace {
  const result = compileWorkspace(workspace);
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  return result;
}

function agent(workspace: CompiledWorkspace, id: string) {
  const found = workspace.agents.find((each) => each.agentId === id);
  assert(found);
  return found;
}

Deno.test('an export is every agent, then the route and chat for the one being chatted with', () => {
  const workspace = compiled(conciergeAndHelper());
  const files = exportFiles(workspace, agent(workspace, 'travel.concierge'));
  assertEquals(
    files.map((file) => file.path),
    [
      'README.md',
      'tools.ts',
      'agents/travel.helper.ts',
      'agents/travel.concierge.ts',
      'theorem.ts',
      'route.ts',
      'AgentChat.tsx',
    ],
  );
  const route = files.find((file) => file.path === 'route.ts')?.code ?? '';
  assertMatch(route, /import '\.\/theorem';/);
  assertMatch(route, /import \{ profile \} from '\.\/agents\/travel\.concierge';/);
  assertMatch(route, /createTheoremHandler\(\{/);
  assertMatch(route, /THEOREM_VAULT_SLOT_A/);
  assertMatch(exportText(files), /\/\/ ─── agents\/travel\.helper\.ts ───/);
  assertMatch(llmBrief(workspace, agent(workspace, 'travel.concierge')), /`travel\.helper`/);
});

Deno.test('a decision exports its questions with its profile, and a decision route', () => {
  const workspace = compiled(workspaceFromDraft(createSpanExampleDraft()));
  const [span] = workspace.agents;
  assert(span);
  const files = exportFiles(workspace, span);
  assertEquals(files.map((file) => file.path).slice(-2), ['route.ts', 'AgentDecision.tsx']);
  const route = files.find((file) => file.path === 'route.ts')?.code ?? '';
  assertMatch(route, /import \{ profile, questions \} from/);
  assertMatch(route, /createTheoremDecisionHandler/);
  const module = files.find((file) => file.path.startsWith('agents/'))?.code ?? '';
  assertMatch(module, /export const questions = /);
});

Deno.test('the zip holds every file', () => {
  const workspace = compiled(conciergeAndHelper());
  const files = exportFiles(workspace, agent(workspace, 'travel.concierge'));
  const zip = zipFiles(files);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record: its signature, then the entry count at byte 10.
  assertEquals(view.getUint32(zip.length - 22, true), 0x06054b50);
  assertEquals(view.getUint16(zip.length - 12, true), files.length);
});

Deno.test('an exported chat passes a value per slot and its context, and the route its server context', () => {
  const blank = setProfileType(createBlankDraft(), 'text');
  const draft = {
    ...blank,
    identity: { ...blank.identity, agentId: 'travel.guide', handle: 'guide' },
    inputs: {
      ...blank.inputs,
      slotsJson: '{"language":["en","fr"]}',
      contextFrom: ['client' as const, 'server' as const],
      contextMaxChars: 2000,
    },
  };
  const workspace = compiled(workspaceFromDraft(draft));
  const [only] = workspace.agents;
  assert(only);
  const files = exportFiles(workspace, only);
  const chat = files.find((file) => file.path === 'AgentChat.tsx')?.code ?? '';
  assertMatch(chat, /\/\/ language: en \| fr\n\s+slots=\{\{ "language": "en" \}\}/);
  assertMatch(chat, /context=\{\{\}\}/);
  assertMatch(
    files.find((file) => file.path === 'route.ts')?.code ?? '',
    /context: \(\) => \(\{\}\),/,
  );
});

Deno.test('a local export configures the registered adapter URL and keeps host options to the vault', () => {
  const draft = setProfileType(createBlankDraft(), 'text');
  draft.identity.agentId = 'local.test';
  draft.identity.handle = 'Local';
  draft.modelBindings[0].provider = 'local';
  draft.modelBindings[0].protocol = 'openAi';
  draft.modelBindings[0].apiId = 'local-model';
  const workspace = compileWorkspace(workspaceFromDraft(draft), 'local');
  assert(workspace.ok, JSON.stringify(!workspace.ok && workspace.issues));
  const files = exportFiles(workspace, workspace.agents[0]);
  const registration = files.find((file) => file.path === 'theorem.ts')?.code ?? '';
  assertMatch(registration, /LOCAL_MODEL_URL/);
  assertMatch(registration, /openAIChat/);
  assert(registration.includes("replace(/\\/$/, '') + '/v1'"));
  const route = files.find((file) => file.path === 'route.ts')?.code ?? '';
  assertNotMatch(route, /local: \{ baseUrl/);
  const emitted = ts.transpileModule(registration, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  assertEquals(emitted.diagnostics, []);
});
