# Defining a Provider

A provider defines the network address of an upstream AI service, how outgoing calls are signed, and which wire protocols the service can speak.

In Theorem, a provider is pure data. It contains no model logic, opens no sockets upon registration, and never reads environment variables implicitly. All credentials are tied to explicit vault slots supplied at turn execution.

---

## The Four Pre-Defined Providers

Theorem ships with four pre-defined providers exported from `@theoremjs/agents`:

| Provider Export | Default ID | Target Infrastructure | Default Auth Signer | Pre-Configured Protocols |
| :--- | :--- | :--- | :--- | :--- |
| **`openRouterProvider`** | `'openrouter'` | OpenRouter cloud aggregator (`https://openrouter.ai/api/v1`). | `bearer()` | `openRouterOpenAi`, `openRouterImages`, `openRouterEmbeddings`, `openRouterDecisions` |
| **`geminiProvider`** | `'gemini'` | Google AI Studio (`https://generativelanguage.googleapis.com`). | `header('x-goog-api-key')` *(Live: `query('key')`)* | `geminiInteractions`, `geminiEmbeddings`, `geminiLive` |
| **`localProvider`** | `'local'` | Self-hosted servers (Ollama, vLLM, llama.cpp, LM Studio). | `bearer()` *(key optional)* | `openAi`, `ollamaEmbeddings` |
| **`typesafeProvider`** | `'typesafe'` | TypeSafe System One decision evaluation (`https://api.typesafe.ai/v1`). | `bearer()` | `systemOne` |

Because these providers are pre-defined by the kernel, you do not need to construct their wire schemas or protocol bindings. You register them directly into your application scope.

---

## Registering Providers (`registerProvider`)

Providers must be registered during application startup before profiles load.

### Basic Registration

For standard cloud services, register the provider directly:

```ts
import { registerProvider, openRouterProvider, geminiProvider } from '@theoremjs/agents';

registerProvider(openRouterProvider);
registerProvider(geminiProvider);
```

### Self-Hosted Models via `localProvider`

To connect to local or private network models (such as Ollama or vLLM), register `localProvider` with your server's endpoint:

```ts
import { registerProvider, localProvider } from '@theoremjs/agents';

registerProvider(localProvider, {
  connection: { baseUrl: 'http://localhost:11434/v1' },
});
```

Because `localProvider` already serves `openAi` and `ollamaEmbeddings`, any OpenAI-compatible server can be used immediately without writing custom provider code.

### Multiple Instances with Custom IDs

When connecting to multiple clusters or distinct private endpoints, supply an `id` matching `/^[a-z][a-z0-9-]*$/` to register separate instances:

```ts
// Local Ollama instance for fast summaries
registerProvider(localProvider, {
  id: 'ollama-edge',
  connection: { baseUrl: 'http://10.0.1.50:11434/v1' },
});

// High-throughput vLLM cluster for complex reasoning
registerProvider(localProvider, {
  id: 'vllm-cluster',
  connection: { baseUrl: 'http://10.0.2.100:8000/v1' },
});
```

Profiles reference each cluster directly via its registered ID (`provider: 'ollama-edge'` or `provider: 'vllm-cluster'`).

### Setting Default Key Slots

Configure default vault slots for all models using this provider:

```ts
registerProvider(openRouterProvider, {
  connection: {
    siteUrl: 'https://harbor.example.com',
    siteName: 'Harbor Logistics Desk',
  },
  keySlot: 'openrouter_primary',
  fallbackKeySlot: 'openrouter_secondary',
});
```

* **`keySlot`**: Default vault slot name for models that do not specify their own slot.
* **`fallbackKeySlot`**: Secondary vault slot invoked when the primary key receives a `429` rate limit or upstream capacity error. Cannot match `keySlot`.

`registerProvider()` returns a `RegisteredProvider` reference containing the active registration metadata and helper methods (`model()` and `decisionModel()`) for declaring model bindings without re-specifying the provider ID.

---

## Defining Custom Providers (`defineProvider`)

When integrating internal enterprise proxies, custom gateway routers, or endpoints that require specialized headers or custom routing logic, define a custom provider using `defineProvider()`:

```ts
import { defineProvider, bearer, openAi, registerProvider } from '@theoremjs/agents';
import { z } from 'zod';

export const corporateGateway = defineProvider({
  id: 'corp-gateway',
  name: 'Corporate AI Gateway',
  description: 'Internal routing proxy with compliance logging.',
  
  connection: z.strictObject({
    gatewayUrl: z.string().url(),
  }),

  key: z.string().min(1),
  authorize: bearer(),

  // The serves function declares which protocols this provider hosts
  serves: (conn) => [
    {
      protocol: openAi,
      baseUrl: conn.gatewayUrl,
    },
  ],
});

// Register the custom provider into scope
registerProvider(corporateGateway, {
  connection: { gatewayUrl: 'https://gateway.internal.corp/v1' },
  keySlot: 'internal_gateway_token',
});
```

### Constraints on `defineProvider`

1. **Provider ID**: Must match `/^[a-z][a-z0-9-]*$/` (lowercase letters, numbers, hyphens; no underscores).
2. **`serves` Function**: Required. Receives the parsed `connection` object and returns an array declaring:
   * **Which protocols the endpoint speaks** (e.g., `protocol: openAi`).
   * **Where that protocol listens** (`baseUrl: conn.gatewayUrl`).
   * Optional protocol-level headers or per-protocol auth overrides (`authorize`).

---

## Authentication Signers

Pre-defined providers already have their signers configured. You only need these helpers when authoring a custom provider definition via `defineProvider()`:

```ts
import { bearer, header, query } from '@theoremjs/agents';
```

### Bearer Token (`bearer`)

Appends an `Authorization: Bearer <key>` header on outgoing calls:

```ts
authorize: bearer()
```

### Custom Header (`header`)

Appends credentials under a custom header name:

```ts
// Google AI Studio
authorize: header('x-goog-api-key')

// Custom gateway token header
authorize: header('x-api-key')
```

### Query Parameter (`query`)

Appends credentials directly to the request URL's query parameters:

```ts
// WebSocket endpoints that do not accept custom headers in browser runtimes
authorize: query('key')
```

---

## URL Sanitization & Security

All provider URLs are validated at registration:

1. **Protocol Restriction**: Only `http:` and `https:` schemes are permitted.
2. **No Embedded Credentials**: URLs with `username` or `password` components (e.g., `https://user:pass@example.com`) are rejected.
3. **No Query Secrets**: Query parameters matching `/key|auth|secret|token|password/i` are rejected. All credentials must reside in the host key vault rather than hardcoded URLs.

---

## Related Guides

* **[Model Bindings & Key Slots](5-1-model-bindings.md)**: Binding models to providers, vault slots, and failover routing.
* **[Supported Protocols](5-3-supported-protocols.md)**: Wire protocols, SSE stream parsers, and modality support.
* **[Network Safety & SSRF](4-4-network-safety.md)**: Private network restrictions and host resolution gates.
