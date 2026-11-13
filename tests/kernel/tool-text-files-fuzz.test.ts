import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { boundaryReader } from '../../src/guardrails/detect-at.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { sanitizeCsvText, sanitizeTurnBlobs } from '../../src/kernel/registry/attachments.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import type { StageHandler } from '../../src/kernel/stages.ts';
import { executeFunction } from '../../src/kernel/tools/execute.ts';
import type { ToolStageSupport } from '../../src/kernel/tools/stage-run.ts';
import type { FunctionToolDef, ToolContext } from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const KEY = TEST_OPENAI_KEY;
const PLACEHOLDER = '[omitted - sensitive]';
const SEEDS = Number(Deno.env.get('FUZZ_SEEDS') ?? 8000);
/** Each encoding × action pair at each boundary, with a key in the file, hidden or not. */
const covered = new Set<string>();
const ACTIONS = ['ignore', 'flag', 'redact', 'block'] as const;
type Action = (typeof ACTIONS)[number];
type Encoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16be'
  | 'utf-16le-bom'
  | 'utf-16be-bom'
  | 'bytes'
  | 'sjis';
const ENCODINGS: readonly Encoding[] = [
  'utf-8',
  'utf-8-bom',
  'utf-16le',
  'utf-16be',
  'utf-16le-bom',
  'utf-16be-bom',
  'bytes',
  'sjis',
];
const WIDE = ['日本語', '😀', 'é', 'Ωμέγα', 'naïve', '​', ' '];
/** Shift_JIS bytes for 日本 and テスト, each byte as one character. */
const SJIS = ['\u0093\u00fa\u0096{', '\u0083e\u0083X\u0083g'];
const NARROW = ['café', 'ÿ', '\u0080', '\u0093', ' ', 'Ünïcödé', 'ÿþ'];
const WORDS = ['notes', 'total', 'Ada', 'row', 'value', '42', 'x'];
const CELLS = ['=SUM(A1)', '+1', '-2', '@cmd', '\t=x', '"=quoted"', "'=kept"];
const SEPARATORS = [',', '\n', ' ', '\r\n', ';'];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Draw {
  int(max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

function drawOf(seed: number): Draw {
  const next = random(seed);
  return {
    int: (max) => Math.floor(next() * max),
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    chance: (p) => next() < p,
  };
}

/** Text from words, cells and characters the encoding holds, with the key between spaces when `keyed`. */
function textOf(draw: Draw, encoding: Encoding, keyed: boolean): string {
  const chars = encoding === 'sjis' ? SJIS : encoding === 'bytes' ? NARROW : [...NARROW, ...WIDE];
  const pieces: string[] = [];
  const length = 1 + draw.int(12);
  const keyAt = keyed ? draw.int(length) : -1;
  for (let index = 0; index < length; index++) {
    if (index === keyAt) pieces.push(` ${KEY} `);
    const kind = draw.int(3);
    pieces.push(draw.pick(kind === 0 ? WORDS : kind === 1 ? CELLS : chars));
    pieces.push(draw.pick(SEPARATORS));
  }
  const text = pieces.join('');
  // invariant: a file that opens with a byte order mark is read by it, as a browser reads it, so a one-byte file never opens with one by chance.
  return /^(\u00ff\u00fe|\u00fe\u00ff|\u00ef\u00bb\u00bf)/.test(text) ? `x${text}` : text;
}

const BOM: Partial<Record<Encoding, number[]>> = {
  'utf-8-bom': [0xef, 0xbb, 0xbf],
  'utf-16le-bom': [0xff, 0xfe],
  'utf-16be-bom': [0xfe, 0xff],
};

/** The test's own encoder: the bytes a file of `encoding` holds for `text`. */
function encode(text: string, encoding: Encoding): Uint8Array {
  const mark = BOM[encoding] ?? [];
  let body: number[];
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') body = [...new TextEncoder().encode(text)];
  else if (encoding === 'bytes' || encoding === 'sjis')
    body = [...text].map((c) => c.charCodeAt(0));
  else {
    const little = encoding.startsWith('utf-16le');
    body = [];
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      body.push(...(little ? [unit & 0xff, unit >> 8] : [unit >> 8, unit & 0xff]));
    }
  }
  return Uint8Array.from([...mark, ...body]);
}

/** The test's own decoder, which knows the true encoding. */
function decode(bytes: Uint8Array, encoding: Encoding): string {
  const mark = BOM[encoding] ?? [];
  const head = [...bytes.subarray(0, mark.length)];
  if (head.join() !== mark.join()) throw new Error(`lost its byte order mark: ${encoding}`);
  const body = bytes.subarray(mark.length);
  if (encoding === 'bytes' || encoding === 'sjis') return String.fromCharCode(...body);
  const name = encoding.startsWith('utf-16le')
    ? 'utf-16le'
    : encoding.startsWith('utf-16be')
      ? 'utf-16be'
      : 'utf-8';
  return new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(body);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
const fromBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function wrapped(data: string, draw: Draw): string {
  if (!draw.chance(0.2)) return data;
  return data.replace(/.{1,76}/g, (line) => `${line}\n`);
}

function mimeOf(draw: Draw, encoding: Encoding): string {
  const essence = draw.pick(['text/csv', 'text/plain', 'text/markdown']);
  const cased = draw.chance(0.3) ? essence.toUpperCase() : essence;
  const params: string[] = [];
  if (draw.chance(0.2)) params.push('header=present');
  if (encoding === 'sjis') {
    params.push(`charset=${draw.pick(['Shift_JIS', 'sjis', '"shift_jis"'])}`);
  } else if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const name = draw.chance(0.5) ? encoding.toUpperCase() : encoding;
    params.push(`charset=${draw.chance(0.5) ? `"${name}"` : name}`);
  } else if (draw.chance(0.4)) {
    params.push(
      `charset=${draw.pick(encoding === 'bytes' ? ['iso-8859-1', 'windows-1252'] : ['utf-8', 'UTF-8'])}`,
    );
  }
  return [cased, ...params].join('; ');
}

interface FileCase {
  kind: 'file';
  encoding: Encoding;
  text: string;
  mimeType: string;
  csv: boolean;
}
type PartCase = FileCase | { kind: 'text'; text: string } | { kind: 'other' };

interface Built {
  parts: Record<string, unknown>[];
  cases: PartCase[];
}

function partsOf(draw: Draw): Built {
  const parts: Record<string, unknown>[] = [];
  const cases: PartCase[] = [];
  const count = 1 + draw.int(5);
  for (let index = 0; index < count; index++) {
    const roll = draw.int(10);
    const sent = draw.chance(0.6) ? { sent: true } : {};
    const metadata = draw.chance(0.3) ? { metadata: { source: `w${index}`, page: index } } : {};
    if (roll < 6) {
      const encoding = draw.pick(ENCODINGS);
      const text = textOf(draw, encoding, draw.chance(0.5));
      const mimeType = mimeOf(draw, encoding);
      const data = wrapped(toBase64(encode(text, encoding)), draw);
      parts.push({ type: 'document', mimeType, data, ...sent, ...metadata });
      cases.push({
        kind: 'file',
        encoding,
        text,
        mimeType,
        csv: mimeType.toLowerCase().startsWith('text/csv'),
      });
    } else if (roll < 8) {
      const text = textOf(draw, 'utf-8', draw.chance(0.4));
      parts.push({ type: 'text', text });
      cases.push({ kind: 'text', text });
    } else if (roll < 9) {
      const bytes = Uint8Array.from({ length: 1 + draw.int(64) }, () => draw.int(256));
      const type = draw.pick(['image', 'audio', 'document'] as const);
      const mimeType = { image: 'image/png', audio: 'audio/wav', document: 'application/pdf' }[
        type
      ];
      parts.push({ type, mimeType, data: toBase64(bytes), ...sent, ...metadata });
      cases.push({ kind: 'other' });
    } else {
      parts.push({
        type: 'document',
        mimeType: 'application/pdf',
        uri: `https://files.example/${index}.pdf`,
        ...metadata,
      });
      cases.push({ kind: 'other' });
    }
  }
  return { parts, cases };
}

function profileOf(output: Action, shown: Action): Profile {
  return {
    id: 'text-files-fuzz',
    type: 'text',
    tools: { allow: ['probe'] },
    guardrails: {
      detect: {
        credentials: { at: { tool_output_function: output, tool_shown_function: shown } },
      },
    },
  } as unknown as Profile;
}

function toolOf(handlerParts: Record<string, unknown>[], hidden: boolean): FunctionToolDef {
  return {
    type: 'function',
    name: 'probe',
    description: 'probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ value: z.number() }),
    output: z.unknown(),
    inputSchema: {},
    outputSchema: {},
    handler: () => ({ finding: 'ok', parts: handlerParts }),
    ...(hidden ? { exposeToModel: false } : {}),
  } as unknown as FunctionToolDef;
}

async function runCall(tool: FunctionToolDef, profile: Profile, stages?: ToolStageSupport) {
  const ctx = { profile, callId: 'c1' } as ToolContext;
  const gen = executeFunction(
    defaultKernelScope.tools,
    tool,
    { value: 1 },
    ctx,
    { name: 'probe', callId: 'c1' },
    undefined,
    stages,
  );
  const events: TurnEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, settlement: next.value };
    events.push(next.value);
  }
}

