/**
 * Synthetic performance benchmark for the THEORUM kernel pipeline.
 *
 * Measures overhead added by profile resolution, sanitization, canary
 * binding, stream processing, and event dispatch vs. a bare provider call.
 *
 * Metrics:
 *   TTFE  — time to first event (profile resolve + provider setup)
 *   TTFT  — time to first text delta
 *   T/s   — text tokens per second throughput
 *   Overhead — total wall-clock delta vs. raw provider consumption
 *
 * @module
 */

import { bindCanary, eventHasCanary, mintCanary } from '../../guardrails/canary.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import { runTurn } from '../../kernel/engine/runner.ts';
import { clearProfiles, registerProfile } from '../../kernel/registry/profiles.ts';
import { pickSystemRole, resolveTurn } from '../../kernel/registry/resolve.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnRequest,
} from '../../kernel/types.ts';
import { buildRecord } from '../../observability/trace-record.ts';

export interface BenchOptions {
  chunks?: number;
  iterations?: number;
  warmup?: number;
}

const DEFAULT_CHUNKS = 200;
const DEFAULT_ITERATIONS = 50;
const DEFAULT_WARMUP = 5;
const MS_PER_SEC = 1000;

const BENCH_PROFILE_ID = '__bench__';

function registerBenchProfile(): void {
  registerProfile({
    type: 'text',
    id: BENCH_PROFILE_ID,
    identity: {
      handle: 'bench',
      system: 'You are a benchmark stub.',
    },
    models: {
      'bench-model': {
        protocol: 'openAi',
        provider: 'openrouter',
        apiId: 'bench-model',
        efforts: { normal: 'none' },
        summaries: false,
        maxOutputTokens: 4096,
        temperature: 0,
        builtInTools: [],
      },
    },
    defaultModel: 'bench-model',
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: {
      canary: true,
      sanitizeInput: true,
      redactSensitive: true,
    },
  });
}

function generateChunks(count: number): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ type: 'text', text: `token_${i} ` });
  }
  events.push({
    type: 'tokens',
    tokens: { input: 10, output: count, total: 10 + count },
  });
  events.push({ type: 'done' });
  return events;
}

