/** labels-exempt-file: benchmark datasets — not runtime user or model copy (P2) */
import type { Detector } from '../../src/guardrails/detectors.ts';
import type { ProbeBoundary } from '../../studio/guardrail-probe.ts';
import {
  hfPageRows,
  jsonLines,
  parquetRows,
  parseCsv,
  parseLabelledCsv,
  passesLuhn,
  recordsFromYaml,
  toolResultsFromChat,
} from './parse.ts';

/** What a dataset is for. A hold-out is scored only: nothing is tuned on it and no figure from it is published. */
export const ROLES = ['train', 'validate', 'test', 'holdout'] as const;
export type Role = (typeof ROLES)[number];

export interface BenchSample {
  /** Unique within its dataset, so a row can be found again. */
  id: string;
  text: string;
  attack: boolean;
  /** The dataset's own sub-label, so one bad category cannot hide inside an average. */
  category: string;
  /**
   * For a set that labels each detector's target apart, such as personal data spans: the
   * detectors whose target the text holds. Where it is set, it decides `attack` per detector.
   */
  holds?: Detector[];
  /** Detectors this row is left out for, because its label does not mean what the detector means. */
  unscored?: Detector[];
}

/** Where a dataset's files are: a path under the data root or the guardrail corpus, made whole. */
export type Locate = (file: string) => string;

/** Files under this prefix are in the guardrail corpus, which can sit apart from the data root. */
export const CORPUS = 'guardrail-corpus/';

export interface BenchDataset {
  id: string;
  role: Role;
  /** The probe boundary its texts cross. */
  boundary: ProbeBoundary;
  /**
   * The detectors whose target this dataset labels. Recall is scored only for these: a credential
   * detector scored on prompt injections would look broken when it was asked the wrong question.
   * False alarms are scored for every detector, because benign is benign whatever a detector looks for.
   */
  labels: readonly Detector[];
  license: string;
  attribution: string;
  /** Paths, under the data root or {@linkcode CORPUS}, that must exist to read it. */
  files: readonly string[];
  read: (locate: Locate) => AsyncIterable<BenchSample>;
}

interface ShareGptTurn {
  from?: unknown;
  value?: unknown;
}

function turnsOf(row: Record<string, unknown>): ShareGptTurn[] {
  return Array.isArray(row.conversations) ? (row.conversations as ShareGptTurn[]) : [];
}

const THINK = /<think>([\s\S]*?)(?:<\/think>|$)/g;

function thoughtsIn(value: string): string[] {
  return [...value.matchAll(THINK)].flatMap((match) => (match[1]?.trim() ? [match[1]] : []));
}

/**
 * A tool message that reports a failure. Hermes keeps no failure flag, so this picks errors by
 * their wording; it is a selection, not a label, and the coverage doc says so.
 */
const TOOL_ERROR =
  /("error"\s*:\s*"[^"]|"success"\s*:\s*false|"exit_code"\s*:\s*[1-9]|Traceback \(most recent|\bError:|command not found|No such file)/i;

const HERMES_FILE = (config: 'kimi' | 'glm') => `hermes-agent-traces/${config}/train.parquet`;

function hermesThoughts(config: 'kimi' | 'glm', role: Role): BenchDataset {
  return {
    id: `hermes-${config}-thoughts`,
    role,
    boundary: 'thought',
    labels: [],
    license: 'Apache-2.0',
    attribution: `lambda/hermes-agent-reasoning-traces (${config})`,
    files: [HERMES_FILE(config)],
    async *read(locate) {
      const columns = ['id', 'category', 'conversations'];
      for await (const row of parquetRows(locate(HERMES_FILE(config)), columns)) {
        for (const [turn, message] of turnsOf(row).entries()) {
          if (message.from !== 'gpt' || typeof message.value !== 'string') continue;
          for (const [n, text] of thoughtsIn(message.value).entries()) {
            yield {
              id: `${String(row.id)}:${turn}:${n}`,
              text,
              attack: false,
              category: typeof row.category === 'string' ? row.category : 'thought',
            };
          }
        }
      }
    },
  };
}

