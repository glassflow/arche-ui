# Auth0 recipe

## What & why

Not every deployment of this app needs login — a local demo, an on-prem
single-tenant install, or an early customer pilot may run with auth switched
off entirely, while a hosted multi-tenant deployment needs real session
enforcement. Baking Auth0 in as a hard dependency would break the former;
skipping it would break the latter. The fix is a drop-in Auth0 integration
with one clean enable/disable toggle: when the flag is off, none of the
Auth0 SDK's client code even mounts, and pages behave as if auth doesn't
exist; when it's on, every protected page checks a real session server-side.

The other half of the problem is secrets. Auth0 needs a client secret and a
session-encryption secret, and those must never reach a browser bundle. Next
Auth0 doesn't have to reason about this, because the two variables are named
so an accident is structurally hard: anything without a `NEXT_PUBLIC_` prefix
is invisible to the client bundle no matter what, so `AUTH0_CLIENT_SECRET`
and `AUTH0_SECRET` simply never had a code path that could leak them.

This recipe is deliberately layered on top of
[`./01-runtime-env-injection.md`](./01-runtime-env-injection.md) — the
enable/disable flag has the exact same build-time-vs-runtime split as any
other env var in this app, and reuses the same `env.js`/`window.__ENV__`
mechanism to let one built image be toggled per deployment without a
rebuild.

## The shape

```
AUTH0_ENABLED (server env, non-prefixed)
    │  read fresh at request time — never inlined by Next.js
    ▼
isAuthEnabled()                     — src/utils/auth-config.server.ts
    │  primary source of truth; falls back to NEXT_PUBLIC_AUTH0_ENABLED
    │  only if AUTH0_ENABLED is unset
    │
    ├──▶ Server: page components call isAuthEnabled(), then
    │            getSessionSafely() to redirect unauthenticated users
    │
    └──▶ Client: AuthProvider reads window.__ENV__.NEXT_PUBLIC_AUTH0_ENABLED
                 (a UI hint, not enforcement) and decides whether to mount
                 the Auth0 client SDK at all

Auth0Client (server)                — src/lib/auth0.ts
    │  routes: /api/auth/{login,callback,logout}
    ▼
Auth route handler                  — app/api/auth/[auth0]/route.ts
    │  delegates everything to auth0.middleware(request)
    ▼
Auth0 (hosted login, callback, session cookie)

AuthProvider ('use client')         — wraps children in Auth0Provider only
    │                                 when NEXT_PUBLIC_AUTH0_ENABLED === 'true';
    │                                 otherwise renders children unchanged
    ▼
{children} — useUser() now works inside, or auth simply doesn't exist
```

Two independent checks of the same underlying flag, because they run in two
different trust contexts:

- **Server enforcement** — `isAuthEnabled()` + `getSessionSafely()` inside a
  page component. This is the only check that actually blocks access; it
  reads `AUTH0_ENABLED` fresh from `process.env` on every request.
- **Client UI hint** — `AuthProvider` reads the `NEXT_PUBLIC_AUTH0_ENABLED`
  runtime var (via `window.__ENV__`, same mechanism as any other runtime env
  var) to decide whether to mount `Auth0Provider` and its hooks at all. This
  is a rendering decision, not a security boundary — see Rules & gotchas.

## Build it

Worked example: protect `/dashboard` behind login, exactly the shape needed
for an AI-observability app where trace/span data is customer-sensitive.

1. **Env vars.** Add the Auth0 block to `.env.example` (or your secrets
   manager) and to the deploy-time entrypoint script that regenerates
   `env.js` — see [`./01-runtime-env-injection.md`](./01-runtime-env-injection.md)
   for that mechanism in general.

   | Name | Build vs runtime | Secret? |
   |---|---|---|
   | `AUTH0_ENABLED` | Runtime (server, non-prefixed — never inlined) | No |
   | `NEXT_PUBLIC_AUTH0_ENABLED` | Build-time client fallback; kept in sync with `AUTH0_ENABLED` by the entrypoint script at container start | No |
   | `AUTH0_SECRET` | Runtime (server-only) | Yes — session cookie encryption key |
   | `APP_BASE_URL` | Runtime (server-only) | No |
   | `AUTH0_DOMAIN` | Runtime (server-only) | No |
   | `AUTH0_ISSUER_BASE_URL` | Runtime (server-only) | No |
   | `AUTH0_CLIENT_ID` | Runtime (server-only) | No |
   | `AUTH0_CLIENT_SECRET` | Runtime (server-only) | Yes |
   | `NEXT_PUBLIC_PROFILE_ROUTE` | Build-time client | No |

   Every secret-bearing var is deliberately non-`NEXT_PUBLIC_`. If a variable
   here ever grows a `NEXT_PUBLIC_` twin the way `API_URL` does elsewhere in
   the app, that twin must carry a non-secret value only.

