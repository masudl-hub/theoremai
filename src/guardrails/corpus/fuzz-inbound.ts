/**
 * Inbound sanitize fuzz runner — exercises all sanitize channels against the corpus.
 *
 * @module
 */

/** lexicon-exempt-file: adversarial corpus fixture — not runtime user or model copy (P2) */
import { clearProfiles, registerProfile } from '../../kernel/registry/profiles.ts';
import type { TurnRequest } from '../../kernel/types.ts';
import { injectionSpans } from '../injection.ts';
import { sanitizeText, sanitizeTurnRequest } from '../sanitize.ts';
import { sensitiveSpans } from '../sensitive.ts';
import { inboundFuzzPayloads } from './inbound-payloads.ts';
import type { InboundFuzzPayload, InboundFuzzResult } from './types.ts';

const FUZZ_PROFILE_ID = '__fuzz__';

function registerFuzzProfile(): void {
  registerProfile({
    type: 'text',
    id: FUZZ_PROFILE_ID,
    identity: { handle: 'fuzz', system: 'Fuzz profile.' },
    models: {
      'fuzz-model': {
        protocol: 'openAi',
        provider: 'openrouter',
        apiId: 'fuzz-model',
        efforts: { normal: 'none' },
        summaries: false,
        maxOutputTokens: 4096,
        temperature: 0,
        builtInTools: [],
      },
    },
    defaultModel: 'fuzz-model',
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: {
      canary: true,
      sanitizeInput: true,
      redactSensitive: true,
    },
  });
}

function testSanitizeText(payloads: InboundFuzzPayload[]): InboundFuzzResult[] {
  const results: InboundFuzzResult[] = [];
  for (const p of payloads) {
    const output = sanitizeText(p.text);
    results.push({
      payload: p,
      channel: 'sanitizeText',
      survived: output === p.text,
      input: p.text,
      output,
    });
  }
  return results;
}

function testTurnRequest(payloads: InboundFuzzPayload[]): InboundFuzzResult[] {
  const results: InboundFuzzResult[] = [];
  for (const p of payloads) {
    const textReq: TurnRequest = { profile: FUZZ_PROFILE_ID, input: { text: p.text } };
    try {
      const safe = sanitizeTurnRequest(textReq);
      const output = safe.input?.text ?? '';
      results.push({
        payload: p,
        channel: 'req.input.text',
        survived: output === p.text,
        input: p.text,
        output,
      });
    } catch {
      results.push({
        payload: p,
        channel: 'req.input.text',
        survived: false,
        input: p.text,
        output: '[threw error]',
      });
    }

    const slotReq: TurnRequest = {
      profile: FUZZ_PROFILE_ID,
      input: { text: 'hello', slots: { payload: p.text } },
    };
    try {
      const safe = sanitizeTurnRequest(slotReq);
      const output = safe.input?.slots?.payload ?? '';
      results.push({
        payload: p,
        channel: 'req.input.slots',
        survived: output === p.text,
        input: p.text,
        output,
      });
    } catch {
      results.push({
        payload: p,
        channel: 'req.input.slots',
        survived: false,
        input: p.text,
        output: '[threw error]',
      });
    }

    const sysReq: TurnRequest = {
      profile: FUZZ_PROFILE_ID,
      system: p.text,
      input: { text: 'hello' },
    };
    try {
      const safe = sanitizeTurnRequest(sysReq);
      const output = safe.system ?? '';
      results.push({
        payload: p,
        channel: 'req.system',
        survived: output === p.text,
        input: p.text,
        output,
      });
    } catch {
      results.push({
        payload: p,
        channel: 'req.system',
        survived: false,
        input: p.text,
        output: '[threw error]',
      });
    }

    const histReq: TurnRequest = {
      profile: FUZZ_PROFILE_ID,
      input: { text: 'hello', history: [{ role: 'user', content: p.text }] },
    };
    try {
      const safe = sanitizeTurnRequest(histReq);
      const output = safe.input?.history?.[0]?.content ?? '';
      results.push({
        payload: p,
        channel: 'req.input.history',
        survived: output === p.text,
        input: p.text,
        output,
      });
    } catch {
      results.push({
        payload: p,
        channel: 'req.input.history',
        survived: false,
        input: p.text,
        output: '[threw error]',
      });
    }
  }
  return results;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function printInboundFuzzResults(results: InboundFuzzResult[]): InboundFuzzResult[] {
  const failures = results.filter((r) => r.payload.expectCaught && r.survived);
  const caught = results.filter((r) => !r.survived);
  const survived = results.filter((r) => r.survived);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(
    `  TOTAL: ${results.length} tests | CAUGHT: ${caught.length} | SURVIVED: ${survived.length} | FAIL: ${failures.length}`,
  );
  console.log(`${'═'.repeat(72)}`);

  if (failures.length > 0) {
    console.log('\n\x1b[31mMISSED (expected redaction, payload unchanged):\x1b[0m\n');
    for (const r of failures) {
      console.log(`  ✗ ${r.payload.category}/${r.payload.name} [${r.channel}]`);
      console.log(`    \x1b[2m${truncate(r.input, 70)}\x1b[0m`);
    }
  }

  if (failures.length === 0 && caught.length > 0) {
    console.log('\n\x1b[32mAll expected payloads caught across sanitize channels.\x1b[0m\n');
  }

  return failures;
}

/**
 * Run inbound adversarial fuzz against the corpus. Returns false when expected catches are missed.
 */
export function runInboundGuardrailFuzz(options?: { quiet?: boolean }): boolean {
  if (!options?.quiet) {
    console.log('\n🔓 Theorum Guardrail Inbound Fuzz\n');
  }

  registerFuzzProfile();
  const payloads = inboundFuzzPayloads();
  if (!options?.quiet) {
    console.log(`Running ${payloads.length} payloads × 5 channels...`);
  }

  const results: InboundFuzzResult[] = [
    ...testSanitizeText(payloads),
    ...testTurnRequest(payloads),
  ];

  const failures = options?.quiet
    ? results.filter((r) => r.payload.expectCaught && r.survived)
    : printInboundFuzzResults(results);

  if (!options?.quiet && failures.length === 0) {
    const missedDetection = new Map<string, InboundFuzzPayload>();
    for (const r of results.filter((r) => r.survived && r.payload.expectCaught)) {
      missedDetection.set(r.payload.name, r.payload);
    }
    for (const [, p] of missedDetection) {
      const iSpans = injectionSpans(p.text);
      const sSpans = sensitiveSpans(p.text);
      if (iSpans.length > 0 || sSpans.length > 0) {
        console.log(
          `  ⚠ ${p.name}: spans detected (${iSpans.length} injection, ${sSpans.length} sensitive) but sanitize missed on some channel`,
        );
      }
    }
    console.log('');
  }

  clearProfiles();
  return failures.length === 0;
}
