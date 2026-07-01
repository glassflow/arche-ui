# Service layer

## What & why

A service is the one typed place in the codebase that knows how to talk to a piece
of the backend. `src/services/*` is where retries live, where a raw backend error
becomes a typed domain error, where a slow call gets a timeout, and where a call
gets cancelled cleanly instead of leaking a socket or a listener. Nothing above this
layer — a component, a hook, a client API wrapper — is allowed to hold that logic
itself.

This exists because "just fetch it inline" always grows. A component that calls
`fetch()` directly starts fine, then needs a timeout, then needs to handle the user
navigating away mid-request, then needs a retry, then needs three different error
messages for three different failure modes. Each of those is orchestration, not
rendering, and putting it in a component means it can't be reused by another
component, can't be unit-tested without mounting React, and can't be swapped to a
different transport without touching UI code. A service is where that orchestration
lives instead — UI-agnostic, independently testable, and the only thing the proxy
route (see [`./02-proxy-routes.md`](./02-proxy-routes.md)) is allowed to call.

The second reason this layer exists is cancellation. Every call a service makes has
a caller that might stop caring — a component that unmounted, a request whose client
disconnected, a poll superseded by a newer one. A service that doesn't accept a
cancellation signal can't stop in-flight work when that happens; it just keeps a
socket open and a timer running for no one. Every public method on a service
therefore takes `{ signal }`, wires it into an `AbortController`, and enforces its own
timeout on top — so a caller gets a clean, typed error either way, and the service
always tears itself down in a `finally` block regardless of which path got there.

The third reason is that the backend behind a service is not fixed. Whether calls go
out over a client library, an HTTP call, or a gateway process depends on
configuration the service receives at call time — not on which code path was
compiled. A factory picks the concrete implementation of a shared interface, and the
service only ever talks to that interface, so the caller-facing shape stays identical
no matter which transport answers underneath.

## The shape

```
Caller (proxy route, another service)
    │  await traceService.listSpans(traceId, { signal })
    ▼
Service class          src/services/trace-service.ts
    │  1. build/validate call-specific input
    │  2. get a transport instance from the factory
    │  3. combine the caller's signal with an internal timeout via AbortController
    │  4. call the transport, always through the shared interface
    │  5. catch, classify (aborted vs. real failure), log structured error, rethrow typed
    │  6. finally: clean up (disconnect / clear timers) — runs on every exit path
    ▼
Transport interface    src/lib/trace-client-interface.ts   (ITraceClient)
    ▲
    │  implemented by
    ▼
Concrete client(s)     src/lib/trace-client.ts, src/lib/trace-gateway-client.ts
    │  chosen by
    ▼
Factory                src/lib/trace-client-factory.ts     (createTraceClient(config))
```

A few properties hold for every service in `src/services/*`, not just the trace
example below:

- **No React.** A service imports nothing from `react`, `next/navigation`, or any
  hook. It is a plain class (or a small set of exported functions) that could run
  under `node script.js` with no UI runtime attached.
- **Every public method takes `{ signal }`.** The signal comes from the caller (a
  proxy route forwarding `request.signal`, or another service composing calls). The
  service does not invent cancellation on its own — it receives it and respects it.
- **Timeouts are internal, cancellation is external — both use the same
  `AbortController`.** A service enforces its own timeout (so a hung transport can't
  block forever even if the caller never cancels) and also honors the caller's
  `signal` (so an early caller-side cancel stops the call immediately). Both paths
  abort the same controller; the service can't tell which one fired without checking,
  and usually doesn't need to.
- **The transport is an interface, not a concrete class.** A service method never
  imports a specific client (`TraceGatewayClient`, `TraceHttpClient`) directly — it
  asks a factory for "the right client for this config" and only ever calls methods
  declared on the shared interface.
- **Errors are classified and logged before they're rethrown.** A timeout, a network
  failure, and a genuine backend error message are three different things, and a
  caller (usually a proxy route) needs to tell them apart to pick the right HTTP
  status. The service logs a structured record with enough context to debug the
  failure later, then rethrows a typed error — never a bare `throw error` with no
  context, and never a swallowed error that returns `undefined`.

## Build it

Worked example: `TraceService.listSpans(traceId, { signal })` — fetch the spans for
one trace, with a caller-supplied cancellation signal, an internal timeout, and a
pluggable transport underneath.

1. **Define the transport interface.** Every concrete client — a direct HTTP client
   today, maybe a gRPC gateway client later — implements this and nothing else. The
   service will only ever call these three methods.

   ```ts
   // src/lib/trace-client-interface.ts
   export interface Span {
     spanId: string
     traceId: string
     name: string
     startTimeUnixNano: string
     durationMs: number
   }

   export interface TraceClientConfig {
     endpoint: string
     apiKey?: string
   }

   export interface ITraceClient {
     connect(): Promise<void>
     disconnect(): Promise<void>
     /** @param signal - combined caller+timeout signal; abort mid-call on fire */
     listSpans(traceId: string, signal?: AbortSignal): Promise<Span[]>
   }
   ```

