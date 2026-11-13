# Guardrails coverage

Use this page to find out how Theorem's detectors read text at each boundary, and what crosses with no check. It shows methods only. The action at each cell is the builder's choice, so actions and defaults are not on this page. Scores for each cell are in the benchmark docs on the `guardrails-bench` branch.

When this page and the code disagree, the code is right. Each name in a code span exists in the code, and `node scripts/docs-claims.mjs check docs/GUARDRAILS_COVERAGE.md` fails when one does not.

## Invariant

> **No data enters or leaves a Theorem agent without the ability to be checked and actioned.**

This is the invariant we build and audit against. Each item under [Gaps](#gaps) is a place where it does not hold yet.

The contract's current wording, in [`docs/contracts/guardrails.md#invariant`](contracts/guardrails.md#invariant), is narrower: it covers only what leaves. It will change once the gaps are closed or accepted.

## Terms

- **Boundary:** a place where the kernel reads text as it crosses. The list is `BOUNDARIES` in [`src/guardrails/boundaries.ts`](../src/guardrails/boundaries.ts), in the order a turn meets them.
- **Detector:** a check that finds one kind of text, such as an email address or the canary token. The list is `DETECTORS` in [`src/guardrails/detectors.ts`](../src/guardrails/detectors.ts).
- **Declared:** a detector is declared at a boundary when a builder can set an action for it there. `DETECTOR_BOUNDARIES` holds the declared boundaries for each detector. At a boundary that is not declared, the detector never runs.
- **Method:** how a detector finds a match. Every method on this page is a rule in code: a pattern, a checksum, an exact match, or a run of words. No detector uses a model.
- **Rewrite:** a second reading of the same text, such as the text with homoglyphs folded or base64 decoded. A match in a rewrite is mapped back to the stretch of the original text it came from.

## Matrix

Each cell names the method of a detector at a boundary, and links to its entry below. A dash means the detector is not declared there.

The columns group boundaries that read the same way:

- **Inbound** is every boundary in `INBOUND_BOUNDARIES`.
- Each tool column is one crossing for all four kinds in `TOOL_KINDS`.

The detectors are declared at the same boundaries in every group, and for every tool kind. A script that read `DETECTOR_BOUNDARIES` confirmed this.

| Detector | Inbound | `tool_arguments` | `tool_output` | `tool_failure` | `tool_shown` | `reply` | `reply_structured` | `live_reply` | `thought` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ids` | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) |
| `financial` | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) | [Checksums](#checksums) |
| `network` | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) |
| `credentials` | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) | [Secret rules](#secret-rules) |
| `email` | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) |
| `phone` | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) |
| `bank_account` | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) | [Patterns](#patterns) |
| `injection` | [Phrases](#phrases) | [Phrases](#phrases) | [Phrases and orders](#phrases-and-orders) | [Phrases and orders](#phrases-and-orders) | [Phrases](#phrases) | – | – | – | – |
| `canary_leak` | – | [Token forms](#token-forms) | – | – | – | [Token forms](#token-forms) | [Token forms](#token-forms) | [Token forms](#token-forms) | [Token forms](#token-forms) |
| `prompt_leak` | – | [Word runs](#word-runs) | – | – | – | [Word runs](#word-runs) | [Word runs](#word-runs) | [Word runs](#word-runs) | [Word runs](#word-runs) |
| `marker_leak` | – | – | – | – | – | [Markers](#markers) | [Markers](#markers) | [Markers](#markers) | [Markers](#markers) |
| `ungiven_images` | – | – | – | – | – | [Addresses](#addresses) | [Addresses](#addresses) | [Addresses](#addresses) | [Addresses](#addresses) |
| `ungiven_links` | – | – | – | – | – | [Addresses](#addresses) | [Addresses](#addresses) | [Addresses](#addresses) | [Addresses](#addresses) |
| `tool_leak` | – | – | – | – | – | [Names](#names) | [Names](#names) | [Names](#names) | [Names](#names) |

A builder can also add a detector of their own under `guardrails.detect`. See [Host detectors](#host-detectors). A host detector can be declared at every boundary.

`tests/guardrails/detect-matrix.test.ts` sends a match through every declared cell with every action, and checks that each detector stays silent at the boundaries it is not declared at.

## Methods

`detectAt` in [`src/guardrails/detect-at.ts`](../src/guardrails/detect-at.ts) is the one place where a match becomes an action. `theoremSpans` in the same file picks the method for each detector.

### Patterns

`ids`, `network`, `email`, `phone`, and `bank_account` read the text as written with regular expressions. Each method is the same at every boundary. The patterns are in [`src/guardrails/sensitive.ts`](../src/guardrails/sensitive.ts) and run through `sensitiveSpans`.

- `ids`: US SSN, ITIN, and EIN shapes (`SSN`, `ITIN`, `EIN`). It also finds any 9-digit form after a field name that says which ID it is (`SSN_CONTEXTUAL`, `ID_KEYED`).
- `network`: IPv4 addresses, and IPv6 in every RFC 4291 text form.
- `email`: ASCII addresses only (`EMAIL`). The top-level domain must start with a letter, so a package version such as `pkg@1.2.3` is not a match (`EMAIL_TLD`).
- `phone`: numbers by shape (`PHONE_SHAPES`), or any number after a phone label in one of six languages (`PHONE_LABELLED`). `phoneHit` drops an SSN or date shape. It also drops a number whose digit count is outside `PHONE_DIGITS_MIN` and `PHONE_DIGITS_MAX`.
- `bank_account`: a number only after a label that names an account (`ACCOUNT_LABEL`), with at least `ACCOUNT_DIGITS_MIN` digits.

### Checksums

`financial` uses patterns, then a check that the number is real:

- An IBAN must pass its ISO 13616 check digits (`ibanHit`).
- A card number must start with digits a card network issues, and pass the Luhn check (`cardHit`). A run of digits inside a web address is not a card.

### Secret rules

`credentials` uses gitleaks' rules, generated into [`src/guardrails/credential-rules.ts`](../src/guardrails/credential-rules.ts). [`src/guardrails/credential-scan.ts`](../src/guardrails/credential-scan.ts) applies each rule in four steps:

1. The rule's regular expression must match.
2. One of the rule's keywords must be in the text by the end of the match.
3. The secret's Shannon entropy must be above the rule's floor.
4. No allowlist may let the secret through.

The keyword must come before the match ends, so a reply read as it streams finds the same secrets as the reply read whole.

### Phrases

`injection` at the inbound boundaries, `tool_arguments`, and `tool_shown` runs `injectionSpans` in [`src/guardrails/injection.ts`](../src/guardrails/injection.ts). It matches injection phrasing in the text as written and in each rewrite of it:

- **Typo-folded:** a scrambled word, or one edit away from a target word, is read as the target.
- **Normalized:** invisible characters removed, unusual spaces made plain, and homoglyphs folded (`normalizeForDetection` in [`src/guardrails/normalize.ts`](../src/guardrails/normalize.ts)).
- **Decoded:** ROT13, leetspeak, and URL escapes.
- **Encoded blobs:** base64, hex, letters spaced apart, and words split by pipes.

### Phrases and orders

`injection` at `tool_output` and `tool_failure` reads everything [Phrases](#phrases) reads. It also runs `directives` in [`src/guardrails/tool-directives.ts`](../src/guardrails/tool-directives.ts), which finds orders aimed at the agent. `readersAt` turns this on where `isToolReturn` holds.

`directives` reports three kinds of order:

- An order or a claim of authority that names a destination before its clause ends. A destination is an email address or an `http` address.
- An order to set instructions aside.
- A sentence that names a tool the model can call this turn. The kernel passes these names from the turn's tool snapshot.

Directive words without a destination are common in real tool output, such as documentation. So a destination, or a callable tool's name, is needed for a match.

### Token forms

`canary_leak` finds the turn's canary token with `canaryLeakRanges` in [`src/guardrails/canary.ts`](../src/guardrails/canary.ts). `canaryLeakForms` lists the forms it reads:

- the token as written, reversed, and in ROT13, read character by character and word by word;
- its characters as hex or decimal codes;
- its base64, at every byte offset.

A run of `TOKEN_LEAK_RUN` characters of a form is a leak, so a truncated or split token is still found. Encoded forms have their own run lengths (`BASE64_LEAK_RUN`, `BYTE_CODE_LEAK_RUN`). When the model was given the token outside its system prompt, it is not read as a leak.

### Word runs

`prompt_leak` finds `PROMPT_ECHO_WORDS` consecutive words from a private stretch of the system prompt. It uses `promptEchoRanges` in [`src/guardrails/prompt-echo.ts`](../src/guardrails/prompt-echo.ts).

- Words are compared case-folded, after Unicode compatibility folding.
- Punctuation and markup between words are ignored, and bare numbers are skipped. So a dump reformatted as a list is still found.
- The prompt is also read backwards and in ROT13, and both the prompt and the reply are read with leetspeak decoded.
- Text the host marked shareable is not read, and no run reaches across it.

### Markers

`marker_leak` matches the kernel's own markers (`SYSTEM_BOUNDARY` in [`src/guardrails/egress-patterns.ts`](../src/guardrails/egress-patterns.ts)). These are the user-data fence tags and the start of the canary note. When the profile's labels change the canary note's words, the new words are matched too (`notePattern`).

### Addresses

`ungiven_images` and `ungiven_links` read the reply as a renderer reads it, in [`src/guardrails/egress-urls.ts`](../src/guardrails/egress-urls.ts). That covers markdown images and links, autolinks, HTML tags, and `<style>` blocks, with entities and escapes decoded.

An image or link is a match when two things are true:

- its address is not one the model was given this turn;
- its host is not one the builder allowed.

Reserved names such as `example.com` are never a match (`RESERVED_HOST`). The given addresses come from `givenUrlSets`.

When both detectors read a boundary, `ungiven_links` leaves an image's markup to `ungiven_images`.

### Names

`tool_leak` matches the names of the profile's own tools, each as a word on its own. It also matches parameter names in double quotes, as tool-call JSON writes keys. A parameter such as `city` outside quotes is not a match. The code is `toolLeakSpans` in [`src/guardrails/tool-leak.ts`](../src/guardrails/tool-leak.ts).

### Host detectors

A host detector reads with its own `patterns`, a `find` function, or both. Its patterns run on the text as written, with no rewrites. If `find` throws, or returns a span outside the text, the text does not cross. The code is `hostReader` in [`src/guardrails/detect-at.ts`](../src/guardrails/detect-at.ts).

A detector of Theorem's that takes patterns can also read with the host's patterns, beside Theorem's own or instead of them.

## How each boundary hands text to the detectors

The method is the same at every boundary a detector is declared at. What changes is which part of the data reaches the detectors, and when.

| Boundary | What is read | Code | Tests |
| --- | --- | --- | --- |
| `user`, `system`, `options`, `repair` | The message text; each system part; each option value; a repair's previous output, rejection, and guidance | `sanitizeTurnRequestWithEvents` in [`src/guardrails/sanitize.ts`](../src/guardrails/sanitize.ts) | `tests/guardrails/sanitize-events.test.ts` |
| `context` | Each sender's package, as text or as JSON | `sanitizeContext`; in Live, `prepareLiveContext` | `tests/kernel/turn-context.test.ts`, `tests/kernel/run-session.test.ts` |
| `history` | Each message's text, and its text parts | `sanitizeHistory` | `tests/guardrails/sanitize-events.test.ts` |
| `attachment`, `voice` | CSV, plain-text, and Markdown files, decoded. A CSV's formula cells are escaped first | `sanitizeAttachment` in [`src/kernel/registry/attachments.ts`](../src/kernel/registry/attachments.ts) | `tests/guardrails/sanitize-events.test.ts` |
| `injected` | A message the host injects during a turn | [`src/kernel/stages.ts`](../src/kernel/stages.ts) | `tests/kernel/stages.test.ts` |
| `live_user` | Text a Live session receives from the user | `prepareLiveInboundText` in [`src/kernel/engine/live-inbound.ts`](../src/kernel/engine/live-inbound.ts) | `tests/kernel/live-inbound.test.ts` |
| `tool_arguments_<kind>` | The whole call as it will be sent. Each draft is also read as it streams | `guardToolValue` in [`src/guardrails/tool-result.ts`](../src/guardrails/tool-result.ts); drafts: `createDraftGate` | `tests/guardrails/tool-boundary.test.ts`, `tests/kernel/agent-tool.test.ts` |
| `tool_output_<kind>` | What the model reads back, and the text parts it reads beside it | `guardResult` and `readTextParts` in [`src/kernel/tools/execute.ts`](../src/kernel/tools/execute.ts) | `tests/guardrails/tool-boundary.test.ts`, `tests/kernel/agent-tool.test.ts`, `tests/kernel/tools-execute-a.test.ts` |
| `tool_failure_<kind>` | The error message and its details, before the kernel frames them for the model | `guardFailure` in [`src/kernel/tools/execute.ts`](../src/kernel/tools/execute.ts) | `tests/guardrails/tool-boundary.test.ts`, `tests/kernel/agent-tool.test.ts`, `tests/kernel/tools-execute-c.test.ts` |
| `tool_shown_<kind>` | What the call shows the person: output, error, trace, and each part without a file's bytes | `showValue` and `showParts` in [`src/kernel/tools/execute.ts`](../src/kernel/tools/execute.ts) | `tests/kernel/tool-shown.test.ts`, `tests/kernel/tools-execute-a.test.ts`, `tests/kernel/tool-images.test.ts` |
| `reply` | The reply as it streams, then the whole reply | `createOutboundProgressiveGate`; whole: `readReply` in [`src/guardrails/detect-reply.ts`](../src/guardrails/detect-reply.ts) | `tests/kernel/detect-reply-turn.test.ts` |
| `reply_structured` | Each draft as it streams, then the whole value as JSON, keys included. A redact replaces the match in each string | `createDraftGate`; whole: `readValue` | `tests/kernel/detect-reply-turn.test.ts`, `tests/kernel/structured-draft-stream.test.ts` |
| `live_reply` | The transcript of the model's speech. Audio waits until its transcript is read, and audio with no transcript is dropped | `live-outbound-gate.ts` in [`src/guardrails/`](../src/guardrails/live-outbound-gate.ts) | `tests/guardrails/live-outbound-gate.test.ts` |
| `thought` | The model's reasoning as it streams. A leak is left out, and the rest of the thought is released. A thought never stops the turn | [`src/guardrails/thought-guard.ts`](../src/guardrails/thought-guard.ts) | `tests/kernel/canary-leak-report.test.ts` |

A streamed boundary reads the text as it grows. Text is held from the earliest place a match could still be under way. When the stream ends, the whole text is read again. The stream code is in [`src/guardrails/egress-stream.ts`](../src/guardrails/egress-stream.ts) and [`src/guardrails/progressive-yield.ts`](../src/guardrails/progressive-yield.ts).

## Gaps

Each gap is data that enters or leaves an agent with no detector reading it.

- **A tool's file bytes.** An image, audio, video, or document that a tool returns reaches the model and the person unread. `showParts` reads every other field of the part: `uri`, `mimeType`, and `metadata`. A text file that a tool returns as bytes is not decoded, but the same file sent as an attachment is.
- **Attachments other than text files.** Only CSV, plain-text, and Markdown attachments are read (`TEXT_MIMES`). Images, audio, PDFs, other files, and provider file references pass unread.
- **`voice` reads nothing in practice.** A voice clip is audio, and only text files are read. Nothing turns a clip into text for this boundary.
- **Live speech from the user.** The provider's transcript of what the user said is recorded in history, but no detector reads it. Text the user types in Live is read at `live_user`.
- **`history` replays more than text.** Tool calls, reasoning, metadata, and parts other than text pass unread.
- **Provider built-in tools.** A built-in tool has no tool kind. The provider runs it, and the kernel never reads its text.

## Keep this page true

This page is not in `docs/_map.mjs`, so `npm run lint:docs` does not check it for freshness. Before you change a detector or a boundary, run:

```bash
node scripts/docs-claims.mjs affected
```

If it lists this page, read the page against the new code.