function hermesErrors(config: 'kimi' | 'glm', role: Role): BenchDataset {
  return {
    id: `hermes-${config}-tool-errors`,
    role,
    boundary: 'tool_failure',
    labels: [],
    license: 'Apache-2.0',
    attribution: `lambda/hermes-agent-reasoning-traces (${config}, failed tool messages)`,
    files: [HERMES_FILE(config)],
    async *read(locate) {
      const columns = ['id', 'category', 'conversations'];
      for await (const row of parquetRows(locate(HERMES_FILE(config)), columns)) {
        for (const [turn, message] of turnsOf(row).entries()) {
          if (message.from !== 'tool' || typeof message.value !== 'string') continue;
          if (!TOOL_ERROR.test(message.value)) continue;
          yield {
            id: `${String(row.id)}:${turn}`,
            text: message.value,
            attack: false,
            category: typeof row.category === 'string' ? row.category : 'tool-error',
          };
        }
      }
    },
  };
}

const OPENTHOUGHTS_FILE = 'openthoughts3-shard0/train-00000.parquet';

const openThoughts: BenchDataset = {
  id: 'openthoughts3-shard0',
  role: 'test',
  boundary: 'thought',
  labels: [],
  license: 'Apache-2.0',
  attribution: 'open-thoughts/OpenThoughts3-1.2M (first shard)',
  files: [OPENTHOUGHTS_FILE],
  async *read(locate) {
    let n = 0;
    for await (const row of parquetRows(locate(OPENTHOUGHTS_FILE), ['domain', 'conversations'])) {
      for (const message of turnsOf(row)) {
        if (message.from !== 'gpt' && message.from !== 'assistant') continue;
        if (typeof message.value !== 'string') continue;
        const found = thoughtsIn(message.value);
        // why: Some rows open the thought without the tag and only close it.
        for (const text of found.length > 0 ? found : [message.value.split('</think>')[0] ?? '']) {
          if (!text.trim()) continue;
          yield {
            id: String(n++),
            text,
            attack: false,
            category: typeof row.domain === 'string' ? row.domain : 'thought',
          };
        }
      }
    }
  },
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const S_LABS = (split: string) => `${CORPUS}s-labs/data/${split}.csv`;

/**
 * S-Labs. Its validation split shares rows with its test split, so the validation rows whose
 * text is also in test are dropped.
 */
function sLabs(split: 'train' | 'validation' | 'test', role: Role): BenchDataset {
  return {
    id: `s-labs-${split}`,
    role,
    boundary: 'user',
    labels: ['injection'],
    license: 'MIT',
    attribution: `S-Labs/prompt-injection-dataset (${split})`,
    files: [S_LABS(split), S_LABS('test')],
    async *read(locate) {
      const rows = parseLabelledCsv(await Deno.readTextFile(locate(S_LABS(split))));
      const test =
        split === 'validation'
          ? new Set(
              parseLabelledCsv(await Deno.readTextFile(locate(S_LABS('test')))).map((r) => r.text),
            )
          : new Set<string>();
      for (const [n, row] of rows.entries()) {
        if (test.has(row.text)) continue;
        yield {
          id: String(n),
          text: row.text,
          attack: row.label === 1,
          category: row.label === 1 ? 'attack' : 'user-prompt',
        };
      }
    },
  };
}

const NEURALCHEMY = (split: string) => `${CORPUS}neuralchemy/core/${split}-00000-of-00001.parquet`;

/** neuralchemy's `core` set: the original rows, without the augmented copies `full` adds to train. */
function neuralchemy(split: 'train' | 'validation' | 'test', role: Role): BenchDataset {
  return {
    id: `neuralchemy-${split}`,
    role,
    boundary: 'user',
    labels: ['injection'],
    license: 'Apache-2.0',
    attribution: `neuralchemy/Prompt-injection-dataset (core, ${split})`,
    files: [NEURALCHEMY(split)],
    async *read(locate) {
      let n = 0;
      for await (const row of parquetRows(locate(NEURALCHEMY(split)), [
        'text',
        'label',
        'category',
      ])) {
        const body = text(row.text);
        if (!body || (row.label !== 0 && row.label !== 1)) continue;
        yield {
          id: String(n++),
          text: body,
          attack: row.label === 1,
          category: text(row.category) ?? (row.label === 1 ? 'attack' : 'benign'),
        };
      }
    },
  };
}

const DEEPSET = `${CORPUS}deepset_prompt_pq_default_train_0.json`;

const deepset: BenchDataset = {
  id: 'deepset-train',
  role: 'train',
  boundary: 'user',
  labels: ['injection'],
  license: 'Apache-2.0',
  attribution: 'deepset/prompt-injections (train)',
  files: [DEEPSET],
  async *read(locate) {
    for (const [n, row] of (await hfPageRows(locate(DEEPSET))).entries()) {
      const body = text(row.text);
      if (!body || (row.label !== 0 && row.label !== 1)) continue;
      yield {
        id: String(n),
        text: body,
        attack: row.label === 1,
        category: row.label === 1 ? 'attack' : 'user-prompt',
      };
    }
  },
};

const NOTINJECT = ['NotInject_one', 'NotInject_two', 'NotInject_three'].map(
  (split) => `${CORPUS}notinject/data/${split}-00000-of-00001.parquet`,
);

/** Harmless prompts built from the words a naive matcher fires on. False alarms only. */
const notInject: BenchDataset = {
  id: 'notinject',
  role: 'test',
  boundary: 'user',
  labels: [],
  license: 'MIT',
  attribution: 'leolee99/NotInject (all three splits)',
  files: NOTINJECT,
  async *read(locate) {
    for (const [split, file] of NOTINJECT.entries()) {
      let n = 0;
      for await (const row of parquetRows(locate(file), ['prompt', 'category'])) {
        const body = text(row.prompt);
        if (!body) continue;
        yield {
          id: `${split}:${n++}`,
          text: body,
          attack: false,
          category: text(row.category) ?? 'over-refusal',
        };
      }
    }
  },
};

const GANDALF_IGNORE = `${CORPUS}gandalf-ignore/data/test-00000-of-00001-bc92128b9288a6d1.parquet`;

/** Gandalf players' "ignore your instructions" prompts. Attacks only, so a found rate. */
const gandalfIgnore: BenchDataset = {
  id: 'gandalf-ignore-test',
  role: 'test',
  boundary: 'user',
  labels: ['injection'],
  license: 'MIT',
  attribution: 'Lakera/gandalf_ignore_instructions (test)',
  files: [GANDALF_IGNORE],
  async *read(locate) {
    let n = 0;
    for await (const row of parquetRows(locate(GANDALF_IGNORE), ['text'])) {
      const body = text(row.text);
      if (body) yield { id: String(n++), text: body, attack: true, category: 'attack' };
    }
  },
};

const SPML = `${CORPUS}reshabhs_SPML_pq_default_train_0.json`;

const spml: BenchDataset = {
  id: 'spml',
  role: 'test',
  boundary: 'user',
  labels: ['injection'],
  license: 'MIT',
  attribution: 'reshabhs/SPML_Chatbot_Prompt_Injection',
  files: [SPML],
  async *read(locate) {
    for (const [n, row] of (await hfPageRows(locate(SPML))).entries()) {
      const body = text(row['User Prompt']);
      if (!body) continue;
      const flag = row['Prompt injection'];
      const attack = flag === 1 || flag === true;
      yield { id: String(n), text: body, attack, category: attack ? 'attack' : 'user-prompt' };
    }
  },
};

const LAKERA_B3 = [0, 100, 200, 300, 400, 500, 600].map(
  (offset) => `${CORPUS}Lakera_b3_test_${offset}.json`,
);

/** Attacks written against named agent apps. Attacks only. */
const lakeraB3: BenchDataset = {
  id: 'lakera-b3',
  role: 'test',
  boundary: 'user',
  labels: ['injection'],
  license: 'other (upstream); read for evaluation only',
  attribution: 'Lakera/b3-agent-security-benchmark-weak (test)',
  files: LAKERA_B3,
  async *read(locate) {
    for (const [page, file] of LAKERA_B3.entries()) {
      for (const [n, row] of (await hfPageRows(locate(file))).entries()) {
        const body = text(row.attack);
        if (body) yield { id: `${page}:${n}`, text: body, attack: true, category: 'attack' };
      }
    }
  },
};

const MULTILINGUAL = 'yanismiraoui/prompt_injections.csv';

/** Injection prompts in several languages. Attacks only. */
const multilingual: BenchDataset = {
  id: 'multilingual-prompts',
  role: 'test',
  boundary: 'user',
  labels: ['injection'],
  license: 'Apache-2.0',
  attribution: 'yanismiraoui/prompt_injections',
  files: [MULTILINGUAL],
  async *read(locate) {
    for (const [n, row] of parseCsv(await Deno.readTextFile(locate(MULTILINGUAL))).entries()) {
      const body = text(row.prompt_injections);
      if (body) yield { id: String(n), text: body, attack: true, category: 'attack' };
    }
  },
};

const REPO_TEXTS = `${CORPUS}repo-hard-negatives.jsonl`;

/** Lines from code repositories, many of them security docs that describe attacks without being one. */
const repoTexts: BenchDataset = {
  id: 'repo-texts',
  role: 'test',
  boundary: 'user',
  labels: ['injection'],
  license: 'Apache-2.0',
  attribution: 'prodnull/prompt-injection-repo-dataset',
  files: [REPO_TEXTS],
  async *read(locate) {
    let n = 0;
    for await (const row of jsonLines(locate(REPO_TEXTS))) {
      const body = text(row.text);
      if (!body || (row.label !== 0 && row.label !== 1)) continue;
      yield {
        id: String(n++),
        text: body,
        attack: row.label === 1,
        category: row.label === 1 ? 'attack' : 'security-docs',
      };
    }
  },
};

const WILDJAILBREAK = Array.from(
  { length: 9 },
  (_, n) => `${CORPUS}allenai_wildjailbreak_tsv_${n}.json`,
);

/**
 * WildJailbreak's adversarial but harmless prompts: roleplay and framing that read like a
 * jailbreak and ask for nothing harmful. False alarms only. Its harmful half is left out: a
 * harmful request with no takeover wording is the model's to refuse, not a detector's to catch.
 */
const wildJailbreak: BenchDataset = {
  id: 'wildjailbreak-benign',
  role: 'test',
  boundary: 'user',
  labels: [],
  license: 'ODC-BY',
  attribution: 'allenai/wildjailbreak (train, adversarial_benign rows)',
  files: WILDJAILBREAK,
  async *read(locate) {
    for (const [page, file] of WILDJAILBREAK.entries()) {
      for (const [n, row] of (await hfPageRows(locate(file))).entries()) {
        const body = text(row.adversarial);
        if (!body || row.data_type !== 'adversarial_benign') continue;
        yield { id: `${page}:${n}`, text: body, attack: false, category: 'adversarial-benign' };
      }
    }
  },
};

const AEGIS = (split: string) => `aegis-2/${split}.json`;

/** Aegis 2.0 prompts labelled safe: ordinary requests from a safety set. False alarms only. */
function aegis(split: 'train' | 'validation' | 'test', role: Role): BenchDataset {
  return {
    id: `aegis-safe-${split}`,
    role,
    boundary: 'user',
    labels: [],
    license: 'CC-BY-4.0',
    attribution: `nvidia/Aegis-AI-Content-Safety-Dataset-2.0 (${split}, prompts labelled safe)`,
    files: [AEGIS(split)],
    async *read(locate) {
      const rows = JSON.parse(await Deno.readTextFile(locate(AEGIS(split)))) as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        const body = text(row.prompt);
        if (!body || body === 'REDACTED' || row.prompt_label !== 'safe') continue;
        yield { id: String(row.id), text: body, attack: false, category: 'safe-prompt' };
      }
    },
  };
}

