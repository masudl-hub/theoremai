# Headless React Hooks

Modern web applications require custom design systems, bespoke micro-interactions, and granular control over the DOM. Rigid, pre-styled AI components break design fidelity and complicate integration into production component libraries.

Theorem provides a suite of headless React hooks in [`@theoremjs/react`](file:///Users/masudlewis/Development/theoremai/react/README.md). These hooks manage asynchronous streaming, event compaction, gate approvals, pending message queues, and transport lifecycles without emitting any markup, styling, or CSS dependencies. Developers pair them with any UI library—such as Tailwind, Radix, or custom corporate design systems.

---

## Hook Summary

| Hook | Profile Type | Purpose | Primary Methods & State |
| :--- | :--- | :--- | :--- |
| [`useTheoremInterface`](#1-interface-discovery-usetheoreminterface) | Any | Discovers public client capabilities, input constraints, and labels | `status`, `iface`, `failure` |
| [`useTheoremChat`](#2-conversational-streaming-usetheoremchat) | `text` | Manages transcript blocks, streaming tokens, composer queues, and tool gates | `phase`, `blocks`, `streamBlocks`, `draftText`, `handleSubmit`, `handleStop`, `handleToolDecision` |
| [`useTheoremDecision`](#3-structured-decisions-usetheoremdecision) | `decision` | Executes single-turn structured schema evaluations | `decide`, `status`, `result`, `failure`, `cancel` |
| [`useTheoremEmbedding`](#4-vector-search--embeddings-usetheoremembedding) | `embedding` | Runs ad-hoc vector embeddings with task-aware query/document profiles | `embed`, `status`, `result`, `failure`, `cancel` |
| [`useEmbeddingIndex`](#4-vector-search--embeddings-usetheoremembedding) | `embedding` | Batches large document collections into vector indexes with progress tracking | `index`, `status`, `progress`, `result`, `cancel` |
| [`useTheoremHost`](#5-host-tools--mcp-consoles-usetheoremhost) | `host` | Runs, monitors, and answers gates for registered server tools | `calls`, `run`, `answer`, `cancel` |

---

## 1. Interface Discovery (`useTheoremInterface`)

Before rendering a chat composer or dispatch form, client applications must inspect what the server profile permits. The [`useTheoremInterface`](file:///Users/masudlewis/Development/theoremai/react/src/hooks/use-theorem-interface.ts) hook issues a discovery request against the server endpoint.

```tsx
import { createHttpTransport, useTheoremInterface } from '@theoremjs/react';

const transport = createHttpTransport({ endpoint: '/api/theorem' });

export function HarborApp() {
  const described = useTheoremInterface(transport);

  if (described.status === 'loading') return <div>Loading interface...</div>;
  if (described.status === 'error') return <div>Failed to load: {described.failure.error}</div>;

  return <div>Connected to {described.iface.identity.handle}</div>;
}
```

The returned `iface` object exposes client-safe metadata:
- **`inputs`**: Whether the profile accepts attachments (`inputs.files`), text, or structured slots.
- **`models`**: Available model aliases if the client is permitted to switch engines.
- **`tools`**: Names and parameter schemas of client-executable page tools.
- **`labels`**: Localized string templates for rendering user-facing errors and UI messages.

System instructions, private keys, and provider configurations remain on the server and are stripped from `iface`.

---

## 2. Conversational Streaming (`useTheoremChat`)

The [`useTheoremChat`](file:///Users/masudlewis/Development/theoremai/react/src/hooks/use-theorem-chat.ts) hook wraps Theorem's headless `ChatController` via `useSyncExternalStore`, synchronizing turn streams, client queues, and tool gates into React state.

### Lean Consumption

To display incoming tokens as they arrive over the wire, concatenate committed `chat.blocks` with active `chat.streamBlocks`:

```tsx
import { useMemo } from 'react';
import { createHttpTransport, useTheoremChat, useTheoremInterface } from '@theoremjs/react';

const transport = createHttpTransport({ endpoint: '/api/theorem' });

export function HarborChat() {
  const described = useTheoremInterface(transport);
  const chat = useTheoremChat({
    transport,
    iface: described.status === 'ready' && described.iface.type !== 'live' ? described.iface : null,
  });

  const allBlocks = useMemo(
    () => [...chat.blocks, ...chat.streamBlocks],
    [chat.blocks, chat.streamBlocks],
  );

  return (
    <div>
      {allBlocks.map((block) => {
        if (block.kind === 'user-text' || block.kind === 'text') {
          return <p key={block.id}>{block.text}</p>;
        }
        return null;
      })}
      <input value={chat.draftText} onChange={(e) => chat.setDraftText(e.target.value)} />
      {chat.phase === 'streaming' ? (
        <button onClick={() => chat.handleStop()}>Stop</button>
      ) : (
        <button onClick={() => chat.handleSubmit()} disabled={chat.phase !== 'idle'}>
          Send
        </button>
      )}
    </div>
  );
}
```

### Transcript Phases & Gating

The `chat.phase` enum indicates the active runtime state:
- `'idle'`: Ready for user input.
- `'streaming'`: Model response tokens are actively flowing into `chat.streamBlocks`.
- `'gated'`: The model paused turn execution to wait for human confirmation on a sensitive tool.

When `chat.phase === 'gated'`, render the pending decision dialog and resolve it using `handleToolDecision` with `'allow'` or `'deny'`:

```tsx
{chat.phase === 'gated' && (
  <div>
    <p>Approval required to clear vessel departure.</p>
    <button onClick={() => chat.handleToolDecision(0, 'allow')}>Approve</button>
    <button onClick={() => chat.handleToolDecision(0, 'deny')}>Reject</button>
  </div>
)}
```

### In-Browser Page Tools

Profiles that define client-side page tools (e.g. tools that read active DOM selection or trigger browser navigation) execute directly on the client without prompt injection risks. Supply functions to `pageTools`:

```tsx
const chat = useTheoremChat({
  transport,
  iface: described.status === 'ready' && described.iface.type !== 'live' ? described.iface : null,
  pageTools: {
    highlightBerth: async (args) => {
      document.getElementById(`berth-${args.berthId}`)?.classList.add('active');
      return { output: { success: true } };
    },
  },
});
```

---

## 3. Structured Decisions (`useTheoremDecision`)

Decision profiles perform single-turn structured extraction or classification against defined output questions. The [`useTheoremDecision`](file:///Users/masudlewis/Development/theoremai/react/src/hooks/use-theorem-decision.ts) hook manages invocation, schema validation, and abort signals.

```tsx
import { createDecisionTransport, useTheoremDecision } from '@theoremjs/react';

const transport = createDecisionTransport({ endpoint: '/api/decision' });

export function CargoSafetyEvaluator() {
  const { decide, status, result, failure, cancel } = useTheoremDecision(transport);

  const handleEvaluate = () => {
    decide({
      vesselId: 'VSL-802',
      grossTonnage: 45000,
      hazardousCargo: true,
    });
  };

  const isDeciding = status === 'deciding';

  return (
    <div>
      <button onClick={handleEvaluate} disabled={isDeciding}>Evaluate Cargo</button>
      {isDeciding && <button onClick={cancel}>Cancel</button>}
      {result && <pre>{JSON.stringify(result.answers, null, 2)}</pre>}
      {failure && <p>Evaluation failed: {failure.error}</p>}
    </div>
  );
}
```

---

## 4. Vector Search & Embeddings (`useTheoremEmbedding`)

Theorem provides two complementary hooks for working with embedding profiles:
1. [`useTheoremEmbedding`](file:///Users/masudlewis/Development/theoremai/react/src/hooks/use-theorem-embedding.ts): For ad-hoc vector generation (e.g. embedding an individual search query).
2. [`useEmbeddingIndex`](file:///Users/masudlewis/Development/theoremai/react/src/hooks/use-embedding-index.ts): For batch-indexing collections of documents with chunking and progress reporting.

```tsx
import {
  createEmbeddingTransport,
  useEmbeddingIndex,
  useTheoremEmbedding,
  useTheoremInterface,
} from '@theoremjs/react';

const transport = createEmbeddingTransport({ endpoint: '/api/embedding' });

export function HarborSearchIndex() {
  const described = useTheoremInterface(transport);
  const { index, progress, status, result } = useEmbeddingIndex(transport);
  const { embed, status: queryStatus, result: queryResult } = useTheoremEmbedding(transport);

  const isIndexing = status === 'indexing';

  const handleIndexDocuments = () => {
    if (described.status !== 'ready' || described.iface.type !== 'embedding') return;
    index(
      ['Berth 4 clearance protocol', 'Hazardous cargo anchorage rules'],
      described.iface.inputs,
    );
  };

  return (
    <div>
      <button onClick={handleIndexDocuments} disabled={isIndexing}>
        {isIndexing ? `Indexing (${progress?.done}/${progress?.total})` : 'Build Index'}
      </button>
      {result && <p>Indexed {result.vectors.length} vectors across {result.requests} batch requests.</p>}
    </div>
  );
}
```

---

## 5. Host Tools & MCP Consoles (`useTheoremHost`)

Host profiles expose registered tools over Model Context Protocol (MCP) or direct web execution. The [`useTheoremHost`](file:///Users/masudlewis/Development/theoremai/react/src/hooks/use-theorem-host.ts) hook renders interactive consoles for testing tool dispatch, inspecting progress events, and resolving approval gates.

```tsx
import { createHostTransport, useTheoremHost } from '@theoremjs/react';

const transport = createHostTransport({ endpoint: '/api/host' });

export function HarborToolConsole() {
  const { calls, run, cancel } = useTheoremHost(transport);

  const handleRunInspection = () => {
    run('inspect_berth_sensors', { berthId: 'B-14' });
  };

  return (
    <div>
      <button onClick={handleRunInspection}>Run Sensor Inspection</button>
      <ul>
        {calls.map((call) => (
          <li key={call.id}>
            Tool: {call.name} | Status: {call.isRunning ? 'Running' : 'Settled'}
            {call.isRunning && <button onClick={() => cancel(call.id)}>Cancel</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Related Guides

* **[Text Profiles](2-1-1-text-profiles.md)**: Declaring inputs, tools, and models for text conversational agents.
* **[Headless Web & Transport](7-1-headless-web-and-transport.md)**: Web-standard server route dispatchers and conversation stores.
* **[Realtime Voice & Video](7-3-realtime-voice-and-video.md)**: WebSocket relay audio worklets and media streams.
* **[Turnkey Astryx UI Components](7-4-astryx-ui-components.md)**: Ready-made Astryx components built on top of these headless hooks.
