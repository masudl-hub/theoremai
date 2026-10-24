#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
/** labels-exempt-file: research script — not runtime user or model copy (P2) */
/**
 * The side researcher: a Theorem agent modelled on Bonsai's thinker that digs
 * for detectors, teachers and datasets the bench has not scored. Its sources
 * are Theorem's own MCP and HTTP tools, all keyless; it reads and cites, and
 * never downloads or runs what it finds. A candidate that rests on a page must
 * quote words a tool returned this turn.
 *
 *   deno run -A scripts/guardrails-bench/research/researcher.ts --brief brief.md \
 *     [--model inclusionai/ling-3.1-flash] [--reader jev|none] [--run name] [--known-answer]
 *
 * Writes `<data>/research/<run>/events.jsonl` and `reply.json`, and appends each
 * candidate to `<data>/research/ledger.jsonl`. The OpenRouter key comes from
 * `THEOREM_VAULT_OPENROUTER` (via `THEOREM_ENV_FILE`); Jev runs through it too.
 */

import { z } from 'zod';
import {
  type DecisionQuestion,
  defineProfile,
  getProvider,
  type ItemCheckTurn,
  invokeTool,
  type ProfileItemCheck,
  registerProfile,
  registerStructured,
  registerTool,
  runDecision,
  runTurn,
  type StageHandler,
} from '../../../mod.ts';
import { hostVault, loadHostEnv } from '../../host-env.ts';
import { registerScriptProviders } from '../../provider-options.ts';

function flag(name: string): string | undefined {
  const at = Deno.args.indexOf(name);
  return at < 0 ? undefined : Deno.args[at + 1];
}

const MODEL = flag('--model') ?? 'inclusionai/ling-3.1-flash';
const READER = flag('--reader') ?? 'jev';
const KNOWN_ANSWER = Deno.args.includes('--known-answer');
const DATA = `${Deno.env.get('HOME')}/Development/.guardrail-data`;
const RUN = flag('--run') ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const OUT = `${DATA}/research/${RUN}`;
const MAX_STEPS = Number(flag('--steps') ?? 40);
const MAX_CANDIDATES = 20;
/** Characters kept from one page; three pages a read and forty steps must fit the model's context. */
const PAGE_CHARS = 8_000;

loadHostEnv();
const vault = hostVault();
if (!vault.openrouter) throw new Error('No THEOREM_VAULT_OPENROUTER: set THEOREM_ENV_FILE');
registerScriptProviders();
const openRouter = getProvider('openrouter');
if (!openRouter) throw new Error('openrouter provider not registered');

// ---------- sources: Theorem MCP and HTTP tools ----------

const shared = {
  category: 'read_only',
  access: 'read-only' as const,
  paths: ['*'],
  loadTier: 'T0' as const,
  permission: 'auto' as const,
};
const question = z
  .string()
  .min(1)
  .describe('What you need from this source, as one specific question.');
const owner = z.string().regex(/^[\w.-]+$/);
const any = z.unknown();

function mcp(
  name: string,
  description: string,
  serverUrl: string,
  mcpToolName: string,
  input: z.ZodType,
) {
  registerTool({
    ...shared,
    type: 'mcp',
    name,
    description,
    serverUrl,
    mcpToolName,
    input,
    output: z.string(),
  });
  return name;
}

function http(
  name: string,
  description: string,
  endpoint: string,
  input: z.ZodObject,
  mapping: { pathParams?: string[]; queryParams?: string[] },
  options: {
    headers?: Record<string, string>;
    limit?: { requests: number; windowMs: number };
  } = {},
) {
  registerTool({
    ...shared,
    type: 'http',
    name,
    description,
    endpoint,
    method: 'GET',
    input,
    output: any,
    mapping,
    ...options,
  });
  return name;
}

const EXA = 'https://mcp.exa.ai/mcp';
const FIRECRAWL = 'https://api.firecrawl.dev/v2/search/research/papers';
const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')?.trim();
const firecrawlHeaders = firecrawlKey
  ? { headers: { authorization: `Bearer ${firecrawlKey}` } }
  : {};
const GITHUB = {
  headers: { accept: 'application/vnd.github.raw', 'user-agent': 'theorem-researcher' },
};

