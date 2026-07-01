# Proxy routes

## What & why

The browser never talks to the backend directly. Every request the UI makes for
backend data goes to a same-origin `/ui-api/*` route first, and that route — running
server-side inside Next.js — is the only thing that ever makes the real network call
to the observability backend.

This exists to protect two things at once: the backend's location and the backend's
shape. The backend's real host, port, and any credentials it needs live only in
server-side environment variables, read by route handler code that never ships to a
browser bundle. A trace store, a metrics API, an alerting service — whatever runs
behind the proxy can move, get replaced, or start requiring an API key without a
single client-side file changing, because the client never knew the real address to
begin with. And the backend's response shape — inconsistent status codes, versioned
payloads, error bodies that vary by failure mode — gets normalized into one stable
JSON envelope before it ever reaches a component, so nothing above the route handler
has to branch on "which backend version answered this."

The proxy route is deliberately the thinnest possible layer: validate the request,
call a service, normalize the response. Anything heavier — retries, aggregation,
translating backend errors into typed domain errors — belongs one layer down, in the
service layer (see [`./03-service-layer.md`](./03-service-layer.md)). A route handler
that grows business logic is a route handler that's about to be hard to test and
impossible to reuse from anywhere but HTTP.

## The shape

```
Browser
    │  fetch('/ui-api/traces?service=checkout')   — same-origin, no backend URL visible
    ▼
Route handler   app/ui-api/traces/route.ts
    │  1. parse & validate the request (query, params, or body) with Zod
    │  2. call a service function — no fetch/axios call lives in the handler itself
    │  3. catch errors from the service, normalize to a stable JSON envelope
    ▼
Service   src/services/trace-service.ts
    │  knows the real backend URL (from runtimeConfig, server-only env)
    │  makes the actual HTTP call, throws typed errors on failure
    ▼
Backend   (trace store, metrics API, whatever is behind the proxy)
```

Every route handler in `app/ui-api/*` follows the same three-step shape regardless of
HTTP method:

1. **Validate.** Parse `request.url` search params, `request.json()`, or route
   params through a Zod schema. Nothing unvalidated reaches the service call.
2. **Delegate.** Call exactly one service function. The handler does not know how the
   service talks to the backend, doesn't build the backend URL itself, and doesn't
   retry anything — that's the service's job.
3. **Normalize.** Every response — success or failure — is shaped into the same
   envelope: `{ success: true, ...data }` or `{ success: false, error: string }`,
   with an HTTP status that matches. A shared helper turns whatever error shape the
   service throws into that one `error` string.

The runtime backend base URL is read once, from server-only config
(`runtimeConfig.apiUrl` in the source project, `src/app/ui-api/config.ts` here) — see
[`./01-runtime-env-injection.md`](./01-runtime-env-injection.md) for why that value
has to come from a non-`NEXT_PUBLIC_*` env var read at request time, not a build-time
constant.

## Build it

Worked example: `GET /ui-api/traces?service=checkout` — the browser wants the recent
traces for one service, and the handler needs to validate the query string, call a
`TraceService`, and hand back a normalized envelope.

1. **Define the query schema.** Put it at the top of the route file, next to the
   handler that uses it — small, route-local schemas don't need their own file.

   ```ts
   // app/ui-api/traces/route.ts
   import { NextResponse } from 'next/server'
   import { z } from 'zod'
   import { TraceService } from '@/src/services/trace-service'

   const querySchema = z.object({
     service: z.string().min(1, 'service is required'),
     limit: z.coerce.number().int().positive().max(200).default(50),
   })
   ```

2. **Parse and validate before touching anything else.** `URL.searchParams` gives
   strings, so `z.coerce.number()` handles the `limit` conversion; a failed parse
   short-circuits with a 400 before any backend call is attempted.

   ```ts
   export async function GET(request: Request) {
     const { searchParams } = new URL(request.url)
     const parsed = querySchema.safeParse({
       service: searchParams.get('service'),
       limit: searchParams.get('limit') ?? undefined,
     })

     if (!parsed.success) {
       return NextResponse.json(
         { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid query' },
         { status: 400 },
       )
     }

     const { service, limit } = parsed.data
   ```