2. **Create the `Auth0Client`.**

   ```ts
   // src/lib/auth0.ts
   import { Auth0Client } from '@auth0/nextjs-auth0/server'

   export const auth0 = new Auth0Client({
     routes: {
       login: '/api/auth/login',
       callback: '/api/auth/callback',
       logout: '/api/auth/logout',
     },
     session: {
       absoluteDuration: 604800, // 7 days
     },
   })

   export async function getSessionSafely() {
     try {
       return await auth0.getSession()
     } catch (error: any) {
       if (error?.code === 'ERR_JWE_DECRYPTION_FAILED') {
         // Stale cookie from before an AUTH0_SECRET rotation — treat as
         // logged out instead of throwing.
         return null
       }
       throw error
     }
   }
   ```

3. **Wire the auth route.** One catch-all route handler delegates every
   Auth0 flow (`/api/auth/login`, `/callback`, `/logout`, `/me`) to the
   SDK's own middleware — there's no per-route logic to write:

   ```ts
   // app/api/auth/[auth0]/route.ts
   import { auth0 } from '@/src/lib/auth0'
   import { NextRequest } from 'next/server'

   export async function GET(request: NextRequest) {
     return auth0.middleware(request)
   }
   ```

4. **Read the enable/disable flag server-side.**

   ```ts
   // src/utils/auth-config.server.ts
   export function isAuthEnabled(): boolean {
     const serverAuth = process.env.AUTH0_ENABLED
     if (serverAuth !== undefined && serverAuth !== '') {
       return serverAuth === 'true'
     }
     // Fallback only if AUTH0_ENABLED itself was never set.
     return process.env.NEXT_PUBLIC_AUTH0_ENABLED === 'true'
   }
   ```

5. **Wrap the provider conditionally.** `AuthProvider` mounts
   `Auth0Provider` — and therefore makes `useUser()` usable at all — only
   when the client-visible flag says auth is on:

   ```tsx
   // src/components/providers/AuthProvider.tsx
   'use client'

   import { Auth0Provider } from '@auth0/nextjs-auth0/client'
   import { getRuntimeEnv } from '@/src/utils/common.client'

   export function AuthProvider({ children }: { children: React.ReactNode }) {
     const runtimeEnv = getRuntimeEnv()
     const isAuthEnabled = runtimeEnv?.NEXT_PUBLIC_AUTH0_ENABLED === 'true'

     if (!isAuthEnabled) {
       return <>{children}</>
     }
     return <Auth0Provider>{children}</Auth0Provider>
   }
   ```

   Place it as the innermost provider in the root layout's stack — see
   [`./10-providers.md`](./10-providers.md) for why auth sits innermost
   relative to telemetry, consent, and health checks.

6. **Protect the page.** `/dashboard` checks the flag, then the session,
   server-side, before rendering anything:

   ```tsx
   // app/dashboard/page.tsx
   import { redirect } from 'next/navigation'
   import { getSessionSafely } from '@/src/lib/auth0'
   import { isAuthEnabled } from '@/src/utils/auth-config.server'
   import { DashboardClient } from './DashboardClient'

   export default async function DashboardPage() {
     if (isAuthEnabled()) {
       const session = await getSessionSafely()
       if (!session?.user) {
         redirect('/')
       }
     }
     return <DashboardClient />
   }
   ```

   This is the whole enforcement story: if `AUTH0_ENABLED` is `false`, the
   `if` never runs and the page behaves as if auth doesn't exist. If it's
   `true`, an unauthenticated visitor never sees `DashboardClient` render —
   the redirect happens before any client JS for the page ships.

