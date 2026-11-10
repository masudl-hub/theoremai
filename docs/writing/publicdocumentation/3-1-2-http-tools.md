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

## Tool media (`media`)

Use the `media` hook when an HTTP tool returns the addresses of pictures, such as product photos, or names files that the person should see. The hook returns one entry for each piece:

* `{ url }`: Theorem fetches the picture and the model reads it. The chat does not show it.
* `{ url, sent: true }`: the model reads the picture, and the chat shows it.
* `{ type, mimeType, uri }`: a reference. The chat shows it through your app's `resolveMedia`. The model never reads it, and its `uri` is never sent to a provider.

```ts
// ... inside http tool definition
media: (output) => [
  ...output.results.map((item) => ({ url: item.thumbnailUrl, sent: true as const })),
  { type: 'document', mimeType: 'application/pdf', uri: output.reportUri },
],

imageLimits: {
  count: 3,                 // Keep at most 3 images
  bytes: 1024 * 1024,       // Max 1 MiB per image
  totalBytes: 2 * 1024 * 1024, // Max 2 MiB across all images
  timeoutMs: 4000,          // 4s timeout per image
},
```

Theorem fetches each picture through network guardrails without forwarding the tool's credentials. If a picture fails to load or exceeds `imageLimits`, Theorem emits an `images_unfetched` warning and delivers the remaining results without failing the tool call. A reference is never fetched.

---

## Related Guides

* **[Tools & Execution Pipeline](3-1-tools.md)**: Universal tool attributes, pipeline stages, and dynamic loading.
* **[MCP Tools](3-1-3-mcp-tools.md)**: Connecting Model Context Protocol servers.
* **[Auth & Credentials](3-3-auth-credentials.md)**: Authenticating HTTP tools with API keys or OAuth.
* **[Network Safety & Guardrails](4-4-network-safety.md)**: Restricting outbound destination domains and IP ranges.
