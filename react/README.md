# `@theorum/react`

React projection of `theorum/interface` — runners, transcript, composer, live stage.

Lives next to the kernel at `theorum/react/` so React apps depend on:

- `theorum` (kernel)
- `@theorum/react` (this package)

No Svelte. The playground site (`theorum-frontend`) hosts a thin Vite SPA at `apps/run` that imports this package; the info-site graph stays Svelte and only writes a `PlaygroundRunPayload` handoff.

## Imports

```ts
import { TheorumRunApp } from '@theorum/react';
import {
  createPlaygroundRunId,
  savePlaygroundRunPayload,
  loadPlaygroundRunPayload,
  readPlaygroundRunIdFromUrl,
} from '@theorum/react/client';
```

## Run handoff

1. Playground compiles the graph, calls `createPlaygroundRunId()`, and
   `savePlaygroundRunPayload(payload, runId)` (keyed localStorage).
2. Opens `/playground/run/?run=<runId>` in a new tab.
3. `TheorumRunApp` reads `?run=`, loads that key, and **keeps** it (refresh-safe).
4. A new Run creates a new id. Storage retains at most 8 runs (oldest pruned).

## Local layout

```text
Development/
  theorum/           # kernel + this package
    react/
  theorum-frontend/  # site; apps/run consumes file:../theorum/react
```

## Composer pending intents

`theorum/interface` owns stash / queue / steer list ops and the action matrix.
This package wires AbortSignal, the pending bar, and playground turn/steer HTTP.

| Phase | Empty composer | Filled composer |
| --- | --- | --- |
| idle | disabled | Send (+ Stash menu) |
| streaming | Stop | Queue (+ Steer / Send now / Stash) |
| paused | disabled | Queue (+ Send now / Stash; no Steer) |

Enter matches the primary action. No keyboard shortcuts for stash/steer.
