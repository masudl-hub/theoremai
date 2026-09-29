/** lexicon-exempt-file: adversarial corpus fixture — not runtime user or model copy (P2) */
import { clearProfiles, getProfile, registerProfile } from '../../kernel/default-scope.ts';
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
      const safe = sanitizeTurnRequest(textReq, getProfile(textReq.profile));
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
      const safe = sanitizeTurnRequest(slotReq, getProfile(slotReq.profile));
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
      const safe = sanitizeTurnRequest(sysReq, getProfile(sysReq.profile));
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
      const safe = sanitizeTurnRequest(histReq, getProfile(histReq.profile));
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

export function missedCause(text: string): string {
  const injection = injectionSpans(text).length;
  const sensitive = sensitiveSpans(text).length;
  if (injection === 0 && sensitive === 0) {
    return 'no spans detected';
  }
  return `spans detected (${injection} injection, ${sensitive} sensitive) but sanitize missed`;
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
      console.log(`    ${missedCause(r.payload.text)}`);
      console.log(`    \x1b[2m${truncate(r.input, 70)}\x1b[0m`);
    }
  }

  if (failures.length === 0 && caught.length > 0) {
    console.log('\n\x1b[32mAll expected payloads caught across sanitize channels.\x1b[0m\n');
  }

  return failures;
}

/** Returns false when any payload expected to be caught survives a sanitize channel. */
export function runInboundGuardrailFuzz(options?: { quiet?: boolean }): boolean {
  if (!options?.quiet) {
    console.log('\n🔓 Theorem Guardrail Inbound Fuzz\n');
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

  clearProfiles();
  return failures.length === 0;
}
