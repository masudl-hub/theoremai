# Migration: ownership boundary ("Host decides, Theorem runs")

Breaking cut. No deprecation aliases.

## Removed: playground entrypoint

Demo fixtures moved to the **repo-private** package `@theoremai/playground`
(`playground/` in the repo). It is never published.

```diff
- import { demoToolSpecs } from '@theoremai/playground';
+ import { demoToolSpecs } from '@theoremai/playground';
```

Hosts link it with `"@theoremai/playground": "file:../theoremai/playground"`.
`PLAYGROUND_AUTH_TYPES` / `PlaygroundAuthType` remain on `@theoremai/agents/schema`
(authoring vocabulary, not demo product).

## Removed: `quotaMessage`

```diff
- quotaMessage(profile) // "Enjoying ${handle}? You've reached today's limit"
+ quotaExhausted(profile)
+ // → TheoremError (kind `rate_limit`) or undefined
```

See the lexicon table below.

## Lexicon + overridable mechanism copy

User- and model-visible defaults live in `src/guardrails/lexicon.ts`.
Hosts override per profile with the profile's `lexicon` (any profile type) or
process-wide with `overrideLexicon({ … })`; the profile wins.

| Was | Now |
| --- | --- |
| `CONTINUE_INSTRUCTION`, `turnBehaviour.resumption.continueInstruction` | Lexicon `continue.instruction` |
| `guardrails.canary.bindNote` | Lexicon `canary.bind_note` (must keep `{canary}`) |
| `PUBLIC_*` constants, `UPSTREAM_FAILED`, message-text error mapping | Error kinds (`ERROR_KINDS`) and lexicon `error.<kind>` — see [Public errors](contracts/guardrails.md#public-errors) |
| `isToolPause` | The tool outcome union (`kind: 'gated'`) |
| `outputs.validation.repairGuidance` | Lexicon `repair.default_guidance` |
| `guardrails.egress.repairGuidance` | Lexicon `egress.default_repair_guidance` |
| `guardrails.quota.message`, `QuotaExhausted` | `quotaExhausted` returns a `rate_limit` `TheoremError`; lexicon `quota.exhausted` (`{perDay}`) |
| Egress `Verdict.refusal`, legacy verdict `text` | Lexicon `egress.refusal`; the policy only decides |
| `guardrails.taint.advisoryGuidance` | Lexicon `advisory.guidance` (empty by default) |
| Kernel egress rejections sent to the model (`Egress blocked: …`, invalid verdict, policy failure) | Lexicon `egress.rejection` (`{rules}`), `egress.invalid_verdict`, `egress.policy_failed`; policies read the profile lexicon on `GuardrailContext.lexicon` |
| A throwing egress policy's message in the model's repair turn (`egress.policy_failed` `{detail}`) | Builder only: the block verdict's and `guardrail` event's `errorInternal` and the trace's `theorem.guardrail` `error`; `forClient` strips it. `egress.policy_failed` takes no values, so an override using `{detail}` shows it literally |
| React handler `onError` returning the user message, its generic fallback | `onError` only reports; the user reads `publicError` wording from the profile lexicon (`session.sign_in`, `session.gate_expired`, `session.turn_ended`, `error.<kind>`) |
| React handler 409 (stale approval, finished turn), 415 (not JSON) | 400 (`request` kind) |
| Hard-coded taint / repair / tool-failure strings | Lexicon keys (`taint.*`, `repair.*`, `tool.*`, `session.*`, …) |

## Composer labels are semantic keys

The repo-private `src/interface/` layer emits `ComposerPrimaryAction` /
`ComposerMenuAction` keys only (`send` / `stop` / `queue` / …). English labels
live in the React package's default UI (`@theoremai/react/ui`), as
`@theorem.composer.menu.*` lines in `THEOREM_UI_CATALOG`. Neither surface is
published for now.

## React: headless hooks, failures, and default wording

The headless React layer (`client/`, `hooks/`, `components/`, `server/`) holds
no English. It reports kinds, codes, and states; the profile's lexicon words
failures; the default UI (`@theoremai/react/ui`) words its own chrome, and a
builder with their own UI owns every line.

| Was | Now |
| --- | --- |
| `useTheoremChat` → `error`, `errorInternal`; `useTheoremInterface` → `error` | `failure: ClientFailure \| null` (`{ error, errorKind, errorInternal? }`); `error` is the profile lexicon's wording |
| Composer drop notices (`attachmentsDroppedMessage`, `imagesDroppedMessage`) | `issues: AttachmentValidationIssue[]` (`too_many_files`, `too_many_images`); word each with `attachmentIssueText(issue, iface.lexicon)` from `@theoremai/agents` |
| `attachmentIssueText` from `@theoremai/react` | `attachmentIssueText` from `@theoremai/agents` (kernel) |
| `liveStateLabel` (client) | `liveState(args)` → `LiveState` key; the default wording is `@theorem.live.state.*` in `ui/labels` |
| Live runner `error`, `stateLabel` | `failure`, `liveState`, `activeTool` |
| Composer voice `voiceError` | `failure: VoiceFailure` (`code`: `unsupported` / `permission` / `unavailable` / `failed` / `empty` / `too_many_files`) |
| `workStatusLabel`, drawer `label`, hint `message` / `actionLabel` | `workStatus` → `{ phase, elapsedMs? }`, drawer `parts`, hint `id`; wording in `ui/labels` (`@theorem.transcript.work*`, `@theorem.composer.drawer.*`, `@theorem.composer.hint.*`) |
| `voiceLabelFromMime`, `voiceFormatLabel` | `voiceFormatFromMime` → format or `undefined`; the default UI words it with `@theorem.voice_note.name` / `.unnamed` |
| Default UI chrome constants (`COMPOSER_PRIMARY_LABELS`, `COMPOSER_MENU_ACTION_LABELS`, `COMPOSER_HINT_LABELS`, `VOICE_NOTE_LABEL`, …) | `THEOREM_UI_CATALOG` (`@theorem.*` Astryx i18n keys); replace any line, and Astryx's own `@astryx.*` lines, with the `labels` prop on `TheoremChat` / `LiveRunner` |
| Playground transports' `failureLabel` option | Removed; failures carry their kind |
| `TheoremStreamError(message, …)` | `TheoremStreamError(kind, publicMessage?, internalMessage?)` |
| Handler stream `{ type: 'error', error }` | `{ type: 'error', error, errorKind }`, as on every error reply |
| A Live close after the provider's `goAway` (e.g. 1008 at the session limit) → `error` event, `error.unsupported` wording | `session` `ended` event, not an error: `session.message` (lexicon `live.session_ended`), `session.ended { cause, code, closedAfterMs, errorKind? }`, the raw close as `errorInternal`; `LiveSessionClient` `onSessionEnded`; `LiveRunner` shows the line |

`ProfileInterface.lexicon` carries the profile's overrides for the keys a
browser words (`CLIENT_LEXICON_KEYS`), resolved on the host; the rest stay on
the host. `clientFailure(err, lexicon)` keeps a host-worded failure's wording
and words a local one from that lexicon.

## Attachment validation is structured

```diff
- tooManyFilesMessage(maxFiles) // English
+ AttachmentValidationIssue { code: 'too_many_files', params: { maxFiles } }
```

One check, in the kernel: `attachmentIssues` returns every issue (a file's names
it), `attachmentIssueCopy` maps one to its lexicon line. The kernel refuses a
turn with one `input` error carrying a line per issue; the interface's
`validateProfileInputs` runs the same check.

```diff
- assertAttachmentLimits(files, limits)          // first problem only
- sanitizeTurnBlobs(attachments, voice, limits)
- sanitizeTurnBlobsForProfile(profileId, attachments, voice)
+ assertTurnAttachments(profile, attachments, voice) // every problem
+ sanitizeTurnBlobs(profile, attachments, voice)
```

`TheoremError.copy` / `errorCopy` may be a list; `publicError` joins its lines.

## Invariant

See `docs/contracts/kernel.md` → **Facts and policy** (P1–P4) and the
README Package Boundary section.
