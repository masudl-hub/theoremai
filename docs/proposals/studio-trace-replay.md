# Studio: import and replay a trace

Status: built. Studio only; evals and the kernel are unchanged.

**Reader:** a Theorem maintainer, and Masud.
**Job:** say how the studio imports a recorded conversation, and how it runs one again through the profile as it is now.
**After reading:** you know what a builder gets, where it stops, and every part of the code it touches.

## 1. What a builder gets

1. **Import a trace.** **Import trace** in the chat pane header opens the trace console, in the frame a decision and a host use. Its trace card takes a `TraceRecord` file (`.json`, one record or an array). The conversation card draws the conversation as the person received it, and its records go into the pane's trace feed, so the inspector shows every guardrail hit, gate and stop as it happened. Nothing runs. It answers "what happened, and why".
2. **Replay it.** **Replay** runs the trace's user turns again through the profile in the editor: its guardrails, stages, gates and UI all run. The model's replies, and by default the tools' results, come from the recording. It answers "what would happen now". Change a guardrail or the instructions, press **Replay again**, compare with **Recorded / Replayed**.
3. **Divergence stops and says so (decision d).** When the profile asks for something the recording does not hold, the replay stops there with a banner that says why, and a **Continue live** button.
4. **Download a trace.** **Download trace** beside View trace writes the run's `TraceRecord`s as `<agent>-<time>.trace.json`. A hosted app's traces (a `TraceSink`) open the same way.

## 2. The format: `TraceRecord`, nothing new

`TraceRecord` (`src/observability/trace-schema.ts`, checked by `traceRecordSchema`) is already the standard: evals grade it and the studio shows it. Replay reads from it:

- **Each user turn:** the root `invoke_agent` span's input.
- **What the person received:** the same span's output, used to draw an imported trace.
- **Each model call, in order:** `chat` spans with `gen_ai.output.messages`, and the stop in `theorem.stop.kind`.
- **Each tool result:** `execute_tool <name>` spans with `gen_ai.tool.call.result`.
- **Guardrail decisions:** the events the inspector already reads.

Content is stored by hash; `inlineContent` reads it back. A call whose content was not recorded, or was redacted, cannot be replayed: it is a divergence (section 4).

## 3. How replay runs

### 3.1 The model and the tools

`studio/replay.ts`:

- `parseTraceFile(text)`: the records in a file, each checked against `traceRecordSchema`; a file that is not a trace says which record failed.
- `replayScript(records)`: the ordered user turns and, for each, its model calls (output parts, stop) and tool results, by agent.
- `createReplay(script, agent, onDiverge)`: a `provider` whose `complete` yields the next recorded call as `ModelEvent`s, and `toolHandlers` that answer each tool from the recording, by name, in order. `startTurn(n)` sets the turn; a turn set again goes on where it stopped, so a reply that waited on a gate resumes.
- `recordedPayload(payload)`: every custom tool, the dependencies' included, registered as a plain function tool, so http and mcp tools answer from the recording too.
- `recordedTranscript(script)`: the blocks the person received, for the opened view and for Continue live.

A **Live tools** switch runs the real tools instead; the recorded model calls still answer.

### 3.2 It always runs in the page

A replay reaches no model, so it needs no keys and no spend. It always runs in the page, on `createBrowserStudioTransport` with a `byok` runtime whose `provider` is the replay, on the demo site and on `theorem studio` alike. The page's trace feed records it, so the inspector shows the replayed run.

### 3.3 Sending the turns

Replay sends each recorded user turn through the chat's `sendText`, one after another, waiting for each reply. A turn the profile holds on a gate waits with **Continue replay**: answer the gate, then continue. A turn the person sent with files cannot be replayed (the trace keeps no file bytes); the replay stops there.

## 4. Divergence (decision d)

The replay stops a turn, and the banner shows why and where (turn, call), when:

1. the profile makes **more model calls** than the recording holds for this turn;
2. the request **offers no tool** that the recorded output calls (a tool was removed or renamed);
3. the recorded call's **content is missing** (not recorded or redacted).

Fewer calls is not a divergence: that is the result (a guardrail now blocks earlier). Instructions or wording that changed are not compared; the recording's replies stand. The kind of the request's last message is not compared either: a tool result where the recording had one is caught by rule 1 or 2 when it matters.

**Continue live** goes on from the turn that stopped, not the call. It starts a live conversation on the blocks recorded before that turn, then sends that turn's message to the profile's real model. In the page that conversation is sealed where the live chat keeps its own (`startBrowserStudioConversation`); on the demo site's lent keys it goes through `POST /api/studio/conversation/start` (`startStudioConversation`, `fetchStarted`), which keeps it in the visitor's session and spends as any live turn does.

Compaction calls and sub-agent turns go through the same `provider`. One the recording ordered differently is caught as a divergence; it is not reordered.

## 5. Studio UI

- **Chat pane header:** **Import trace** for chat profiles, pressed while its console is open, and **Download trace** beside View trace (hidden while testing or importing). View trace drives the console's inspector, as it does a decision's.
- **The trace console** replaces the chat, on `ConsoleFrame` as a decision and a host are: a **Trace** card (`RequestCard`: the file drop, the file name, agent, turns and when it was recorded, **Live tools**, and a `RunBar` with **Replay**), then a **Conversation** card (`ResponseColumn` with `ChatTranscript`). A banner in the trace card says when the trace's agent is not the one selected, or when it holds no turns.
- **A replay** runs in the conversation card, under a status banner: running, waiting on a gate, stopped on missing files, diverged or failed (with **Continue live**), done.
- **Compare:** after a replay, **Recorded / Replayed** in the trace card's heading switches the conversation, and the inspector's records, between the two. Side by side is later.

The view is loaded lazily (`studio/ui/studio-trace-replay.tsx`). All of it uses Astryx and the existing chat and trace components.

## 6. Removed

The site's dev-only model tape, and its uses in the site's studio turn.

## 7. Later, not in this plan

- Other formats: a kernel cassette and chat formats (OpenAI/Anthropic messages, a Theorem transcript) converted to a replay script. Chat formats hold only final replies, so they replay at reply level.
- Continue live from the call that diverged, not the turn.
- Evals: `runSuite({ replay })` on the same `replayScript`, and "Save as eval case" from the studio.
- Side-by-side compare.

## 8. Verification

- **Tests:** `tests/studio/replay.test.ts` (readback, same-profile replay, a removed tool, more calls than recorded, files, missing content, a failed turn, recorded tools, `parseTraceFile`, turn resume); `tests/studio/draft-handler.test.ts` (the start route on lent keys, and 404 without).
- **Studio, in the browser:** download a run’s trace and import it; replay it unchanged; turn Live tools on; remove a tool the recording calls and Continue live; dark and light.
