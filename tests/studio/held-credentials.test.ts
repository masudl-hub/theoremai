import { assertEquals, assertStringIncludes } from '@std/assert';
import { defaultKernelScope, registerTool, z } from '../../mod.ts';
import { MASK } from '../../src/surface/mod.ts';
import { compileWorkspace } from '../../studio/compile-workspace.ts';
import type { ToolSpecDraft } from '../../studio/draft.ts';
import { shownConnection, unheld } from '../../studio/held-credentials.ts';
import { type ProjectEdits, registerEdits } from '../../studio/server/edits.ts';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { projectNames, providerSettings, saveSubjects } from '../../studio/server/save.ts';
import { applyEdits, planSave } from '../../studio/server/save-plan.ts';
import { type StudioWorkspace, setToolAllowed, withProvider } from '../../studio/workspace.ts';

const ENDPOINT = 'https://gardener:trowel@soil.example/v1/{bed}/read?api_key=soil-key-1&unit=ph';
const HEADERS = { Authorization: 'Bearer soil-token-1', 'X-Tenant': 'garden' };
const SHOWN = 'https://••••:••••@soil.example/v1/{bed}/read?api_key=••••&unit=ph';

/** The example with one tool that carries credentials in its URL and its headers. */
function register(): void {
  registerExample();
  registerTool({
    type: 'http',
    name: 'read_soil',
    description: 'Reads the soil of a bed.',
    category: 'plants',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    endpoint: ENDPOINT,
    method: 'GET',
    headers: HEADERS,
    mapping: { pathParams: ['bed'] },
    input: z.object({ bed: z.string() }),
    output: z.object({ ph: z.number() }),
  });
}

async function described(): Promise<StudioDescription> {
  const handler = createStudioHandler({
    project: 'garden',
    pageOrigins: ['http://localhost:5174'],
    listenHost: '127.0.0.1:4983',
  });
  const answer = await handler(
    new Request('http://127.0.0.1:4983/api/studio', { headers: { host: '127.0.0.1:4983' } }),
  );
  return answer.json();
}

register();
const opened = await described();

/** The opened workspace with `read_soil` allowed and changed by `change`. */
function edited(change: (tool: ToolSpecDraft) => ToolSpecDraft = (tool) => tool): StudioWorkspace {
  const { workspace } = opened;
  const [agent] = workspace.agents;
  const soil = workspace.toolSpecs.find((tool) => tool.toolName === 'read_soil');
  if (!agent || !soil) throw new Error('The example changed.');
  const allowed = setToolAllowed(workspace, agent.key, soil.key, true);
  return {
    ...allowed,
    toolSpecs: allowed.toolSpecs.map((tool) => (tool.key === soil.key ? change(tool) : tool)),
  };
}

/** What Save and an edited run read from a workspace the page sent. */
function subjectsOf(workspace: StudioWorkspace): ReturnType<typeof saveSubjects> {
  // The start has the tool allowed too: only the tool's own change is the edit.
  const agents = Object.fromEntries(edited().agents.map((agent) => [agent.key, agent]));
  return saveSubjects(
    { ...workspace, starts: { ...workspace.starts, agents } },
    projectNames(opened.workspace),
  );
}

function edits(workspace: StudioWorkspace): ProjectEdits {
  const subjects = subjectsOf(workspace);
  if (!subjects.ok) throw new Error(subjects.issues.join('\n'));
  return { subjects: subjects.subjects, added: subjects.added };
}

/** `read_soil` as the kernel holds it after the edits are laid over a fresh load. */
async function ran(
  workspace: StudioWorkspace,
): Promise<{ endpoint?: string; headers?: Record<string, string> }> {
  register();
  await registerEdits(defaultKernelScope, edits(workspace));
  return defaultKernelScope.tools.get('read_soil') as {
    endpoint?: string;
    headers?: Record<string, string>;
  };
}

Deno.test('the page gets a tool with the credentials in its URL and headers masked', () => {
  const soil = opened.workspace.toolSpecs.find((tool) => tool.toolName === 'read_soil');
  assertEquals(soil?.endpoint, SHOWN);
  assertEquals(JSON.parse(soil?.headersJson ?? ''), {
    Authorization: '••••',
    'X-Tenant': 'garden',
  });
  const sent = JSON.stringify(opened);
  for (const secret of ['trowel', 'gardener', 'soil-key-1', 'soil-token-1']) {
    assertEquals(sent.includes(secret), false);
  }
});

Deno.test("a tool whose credential header is the project's own compiles, masked as the page holds it", () => {
  const result = compileWorkspace(edited(), 'byok');
  assertEquals(result.ok, true);
  const typed = compileWorkspace(
    edited((tool) => ({ ...tool, headersJson: '{"Authorization":"Bearer typed"}' })),
    'byok',
  );
  assertEquals(typed.ok, false);
});

