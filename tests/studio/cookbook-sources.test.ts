import { assertEquals } from '@std/assert';
import { createToolRegistry } from '../../src/kernel/tools/registry.ts';
import { cookbookToolSources } from '../../studio/cookbooks/sources.ts';
import type { HttpToolRegistration } from '../../studio/registrations.ts';
import { registerCustomTool } from '../../studio/tools.ts';

const GITHUB = cookbookToolSources('search_github');
const MODELS = cookbookToolSources('search_models');
const DATASETS = cookbookToolSources('search_datasets');
const ARXIV = cookbookToolSources('list_arxiv');
const PAGES = cookbookToolSources('read_pages');

Deno.test('research search tools cite Hub, GitHub, and arXiv rows', () => {
  assertEquals(
    GITHUB?.({
      items: [
        { full_name: 'letta-ai/letta', html_url: 'https://github.com/letta-ai/letta' },
        { full_name: 'mem0ai/mem0', html_url: 'https://github.com/mem0ai/mem0' },
      ],
    }),
    [
      { title: 'letta-ai/letta', uri: 'https://github.com/letta-ai/letta', type: 'web' },
      { title: 'mem0ai/mem0', uri: 'https://github.com/mem0ai/mem0', type: 'web' },
    ],
  );
  assertEquals(MODELS?.([{ id: 'sentence-transformers/all-MiniLM-L6-v2' }]), [
    {
      title: 'sentence-transformers/all-MiniLM-L6-v2',
      uri: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2',
      type: 'web',
    },
  ]);
  assertEquals(DATASETS?.([{ id: 'THUDM/LongBench' }]), [
    {
      title: 'THUDM/LongBench',
      uri: 'https://huggingface.co/datasets/THUDM/LongBench',
      type: 'web',
    },
  ]);
  assertEquals(
    ARXIV?.(
      '<feed><entry><id>http://arxiv.org/abs/2310.08560v1</id><title>MemGPT: Towards LLMs as Operating Systems</title></entry></feed>',
    ),
    [
      {
        title: 'MemGPT: Towards LLMs as Operating Systems',
        uri: 'http://arxiv.org/abs/2310.08560v1',
        type: 'web',
      },
    ],
  );
});

Deno.test('page and card tools cite http(s) links and skip other schemes', () => {
  assertEquals(PAGES?.('See [mem0](https://github.com/mem0ai/mem0) and javascript:alert(1).'), [
    { title: 'mem0', uri: 'https://github.com/mem0ai/mem0', type: 'web' },
  ]);
  assertEquals(cookbookToolSources('geocode_city'), undefined);
});

Deno.test('registerCustomTool attaches the cookbook sources hook', () => {
  const tools = createToolRegistry();
  const spec: HttpToolRegistration = {
    type: 'http',
    name: 'search_github',
    description: 'Search GitHub',
    category: 'research',
    access: 'read-only',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    endpoint: 'https://api.github.com/search/repositories',
    method: 'GET',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  };
  registerCustomTool(tools, spec);
  const tool = tools.require('search_github');
  assertEquals(tool.type, 'http');
  if (tool.type !== 'http') return;
  assertEquals(typeof tool.sources, 'function');
  assertEquals(tool.sources?.({ items: [] }), []);
});
