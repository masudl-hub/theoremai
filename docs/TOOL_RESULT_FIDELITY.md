# THEOREM — Tool-result multimodal fidelity

> **Type:** Spec · current  
> **Status:** Complete  
> **Scope:** `src/kernel` + `src/providers` (kernel tools, runner history, provider adapters)  

## 1. Goal

Tool results keep the same part fidelity as user input. If a tool returns text, image, audio, video, or document parts, the next model round sees those as media parts — not a JSON string with base64 stuffed into `content`.

## 2. Non-goals

- New part kinds beyond `InteractionPart` (`text` | `image` | `audio` | `video` | `document`)
- Changing host product tools except to emit `parts` (hosts opt in per tool)
- URI / `file_id` indirection (inline `mimeType` + `data` remains the contract)
- Inventing live-session media semantics beyond what Gemini Live `functionResponses` can carry

## 3. Contract

### 3.1 `ModelToolResult`

```ts
interface ModelToolResult {
  finding: string;
  /** Lean JSON for reasoning — must not contain media bytes. */
  data?: unknown;
  /** Multimodal tool-result parts (text and/or media). */
  parts?: InteractionPart[];
}
```

### 3.2 Host tool output → projection

`projectForModel`:

1. Read `finding` as today.
2. If `output.parts` is a non-empty array of valid `InteractionPart`s, set `ModelToolResult.parts`.
3. Set `data` to the output object **with `parts` removed** (and any other host-only keys the host already strips). Never JSON-serialize media bytes into `data`.

### 3.3 History

`TurnHistoryMessage` for `role: 'tool'`:

| Field | Meaning |
|-------|---------|
| `content` | Text projection: `finding` + lean `data` (no media bytes) |
| `parts` | Full `InteractionPart[]` when present |

Adapters must prefer `parts` when wiring the provider; `content` is the text fallback / transcript summary.

### 3.4 `formatToolResult`

Remains the **text** projection for `content` and for adapters that only accept strings. It must never embed `parts[].data`.

## 4. Adapter mapping

| Adapter | Behavior |
|---------|----------|
| **Google Interactions** | `function_result.result` = `parts.map(wireInteractionPart)` (shared with live continuation); if no parts, `[{ type: 'text', text: content }]` |
| **OpenRouter / AI SDK** | Tool message `output`: multimodal `content` value when `parts` present; else `{ type: 'text', value: content }` |
| **OpenAI-compat REST** | Tool `content`: if `parts` present, wire via the same multimodal content mapper as user messages (text / image_url / input_audio / file-equivalent); else string `content` |
| **Gemini Live** | Keep JSON `response: { result }` from tool output; Live function responses are structured JSON, not multimodal turns. Do not pretend Live can inline tool media the same way. Text finding/data still flow. |

## 5. Compaction

When folding history to text for compaction, represent non-text parts as markers (`[image]`, `[audio]`, `[video]`, `[document]`) instead of silent empty strings.

## 6. Invariants

1. Media bytes travel only on `parts`, never inside stringified `data` / `content`.
2. Text-only tools unchanged (`parts` omitted).
3. Invalid / unknown part shapes are dropped at projection (do not throw the turn).
4. Provider wire limitations are named in §4 — no silent empty media parts for video/document on OpenAI-compat (map to file-equivalent or explicit text marker).

## 7. Tests

- `projectForModel` lifts `parts`, strips them from `data`
- `formatToolResult` ignores part bytes
- History append sets `content` + `parts`
- Round-trip: `projectForModel` → history → Google / AI SDK / OpenAI-compat wire
- Google Interactions `function_result` uses `wireInteractionPart`
- AI SDK `toolResultMessage` multimodal vs text-only
- Compaction markers for media parts