const DEEPWIKI = 'ask_deepwiki';
/** The tools whose output is a page to read for a question: Jev picks its passages. */
const READS = new Set([
  'read_pages',
  'read_model_card',
  'read_dataset_card',
  'read_readme',
  'library_docs',
]);

const TOOLS = [
  mcp(
    'search_web',
    'Search the live web (Exa). Returns each result with its highlights.',
    EXA,
    'web_search_exa',
    z.object({ query: z.string().min(1), numResults: z.number().int().max(10).default(6) }),
  ),
  mcp(
    'read_pages',
    'Read up to three web pages by URL (Exa). Pass the question you read them for.',
    EXA,
    'web_fetch_exa',
    z.object({
      urls: z.array(z.string().url()).min(1).max(3),
      maxCharacters: z.number().int().max(PAGE_CHARS).default(PAGE_CHARS),
      question,
    }),
  ),
  http(
    'search_papers',
    'Search the Firecrawl Research Index of papers (arXiv and more) by meaning. from/to are YYYY-MM-DD; categories like cs.CR,cs.CL.',
    FIRECRAWL,
    z.object({
      query: z.string().min(1),
      k: z.number().int().max(20).default(10),
      from: z.string().optional(),
      to: z.string().optional(),
      categories: z.string().optional(),
    }),
    { queryParams: ['query', 'k', 'from', 'to', 'categories'] },
    firecrawlHeaders,
  ),
  http(
    'read_paper',
    "A paper's abstract and the passages that best answer query. id is like arxiv:2610.28988.",
    `${FIRECRAWL}/{id}`,
    z.object({ id: z.string().min(1), query: question, k: z.number().int().max(12).default(4) }),
    { pathParams: ['id'], queryParams: ['query', 'k'] },
    firecrawlHeaders,
  ),
  http(
    'related_papers',
    'Papers like one paper (similar), the papers that cite it (citers), or the papers it cites (references).',
    `${FIRECRAWL}/{id}/similar`,
    z.object({
      id: z.string().min(1),
      mode: z.enum(['similar', 'citers', 'references']),
      intent: z.string().min(1).describe('What the related papers should be about.'),
      k: z.number().int().max(20).default(10),
    }),
    { pathParams: ['id'], queryParams: ['mode', 'intent', 'k'] },
    firecrawlHeaders,
  ),
  http(
    'list_arxiv',
    'The newest arXiv submissions for an arXiv query (e.g. all:"prompt injection" AND all:detector), newest first: papers too new for the index.',
    'https://export.arxiv.org/api/query',
    z.object({
      search_query: z.string().min(1),
      sortBy: z.literal('submittedDate').default('submittedDate'),
      sortOrder: z.literal('descending').default('descending'),
      max_results: z.number().int().max(25).default(15),
    }),
    { queryParams: ['search_query', 'sortBy', 'sortOrder', 'max_results'] },
  ),
  http(
    'search_models',
    'Search Hugging Face models, most recently changed first.',
    'https://huggingface.co/api/models',
    z.object({
      search: z.string().min(1),
      sort: z.literal('lastModified').default('lastModified'),
      direction: z.literal('-1').default('-1'),
      limit: z.number().int().max(30).default(20),
    }),
    { queryParams: ['search', 'sort', 'direction', 'limit'] },
  ),
  http(
    'search_datasets',
    'Search Hugging Face datasets, most recently changed first.',
    'https://huggingface.co/api/datasets',
    z.object({
      search: z.string().min(1),
      sort: z.literal('lastModified').default('lastModified'),
      direction: z.literal('-1').default('-1'),
      limit: z.number().int().max(30).default(20),
    }),
    { queryParams: ['search', 'sort', 'direction', 'limit'] },
  ),
  http(
    'read_model_card',
    'Read a Hugging Face model card. For Horizon-Labs/prompt-injection-guard-small, owner is Horizon-Labs and name is prompt-injection-guard-small.',
    'https://huggingface.co/{owner}/{name}/raw/main/README.md',
    z.object({ owner, name: owner, question }),
    { pathParams: ['owner', 'name'] },
  ),
  http(
    'read_dataset_card',
    'Read a Hugging Face dataset card, by owner and name.',
    'https://huggingface.co/datasets/{owner}/{name}/raw/main/README.md',
    z.object({ owner, name: owner, question }),
    { pathParams: ['owner', 'name'] },
  ),
  http(
    'search_github',
    'Search GitHub repositories, most recently updated first. Keyless: 10 searches a minute.',
    'https://api.github.com/search/repositories',
    z.object({
      q: z.string().min(1),
      sort: z.literal('updated').default('updated'),
      per_page: z.number().int().max(20).default(6),
    }),
    { queryParams: ['q', 'sort', 'per_page'] },
    { ...GITHUB, limit: { requests: 10, windowMs: 60_000 } },
  ),
  http(
    'read_readme',
    'Read a GitHub repository README, by owner and repo.',
    'https://api.github.com/repos/{owner}/{repo}/readme',
    z.object({ owner, repo: owner, question }),
    { pathParams: ['owner', 'repo'] },
    GITHUB,
  ),
  mcp(
    'library_docs',
    "A library's current docs (Context7) for a query. libraryId comes from find_library, like /huggingface/transformers.",
    'https://mcp.context7.com/mcp',
    'query-docs',
    z.object({ libraryId: z.string().min(1), query: question }),
  ),
  mcp(
    'find_library',
    'Find the Context7 id of a library by name.',
    'https://mcp.context7.com/mcp',
    'resolve-library-id',
    z.object({ libraryName: z.string().min(1), query: z.string().min(1) }),
  ),
  mcp(
    DEEPWIKI,
    "Ask DeepWiki's generated wiki about a GitHub repository (repoName owner/repo). Its answer is a lead to check, never a source to quote.",
    'https://mcp.deepwiki.com/mcp',
    'ask_wiki_question',
    z.object({ repoName: z.string().regex(/^[\w.-]+\/[\w.-]+$/), question }),
  ),
];