function createMockProvider(chunks: TurnEvent[]): ModelProvider {
  return {
    async *complete(_req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function buildBenchRequest(): TurnRequest {
  return {
    profile: BENCH_PROFILE_ID,
    input: { text: 'Benchmark prompt.' },
  };
}

interface TimingResult {
  ttfe: number;
  ttft: number;
  totalMs: number;
  textEvents: number;
}

async function measureRawProvider(provider: ModelProvider): Promise<TimingResult> {
  const req = buildBenchRequest();
  const start = performance.now();
  let firstEvent = 0;
  let firstText = 0;
  let textEvents = 0;
  let gotFirst = false;
  let gotFirstText = false;

  // Simulate what a bare consumer does — no kernel overhead
  const fakeReq: ProviderCompleteRequest = {
    model: 'bench-model',
    apiId: 'bench-model',
    thinking: 'none',
    summaries: undefined,
    maxOutputTokens: 4096,
    temperature: 0,
    builtins: [],
    system: '',
    input: [{ type: 'text', text: req.input?.text ?? '' }],
    structured: null,
    image: null,
  };

  for await (const event of provider.complete(fakeReq)) {
    if (!gotFirst) {
      firstEvent = performance.now() - start;
      gotFirst = true;
    }
    if (!gotFirstText && event.type === 'text') {
      firstText = performance.now() - start;
      gotFirstText = true;
    }
    if (event.type === 'text') {
      textEvents++;
    }
  }

  return {
    ttfe: firstEvent,
    ttft: firstText,
    totalMs: performance.now() - start,
    textEvents,
  };
}

async function measureKernelPipeline(provider: ModelProvider): Promise<TimingResult> {
  const req = buildBenchRequest();
  const start = performance.now();
  let firstEvent = 0;
  let firstText = 0;
  let textEvents = 0;
  let gotFirst = false;
  let gotFirstText = false;

  for await (const event of runTurn(req, provider)) {
    if (!gotFirst) {
      firstEvent = performance.now() - start;
      gotFirst = true;
    }
    if (!gotFirstText && event.type === 'text') {
      firstText = performance.now() - start;
      gotFirstText = true;
    }
    if (event.type === 'text') {
      textEvents++;
    }
  }

  return {
    ttfe: firstEvent,
    ttft: firstText,
    totalMs: performance.now() - start,
    textEvents,
  };
}

interface AggregatedMetrics {
  ttfeMs: { median: number; p95: number; mean: number };
  ttftMs: { median: number; p95: number; mean: number };
  tokensPerSec: { median: number; p95: number; mean: number };
  totalMs: { median: number; p95: number; mean: number };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function aggregate(results: TimingResult[]): AggregatedMetrics {
  const ttfe = results.map((r) => r.ttfe).sort((a, b) => a - b);
  const ttft = results.map((r) => r.ttft).sort((a, b) => a - b);
  const total = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const tps = results.map((r) => (r.textEvents / r.totalMs) * MS_PER_SEC).sort((a, b) => a - b);

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    ttfeMs: {
      median: percentile(ttfe, 50),
      p95: percentile(ttfe, 95),
      mean: mean(ttfe),
    },
    ttftMs: {
      median: percentile(ttft, 50),
      p95: percentile(ttft, 95),
      mean: mean(ttft),
    },
    tokensPerSec: {
      median: percentile(tps, 50),
      p95: percentile(tps, 5), // lower is worse for throughput
      mean: mean(tps),
    },
    totalMs: {
      median: percentile(total, 50),
      p95: percentile(total, 95),
      mean: mean(total),
    },
  };
}

function fmtMs(ms: number): string {
  if (ms < 1) {
    return `${(ms * MS_PER_SEC).toFixed(0)}µs`;
  }
  return `${ms.toFixed(2)}ms`;
}

function fmtRate(tps: number): string {
  if (tps >= MS_PER_SEC * MS_PER_SEC) {
    return `${(tps / (MS_PER_SEC * MS_PER_SEC)).toFixed(1)}M/s`;
  }
  if (tps >= MS_PER_SEC) {
    return `${(tps / MS_PER_SEC).toFixed(1)}K/s`;
  }
  return `${tps.toFixed(0)}/s`;
}

function printMetricRow(
  label: string,
  raw: AggregatedMetrics[keyof AggregatedMetrics],
  fmt: (v: number) => string,
): void {
  console.log(
    `  ${label.padEnd(14)} median ${fmt(raw.median).padStart(10)}   p95 ${fmt(raw.p95).padStart(10)}   mean ${fmt(raw.mean).padStart(10)}`,
  );
}

function printResults(label: string, metrics: AggregatedMetrics): void {
  console.log(`\n${label}`);
  console.log('─'.repeat(72));
  printMetricRow('TTFE', metrics.ttfeMs, fmtMs);
  printMetricRow('TTFT', metrics.ttftMs, fmtMs);
  printMetricRow('Throughput', metrics.tokensPerSec, fmtRate);
  printMetricRow('Total', metrics.totalMs, fmtMs);
}

function printOverhead(raw: AggregatedMetrics, kernel: AggregatedMetrics): void {
  console.log('\nOverhead (kernel − raw)');
  console.log('─'.repeat(72));
  const ttfeDelta = kernel.ttfeMs.median - raw.ttfeMs.median;
  const ttftDelta = kernel.ttftMs.median - raw.ttftMs.median;
  const totalDelta = kernel.totalMs.median - raw.totalMs.median;
  const tpsDelta = kernel.tokensPerSec.median - raw.tokensPerSec.median;

  console.log(`  TTFE           ${ttfeDelta >= 0 ? '+' : ''}${fmtMs(ttfeDelta)}`);
  console.log(`  TTFT           ${ttftDelta >= 0 ? '+' : ''}${fmtMs(ttftDelta)}`);
  console.log(`  Throughput     ${tpsDelta >= 0 ? '+' : ''}${fmtRate(tpsDelta)}`);
  console.log(`  Total          ${totalDelta >= 0 ? '+' : ''}${fmtMs(totalDelta)}`);

  if (raw.totalMs.median > 0) {
    const pct = ((totalDelta / raw.totalMs.median) * 100).toFixed(1);
    console.log(`  Relative       ${totalDelta >= 0 ? '+' : ''}${pct}%`);
  }
}

interface PhaseTimings {
  sanitizeMs: number;
  resolveMs: number;
  systemMs: number;
  canaryMs: number;
  totalSetupMs: number;
}

function measureSetupPhases(): PhaseTimings {
  const req = buildBenchRequest();

  const t0 = performance.now();
  const safe = sanitizeTurnRequest(req);
  const t1 = performance.now();

  const { profile, generation } = resolveTurn(safe);
  const t2 = performance.now();

  pickSystemRole(profile, safe.input?.role);
  const sys = profile.identity.system ?? '';
  const t3 = performance.now();

  bindCanary(sys, generation.canary);
  const t4 = performance.now();

  return {
    sanitizeMs: t1 - t0,
    resolveMs: t2 - t1,
    systemMs: t3 - t2,
    canaryMs: t4 - t3,
    totalSetupMs: t4 - t0,
  };
}

function printPhaseBreakdown(iterations: number): void {
  const results: PhaseTimings[] = [];
  for (let i = 0; i < iterations; i++) {
    results.push(measureSetupPhases());
  }

  const median = (arr: number[]) => {
    const s = arr.slice().sort((a, b) => a - b);
    return percentile(s, 50);
  };

  const sanitize = median(results.map((r) => r.sanitizeMs));
  const resolve = median(results.map((r) => r.resolveMs));
  const system = median(results.map((r) => r.systemMs));
  const canary = median(results.map((r) => r.canaryMs));
  const total = median(results.map((r) => r.totalSetupMs));

  console.log('\nSetup Phase Breakdown (median)');
  console.log('─'.repeat(72));
  console.log(`  sanitizeTurnRequest    ${fmtMs(sanitize).padStart(10)}`);
  console.log(`  resolveTurn            ${fmtMs(resolve).padStart(10)}`);
  console.log(`  pickSystemRole         ${fmtMs(system).padStart(10)}`);
  console.log(`  bindCanary             ${fmtMs(canary).padStart(10)}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Total setup            ${fmtMs(total).padStart(10)}`);
}

interface MicroResult {
  label: string;
  totalMs: number;
  perEventNs: number;
}

function microCanaryCheck(chunks: TurnEvent[], iterations: number): MicroResult {
  const canary = mintCanary();
  const total = chunks.length * iterations;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const chunk of chunks) {
      eventHasCanary(chunk, canary);
    }
  }
  const elapsed = performance.now() - start;
  return {
    label: 'eventHasCanary',
    totalMs: elapsed,
    perEventNs: (elapsed / total) * 1e6,
  };
}

function microArrayPush(chunks: TurnEvent[], iterations: number): MicroResult {
  const total = chunks.length * iterations;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const seen: TurnEvent[] = [];
    const allEmitted: TurnEvent[] = [];
    const attempt: TurnEvent[] = [];
    for (const chunk of chunks) {
      seen.push(chunk);
      allEmitted.push(chunk);
      attempt.push(chunk);
    }
  }
  const elapsed = performance.now() - start;
  return {
    label: 'Array.push ×3',
    totalMs: elapsed,
    perEventNs: (elapsed / total) * 1e6,
  };
}

