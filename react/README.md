# `@theoremai/react`

React projection of the repo-private headless interface (`src/interface/`) — runners, transcript, composer, live stage.

Lives next to the kernel at `theorem/react/` so React apps depend on:

- `@theoremai/agents` (kernel)
- `@theoremai/react` (this package)

No Svelte. The playground site (`theorem-frontend`) hosts a thin Vite SPA at `apps/run` that imports this package; the info-site graph stays Svelte and only writes a `PlaygroundRunPayload` handoff.

## Imports

```ts
import { TheoremRunApp } from '@theoremai/react';
import {
  createPlaygroundRunId,
  savePlaygroundRunPayload,
  loadPlaygroundRunPayload,
  readPlaygroundRunIdFromUrl,
} from '@theoremai/react/client';
```

## Run handoff

1. Playground compiles the graph, calls `createPlaygroundRunId()`, and
   `savePlaygroundRunPayload(payload, runId)` (keyed localStorage).
2. Opens `/playground/run/?run=<runId>` in a new tab.
3. `TheoremRunApp` reads `?run=`, loads that key, and **keeps** it (refresh-safe).
4. A new Run creates a new id. Storage retains at most 8 runs (oldest pruned).

## Local layout

```text
Development/
  theorem/           # kernel + this package
    react/
  theorem-frontend/  # site; apps/run consumes file:../theorem/react
```

## Composer pending intents

`src/interface/` owns stash / queue / steer list ops and the action matrix.
This package wires AbortSignal, the pending bar, and playground turn/steer HTTP.

| Phase | Empty composer | Filled composer |
| --- | --- | --- |
| idle | disabled | Send (+ Stash menu) |
| streaming | Stop | Queue (+ Steer / Send now / Stash) |
| gated | disabled | Queue (+ Send now / Stash; no Steer) |

Enter matches the primary action. No keyboard shortcuts for stash/steer.

Send now while gated abandons the tool wait (`abandonGatedInterfaceTool`) without
continuing the model, then starts a new user turn. Steer POSTs use the Cache API
on Cloudflare (process Map locally) so mid-turn injects work across isolates.
Live sessions key the same inbox by `sessionId` from relay `ready`.

Pending rows show attachment / voice previews, text, **Queue** (stash → queue),
and **Send now**. Clicking the text restores the full draft (text + files + voice)
into the composer; if the composer already had a payload, that payload is re-stashed.
