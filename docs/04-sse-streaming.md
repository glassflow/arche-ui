# SSE streaming

## What & why

A dashboard that shows live status for N things — pipelines, services, error
rates — has exactly one good transport option per browser tab: a single
Server-Sent Events connection that every subscriber shares. Not one
`EventSource` per widget, not one polling timer per component. One connection,
multiplexed across however many entities the UI currently cares about, with a
transparent fallback to polling when the stream can't be established at all.

This exists because the naive version doesn't scale. If every card on a page
opens its own `EventSource` or its own `setInterval`, then a page with twenty
cards makes twenty connections (browsers cap concurrent connections per origin,
so most of those twenty queue behind the first six) or twenty redundant
polling requests hitting the same backend on staggered, uncoordinated
schedules. Centralizing the transport in a singleton manager fixes both: one
connection carries updates for every subscribed entity, and components mount
and unmount without touching the connection lifecycle at all — they just
subscribe to an ID and get called back when that ID's data changes.

The second reason is that live connections fail, and they fail in ways a
component shouldn't have to know about. A laptop goes to sleep, a k8s ingress
recycles a connection, a corporate proxy doesn't support `text/event-stream`
at all. The manager owns reconnection — with exponential backoff, so a flapping
connection doesn't hammer the server — and owns the decision to give up on SSE
entirely and fall back to plain HTTP polling. Crucially, the polling fallback
exposes the *same* subscribe/unsubscribe/callback interface as the SSE path.
A component that called `liveMetricsManager.subscribe(['svc-checkout'])` never
finds out whether the numbers it's receiving came from a stream or a poll
loop — and that's the point. Swapping transports is an implementation detail
the UI layer is not allowed to care about.

## The shape

```
Component (e.g. ErrorRatePanel)
    │  liveMetricsManager.subscribe(['svc-checkout'])
    │  liveMetricsManager.addMetricListener(cb)
    ▼
LiveMetricsManager (singleton)      src/services/live-metrics-manager.ts
    │  - one EventSource for the whole tab
    │  - Set<serviceId> of active subscriptions (multiplexed onto that one connection)
    │  - Set<callback> of listeners, notified on every update regardless of
    │    which serviceId changed
    │  - reconnect: exponential backoff, capped, up to maxReconnectAttempts
    │  - heartbeat watchdog: no heartbeat within timeout -> treat as dead, reconnect
    │  - on visibilitychange: tab hidden -> disconnect; tab visible -> reconnect
    │  - after maxReconnectAttempts: flip fallbackActive, dispatch a DOM event
    ▼
EventSource -> GET /api/metrics/stream?serviceIds=svc-checkout,svc-billing
    (server polls the metrics backend, emits only on change, sends heartbeats)

──────────────────────── same callback interface ────────────────────────

LiveMetricsPollingManager             src/services/live-metrics-polling-manager.ts
    │  - same subscribe/unsubscribe/addMetricListener shape as the SSE manager
    │  - setInterval per subscribed batch, diffs against a cache, calls the
    │    same listeners only when a value actually changed
    ▼
GET /api/metrics/snapshot?serviceIds=svc-checkout,svc-billing   (plain JSON)
```

A few properties hold regardless of which manager is currently active:

- **One connection per tab, not per subscriber.** `subscribe()` adds IDs to a
  shared set and (re)opens a single `EventSource` with the full set encoded
  in the query string. It never opens a second connection because a second
  component subscribed.
- **Multiplexing, not per-ID connections.** Every listener registered via
  `addMetricListener` gets called for every update on every subscribed ID.
  Components filter for the ID they care about; the manager doesn't fan out
  by ID internally.
- **Reconnection is exponential, capped, and finite.** Backoff grows as
  `baseDelay * 2^(attempt-1)` up to a `maxReconnectDelay` ceiling, and gives up
  — triggering the polling fallback — after `maxReconnectAttempts`.
- **A heartbeat is the only proof the stream is still alive.** `onerror` does
  not fire for a silently stalled connection (e.g. a load balancer that closed
  the socket without a TCP reset). The manager tracks the last heartbeat
  timestamp and forces a reconnect if too much time passes without one, even
  if `EventSource` itself never reports an error.
- **The polling manager is not a lesser cousin — it is the same interface.**
  `subscribe`, `unsubscribe`, `addMetricListener`, `getMetric` all exist on
  both managers with identical signatures. An adapter hook picks which one is
  "live" and the component importing the hook never imports either manager
  directly.
