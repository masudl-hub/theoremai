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

The repo-private `src/interface/` layer emits `ComposerPrimaryAction` /
`ComposerMenuAction` keys only (`send` / `stop` / `queue` / …). English labels
live in the repo-private React package (`COMPOSER_PRIMARY_LABELS`,
`COMPOSER_MENU_ACTION_LABELS`). Neither surface is published for now.

## Attachment validation is structured

```diff
- tooManyFilesMessage(maxFiles) // English
+ AttachmentValidationIssue { code: 'too_many_files', params: { maxFiles } }
```

`@theoremai/react` renders via `attachmentIssueText` (lexicon defaults).
Hosts may render codes themselves.

## Invariant

See `docs/contracts/kernel.md` → **Facts and policy** (P1–P4) and the
README Package Boundary section.
