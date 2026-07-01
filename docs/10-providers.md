# Providers

## What & why

Cross-cutting concerns — theme, telemetry, analytics consent, backend health,
platform metadata, notifications, auth — don't belong to any one feature, but
every feature needs them available by the time it renders. The app solves
this with a fixed stack of React context providers, each wrapping the next,
composed once at the root layout. A provider is not a place to put feature
logic; it's a place to put *initialization and ambient state* — "make sure
telemetry is booted," "make sure the user has answered the consent prompt,"
"make sure auth context exists" — so that everything rendered inside `{children}`
can simply assume the concern is already handled.

This exists because cross-cutting concerns have real dependencies on each
other and on app infrastructure that isn't optional to get right. Telemetry
needs to be initialized before anything else executes so that early errors
are still captured. The analytics-consent flow needs the Zustand store to
already exist so it can read and write the user's consent decision. Auth
needs to be the innermost layer so a redirect or session check doesn't block
routing, health checks, or telemetry from running first. None of this is
enforceable by the type system — a provider's props don't say "I require the
store to be initialized first" — so the nesting order in one composition root
*is* the enforcement. Getting the order wrong doesn't fail to compile; it
fails silently (a provider reads `undefined` off a context that isn't mounted
yet) or fails loudly at runtime in a way that's hard to trace back to "the
providers are in the wrong order."

## The shape

```
ThemeProvider                    outermost — sets data-theme before first paint
  ObservabilityProvider           boots telemetry — must see errors from everything inside
    AnalyticsProviderWithUserConsent   reads/writes consent → needs the store
      HealthCheckProvider         backend reachability, blocks nothing else
        PlatformProvider          platform/tenant metadata fetch
          NotificationProvider    banner/modal/toast channels
            AuthProvider          innermost — session/identity
              {children}
```

Each provider is a `'use client'` wrapper — server components can't hold
`useState`/`useEffect`, and every provider here does. The nesting is
declared once, in the root layout, and nowhere else; a feature never
re-wraps itself in a copy of one of these providers.

Two shapes recur across the stack:

- **Fire-and-forget initializer.** `ObservabilityProvider` and the plain
  `AnalyticsProvider` variant have no visual output — they run a `useEffect`
  on mount (and sometimes an unmount cleanup), then render `children`
  unchanged. They exist purely so *something* in the tree calls
  `initializeObservability()` or `initAnalytics()` exactly once, at a
  predictable point in the tree.
- **Ambient state + occasional UI.** `HealthCheckProvider`,
  `AnalyticsProviderWithUserConsent`, and `NotificationProvider` hold local
  state and conditionally render something alongside `children` — a
  reconnect banner, a consent prompt, a toast host. They still don't fetch
  or own *feature* data; the state is scoped to the cross-cutting concern
  itself (is the backend reachable, has the user answered consent, what
  banners are queued).

The consent flow is the one provider in this stack that talks to the global
store rather than owning fully local state: it calls `useStore((s) =>
s.coreStore)` to read `consentAnswered` and to call `setAnalyticsConsent` /
`setConsentAnswered` when the user responds to the consent dialog, so the
decision survives as app state rather than living only in the provider's
own `useState`. That's *why* it has to sit somewhere the store is already
available — see Rules & gotchas.

## Build it

Worked example: adding a **`TenantProvider`** that exposes the active tenant
(id, name, plan) to the rest of the app — the AI-observability equivalent of
"which customer's traces am I looking at."

1. **Decide what it needs before it can run.** `TenantProvider` needs to
   fetch tenant metadata (an API call, comparable to how `PlatformProvider`
   fetches platform info) and it needs telemetry already booted so that a
   failed tenant fetch is captured by observability rather than silently
   swallowed. It does **not** need auth to have resolved first — quite the
   opposite, auth and later app code want to know the tenant *before* they
   run, e.g. to scope an auth redirect or a health check to the right
   backend. That fixes its position: outside `AuthProvider`, but inside
   `ObservabilityProvider`.

2. **Write it as ambient state, not a feature component.** Same shape as
   `PlatformProvider`: a context object holding `{ tenant, loading, error,
   refetch }`, populated by a `useEffect` on mount.

   ```tsx
   // src/components/providers/TenantProvider.tsx
   'use client'

   import { createContext, useContext, useEffect, useState } from 'react'
   import { getActiveTenant } from '@/src/api/tenant-api'
   import type { Tenant } from '@/src/types/tenant'

   interface TenantContextType {
     tenant: Tenant | null
     loading: boolean
     error: string | null
     refetch: () => Promise<void>
   }

   const TenantContext = createContext<TenantContextType | undefined>(undefined)

   export const useTenant = () => {
     const ctx = useContext(TenantContext)
     if (ctx === undefined) {
       throw new Error('useTenant must be used within a TenantProvider')
     }
     return ctx
   }

   export function TenantProvider({ children }: { children: React.ReactNode }) {
     const [tenant, setTenant] = useState<Tenant | null>(null)
     const [loading, setLoading] = useState(true)
     const [error, setError] = useState<string | null>(null)

     const fetchTenant = async () => {
       try {
         setLoading(true)
         setError(null)
         setTenant(await getActiveTenant())
       } catch (err) {
         setError(err instanceof Error ? err.message : 'Failed to fetch tenant')
       } finally {
         setLoading(false)
       }
     }

     useEffect(() => {
       fetchTenant()
     }, [])

     return (
       <TenantContext.Provider value={{ tenant, loading, error, refetch: fetchTenant }}>
         {children}
       </TenantContext.Provider>
     )
   }
   ```

