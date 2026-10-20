import { assert, assertEquals, assertMatch, assertNotMatch } from '@std/assert';
import ts from 'typescript';
import { TEST_KEYS } from '../../tests/fixtures/lent-keys.ts';
import { ON_OWN_KEYS } from '../lent-keys.ts';
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
import { definitionFactory } from '../providers.ts';
import { exportFiles, exportText, llmBrief } from '../ui/lib/export-agent.ts';
import { zipFiles } from '../ui/lib/zip.ts';

/** The concierge, calling a helper through an agent tool. */
function conciergeAndHelper(): StudioWorkspace {
  const blank = setProfileType(createBlankDraft(), 'text', TEST_KEYS);
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
  const result = compileWorkspace(workspace, ON_OWN_KEYS);
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

Deno.test('an embedding exports an embedding route and its inputs-and-vectors component, not a chat', () => {
  const workspace = compiled(workspaceFromDraft(createSpanExampleDraft()));
  const [span] = workspace.agents;
  assert(span);
  const embedder = {
    ...span,
    agentId: 'docs.embeddings',
    questions: undefined,
    profile: {
      id: 'docs.embeddings',
      type: 'embedding' as const,
      identity: { handle: 'Docs embeddings' },
      inputs: { text: true },
      models: {
        gemma: { protocol: 'ollamaEmbedding', provider: 'local', apiId: 'embeddinggemma' },
      },
    },
  };
  const only = { ...workspace, agents: [embedder] };
  const files = exportFiles(only, embedder);
  assertEquals(files.map((file) => file.path).slice(-2), ['route.ts', 'AgentEmbedding.tsx']);
  const route = files.find((file) => file.path === 'route.ts')?.code ?? '';
  assertMatch(route, /createTheoremEmbeddingHandler\(\{/);
  assertMatch(route, /import \{ profile \} from/);
  const ui = files.find((file) => file.path === 'AgentEmbedding.tsx')?.code ?? '';
  assertMatch(ui, /<TheoremEmbedding endpoint="\/api\/embedding" \/>/);
  const brief = llmBrief(only, embedder);
  assertMatch(brief, /runEmbedding/);
  assertNotMatch(brief, /TheoremChat|useTheoremChat/);
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
  const blank = setProfileType(createBlankDraft(), 'text', TEST_KEYS);
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

Deno.test('a local export registers the local provider at the configured URL and keeps host options to the vault', () => {
  const draft = setProfileType(createBlankDraft(), 'text', TEST_KEYS);
  draft.identity.agentId = 'local.test';
  draft.identity.handle = 'Local';
  draft.modelBindings[0].protocol = 'openAi';
  draft.modelBindings[0].provider = 'local';
  draft.modelBindings[0].apiId = 'local-model';
  const workspace = compileWorkspace(workspaceFromDraft(draft), { mode: 'local' });
  assert(workspace.ok, JSON.stringify(!workspace.ok && workspace.issues));
  const files = exportFiles(workspace, workspace.agents[0]);
  const registration = files.find((file) => file.path === 'theorem.ts')?.code ?? '';
  assertMatch(registration, /import \{[^}]*\blocalProvider\b[^}]*\} from '@theoremjs\/agents';/);
  assert(
    registration.includes(
      "registerProvider(localProvider, {\n  id: 'local',\n  connection: { baseUrl: (process.env.LOCAL_MODEL_URL ?? 'http://127.0.0.1:11434').replace(/\\/$/, '') + '/v1' },\n});\n",
    ),
    registration,
  );
  const route = files.find((file) => file.path === 'route.ts')?.code ?? '';
  assertNotMatch(route, /local: \{ baseUrl/);
  const emitted = ts.transpileModule(registration, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  assertEquals(emitted.diagnostics, []);
});

Deno.test('on a project, an export imports the providers its files export and names the ones they do not', () => {
  const workspace = compiled(conciergeAndHelper());
  const [id] = new Set(
    workspace.agents.flatMap((each) =>
      each.profile.type === 'host'
        ? []
        : Object.values(each.profile.models).map((model) => model.provider),
    ),
  );
  assert(id);
  const factory = definitionFactory(id);
  assert(factory, id);
  const written = `registerProvider(${factory}, {\n  id: '${id}'`;
  const place = { id, name: 'houseProvider', file: 'server/providers.ts', line: 12 };
  const setup = (project: Parameters<typeof exportFiles>[2]) => {
    const file = exportFiles(workspace, agent(workspace, 'travel.concierge'), project).find(
      (each) => each.path === 'theorem.ts',
    );
    assert(file);
    return file.code;
  };
  const imported = setup({ providers: [{ ...place, exported: true }], origins: {} });
  assertMatch(imported, /import \{ houseProvider \} from '\.\/server\/providers';/);
  assertMatch(imported, /registerProvider\(houseProvider\);/);
  assert(!imported.includes(written));
  const named = setup({ providers: [place], origins: {} });
  assertMatch(
    named,
    /\/\/ Register the provider '[^']+' here, before the agents: server\/providers\.ts:12 defines it/,
  );
  assertNotMatch(named, /houseProvider/);
  // A provider the builder changed has no place: the code writes it as the studio holds it.
  assert(setup({ providers: [], origins: {} }).includes(written));
});

Deno.test('an export writes the check of an item rule as the files write it, and says so when it has none', () => {
  const start = conciergeAndHelper();
  const [concierge] = start.agents;
  assert(concierge);
  const draft = agentDraft(start, concierge.key);
  assert(draft);
  const workspace = compiled(
    withAgentDraft(start, concierge.key, {
      ...draft,
      outputs: {
        ...draft.outputs,
        mode: 'structured',
        schemaId: 'trip_plan',
        schemaJson: JSON.stringify({
          type: 'object',
          properties: { stops: { type: 'array', items: { type: 'string' } } },
          required: ['stops'],
        }),
        validationEnabled: true,
        itemRules: { stops: 'fix' },
      },
    }),
  );
  const module = (project: Parameters<typeof exportFiles>[2]) => {
    const file = exportFiles(workspace, agent(workspace, 'travel.concierge'), project).find(
      (each) => each.path === 'agents/travel.concierge.ts',
    );
    assert(file);
    return file.code;
  };
  const origin = {
    path: ['outputs', 'validation', 'items', 'stops', 'check'],
    kind: 'code' as const,
    text: 'checkStop',
    file: 'server/concierge.ts',
    line: 40,
  };
  assertMatch(
    module({ providers: [], origins: { 'travel.concierge': [origin] } }),
    /check: checkStop \/\* server\/concierge\.ts:40 \*\/,\n\s+onFail: 'fix',/,
  );
  assertMatch(
    module(undefined),
    /check: undefined \/\* The check of each item of 'stops' is your own code: name it here\. \*\//,
  );
});
