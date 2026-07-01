# Mock API layer

## What & why

A frontend that can't run without its backend can't be developed, demoed, or
tested without its backend either — and for an observability UI, the backend
is often the thing least available on a laptop: no local ClickHouse, no local
Kafka, no synthetic trace volume worth looking at. The mock API layer exists
so the whole app boots and behaves realistically with zero external services:
one env var flips every data-fetching call from "hit the real backend" to
"hit an in-process fixture," and nothing above that toggle — no component, no
hook, no page — has to know which one is active.

The toggle has to work identically whether the code runs in the browser or on
the server, because Next.js runs the same data-fetching code in both places.
A `getApiUrl(endpoint)` helper decides, per call, whether to route to
`/ui-api/mock/<endpoint>` or `/ui-api/<endpoint>` — client-side by reading a
runtime-injected env value (see
[`./01-runtime-env-injection.md`](./01-runtime-env-injection.md)), server-side
by reading `process.env` directly, since server code never sees the
runtime-injected `window.__ENV__` object.

The payoff compounds past local dev: the same toggle powers demo mode (show a
populated, plausible product with no backend at all), CI (tests run against
fixtures, not flaky live infra), and — if streaming is made a first-class
mock, see **Rules & gotchas** — a synthetic load generator for exercising the
UI's live-update path under volume nobody has to actually produce.

## The shape

```
Component / hook
    │  useTraces() -> fetch(getApiUrl('traces'))
    ▼
getApiUrl(endpoint)                          src/utils/mock-api.ts
    │  isMockMode() — reads NEXT_PUBLIC_USE_MOCK_API
    │    server: process.env directly
    │    client: window.__ENV__ (runtime), falls back to process.env (dev)
    │
    ├─ mock mode  → /ui-api/mock/<endpoint>
    └─ real mode  → /ui-api/<endpoint>
    ▼                                    ▼
Mock route                          Real route
app/ui-api/mock/traces/route.ts     app/ui-api/traces/route.ts
    │  reads/writes in-memory            │  calls the real service layer
    │  fixtures via a state manager      │  (see 03-service-layer.md)
    ▼
Fixtures + state manager
app/ui-api/mock/data/traces.ts       (static seed data, typed against
                                       the SAME types the real response uses)
app/ui-api/mock/data/traces-state.ts  (Map-backed CRUD over the fixtures,
                                       simulates lifecycle: create, update,
                                       transition, delete — for the
                                       lifetime of the dev server process)
```

Four layers, each with one job:

1. **Runtime toggle.** `isMockMode()` answers "is mock mode on?" for the
   current environment (browser vs. server); `getApiUrl(endpoint)` uses that
   answer to pick a URL prefix. Every data-fetching call goes through
   `getApiUrl`, never a hand-built path — that's what makes the toggle global
   instead of a per-call decision that can drift.
2. **Interception.** A parallel route tree under `/ui-api/mock/*` mirrors the
   real route tree path-for-path. Because the toggle changes the URL, not the
   handler, the mock and real implementations of "the traces endpoint" are
   two separate files that happen to share a path shape — nothing branches
   inside one handler.
3. **Schema-typed fixtures.** Static seed arrays (`mockTraces`, `mockSpans`,
   ...) are typed against the exact types the real response uses — a shared
   `Trace` interface, or ideally a shared Zod schema — never a hand-rolled
   shape that happens to look similar today.
4. **In-memory stateful managers.** A module-level `Map` per resource,
   initialized once from the static fixtures, gives mock routes real CRUD
   and lifecycle behavior (create a trace annotation, acknowledge an alert,
   watch a status field transition after a delay) without persisting
   anything or touching a database.

The seed toggle at [`../seed/mock/mock-api.ts`](../seed/mock/mock-api.ts) is
the starting point for a new project — it's the `isMockMode()` /
`getApiUrl()` pair above, stripped of any glassflow-specific fixture imports,
ready to point at your own mock route tree.

## Build it

Worked example: a mocked `GET /ui-api/traces` list endpoint, plus a synthetic
live-span/metric event generator that closes the gap the source project
never solved — see **Rules & gotchas** for why that gap matters more here
than it did there.