- **Visibility changes are lifecycle events.** A backgrounded tab closes its
  connection (no point streaming to a tab nobody's watching); a foregrounded
  tab with active subscriptions reopens one. This is not an optimization
  that can be skipped — without it, background tabs accumulate dead
  connections the server has to keep polling for.

## Build it

Worked example: `LiveMetricsManager` — a live tail of a service's error-rate
metric, multiplexed across however many services the dashboard currently has
on screen.

1. **Define the event and config types.** The server emits one shape per
   event type; the manager only needs to agree on the contract.

   ```ts
   // src/types/live-metrics.ts
   export interface ErrorRateSample {
     serviceId: string
     errorRate: number // 0..1
     windowSec: number
   }

   export type MetricsConnectionState =
     | 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

   export interface LiveMetricsManagerConfig {
     endpoint?: string
     maxReconnectAttempts?: number
     reconnectDelay?: number
     maxReconnectDelay?: number
     heartbeatTimeout?: number
     enablePollingFallback?: boolean
   }

   export const DEFAULT_LIVE_METRICS_CONFIG: Required<LiveMetricsManagerConfig> = {
     endpoint: '/api/metrics/stream',
     maxReconnectAttempts: 5,
     reconnectDelay: 1000,
     maxReconnectDelay: 30_000,
     heartbeatTimeout: 45_000, // server heartbeats every 30s
     enablePollingFallback: true,
   }
   ```

2. **Write the singleton with subscription multiplexing.** `subscribe` and
   `unsubscribe` mutate one shared `Set<string>` and reconnect with the full,
   updated ID list — they never open a second connection.

   ```ts
   // src/services/live-metrics-manager.ts
   import {
     ErrorRateSample, MetricsConnectionState,
     LiveMetricsManagerConfig, DEFAULT_LIVE_METRICS_CONFIG,
   } from '@/src/types/live-metrics'

   type MetricListener = (serviceId: string, sample: ErrorRateSample) => void
   type ConnectionListener = (state: MetricsConnectionState) => void

   class LiveMetricsManagerImpl {
     private static instance: LiveMetricsManagerImpl | null = null
     private config: Required<LiveMetricsManagerConfig>
     private eventSource: EventSource | null = null
     private connectionState: MetricsConnectionState = 'disconnected'
     private subscribedIds = new Set<string>()
     private metricListeners = new Set<MetricListener>()
     private connectionListeners = new Set<ConnectionListener>()
     private cache = new Map<string, ErrorRateSample>()
     private reconnectAttempts = 0
     private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null
     private lastHeartbeat = 0
     private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null
     private fallbackActive = false

     private constructor(config: LiveMetricsManagerConfig = {}) {
       this.config = { ...DEFAULT_LIVE_METRICS_CONFIG, ...config }
       this.setupVisibilityHandler()
     }

     static getInstance(config?: LiveMetricsManagerConfig): LiveMetricsManagerImpl {
       if (!this.instance) this.instance = new LiveMetricsManagerImpl(config)
       return this.instance
     }

     // ---- Public API — identical on LiveMetricsPollingManager ----

     getMetric(serviceId: string): ErrorRateSample | null {
       return this.cache.get(serviceId) ?? null
     }

     subscribe(serviceIds: string[]): void {
       const newIds = serviceIds.filter((id) => !this.subscribedIds.has(id))
       if (newIds.length === 0) return
       newIds.forEach((id) => this.subscribedIds.add(id))
       this.reconnect()
     }

     unsubscribe(serviceIds: string[]): void {
       let changed = false
       serviceIds.forEach((id) => {
         if (this.subscribedIds.delete(id)) {
           changed = true
           this.cache.delete(id)
         }
       })
       if (!changed) return
       this.subscribedIds.size === 0 ? this.disconnect() : this.reconnect()
     }

     addMetricListener(cb: MetricListener): () => void {
       this.metricListeners.add(cb)
       return () => this.metricListeners.delete(cb)
     }

     addConnectionListener(cb: ConnectionListener): () => void {
       this.connectionListeners.add(cb)
       cb(this.connectionState)
       return () => this.connectionListeners.delete(cb)
     }

     isFallbackActive(): boolean {
       return this.fallbackActive
     }

     resetFallback(): void {
       this.fallbackActive = false
       this.reconnectAttempts = 0
     }

     disconnect(): void {
       this.clearReconnectTimeout()
       this.clearHeartbeatCheck()
       this.eventSource?.close()
       this.eventSource = null
       this.setConnectionState('disconnected')
     }

     reconnect(): void {
       this.disconnect()
       this.connect()
     }

     // ---- Private ----

     private connect(): void {
       if (this.subscribedIds.size === 0 || this.fallbackActive) return

       const ids = Array.from(this.subscribedIds).join(',')
       this.setConnectionState('connecting')
       this.eventSource = new EventSource(
         `${this.config.endpoint}?serviceIds=${encodeURIComponent(ids)}`,
       )

       this.eventSource.onopen = () => {
         this.setConnectionState('connected')
         this.reconnectAttempts = 0
         this.lastHeartbeat = Date.now()
         this.startHeartbeatCheck()
       }

       this.eventSource.addEventListener('error_rate', (event) => {
         const sample = JSON.parse((event as MessageEvent).data) as ErrorRateSample
         this.cache.set(sample.serviceId, sample)
         this.metricListeners.forEach((cb) => cb(sample.serviceId, sample))
       })

       this.eventSource.addEventListener('heartbeat', (event) => {
         this.lastHeartbeat = (JSON.parse((event as MessageEvent).data) as { timestamp: number }).timestamp
       })

       this.eventSource.onerror = () => this.handleConnectionError()
     }

     private handleConnectionError(): void {
       this.clearHeartbeatCheck()
       this.eventSource?.close()
       this.eventSource = null
       this.reconnectAttempts++

       if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
         this.setConnectionState('error')
         if (this.config.enablePollingFallback) {
           this.fallbackActive = true
           window.dispatchEvent(new CustomEvent('live-metrics-fallback-triggered'))
         }
         return
       }

       const delay = Math.min(
         this.config.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
         this.config.maxReconnectDelay,
       )
       this.setConnectionState('reconnecting')
       this.reconnectTimeoutId = setTimeout(() => this.connect(), delay)
     }

     private startHeartbeatCheck(): void {
       this.clearHeartbeatCheck()
       this.heartbeatIntervalId = setInterval(() => {
         if (Date.now() - this.lastHeartbeat > this.config.heartbeatTimeout) {
           this.handleConnectionError() // stalled socket, no error event fired
         }
       }, this.config.heartbeatTimeout / 2)
     }

     private clearHeartbeatCheck(): void {
       if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId)
       this.heartbeatIntervalId = null
     }

     private clearReconnectTimeout(): void {
       if (this.reconnectTimeoutId) clearTimeout(this.reconnectTimeoutId)
       this.reconnectTimeoutId = null
     }

     private setConnectionState(state: MetricsConnectionState): void {
       if (this.connectionState === state) return
       this.connectionState = state
       this.connectionListeners.forEach((cb) => cb(state))
     }

     private setupVisibilityHandler(): void {
       document.addEventListener('visibilitychange', () => {
         if (document.hidden) {
           this.disconnect()
         } else if (this.subscribedIds.size > 0 && !this.fallbackActive) {
           this.connect()
         }
       })
     }
   }

   export const liveMetricsManager = LiveMetricsManagerImpl.getInstance()
   ```

3. **Write the polling manager with the same shape.** No `EventSource`, no
   backoff, no heartbeat — just a `setInterval` and a diff against the same
   kind of cache — but `subscribe`, `unsubscribe`, `addMetricListener`, and
   `getMetric` are call-compatible with the manager above.

   ```ts
   // src/services/live-metrics-polling-manager.ts
   const POLL_INTERVAL_MS = 5000
   const cache = new Map<string, ErrorRateSample>()
   const listeners = new Set<MetricListener>()
   let subscribedIds = new Set<string>()
   let intervalId: ReturnType<typeof setInterval> | null = null

   function startPolling() {
     if (intervalId) return
     intervalId = setInterval(async () => {
       if (subscribedIds.size === 0) return
       const ids = Array.from(subscribedIds).join(',')
       const res = await fetch(`/api/metrics/snapshot?serviceIds=${ids}`)
       const samples: ErrorRateSample[] = await res.json()
       samples.forEach((sample) => {
         const prev = cache.get(sample.serviceId)
         if (prev?.errorRate === sample.errorRate) return // only notify on change
         cache.set(sample.serviceId, sample)
         listeners.forEach((cb) => cb(sample.serviceId, sample))
       })
     }, POLL_INTERVAL_MS)
   }

   export const liveMetricsPollingManager = {
     getMetric: (id: string) => cache.get(id) ?? null,
     subscribe(ids: string[]) {
       ids.forEach((id) => subscribedIds.add(id))
       startPolling()
     },
     unsubscribe(ids: string[]) {
       ids.forEach((id) => { subscribedIds.delete(id); cache.delete(id) })
       if (subscribedIds.size === 0 && intervalId) {
         clearInterval(intervalId)
         intervalId = null
       }
     },
     addMetricListener(cb: MetricListener) {
       listeners.add(cb)
       return () => listeners.delete(cb)
     },
   }
   ```

4. **Write the adapter hook that picks between them.** This is the only place
   in the app that imports both managers by name — everything else imports
   the hook.

   ```ts
   // src/hooks/useLiveMetrics.ts
   import { useEffect, useState } from 'react'
   import { liveMetricsManager } from '@/src/services/live-metrics-manager'
   import { liveMetricsPollingManager } from '@/src/services/live-metrics-polling-manager'

   export function useLiveMetrics(serviceIds: string[]) {
     const [active, setActive] = useState(() =>
       liveMetricsManager.isFallbackActive() ? liveMetricsPollingManager : liveMetricsManager,
     )
     const [samples, setSamples] = useState<Record<string, ErrorRateSample>>({})

     useEffect(() => {
       const onFallback = () => setActive(liveMetricsPollingManager)
       window.addEventListener('live-metrics-fallback-triggered', onFallback)

       active.subscribe(serviceIds)
       const unsubscribeListener = active.addMetricListener((id, sample) =>
         setSamples((prev) => ({ ...prev, [id]: sample })),
       )

       return () => {
         window.removeEventListener('live-metrics-fallback-triggered', onFallback)
         unsubscribeListener()
         active.unsubscribe(serviceIds)
       }
     }, [active, serviceIds])

     return samples
   }
   ```

   A component calls `useLiveMetrics(['svc-checkout', 'svc-billing'])` and
   renders `samples['svc-checkout']?.errorRate`. It never knows, and never
   needs to know, whether that number arrived over SSE or a poll.

## Rules & gotchas

- **Never bind the upstream fetch or its teardown to the incoming request's
  `signal` in the server-side SSE route.** This is the single most expensive
  lesson in this pattern: on a Kubernetes cluster sitting behind an ingress,
  the framework's `request.signal` on the SSE route handler can fire `abort`
  prematurely — not because the client actually disconnected, but as an
  artifact of how the ingress/proxy manages the long-lived connection. Wiring
  `signal: request.signal` into the upstream `fetch()` (or into its cleanup)
  makes every connection self-abort shortly after opening: the route returns
  a one-shot error frame, the client's `EventSource` closes and immediately
  reconnects, and the UI sits in "connecting" forever with no data ever
  arriving. This is silent — nothing throws in an obviously wrong way, logs
  just show endless reconnect churn — and it reached production once (as a
  real regression, then regressed a second time weeks later when a "temp
  diagnostic" commit re-added the same binding). **Use the `ReadableStream`'s
  own `cancel()` callback for client-disconnect teardown instead** — it fires
  when the client actually goes away, without inheriting the ingress's
  unrelated abort behavior. If you're ever tempted to reach for `req.signal`
  again in an SSE route, get server-side evidence first (does `cancel()`
  already fire correctly on real disconnects? is something actually leaking?)
  — it cannot be validated by testing locally, and it broke prod when done
  without that evidence.
- **Disable proxy/ingress buffering on the SSE response**, e.g.
  `X-Accel-Buffering: no` for nginx-style ingresses. Without it, an
  intermediary buffers the `text/event-stream` body and events arrive in
  bursts (or not at all) instead of as they're emitted — "works locally,
  silent on the cluster" is the exact symptom.
- **One `EventSource` per tab — always.** If a new component's subscription
  would otherwise trigger a second connection, that's a bug in the manager,
  not a shape to accept. Route every subscribe/unsubscribe through the
  singleton's shared ID set and reconnect with the full set, not a new
  connection per caller.
- **A heartbeat is required, not decorative.** `EventSource.onerror` does not
  reliably fire for a connection that silently stalls (socket half-closed,
  intermediary drops packets without a clean TCP reset). Track a
  last-heartbeat timestamp server-and-client-side and force a reconnect on
  the client if it goes stale — otherwise a dead connection can sit in
  `connected` state indefinitely, showing no error and no data.
- **Exponential backoff needs both a cap and a give-up point.** Uncapped
  backoff means a transient blip after ten failed attempts waits minutes to
  retry; no give-up point means a genuinely broken endpoint retries forever
  and never falls back to polling. Cap the delay (`maxReconnectDelay`) and
  cap the attempts (`maxReconnectAttempts`) — the second cap is what actually
  triggers the polling fallback.
- **The polling manager's callback interface must match the SSE manager's
  exactly** — same method names, same argument shapes, same listener
  semantics (only fire on an actual value change, not on every poll tick).
  If they drift, the adapter hook (or whatever chooses between them) leaks the
  distinction into every consumer, which defeats the reason two managers
  exist behind one hook.
- **Tear down on `visibilitychange`, not just on unmount.** A backgrounded
  tab with mounted components still "subscribed" has no reason to hold a live
  connection open — disconnect when `document.hidden` becomes true, and
  reconnect (if there are still active subscriptions) when it becomes false
  again. Skipping this means every backgrounded tab a user has open keeps
  polling the server for data nobody's looking at.

## Source lineage

- glassflow-etl-ui/src/services/pipeline-sse-manager.ts
- glassflow-etl-ui/src/services/pipeline-state-manager.ts
- glassflow-etl-ui/src/types/sse.ts
- glassflow-etl-ui/docs/implementations/SSE_PIPELINE_STATUS_STREAMING.md
