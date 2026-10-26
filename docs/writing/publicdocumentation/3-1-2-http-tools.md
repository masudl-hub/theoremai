# HTTP Tools

An `http` tool executes an HTTP request directly against an external REST endpoint without requiring custom handler code. Theorem validates inputs with Zod, serializes arguments into URL path or query parameters, and verifies response bodies against an output schema.

---

## Registering an HTTP Tool

Register HTTP tools using `registerTool()` with `type: 'http'`:

```ts
import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';

export const marineWeatherTool = registerTool({
  type: 'http',
  name: 'get_marine_weather',
  description: 'Retrieve current wave height, wind speed, and water temperature for a port.',
  category: 'maritime',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',

  endpoint: 'https://api.oceanweather.example/v1/ports/{portCode}/conditions',
  method: 'GET',

  mapping: {
    pathParams: ['portCode'],
    queryParams: ['units'],
  },

  limit: { requests: 60, windowMs: 60_000 },
  timeoutMs: 8000,
  maxResponseBytes: 1024 * 1024,

  input: z.object({
    portCode: z.string().describe('Three-letter port identifier'),
    units: z.enum(['metric', 'imperial']).default('metric'),
  }),

  output: z.object({
    waveHeightMeters: z.number(),
    windSpeedKnots: z.number(),
    waterTempCelsius: z.number(),
  }),
});
```

---

## Argument Mapping (`mapping`)

The `mapping` configuration defines where model-generated arguments are placed in the outgoing HTTP request:

* **`pathParams`**: Names arguments that replace `{name}` placeholders in `endpoint`.
* **`queryParams`**: Names arguments appended to the URL query string (e.g., `?units=metric`).
* **`bodyParam`**: For methods other than `GET`, names a single input field sent as the whole JSON body. If omitted, all arguments not consumed by `pathParams` or `queryParams` are sent as a JSON object.

---

## Upstream Protection & Bounds

Remote HTTP services often enforce strict rate limits or experience network latency. Theorem guards outbound calls with three built-in controls:

* **`limit`**: Sets a sliding-window rate limit (`requests` per `windowMs`) for the tool's credentials. Calls wait up to 5 seconds for an available slot before failing with `rate_limit_window`.
* **`timeoutMs`**: Hard deadline covering both connection time and response body streaming. Calls exceeding the deadline fail with `timeout`.
* **`maxResponseBytes`**: Maximum response body size (default: 4 MiB). Responses exceeding this limit are aborted and fail with `response_too_large`.

---

## Multimodal Image Extraction (`images`)

When an HTTP tool returns data that references image URLs (e.g., satellite imagery or product photos), configure the `images` hook to fetch and deliver the images as multimodal parts to the model:

```ts
// ... inside http tool definition
images: (output) => output.results.map((item) => item.thumbnailUrl),

imageLimits: {
  count: 3,                 // Keep at most 3 images
  bytes: 1024 * 1024,       // Max 1 MiB per image
  totalBytes: 2 * 1024 * 1024, // Max 2 MiB across all images
  timeoutMs: 4000,          // 4s timeout per image
},
```

Theorem fetches each image through network guardrails without forwarding the tool's credentials. If an image fails to load or exceeds `imageLimits`, Theorem emits an `images_unfetched` warning and delivers the remaining results without failing the tool call.

---

## Related Guides

* **[Tools & Execution Pipeline](3-1-tools.md)**: Universal tool attributes, pipeline stages, and dynamic loading.
* **[MCP Tools](3-1-3-mcp-tools.md)**: Connecting Model Context Protocol servers.
* **[Auth & Credentials](3-3-auth-credentials.md)**: Authenticating HTTP tools with API keys or OAuth.
* **[Network Safety & Guardrails](4-4-network-safety.md)**: Restricting outbound destination domains and IP ranges.