## Rules & gotchas

- **`AUTH0_ENABLED` (server, non-prefixed) is the single source of truth.**
  `isAuthEnabled()` reads it fresh from `process.env` on every request,
  which is what makes it safe to enforce with — Next.js never inlines a
  non-`NEXT_PUBLIC_` var, so there's no stale-bundle risk. `NEXT_PUBLIC_AUTH0_ENABLED`
  exists only because client components need *some* way to know whether to
  render auth UI, and it's a fallback in `isAuthEnabled()` for the edge case
  where `AUTH0_ENABLED` itself was never set — not the primary check.
- **The deploy entrypoint script syncs the public flag to the server flag.**
  At container start, the entrypoint exports
  `NEXT_PUBLIC_AUTH0_ENABLED=${AUTH0_ENABLED}` before regenerating
  `public/env.js`, so the two flags can't drift in a running deployment. A
  local dev generator that only mirrors whatever `NEXT_PUBLIC_AUTH0_ENABLED`
  is already set to (without deriving it from the server flag) is a weaker
  version of the same idea — fine for a laptop, not the pattern to copy for
  the deploy path. See [`./01-runtime-env-injection.md`](./01-runtime-env-injection.md)
  for why there are two generators at all and how `env.js` gets regenerated
  without a rebuild.
- **Secrets never get a `NEXT_PUBLIC_` twin.** `AUTH0_SECRET` and
  `AUTH0_CLIENT_SECRET` are read only via non-prefixed `process.env` in
  server-only files (`src/lib/auth0.ts`, the entrypoint script). If a future
  change ever needs one of these values client-side, that's a sign the
  design is wrong, not a sign to add a `NEXT_PUBLIC_` alias — route the need
  through a server action or API route instead.
- **`getSessionSafely()` swallows one specific error, not all errors.** A
  session cookie encrypted under a previous `AUTH0_SECRET` (e.g. after a
  secret rotation) fails to decrypt with the new secret, and the SDK throws
  `ERR_JWE_DECRYPTION_FAILED`. Treating that as "no session" — rather than a
  500 — is correct because it just means the browser has a stale cookie;
  the fix is a fresh login, not an error page. Any other error code is
  re-thrown, not swallowed, because those usually indicate a real
  misconfiguration (bad `AUTH0_DOMAIN`, network failure) worth surfacing.
- **The proxy is permissive; enforcement lives in page components.** The
  app's `proxy` (Next.js's route-gating layer) checks `isAuthEnabled()` but,
  even when auth is on, still calls through for every matched route — it
  never redirects or blocks. That's intentional: parsing Auth0's session
  cookie at the proxy layer is fragile across SDK versions, so every
  protected page is individually responsible for calling
  `getSessionSafely()` (server) or `useUser()` (client) and redirecting
  itself, the same way `/dashboard` does above. Don't assume adding a route
  to the proxy's matcher protects it — it doesn't. Protection only exists
  where a page component actually checks the session.
- **Avoid the hook-after-conditional bug.** React's rules of hooks require
  every hook to run unconditionally, in the same order, on every render.
  It's tempting to write a guard like "if auth is disabled, return null
  early" above a `useUser()` call, so the hook is skipped entirely when auth
  is off — but that's exactly the bug: the hook now runs on some renders and
  not others depending on a runtime value, which breaks React's hook
  bookkeeping in ways that don't always show up until a re-render sequence
  hits it. Call every hook before any early return; do the enable/disable
  branching after all hooks have run, or push the branch outside the
  component entirely (e.g. in the parent that decides whether to render
  the component at all).

## Source lineage

- glassflow-etl-ui/src/lib/auth0.ts
- glassflow-etl-ui/src/utils/auth-config.server.ts
- glassflow-etl-ui/src/app/api/auth/[auth0]/route.ts
- glassflow-etl-ui/src/components/providers/AuthProvider.tsx
- glassflow-etl-ui/src/components/shared/UserSection.tsx
- glassflow-etl-ui/src/proxy.ts
- glassflow-etl-ui/startup.sh
- glassflow-etl-ui/generate-env.mjs
- glassflow-etl-ui/.env.example
- glassflow-etl-ui/.cursor/architecture/AUTH0_ENV.md
