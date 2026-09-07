# Playground (`theorum/playground`)

Optional fixtures and helpers for the THEORUM web playground and smoke tests.
Hosts that do not ship a graph editor can ignore this entrypoint entirely.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/playground` |
| Module | `src/playground/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/playground/mod.ts` | Public barrel |
| `src/playground/types.ts` | Serializable facet seed types (kernel schema unions) |
| `src/playground/stub.ts` | JSON Schema → stub output helper |
| `src/playground/demo-handlers.ts` | Local function-tool handlers for the travel demo |
| `src/playground/concierge-demo.ts` | Travel concierge demo seeds (tools, inputs, system prompt) |

## Role in the package

| Concern | Kernel | Playground |
| --- | --- | --- |
| Tool registration | `registerTool`, `HttpToolDef`, `McpToolDef` | Demo seeds compile into those shapes in the host UI |
| Schema unions | `CustomToolType`, `HttpMethod`, `PlaygroundAuthType`, … | Seeds and types import from `theorum/schema` only |
| Demo content | Not bundled into core profiles | `demoToolSpecs`, `demoInputsSpec`, `DEMO_CONCIERGE_SYSTEM` |
| Function stubs | Host `handler` on `registerTool` | `playgroundDemoHandler` + `stubOutputFromSchema` |

The playground package is **not** imported by the kernel runner. It exists so
demo graphs, smoke scripts, and the frontend playground share one typed source
of truth instead of duplicating URLs, JSON schemas, and handler logic.

## Demo graph seeds

| Export | Content |
| --- | --- |
| `demoToolSpecs()` | HTTP, MCP, and function tool facet seeds for the travel concierge graph |
| `demoInputsSpec()` | Text, attachments, and voice limits for the demo inputs facet |
| `DEMO_CONCIERGE_SYSTEM` | Agent system prompt |
| `DEMO_ALLOWED_HOSTS` | Egress allowlist host string for guardrails (includes `api.frankfurter.dev` for live FX) |
| `DEMO_HTTP_SAMPLE_INPUT` | Sample payloads for HTTP demo tool connection tests |
| `demoHttpSampleInput` | Lookup sample input by demo HTTP tool name |

```ts
import { demoToolSpecs, demoInputsSpec } from 'theorum/playground';

const tools = demoToolSpecs(); // PlaygroundToolSeed[]
const inputs = demoInputsSpec(); // PlaygroundInputsSpec
```

## Exported API

| Export | Role |
| --- | --- |
| `demoToolSpecs` | Travel concierge tool facet seeds (`PlaygroundToolSeed[]`) |
| `demoInputsSpec` | Inputs facet seed (`PlaygroundInputsSpec`) |
| `DEMO_CONCIERGE_SYSTEM` | System prompt for the demo agent |
| `DEMO_ALLOWED_HOSTS` | Egress allowlist hosts (comma-separated) |
| `DEMO_HTTP_SAMPLE_INPUT` | Sample HTTP tool inputs for smoke / connection tests |
| `demoHttpSampleInput` | Lookup sample input for a demo HTTP tool name |
| `playgroundDemoHandler` | Lookup local demo function handler by tool name |
| `stubOutputFromSchema` | Build a stub object from a JSON Schema `properties` map |
| `PlaygroundDemoHandler` | Handler function type |
| `PlaygroundToolSeed`, `PlaygroundToolSpecSeed`, `PlaygroundInputsSpec` | Seed types |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/playground/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/playground/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Role in the package": {
      "supports": [
        { "kind": "source", "path": "src/playground/types.ts" },
        { "kind": "contract_test", "path": "tests/playground/mod.test.ts" }
      ]
    },
    "Demo graph seeds": {
      "supports": [
        { "kind": "source", "path": "src/playground/concierge-demo.ts" },
        { "kind": "contract_test", "path": "tests/playground/mod.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/playground/mod.ts" },
        { "kind": "doc", "path": "docs/contracts/playground.md" }
      ]
    }
  }
}
```