3. **Place it in the layout, right after observability, before consent.**
   Consent tracking and health checks both benefit from knowing which
   tenant they're scoped to (a consent decision or a health check is
   arguably per-tenant), so `TenantProvider` goes immediately inside
   `ObservabilityProvider` and outside everything that might want to read
   `useTenant()`:

   ```tsx
   // app/layout.tsx
   <ThemeProvider>
     <ObservabilityProvider>
       <TenantProvider>
         <AnalyticsProviderWithUserConsent>
           <HealthCheckProvider>
             <PlatformProvider>
               <NotificationProvider>
                 <AuthProvider>
                   {children}
                 </AuthProvider>
               </NotificationProvider>
             </PlatformProvider>
           </HealthCheckProvider>
         </AnalyticsProviderWithUserConsent>
       </TenantProvider>
     </ObservabilityProvider>
   </ThemeProvider>
   ```

4. **Reasoning for exactly that slot, stated plainly.** Outside
   `AnalyticsProviderWithUserConsent` because the consent flow's tracked
   events should already be attributable to a tenant. Outside
   `HealthCheckProvider` and `PlatformProvider` for the same reason — a
   health check or platform-info fetch that's tenant-scoped needs
   `useTenant()` to already resolve to something. Inside
   `ObservabilityProvider`, not outside, because a tenant-fetch failure is
   exactly the kind of early error telemetry exists to catch. Nothing here
   requires the Zustand store, so `TenantProvider` does not need to sit
   inside any store-dependent boundary — but nothing stops a later provider
   (say, a per-tenant feature flag provider) from reading `useTenant()` and
   also writing into the store, as long as it's placed inside both.

## Rules & gotchas

- **Order matters, and it encodes a dependency graph, not a preference.**
  Theme is outermost because CSS variables and dark-mode class names need to
  exist before anything else paints. Auth is innermost because nothing else
  in this stack should block on — or be blocked by — session resolution.
  Everything between those two ends is ordered by "what does this provider
  need to already exist," not by file-creation order or alphabetical
  convenience.
- **A provider that reads or writes the store must sit where the store is
  already available.** `AnalyticsProviderWithUserConsent` calls `useStore((s)
  => s.coreStore)` to persist the consent decision — that only works because
  the store is a module-level `create()` singleton, available to any client
  component the moment it's imported, not because of provider nesting order.
  But treat store-dependent providers as if they *do* have a positional
  requirement anyway: keep them below anything whose initialization the
  store's cross-slice effects depend on (see
  [`./05-zustand-slice-store.md`](./05-zustand-slice-store.md) and
  `wireCrossSliceEffects`, which `ObservabilityProvider` wires on mount) so a
  store read never races an effect that's supposed to populate it first.
- **Keep providers thin.** A provider initializes, subscribes, or exposes
  ambient state — it does not contain feature logic, does not fetch data a
  specific page needs, and does not render feature UI. `HealthCheckProvider`
  renders a reconnect notification, not a dashboard; `PlatformProvider`
  exposes `{ platform, loading, error, refetch }`, not a settings page. If a
  provider starts growing feature-specific branches, that logic belongs in a
  module component consuming the provider's context, not in the provider.
- **Every provider in this stack is `'use client'`.** They all use
  `useState`/`useEffect`/context, none of which a server component can do.
  Don't try to make a provider a server component "for performance" — it
  will fail to compile the moment it touches a hook.
- **A provider that renders nothing but `{children}` still earns its place
  in the tree.** `ObservabilityProvider` and `AnalyticsProvider` (the
  no-consent variant) never render visible UI, but removing them removes the
  `useEffect` that boots the concern. Don't collapse a no-render provider
  into a plain function call — the component boundary is what gives it a
  predictable mount/unmount lifecycle tied to the app's actual lifetime.
- **Don't re-wrap a provider inside a feature module "just to be safe."** If
  `useTenant()` returns `undefined` context inside some deeply nested
  component, the fix is checking the root layout's nesting — never adding a
  second `<TenantProvider>` further down the tree. A second instance means
  two independent fetches and two sources of truth for the same ambient
  state.

## Source lineage

- glassflow-etl-ui/src/components/providers/ThemeProvider.tsx
- glassflow-etl-ui/src/components/providers/ObservabilityProvider.tsx
- glassflow-etl-ui/src/components/providers/AnalyticsProvider.tsx
- glassflow-etl-ui/src/components/providers/AnalyticsProviderWithUserConsent.tsx
- glassflow-etl-ui/src/components/providers/HealthCheckProvider.tsx
- glassflow-etl-ui/src/components/providers/NotificationProvider.tsx
- glassflow-etl-ui/src/components/providers/AuthProvider.tsx
- glassflow-etl-ui/src/contexts/PlatformContext.tsx
- glassflow-etl-ui/src/app/layout.tsx