function mutating(parts: Record<string, unknown>[]): ToolStageSupport {
  const handler = ((ctx) =>
    ctx.stage === 'post_tool'
      ? { mutate: { output: { finding: 'ok', parts } } }
      : undefined) as StageHandler;
  return {
    handlers: [handler],
    profile: profileOf('ignore', 'ignore'),
    step: 1,
    history: () => [],
    injectAllowed: true,
  };
}

/**
 * What the model should read of a file, said as UTF-8: its text as the WHATWG decoders read the bytes.
 */
function modelRead(c: FileCase, want: string): string {
  if (c.encoding !== 'bytes' && c.encoding !== 'sjis') return want;
  const bytes = encode(want, c.encoding);
  const named = /charset=/i.test(c.mimeType);
  const utf8 = (() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  })();
  if (c.encoding === 'sjis') return new TextDecoder('shift_jis').decode(bytes);
  if (!named && utf8 !== undefined) return utf8;
  return new TextDecoder('windows-1252').decode(bytes);
}

const keyed = (c: PartCase) => c.kind !== 'other' && c.text.includes(KEY);
const redacted = (text: string) => text.replaceAll(KEY, PLACEHOLDER);

function fail(seed: number, what: string, detail?: unknown): never {
  throw new Error(
    `seed ${seed}: ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`,
  );
}

