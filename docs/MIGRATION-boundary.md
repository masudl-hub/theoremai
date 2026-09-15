# Migration: ownership boundary ("Host decides, Theorum runs")

Breaking cut. No deprecation aliases.

## Removed: `theorum/playground` entrypoint

Demo fixtures moved to the **repo-private** package `@theorum/playground`
(`playground/` in the theorum repo). It is never published.

```diff
- import { demoToolSpecs } from 'theorum/playground';
+ import { demoToolSpecs } from '@theorum/playground';
```

Hosts link it with `"@theorum/playground": "file:../theorum/playground"`.
`PLAYGROUND_AUTH_TYPES` / `PlaygroundAuthType` remain on `theorum/schema`
(authoring vocabulary, not demo product).

## Removed: `quotaMessage`

```diff
- quotaMessage(profile) // "Enjoying ${handle}? You've reached today's limit"
+ quotaExhausted(profile)
+ // → { code: 'quota_exhausted', perDay, message? }
```

`message` is present only when the host set `guardrails.quota.message`.
No English fallback in the kernel.

## Lexicon + overridable mechanism copy

User- and model-visible defaults live in `src/guardrails/lexicon.ts`.
Hosts override process-wide with `overrideLexicon({ … })`.

| Was | Now |
| --- | --- |
| Hard-coded `CONTINUE_INSTRUCTION` only | Profile `turnBehaviour.resumption.continueInstruction` (optional) or lexicon |
| Hard-coded canary bind note | `guardrails.canary.bindNote` (must keep `{canary}`) or lexicon |
| Hard-coded taint / public error / repair / tool-failure strings | Lexicon keys (`taint.*`, `public.*`, `repair.*`, `tool.*`, `session.*`, …) |

## Composer labels are semantic keys

`theorum/interface` emits `ComposerPrimaryAction` / `ComposerMenuAction` keys
only (`send` / `stop` / `queue` / …). English labels live in `@theorum/react`
(`COMPOSER_PRIMARY_LABELS`, `COMPOSER_MENU_ACTION_LABELS`).

## Attachment validation is structured

```diff
- tooManyFilesMessage(maxFiles) // English
+ AttachmentValidationIssue { code: 'too_many_files', params: { maxFiles } }
```

`@theorum/react` renders via `attachmentIssueText` (lexicon defaults).
Hosts may render codes themselves.

## Invariant

See `docs/contracts/kernel.md` → **Facts and policy** (P1–P4) and the
README Package Boundary section.
