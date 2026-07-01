# Runtime env injection

## What & why

A container image is built once and then promoted through every environment —
local, staging, production — without a rebuild. But Next.js's default env model
is a build-time model: `NEXT_PUBLIC_*` variables get inlined into the JS bundle
at `next build` and frozen there. If the ingest URL for one environment gets
baked in at build time, every other environment that runs the same image is
stuck with it.

The fix is to make client-visible env vars mutable *after* the image is built,
not just after it's deployed. The app reads a small `window.__ENV__` object at
page load instead of trusting whatever `next build` inlined, and that object is
written to disk by the container's entrypoint script the moment the container
starts — using whatever env vars the orchestrator (Kubernetes, Docker Compose,
a local shell) injects into that specific container. One image, any number of
environments, no rebuild.

Server-side code has a simpler version of the same problem and a simpler fix:
it just avoids the `NEXT_PUBLIC_*` prefix. Non-prefixed vars are never inlined,
so server code reads `process.env` directly at request time and gets whatever
the current process's environment says — no bundling step involved.

## The shape

Three moving pieces, one per place code needs the value:

```
Container starts
    │
    ▼
Entrypoint script (startup.sh in prod; generate-env.mjs in dev)
    │  reads process env, applies defaults for anything unset
    ▼
public/env.js         — plain JS, not bundled: `window.__ENV__ = { NEXT_PUBLIC_*: "..." }`
    │
    ▼
<Script src="/env.js" strategy="beforeInteractive" />   — in the root layout,
    │                                                       loads before hydration
    ▼
window.__ENV__ is now populated when any client component first runs
    │
    ▼
getRuntimeEnv()        — client helper: window.__ENV__ first, then process.env
```

Server-side code skips all of this — it reads `process.env.API_URL` (no
`NEXT_PUBLIC_` prefix) directly, because non-prefixed vars are never inlined by
Next.js and are always read fresh from the process's environment at request
time.

Two independent trust boundaries, two independent mechanisms:

- **Client, `NEXT_PUBLIC_*` vars** → `window.__ENV__` via `env.js`, read
  through `getRuntimeEnv()`.
- **Server, non-prefixed vars** → `process.env` directly, read at request time
  by route handlers and server components.

## Build it

Worked example: add `NEXT_PUBLIC_TELEMETRY_INGEST_URL`, a client-visible URL
the browser needs to know in order to ship telemetry events to the right
collector — and which must differ between local, staging, and production
without rebuilding the image.

1. **Pick the prefix.** The browser needs this value, so it has to be
   `NEXT_PUBLIC_*` — anything without that prefix never reaches client bundles
   at all, inlined or not. Name it `NEXT_PUBLIC_TELEMETRY_INGEST_URL`.