// ---------- the page reader (Jev), as bonsai.pagereader, run at post_tool ----------

const READER_PROFILE = 'research.pagereader';
const HEADING = /^#{1,6}\s/;
let readerUsd = 0;

registerProfile({
  type: 'decision',
  id: READER_PROFILE,
  identity: { handle: 'Research page reader' },
  models: {
    jev: openRouter.decisionModel('openRouterDecisions', 'typesafe/jev-1.14'),
  },
  inputs: { state: 'json' },
  decision: { contract: 'research.page-passages.v1' },
});

/** One passage per paragraph; a heading travels with the paragraph under it. */
function cutPassages(text: string): string[] {
  const passages: string[] = [];
  let headings: string[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING.test(line)) {
      headings.push(line);
      continue;
    }
    passages.push([...headings, line].join('\n'));
    headings = [];
  }
  if (headings.length > 0) passages.push(headings.join('\n'));
  return passages;
}

/** Passages in requests that fit Jev's 64k context, at about four characters a token and 150 tokens a question. */
function batches(passages: readonly string[]): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let used = 0;
  for (const passage of passages) {
    const tokens = passage.length / 4 + 150;
    if (batch.length > 0 && used + tokens > 48_000) {
      out.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(passage);
    used += tokens;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

function passageQuestion(id: string): DecisionQuestion {
  return {
    type: 'choice',
    instructions: `Does state.passages.${id} state a fact a careful researcher would want when answering state.question, including facts about the subject that do not settle it and anything contradictory?`,
    criteria: {
      relevant: 'The passage states such a fact.',
      not_relevant:
        'The passage does not: it is about something else, or is only a heading, navigation, a reference or a list of links.',
    },
  };
}

async function relevantOf(q: string, batch: readonly string[]): Promise<string[]> {
  const ids = batch.map((_, index) => `p${index + 1}`);
  const result = await runDecision(
    {
      profile: READER_PROFILE,
      state: { question: q, passages: Object.fromEntries(ids.map((id, i) => [id, batch[i]])) },
      questions: Object.fromEntries(ids.map((id) => [id, passageQuestion(id)])),
    },
    { vault },
  );
  readerUsd += result.usage?.costUsd ?? 0;
  return batch.filter((_, i) => {
    const answer = result.answers[ids[i] ?? ''];
    return answer?.type === 'choice' && answer.choice === 'relevant';
  });
}

/** Where a read came from, from its input: the check needs the page named in what the tool returned. */
function sourceOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'read_model_card') return `https://huggingface.co/${input.owner}/${input.name}`;
  if (tool === 'read_dataset_card')
    return `https://huggingface.co/datasets/${input.owner}/${input.name}`;
  if (tool === 'read_readme') return `https://github.com/${input.owner}/${input.repo}`;
  if (tool === 'library_docs') return `https://context7.com${input.libraryId}`;
  return '';
}