/** A file part's bytes against what the person should be shown: the bytes as given, or the redacted text in the same encoding. */
function checkFile(
  seed: number,
  where: string,
  given: Record<string, unknown>,
  got: Record<string, unknown>,
  c: FileCase,
  redact: boolean,
) {
  if (got.mimeType !== given.mimeType)
    fail(seed, `${where}: the MIME type changed`, [given.mimeType, got.mimeType]);
  if (got.type !== given.type) fail(seed, `${where}: the type changed`);
  if (JSON.stringify(got.metadata) !== JSON.stringify(given.metadata))
    fail(seed, `${where}: metadata changed`);
  if (got.sent !== given.sent) fail(seed, `${where}: sent changed`);
  const bytes = fromBase64(String(got.data));
  if (!redact || !c.text.includes(KEY)) {
    if (!sameBytes(bytes, fromBase64(String(given.data))))
      fail(seed, `${where}: bytes changed with nothing to redact`, c.encoding);
    return;
  }
  const text = decode(bytes, c.encoding);
  if (text !== redacted(c.text))
    fail(seed, `${where}: the redacted text is wrong`, {
      encoding: c.encoding,
      want: redacted(c.text),
      got: text,
    });
}

function checkOther(
  seed: number,
  where: string,
  given: Record<string, unknown>,
  got: Record<string, unknown>,
) {
  const { sent: _given, ...want } = given;
  const { sent: _got, ...have } = got;
  if (JSON.stringify(have) !== JSON.stringify(want))
    fail(seed, `${where}: a part that is not text changed`, { want, have });
}

interface Run {
  seed: number;
  hidden: boolean;
  outputAction: Action;
  shownAction: Action;
  viaMutate: boolean;
  parts: Record<string, unknown>[];
  cases: PartCase[];
  events: TurnEvent[];
  settlement: Awaited<ReturnType<typeof runCall>>['settlement'];
}

