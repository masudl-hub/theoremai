/**
 * Corpus acquisition for guardrail evaluation.
 *
 * Nothing is vendored. Corpora are fetched on demand and cached locally, so the
 * published package carries no third-party data and no licence obligations beyond
 * attribution here.
 *
 * Two sources, deliberately different in shape:
 *
 * - **S-Labs/prompt-injection-dataset** (MIT) — ~11k labelled prompts whose benign
 *   half deliberately includes security-adjacent questions ("explain output
 *   validation best practices", "how do I implement stress testing"). This is
 *   where user-text detectors are most likely to misfire.
 *
 *   Chosen over `prodnull/prompt-injection-repo-dataset`, which has richer hard
 *   negatives but is gated: licence and access are separate axes, and a gated
 *   corpus cannot be fetched by an unattended run.
 * - **AgentDojo** (MIT, ETH Zurich) — simulated environments for a tool-using
 *   agent. Its fixtures are read directly; the benchmark is never run, so no model
 *   or API key is involved. This supplies benign output in the shape a *tool*
 *   returns, which the repo dataset does not cover.
 *
 * The two are kept separate on purpose. Pooling sources and reporting one number
 * hides the domain shift between them, and that shift is the thing most likely to
 * make a detector look better than it is.
 *
 * @module
 */

/** A single labelled example. */
export interface CorpusSample {
  text: string;
  /** True when the sample is an attack. */
  attack: boolean;
  /** Source dataset id, kept so results are never pooled silently. */
  source: string;
  /** Benign sub-category, so "security docs" never averages into "work email". */
  category: string;
}

export interface CorpusSource {
  id: string;
  licence: string;
  attribution: string;
  /**
   * Rows fetched by default.
   *
   * Several of these corpora are far larger than a fast run wants. The cap is
   * declared rather than buried in the loader so a report can say what fraction
   * was actually sampled — a rate over 1% of a corpus is not a rate over the
   * corpus.
   */
  sampleLimit: number;
  /** Rows available upstream, when known, so sampling is visible in the report. */
  upstreamRows?: number;
  /** Set when the dataset is gated and needs `HF_TOKEN` to fetch. */
  requiresToken?: boolean;
  load: (cache: CorpusCache, limit: number) => Promise<CorpusSample[]>;
}

/** Local cache directory for fetched corpora; gitignored, never published. */
export interface CorpusCache {
  dir: string;
  fetchText: (url: string, key: string) => Promise<string>;
}

const PROMPT_DATASET_URL =
  'https://huggingface.co/datasets/S-Labs/prompt-injection-dataset/resolve/main/data/train.csv';

/**
 * HuggingFace rows API.
 *
 * Serves any public dataset as JSON regardless of its storage format, which makes
 * the many parquet-only corpora usable without a parquet reader.
 */
const HF_ROWS = 'https://datasets-server.huggingface.co/rows';

/** Page through a dataset via the rows API. */
/** Rows per request; the API caps this at 100. */
const HF_PAGE = 100;

/**
 * Concurrent requests.
 *
 * Kept low deliberately. Higher concurrency trips the upstream rate limiter almost
 * immediately, and a rate-limited walk yields an empty corpus that still looks like
 * a successful run.
 */
const HF_CONCURRENCY = 4;

/**
 * One page, retried on failure.
 *
 * A failed request and a past-the-end request are different facts and must not be
 * conflated: treating a rate-limited page as the end of the split silently
 * truncates the corpus, and the run still reports a confident rate over whatever
 * fraction happened to arrive.
 */