async function microAsyncGenOverhead(
  chunks: TurnEvent[],
  iterations: number,
): Promise<MicroResult> {
  async function* layer1(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
    for (const e of events) yield e;
  }
  async function* layer2(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
    for await (const e of layer1(events)) yield e;
  }
  async function* layer3(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
    for await (const e of layer2(events)) yield e;
  }
  async function* layer4(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
    for await (const e of layer3(events)) yield e;
  }

  const total = chunks.length * iterations;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for await (const _e of layer4(chunks)) {
      // consume
    }
  }
  const elapsed = performance.now() - start;
  return {
    label: 'AsyncGen ×4 layers',
    totalMs: elapsed,
    perEventNs: (elapsed / total) * 1e6,
  };
}

function microAbortCheck(chunks: TurnEvent[], iterations: number): MicroResult {
  const controller = new AbortController();
  const { signal } = controller;
  const total = chunks.length * iterations;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const _chunk of chunks) {
      if (signal.aborted) throw signal.reason;
    }
  }
  const elapsed = performance.now() - start;
  return {
    label: 'signal.aborted check',
    totalMs: elapsed,
    perEventNs: (elapsed / total) * 1e6,
  };
}

async function microTraceRecord(chunks: TurnEvent[], iterations: number): Promise<MicroResult> {
  const req = buildBenchRequest();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await buildRecord({
      req,
      events: chunks,
      started: Date.now(),
      model: 'bench-model',
    });
  }
  const elapsed = performance.now() - start;
  return {
    label: 'buildRecord (trace)',
    totalMs: elapsed,
    perEventNs: (elapsed / iterations) * 1e6,
  };
}

