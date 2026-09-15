# @theorum/playground (repo-private)

Demo fixtures for hosts developing against theorum: the travel concierge demo
graph seeds, sample HTTP inputs (Open-Meteo, Nominatim, Frankfurter, …), local
function handlers, and JSON Schema stub generation.

This package is **never published**. The kernel's boundary rule — "Host
decides, Theorum runs" — forbids bundled assistants and demo product in the
`theorum` package; `scripts/verify-publish-bundle.ts` asserts `playground/`
stays out of every npm/JSR artifact. Consumers link it directly, e.g.

```json
{ "@theorum/playground": "file:../theorum/playground" }
```

## Surface (`mod.ts`)

| Export | Purpose |
| --- | --- |
| `demoToolSpecs()`, `demoInputsSpec()` | Travel concierge tool + inputs facet seeds |
| `DEMO_CONCIERGE_SYSTEM`, `DEMO_ALLOWED_HOSTS` | Demo system prompt and egress allowlist |
| `DEMO_HTTP_SAMPLE_INPUT`, `demoHttpSampleInput()` | Connection-test payloads for demo HTTP tools |
| `playgroundDemoHandler()`, `PlaygroundDemoHandler` | Local function-tool handlers (unit conversion, haversine, …) |
| `stubOutputFromSchema()` | Generic stub object from a JSON Schema |
| `PlaygroundInputsSpec`, `PlaygroundToolSeed`, `PlaygroundToolSpecSeed` | Serializable seed shapes |

Generic authoring vocabulary the kernel schema owns (`PLAYGROUND_AUTH_TYPES`,
`PlaygroundAuthType`, `playground.*` field metadata) stays in `theorum/schema`.

Tests live in the main repo: `tests/playground/`.