const GRAVITEE = `${CORPUS}gravitee-full/data.parquet`;

/** The gravitee span labels that mean what a detector means. Routing numbers are `FINANCIAL`, so not an account. */
const GRAVITEE_LABELS: Readonly<Record<string, Detector>> = {
  US_SSN: 'ids',
  US_ITIN: 'ids',
  CREDIT_CARD: 'financial',
  IBAN_CODE: 'financial',
  IP_ADDRESS: 'network',
  EMAIL_ADDRESS: 'email',
  PHONE_NUMBER: 'phone',
  US_BANK_NUMBER: 'bank_account',
};

interface Span {
  start: number;
  end: number;
  label: string;
}

/**
 * gravitee's personal data spans, in structured payloads. Rows 0 to 9,999 are tuned on, rows
 * 10,000 to 19,999 pick settings, and the rest are the test. A card that fails its checksum is
 * not a card, so a row whose only card does is left out of the `financial` score.
 */
function gravitee(role: 'train' | 'validate' | 'test'): BenchDataset {
  const [from, to] = { train: [0, 10_000], validate: [10_000, 20_000], test: [20_000, Infinity] }[
    role
  ];
  return {
    id: `gravitee-${role}`,
    role,
    boundary: 'tool_result_local',
    labels: [...new Set(Object.values(GRAVITEE_LABELS))],
    license: 'Apache-2.0',
    attribution: `gravitee-io/pii-detection-dataset (rows ${from} to ${to === Infinity ? 'the end' : to - 1})`,
    files: [GRAVITEE],
    async *read(locate) {
      let n = 0;
      for await (const row of parquetRows(locate(GRAVITEE), ['text', 'spans'])) {
        const at = n++;
        if (at < from) continue;
        if (at >= to) return;
        const body = text(row.text);
        if (!body) continue;
        const spans = Array.isArray(row.spans) ? (row.spans as Span[]) : [];
        const holds = new Set<Detector>();
        let fakeCard = false;
        for (const span of spans) {
          const detector = GRAVITEE_LABELS[span.label];
          if (!detector) continue;
          if (span.label === 'CREDIT_CARD' && !passesLuhn(body.slice(span.start, span.end))) {
            fakeCard = true;
            continue;
          }
          holds.add(detector);
        }
        yield {
          id: String(at),
          text: body,
          attack: holds.size > 0,
          category: holds.size > 0 ? 'pii' : 'structured-payload',
          holds: [...holds],
          ...(fakeCard && !holds.has('financial') ? { unscored: ['financial' as const] } : {}),
        };
      }
    },
  };
}