async function fuzzOne(seed: number): Promise<void> {
  const draw = drawOf(seed);
  const hidden = draw.chance(0.25);
  const outputAction = draw.pick(ACTIONS);
  const shownAction = draw.pick(ACTIONS);
  const viaMutate = draw.chance(0.2);
  const built = partsOf(draw);
  const decoy = partsOf(draw);
  const { events, settlement } = await runCall(
    toolOf(viaMutate ? decoy.parts : built.parts, hidden),
    profileOf(outputAction, shownAction),
    viaMutate ? mutating(built.parts) : undefined,
  );
  const run: Run = {
    seed,
    hidden,
    outputAction,
    shownAction,
    viaMutate,
    ...built,
    events,
    settlement,
  };
  for (const c of run.cases) {
    if (c.kind === 'file' && c.text.includes(KEY)) {
      covered.add(`${c.encoding}/${outputAction}/${shownAction}/${hidden}/${viaMutate}`);
    }
  }
  checkUnread(run);
  // invariant: the guard reads the handler's own output before post_tool, so a key there blocks the call whatever post_tool returns.
  const decoyBlocks = viaMutate && decoy.cases.some(keyed);
  if (!hidden && outputAction === 'block' && (run.cases.some(keyed) || decoyBlocks)) {
    if (settlement.failure?.code !== 'output_blocked')
      fail(seed, 'a blocked key did not withhold the result', settlement.failure);
    if (toolEventsOf(events, 'complete').length) fail(seed, 'a withheld result was still shown');
    return;
  }
  if (settlement.failure)
    fail(seed, 'the call failed', {
      failure: settlement.failure,
      hidden,
      outputAction,
      shownAction,
      viaMutate,
      cases: run.cases,
    });
  if (!hidden) checkModelParts(run);
  checkShown(run);
}

/** A hidden tool is never read at tool_output and gives the model no parts; no file's raw bytes reach the model's data. */
function checkUnread(run: Run) {
  const { seed, settlement } = run;
  const boundaries = run.events.flatMap((e) =>
    e.type === 'guardrail' ? [e.guardrail.boundary] : [],
  );
  if (run.hidden) {
    if (boundaries.includes('tool_output_function'))
      fail(seed, 'a hidden tool was read at tool_output');
    if (settlement.modelResult?.parts) fail(seed, 'the model got parts of a hidden tool');
  } else if (
    run.cases.some(keyed) &&
    run.outputAction !== 'ignore' &&
    !settlement.failure &&
    !boundaries.includes('tool_output_function')
  ) {
    fail(seed, 'a key the model reads raised no event');
  }
  const modelJson =
    JSON.stringify(settlement.modelResult?.data ?? null) +
    String(settlement.modelResult?.finding ?? '');
  for (const part of run.parts) {
    if (typeof part.data === 'string' && modelJson.includes(part.data))
      fail(seed, 'raw bytes reached the model in its data');
  }
}

function checkModelParts(run: Run) {
  const { seed } = run;
  const outRedact = run.outputAction === 'redact';
  const read = (run.settlement.modelResult?.parts ?? []) as unknown as Record<string, unknown>[];
  let at = 0;
  for (const [index, c] of run.cases.entries()) {
    const part = run.parts[index] as Record<string, unknown>;
    if (c.kind === 'other' && !('data' in part)) continue;
    const got = read[at++];
    if (!got) fail(seed, 'a model part is missing', index);
    if (got.type !== part.type) fail(seed, 'model parts are out of order', index);
    if (c.kind === 'text') {
      if (got.text !== (outRedact ? redacted(c.text) : c.text))
        fail(seed, 'the model read the wrong text part', index);
    } else if (c.kind === 'file') {
      checkModelFile(seed, part, got, c, outRedact);
    } else {
      checkOther(seed, 'model', { type: part.type, mimeType: part.mimeType, data: part.data }, got);
    }
  }
  if (at !== read.length) fail(seed, 'the model got extra parts');
}

