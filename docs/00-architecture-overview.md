# Architecture overview

## What & why

This doc is the map. Every other doc in this pack (`01`–`16`) is a deep dive into one
layer; this one shows how the layers connect and why they're arranged this way. Read
it first — everything else assumes you already know these two shapes.

The whole frontend runs on two lifecycles that repeat for every feature:

1. **The request lifecycle** — a user action (or a poll, or a stream) asks the backend
   for something and gets data back into a component.
2. **The hydration lifecycle** — a backend config blob becomes live, editable client
   state (store slices, form defaults) when a view loads.

Almost every bug in a codebase like this comes from someone shortcutting one of these
two lifecycles: a component that fetches the backend directly instead of going through
a service, or a page that pokes a store slice directly instead of hydrating through the
core store. The rest of this doc explains why those shortcuts are disallowed and what
to do instead.

The reasoning behind the shape: the backend is untrusted and unstable-shaped (different
versions, partial failures, auth concerns), so nothing above the proxy-route layer is
allowed to know what the backend actually looks like. Client state is trusted and
UI-shaped, so nothing below the store layer is allowed to know what the backend actually
looks like either. The layers in between exist purely to translate one shape into the
other, in exactly one direction each.

## The shape

### Request lifecycle

Data flows from a component's intent (render, click, poll) down to the backend, and the
response flows back up through the same layers in reverse. No layer is skipped in
either direction.

```
Component (renders / user clicks "load spans")
    │  calls a typed client function
    ▼
Client API   (src/api/*)        — fetch wrapper, builds the URL, no business logic
    │
    ▼
Service      (src/services/*)   — orchestration: retries, aggregation, typed errors
    │
    ▼
Proxy route  (app/ui-api/*)     — Next.js route handler, the ONLY layer that talks
    │                              to the backend; normalizes payloads, maps errors
    ▼
Backend      (external API)
    │
    ▼  (response flows back up through the same four layers, reshaped at each hop)
Component receives typed, UI-ready data
```

Each layer has exactly one job:

- **Component** — knows *when* to ask, not *how*. Calls a client API function or a hook
  that wraps one.
- **Client API** (`src/api/*`) — a thin `fetch` wrapper. Builds the URL (respecting mock
  mode), sends the request, does light response parsing. No orchestration.
- **Service** (`src/services/*`) — the only layer allowed to have business logic:
  retries, connection lifecycle, combining multiple calls, translating backend errors
  into typed domain errors. UI-agnostic — it doesn't know about React.
- **Proxy route** (`app/ui-api/*`) — a Next.js route handler running server-side. This
  is the *only* place allowed to hold backend credentials, know the backend's real host,
  or see the backend's raw response shape. It normalizes the payload before it ever
  reaches client code.
- **Backend** — the actual observability API (trace store, metrics store, alerting
  service, whatever is behind the proxy).

See [`./02-proxy-routes.md`](./02-proxy-routes.md) for the proxy-route contract and
[`./03-service-layer.md`](./03-service-layer.md) for what belongs in a service versus a
client API function.

### Hydration lifecycle

Hydration is the other direction: a backend config object becomes live, form-editable
client state. This runs once per "load an existing thing" moment — opening a saved
alert rule, resuming a dashboard, loading a trace's detail view.

```
Backend config   (raw JSON, versioned wire format)
    │
    ▼
Version adapter  (src/adapters/version/*) — normalizes V1/V2/V3 payload shapes
    │                                        into one canonical internal shape
    ▼
coreStore.hydrateFromConfig(config)  — the single entry point; fans out to
    │                                   per-domain hydration functions
    ▼
Store slice(s)    (src/store/*)      — canonical, typed, UI-facing state
    │
    ▼
Form defaults     (React Hook Form)  — Manager reads the slice, seeds useForm()
```

