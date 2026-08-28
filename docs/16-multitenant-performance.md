# Multi-tenant performance

> **Net-new / profile: observability-saas** — designed for the first consumer
> (a multi-tenant hosted SaaS, workspace-as-tenant), not extracted from a
> shipped codebase. Applies to products that adopt the tenancy shape of
> [`./17-workspace-tenancy-model.md`](./17-workspace-tenancy-model.md); see the
> profile note in the [README](../README.md).

> **Terminology.** This doc's `tenantId` is the `workspaceId` of
> [`./17-workspace-tenancy-model.md`](./17-workspace-tenancy-model.md) — the
> workspace *is* the tenant. Doc 17 defines the tenancy model; this doc is
> performance and isolation *under* it. Read them as one pair.

## What & why

The source app was a single-tenant internal tool: one Kafka cluster, one
ClickHouse instance, one operator looking at one pipeline's data at a time.
Load was never a design constraint because there was never more than one
tenant's worth of data in play, and the person looking at it was trusted
infrastructure, not a customer on a shared plane. None of that holds for a
multi-tenant AI-observability frontend. Every tenant's traces, spans, and logs
live behind the same UI shell, on the same shared backend fleet, rendered by
the same React tree — and a performance mistake that would have been a minor
annoyance for one operator becomes, at scale, a cost line item, a noisy-tenant
incident, or a data leak.

Three properties make this existential rather than nice-to-have. First,
**data volume per view is now unbounded by tenant size, not by the app.** A
trace table that comfortably rendered 200 rows in the source app must now
render the same view for a tenant emitting 50,000 spans a minute, and the UI
cannot know in advance which tenant it's rendering for. Second, **every
unbounded fetch is a shared-infrastructure cost, multiplied by tenant
count.** A dashboard that fetches "everything" once and filters client-side is
a rounding error for one tenant and a capacity-planning problem for a thousand
— the query pattern that's merely wasteful in a single-tenant tool is the
query pattern that produces a five-figure ClickHouse bill in a multi-tenant
one. Third, **isolation failures compound with scale.** A query missing a
tenant-scoping clause returns wrong data for one operator in the source app;
in the hosted product it returns *another paying customer's* traces, which is
not a performance bug, it's an incident.

The fix is to treat load-bearing performance as a checklist layered onto the
patterns already established by the service layer
([`./03-service-layer.md`](./03-service-layer.md)) and the streaming layer
([`./04-sse-streaming.md`](./04-sse-streaming.md)), not as a separate
performance-engineering pass bolted on later. Every pattern below reuses
machinery those docs already define — the same `AbortController` plumbing, the
same "the transport is not fixed" posture — pointed at the specific failure
modes that only exist once there is more than one tenant. And because these
patterns only pay off if violations are caught mechanically, the per-route
budgets this doc defines are the concrete numbers Layer 1 enforces in
[`./15-architectural-guardrails.md`](./15-architectural-guardrails.md)'s
`bundle-budget` and `web-vitals` CI jobs — this doc is where those ceilings
come from; that doc is where they get enforced.

## The shape

A checklist of load-lens patterns, each layered onto an existing doc rather
than introducing a new architectural layer:

```
Load-lens checklist                     Layered onto
─────────────────────────────────────  ──────────────────────────────
1. Data virtualization                  component-architecture (./09)
   render only visible rows of a          — a table component never
   large trace/log table                  mounts 50k row nodes
2. Streaming + pagination over          service-layer (./03) +
   full fetch                            sse-streaming (./04)
   never "fetch everything, filter        — services accept
   client-side"                           { cursor, limit, signal }
3. Request cancellation                 service-layer (./03)
   every long-running fetch is            — reuse the AbortController
   cancellable                            pattern verbatim
4. Memoization discipline               component-architecture (./09)
   stop re-renders from re-deriving       — memoize the derived-data
   large row sets on every render         boundary, not everything
5. No cross-tenant over-fetch           service-layer (./03) +
   every query is scoped to exactly       hydration-adapters (./07)
   the caller's tenant, never "all"
6. Per-tenant cost awareness            service-layer (./03)
   a service knows the query it's         — cost is a property of
   about to run before it runs it         the call, checked pre-flight
7. Web Vitals budgets                   architectural-guardrails (./15)
   per-route ceilings, gated in CI,       — this doc sets the numbers,
   not an app-wide average                that doc enforces them
8. Dogfooding                           sse-streaming (./04) +
   the app instruments itself with        providers (./10)
   the same observability product it
   ships to tenants
```

