# Headless Web & Transport

Deploying an agent to web browsers requires streaming incremental tokens over HTTP, handling user approvals for gated tools, sanitizing client inputs, and managing conversation persistence without leaking model credentials or internal prompt instructions.

Theorem provides [`@theoremjs/web`](file:///Users/masudlewis/Development/theoremai/web/README.md), a headless web platform designed around Web-standard primitives (`Request` and `Response`). It contains zero UI framework dependencies, allowing server routes to mount directly on any modern runtime (Next.js route handlers, Hono, Cloudflare Workers, SvelteKit, or Deno).

---

## Web Handler Architecture (`createTheoremHandler`)

The server endpoint is instantiated via [`createTheoremHandler`](file:///Users/masudlewis/Development/theoremai/web/src/server/handler.ts#L71), wrapping an agent profile into a standard HTTP handler:

```mermaid
flowchart TD
    Client["Browser / Vanilla Client (@theoremjs/web/client)"]
    
    subgraph Server["Web Server Route (@theoremjs/web/server)"]
        Handler["createTheoremHandler(options)"]
        Auth["Session & Vault Resolution"]
        ConvStore["ConversationStore (Sealed / DB)"]
        SessStore["SessionStore (Gate Authority)"]
    end
    
    subgraph Kernel["Theorem Engine (@theoremjs/agents)"]
        Profile["harbor.desk Profile"]
        Runner["runTurn() / Gate Coordinator"]
    end
    
    Client -->|GET /api/agent (Describe)| Handler
    Client -->|POST /api/agent/turn (Stream)| Handler
    Client -->|POST /api/agent/invoke (Answer Gate)| Handler
    Client -->|POST /api/agent/steer (Inject)| Handler
    
    Handler --> Auth
    Handler --> ConvStore
    Handler --> SessStore
    Handler --> Kernel
```

### Catch-All Route Dispatch

A single mounted endpoint handles six sub-routes:

| Method & Route | Payload / Response | Purpose |
| :--- | :--- | :--- |
| **`GET <base>`** | Returns `{ interface }` | Serves client-safe profile metadata ([`clientProfileInterface`](file:///Users/masudlewis/Development/theoremai/src/interface/from-profile.ts#L29)). System instructions, canaries, and private credentials are automatically stripped. |
| **`POST <base>/turn`** | NDJSON Stream | Streams turn execution events (`text_delta`, `tool`, `gate`, `done`). If a new turn arrives while an earlier reply is awaiting a gate, the handler cleanly walks away from the pending call first. |
| **`POST <base>/invoke`** | NDJSON Stream | Processes the user's decision or credentials for a paused tool gate (`approve`, `deny`, or `modify`). |
| **`POST <base>/steer`** | JSON Status | Injects mid-turn instructions into an active running tool loop without terminating execution. |
| **`POST <base>/conversation`** | Returns `{ transcript, reply }` | Retrieves the rendered transcript and any paused reply state for a conversation reference. |
| **`POST <base>/rewind`** | Returns `{ conversation, view }` | Truncates a conversation after a designated block, returning a new conversation ref for branching. |

---

## Mounting on Web Frameworks

Mounting [`createTheoremHandler`](file:///Users/masudlewis/Development/theoremai/web/src/server/handler.ts#L71) requires passing the profile, provider credential mappings, and a conversation store.

### Next.js App Router (`app/api/agent/[...path]/route.ts`)

```ts
import { createMemoryConversationStore, createTheoremHandler } from '@theoremjs/web/server';
import { harborDesk } from '@/lib/agent';

const handler = createTheoremHandler({
  profile: harborDesk,
  provider: {
    vault: { primary: process.env.ANTHROPIC_API_KEY! },
  },
  conversationStore: createMemoryConversationStore(),
});

export const GET = handler;
export const POST = handler;
```

### Hono / Cloudflare Workers

```ts
import { Hono } from 'hono';
import { createSealedConversationStore, createTheoremHandler } from '@theoremjs/web/server';
import { harborDesk } from './agent';

const app = new Hono();

const agentHandler = createTheoremHandler({
  profile: harborDesk,
  provider: (ctx) => ({
    vault: { primary: process.env.ANTHROPIC_API_KEY! },
  }),
  conversationStore: createSealedConversationStore({
    secret: process.env.SESSION_SECRET!, // Zero-database stateless store
  }),
});

app.all('/api/agent/*', (c) => agentHandler(c.req.raw));

export default app;
```

---

## Trust Boundaries & Conversation Stores

Theorem enforces strict trust boundaries between browser clients and server state:

1. **The Browser Never Sends History**: The browser transmits only the immediate user action alongside an opaque conversation reference (`ref`). History replay attacks are structurally prevented.
2. **Server-Owned Gate Authority**: The browser cannot approve or deny tool permissions through synthetic request flags. Pending tool gates are tracked server-side in a [`sessionStore`](file:///Users/masudlewis/Development/theoremai/web/src/server/session-store.ts#L107), verifying that gate answers correspond to valid active suspensions.
3. **Credential Isolation**: Secrets entered by users (such as OAuth tokens or third-party passwords) are captured server-side by the handler and written directly to a [`credentialStore`](file:///Users/masudlewis/Development/theoremai/web/src/server/credential-store.ts#L121). They are never reflected back to the browser or echoed in transcripts.

### Conversation Store Implementations

| Store | Function | Storage Mechanism | Best Fit |
| :--- | :--- | :--- | :--- |
| **Memory Store** | [`createMemoryConversationStore()`](file:///Users/masudlewis/Development/theoremai/web/src/server/conversation-store.ts#L45) | Local memory with LRU eviction. | Local development and integration tests. |
| **Sealed Store** | [`createSealedConversationStore({ secret })`](file:///Users/masudlewis/Development/theoremai/web/src/server/conversation-store.ts#L46) | **Zero-Database**: Transcript and state are encrypted and signed with AES-GCM into the opaque `ref` itself. | Serverless workers, edge deployments, and ephemeral sessions. |
| **Database Store** | Custom `TheoremConversationStore` | Keyed records stored in PostgreSQL, DynamoDB, or Redis. | Enterprise persistence with long-term retention. |

For profiles configured with `providerContinuation: { history: 'stateless' }`, no conversation is retained and `conversationStore` is omitted.

---

## Specialized Handlers

Beyond conversational agents, `@theoremjs/web/server` provides specialized handlers for other modalities:

### 1. Decision Handlers (`createTheoremDecisionHandler`)
Exposes single-pass deterministic evaluations over JSON state ([`decision-handler.ts`](file:///Users/masudlewis/Development/theoremai/web/src/server/decision-handler.ts#L61)):

```ts
import { createTheoremDecisionHandler } from '@theoremjs/web/server';
import { cargoSafetyDecision } from './decision-profile';

export const POST = createTheoremDecisionHandler({
  profile: cargoSafetyDecision,
  provider: { vault: { primary: process.env.GEMINI_API_KEY! } },
});
```

### 2. Host Execution Handlers (`createTheoremHostHandler`)
Exposes synthetic host tools directly to client browsers or MCP clients without an LLM loop ([`handler.ts`](file:///Users/masudlewis/Development/theoremai/web/src/server/handler.ts#L72)).

### 3. Embedding Handlers (`createTheoremEmbeddingHandler`)
Exposes batch vector embedding pipelines over HTTP ([`embedding-handler.ts`](file:///Users/masudlewis/Development/theoremai/web/src/server/embedding-handler.ts#L65)).

---

## Vanilla Browser Client (`@theoremjs/web/client`)

Applications without React interact with server handlers using `@theoremjs/web/client`:

```ts
import { createHttpTransport, createChatController } from '@theoremjs/web/client';

// 1. Initialize HTTP transport pointing to server handler
const transport = createHttpTransport({
  endpoint: '/api/agent',
});

// 2. Fetch client-safe profile descriptor
const iface = await transport.describe();

// 3. Create framework-agnostic chat controller
const chat = createChatController({
  transport,
  iface,
});

// Subscribe to state updates (blocks, phase, streaming status)
chat.subscribe(() => {
  const state = chat.getState();
  console.log('Transcript Blocks:', state.transcript);
});

// Submit user message
await chat.submit({ text: 'Verify container MSKU9012345.' });
```

---

## Related Guides

* **[Headless React Hooks](7-2-react-hooks.md)**: Consuming web transports in React via `useTheoremChat` and `useLiveSessionClient`.
* **[Profiles & Contract](2-1-profiles.md)**: Universal profile structure, inputs, and model bindings.
* **[Provider Checkpoints & State](5-4-provider-checkpoints.md)**: Dual-layer history persistence and native checkpoints.
* **[Tool Permissions & Gates](3-2-tool-gates.md)**: Lifecycle of paused tool calls and user approval workflows.