async function fetchPage(
  cache: CorpusCache,
  dataset: string,
  split: string,
  offset: number,
  length: number,
  config: string,
  retryBaseMs: number,
): Promise<{ rows: Record<string, unknown>[] } | { failed: true }> {
  const url =
    `${HF_ROWS}?dataset=${encodeURIComponent(dataset)}` +
    `&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  const key = `${dataset.replaceAll('/', '_')}-${config}-${split}-${offset}.json`;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const body = await cache.fetchText(url, key);
      const parsed = JSON.parse(body) as { rows?: { row?: Record<string, unknown> }[] };
      return { rows: (parsed.rows ?? []).flatMap((e) => (e.row ? [e.row] : [])) };
    } catch {
      // Seconds, not milliseconds: the upstream limiter needs tens of seconds to
      // clear, and a short backoff just burns the retries and returns nothing.
      await new Promise((resolve) => setTimeout(resolve, retryBaseMs * 2 ** attempt));
    }
  }
  return { failed: true };
}

/**
 * Page through a dataset via the rows API.
 *
 * Pages are fetched in batches rather than one at a time: a full corpus here runs
 * to thousands of pages, and a serial walk is slow enough that it pressures whoever
 * runs it into sampling a slice and quoting the result as if it covered the whole.
 */
/** Paging options. An object rather than more positionals, which had reached five. */
export interface FetchRowsOptions {
  split?: string;
  config?: string;
  /** Base retry delay. Seconds in production; tests pass milliseconds. */
  retryBaseMs?: number;
}

async function fetchRows(
  cache: CorpusCache,
  dataset: string,
  limit: number,
  options: FetchRowsOptions = {},
): Promise<Record<string, unknown>[]> {
  const { split = 'train', config = 'default', retryBaseMs = 2000 } = options;
  const offsets: number[] = [];
  for (let offset = 0; offset < limit; offset += HF_PAGE) {
    offsets.push(offset);
  }

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < offsets.length; i += HF_CONCURRENCY) {
    const batch = offsets.slice(i, i + HF_CONCURRENCY);
    const pages = await Promise.all(
      batch.map((offset) =>
        fetchPage(
          cache,
          dataset,
          split,
          offset,
          Math.min(HF_PAGE, limit - offset),
          config,
          retryBaseMs,
        ),
      ),
    );

    let pastEnd = false;
    for (const page of pages) {
      if ('failed' in page) {
        // Retries exhausted. Skip the page rather than pretending the split ended.
        continue;
      }
      if (page.rows.length === 0) {
        pastEnd = true;
        continue;
      }
      rows.push(...page.rows);
    }
    // Only an empty page means the split is finished.
    if (pastEnd) {
      break;
    }
  }
  return rows;
}

const AGENTDOJO_RAW =
  'https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/src/agentdojo/data/suites';

const AGENTDOJO_FIXTURES: readonly { path: string; category: string }[] = [
  { path: 'workspace/include/inbox.yaml', category: 'email' },
  { path: 'workspace/include/calendar.yaml', category: 'calendar' },
  { path: 'workspace/include/cloud_drive.yaml', category: 'documents' },
  { path: 'slack/environment.yaml', category: 'chat' },
  { path: 'banking/environment.yaml', category: 'transactions' },
  { path: 'travel/environment.yaml', category: 'travel' },
];

/**
 * Resolve a HuggingFace token for gated corpora.
 *
 * Checks `HF_TOKEN` first, then the location `hf auth login` writes to, so a
 * machine that is already logged in needs no extra setup. Deliberately does not
 * look inside the repository: a credential sitting next to the source is a
 * footgun even when gitignored.
 *
 * The value is never logged, and a missing token is not an error — the run simply
 * reports the gated corpus as not loaded.
 */
function huggingFaceToken(): string | undefined {
  const fromEnv = Deno.env.get('HF_TOKEN');
  if (fromEnv) {
    return fromEnv.trim();
  }
  const home = Deno.env.get('HOME');
  if (!home) {
    return undefined;
  }
  try {
    const stored = Deno.readTextFileSync(`${home}/.cache/huggingface/token`).trim();
    return stored.length > 0 ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** Create a cache that reads from disk when present and fetches when not. */
function createCorpusCache(dir: string): CorpusCache {
  return {
    dir,
    async fetchText(url: string, key: string): Promise<string> {
      const path = `${dir}/${key}`;
      try {
        return await Deno.readTextFile(path);
      } catch {
        // Not cached yet.
      }
      // A gated dataset needs a token the runner may or may not have; the caller
      // decides whether a miss is fatal.
      const token = huggingFaceToken();
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`corpus fetch failed (${response.status}): ${url}`);
      }
      const text = await response.text();
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(path, text);
      return text;
    },
  };
}

/**
 * Parse a two-column `text,label` CSV.
 *
 * Hand-rolled because the corpus text is adversarial by construction: it contains
 * quotes, commas, and embedded newlines, and a naive split would shred exactly the
 * samples that matter most.
 */
function parseLabelledCsv(input: string): { text: string; label: number }[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const out: { text: string; label: number }[] = [];
  for (const parsed of rows.slice(1)) {
    const text = parsed[0];
    // `Number('')` is 0, so a blank label would silently count as benign and
    // inflate the denominator every false-positive rate is measured against.
    const rawLabel = parsed[1]?.trim();
    if (!text || !rawLabel) {
      continue;
    }
    const label = Number(rawLabel);
    if (label === 0 || label === 1) {
      out.push({ text, label });
    }
  }
  return out;
}

const promptDataset: CorpusSource = {
  id: 'prompt-injection-prompts',
  licence: 'MIT',
  attribution: 'S-Labs/prompt-injection-dataset',
  sampleLimit: 12000,
  upstreamRows: 11089,
  async load(cache, limit) {
    const raw = await cache.fetchText(PROMPT_DATASET_URL, 'prompt-dataset.csv');
    // The CSV is one file, so the sample cap is applied after parsing: the report
    // must describe the rows actually scored, not the rows in the file.
    return parseLabelledCsv(raw)
      .slice(0, limit)
      .map((row) => ({
        text: row.text,
        attack: row.label === 1,
        source: 'prompt-injection-prompts',
        // The dataset does not sub-label its benign half; treat it as one category
        // rather than inventing a taxonomy it does not carry.
        category: row.label === 1 ? 'attack' : 'user-prompt',
      }));
  },
};

/**
 * Serialise a YAML record the way a tool would return it.
 *
 * This matters more than it looks. Extracting only prose bodies drops the
 * addresses, ids, and amounts that a real tool result carries, and a detector
 * measured against that thinner text scores better than it deserves.
 */
function recordsFromYaml(yaml: string): string[] {
  const blocks = yaml.split(/\n\s*- (?=\w+[_a-z]*:)/).slice(1);
  const out: string[] = [];
  for (const block of blocks) {
    const fields: Record<string, string | string[]> = {};
    let listKey = '';
    for (const line of block.split('\n')) {
      const scalar = /^\s*([a-z_]+):\s*"?(.+?)"?\s*$/.exec(line);
      if (scalar?.[1] && scalar[2] && scalar[2] !== '[]') {
        fields[scalar[1]] = scalar[2].replace(/\\n/g, '\n');
        listKey = '';
        continue;
      }
      // A bare `key:` opens a list. Without tracking it, the items below attach to
      // the previous field and overwrite it — which silently dropped sender
      // addresses from every email record.
      const header = /^\s*([a-z_]+):\s*$/.exec(line);
      if (header?.[1]) {
        listKey = header[1];
        fields[listKey] = [];
        continue;
      }
      const item = /^\s+- (\S+)\s*$/.exec(line);
      if (item?.[1] && listKey) {
        const prior = fields[listKey];
        fields[listKey] = Array.isArray(prior) ? [...prior, item[1]] : [item[1]];
      }
    }
    const rendered = JSON.stringify(fields, null, 2);
    if (rendered.length > 80) {
      out.push(rendered);
    }
  }
  return out.length > 0 ? out : [];
}

const agentDojo: CorpusSource = {
  id: 'agentdojo-benign',
  licence: 'MIT',
  attribution: 'ethz-spylab/agentdojo (environment fixtures only; benchmark not run)',
  sampleLimit: 500,
  async load(cache, limit) {
    const samples: CorpusSample[] = [];
    for (const fixture of AGENTDOJO_FIXTURES) {
      let raw: string;
      try {
        raw = await cache.fetchText(
          `${AGENTDOJO_RAW}/${fixture.path}`,
          fixture.path.replaceAll('/', '_'),
        );
      } catch {
        // A suite that moved upstream should not fail the whole run.
        continue;
      }
      for (const text of recordsFromYaml(raw)) {
        samples.push({
          text,
          attack: false,
          source: 'agentdojo-benign',
          category: fixture.category,
        });
      }
    }
    // Fixtures are fetched whole; the sample cap decides how many are scored.
    return samples.slice(0, limit);
  },
};

/**
 * A second labelled prompt corpus, deliberately unlike the first.
 *
 * Small, but independently built and partly non-English. One corpus produces one
 * number; agreement across corpora built by different people is the only thing
 * that makes a rate believable.
 */
const deepsetPrompts: CorpusSource = {
  id: 'deepset-prompts',
  licence: 'Apache-2.0',
  attribution: 'deepset/prompt-injections',
  sampleLimit: 600,
  upstreamRows: 546,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'deepset/prompt-injections', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.text;
      const label = row.label;
      if (typeof text === 'string' && (label === 0 || label === 1)) {
        out.push({
          text,
          attack: label === 1,
          source: 'deepset-prompts',
          category: label === 1 ? 'attack' : 'user-prompt',
        });
      }
    }
    return out;
  },
};

/**
 * Injection attempts paired with the system prompt they target.
 *
 * Closer to deployment shape than a bare string: the attack is written against a
 * specific assistant's instructions, which is how indirect injection actually
 * arrives.
 */
const spmlPrompts: CorpusSource = {
  id: 'spml-chatbot',
  licence: 'MIT',
  attribution: 'reshabhs/SPML_Chatbot_Prompt_Injection',
  sampleLimit: 16100,
  upstreamRows: 16012,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'reshabhs/SPML_Chatbot_Prompt_Injection', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row['User Prompt'];
      const flag = row['Prompt injection'];
      if (typeof text !== 'string' || text.length === 0) {
        continue;
      }
      const attack = flag === 1 || flag === true;
      out.push({
        text,
        attack,
        source: 'spml-chatbot',
        category: attack ? 'attack' : 'user-prompt',
      });
    }
    return out;
  },
};

/**
 * PII with ground-truth spans, in structured payloads.
 *
 * Two jobs at once. It is the first corpus that labels what `sensitive.spans`
 * actually hunts, and its content is XML, JSON, and tabular records — the shape a
 * tool returns, rather than the prose most injection corpora carry. Rows with no
 * annotated span are genuine negatives.
 */
const piiSpans: CorpusSource = {
  id: 'pii-spans',
  licence: 'Apache-2.0',
  attribution: 'gravitee-io/pii-detection-dataset',
  sampleLimit: 176000,
  upstreamRows: 175881,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'gravitee-io/pii-detection-dataset', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.text;
      const spans = row.spans;
      if (typeof text !== 'string' || text.length === 0) {
        continue;
      }
      const count = Array.isArray(spans) ? spans.length : 0;
      out.push({
        text,
        attack: count > 0,
        source: 'pii-spans',
        category: count > 0 ? 'pii' : 'structured-payload',
      });
    }
    return out;
  },
};

/**
 * Attacks written against realistic agent applications.
 *
 * Closer to what a deployed product faces than a bare injection string: the
 * payloads target a named assistant and pursue a concrete outcome, such as
 * planting a phishing link in an itinerary. Attack-only, so it measures recall
 * and says nothing about false positives.
 *
 * Licensed `other` upstream — fetched for evaluation, never redistributed.
 */
const agentAttacks: CorpusSource = {
  id: 'agent-app-attacks',
  licence: 'other (upstream); fetched for evaluation only',
  attribution: 'Lakera/b3-agent-security-benchmark-weak',
  sampleLimit: 700,
  upstreamRows: 630,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'Lakera/b3-agent-security-benchmark-weak', limit, {
      split: 'test',
    });
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.attack;
      if (typeof text === 'string' && text.length > 0) {
        out.push({ text, attack: true, source: 'agent-app-attacks', category: 'attack' });
      }
    }
    return out;
  },
};

/**
 * Agentic indirect prompt injection, annotated by attack goal.
 *
 * The closest published match to this facet's threat model: payloads planted in
 * data an agent reads (chart notes, tickets, documents) that try to make it act.
 * Each row labels its own `category` — `exfiltration` or `unauthorized_action` —
 * which is the same split this module draws between what content detection can
 * see and what only the taint gate can stop.
 */
const agenticIpi: CorpusSource = {
  id: 'nvidia-agentic-ipi',
  licence: 'CC-BY-4.0',
  attribution: 'nvidia/Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1',
  sampleLimit: 1300,
  upstreamRows: 1272,
  async load(cache, limit) {
    const rows = await fetchRows(
      cache,
      'nvidia/Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1',
      limit,
    );
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const injection = row.injection as
        | { injection_text?: unknown; category?: unknown }
        | undefined;
      const text = injection?.injection_text;
      if (typeof text !== 'string' || text.length === 0) {
        continue;
      }
      const category = typeof injection?.category === 'string' ? injection.category : 'attack';
      out.push({ text, attack: true, source: 'nvidia-agentic-ipi', category });
    }
    return out;
  },
};

/** Every `FUNCTION RESPONSE:` segment in a transcript — one benign tool result each. */
function toolResultsFromChat(chat: string): string[] {
  const out: string[] = [];
  for (const match of chat.matchAll(/FUNCTION RESPONSE:\s*(\{[\s\S]*?\})\s*(?:\n|$)/g)) {
    const body = match[1];
    if (body && body.length > 15) {
      out.push(body);
    }
  }
  return out;
}

/**
 * Benign tool results at scale.
 *
 * The corpus this module most needed. Every other benign source here is prose or
 * a handful of fixtures; this is real function-calling traffic, and the payload a
 * detector actually sees at the tool boundary is the `FUNCTION RESPONSE` body.
 */
const toolResults: CorpusSource = {
  id: 'glaive-tool-results',
  licence: 'Apache-2.0',
  attribution: 'glaiveai/glaive-function-calling-v2 (function responses only)',
  sampleLimit: 113000,
  upstreamRows: 112960,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'glaiveai/glaive-function-calling-v2', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const chat = row.chat;
      if (typeof chat !== 'string') {
        continue;
      }
      for (const text of toolResultsFromChat(chat)) {
        out.push({ text, attack: false, source: 'glaive-tool-results', category: 'tool-result' });
      }
    }
    return out;
  },
};

/**
 * The richest hard-negative corpus available, and the reason it is opt-in.
 *
 * Its benign half is built from the exact material that breaks pattern matchers:
 * security documentation describing attacks without being one, CVE descriptions,
 * pentesting guides, SQL grants, deployment scripts with environment variables,
 * and code-review discussion. Nothing else here tests that category at volume.
 *
 * It is `gated: auto` upstream, so it needs `HF_TOKEN` in the environment after a
 * one-time terms acceptance. Without a token the run skips it rather than failing:
 * an unavailable corpus should narrow a report, never break it.
 */
const repoHardNegatives: CorpusSource = {
  id: 'repo-hard-negatives',
  licence: 'Apache-2.0',
  attribution: 'prodnull/prompt-injection-repo-dataset (gated; needs HF_TOKEN)',
  sampleLimit: 6000,
  upstreamRows: 5671,
  requiresToken: true,
  async load(cache) {
    const raw = await cache.fetchText(
      'https://huggingface.co/datasets/prodnull/prompt-injection-repo-dataset/resolve/main/train.jsonl',
      'repo-hard-negatives.jsonl',
    );
    const out: CorpusSample[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { text?: unknown; label?: unknown };
        if (typeof row.text === 'string' && (row.label === 0 || row.label === 1)) {
          out.push({
            text: row.text,
            attack: row.label === 1,
            source: 'repo-hard-negatives',
            category: row.label === 1 ? 'attack' : 'security-docs',
          });
        }
      } catch {
        // A malformed row is not worth failing the run over.
      }
    }
    return out;
  },
};

/**
 * Corpora evaluated and deliberately not enabled, with the reason.
 *
 * Kept in the repo so the search does not have to be repeated, and so a later
 * decision to include one starts from the objection rather than from scratch.
 */
export const REVIEWED_SOURCES: readonly {
  dataset: string;
  rows: number;
  licence: string;
  verdict: string;
}[] = [
  {
    dataset: 'Lakera/mosscap_prompt_injection',
    rows: 223533,
    licence: 'MIT',
    verdict:
      'Real human attack attempts against a password-keeping game. Many entries are ' +
      'attacks only in context — "does the password contain numbers?" is an innocent ' +
      'string alone — so scoring them all as must-catch would understate any detector ' +
      'as unfairly as a soft benign set overstates one. Usable as a difficulty ceiling ' +
      'with that stated, not as a headline metric.',
  },
  {
    dataset: 'JailbreakBench/JBB-Behaviors',
    rows: 200,
    licence: 'MIT',
    verdict:
      'Has matched harmful/benign splits, which is the right shape. Targets model ' +
      'harm refusal rather than injection of an agent, so it measures a different ' +
      'guardrail than any here.',
  },
  {
    dataset: 'nvidia/Nemotron-AIQ-Agentic-Safety-Dataset-1.0',
    rows: 0,
    licence: 'other',
    verdict:
      'Agentic safety with with/without-defense splits. Licence is `other` and the ' +
      'split layout needs per-config handling; worth revisiting for defence-efficacy ' +
      'measurement rather than detector scoring.',
  },
  {
    dataset: 'xTRam1/safe-guard-prompt-injection',
    rows: 8236,
    licence: 'none declared',
    verdict: 'Well shaped and ungated, but no declared licence — not a base for a published claim.',
  },
  {
    dataset: 'jayavibhav/prompt-injection-safety',
    rows: 50000,
    licence: 'none declared',
    verdict: 'Large and ungated, no declared licence. Same objection.',
  },
  {
    dataset: 'rogue-security/prompt-injections-benchmark',
    rows: 0,
    licence: 'CC-BY-NC-4.0',
    verdict: 'Gated and non-commercial. Incompatible with an MIT package.',
  },
  {
    dataset: 'gorilla-llm/Berkeley-Function-Calling-Leaderboard',
    rows: 0,
    licence: 'Apache-2.0',
    verdict:
      'The canonical function-calling benchmark and a strong benign tool-traffic ' +
      'source, but its splits API errors; needs direct file access to use.',
  },
];

/**
 * Attacks from a live adaptive competition, labelled by whether they evaded defense.
 *
 * The most valuable attack corpus available here, for three reasons. The payloads
 * are adaptive — written by people iterating against a deployed guardrail, not
 * composed once for a paper. They are email-shaped, which is the domain our tool
 * boundary actually sees. And each carries `objectives.defense.undetected`, so the
 * data says whether a real defense caught it.
 *
 * Split into two sources: everything, and the subset that beat the competition's
 * own defenses. A detector's score on the second is the interesting number.
 */
function llmailSource(id: string, evadedOnly: boolean): CorpusSource {
  return {
    id,
    licence: 'MIT',
    attribution: 'microsoft/llmail-inject-challenge',
    sampleLimit: 20000,
    upstreamRows: 370724,
    async load(cache, limit) {
      const rows = await fetchRows(cache, 'microsoft/llmail-inject-challenge', limit, {
        split: 'Phase1',
      });
      const out: CorpusSample[] = [];
      for (const row of rows) {
        const body = row.body;
        if (typeof body !== 'string' || body.length < 20) {
          continue;
        }
        let undetected = false;
        try {
          const objectives = JSON.parse(String(row.objectives ?? '{}')) as Record<string, unknown>;
          undetected = objectives['defense.undetected'] === true;
        } catch {
          // Unparsable objectives: treat as not-evaded rather than guessing.
        }
        if (evadedOnly && !undetected) {
          continue;
        }
        out.push({
          text: body,
          attack: true,
          source: id,
          category: typeof row.scenario === 'string' ? row.scenario : 'attack',
        });
      }
      return out;
    },
  };
}

const llmailAttacks = llmailSource('llmail-adaptive', false);
const llmailEvaded = llmailSource('llmail-evaded-defense', true);

/** Multilingual injection prompts; independently recommended and cleanly licensed. */
const multilingualPrompts: CorpusSource = {
  id: 'multilingual-prompts',
  licence: 'Apache-2.0',
  attribution: 'yanismiraoui/prompt_injections',
  sampleLimit: 1100,
  upstreamRows: 1034,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'yanismiraoui/prompt_injections', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.prompt_injections;
      if (typeof text === 'string' && text.length > 0) {
        out.push({ text, attack: true, source: 'multilingual-prompts', category: 'attack' });
      }
    }
    return out;
  },
};

/**
 * Benign prompts built from injection trigger words.
 *
 * Purpose-built to measure over-refusal: every entry is innocuous but contains
 * vocabulary a naive matcher fires on ("can I ignore this warning in my code?").
 * Small, and the only corpus here aimed squarely at that failure.
 */
const overRefusal: CorpusSource = {
  id: 'notinject-over-refusal',
  licence: 'none declared (academic benchmark)',
  attribution: 'leolee99/NotInject',
  sampleLimit: 400,
  upstreamRows: 339,
  async load(cache) {
    const out: CorpusSample[] = [];
    for (const split of ['NotInject_one', 'NotInject_two', 'NotInject_three']) {
      const rows = await fetchRows(cache, 'leolee99/NotInject', 200, { split });
      for (const row of rows) {
        const text = row.prompt;
        if (typeof text === 'string' && text.length > 0) {
          out.push({
            text,
            attack: false,
            source: 'notinject-over-refusal',
            category: typeof row.category === 'string' ? row.category : 'over-refusal',
          });
        }
      }
    }
    return out;
  },
};

/**
 * Safe-labelled prompts from a content-safety corpus.
 *
 * A different kind of hard negative. These are ordinary requests drawn from a
 * safety benchmark, so they sit in the same distribution as harmful ones without
 * being harmful — and an injection detector firing on them would be answering a
 * question it was not asked. Only the `safe` half is taken: the unsafe half is a
 * different threat class (harmful content, not instruction hijacking) that nothing
 * in this facet claims to detect.
 */
const contentSafetyBenign: CorpusSource = {
  id: 'aegis-safe-prompts',
  licence: 'CC-BY-4.0',
  attribution: 'nvidia/Aegis-AI-Content-Safety-Dataset-2.0 (safe-labelled prompts only)',
  sampleLimit: 30100,
  upstreamRows: 30007,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'nvidia/Aegis-AI-Content-Safety-Dataset-2.0', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.prompt;
      const label = row.prompt_label;
      if (typeof text === 'string' && text.length > 0 && label === 'safe') {
        out.push({
          text,
          attack: false,
          source: 'aegis-safe-prompts',
          category: 'safety-benchmark-benign',
        });
      }
    }
    return out;
  },
};

/** First user message from a nested Responses-API parameter block. */
function userContentOf(row: Record<string, unknown>): string | undefined {
  const params = row.responses_create_params as { input?: unknown } | undefined;
  const input = params?.input;
  if (!Array.isArray(input)) {
    return undefined;
  }
  for (const turn of input) {
    const entry = turn as { role?: unknown; content?: unknown };
    if (entry.role === 'user' && typeof entry.content === 'string' && entry.content.length > 0) {
      return entry.content;
    }
  }
  return undefined;
}

/**
 * Jailbreak attempts that lean on authority framing rather than trigger words.
 *
 * Adjacent to injection rather than identical to it — the goal is to unlock a
 * refusal, not to hijack a tool call — but the evasion techniques overlap, and
 * `injection.ts` already carries DAN and jailbreak-mode patterns, so it is
 * answerable here.
 */
const jailbreakRobustness: CorpusSource = {
  id: 'nvidia-jailbreak',
  licence: 'CC-BY-4.0',
  attribution: 'nvidia/Nemotron-RL-Jailbreak-Robustness-v1',
  sampleLimit: 5700,
  upstreamRows: 5611,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'nvidia/Nemotron-RL-Jailbreak-Robustness-v1', limit);
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = userContentOf(row);
      if (text) {
        out.push({ text, attack: true, source: 'nvidia-jailbreak', category: 'jailbreak' });
      }
    }
    return out;
  },
};

/**
 * Adversarially-constructed prompts that are nonetheless harmless.
 *
 * The strongest hard negative available. Each row carries both an `adversarial`
 * flag and a harm label, so the subset that is adversarial *and* unharmful is
 * exactly the population a detector is most likely to misfire on: crafted to look
 * like an attack, legitimate in fact. The categories keep that subset visible
 * rather than averaged into the ordinary benign half.
 *
 * Harmful rows are excluded: harmful content is a different guardrail's job, and
 * scoring an injection detector against it would answer a question nobody asked.
 */
const adversarialBenign: CorpusSource = {
  id: 'wildguard-benign',
  licence: 'ODC-BY',
  attribution: 'allenai/wildguardmix (unharmful prompts only)',
  sampleLimit: 87000,
  upstreamRows: 86759,
  requiresToken: true,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'allenai/wildguardmix', limit, {
      split: 'train',
      config: 'wildguardtrain',
    });
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.prompt;
      if (typeof text !== 'string' || text.length === 0) {
        continue;
      }
      if (row.prompt_harm_label !== 'unharmful') {
        continue;
      }
      out.push({
        text,
        attack: false,
        source: 'wildguard-benign',
        category: row.adversarial === true ? 'adversarial-but-harmless' : 'ordinary-prompt',
      });
    }
    return out;
  },
};

/**
 * Adversarially-phrased prompts, split by whether they are actually harmful.
 *
 * The `adversarial_benign` half is the sharpest over-refusal test available:
 * elaborate roleplay and authorial framing that reads exactly like a jailbreak
 * set-up and asks for nothing harmful. A detector keying on framing rather than
 * intent fires on all of it.
 */
const adversarialFraming: CorpusSource = {
  id: 'wildjailbreak',
  licence: 'ODC-BY',
  attribution: 'allenai/wildjailbreak (eval split)',
  sampleLimit: 2300,
  upstreamRows: 2210,
  requiresToken: true,
  async load(cache, limit) {
    const rows = await fetchRows(cache, 'allenai/wildjailbreak', limit, {
      split: 'train',
      config: 'eval',
    });
    const out: CorpusSample[] = [];
    for (const row of rows) {
      const text = row.adversarial;
      const kind = row.data_type;
      if (typeof text !== 'string' || text.length === 0 || typeof kind !== 'string') {
        continue;
      }
      const harmful = kind === 'adversarial_harmful';
      out.push({
        text,
        attack: harmful,
        source: 'wildjailbreak',
        category: harmful ? 'jailbreak' : 'adversarial-benign',
      });
    }
    return out;
  },
};

const SOURCES: readonly CorpusSource[] = [
  promptDataset,
  repoHardNegatives,
  deepsetPrompts,
  spmlPrompts,
  piiSpans,
  agentAttacks,
  agenticIpi,
  llmailAttacks,
  llmailEvaded,
  multilingualPrompts,
  overRefusal,
  contentSafetyBenign,
  jailbreakRobustness,
  adversarialBenign,
  adversarialFraming,
  toolResults,
  agentDojo,
];

export {
  agentAttacks,
  agentDojo,
  agenticIpi,
  createCorpusCache,
  deepsetPrompts,
  fetchRows,
  huggingFaceToken,
  parseLabelledCsv,
  piiSpans,
  promptDataset,
  recordsFromYaml,
  repoHardNegatives,
  SOURCES,
  spmlPrompts,
  toolResults,
  toolResultsFromChat,
};