The ordering matters: 1–4 are what makes a single heavy view (the trace/log
table) survive contact with a large tenant. 5–6 are what stops the backend
from being asked to do more work than the current tenant's view actually
needs. 7 is the CI-enforced ceiling that catches regressions in 1–6 before
they ship. 8 is the feedback loop that tells you the ceiling was set correctly
in the first place — an observability product that can't observe its own
frontend degrading is not credible with tenants who are trusting it to
observe theirs.

## Build it

Worked example: a trace/log table view scoped to **one tenant**, sized for
~50,000 rows in the worst case (a tenant emitting spans at a high rate over
the selected time window). The view must stay responsive at that size without
ever fetching more than the current tenant's data.

1. **Virtualize the row list — never mount 50k DOM nodes.** The table
   component only renders the rows in (and just around) the current
   scroll viewport, regardless of how many rows the underlying dataset has.

   ```tsx
   // src/modules/traces/components/SpanTable.tsx
   'use client'

   import { useVirtualizer } from '@tanstack/react-virtual'
   import { useRef } from 'react'
   import type { Span } from '@/src/lib/trace-client-interface'

   const ROW_HEIGHT_PX = 36

   export function SpanTable({ spans }: { spans: Span[] }) {
     const scrollRef = useRef<HTMLDivElement>(null)

     const virtualizer = useVirtualizer({
       count: spans.length,
       getScrollElement: () => scrollRef.current,
       estimateSize: () => ROW_HEIGHT_PX,
       overscan: 12,
     })

     return (
       <div ref={scrollRef} className="h-full overflow-auto">
         <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
           {virtualizer.getVirtualItems().map((row) => {
             const span = spans[row.index]
             return (
               <div
                 key={span.spanId}
                 data-index={row.index}
                 style={{
                   position: 'absolute',
                   top: 0,
                   transform: `translateY(${row.start}px)`,
                   height: ROW_HEIGHT_PX,
                   width: '100%',
                 }}
               >
                 {span.name} · {span.durationMs}ms
               </div>
             )
           })}
         </div>
       </div>
     )
   }
   ```

   `spans.length` can be 50,000 here — the DOM only ever holds the rows in
   `virtualizer.getVirtualItems()`, typically a few dozen. This is what makes
   step 2's pagination page size (500–2,000 rows per page) safe to hold
   entirely in memory: virtualization means "rows in memory" and "rows on
   screen" are decoupled, so a page of 2,000 rows never becomes 2,000 DOM
   nodes.

2. **Paginate the fetch — never fetch all 50k rows in one call.** The service
   method takes a cursor and a limit, exactly the same `{ signal }`-taking
   shape every service method in [`./03-service-layer.md`](./03-service-layer.md)
   already has — pagination is an additional parameter, not a different
   pattern.

   ```ts
   // src/services/trace-service.ts (extends the listSpans example from ./03-service-layer.md)
   const PAGE_SIZE = 1_000

   export class TraceService {
     async listSpansPage(
       traceId: string,
       tenantId: string,
       config: TraceClientConfig,
       { cursor, signal }: { cursor?: string; signal?: AbortSignal } = {},
     ): Promise<{ spans: Span[]; nextCursor: string | null }> {
       // tenantId is a required, non-optional argument — see rule below.
       const client = await createTraceClient(config)
       try {
         return await withTimeout(LIST_SPANS_TIMEOUT_MS, signal, (combinedSignal) =>
           client.listSpansPage(traceId, tenantId, { cursor, limit: PAGE_SIZE }, combinedSignal),
         )
       } finally {
         await client.disconnect()
       }
     }
   }
   ```

