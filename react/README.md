# `@theorum/react`

React projection of `theorum/interface` — runners, transcript, composer, live stage.

Lives next to the kernel at `theorum/react/` so React apps depend on:

- `theorum` (kernel)
- `@theorum/react` (this package)

No Svelte. The playground site (`theorum-frontend`) hosts a thin Vite SPA at `apps/run` that imports this package; the info-site graph stays Svelte and only writes a `PlaygroundRunPayload` handoff.

## Imports

```ts
import { TheorumRunApp } from '@theorum/react';
import { readPlaygroundRunPayload } from '@theorum/react/client';
```

## Local layout

```text
Development/
  theorum/           # kernel + this package
    react/
  theorum-frontend/  # site; apps/run consumes file:../theorum/react
```