2. **Give it a default in the entrypoint script** (the dev generator mirrors
   this — see [Rules & gotchas](#rules--gotchas) for why there are two
   scripts):

   ```sh
   export NEXT_PUBLIC_TELEMETRY_INGEST_URL=${NEXT_PUBLIC_TELEMETRY_INGEST_URL:-http://localhost:4318/v1/telemetry}
   ```

3. **Emit it into `public/env.js`**, in the same script, right after the
   `export`:

   ```sh
   echo "window.__ENV__ = {" > /app/public/env.js
   echo "  NEXT_PUBLIC_TELEMETRY_INGEST_URL: \"$NEXT_PUBLIC_TELEMETRY_INGEST_URL\"," >> /app/public/env.js
   echo "};" >> /app/public/env.js
   ```

   (In the real script this is one growing object literal with every runtime
   var as a line — see [Source lineage](#source-lineage) for the full file.)

4. **Read it on the client** through the shared helper, never through
   `window.__ENV__` directly and never through `process.env` directly:

   ```ts
   // getRuntimeEnv() — reads window.__ENV__ first, falls back to process.env
   export const getRuntimeEnv = () => {
     if (typeof window !== 'undefined' && window.__ENV__) {
       return window.__ENV__
     }
     return {}
   }

   export const getTelemetryIngestUrl = (): string => {
     const isServer = typeof window === 'undefined'
     if (isServer) {
       return process.env.NEXT_PUBLIC_TELEMETRY_INGEST_URL || ''
     }
     const runtimeEnv = getRuntimeEnv()
     return runtimeEnv.NEXT_PUBLIC_TELEMETRY_INGEST_URL || process.env.NEXT_PUBLIC_TELEMETRY_INGEST_URL || ''
   }
   ```

   The `window.__ENV__` check comes first because it reflects *this
   container's* actual runtime env; `process.env` on the client is whatever
   was inlined at build time and is only a fallback for local dev before
   `env.js` has loaded, or tests that never load `env.js` at all.

5. **If a server route handler also needs the ingest URL** (say, a proxy route
   that forwards a batch server-side), give it a non-prefixed twin and read it
   straight from `process.env` — no helper needed, no `env.js` involved:

   ```ts
   const TELEMETRY_INGEST_URL = process.env.TELEMETRY_INGEST_URL || process.env.NEXT_PUBLIC_TELEMETRY_INGEST_URL || ''
   ```

   Set both in the entrypoint script if server code needs the value too —
   they can carry the same value, but keep them as two separate exports
   (see the `API_URL` example in [Source lineage](#source-lineage)) so the
   server path never depends on a `NEXT_PUBLIC_*` var making it through
   Next.js's inlining unchanged.

That's the whole vertical slice: one default in the entrypoint script, one
line in the `env.js` template, one read through `getRuntimeEnv()` on the
client, and — only if server code needs it too — one non-prefixed twin read
straight from `process.env`.

## Rules & gotchas

- **In production, `startup.sh` — the container entrypoint — regenerates
  `public/env.js` every time the container starts, not a dev tool.** There are
  two generators and they run in different places: a Node dev-only generator
  runs from `predev` before `next dev` on a developer's machine, and the
  container entrypoint shell script runs `exec node server.js` after writing
  `env.js`, as the very last step before the standalone server starts inside
  the built image. Production never invokes the dev generator — if you're
  debugging a stale `env.js` value in a deployed container, the entrypoint
  script is where to look, not the dev tool.
- **Never bake a per-deploy `NEXT_PUBLIC_*` value in as a build ARG.** It feels
  natural to pass `NEXT_PUBLIC_TELEMETRY_INGEST_URL` as a Docker build
  argument so it's "configured" per environment — but `next build` inlines
  `NEXT_PUBLIC_*` values into the compiled bundle at that exact moment. Once
  the image is built, that value is frozen inside the JS, and a Kubernetes
  ConfigMap or Secret set on the *running* container has no effect on it — the
  bundle never reads `process.env` again after build. This is the trap
  `env.js` exists to route around: keep the build ARG unset (or set to a
  harmless default) and let the entrypoint script's `window.__ENV__` be the
  only thing that varies per deploy. See
  [`./12-deployment.md`](./12-deployment.md) for how the image is built and
  promoted across environments without ever re-running `next build`.
- **Server truth uses non-prefixed names.** `API_URL`, not
  `NEXT_PUBLIC_API_URL`, is what server-side route handlers and server
  components should read for the value that matters at request time. The
  `NEXT_PUBLIC_` twin exists only because the client also needs the value and
  the client has no other way to get it. Don't let a route handler read the
  `NEXT_PUBLIC_*` var "because it's already there" — that reintroduces the
  build-time-freezing problem on the server path too.
- **`getRuntimeEnv()` is the only sanctioned way to read a runtime var on the
  client.** Reaching for `window.__ENV__` directly works right up until a test
  environment or a server-rendered pass runs the same code with no `window` —
  the helper's `typeof window !== 'undefined'` guard is what makes the code
  safe in both places. Every client-side runtime-env read should go through
  it, even for a "just this once" case.
- **`env.js` changing doesn't require a Next.js rebuild — only a container
  restart.** Because `env.js` is a static file loaded via `<Script>`, not part
  of the JS bundle, editing the vars an orchestrator injects and restarting
  the container is enough to change what the client sees. Don't reach for
  `next build` to fix a runtime value that turns out to be wrong; check
  whether the entrypoint script actually re-ran with the values you expect
  first.
- **A missing var isn't a crash, it's an empty string or a hardcoded
  default.** Every var the entrypoint script exports uses a shell default
  (`${VAR:-default}`), and every client read falls back past `window.__ENV__`
  to `process.env` to, ultimately, an empty string or hardcoded literal. If a
  new var is added to the app's read paths but not to the entrypoint script's
  export list, it will silently resolve to that fallback in every
  environment — there's no error to catch this, so it's worth checking the
  entrypoint script whenever a new runtime var is introduced.

## Source lineage

- glassflow-etl-ui/startup.sh
- glassflow-etl-ui/generate-env.mjs
- glassflow-etl-ui/src/app/layout.tsx
- glassflow-etl-ui/src/utils/common.client.ts
- glassflow-etl-ui/src/app/ui-api/config.ts
- glassflow-etl-ui/.cursor/architecture/ENVIRONMENT.md