2. **Write the factory.** The factory is the only place that decides which concrete
   client answers a given config — a service never `new`s a client directly.

   ```ts
   // src/lib/trace-client-factory.ts
   import { ITraceClient, TraceClientConfig } from './trace-client-interface'
   import { TraceHttpClient } from './trace-http-client'
   import { TraceGatewayClient } from './trace-gateway-client'

   export async function createTraceClient(config: TraceClientConfig): Promise<ITraceClient> {
     // Today this is a straight branch; it can grow into a lookup table (e.g. by
     // auth method, like the Kafka client factory this pattern is lineaged from)
     // without any caller of createTraceClient noticing.
     if (config.endpoint.startsWith('grpc://')) {
       return new TraceGatewayClient(config)
     }
     return new TraceHttpClient(config)
   }
   ```

3. **Write the timeout + abort helper.** This is the piece every service method
   reuses: combine the caller's `signal` with an internal timeout into one
   `AbortController`, and guarantee `clearTimeout` runs no matter how the call ends.

   ```ts
   // src/services/with-timeout.ts
   export async function withTimeout<T>(
     timeoutMs: number,
     signal: AbortSignal | undefined,
     run: (signal: AbortSignal) => Promise<T>,
   ): Promise<T> {
     const controller = new AbortController()

     // Caller cancelled (e.g. component unmounted, HTTP client disconnected)
     const onCallerAbort = () => controller.abort()
     signal?.addEventListener('abort', onCallerAbort)

     // Internal timeout — fires even if the caller never cancels
     const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

     try {
       return await run(controller.signal)
     } finally {
       clearTimeout(timeoutId)
       signal?.removeEventListener('abort', onCallerAbort)
     }
   }
   ```

4. **Write the service method.** It composes the factory, the timeout helper, and
   structured error logging — and cleans up the transport connection in `finally`
   regardless of which branch returned or threw.

   ```ts
   // src/services/trace-service.ts
   import { createTraceClient } from '@/src/lib/trace-client-factory'
   import { TraceClientConfig, Span } from '@/src/lib/trace-client-interface'
   import { withTimeout } from './with-timeout'
   import { structuredLogger } from '@/src/observability'

   const LIST_SPANS_TIMEOUT_MS = 30_000

   export class TraceService {
     async listSpans(
       traceId: string,
       config: TraceClientConfig,
       { signal }: { signal?: AbortSignal } = {},
     ): Promise<Span[]> {
       const client = await createTraceClient(config)

       try {
         return await withTimeout(LIST_SPANS_TIMEOUT_MS, signal, async (combinedSignal) => {
           await client.connect()
           return client.listSpans(traceId, combinedSignal)
         })
       } catch (error) {
         const isAborted = error instanceof Error && error.name === 'AbortError'

         structuredLogger.error('TraceService.listSpans failed', {
           traceId,
           timedOut: isAborted,
           error: error instanceof Error ? error.message : String(error),
         })

         if (isAborted) {
           throw new Error(`listSpans timed out or was cancelled after ${LIST_SPANS_TIMEOUT_MS}ms`)
         }
         throw error
       } finally {
         try {
           await client.disconnect()
         } catch (disconnectError) {
           structuredLogger.error('TraceService failed to disconnect trace client', {
             error: disconnectError instanceof Error ? disconnectError.message : String(disconnectError),
           })
         }
       }
     }
   }
   ```

That's the whole method: get a transport from the factory, run the call through the
shared timeout/abort helper, classify and log any failure with structured context,
and always disconnect in `finally`. The proxy route that calls this
(`./02-proxy-routes.md`) forwards its own `request.signal` straight into the
`{ signal }` param and never sees `ITraceClient`, `TraceHttpClient`, or the endpoint
URL at all.

## Rules & gotchas

- **Every public method takes `{ signal }` — no exceptions for "quick" calls.** Even
  a call that's expected to be fast can hang on a stalled connection. If a method
  can't be cancelled, it can't be safely called from a route handler whose own
  request might be aborted.
- **`AbortController` cleanup runs in `finally`, not just the happy path.** Clear the
  timeout and remove the caller's abort listener whether the call succeeded, threw,
  or was aborted. A timeout left running after a fast success fires later against a
  controller nobody's listening to; an uncleared event listener on a long-lived
  signal leaks across calls.
- **Services are UI-agnostic — no `react`, no `next/navigation`, no hooks.** If a
  service needs something React-flavored (a toast, a redirect), that's a sign the
  logic belongs one layer up. A service should run identically in a script, a test,
  or a route handler.
- **Log structured errors before rethrowing — never a bare `throw error`.** Include
  enough context (the identifiers involved, whether it timed out, the underlying
  message) that a failure is debuggable from logs alone. Don't log and swallow —
  always rethrow so the caller can decide the HTTP status.
- **Never `new` a concrete client directly in a service method.** Always go through
  the factory. A service that imports `TraceGatewayClient` directly has hardcoded the
  transport, which defeats the reason the interface and factory exist.
- **Distinguish "timed out / cancelled" from "backend said no."** Checking
  `error.name === 'AbortError'` (or a message match, if the transport doesn't set
  `name`) before rethrowing lets the proxy route map cancellation to a different
  outcome than a genuine backend failure — collapsing both into the same generic
  error loses information the caller needs.
- **Disconnect/cleanup failures are logged, not thrown.** A failure to close a
  connection in `finally` shouldn't mask or replace the original error from the `try`
  block — log it and move on, don't let a cleanup exception become the thrown error.

## Source lineage

- glassflow-etl-ui/src/services/kafka-service.ts
- glassflow-etl-ui/src/services/clickhouse-service.ts
- glassflow-etl-ui/src/lib/kafka-client-interface.ts
- glassflow-etl-ui/src/lib/kafka-client-factory.ts
