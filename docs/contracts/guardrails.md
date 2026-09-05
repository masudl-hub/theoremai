# Guardrails (`theorum/guardrails`)

Generic inbound and outbound guardrail primitives. App-specific policy,
product copy, and channel UX remain host-owned — this entry ships reusable
detectors, sanitizers, public error mapping, and optional per-day quota slots.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/guardrails` / `jsr:@theorum/core/guardrails` |
| Module | `src/guardrails/mod.ts` |
| Testing | `theorum/guardrails/testing` → `src/guardrails/testing.ts` (corpus / fuzz only) |
| Also on | Root `theorum` re-exports common error/sanitize/quota/canary helpers |

## Ownership

Owns every module under `src/guardrails/`.

| Module | Role |
| --- | --- |
| `error.ts` | `TheorumError`, `publicError`, abort helpers |
| `sanitize.ts` | Turn + text sanitization |
| `injection.ts` | Prompt-injection span patterns |
| `sensitive.ts` | Credential / PII span patterns |
| `canary.ts` | Per-turn canary mint/bind, stream gate, leak scan |
| `canary-gate.ts` | Stateful Live batch canary gate |
| `live-outbound-gate.ts` | Live outbound canary + egress holdback |
| `egress.ts` | `standardEgressEnforce` bundled outbound policy |
| `corpus/` | Adversarial bank (live attacks, inbound fuzz, canary egress catalog) |
| `testing.ts` | Test-only re-exports (`theorum/guardrails/testing`) |
| `normalize.ts` | Detection normalization |
| `quota.ts` | In-memory daily slots for HTTP hosts |

## Canary

| API | Role |
| --- | --- |
| `mintCanary` | Generate per-turn `theo-` + 32 hex token |
| `bindCanary` | Append canary note to system prompt |
| `wrapUserData` | Fence untrusted user text in `<user_data>` |
| `createCanaryStreamGate` | Rolling holdback for split-token streaming |
| `scanTextForCanaryLeak` | Literal + base64 + spaced-hex detection |
| `eventHasCanary` | Scan any `TurnEvent` wire shape |
| `createCanaryGateSession` / `filterCanaryGatedEvents` | Live batch path |

## Egress

Hosts may supply `guardrails.egress.enforce` or use the bundled helper:

```ts
import { standardEgressEnforce } from 'theorum/guardrails';