3. **Fetch one page per trigger, cancel the in-flight one on supersede —
   reuse the `AbortController` pattern from
   [`./03-service-layer.md`](./03-service-layer.md) verbatim.** The hook does
   not drain the cursor in a loop; it loads exactly one page when asked
   (on mount, and again each time the caller says "the user scrolled near
   the bottom"), tracks `hasMore`, and aborts a still-in-flight page the
   instant the trace/tenant/filter changes so a slow, stale response can
   never land after a newer one.

   ```tsx
   // src/modules/traces/hooks/useSpanPages.ts
   'use client'

   import { useCallback, useEffect, useRef, useState } from 'react'
   import { traceService } from '@/src/services/trace-service'
   import type { Span, TraceClientConfig } from '@/src/lib/trace-client-interface'

   export function useSpanPages(
     traceId: string,
     tenantId: string,
     filterKey: string,
     config: TraceClientConfig,
   ) {
     const [spans, setSpans] = useState<Span[]>([])
     const [hasMore, setHasMore] = useState(true)
     const [isLoading, setIsLoading] = useState(false)
     const controllerRef = useRef<AbortController | null>(null)
     const cursorRef = useRef<string | undefined>(undefined)

     const loadNextPage = useCallback(async () => {
       // Already fetching this trace/tenant/filter's current page, or there's
       // nothing left to fetch — a scroll-near-bottom trigger while a page is
       // still in flight is a no-op, not a second overlapping request.
       if (controllerRef.current || !hasMore) return

       const controller = new AbortController()
       controllerRef.current = controller
       setIsLoading(true)

       try {
         const page = await traceService.listSpansPage(traceId, tenantId, config, {
           cursor: cursorRef.current,
           signal: controller.signal,
         })
         if (controller.signal.aborted) return
         setSpans((prev) => [...prev, ...page.spans])
         cursorRef.current = page.nextCursor ?? undefined
         setHasMore(page.nextCursor !== null)
       } catch (error) {
         if (controller.signal.aborted) return // expected — superseded, not a failure
         throw error
       } finally {
         if (controllerRef.current === controller) controllerRef.current = null
         setIsLoading(false)
       }
     }, [traceId, tenantId, config, hasMore])

     useEffect(() => {
       // A new filter (or a new trace) supersedes whatever page fetch is
       // still in flight and resets pagination state back to page one.
       controllerRef.current?.abort()
       controllerRef.current = null
       cursorRef.current = undefined
       setSpans([])
       setHasMore(true)
     }, [traceId, tenantId, filterKey])

     useEffect(() => {
       return () => controllerRef.current?.abort()
     }, [])

     return { spans, hasMore, isLoading, loadNextPage }
   }
   ```

   This is the same "signal comes from the caller, cleanup runs regardless of
   which path got there" contract as [`./03-service-layer.md`](./03-service-layer.md)
   — the only new piece is *where* the controller gets created (a component
   hook reacting to filter/trace changes and to scroll-driven page requests)
   rather than a proxy route reacting to `request.signal`.

   Wire `loadNextPage` to the virtualizer built in step 1 — the range the
   virtualizer reports is what decides *when* the next page is worth fetching,
   not a timer or an eager loop:

   ```tsx
   // inside SpanTable, alongside the useVirtualizer call from step 1
   const { spans, hasMore, isLoading, loadNextPage } = useSpanPages(
     traceId,
     tenantId,
     filterKey,
     config,
   )

   const virtualizer = useVirtualizer({
     count: spans.length,
     getScrollElement: () => scrollRef.current,
     estimateSize: () => ROW_HEIGHT_PX,
     overscan: 12,
   })

   useEffect(() => {
     const [lastItem] = virtualizer.getVirtualItems().slice(-1)
     if (!lastItem) return
     // Within 20 rows of the end of what's loaded so far — and not already
     // fetching, and more pages exist — is "near the bottom."
     if (lastItem.index >= spans.length - 20 && hasMore && !isLoading) {
       loadNextPage()
     }
   }, [virtualizer.getVirtualItems(), spans.length, hasMore, isLoading, loadNextPage])
   ```

   50,000 rows at `PAGE_SIZE = 1_000` is now up to 50 requests total, but they
   fire one at a time as the user actually scrolls that far — not 50
   back-to-back requests the moment the trace/tenant/filter changes. A tenant
   whose view of a trace never scrolls past row 3,000 triggers three page
   fetches, not fifty.

4. **Memoize at the derived-data boundary, not everywhere.** The expensive
   step in a trace table isn't rendering a row, it's re-deriving sorted or
   filtered views of a 50k-row array on every parent re-render. Memoize that
   boundary; don't reach for `React.memo` on every leaf component reflexively.

   ```tsx
   const sortedSpans = useMemo(
     () => [...spans].sort((a, b) => b.durationMs - a.durationMs),
     [spans],
   )
   ```

5. **Never fetch beyond the current tenant.** `listSpansPage` above takes
   `tenantId` as a required argument that flows into the query the transport
   builds — there is no code path in the service layer that can construct a
   query without it, and no "admin view" shortcut that fetches across
   tenants and filters in the browser.

6. **Web Vitals and bundle budgets, per route class.** Route classes and
   their ceilings, enforced by the `bundle-budget` and `web-vitals` CI jobs
   defined in [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md):

   | Route class | Example | First-load JS ceiling | LCP budget |
   |---|---|---|---|
   | Shell / list views | `/dashboard/[tenantId]` | 180 KB | 2.0s |
   | Heavy data views | `/dashboard/[tenantId]/traces/[traceId]` | 220 KB | 2.5s |
   | Settings / low-traffic | `/dashboard/[tenantId]/settings/*` | 150 KB | 2.0s |

   The trace/log table above lands in "heavy data views" — its higher ceiling
   is a deliberate, reviewed allowance for the virtualization library and
   table chrome, not an escape hatch for unrelated bloat.

   These per-route ceilings sit on top of one more budget that isn't a route
   class at all: the **app shell / shared entry chunk** (`main-*.js`, ~120 KB)
   that every route loads before its own route-class bundle — the floor every
   route's first-load JS pays on top of, not part of any row above.

## Rules & gotchas

- **Never fetch all tenants' data — not even for an admin or superuser
  view.** Every service method that queries tenant-scoped data takes a
  required `tenantId` (or equivalent) parameter with no "fetch all" mode. An
  admin-facing aggregate view is a separate, explicitly-audited service path
  with its own access control — never a client-side loop that iterates
  tenants and concatenates results, and never a missing `WHERE tenant_id = ?`
  "fixed later."
- **Every long-running fetch is cancellable.** If a service method can run
  longer than a UI interaction (scrolling past a page, changing a filter,
  navigating away), it takes `{ signal }` per
  [`./03-service-layer.md`](./03-service-layer.md) and the caller aborts the
  previous request before starting the next one. A component that fires a
  new fetch without cancelling the old one on every filter keystroke is the
  single most common way a "fast" table view turns into a page issuing ten
  overlapping queries against the same tenant's data.
- **Big lists are always virtualized — there is no row-count threshold below
  which it's skipped.** A table built without virtualization "because this
  tenant only has 300 rows today" breaks the day that tenant's traffic grows,
  and by then the component is load-bearing across several views. Build the
  trace/log table virtualized from the first commit, not as a later
  retrofit.
- **Pagination page size and virtualization overscan are independent
  knobs — don't conflate them.** Page size (how many rows one fetch returns)
  is a network/backend-cost decision; overscan (how many extra rows render
  outside the viewport) is a scroll-smoothness decision. Tuning one to fix a
  problem in the other produces a page size too small to be efficient or an
  overscan large enough to defeat virtualization's purpose.
- **Measure with real user monitoring, not just lab.** A Lighthouse CI run in
  [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md)
  catches a regression against a synthetic, single-tenant-shaped fixture. It
  cannot catch "tenant X's 50k-span dashboard takes 9 seconds to interactive
  on a mid-tier Android device" — that only shows up in field data (Core Web
  Vitals collected from real sessions, broken out by route class and, where
  volume allows, by tenant size tier). Lab budgets are the CI gate; RUM is
  the signal that tells you whether the gate's thresholds are still the right
  ones.
- **Per-tenant cost is a service-layer concern, not an afterthought.** A
  service method that's about to run an expensive aggregation should be able
  to answer "roughly how much backend work does this call cost" before
  issuing it — a page-size cap, a required time-range bound, or a rate limit
  keyed on tenant ID. A single tenant able to trigger an unbounded query is a
  noisy-neighbor incident waiting to happen in a way it never could be in the
  single-tenant source app.
- **Dogfood the observability product on itself.** The frontend's own
  traces, error rates, and Web Vitals are piped through the same
  streaming/SSE path documented in
  [`./04-sse-streaming.md`](./04-sse-streaming.md) and surfaced with the same
  primitives tenants see. If the product can't render its own frontend's
  performance data usefully, that's a defect a tenant will find first.

## Source lineage

Net-new. No prior single-tenant version of this doc exists — the source app
had no multi-tenant load or cost surface. The one reused piece of machinery
is the timeout + `AbortController` cancellation pattern:

- glassflow-etl-ui/src/services/kafka-service.ts
