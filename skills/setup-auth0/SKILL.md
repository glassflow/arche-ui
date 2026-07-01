---
name: setup-auth0
description: Use when enabling or debugging Auth0 auth — wires the toggle, server-only secrets, env.js sync, conditional provider, and page protection, with the known session gotchas.
---

# Set up Auth0

Wire the drop-in Auth0 toggle the same way the reference deployment does: a
non-prefixed server flag as the single source of truth, secrets that never
get a `NEXT_PUBLIC_` twin, a client provider that only mounts when the flag
says so, and per-page server-side enforcement. Background and the full file
listing live in [`../../docs/11-auth0-recipe.md`](../../docs/11-auth0-recipe.md)
— this file is the procedure, not the rationale. Step 1 also leans on
[`../../docs/01-runtime-env-injection.md`](../../docs/01-runtime-env-injection.md)
for the general build-time-vs-runtime env split this toggle reuses.

## When to use this

You're adding Auth0 login to a deployment that currently runs without it, or
you're debugging a session that isn't behaving — a user who can't stay
logged in, a page that isn't actually protected, or a crash right after a
secret rotation. If auth is already wired and you're just protecting one
more page, skip to step 5.

## Procedure

1. **Set the env vars.** File: `.env.example` (and the deploy-time entrypoint
   script that regenerates `public/env.js` — see
   [`../../docs/01-runtime-env-injection.md`](../../docs/01-runtime-env-injection.md)
   for that mechanism).
   Add `AUTH0_ENABLED`, `AUTH0_SECRET`, `APP_BASE_URL`, `AUTH0_DOMAIN`,
   `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` — all
   runtime, server-only, non-`NEXT_PUBLIC_` — plus the client-visible
   `NEXT_PUBLIC_AUTH0_ENABLED` and `NEXT_PUBLIC_PROFILE_ROUTE`. Every var that
   carries a secret (`AUTH0_SECRET`, `AUTH0_CLIENT_SECRET`) must never grow a
   `NEXT_PUBLIC_` twin — if a later change seems to need one client-side,
   that's a sign to route the value through a server action instead, not to
   add the twin.

2. **Instantiate the `Auth0Client` and wire the auth route.**
   Files: `src/lib/auth0.ts` (new), `app/api/auth/[auth0]/route.ts` (new).
   In `src/lib/auth0.ts`, construct `new Auth0Client({ routes: { login,
   callback, logout }, session: { absoluteDuration } })` and export it
   alongside a `getSessionSafely()` wrapper (see step 6's debug checklist for
   why that wrapper exists). In the route file, export a `GET` handler that
   does nothing but `return auth0.middleware(request)` — every Auth0 flow
   (`login`, `callback`, `logout`, `me`) is delegated to the SDK, no
   per-route logic to write. Full listings in doc 11, step 2.

3. **Add the conditional `AuthProvider`.**
   File: `src/components/providers/AuthProvider.tsx` (new).
   A `'use client'` component that reads `NEXT_PUBLIC_AUTH0_ENABLED` via the
   shared `getRuntimeEnv()` helper (never `window.__ENV__` or `process.env`
   directly) and renders `<Auth0Provider>{children}</Auth0Provider>` when
   it's `'true'`, or just `{children}` otherwise — so the Auth0 client SDK
   never even mounts when auth is off. Place it as the innermost provider in
   the root layout's provider stack (see
   [`../../docs/10-providers.md`](../../docs/10-providers.md) for provider
   ordering).

4. **Sync the public flag from the server flag in the entrypoint script.**
   File: `startup.sh` (production entrypoint) — and mirror it in the local
   dev generator (`generate-env.mjs` or equivalent) so the two never drift.
   Before regenerating `public/env.js`, export
   `NEXT_PUBLIC_AUTH0_ENABLED=${AUTH0_ENABLED}` so the client-visible flag is
   always derived from the server flag, never set independently. A generator
   that only mirrors whatever `NEXT_PUBLIC_AUTH0_ENABLED` already happens to
   be is a weaker version of this and is fine for a laptop, but is not the
   pattern to copy for the deploy path.