guardrails: {
  egress: { enforce: standardEgressEnforce, onBlock: 'refuse_to_user' },
}
```

`standardEgressEnforce` blocks canary leaks, sensitive echoes, system-boundary
markers, and injection-pattern echoes in assistant text.

## Adversarial testing

Import corpus helpers from **`theorum/guardrails/testing`** (not the production guardrails entry).

| API / task | Role |
| --- | --- |
| `inboundFuzzPayloads` | Corpus entries for inbound sanitize |
| `runInboundGuardrailFuzz` | Run fuzz programmatically; `false` on miss |
| `buildLiveAttacks` | Live red-team cases from same corpus |
| `buildCanaryEgressAttacks` | Synthetic canary egress leak attempts |
| `deno task fuzz` | CLI inbound fuzz; exit `1` on expected miss |
| `deno task fuzz-canary` | CLI canary egress fuzz (stream + Live gates) |
| `deno task test:guardrails` | Unit tests + inbound + canary fuzz (no live API) |
| `deno task verify:guardrails-live` | Live provider red-team (`scripts/verify-guardrails-live.ts`) |

Extend attack cases under **`src/guardrails/corpus/`** only (`strings.ts` / `secrets.ts` for shared literals).

## Public errors

`TheorumError` marks expected contract failures. Never show raw internal
messages to end users — map through `publicError(err)` (or `toErrorEvent` for
streams).

| Internal marker | Public copy |
| --- | --- |
| `UPSTREAM_FAILED` | `PUBLIC_UNAVAILABLE` |
| `canary leaked` / egress violations | `PUBLIC_CANARY` |
| Abort | `PUBLIC_CANCELLED` |
| Tool / MIME / size denials | `PUBLIC_ACTION` / `PUBLIC_FILE_*` |
| Tool not registered / not enabled on turn / not allowed on profile | `PUBLIC_ACTION` |

`describeError` returns structured detail for logs. `throwIfAborted(signal)`
rethrows `AbortError` when a turn should stop early.

Exact-message and regex rules live in `error.ts` (`EXACT`, `RULES` arrays) —
extend there when adding new stable public mappings.

## Sanitization

Driven by profile `guardrails.sanitizeInput` and `guardrails.redactSensitive`
(default both on in `sanitizeText` unless overridden).

| API | Role |
| --- | --- |
| `sanitizeText` | Strip injection + sensitive spans from one string |
| `sanitizeTurnRequest` | Full turn: text, slots, tool arguments, blobs |
| `sanitizeTurnRequestForTrace` | Trace path: full sanitize, or text-only fallback that keeps blobs for hashing (never invents empty input) |
| `sanitizeProjectId` | Bound project id strings (`PROJECT_ID_MAX`) |

`injectionSpans` and `sensitiveSpans` return `RedactSpan[]`; `applySpans`
(from observability) performs replacement. Detection runs on normalized text
(`normalizeForDetection`).

### Injection categories (non-exhaustive)

Patterns target untrusted user text before provider submission:

- Instruction override (`ignore previous instructions`, `disregard rules`, …)
- Mode hijack (`developer mode`, `jailbreak`, `DAN`, `do anything now`)
- Safety bypass (`disable safety filters`, …)
- Role / delimiter forgery (`<system>`, `[System Message]`, ChatML tokens)
- Prompt exfiltration (`reveal your system prompt`, …)
- Multilingual override fragments

False-positive tuning: `tests/guardrails/false-positives.test.ts` and
`tests/guardrails/injection.test.ts`.

## Sensitive data

| API | Role |
| --- | --- |
| `sensitiveSpans` | Credential / PII span detection |
| `redactSensitiveOnly` | Model output path without injection patterns |

`sensitiveSpans` redacts credential-like and PII patterns from inbound text and,
when enabled, outbound paths. Use `redactSensitiveOnly` on model output when
injection patterns should not run.

## Quota

**Not** enforced inside `runTurn`. HTTP hosts call:

```ts
const ip = clientIp(peer, req);
if (skipQuota(peer, req)) { /* local dev */ }
const status = takeSlot(profile, ip, Date.now());
// 'ok' | 'busy' | 'quota' | 'not_configured'
try {
  await runTurn(...);
} finally {
  releaseSlot(profile, ip);
}
```

| Status | Meaning |
| --- | --- |
| `ok` | Slot taken; increment daily count |
| `busy` | Same ip/profile already in flight |
| `quota` | `perDay` exhausted |
| `not_configured` | Profile has no `guardrails.quota` (including when `guardrails` itself is omitted) |

`takeSlot` reads `profile.guardrails?.quota` — missing guardrails object is treated
like missing quota config.

`quotaMessage(profile)` uses `identity.handle` for user-facing limit copy.
`resetSlots()` clears in-memory state (tests).

## Exported API

From `src/guardrails/mod.ts`:

| Group | Symbols |
| --- | --- |
| Public errors | `describeError`, `isAbortError`, `publicError`, `TheorumError`, `throwIfAborted`, `toErrorEvent`, `PUBLIC_ACTION`, `PUBLIC_CANARY`, `PUBLIC_CANCELLED`, `PUBLIC_FILE_COUNT`, `PUBLIC_FILE_SIZE`, `PUBLIC_FILE_TYPE`, `PUBLIC_GENERIC`, `PUBLIC_IMAGE_SIZE`, `PUBLIC_UNAVAILABLE`, `UPSTREAM_FAILED` |
| Injection / sensitive | `injectionSpans`, `sensitiveSpans` |
| Sanitize | `PROJECT_ID_MAX`, `sanitizeProjectId`, `sanitizeText`, `sanitizeTurnRequest`, `sanitizeTurnRequestForTrace`, `redactSensitiveOnly` |
| Canary | `mintCanary`, `bindCanary`, `wrapUserData`, `scanTextForCanaryLeak`, `createCanaryStreamGate`, `eventHasCanary`, `isStreamedCanaryEvent`, `redactCanary`, `OMIT_CANARY`, `USER_OPEN`, `USER_CLOSE`, `createCanaryGateSession`, `filterCanaryGatedEvents`, `CanaryGateResult`, `CanaryGateSession`, `CanaryStreamGate` |
| Egress / Live | `standardEgressEnforce`, `createLiveOutboundGateSession`, `processLiveOutboundBatch`, `finalizeLiveOutboundTurn`, `abortLiveOutboundTurn`, `LiveOutboundBatchResult`, `LiveOutboundGateSession` |
| Quota | `QuotaSlotStatus`, `clientIp`, `quotaMessage`, `releaseSlot`, `resetSlots`, `skipQuota`, `takeSlot` |

From `src/guardrails/testing.ts` (test / harness only):

| Group | Symbols |
| --- | --- |
| Fuzz / red-team | `inboundFuzzPayloads`, `runInboundGuardrailFuzz`, `buildLiveAttacks`, `buildCanaryEgressAttacks`, `filterLiveAttacks`, `summarizeAttackBank` |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Public errors": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/error.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/error.test.ts" }
      ]
    },
    "Sanitization": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/sanitize.ts" },
        { "kind": "source", "path": "src/guardrails/injection.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/sanitize.test.ts" }
      ]
    },
    "Injection categories (non-exhaustive)": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/injection.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/false-positives.test.ts" }
      ]
    },
    "Sensitive data": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/sensitive.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/sanitize.test.ts" }
      ]
    },
    "Quota": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/quota.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/quota.test.ts" }
      ]
    },
    "Adversarial testing": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/testing.ts" },
        { "kind": "contract_test", "path": "tests/cli/fuzz-guardrails.test.ts" },
        { "kind": "contract_test", "path": "tests/cli/fuzz-canary.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/mod.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/error.test.ts" }
      ]
    }
  }
}
```
