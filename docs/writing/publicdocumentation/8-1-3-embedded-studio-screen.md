# Embedded Studio Screen & Lent Keys

While Theorem Studio runs locally from the command line (`npx theorem-studio`), you can also embed the complete visual workbench directly into your own React web applications.

Embedding Studio allows you to provide self-contained agent playgrounds for customers, integration benches for partners, or internal authoring consoles for team members who do not work in terminal environments or clone git repositories.

---

## Why Embed Studio?

Embedding the Studio screen creates an interactive workbench where visitors can design, configure, and test agent profiles within the boundaries of your web platform:

```text
┌─────────────────────────────────────────────────────────────┐
│ VISITOR'S BROWSER                                           │
│                                                             │
│ <StudioScreen />                                            │
│ • Edits profile in visual forms or Monaco                   │
│ • Runs interactive test turns against lent models           │
│ • Operates in browser memory (no server disk writes)        │
└──────────────────────────────┬──────────────────────────────┘
                               │ POST /api/studio/*
                               │ (profile draft rides along)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ YOUR BACKEND SERVER                                         │
│                                                             │
│ createStudioDraftHandler({                                  │
│   lent: { keys: myLentKeys, hostOptions: ... },             │
│   spend: (kind, request) => { enforceUserQuota(...) },      │
│ })                                                          │
│ • Signs model requests using your server credentials        │
│ • Enforces model allowlists and spending quotas             │
│ • Sandboxes network requests to public hosts only           │
└─────────────────────────────────────────────────────────────┘
```

* **No Visitor API Keys Required**: Your server provides the underlying model credentials using **Lent Keys**, allowing visitors to test agents immediately.
* **Strict Quota & Model Boundaries**: Visitors can only use the model families and token budgets you explicitly permit.
* **Zero Persistence Risk**: All edits and test conversations execute in ephemeral browser tab memory. Visitors cannot write files to your server or access private infrastructure.

---

## 1. Vite & Dependency Setup

Install `@theoremjs/studio`, `@theoremjs/react`, and the required design peer packages:

```bash
npm install @theoremjs/studio @theoremjs/react @astryxdesign/core@0.7.1 @astryxdesign/theme-neutral@0.7.1 @stylexjs/stylex@0.19.0
```

Add the `studioVite` plugin to your `vite.config.ts`. It resolves shared dependencies and serves the Monaco editor's web workers and type definitions:

```ts
// vite.config.ts
import { studioVite } from '@theoremjs/studio/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    react(),
    studioVite({ hostRoot: import.meta.dirname }),
  ],
});
```

---

## 2. Rendering `<StudioScreen />`

Render the `<StudioScreen />` component inside your application, wrapped with Astryx `<Theme>` and `<LayerProvider>`:

```tsx
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { theoremStudioTheme } from '@theoremjs/studio/ui/built/theorem-studio.ts';
import { openStudio } from '@theoremjs/studio/ui/lib/studio-open.ts';
import { StudioScreen } from '@theoremjs/studio/ui/studio-screen.tsx';
import { harborLentKeys } from './harbor-lent-keys.ts';

// Stylesheets required by Studio and Astryx
import '@theoremjs/studio/ui/figtree.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@theoremjs/studio/ui/built/theme.css';
import '@theoremjs/studio/ui/motion.css';

export function AgentPlayground() {
  return (
    <Theme theme={theoremStudioTheme} mode="dark">
      <LayerProvider>
        <StudioScreen
          opened={openStudio()}
          host={{
            kernelVersion: '0.3.3',
            lentKeys: harborLentKeys,
          }}
        />
      </LayerProvider>
    </Theme>
  );
}
```

The `host` property configures the workbench:
* `kernelVersion`: The current `@theoremjs/agents` version, displayed in the Studio header.
* `lentKeys`: The policy object defining which models, tools, and token limits visitors may access.
* `toolHandlers`: Optional mock or client-side handlers for custom function tools.

---

## 3. Configuring Lent Keys

When visitors test agents in an embedded studio, your backend pays for the model calls. You protect your API credits and infrastructure by declaring a `LentKeys` configuration:

```ts
// harbor-lent-keys.ts
import type { LentKeys } from '@theoremjs/studio';

export const harborLentKeys: LentKeys = {
  // Allowlist the exact models visitors can select
  models(type, definition) {
    if (type === 'text') {
      return [
        { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      ];
    }
    return [];
  },

  // Confirm provider support
  runs(type, definition) {
    return type === 'text';
  },

  // Default model for newly created agent drafts
  start(type) {
    return { protocol: 'openAi', provider: 'openai', apiId: 'gpt-4o-mini' };
  },

  // Reject unauthorized models or expensive frontier bindings
  violation(binding) {
    if (binding.apiId !== 'gpt-4o-mini' && binding.apiId !== 'gemini-2.5-flash') {
      return {
        field: 'apiId',
        message: 'Only standard demo models (GPT-4o Mini and Gemini 2.5 Flash) are permitted in this playground.',
      };
    }
    return null;
  },

  // Restrict provider built-in tools (e.g., disable arbitrary code execution)
  builtins(apiId) {
    return [];
  },

  // Cap decision profile limits
  decision: {
    questions: 3,
    criteria: 4,
    instructionsChars: 1000,
    criterionChars: 200,
    nameChars: 50,
    idChars: 50,
    stateBytes: 16384,
    images: 1,
    imageBytes: 524288,
    timeoutMs: 15000,
  },

  questionViolation: () => null,
  stateViolation: () => null,
  liveInputTokens: 8192,

  // Enforce security boundaries
  holds: {
    publicHostsOnly: true, // Prevents SSRF to internal private networks
    afterRemoteRead: 'block', // Blocks potential exfiltration after untrusted reads
  },
};
```

### Enforced Protections
* **Model Allowlisting**: If a visitor attempts to configure an unpermitted model (such as an expensive reasoning model), Studio surfaces an inline validation badge and blocks execution.
* **Network Sandboxing**: Setting `holds.publicHostsOnly: true` forces all outbound network calls through Theorem's private IP detector, preventing SSRF attacks against internal services.
* **Payload Caps**: Decision profile questions, state byte sizes, and image attachments are capped to prevent memory exhaustion.

---

## 4. Answering at `/api/studio`

The embedded `<StudioScreen />` sends draft execution requests to your server under the `/api/studio` base path.

Mount `createStudioDraftHandler` on your backend server (Node.js, Deno, Bun, or Cloudflare Workers):

```ts
// server/studio-route.ts
import { createStudioDraftHandler, STUDIO_BASE } from '@theoremjs/studio/server';
import { TheoremError } from '@theoremjs/agents';
import { harborLentKeys } from '../shared/harbor-lent-keys.ts';

const studioHandler = createStudioDraftHandler({
  lent: {
    mode: 'demo',
    keys: harborLentKeys,
    // Fill each key slot the draft's model requests
    hostOptions: (profile) => ({
      vault: {
        openai: process.env.OPENAI_API_KEY ?? '',
        gemini: process.env.GEMINI_API_KEY ?? '',
      },
    }),
  },

  // Enforce rate limits and spending quotas per user or IP
  spend: async (kind, request) => {
    const clientIp = request.headers.get('x-forwarded-for') ?? 'unknown';
    const usageCount = await getVisitorUsage(clientIp);

    if (usageCount > 25) {
      throw new TheoremError('Demo quota exceeded. You have reached the limit of 25 test turns per session.');
    }

    await incrementVisitorUsage(clientIp);
  },
});

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname.startsWith(`${STUDIO_BASE}/`)) {
      return studioHandler(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
```

### How Server Execution Works
1. **The Draft Rides Along**: The client sends the visitor's modified profile draft in the request body. The server does not look up stored files or load a project setup.
2. **Credential Injection**: `hostOptions` receives the profile, reads the key slot it requests (e.g., `openai`), and signs the request using your server environment variable. The browser never sees your API keys.
3. **Quota Rejection**: If `spend` throws a `TheoremError`, Studio halts execution and displays the error message directly inside the chat bench.

---

## 5. Ephemeral In-Memory Workspaces

Embedded Studio screens do not write to disk. 

* **Browser Session State**: Draft changes, prompt edits, and test conversations live in browser tab memory (`openStudio()`).
* **Session Reset**: When the visitor refreshes or closes the browser tab, the draft resets to its initial state.
* **Download Trace**: If visitors want to preserve their test results, they can click **Download trace** in the trace inspector to export their session as a `.trace.json` file.

---

## Related Guides

* **[Theorem Studio Overview](8-1-theorem-studio.md)**: Mental model, visual workbench capabilities, and execution environments.
* **[Project Setup & Workspaces](8-1-1-studio-setup-and-workspace.md)**: Local development setup, credentials, and desktop editor integration.
* **[Draft Compiler & Code Synchronization](8-1-2-draft-compiler-and-code-export.md)**: Form-to-code synchronization, background diagnostics, and file saving.
* **[React Hooks & Transports](7-2-react-hooks.md)**: Headless React hooks for building custom conversational interfaces.