1. **Type the fixture against the real response schema, not a copy of it.**
   If the real route validates its response with a Zod schema, import that
   schema's inferred type for the fixture. Drift between mock and real shape
   becomes a type error, not a runtime surprise months later.

   ```ts
   // src/types/trace.ts — shared by the real route, the mock route, and the UI
   import { z } from 'zod'

   export const traceSchema = z.object({
     traceId: z.string(),
     service: z.string(),
     durationMs: z.number(),
     status: z.enum(['ok', 'error']),
     spanCount: z.number().int(),
     startedAt: z.string(), // ISO timestamp
   })
   export type Trace = z.infer<typeof traceSchema>
   ```

   ```ts
   // app/ui-api/mock/data/traces.ts
   import { type Trace, traceSchema } from '@/src/types/trace'

   export const mockTraces: Trace[] = [
     {
       traceId: 'trace-001',
       service: 'checkout',
       durationMs: 842,
       status: 'ok',
       spanCount: 14,
       startedAt: '2026-06-30T09:12:00Z',
     },
     {
       traceId: 'trace-002',
       service: 'checkout',
       durationMs: 5310,
       status: 'error',
       spanCount: 22,
       startedAt: '2026-06-30T09:13:41Z',
     },
   ]

   // Fail fast in dev if a fixture and the schema it's typed against diverge —
   // catches hand-edits that skip the type checker (e.g. editing compiled output).
   mockTraces.forEach((t) => traceSchema.parse(t))
   ```

2. **Stand up the mock route two ways, and pick one per project — don't run
   both.**

   **(a) Parallel route file — the mechanism ported from the source
   project.** A file at the mirrored path, reading through a state manager:

   ```ts
   // app/ui-api/mock/traces/route.ts
   import { NextResponse } from 'next/server'
   import { listTraces } from '@/app/ui-api/mock/data/traces-state'

   export async function GET() {
     return NextResponse.json({ success: true, traces: listTraces() })
   }
   ```

   ```ts
   // app/ui-api/mock/data/traces-state.ts
   import { mockTraces } from './traces'
   import type { Trace } from '@/src/types/trace'

   const traces = new Map<string, Trace>()
   let initialized = false

   function init() {
     if (initialized) return
     initialized = true
     mockTraces.forEach((t) => traces.set(t.traceId, { ...t }))
   }

   export function listTraces(): Trace[] {
     init()
     return Array.from(traces.values())
   }

   export function upsertTrace(trace: Trace): void {
     init()
     traces.set(trace.traceId, trace)
   }
   ```

   **(b) MSW handler — the recommended replacement.** One handler file,
   registered once, with no second route tree to keep in sync:

   ```ts
   // src/mocks/handlers/traces.ts
   import { http, HttpResponse } from 'msw'
   import { listTraces } from './traces-state'

   export const traceHandlers = [
     http.get('/ui-api/traces', () => {
       return HttpResponse.json({ success: true, traces: listTraces() })
     }),
   ]
   ```

   **The trade-off:** (a) needs no extra dependency and works identically in
   SSR and the browser because it's just another Next.js route — but it means
   a second file tree to keep path-for-path in sync with the real routes
   forever. (b) needs a service worker (browser) or a Node request
   interceptor (SSR/tests) wired up via MSW's setup, but the same handler
   file mocks the endpoint in dev, in component tests, and in Playwright/E2E
   runs — one definition, three consumers, and no parallel route tree to
   drift out of sync. For a new project, prefer (b); see **Rules & gotchas**.

3. **Add a synthetic live-event generator for the streaming case.** An
   observability UI lives or dies on its live view, so the mock layer has to
   cover the SSE endpoint, not just the request/response ones. This is a
   plain route handler that emits synthetic spans/metrics on an interval
   instead of proxying a real stream — see
   [`./04-sse-streaming.md`](./04-sse-streaming.md) for the manager the
   client side of this connects to.

   ```ts
   // app/ui-api/mock/traces/stream/route.ts
   import type { Trace } from '@/src/types/trace'

   const SERVICES = ['checkout', 'payments', 'inventory']

   function randomTrace(): Trace {
     const isError = Math.random() < 0.08
     return {
       traceId: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
       service: SERVICES[Math.floor(Math.random() * SERVICES.length)],
       durationMs: isError ? 3000 + Math.random() * 4000 : 50 + Math.random() * 900,
       status: isError ? 'error' : 'ok',
       spanCount: 3 + Math.floor(Math.random() * 20),
       startedAt: new Date().toISOString(),
     }
   }

   export async function GET() {
     const encoder = new TextEncoder()
     let intervalId: ReturnType<typeof setInterval>

     const stream = new ReadableStream({
       start(controller) {
         intervalId = setInterval(() => {
           const frame = `event: trace\ndata: ${JSON.stringify(randomTrace())}\n\n`
           controller.enqueue(encoder.encode(frame))
         }, 1500)
       },
       cancel() {
         clearInterval(intervalId) // fires on real client disconnect — see 04-sse-streaming.md
       },
     })

     return new Response(stream, {
       headers: {
         'Content-Type': 'text/event-stream',
         'Cache-Control': 'no-cache',
         Connection: 'keep-alive',
         'X-Accel-Buffering': 'no',
       },
     })
   }
   ```

   The same generator function (`randomTrace`) doubles as the seed for demo
   mode and as a crude load-testing tool — turn the interval down to stress
   the UI's render path with a burst of updates and watch whether the trace
   table or live chart keeps up.