/** The model reads a file as UTF-8 with no byte order mark, a CSV escaped, under its own type. */
function checkModelFile(
  seed: number,
  part: Record<string, unknown>,
  got: Record<string, unknown>,
  c: FileCase,
  outRedact: boolean,
) {
  const read = modelRead(c, outRedact ? redacted(c.text) : c.text);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    fromBase64(String(got.data)),
  );
  const expected = c.csv ? sanitizeCsvText(read) : read;
  if (text !== expected)
    fail(seed, 'the model read the wrong file text', { encoding: c.encoding, expected, text });
  if (text.startsWith('\ufeff')) fail(seed, 'the model got a byte order mark');
  const charset = /charset=("?)([^";]+)\1/i.exec(String(got.mimeType))?.[2]?.toLowerCase();
  if (String(got.data) !== part.data && charset !== undefined && charset !== 'utf-8')
    fail(seed, 'the model got UTF-8 under another charset', got.mimeType);
  if (String(got.mimeType).split(';')[0] !== String(part.mimeType).split(';')[0])
    fail(seed, 'the model got another MIME type');
}

/** The person's parts: what a hidden tool sends, less what tool_shown blocks, each as given or redacted in place. */
function checkShown(run: Run) {
  const { seed, hidden, shownAction } = run;
  const outRedact = !hidden && run.outputAction === 'redact';
  const [complete] = toolEventsOf(run.events, 'complete');
  if (!complete) fail(seed, 'no complete event');
  const expected = run.parts
    .map((part, index) => ({ part, c: run.cases[index] as PartCase }))
    .filter(
      ({ part }) => !hidden || (part.type !== 'text' && ('uri' in part || part.sent === true)),
    )
    .filter(({ c }) => !(shownAction === 'block' && keyed(c) && !outRedact));
  const shown = (complete.parts ?? []) as unknown as Record<string, unknown>[];
  if (shown.length !== expected.length)
    fail(seed, 'the person was shown the wrong number of parts', { cases: run.cases, shown });
  const redact = outRedact || shownAction === 'redact';
  for (const [index, { part, c }] of expected.entries()) {
    checkPart(seed, 'shown part', part, shown[index] as Record<string, unknown>, c, redact);
  }
  const output = complete.output as { parts?: Record<string, unknown>[] } | string | undefined;
  if (shownAction === 'block' && run.cases.some(keyed)) {
    if (typeof output === 'object' && output?.parts) fail(seed, 'a blocked output was still shown');
    return;
  }
  const outParts = typeof output === 'object' ? (output?.parts ?? []) : [];
  if (outParts.length !== run.parts.length) fail(seed, 'the output lost parts');
  for (const [index, c] of run.cases.entries()) {
    const given = run.parts[index] as Record<string, unknown>;
    const got = outParts[index] as Record<string, unknown>;
    if (c.kind === 'other') {
      if (JSON.stringify(got) !== JSON.stringify(given))
        fail(seed, 'the output changed a part that is not text');
    } else checkPart(seed, 'output part', given, got, c, shownAction === 'redact');
  }
}

function checkPart(
  seed: number,
  where: string,
  given: Record<string, unknown>,
  got: Record<string, unknown>,
  c: PartCase,
  redact: boolean,
) {
  if (c.kind === 'file') checkFile(seed, where, given, got, c, redact);
  else if (c.kind === 'text') {
    if (got.text !== (redact ? redacted(c.text) : c.text)) fail(seed, `${where}: the wrong text`);
  } else checkOther(seed, where, given, got);
}

Deno.test("fuzz: a tool's text files are read in every encoding, and come back as given or redacted in place", async () => {
  for (let seed = 1; seed <= SEEDS; seed++) await fuzzOne(seed);
  const missing = ENCODINGS.flatMap((encoding) =>
    ACTIONS.flatMap((output) =>
      ACTIONS.flatMap((shown) =>
        [true, false].flatMap((hidden) => {
          const cell = `${encoding}/${output}/${shown}/${hidden}`;
          return covered.has(`${cell}/false`) ? [] : [cell];
        }),
      ),
    ),
  );
  if (missing.length) throw new Error(`cells the seeds never reached: ${missing.join(', ')}`);
});

