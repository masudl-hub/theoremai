# @theoremjs/studio (repo-private)

The studio's authoring logic and demo fixtures: the editable profile draft,
its tree, the compiler that turns it into a kernel profile, TypeScript source
export, the travel concierge demo (tool seeds, sample HTTP inputs, local
function handlers), and the run-tab handoff.

The logic lives here, not in the frontend, so it is type-checked and tested
against the kernel it compiles for.

This package is **never published**. The kernel's boundary rule — "Host
decides, Theorem runs" — forbids bundled assistants and demo product in the
`@theoremjs/agents` package; `scripts/verify-publish-bundle.ts` asserts `studio/`
stays out of every npm/JSR artifact. Consumers link it directly, e.g.

```json
{ "@theoremjs/studio": "file:../theoremai/studio" }
```

## Surface (`mod.ts`)

| Export | Purpose |
| --- | --- |
| `StudioDraft`, `createBlankDraft()`, `createExampleDraft()` | Editable profile draft; blank, or the travel concierge |
| `createLiveExampleDraft()`, `createNarratorExampleDraft()`, `createConsoleExampleDraft()`, `createArchitectWorkspace()` | The other examples: the concierge as a live agent, a speech narrator, a host tool console, and a code architect that calls the narrator through an agent tool |
| `setProfileType()`, `includeFacet()`, `excludeFacet()`, `newModelBinding()`, `newToolSpec()` | Draft edits that keep it consistent with `PROFILE_GRAPH` |
| `studioTree()`, `studioNodeRef()`, `modelBindingNodeId()`, `toolSpecNodeId()` | The draft as a tree; node ids that issues point at |
| `compileStudio()` | Draft → profile definition, custom tools, structured schema; or issues keyed by node |
| `studioSource()` | Compiled draft as a TypeScript module (`registerTool`, `defineProfile`, `registerProfile`) |
| `modelBindingViolation()`, `GEMINI_STUDIO_MODELS`, … | Which models and built-in tools the public studio allows |
| `zodFromJsonSchema()`, `parseJsonSchema()` | Authored JSON Schema → Zod for registration |
| run-payload helpers, `studioRunDefines()`, `clearStaleStudioRuns()` | Handoff of a compiled draft to the run tab, whether a kept run still defines on this package, and clearing the ones that do not |
| `createStudioTransport()`, `studioInterface()` | The run tab's transport for a compiled draft; its `traces` feed receives the records each run writes |
| `runGuardrailProbes()`, `runGuardrailProbe()`, `probeDraft()`, `PROBE_BOUNDARIES`, `PROBE_BOUNDARY_NOTES`, `PROBE_STATUSES` | Test a draft's guardrails: send one text across every boundary, or across one, on a scripted model. Each boundary answers with a status (passed, flagged, redacted or blocked), whether its turn was tainted by a remote read, the guardrail events, what went on past the boundary, and the turn's trace records. No model or host is called. Each boundary's note says what crosses it, when the kernel reads it and what the kernel does there |
| `PROBE_BATTERY` | Hard texts to probe with: disguised attacks and harmless texts that look like attacks, each with the boundary it crosses and whether a guardrail should act on it |
| `createStudioTraceRouter()`, `STUDIO_RUN_METADATA_KEY`, `StudioTraceLine` | Trace delivery: the server registers the router's sink for `STUDIO_TRACE_DESTINATION`; each run opens a route and passes its metadata, and gets back `{ type: 'trace', record }` lines (after a text run's events, or on the Live socket as each record is written) |
| `demoToolSpecs()`, `demoInputsSpec()` | Every example tool seed, and the inputs facet seed |
| `DEMO_CONCIERGE_SYSTEM`, `DEMO_ALLOWED_HOSTS` | Demo system prompt and egress allowlist |
| `DEMO_HTTP_SAMPLE_INPUT`, `demoHttpSampleInput()` | Connection-test payloads for demo HTTP tools |
| `studioDemoHandler()`, `StudioDemoHandler` | Local function-tool handlers (unit conversion, haversine, …) |
| `stubOutputFromSchema()` | Generic stub object from a JSON Schema |
| `StudioInputsSpec`, `StudioToolSeed`, `StudioToolSpecSeed` | Serializable seed shapes |

Generic authoring vocabulary the kernel schema owns (`STUDIO_AUTH_TYPES`,
`StudioAuthType`, `studio.*` field metadata) stays in `@theoremjs/agents/schema`.

Tests live in the main repo: `tests/studio/`.
