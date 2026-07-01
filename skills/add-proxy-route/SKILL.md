---
name: add-proxy-route
description: Use when adding a new ui-api proxy route that shields a backend call — scaffolds the route, request validation, service invocation, and error normalization.
---

# Add a proxy route

Scaffold a new `/ui-api/<name>` route the same way every other route in the pack is
built: validate with Zod, delegate to a service method that takes `{ signal }`,
normalize the result into the standard `{ success, ... }` envelope. Background and
rules live in [`../../docs/02-proxy-routes.md`](../../docs/02-proxy-routes.md) and
[`../../docs/03-service-layer.md`](../../docs/03-service-layer.md) — this file is the
procedure, not the rationale.

## When to use this

You're adding a new backend-shaped read or write that the browser needs, and no
existing `/ui-api/*` route already covers it. If you're just adding a method to an
existing service for a route that already exists, skip to step 3.

## Procedure

1. **Define or extend the Zod request schema.**
   File: the route file itself (`app/ui-api/<name>/route.ts`), or the shared schema
   file if the shape is reused elsewhere (e.g. `src/schemas/<name>.ts`).
   Small, route-local schemas live at the top of the route file, next to the handler
   that uses them — don't give a schema its own file until something else needs to
   import it. Cover every input: query params (`z.coerce.number()` for anything
   numeric off a query string), route params, or the JSON body. Nothing unvalidated
   should be allowed to reach the service call.

2. **Create `app/ui-api/<name>/route.ts` as a thin handler.**
   File: `app/ui-api/<name>/route.ts`.
   Export the HTTP method function (`GET`, `POST`, etc.). Parse `request.url`
   search params or `request.json()` through the schema from step 1 with
   `safeParse`, and short-circuit with a 400 envelope on failure — before any
   service call is attempted. The handler holds no `fetch`/`axios` call and no
   business logic; if you find yourself reshaping data or retrying here, that logic
   belongs in the service instead.

3. **Add or extend the service method, taking `{ signal }`.**
   File: `src/services/<name>-service.ts` (new file if this is a new backend
   concern; add a method to an existing service class otherwise).
   The method signature is `async <method>(...args, { signal }: { signal?: AbortSignal } = {})`.
   Forward `request.signal` from the route into this param — never invent
   cancellation inside the service. If the service is new, it also needs a
   transport interface (`src/lib/<name>-client-interface.ts`) and a factory
   (`src/lib/<name>-client-factory.ts`) per the shape in
   [`../../docs/03-service-layer.md`](../../docs/03-service-layer.md); reuse
   `withTimeout` from `src/services/with-timeout.ts` to combine the caller's
   signal with an internal timeout, and disconnect the transport in `finally`.

4. **Normalize the response and errors to the standard envelope.**
   File: `app/ui-api/<name>/route.ts` (same handler from step 2).
   Wrap the service call in `try/catch`. Success returns
   `NextResponse.json({ success: true, ...data })`. Failure returns
   `NextResponse.json({ success: false, error: <message> }, { status })` using a
   shared `getBackendErrorMessage` / `statusFromError` helper (reuse the one other
   routes already import, or add it if this is the first route in the tree) so
   every route collapses backend errors to the same `error: string` shape instead
   of leaking the backend's raw error body.

5. **Add the mock counterpart.**
   File: `app/ui-api/mock/<name>/route.ts`, plus fixtures at
   `app/ui-api/mock/data/<name>.ts` (and a state manager at
   `app/ui-api/mock/data/<name>-state.ts` if the resource needs lifecycle/CRUD
   behavior, not just static reads).
   Mirror the real route's path and response envelope exactly — same
   `{ success, ... }` shape, same field names — so `getApiUrl(<name>)` can swap
   between them with zero caller-side branching. Type the fixtures against the
   same interface or Zod schema the real response uses. A dedicated
   `add-mock-endpoint` skill covering this step in depth is a planned fast-follow;
   until then, follow [`../../docs/14-mock-api-layer.md`](../../docs/14-mock-api-layer.md)
   directly.

6. **Verify with a quick request or test.**
   Run the dev server and hit the route directly, e.g.
   `curl -s 'http://localhost:3000/ui-api/<name>?<query>' | jq`, and confirm both the
   success envelope and a deliberately invalid request (missing/bad param) return
   the expected 400 with `{ success: false, error: ... }`. If the project has route
   tests (`*.test.ts` next to the route or service), add or update one covering the
   validation-failure and service-error branches, not just the happy path.

## Worked example: `GET /ui-api/traces`

A new route that lists recent traces for one service — mirrors the walkthrough in
[`../../docs/02-proxy-routes.md`](../../docs/02-proxy-routes.md).

1. Schema, inline at the top of the route file:

   ```ts
   const querySchema = z.object({
     service: z.string().min(1, 'service is required'),
     limit: z.coerce.number().int().positive().max(200).default(50),
   })
   ```

2. Handler skeleton in `app/ui-api/traces/route.ts`:

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
     // steps 3-4 below plug in here
   }
   ```

3. Service call, added to `src/services/trace-service.ts`:

   ```ts
   const traces = await new TraceService().listByService(service, limit, {
     signal: request.signal,
   })
   ```

4. Envelope + error normalization, completing the handler:

   ```ts
     try {
       const traces = await traceService.listByService(service, limit, { signal: request.signal })
       return NextResponse.json({ success: true, traces })
     } catch (error) {
       return NextResponse.json(
         { success: false, error: getBackendErrorMessage(error) },
         { status: statusFromError(error) },
       )
     }
   ```

5. Mock counterpart: `app/ui-api/mock/traces/route.ts` reads from
   `app/ui-api/mock/data/traces.ts` (a static `Trace[]` fixture) filtered by
   `service` and sliced to `limit`, returning the identical
   `{ success: true, traces }` envelope.

6. Verify:

   ```bash
   curl -s 'http://localhost:3000/ui-api/traces?service=checkout&limit=10' | jq
   curl -s 'http://localhost:3000/ui-api/traces' | jq   # expect 400, missing `service`
   ```

## Rules carried over from the reference docs

- No `fetch`/`axios` call ever lives inside the route handler — only inside the
  service (or its transport client).
- Every service method takes `{ signal }` and forwards it into `AbortController`
  cleanup in `finally` — no exceptions for calls that feel "fast enough."
- The envelope shape (`{ success: true, ... }` / `{ success: false, error }`) is
  identical across every route, including the mock counterpart. A route that
  returns a bare backend error body forces every caller to special-case it.
- The backend's real URL and any credentials stay server-side; never surface them
  in the JSON response or read them from a `NEXT_PUBLIC_*` var.
