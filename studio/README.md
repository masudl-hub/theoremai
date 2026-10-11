# @theoremjs/studio (repo-private)

The studio's authoring logic and demo fixtures: the editable profile draft,
its tree, the compiler that turns it into a kernel profile, TypeScript source
export, the travel concierge demo (tool seeds, sample HTTP inputs, local
function handlers), and the run-tab handoff.

The logic lives here, not in the frontend, so it is type-checked and tested
against the kernel it compiles for.

Studio runs resolve their models through an isolated kernel scope's provider registry.
Provider host options can set `limits` for deadlines and upstream output. Studio uses the same kernel enforcement.
The runtime resolves only own entries in the host's provider vault. Inherited credentials and resolvers are unavailable.
Scripted live guardrail probes supply fixture credentials only for the selected model's primary and fallback slots.
Registered adapters can use object methods or class prototype methods. The kernel retains their method receivers for the run.
Replacing a scope registration affects later runs. It does not replace an active run's captured adapter contract.

Exported agent handoffs ask the builder to supply shared atomic session storage when deployment uses several server instances.
The React handler's session contract uses `load` and `compareAndSwap`. Tool credentials use a separate store.
Exported React handlers apply finite session limits before accepting new execution claims.
Builders can set `sessionLimits` and `operationRetentionMs` in the host handler options.
These settings are host code; they do not enter the exported profile.
The handler stores version 3 operation records. It retains unresolved claims instead of restoring approvals after dispatch.
A trusted `StudioRuntime.execution` service can supply the same kernel coordination contract to Studio turns, invokes, and host calls.
New operation claims retain accepted request data and final prepared input through `SavedToolInvocation`.
Its `lookup` method checks saved operations before preparation hooks. It must enforce current resource access before returning saved results.
The default authoring runtime supplies no durable execution store. Browser replay cannot supply this service.
Studio turn replay and live answers preserve both the call ID and the kernel-issued operation ID.
Browser replay entries use operation IDs as keys. Live timers check the same reference before they stop.
A live relay can use `createTheoremSessionBoundary` with its authenticated session resolver and atomic store.
Pass its `toolExecution` to the kernel. Use `beforeEvent` to save checkpoint ownership before browser delivery.
A failed ownership write stops delivery of that checkpoint.
Live page callbacks wait for a claimed dispatch grant. Permission and sign-in decisions precede the grant.
The grant carries final prepared arguments. The relay routes its correlated result to the session boundary.
The local browser runtime supplies memory coordination and result delivery for its own authoring session.
Text and host browser transports retain the same execution authority.
Its authority remains in that browser. It does not provide recovery after a browser restart.
Text and live browser transports save checkpoint ownership before delivery and check it before resumption.
Runtime methods retain their original receiver, including methods that read private class fields.
An injected runtime coordinator also needs a paired `pageExecution` service when browser tools require it.
For a custom protocol in a host-supplied authoring runtime, pass definitions through `StudioRuntime.providerDefinitions`.
The runtime registers these definitions before profiles. They remain host code and never enter saved profile JSON.
The public demo retains its separate provider policy.

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