Deno.test("an edit beside a masked credential runs with the project's own value", async () => {
  const described = await ran(edited((tool) => ({ ...tool, description: 'Reads one bed.' })));
  assertEquals([described.endpoint, described.headers], [ENDPOINT, HEADERS]);

  const header = await ran(
    edited((tool) => ({
      ...tool,
      headersJson: '{"Authorization":"••••","X-Tenant":"orchard","X-Row":"3"}',
    })),
  );
  assertEquals(header.headers, {
    Authorization: 'Bearer soil-token-1',
    'X-Tenant': 'orchard',
    'X-Row': '3',
  });
  assertEquals(header.endpoint, ENDPOINT);

  const url = await ran(
    edited((tool) => ({
      ...tool,
      endpoint: SHOWN.replace('/read', '/probe').replace('unit=ph', 'unit=ec'),
    })),
  );
  assertEquals(url.endpoint, ENDPOINT.replace('/read', '/probe').replace('unit=ph', 'unit=ec'));
  assertEquals(url.headers, HEADERS);
});

Deno.test('a mask the project gave no value for is refused, by name', () => {
  const renamed = subjectsOf(
    edited((tool) => ({ ...tool, headersJson: '{"X-Api-Key":"••••","X-Tenant":"garden"}' })),
  );
  assertEquals(renamed.ok, false);
  assertStringIncludes(
    renamed.ok ? '' : (renamed.issues[0] ?? ''),
    'read_soil: the studio has no value for X-Api-Key.',
  );

  const url = subjectsOf(edited((tool) => ({ ...tool, endpoint: `${SHOWN}&token=••••` })));
  assertEquals(url.ok, false);
  assertStringIncludes(url.ok ? '' : (url.issues[0] ?? ''), 'its endpoint URL');

  assertEquals(unheld({ endpoint: SHOWN, headers: { Authorization: '••••' } }), [
    'its endpoint URL',
    'Authorization',
  ]);
  assertEquals(
    unheld(
      { endpoint: SHOWN, headers: { Authorization: '••••' } },
      { endpoint: SHOWN, headers: { Authorization: '••••' } },
    ),
    [],
  );
});

const FILE = `import { registerTool, z } from '@theoremjs/agents';

registerTool({
  type: 'http',
  name: 'read_soil',
  description: 'Reads the soil of a bed.',
  endpoint: '${ENDPOINT}',
  method: 'GET',
  headers: { Authorization: 'Bearer soil-token-1', 'X-Tenant': 'garden' },
  input: z.object({ bed: z.string() }),
  output: z.object({ ph: z.number() }),
});
`;

Deno.test("Save writes an edit beside a masked credential with the file's own value, never the mask", () => {
  const source = readProjectSource('/project/setup.ts', '/project', (path) =>
    path === '/project/setup.ts' ? FILE : undefined,
  );
  const before = {
    type: 'http',
    name: 'read_soil',
    endpoint: SHOWN,
    headers: { Authorization: '••••', 'X-Tenant': 'garden' },
  };
  const after = {
    ...before,
    endpoint: SHOWN.replace('/read', '/probe'),
    headers: { Authorization: '••••', 'X-Tenant': 'orchard' },
  };
  const plan = planSave(source, [{ kind: 'tool', of: 'read_soil', before, after }]);
  assertEquals(plan.changes.map((change) => `${change.setting}: ${change.status}`).sort(), [
    'endpoint: written',
    'headers.X-Tenant: written',
  ]);
  const text = applyEdits(FILE, plan.edits);
  assertEquals(text, FILE.replace('/read', '/probe').replace("'garden'", "'orchard'"));
  assertEquals(text.includes('••••'), false);
});

Deno.test('a provider connection is told with its credentials masked, and only what is text', () => {
  assertEquals(
    shownConnection({ baseURL: 'https://user:secret@models.example/v1?api_key=abc', retries: 3 }),
    { baseURL: `https://${MASK}:${MASK}@models.example/v1?api_key=${MASK}` },
  );
  assertEquals(shownConnection({ siteName: 'Desk' }), { siteName: 'Desk' });
});

Deno.test('a provider defined with nothing has no connection to tell', () => {
  assertEquals(shownConnection({}), undefined);
  assertEquals(shownConnection(undefined), undefined);
  assertEquals(shownConnection('https://models.example'), undefined);
});

Deno.test('a provider the builder changed is a Save subject over what its definition holds, and a mask is refused', () => {
  const { workspace } = opened;
  const [provider] = workspace.providers;
  if (!provider) throw new Error('The example changed.');
  const names = projectNames(workspace);
  const untouched = saveSubjects(workspace, names);
  assertEquals(untouched.ok && untouched.subjects.filter((each) => each.kind === 'provider'), []);

  const changed = saveSubjects(withProvider(workspace, { ...provider, keySlot: 'team' }), names);
  const settings = providerSettings(provider);
  assertEquals(changed.ok && changed.subjects.filter((each) => each.kind === 'provider'), [
    {
      kind: 'provider',
      of: provider.id,
      before: settings,
      after: { ...settings, keySlot: 'team' },
    },
  ]);
  assertEquals('id' in settings || 'adapter' in settings, false);

  const masked = saveSubjects(
    withProvider(workspace, {
      ...provider,
      connection: { baseURL: `https://${MASK}@house.example/v1` },
    }),
    names,
  );
  if (masked.ok) throw new Error('A mask in a provider was let through.');
  assertStringIncludes(
    masked.issues.join('\n'),
    `${provider.id}: the studio has no value for baseURL`,
  );
});