5. **Protect a page via server-side session check.**
   File: the page's `page.tsx` (e.g. `app/dashboard/page.tsx`).
   Add `src/utils/auth-config.server.ts` once, exporting `isAuthEnabled()`
   (reads `AUTH0_ENABLED` fresh from `process.env`, falling back to
   `NEXT_PUBLIC_AUTH0_ENABLED` only if the server var was never set — see
   doc 11 step 4 for the exact body). Then in the page component:

   ```tsx
   export default async function DashboardPage() {
     if (isAuthEnabled()) {
       const session = await getSessionSafely()
       if (!session?.user) redirect('/')
     }
     return <DashboardClient />
   }
   ```

   This `if` block, repeated per protected page, is the entire enforcement
   story — see the debug checklist below for why it can't live in the proxy
   instead.

6. **Debug checklist.** Work top to bottom; each row is symptom → likely
   cause → fix.

   | Symptom | Likely cause | Fix |
   |---|---|---|
   | User is logged out right after a deploy that rotated `AUTH0_SECRET`, or `getSession()` throws instead of returning `null` | Old session cookie was encrypted under the previous `AUTH0_SECRET`; the SDK throws `ERR_JWE_DECRYPTION_FAILED` when it can't decrypt it under the new one | Call through `getSessionSafely()` (step 2), which catches exactly that error code and returns `null` — treat it as "no session," not a 500. Re-throw every other error code; those are real misconfiguration (bad `AUTH0_DOMAIN`, network failure) and should surface. |
   | `useUser()` (or any Auth0 hook) throws, or React warns about hooks changing order between renders, after adding an enable/disable branch near a component that uses it | A hook-after-conditional bug: an early return (`if (!authEnabled) return null`) was placed above the hook call, so the hook runs on some renders and not others | Call every hook unconditionally, before any early return. Do the enable/disable branching after all hooks have run inside the component, or move the branch to the parent that decides whether to render the component at all. |
   | A route added to the proxy's matcher is reachable by an unauthenticated user even though `AUTH0_ENABLED=true` | The proxy is permissive by design — it checks `isAuthEnabled()` but still calls through for every matched route; it never redirects or blocks, because parsing the session cookie at the proxy layer is fragile across SDK versions | Don't rely on the proxy matcher for protection. Add the server-side check from step 5 (`isAuthEnabled()` + `getSessionSafely()`, or `useUser()` client-side) directly in that page's own component. |
   | Auth behaves differently than expected in one environment but not another, or toggling `AUTH0_ENABLED` in one place doesn't seem to change client behavior | `NEXT_PUBLIC_AUTH0_ENABLED` drifted from `AUTH0_ENABLED` because the entrypoint script wasn't updated to derive one from the other | Confirm `startup.sh` (or the dev generator) exports `NEXT_PUBLIC_AUTH0_ENABLED=${AUTH0_ENABLED}` before regenerating `env.js` (step 4) — the public flag must always be derived, never set independently. |
   | A secret (`AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`) shows up in a client bundle or browser network tab | Something added a `NEXT_PUBLIC_` twin of a secret var, or read the secret from a client component | Remove the twin. Route the value through a server action or an API route instead — see step 1. |

## Rules carried over from the reference doc

- `AUTH0_ENABLED` (server, non-prefixed) is the single source of truth;
  `NEXT_PUBLIC_AUTH0_ENABLED` is a client-side rendering hint only, never the
  primary enforcement check.
- Enforcement lives in page components, not the proxy — every protected page
  is individually responsible for calling `getSessionSafely()` or
  `useUser()` and redirecting itself.
- No secret-bearing var ever grows a `NEXT_PUBLIC_` twin.
- `getSessionSafely()` swallows exactly one error code
  (`ERR_JWE_DECRYPTION_FAILED`) and re-throws everything else.
