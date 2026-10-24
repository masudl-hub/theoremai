# Studio contract

For maintainers of `studio/`. The package README (`studio/README.md`) speaks to builders; this file does not ship.

## Ownership

The studio's authoring logic and demo fixtures: the editable profile draft,
its tree, the compiler that turns it into a kernel profile, TypeScript source
export, the travel concierge demo (tool seeds, sample HTTP inputs, local
function handlers), and the run-tab handoff.

The logic lives here, not in the frontend, so it is type-checked and tested
against the kernel it compiles for.

## Runs and sessions

Studio runs resolve their models through an isolated kernel scope's provider registry.
Provider host options can set `limits` for deadlines and upstream output. Studio uses the same kernel enforcement.
The runtime resolves only own entries in the host's provider vault. Inherited credentials and resolvers are unavailable.
Scripted live guardrail probes supply fixture credentials only for the selected model's primary and fallback slots.
Registered adapters can use object methods or class prototype methods. The kernel retains their method receivers for the run.
Replacing a scope registration affects later runs. It does not replace an active run's captured adapter contract.

Exported agent handoffs ask the builder to supply shared atomic session storage when deployment uses several server instances.
The session contract of the `@theoremjs/web/server` handler uses `load` and `compareAndSwap`. Tool credentials use a separate store.
Exported handlers apply finite session limits before accepting new execution claims.
Builders can set `sessionLimits` and `operationRetentionMs` in the host handler options.
These settings are host code; they do not enter the exported profile.
The handler stores version 3 operation records. It retains unresolved claims instead of restoring approvals after dispatch.
A trusted `StudioRuntime.execution` service can supply the same kernel coordination contract to Studio turns, invokes, and host calls.
New operation claims retain accepted request data and final prepared input through `SavedToolInvocation`.
Its `lookup` method checks saved operations before preparation hooks. It must enforce current resource access before returning saved results.
The default authoring runtime supplies no durable execution store. Browser replay cannot supply this service.
Studio turn replay and live answers preserve both the call ID and the kernel-issued operation ID.
Browser replay entries use operation IDs as keys. Live timers check the same reference before they stop.
A live relay can use `createTheoremSessionBoundary` with its authenticated session resolver and atomic store.
Pass its `toolExecution` to the kernel. Use `beforeEvent` to save checkpoint ownership before browser delivery.
A failed ownership write stops delivery of that checkpoint.
Live page callbacks wait for a claimed dispatch grant. Permission and sign-in decisions precede the grant.
The grant carries final prepared arguments. The relay routes its correlated result to the session boundary.
The local browser runtime supplies memory coordination and result delivery for its own authoring session.
Text and host browser transports retain the same execution authority.
A Studio chat keeps its conversation in a sealed store. A run in the page seals with a key that the tab keeps. A project run seals with one key that `serve.ts` makes for each Studio run and hands to every load, so a chat survives a Save or an edit. Quitting Studio ends the chats. The key is never written to disk.
Its authority remains in that browser. It does not provide recovery after a browser restart.
Text and live browser transports save checkpoint ownership before delivery and check it before resumption.
Runtime methods retain their original receiver, including methods that read private class fields.
An injected runtime coordinator also needs a paired `pageExecution` service when browser tools require it.
For a custom protocol in a host-supplied authoring runtime, pass definitions through `StudioRuntime.providerDefinitions`.
The runtime registers these definitions before profiles. They remain host code and never enter saved profile JSON.
The public demo retains its separate provider policy.

## Package boundary

The kernel's boundary rule, "Host decides, Theorem runs", keeps assistants and
demo product out of the `@theoremjs/agents` package.
`scripts/verify-publish-bundle.ts` checks that `studio/` stays out of the
kernel's npm and JSR packages. `scripts/build-npm-studio.ts` builds the npm package
`@theoremjs/studio` (`npm run build:npm:studio`), and copies `studio/README.md` into it.

The studio's server, its runs and its exported handlers use `@theoremjs/web`, which has no React. Its peers are `zod`, `@theoremjs/agents` and `@theoremjs/web`, and `@theoremjs/react` as an optional exact peer. React, React DOM and the design packages are not peers, so `npx theorem-studio` installs beside any React, or none: npm refuses an install when a peer, even an optional one, is present at a version outside its range. The command runs the built page and checks only those packages (`studio/installed.mjs`). A host that shows the screen in its app installs `@theoremjs/react` and its peers.

Generic authoring vocabulary the kernel schema owns (`STUDIO_AUTH_TYPES`,
`StudioAuthType`, `studio.*` field metadata) stays in `@theoremjs/agents/schema`.

Tests live in `tests/studio/` (the server and compiler) and `studio/tests/` (the screen's logic, `npm --prefix studio test`).