/** One read page's text, kept to the passages Jev finds relevant to the question (all of them under `--reader none`). */
async function readFor(text: string, q: string): Promise<string> {
  const passages = cutPassages(text.slice(0, PAGE_CHARS));
  if (READER !== 'jev' || passages.length <= 3) return passages.join('\n\n');
  const picked = await Promise.all(batches(passages).map((batch) => relevantOf(q, batch)));
  return picked.flat().join('\n\n');
}

/** Exa answers several pages in one text, each from its own `URL:` line: each is read on its own. */
async function readExaPages(text: string, q: string): Promise<string> {
  const pages = text.split(/^(?=URL: )/m).filter((page) => page.trim());
  const read = await Promise.all(
    pages.map(async (page) => {
      const head = /^URL: .*$/m.exec(page)?.[0] ?? '';
      return `${head}\n${await readFor(page.slice(head.length), q)}`;
    }),
  );
  return read.join('\n\n---\n\n');
}

const onStage: StageHandler = async (ctx) => {
  if (ctx.stage !== 'post_tool' || !ctx.tool || !READS.has(ctx.tool)) return undefined;
  if (typeof ctx.outputRaw !== 'string' || ctx.failure) return undefined;
  const input = (ctx.input ?? {}) as Record<string, unknown>;
  const q = String(input.question ?? input.query ?? '');
  const output =
    ctx.tool === 'read_pages'
      ? await readExaPages(ctx.outputRaw, q)
      : `Source: ${sourceOf(ctx.tool, input)}\n\n${await readFor(ctx.outputRaw, q)}`;
  return { mutate: { output } };
};

// ---------- the reply and its check ----------

const evidenceSchema = z.object({
  uri: z.string().describe('URL of a page or paper a tool returned this turn.'),
  quote: z.string().describe('The exact words in what the tool returned that this rests on.'),
});

const candidateSchema = z.object({
  kind: z.enum(['model', 'dataset', 'paper', 'repo', 'method']),
  name: z
    .string()
    .describe('Its id as published: a Hub id, an arXiv id, owner/repo, or a short name.'),
  url: z.string().describe('Where it is published.'),
  what: z
    .string()
    .describe('What it is, in one sentence: architecture and size, or contents and size.'),
  why: z
    .string()
    .describe(
      'Why it could help detect injected instructions in web pages and tool results: as a teacher, a training set, a test set, or a method.',
    ),
  released: z.string().optional().describe('Release or last-update date, YYYY-MM-DD, when stated.'),
  license: z.string().optional(),
  gated: z.boolean().optional(),
  basis: z
    .enum(['page', 'lead', 'memory'])
    .describe(
      'page: a source a tool returned this turn; cite it. lead: DeepWiki or a hint not yet confirmed. memory: your own recall.',
    ),
  evidence: z.array(evidenceSchema).describe('Quotes it rests on; required when basis is page.'),
});

const replySchema = z.object({
  summary: z.string().describe('What the search found and how sure you are, in a few sentences.'),
  candidates: z.array(candidateSchema),
  searched: z
    .array(z.string())
    .describe('The queries and sources you tried, including the empty ones.'),
  open: z.array(z.string()).describe('Leads you could not follow, and what would settle them.'),
});

const REPLY_ID = 'research.reply';
const replyJson: Record<string, unknown> = z.toJSONSchema(replySchema);
delete replyJson.$schema;
registerStructured(REPLY_ID, { jsonSchema: replyJson });