Deno.test('fuzz: text-file bytes that are not base64 fail the call, and are never passed on unread', async () => {
  const bad = ['!!!', 'data:text/plain;base64,YQ==', 'YQ=a', '-_-_', 'Y', 'a b c\u0000', '😀'];
  for (const data of bad) {
    for (const mimeType of ['text/csv', 'TEXT/PLAIN; charset=utf-8', 'text/markdown']) {
      const { events, settlement } = await runCall(
        toolOf([{ type: 'document', mimeType, data }], false),
        profileOf('ignore', 'ignore'),
      );
      if (settlement.failure?.code !== 'invalid_output')
        throw new Error(`${data} / ${mimeType}: ${JSON.stringify(settlement.failure)}`);
      if (toolEventsOf(events, 'complete').length) throw new Error(`${data}: shown`);
    }
  }
  const { settlement } = await runCall(
    toolOf([{ type: 'image', mimeType: 'image/png', data: '!!!' }], false),
    profileOf('ignore', 'ignore'),
  );
  if (settlement.failure)
    throw new Error('bytes that are not text are not decoded, so they are not checked as base64');
});

Deno.test('a large text file is read whole, in bounded time', async () => {
  const row = `alpha,beta,=SUM(A1),café,${'x'.repeat(40)}\n`;
  const text = `${row.repeat(40_000)} ${KEY} \n${row.repeat(10)}`;
  const data = toBase64(new TextEncoder().encode(text));
  const started = performance.now();
  const { settlement, events } = await runCall(
    toolOf([{ type: 'document', mimeType: 'text/csv', data, sent: true }], false),
    profileOf('redact', 'redact'),
  );
  const took = performance.now() - started;
  const [complete] = toolEventsOf(events, 'complete');
  const shown = new TextDecoder().decode(
    fromBase64(String((complete?.parts?.[0] as { data?: string } | undefined)?.data)),
  );
  if (shown.includes(KEY) || !shown.includes(PLACEHOLDER))
    throw new Error('the key was not redacted in a large file');
  const model = new TextDecoder().decode(
    fromBase64(String((settlement.modelResult?.parts?.[0] as { data?: string } | undefined)?.data)),
  );
  if (model.includes(KEY)) throw new Error('the model read the key in a large file');
  console.log(`${(data.length / 1e6).toFixed(1)} MB of base64 read in ${took.toFixed(0)} ms`);
  if (took > 20_000) throw new Error(`a ${data.length}-byte file took ${took} ms`);
});

Deno.test('fuzz: a text attachment reaches the model as UTF-8, redacted and escaped, under a charset that says so', () => {
  const accept = ['text/csv', 'text/plain', 'text/markdown'];
  const profile = {
    id: 'attachments-fuzz',
    type: 'text',
    inputs: {
      text: true,
      attachments: { accept },
      maxFiles: 8,
      maxBytes: 1_000_000,
      maxTurnBytes: 8_000_000,
    },
    guardrails: { detect: { credentials: { at: { attachment: 'redact' } } } },
  } as unknown as Profile;
  const { detect } = resolveGuardrailPolicy(profile.guardrails);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const draw = drawOf(seed);
    const encoding = draw.pick(ENCODINGS);
    const text = textOf(draw, encoding, draw.chance(0.5));
    const mimeType = mimeOf(draw, encoding);
    const data = toBase64(encode(text, encoding));
    const { attachments } = sanitizeTurnBlobs(profile, [{ mimeType, data }], undefined, {
      attachment: boundaryReader('attachment', detect),
      voice: boundaryReader('voice', detect),
    });
    const got = attachments?.[0] as { mimeType: string; data: string };
    const c: FileCase = {
      kind: 'file',
      encoding,
      text,
      mimeType,
      csv: mimeType.toLowerCase().startsWith('text/csv'),
    };
    const read = modelRead(c, text);
    const bytes = fromBase64(got.data);
    const seen = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const want = redacted(c.csv ? sanitizeCsvText(read) : read);
    if (seen !== want)
      fail(seed, 'the model read the wrong attachment text', { encoding, mimeType, want, seen });
    const charset = /charset=("?)([^";]+)\1/i.exec(got.mimeType)?.[2]?.toLowerCase();
    if (got.data !== data && charset !== undefined && charset !== 'utf-8') {
      fail(seed, 'an attachment was sent as UTF-8 under another charset', got.mimeType);
    }
  }
});