const LLMAIL = (file: string) => `${CORPUS}llmail-inject/data/${file}`;
const LLMAIL_1 = LLMAIL('raw_submissions_phase1.jsonl');
const LLMAIL_2 = LLMAIL('raw_submissions_phase2.jsonl');

/** An LLMail submission as the competition's agent read it. */
function llmailEmail(row: Record<string, unknown>): string {
  return `Subject of the email: ${String(row.subject ?? '')}.   Body: ${String(row.body ?? '')}`;
}

interface LlmailSplit {
  train: Map<string, string>;
  validate: Map<string, string>;
  test: Map<string, string>;
}

let llmailSplit: Promise<LlmailSplit> | undefined;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * LLMail's distinct emails, keyed by text, each with its team. Phase 1 teams that never played
 * phase 2 are ordered by a hash of their id, and the first fifth pick settings. The rest of phase 1
 * is tuned on, less any email a validate team also sent. The test is phase 2 from the teams that
 * never played phase 1.
 */
function splitLlmail(locate: Locate): Promise<LlmailSplit> {
  llmailSplit ??= (async () => {
    const byTeam = new Map<string, Map<string, string>>();
    for await (const row of jsonLines(locate(LLMAIL_1))) {
      const team = String(row.team_id);
      const emails = byTeam.get(team) ?? new Map<string, string>();
      emails.set(llmailEmail(row), team);
      byTeam.set(team, emails);
    }
    const phase2 = new Map<string, string>();
    const phase2Teams = new Set<string>();
    for await (const row of jsonLines(locate(LLMAIL_2))) {
      const team = String(row.team_id);
      phase2Teams.add(team);
      if (!byTeam.has(team)) phase2.set(llmailEmail(row), team);
    }
    const candidates = await Promise.all(
      [...byTeam.keys()]
        .filter((team) => !phase2Teams.has(team))
        .map(async (team) => ({ team, hash: await sha256(team) })),
    );
    candidates.sort((a, b) => (a.hash < b.hash ? -1 : 1));
    const held = new Set(candidates.slice(0, Math.floor(candidates.length / 5)).map((c) => c.team));
    const validate = new Map<string, string>();
    const train = new Map<string, string>();
    for (const [team, emails] of byTeam) {
      for (const [email] of emails) (held.has(team) ? validate : train).set(email, team);
    }
    for (const email of validate.keys()) train.delete(email);
    return { train, validate, test: phase2 };
  })();
  return llmailSplit;
}

