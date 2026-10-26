# Turnkey Astryx UI Components

While headless hooks provide complete DOM flexibility, building production conversational interfaces from scratch requires implementing virtualized transcripts, streaming token smoothers, multi-file composers, audio waveforms, mid-stream modal gates, and accessibility patterns.

Theorem provides a ready-made UI layer built on [Astryx](https://www.npmjs.com/package/@astryxdesign/core) in [`@theoremjs/react/ui`](file:///Users/masudlewis/Development/theoremai/react/README.md) and [`@theoremjs/react/live`](file:///Users/masudlewis/Development/theoremai/react/README.md). These components provide production-grade user experiences with built-in screen reader announcements, keyboard navigation, focus management, reduced-motion adaptations, and internationalization.

---

## Component Catalog

| Component | Profile Type | Package Entry | Description |
| :--- | :--- | :--- | :--- |
| [`<TheoremChat />`](#1-conversational-chat-theoremchat) | `text` | `@theoremjs/react/ui` | Full chat console with transcript, composer drawer, slot selectors, and tool gate modals |
| [`<LiveRunner />`](#2-realtime-voice--video-liverunner) | `live` | `@theoremjs/react/live` | Voice and video calling interface with real-time audio waveforms, camera flip, and captions |
| [`<TheoremDecision />`](#3-decision-evaluations-theoremdecision) | `decision` | `@theoremjs/react/ui` | Schema evaluation console with JSON state editor, image attachments, and answer metrics |
| [`<TheoremEmbedding />`](#4-vector-search--embeddings-theoremembedding) | `embedding` | `@theoremjs/react/ui` | Vector search bench with text chunking, document uploads, and interactive 3D spatial view |
| [`<TheoremHost />`](#5-host--mcp-tools-theoremhost) | `host` | `@theoremjs/react/ui` | Developer workbench for discovering, running, and inspecting MCP and server tools |

---

## 1. Conversational Chat (`<TheoremChat />`)

[`<TheoremChat />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/TheoremChat.tsx) connects to a server-hosted `text` profile over HTTP. It queries the handler for allowed models, file inputs, and tool gates, automatically rendering only the controls permitted by the profile.

### Lean Consumption

```tsx
import { TheoremChat } from '@theoremjs/react/ui';

export function VesselDispatchChat() {
  return <TheoremChat endpoint="/api/theorem" />;
}
```

### Context, Slots & Page Tools

```tsx
import { TheoremChat } from '@theoremjs/react/ui';

export function VesselDispatchChat() {
  return (
    <TheoremChat
      endpoint="/api/theorem"
      slots={{ sector: 'north-basin' }}
      context={{ activeVessel: 'VSL-409', quayPosition: 12 }}
      pageTools={{
        highlightQuay: async (args) => {
          document.getElementById(`quay-${args.quayId}`)?.scrollIntoView();
          return { output: { success: true } };
        },
      }}
      trace={true}
      usage={true}
    />
  );
}
```

- **`slots`**: Locks slot values or provides default choices in the composer bar.
- **`context`**: Transmits background client state with every turn. The agent reads this context without generating conversational replies to it.
- **`pageTools`**: Handles tools declared with `answeredBy: 'page'`. The client executes the function and returns output over HTTP without displaying prompt dialogs to the user.
- **`trace`**: Renders an interactive trace inspector panel when the profile has observability enabled.
- **`usage`**: Displays token counts and estimated costs under completed assistant turns.

---

## 2. Realtime Voice & Video (`<LiveRunner />`)

[`<LiveRunner />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/LiveRunner.tsx) provides a turnkey interface for `live` profiles, managing microphone streams, gapless 24kHz audio synthesis, real-time audio waveforms, and device camera streaming over a WebSocket relay.

```tsx
import { LiveRunner } from '@theoremjs/react/live';
import { useTheoremInterface, createHttpTransport } from '@theoremjs/react';

const transport = createHttpTransport({ endpoint: '/api/theorem' });

export function HarborCallView() {
  const described = useTheoremInterface(transport);

  if (described.status !== 'ready' || described.iface.type !== 'live') {
    return <div>Connecting to dispatch relay...</div>;
  }

  return (
    <LiveRunner
      iface={described.iface}
      connection={() => ({
        relayUrl: 'wss://api.example.com/api/live/relay',
        profile: 'harbor.live_dispatch',
      })}
    />
  );
}
```

`<LiveRunner />` includes:
- **Waveform Animation**: Built-in [`InkWaveform`](file:///Users/masudlewis/Development/theoremai/react/src/components/InkWaveform.tsx) driven by real-time normalized microphone and model audio levels.
- **Camera Flip & Preview**: Manages front and rear camera selection (`facingMode: 'user' | 'environment'`) and downsamples frames to 640x480 at 400ms intervals.
- **Approval Dialogs**: Renders [`ApprovalCard`](file:///Users/masudlewis/Development/theoremai/react/src/ui/ToolGateCard.tsx) modals over the active call when sensitive tools trigger human confirmation gates.
- **Captions Drawer**: Provides real-time transcription history with user and agent distinction.

---

## 3. Decision Evaluations (`<TheoremDecision />`)

[`<TheoremDecision />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/TheoremDecision.tsx) renders a workbench for `decision` profiles. It accepts structured JSON state, manages optional image attachments, and visualizes answers, confidences, scores, and bounding boxes.

```tsx
import { TheoremDecision } from '@theoremjs/react/ui';

export function CargoSafetyConsole() {
  return (
    <TheoremDecision
      endpoint="/api/decision"
      defaultState={JSON.stringify(
        { vesselId: 'VSL-409', grossTonnage: 32000, hazardousCargo: true },
        null,
        2,
      )}
    />
  );
}
```

---

## 4. Vector Search & Embeddings (`<TheoremEmbedding />`)

[`<TheoremEmbedding />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/TheoremEmbedding.tsx) provides an interactive search workbench for `embedding` profiles. It chunks text, ingests uploaded files, batches requests to match model limits, and ranks similarity matches against queries.

```tsx
import { TheoremEmbedding } from '@theoremjs/react/ui';

export function HarborSearchBench() {
  return (
    <TheoremEmbedding
      endpoint="/api/embedding"
      defaultText="Berth 4 clearance protocols require tugboat escort for vessels over 20,000 DWT."
      defaultQuery="When is tugboat escort required?"
    />
  );
}
```

When indexing documents, [`<TheoremEmbedding />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/TheoremEmbedding.tsx) projects vector clusters into an interactive 3D geometric visualization ([`EmbeddingSpaceView`](file:///Users/masudlewis/Development/theoremai/react/src/ui/EmbeddingSpace.tsx)), linking nearest neighbors and placing active queries in relation to document vectors.

---

## 5. Host & MCP Tools (`<TheoremHost />`)

[`<TheoremHost />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/TheoremHost.tsx) serves as an interactive testing console for `host` profiles and MCP servers. It dynamically discovers registered tools, generates input forms from JSON schemas, executes calls with streaming progress updates, and resolves approval gates.

```tsx
import { TheoremHost } from '@theoremjs/react/ui';

export function HarborToolWorkbench() {
  return <TheoremHost endpoint="/api/host" />;
}
```

---

## 6. Composable UI Primitives

When building hybrid interfaces that combine custom layouts with pre-built Theorem elements, import sub-components directly from `@theoremjs/react/ui`:

```tsx
import {
  ChatTranscript,
  ChatComposerBar,
  ApprovalCard,
  InkWaveform,
  LiveCaptionsPanel,
} from '@theoremjs/react/ui';
```

- **[`<ChatTranscript />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/ChatTranscript.tsx)**: Renders turn blocks, streaming markdown, citations, thoughts, tool activities, and error notices.
- **[`<ChatComposerBar />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/ChatComposerBar.tsx)**: Composer input handling text input, multi-file drops, audio recording, and queue/steer actions.
- **[`<ApprovalCard />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/ToolGateCard.tsx)**: Dialog card for reviewing tool parameters, editing arguments, and resolving gates with `'allow'` or `'deny'`.
- **[`<InkWaveform />`](file:///Users/masudlewis/Development/theoremai/react/src/components/InkWaveform.tsx)**: Canvas-based fluid waveform visualizer responding to mic and speaker audio levels.
- **[`<LiveCaptionsPanel />`](file:///Users/masudlewis/Development/theoremai/react/src/ui/LiveCaptionsPanel.tsx)**: Transcription panel for live calls.

---

## 7. Theming & Styling

Theorem UI is built on Astryx and StyleX. Ready-made components (`@theoremjs/react/ui` and `@theoremjs/react/live`) import their required stylesheets (`@astryxdesign/core/reset.css`, `@astryxdesign/core/astryx.css`, and internal component theme sheets) automatically. Applications need only a bundler that resolves CSS imports (such as Vite, Next.js, or Bun).

The reset lives inside `@layer reset`, ensuring that any unlayered host CSS takes precedence over library defaults.

### Theme Extensions

Extend [`theoremTheme`](file:///Users/masudlewis/Development/theoremai/react/src/ui/theorem-theme.ts) using Astryx’s `defineTheme`:

```ts
import { defineTheme } from '@astryxdesign/core/theme';
import { theoremTheme } from '@theoremjs/react/ui/theme';

export const maritimeTheme = defineTheme({
  name: 'maritime',
  extends: theoremTheme,
  tokens: {
    '--color-accent': '#0066cc',
    '--radius-chat': '8px',
  },
});
```

Pass the customized theme and mode directly to components:

```tsx
<TheoremChat endpoint="/api/theorem" theme={maritimeTheme} mode="dark" />
```

### Layout Variables

Adjust pane geometry using scoped CSS custom properties:
- `--theorem-pane-background`: Overrides the background color of raised side panes (defaults to `--color-background-card`).
- `--theorem-pane-edge`: Adjusts the margin kept between raised panels and viewport edges (defaults to `12px` or `16px`).

---

## 8. Localized Labels & ICU Overrides

All user-visible text in Astryx components is defined in an internationalized message catalog. Theorem messages use `@theorem.*` keys, while Astryx core messages use `@astryx.*` keys.

Override messages per locale using the `labels` prop:

```tsx
<TheoremChat
  endpoint="/api/theorem"
  labels={{
    en: {
      '@theorem.chat.greeting': 'Harbor Dispatch Console',
      '@theorem.composer.placeholder': 'Send instruction to @{handle}...',
      '@astryx.chatSendButton.send': 'Dispatch',
    },
    fr: {
      '@theorem.chat.greeting': 'Console de régulation portuaire',
      '@theorem.composer.placeholder': 'Envoyer un message à @{handle}...',
      '@astryx.chatSendButton.send': 'Envoyer',
    },
  }}
/>
```

Components validate labels on mount. An error is thrown if:
1. A `@theorem.*` key is not present in [`THEOREM_UI_CATALOG`](file:///Users/masudlewis/Development/theoremai/react/src/ui/labels.ts).
2. A message contains invalid ICU syntax.
3. A message fails to supply a required placeholder parameter (such as `{handle}`).

---

## Related Guides

* **[Text Profiles](2-1-1-text-profiles.md)**: Declaring inputs, models, and tools for conversational agents.
* **[Headless Web & Transport](7-1-headless-web-and-transport.md)**: Web-standard server route dispatchers and conversation stores.
* **[Headless React Hooks](7-2-react-hooks.md)**: Building unstyled interfaces using Theorem hooks.
* **[Realtime Voice & Video](7-3-realtime-voice-and-video.md)**: Audio worklets, Web Audio playback, and video streaming.