function microSanitizeScaling(): void {
  const sizes = [50, 200, 1000, 5000];
  console.log('\nSanitize Scaling (input text length)');
  console.log('─'.repeat(72));

  for (const size of sizes) {
    const text = 'A'.repeat(size);
    const req: TurnRequest = {
      profile: BENCH_PROFILE_ID,
      input: { text },
    };
    const runs = 500;
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      sanitizeTurnRequest(req);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / runs;
    console.log(`  ${String(size).padStart(5)} chars          ${fmtMs(perCall).padStart(10)}/call`);
  }
}

function fmtNs(ns: number): string {
  if (ns < 1000) {
    return `${ns.toFixed(0)}ns`;
  }
  return `${(ns / 1000).toFixed(1)}µs`;
}

async function printMicroBenchmarks(chunks: TurnEvent[], iterations: number): Promise<void> {
  const results: MicroResult[] = [];

  results.push(microCanaryCheck(chunks, iterations));
  results.push(microArrayPush(chunks, iterations));
  results.push(await microAsyncGenOverhead(chunks, iterations));
  results.push(microAbortCheck(chunks, iterations));
  results.push(await microTraceRecord(chunks, Math.min(iterations, 20)));

  console.log('\nPer-Event Micro-Benchmarks');
  console.log('─'.repeat(72));
  for (const r of results) {
    const perEvent =
      r.label === 'buildRecord (trace)'
        ? `${fmtMs(r.totalMs / Math.min(iterations, 20)).padStart(10)}/turn`
        : `${fmtNs(r.perEventNs).padStart(8)}/event`;
    console.log(`  ${r.label.padEnd(24)} ${perEvent}    (${fmtMs(r.totalMs)} total)`);
  }

  microSanitizeScaling();
}

export async function benchCommand(options: BenchOptions = {}): Promise<void> {
  const chunkCount = options.chunks ?? DEFAULT_CHUNKS;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const warmup = options.warmup ?? DEFAULT_WARMUP;

  console.log(`\n⏱  Theorum Kernel Benchmark`);
  console.log(`   ${chunkCount} chunks × ${iterations} iterations (${warmup} warmup)\n`);

  const chunks = generateChunks(chunkCount);
  const provider = createMockProvider(chunks);

  registerBenchProfile();

  // Warmup
  for (let i = 0; i < warmup; i++) {
    await measureRawProvider(provider);
    await measureKernelPipeline(provider);
  }

  // Collect raw baseline
  const rawResults: TimingResult[] = [];
  for (let i = 0; i < iterations; i++) {
    rawResults.push(await measureRawProvider(provider));
  }

  // Collect kernel pipeline
  const kernelResults: TimingResult[] = [];
  for (let i = 0; i < iterations; i++) {
    kernelResults.push(await measureKernelPipeline(provider));
  }

  const rawMetrics = aggregate(rawResults);
  const kernelMetrics = aggregate(kernelResults);

  printResults('Raw Provider (baseline)', rawMetrics);
  printResults('Kernel Pipeline (runTurn)', kernelMetrics);
  printOverhead(rawMetrics, kernelMetrics);
  printPhaseBreakdown(iterations);
  await printMicroBenchmarks(chunks, iterations);

  // Cleanup
  clearProfiles();

  console.log('\n');
}