/** LLMail emails, each written by a player to make the agent send an email. Attacks only, by team. */
function llmail(role: keyof LlmailSplit): BenchDataset {
  return {
    id: `llmail-${role}`,
    role,
    boundary: 'tool_result_local',
    labels: ['injection', 'tool_instructions'],
    license: 'MIT',
    attribution: `microsoft/llmail-inject-challenge (${role === 'test' ? 'phase 2, teams new to it' : 'phase 1'})`,
    files: [LLMAIL_1, LLMAIL_2],
    async *read(locate) {
      let n = 0;
      for (const [email, team] of (await splitLlmail(locate))[role]) {
        yield { id: String(n++), text: email, attack: true, category: `team ${team}` };
      }
    },
  };
}

const LLMAIL_BENIGN = LLMAIL('emails_for_fp_tests.json');

/** The emails LLMail's organisers wrote to test false alarms. */
const llmailBenign: BenchDataset = {
  id: 'llmail-benign',
  role: 'test',
  boundary: 'tool_result_local',
  labels: [],
  license: 'MIT',
  attribution: 'microsoft/llmail-inject-challenge (emails for false-alarm tests)',
  files: [LLMAIL_BENIGN],
  async *read(locate) {
    const emails = JSON.parse(await Deno.readTextFile(locate(LLMAIL_BENIGN))) as unknown[];
    for (const [n, email] of emails.entries()) {
      const body = text(email);
      if (body) yield { id: String(n), text: body, attack: false, category: 'email' };
    }
  },
};