3. **Delegate to the service — no `fetch`/`axios` call in the handler.** The handler
   doesn't know the backend's host or path; `TraceService` does.

   ```ts
     try {
       const traceService = new TraceService()
       const traces = await traceService.listByService(service, limit)

       return NextResponse.json({ success: true, traces })
     } catch (error) {
       return NextResponse.json(
         { success: false, error: getBackendErrorMessage(error) },
         { status: statusFromError(error) },
       )
     }
   }
   ```

4. **Normalize every error through one shared helper.** Whatever the service throws
   — an HTTP error from the backend, a network failure, a validation error the
   backend itself returned — collapses to a single `error: string` field, never the
   backend's raw error body.

   ```ts
   function getBackendErrorMessage(error: unknown): string {
     if (error instanceof Error) return error.message
     return 'Unknown error'
   }

   function statusFromError(error: unknown): number {
     if (error && typeof error === 'object' && 'status' in error) {
       const status = (error as { status?: number }).status
       if (typeof status === 'number') return status
     }
     return 500
   }
   ```

That's the whole route: a Zod schema, a validate-or-400 branch, one call into
`TraceService`, and a try/catch that always returns the same envelope shape. Nothing
in this file knows the trace store's real URL, its auth scheme, or its native
response format — `TraceService` owns all of that (see
[`./03-service-layer.md`](./03-service-layer.md)).

## Rules & gotchas

- **Routes stay thin — no business logic.** If a route handler starts accumulating
  `if` branches that reshape data, retry a call, or combine two backend responses,
  that logic has leaked out of the service layer. Move it into the service and leave
  the handler as validate → delegate → normalize.
- **The browser only ever calls same-origin `ui-api` routes, never the backend
  directly.** Don't return the backend's base URL to the client "so it can poll
  itself," and don't call the backend from a client component even for a "quick"
  read. Every backend call — reads included — goes through a proxy route.
- **Validate every request, including query strings.** A `GET` with unvalidated
  query params is just as dangerous as an unvalidated `POST` body — an unbounded
  `limit`, an empty `service`, or a malformed filter can reach the backend call
  unless a Zod schema rejects it first. Validate before the service is called, not
  inside the service.
- **Keep one consistent error envelope across every route.** Every handler in
  `app/ui-api/*` should return the same `{ success, error }` (or `{ success, ...data
  }`) shape on both success and failure paths. A route that returns a bare backend
  error body, or omits `success` on one branch, forces every caller to special-case
  that one route.
- **The backend base URL and any secrets never reach the client.** Read the backend
  URL from server-only config inside the service (or the route, for the simplest
  cases) — never from a `NEXT_PUBLIC_*` var, and never pass it through in the JSON
  response "for debugging." See
  [`./01-runtime-env-injection.md`](./01-runtime-env-injection.md) for the
  server/client env split this depends on.
- **Don't let the app's top-level proxy/middleware second-guess `ui-api` routes.**
  Route-level auth and validation live in the route handler itself; the root
  proxy/middleware should let `/ui-api/*` pass through unconditionally rather than
  trying to apply page-level redirect or auth logic to API routes it wasn't designed
  to intercept.

## Source lineage

- glassflow-etl-ui/src/app/ui-api/pipeline/route.ts
- glassflow-etl-ui/src/app/ui-api/kafka/route.ts
- glassflow-etl-ui/src/app/ui-api/healthz/route.ts
- glassflow-etl-ui/src/app/ui-api/loadgen/provision/route.ts
- glassflow-etl-ui/src/app/ui-api/config.ts
- glassflow-etl-ui/src/proxy.ts