This layer is the **backend-config version adapter**: its only job is absorbing
differences between wire-format versions before anything canonical sees the data.
`src/adapters/version/*` is arche-ui's own prescriptive convention for where this
lives — one adapter module per versioned domain, plus a factory that picks the right
one for the payload it's handed. (The source project kept the equivalent logic at
`src/modules/pipeline-adapters/`, with V1/V2/V3 adapters and a factory — see
[Source lineage](#source-lineage).)

By convention, the only door into the store from backend data is `hydrateFromConfig`
(or its scoped sibling, `hydrateSection`) — the pattern keeps raw backend data out of
slice setters, even though nothing at the type level stops a setter from being called
with backend-shaped data directly. Follow the convention anyway; see the gotcha below
for why.
See [`./07-hydration-adapters.md`](./07-hydration-adapters.md) for the adapter contract
and [`./05-zustand-slice-store.md`](./05-zustand-slice-store.md) for how slices are
composed and what a hydration function is allowed to touch.

## Build it

Worked example: a **span detail panel** that, given a trace ID, loads the trace's span
list and lets the user edit a label on one span.

**Request half — loading the spans:**

1. `SpanDetailPanel` component mounts and calls `useSpans(traceId)`, a hook that wraps
   a client API function.
2. `src/api/spans-api.ts` exports `fetchSpans(traceId)` — builds
   `/ui-api/traces/${traceId}/spans`, does the `fetch`, returns parsed JSON. See
   [`./03-service-layer.md`](./03-service-layer.md) for where the line is between this
   and the service below.
3. If span-loading needs orchestration (e.g., paginating until all spans are in, or
   falling back to a cached span list on error), that logic lives in
   `src/services/trace-service.ts`, not in the client API function or the component.
4. `app/ui-api/traces/[id]/spans/route.ts` is the proxy route. It reads the real backend
   URL from server-side config, calls the trace store backend, and normalizes the
   response (e.g., flattening a nested `attributes` map, mapping backend status codes to
   `{ success: boolean, ... }`) before returning JSON. Full contract in
   [`./02-proxy-routes.md`](./02-proxy-routes.md).
5. The component receives a typed `Span[]` and renders the list. It never saw the
   backend's real shape or host.

**Hydration half — seeding the edit form:**

1. The user clicks a span row to edit its label. The panel already has the span object
   in memory (from the fetch above), but the *edit form* needs to seed its defaults
   from canonical store state, not directly from the fetch response — so the span gets
   pushed through hydration first: `spanStore.hydrateSection('activeSpan', rawSpan)`.
2. If the span came from an older backend version (say, a trace service that used to
   nest labels under `meta.label` and now returns `label` top-level), a version adapter
   in `src/adapters/version/span/` normalizes it into the canonical internal shape
   before hydration touches the store. See [`./07-hydration-adapters.md`](./07-hydration-adapters.md).
3. `coreStore.hydrateSection('activeSpan', config)` fans out to the `spanStore`'s own
   hydration function, which writes the canonical fields into the slice. See
   [`./05-zustand-slice-store.md`](./05-zustand-slice-store.md) for how a slice exposes
   a hydration function without letting anything else write to it directly.
4. The `SpanLabelFormManager` reads `spanStore.activeSpan` and passes it as
   `defaultValues` to `useForm()`. The Renderer never touches the store directly — it
   only sees `control`.
5. On submit, the Manager writes back through the request lifecycle (a client API call
   to a proxy route that PATCHes the backend), and — critically — does **not** write the
   new label into the store by hand. It waits for the save to succeed, then either
   re-hydrates from the fresh backend response or calls the slice's own typed setter
   (never a raw object spread of backend JSON).

Both halves of this example touch four of the other docs in the pack:
[`./02-proxy-routes.md`](./02-proxy-routes.md) (step 4 of the request half),
[`./03-service-layer.md`](./03-service-layer.md) (step 3 of the request half),
[`./05-zustand-slice-store.md`](./05-zustand-slice-store.md) (steps 3–4 of the hydration
half), and [`./07-hydration-adapters.md`](./07-hydration-adapters.md) (step 2 of the
hydration half).

## Rules & gotchas

- **Layers are one-directional.** A component can call a client API function; a client
  API function cannot call a component. A service can call a proxy route; a proxy route
  cannot call a service. Data flows down to the backend and back up through the same
  layers — never sideways, never skipping a layer "just this once."
- **The browser never calls the backend directly.** Every backend call goes through a
  proxy route running server-side in Next.js. This is not just a style preference: it's
  the only place backend credentials and the real backend host are allowed to exist. If
  you find yourself putting a backend URL or API key in client-side code, you've broken
  this rule.
- **Hydration always goes through the core store — never raw slice writes.** It's
  tempting, when a fetch already returned the exact shape a slice wants, to just call
  the slice's internal setter with the raw response. Don't. Even when it looks like a
  no-op today, it means the slice now has two ways backend data can enter it, and the
  next backend version bump (a renamed field, a new nesting level) has to be fixed in
  two places instead of one. Route everything through `hydrateFromConfig` /
  `hydrateSection`, even when a version adapter has nothing to do this month.
- **A version adapter's job is to disappear.** Once data passes through it, nothing
  downstream — the store, the form, the component — should ever need to know which
  backend version the data originally came from. If a component is branching on
  version, hydration didn't do its job.
- **Services are UI-agnostic; client API functions are business-logic-agnostic.** If
  you're tempted to add a retry loop to a client API function, or add a `fetch` call
  directly inside a component "because it's simple," that's the seam where this
  architecture usually starts to erode. Put the retry in the service; put the fetch
  behind the client API.
- **The request and hydration lifecycles are independent, not sequential.** Loading the
  span list (request lifecycle) does not by itself put anything into the store. Only
  the explicit hydration step does. It's normal for a view to fetch data for display
  and hydrate a completely different (or overlapping) slice for editing — treat them as
  two separate flows that happen to share a component.

## Source lineage

- glassflow-etl-ui/docs/architecture/ARCHITECTURE_OVERVIEW.md
- glassflow-etl-ui/.cursor/architecture/API_ARCHITECTURE.md
- glassflow-etl-ui/.cursor/architecture/STATE_MANAGEMENT.md
- glassflow-etl-ui/.cursor/architecture/MODULE_ARCHITECTURE.md
- glassflow-etl-ui/.cursor/architecture/COMPONENT_ARCHITECTURE.md
- glassflow-etl-ui/.cursor/architecture/FORM_ARCHITECTURE.md
- glassflow-etl-ui/src/modules/pipeline-adapters/ (source of the version-adapter
  layer: V1/V2/V3 adapters + factory, distilled here as `src/adapters/version/*`)
