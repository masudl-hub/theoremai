# @theoremjs/playground (repo-private)

The playground's authoring logic and demo fixtures: the editable profile draft,
its tree, the compiler that turns it into a kernel profile, TypeScript source
export, the travel concierge demo (tool seeds, sample HTTP inputs, local
function handlers), and the run-tab handoff.

The logic lives here, not in the frontend, so it is type-checked and tested
against the kernel it compiles for.

This package is **never published**. The kernel's boundary rule — "Host
decides, Theorem runs" — forbids bundled assistants and demo product in the
`@theoremjs/agents` package; `scripts/verify-publish-bundle.ts` asserts `playground/`
stays out of every npm/JSR artifact. Consumers link it directly, e.g.

```json
{ "@theoremjs/playground": "file:../theoremai/playground" }
```

## Surface (`mod.ts`)

| Export | Purpose |
| --- | --- |
| `PlaygroundDraft`, `createBlankDraft()`, `createExampleDraft()` | Editable profile draft; blank, or the travel concierge |
| `setProfileType()`, `includeFacet()`, `excludeFacet()`, `newModelBinding()`, `newToolSpec()` | Draft edits that keep it consistent with `PROFILE_GRAPH` |
| `playgroundTree()`, `playgroundNodeRef()`, `modelBindingNodeId()`, `toolSpecNodeId()` | The draft as a tree; node ids that issues point at |
| `compilePlayground()` | Draft → profile definition, custom tools, structured schema; or issues keyed by node |
| `playgroundSource()` | Compiled draft as a TypeScript module (`registerTool`, `defineProfile`, `registerProfile`) |
| `modelBindingViolation()`, `GEMINI_PLAYGROUND_MODELS`, … | Which models and built-in tools the public playground allows |
| `zodFromJsonSchema()`, `parseJsonSchema()` | Authored JSON Schema → Zod for registration |
| run-payload helpers, `playgroundRunDefines()` | Handoff of a compiled draft to the run tab, and whether a kept run still defines on this package |
| `createPlaygroundTransport()`, `playgroundInterface()` | The run tab's transport for a compiled draft; its `traces` feed receives the records each run writes |
| `runGuardrailProbes()`, `runGuardrailProbe()`, `probeDraft()`, `PROBE_BOUNDARIES`, `PROBE_BOUNDARY_NOTES`, `PROBE_STATUSES` | Test a draft's guardrails: send one text across every boundary, or across one, on a scripted model. Each boundary answers with a status (passed, flagged, redacted or blocked), whether its turn was tainted by a remote read, the guardrail events, what went on past the boundary, and the turn's trace records. No model or host is called. Each boundary's note says what crosses it, when the kernel reads it and what the kernel does there |
| `PROBE_BATTERY` | Hard texts to probe with: disguised attacks and harmless texts that look like attacks, each with the boundary it crosses and whether a guardrail should act on it |
| `createPlaygroundTraceRouter()`, `PLAYGROUND_RUN_METADATA_KEY`, `PlaygroundTraceLine` | Trace delivery: the server registers the router's sink for `PLAYGROUND_TRACE_DESTINATION`; each run opens a route and passes its metadata, and gets back `{ type: 'trace', record }` lines (after a text run's events, or on the Live socket as each record is written) |
| `demoToolSpecs()`, `demoInputsSpec()` | Travel concierge tool + inputs facet seeds |
| `DEMO_CONCIERGE_SYSTEM`, `DEMO_ALLOWED_HOSTS` | Demo system prompt and egress allowlist |
| `DEMO_HTTP_SAMPLE_INPUT`, `demoHttpSampleInput()` | Connection-test payloads for demo HTTP tools |
| `playgroundDemoHandler()`, `PlaygroundDemoHandler` | Local function-tool handlers (unit conversion, haversine, …) |
| `stubOutputFromSchema()` | Generic stub object from a JSON Schema |
| `PlaygroundInputsSpec`, `PlaygroundToolSeed`, `PlaygroundToolSpecSeed` | Serializable seed shapes |

Generic authoring vocabulary the kernel schema owns (`PLAYGROUND_AUTH_TYPES`,
`PlaygroundAuthType`, `playground.*` field metadata) stays in `@theoremjs/agents/schema`.

Tests live in the main repo: `tests/playground/`.