const NVIDIA_IPI = Array.from(
  { length: 13 },
  (_, n) => `${CORPUS}nvidia_Nemotron-RL-Agentic_train_${n * 100}.json`,
);

/** Text planted in the data an agent reads, such as chart notes and tickets. Attacks only. */
const nvidiaIpi: BenchDataset = {
  id: 'nvidia-agentic-ipi',
  role: 'test',
  boundary: 'tool_result_local',
  labels: ['injection', 'tool_instructions'],
  license: 'CC-BY-4.0',
  attribution: 'nvidia/Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1',
  files: NVIDIA_IPI,
  async *read(locate) {
    for (const file of NVIDIA_IPI) {
      for (const row of await hfPageRows(locate(file))) {
        const injection = row.injection as { injection_text?: unknown } | undefined;
        const body = text(injection?.injection_text);
        if (!body) continue;
        yield {
          id: String(row.id),
          text: body,
          attack: true,
          category: text(row.attack_category) ?? 'attack',
        };
      }
    }
  },
};

const GLAIVE = 'glaive-fc-dl/g.json';

/** The function responses in Glaive's function-calling chats. False alarms only. */
const glaive: BenchDataset = {
  id: 'glaive-tool-results',
  role: 'test',
  boundary: 'tool_result_local',
  labels: [],
  license: 'Apache-2.0',
  attribution: 'glaiveai/glaive-function-calling-v2 (function responses only)',
  files: [GLAIVE],
  async *read(locate) {
    const rows = JSON.parse(await Deno.readTextFile(locate(GLAIVE))) as { chat?: unknown }[];
    for (const [n, row] of rows.entries()) {
      if (typeof row.chat !== 'string') continue;
      for (const [k, body] of toolResultsFromChat(row.chat).entries()) {
        yield { id: `${n}:${k}`, text: body, attack: false, category: 'tool-result' };
      }
    }
  },
};

const SUITES = `${CORPUS}agentdyn/src/agentdojo/data/suites`;
const AGENTDOJO_FIXTURES: readonly { file: string; category: string }[] = [
  { file: `${SUITES}/workspace/include/inbox.yaml`, category: 'email' },
  { file: `${SUITES}/workspace/include/calendar.yaml`, category: 'calendar' },
  { file: `${SUITES}/workspace/include/cloud_drive.yaml`, category: 'documents' },
  { file: `${SUITES}/slack/environment.yaml`, category: 'chat' },
  { file: `${SUITES}/banking/environment.yaml`, category: 'transactions' },
  { file: `${SUITES}/travel/environment.yaml`, category: 'travel' },
];

/** The records of AgentDojo's four suites, as a tool returns them. False alarms only. */
const agentDojo: BenchDataset = {
  id: 'agentdojo-records',
  role: 'test',
  boundary: 'tool_result_local',
  labels: [],
  license: 'MIT',
  attribution: 'ethz-spylab/agentdojo environment fixtures, from the AgentDyn fork',
  files: AGENTDOJO_FIXTURES.map((fixture) => fixture.file),
  async *read(locate) {
    for (const { file, category } of AGENTDOJO_FIXTURES) {
      for (const [n, body] of recordsFromYaml(await Deno.readTextFile(locate(file))).entries()) {
        yield { id: `${category}:${n}`, text: body, attack: false, category };
      }
    }
  },
};

export const DATASETS: readonly BenchDataset[] = [
  sLabs('train', 'train'),
  sLabs('validation', 'validate'),
  sLabs('test', 'test'),
  neuralchemy('train', 'train'),
  neuralchemy('validation', 'validate'),
  neuralchemy('test', 'test'),
  deepset,
  notInject,
  gandalfIgnore,
  spml,
  lakeraB3,
  multilingual,
  repoTexts,
  wildJailbreak,
  aegis('train', 'train'),
  aegis('validation', 'validate'),
  aegis('test', 'test'),
  gravitee('train'),
  gravitee('validate'),
  gravitee('test'),
  llmail('train'),
  llmail('validate'),
  llmail('test'),
  llmailBenign,
  nvidiaIpi,
  glaive,
  agentDojo,
  hermesThoughts('kimi', 'train'),
  hermesThoughts('glm', 'validate'),
  openThoughts,
  hermesErrors('kimi', 'train'),
  hermesErrors('glm', 'validate'),
];