/** Text as it is compared: markup, typographic marks, case and spacing do not make different words. */
function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\\n/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>\\]/g, '')
    .replace(/[‘’“”"]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function quotedWords(quote: string): string {
  return comparable(quote)
    .replace(/^'+|'+$/g, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

/** How a source is named in a tool's output: an arXiv id, a Hub or GitHub owner/name, else the URL. */
function sourceKey(uri: string): string {
  const arxiv = /(\d{4}\.\d{4,5})/.exec(uri);
  if (arxiv?.[1] && /arxiv/i.test(uri)) return arxiv[1];
  const repo = /(?:huggingface\.co\/(?:datasets\/)?|github\.com\/)([\w.-]+\/[\w.-]+)/.exec(uri);
  if (repo?.[1]) return repo[1].toLowerCase();
  return uri
    .replace(/[#?].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/** Each quotable tool result's text. DeepWiki's leads are left out. */
function resultsRead(results: ItemCheckTurn['toolResults']): string[] {
  return results
    .filter(({ tool }) => tool !== DEEPWIKI)
    .map(({ output }) => comparable(typeof output === 'string' ? output : JSON.stringify(output)));
}

const refused = (error: string) => ({ isValid: false, error });

const checkCandidate: ProfileItemCheck = (item, turn) => {
  const parsed = candidateSchema.safeParse(item);
  if (!parsed.success) return refused(z.prettifyError(parsed.error));
  const { basis, evidence, url } = parsed.data;
  if (basis === 'page' && evidence.length === 0)
    return refused('A candidate based on a page needs that page and the exact words.');
  const read = resultsRead(turn.toolResults);
  if (basis === 'page' && !read.some((text) => text.includes(sourceKey(url))))
    return refused(
      'No tool returned this URL this turn. Find it with a tool, or set basis memory.',
    );
  for (const { uri, quote } of evidence) {
    const words = quotedWords(quote);
    if (!words) return refused('Each piece of evidence needs the exact words.');
    const key = sourceKey(uri);
    const fromIt = read.filter((text) => text.includes(key));
    if (fromIt.length === 0)
      return refused(
        `No tool returned ${uri} this turn. Cite a source you read, or read it first.`,
      );
    if (!fromIt.some((text) => text.includes(words)))
      return refused(
        `These words are not in what the tools returned for ${uri}. Quote them exactly.`,
      );
  }
  return { isValid: true };
};

// ---------- the profile ----------

const SYSTEM = `Role: independent research scout for a team that guards AI agents against injected instructions in what they read. The brief says what the team needs and where it stands; how to search, and what matters most, is your judgement. The team does not know the whole field: when the evidence disagrees with the brief's framing, say so.

Standards:
- The newest work is often not indexed yet; one search is rarely enough.
- A claim rests on a primary source: the paper, the model card, the dataset card, the repository. A blog or a list is a lead to its primary source; DeepWiki answers are leads only.
- Quote exact words from what the tools returned. Say how sure you are, and what you could not check.
- You never download or run anything. You only find and describe.

Your final answer is one JSON object in the reply schema. Return at most ${MAX_CANDIDATES} candidates, the strongest first.`;

registerProfile(
  defineProfile({
    id: 'research.scout',
    type: 'text',
    identity: { handle: 'Research scout', system: SYSTEM },
    models: {
      main: openRouter.model('openRouterOpenAi', MODEL, { builtInTools: [] }),
    },
    maxSteps: MAX_STEPS,
    turnBehaviour: { atStepLimit: 'answer' },
    inputs: { text: true },
    tools: { allow: TOOLS, parallel: true },
    // The pages it reads are about injection and full of it: every detector records, none acts.
    guardrails: { detect: 'flag' },
    outputs: {
      structured: REPLY_ID,
      validation: {
        maxRetries: 1,
        items: { candidates: { check: checkCandidate, onFail: 'fix' } },
      },
      streaming: { streamThoughts: false },
    },
  }),
);

// ---------- what the bench already has ----------

async function seen(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(`${DATA}/hf-models`))
    names.push(entry.name.replace(/__|--/, '/'));
  const datasets = await Deno.readTextFile(new URL('../datasets.ts', import.meta.url).pathname);
  for (const [, url] of datasets.matchAll(/source: '([^']+)'/g)) if (url) names.push(url);
  return names.sort();
}

// ---------- `--tools`: one call of each source, no model ----------

const SAMPLES: Record<string, Record<string, unknown>> = {
  search_web: { query: 'indirect prompt injection classifier web pages' },
  read_pages: {
    urls: ['https://huggingface.co/Horizon-Labs/prompt-injection-guard-small'],
    question: 'What was it trained on?',
  },
  search_papers: { query: 'indirect prompt injection detection', from: '2026-06-01' },
  read_paper: { id: 'arxiv:2610.28988', query: 'Which datasets are evaluated?' },
  related_papers: { id: 'arxiv:2410.05451', mode: 'citers', intent: 'prompt injection detection' },
  list_arxiv: { search_query: 'all:"prompt injection" AND all:detection' },
  search_models: { search: 'prompt injection' },
  search_datasets: { search: 'indirect prompt injection' },
  read_model_card: {
    owner: 'Horizon-Labs',
    name: 'prompt-injection-guard-small',
    question: 'What was it trained on?',
  },
  read_dataset_card: {
    owner: 'microsoft',
    name: 'llmail-inject-challenge',
    question: 'How many emails?',
  },
  search_github: { q: 'indirect prompt injection detector' },
  read_readme: { owner: 'microsoft', repo: 'BIPIA', question: 'What attack categories?' },
  find_library: { libraryName: 'transformers', query: 'ModernBERT classification' },
  library_docs: {
    libraryId: '/huggingface/transformers',
    query: 'ModernBERT sequence classification pooling',
  },
  [DEEPWIKI]: { repoName: 'microsoft/BIPIA', question: 'What attack categories does it include?' },
};

if (Deno.args.includes('--tools')) {
  for (const name of TOOLS) {
    let result = 'no result';
    for await (const event of invokeTool({
      profile: 'research.scout',
      name,
      input: SAMPLES[name],
      onStage,
    })) {
      if (event.type !== 'tool') continue;
      const call = event.tool;
      if (call.phase === 'complete') {
        const text = typeof call.output === 'string' ? call.output : JSON.stringify(call.output);
        result = `ok ${text.length} chars: ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      }
      if (call.phase === 'error') result = `FAIL ${JSON.stringify(call).slice(0, 300)}`;
    }
    console.log(name.padEnd(18), result);
  }
  console.log({ readerUsd });
  Deno.exit(0);
}

// ---------- the run ----------

const briefPath = flag('--brief');
if (!briefPath) throw new Error('Pass --brief <file>');
const known = await seen();
const brief = KNOWN_ANSWER
  ? await Deno.readTextFile(briefPath)
  : `${await Deno.readTextFile(briefPath)}\n\nThe bench already has these; find others, or say why one deserves another look:\n${known.map((name) => `- ${name}`).join('\n')}`;

await Deno.mkdir(OUT, { recursive: true });
const events = await Deno.open(`${OUT}/events.jsonl`, {
  write: true,
  create: true,
  truncate: true,
});
const encoder = new TextEncoder();
let reply: z.infer<typeof replySchema> | undefined;
let stop = '';
let usd = 0;
let tokens = { input: 0, output: 0 };
let removed = 0;
let flagged = 0;
const started = performance.now();

for await (const event of runTurn(
  {
    profile: 'research.scout',
    input: { text: brief },
    onStage,
  },
  { vault },
)) {
  await events.write(encoder.encode(`${JSON.stringify(event)}\n`));
  if (event.type === 'structured') {
    reply = replySchema.parse(event.structured);
    removed += event.removed?.length ?? 0;
  }
  if (event.type === 'guardrail') flagged++;
  if (event.type === 'done') {
    stop = event.stop.kind;
    usd = event.tokens?.cost?.usd ?? 0;
    tokens = { input: event.tokens?.input ?? 0, output: event.tokens?.output ?? 0 };
  }
  if (event.type === 'error') console.error('error:', JSON.stringify(event).slice(0, 400));
}
events.close();

if (reply) {
  await Deno.writeTextFile(`${OUT}/reply.json`, JSON.stringify(reply, null, 2));
  const at = new Date().toISOString();
  const keys = known.map(sourceKey);
  const lines = reply.candidates.map((candidate) =>
    JSON.stringify({
      run: RUN,
      at,
      model: MODEL,
      seen: keys.includes(sourceKey(candidate.url)),
      ...candidate,
    }),
  );
  if (lines.length > 0)
    await Deno.writeTextFile(`${DATA}/research/ledger.jsonl`, `${lines.join('\n')}\n`, {
      append: true,
    });
}

console.log(
  JSON.stringify({
    run: RUN,
    model: MODEL,
    reader: READER,
    stop,
    seconds: Math.round((performance.now() - started) / 1000),
    tokens,
    usd: Number(usd.toFixed(4)),
    readerUsd: Number(readerUsd.toFixed(4)),
    candidates: reply?.candidates.length ?? 0,
    removed,
    guardrailEvents: flagged,
    out: OUT,
  }),
);