## Rules & gotchas

- **Drift-protection via shared types is the crown jewel of this pattern —
  keep it no matter how the rest is restructured.** The source project types
  every mock fixture against the same TypeScript interfaces the real
  route/DB layer uses (`MockKafkaConnection` reuses `KafkaConfig`,
  `MockSchema` reuses the Drizzle-inferred schema type), so a fixture that
  drifts from the real shape is a compile error, not a runtime surprise
  discovered when someone finally disables mock mode. For the new project,
  go one step further: type fixtures against the same **Zod schema** the
  real response is validated with, and — where practical — generate fixture
  values from that schema (e.g. with a Zod-aware faker) instead of
  hand-writing them. Hand-written fixtures typed against a shared schema
  catch shape drift; generated fixtures also catch "this field is always the
  happy-path value in every fixture," which is its own kind of drift.
- **The source project's mock layer does not mock the SSE stream at all.**
  Every mocked endpoint in `glassflow-etl-ui` is request/response — there is
  no mock counterpart to the real-time status stream. That gap is tolerable
  in a pipeline-config UI where the live view is a secondary feature; it is
  **disqualifying for an observability UI**, where the live trace/span/metric
  feed usually *is* the product. Do not port the mock layer without also
  building the synthetic event generator in **Build it** step 3 — a mock API
  layer that can list traces but can't stream them will pass code review and
  then fail the first demo where someone asks "does it update live?"
- **Collapse the parallel `/ui-api/mock/*` route tree for the new project —
  prefer MSW.** The source project's mock tree mirrors ~30 real routes
  path-for-path, and every new real route means remembering to add a mock
  twin, or discovering the gap when `NEXT_PUBLIC_USE_MOCK_API=true` 404s.
  MSW handlers collapse this: one handler module per resource, and the exact
  same handlers that back local dev also back component tests and E2E runs,
  so there is no separate "test mocks" layer to keep in sync with the "dev
  mocks" layer. If MSW's service-worker/Node-interceptor setup is a poor fit
  (e.g. an edge runtime MSW doesn't support), the fallback is internal
  per-route branching (`if (isMockMode()) return mockHandler(); return
  realHandler();` inside one file) — worse for readability at scale, but
  still better than a second file tree that can silently drift out of sync
  route-by-route.
- **Port the mechanism, regenerate the data.** The toggle
  (`isMockMode`/`getApiUrl`), the interception approach (MSW handler or
  route branch), and the stateful-manager pattern (`Map` + `init()` guard +
  CRUD functions) are the reusable part. The fixture *content* —
  `mockPipelines`, `mockKafkaConnections`, `mockTraces` — is domain-specific
  and gets rewritten from scratch for traces/spans/metrics/alerts; don't
  try to reshape glassflow fixtures into observability data.
- **Initialize stateful managers lazily, exactly once, guarded by a flag.**
  Every state manager in the source project uses the same `let initialized
  = false; function init() { if (initialized) return; ... }` guard before
  seeding its `Map`s from the static fixtures. Skipping the guard means a
  hot-reloaded module in dev re-seeds the map on every import and silently
  erases whatever mutations a previous request made (a pipeline that was
  "stopped" resets back to "running").
- **A mock endpoint's response envelope must match the real endpoint's
  envelope exactly** — same `{ success, ...data }` wrapper, same field names,
  same status codes on error paths. A mock that returns bare data where the
  real route wraps it means the UI code paths that only exercise cleanly
  against mock data break the moment mock mode is switched off.
- **Simulate lifecycle transitions with real delays, not instant flips.** A
  "stop pipeline" mock that flips straight from `Running` to `Stopped` hides
  every UI bug in the "pending/transitioning" state — the loading spinner
  that never got tested, the disabled button that should re-enable after the
  transition. Use a `setTimeout` to hold an intermediate state
  (`Stopping` → `Stopped` after ~2s) the same way the source project's
  `simulateTransition` helper does, and give the synthetic stream generator
  the same treatment for span/metric state changes.

## Source lineage

- glassflow-etl-ui/src/utils/mock-api.ts
- glassflow-etl-ui/src/app/ui-api/mock/pipeline/route.ts
- glassflow-etl-ui/src/app/ui-api/mock/library/connections/kafka/route.ts
- glassflow-etl-ui/src/app/ui-api/mock/data/mock-state.ts
- glassflow-etl-ui/src/app/ui-api/mock/data/library-state.ts
- glassflow-etl-ui/src/app/ui-api/mock/data/library.ts
- glassflow-etl-ui/src/app/ui-api/mock/data/pipelines.ts
