# Workspace tenancy model

> **Net-new / prescriptive** — designed for the new project. The pattern is
> extracted from GlassFlow's *first* product (a Preact/MobX app in a separate
> repo), not from the single-tenant source app the rest of this pack is drawn
> from. See [Source lineage](#source-lineage).

## What & why

The source app this pack is extracted from (the ClickHouse ETL UI) was
single-tenant: one operator, one backend, no concept of "whose data is this."
[`./16-multitenant-performance.md`](./16-multitenant-performance.md) covers the
*performance and isolation* consequences of that assumption breaking. This doc
covers the layer underneath it — the **tenancy model itself**: what the tenant,
the workspace, and the agent are, how a user is bound to them, and how the
active tenant travels through the app. Doc 16 is how a tenant-scoped view stays
fast and can't leak; doc 17 is what "a tenant" *is* and where its identifier
lives.

The model is not invented here. GlassFlow's first product already shipped a
working multi-tenant frontend, and its shape is the lineage: a user belonged to
many **organizations** (the tenant), each organization held **spaces**
(groupings), and each space held **pipelines** (the resources). That worked, and
the parts that worked are kept. But it also made one decision that is the origin
of a whole class of bugs, and this doc exists mostly to correct it.

**The correction.** In the first product the *active tenant* was an ambient
value: `localStorage["activeOrganization"]`, read inline at every single call
site and passed as an `organization_id` **query parameter**. That has four
failure modes, and a multi-tenant AI-observability product hits all of them:

1. **A forgotten scope is a cross-tenant leak.** Nothing structural forces a
   query to be scoped — the `organization_id` param was `required: false` in the
   spec. One call site that forgets it returns the wrong tenant's data. In a
   hosted product that's not a bug, it's an incident (the same escalation doc 16
   describes for a missing `WHERE tenant_id`).
2. **URLs aren't shareable.** Two operators can't send each other a link to "the
   same view of the same tenant," because the tenant isn't *in* the link — it's
   in one browser's localStorage.
3. **No two tenants at once.** Two browser tabs share one localStorage, so a
   user can't watch workspace A in one tab and workspace B in another. The
   second tab silently reinterprets the first tab's data.
4. **Switching is a global reset.** Because the active tenant lived outside the
   view tree, changing it meant a `reaction` that reset every store and
   refetched — brittle, and easy to leave a stale slice behind.

The fix is to make the tenant identifier a **required path segment** and a
**required argument**, never an ambient default. The URL becomes the single
source of truth for "which tenant am I looking at," which dissolves all four
failure modes at once: the scope can't be forgotten (a route can't render
without it), links carry it, tabs are independent, and switching is ordinary
navigation.

**The reading of "tenant."** For this product the **workspace is the tenant** —
the isolation, billing, and invitation boundary. A workspace carries a nullable
`organizationId` so an enterprise org/billing umbrella can be added later
without a data migration, but nothing reads that field today and no org UI is
built (see the YAGNI rule below). This keeps the term consistent with
[`./16-multitenant-performance.md`](./16-multitenant-performance.md): **its
`tenantId` is this doc's `workspaceId`** — the same value, named for what it is
here.

## The shape

The hierarchy, and the one relationship that is many-to-many:

```
[Organization]        nullable umbrella — a field, not a feature (forward-compat)
     └─ Workspace      THE TENANT: isolation + billing + invite root
          └─ Agent     the observed AI agent; belongs to exactly one workspace

User ⇄ Workspace   via Membership { userId, workspaceId, role }
                   role ∈ 'admin' | 'member' | 'viewer'
                   one user, many workspaces, a possibly-different role in each
```

How the tenant identifier travels on a request — it enters at the URL and is
re-asserted at every layer down to the enforcement seam, never defaulted:

```
URL             /w/[workspaceId]/agents        ← single source of truth
   │
   ▼
WorkspaceProvider (src/components/providers)    ← reads the route param, exposes
   │                                              { workspaceId, workspace, role, can() }
   ▼
Component         calls a service with workspaceId, never "current" or "all"
   │
   ▼
Service           listAgents(workspaceId, …)    ← workspaceId is a REQUIRED arg
   │              (the { signal }-taking shape of ./03-service-layer.md)
   ▼
Proxy route       app/ui-api/w/[workspaceId]/…  ← THE ENFORCEMENT SEAM:
   │              verifies session user is a member of workspaceId AND has the
   │              required role, THEN calls the backend
   ▼
Backend           receives an already-authorized, already-scoped request
```

Two things are load-bearing in that diagram. First, `workspaceId` is present as
a **value in the path**, not a lookup — every layer receives it as an argument
rather than reading it from a shared place. Second, the **proxy route is the
only place authorization is enforced**; everything above it (the `can()` checks
in components) is UX, not security. Those two properties are what the rest of
this doc builds on, and what the [Rules & gotchas](#rules--gotchas) protect.

This layers directly onto the two lifecycles in
[`./00-architecture-overview.md`](./00-architecture-overview.md): the request
lifecycle gains a required `workspaceId` at the service and proxy hops, and the
hydration lifecycle keys its scoped slices by `workspaceId` so a switch
rehydrates instead of mutating in place.

## Build it

Worked example: a **workspace-scoped agent list** at
`/w/[workspaceId]/agents`, plus switching workspaces and inviting a member. The
whole thing assumes the tenant identifier is always in the path.

1. **Canonical types.** One place defines the tenancy shape the whole frontend
   agrees on. `organizationId` is present and nullable — a forward-compat field,
   nothing more.

   ```ts
   // src/lib/tenancy.ts
   export type WorkspaceRole = 'admin' | 'member' | 'viewer'

   export interface Workspace {
     id: string
     name: string
     organizationId: string | null // forward-compat; unread today
     createdAt: string
   }

   export interface Membership {
     userId: string
     workspaceId: string
     role: WorkspaceRole
   }

   export interface Agent {
     id: string
     workspaceId: string // non-optional: an agent is always in one workspace
     name: string
   }

   // Central role→capability map. A capability that gates UI here MUST be
   // enforced by the proxy (see step 5) — never add one that isn't.
   const CAPABILITIES: Record<WorkspaceRole, ReadonlySet<string>> = {
     admin: new Set(['agent:read', 'agent:write', 'member:invite', 'member:remove']),
     member: new Set(['agent:read', 'agent:write']),
     viewer: new Set(['agent:read']),
   }

   export function can(role: WorkspaceRole, capability: string): boolean {
     return CAPABILITIES[role].has(capability)
   }
   ```

2. **The route puts `workspaceId` in the path.** The segment is required — the
   view cannot mount without it, so it can never be forgotten.

   ```
   app/w/[workspaceId]/agents/page.tsx      ← agent list
   app/w/[workspaceId]/layout.tsx           ← mounts WorkspaceProvider
   app/page.tsx                             ← bare "/" redirects to a workspace
   ```

3. **`WorkspaceProvider` reads the param and exposes the active tenant.** This
   is a provider in the sense of [`./10-providers.md`](./10-providers.md); it is
   the *only* thing that turns the URL segment into an in-memory active
   workspace, and it refuses to render a workspace the user isn't a member of.

   ```tsx
   // src/components/providers/WorkspaceProvider.tsx
   'use client'

   import { createContext, useContext } from 'react'
   import { notFound } from 'next/navigation'
   import { can, type Membership, type Workspace, type WorkspaceRole } from '@/src/lib/tenancy'

   interface WorkspaceContextValue {
     workspaceId: string
     workspace: Workspace
     role: WorkspaceRole
     can: (capability: string) => boolean
   }

   const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

   export function WorkspaceProvider({
     workspaceId,
     workspace,
     memberships,
     children,
   }: {
     workspaceId: string
     workspace: Workspace
     memberships: Membership[]
     children: React.ReactNode
   }) {
     const membership = memberships.find((m) => m.workspaceId === workspaceId)
     // Not a member of the workspace in the URL → this route does not exist
     // for this user. The proxy will also reject the data calls (step 5); this
     // is the UX half of the same fact.
     if (!membership) notFound()

     const value: WorkspaceContextValue = {
       workspaceId,
       workspace,
       role: membership.role,
       can: (capability) => can(membership.role, capability),
     }
     return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
   }

   export function useWorkspace(): WorkspaceContextValue {
     const ctx = useContext(WorkspaceContext)
     if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider')
     return ctx
   }
   ```

4. **The service method takes `workspaceId` as a required argument.** This is
   the exact `{ signal }`-taking shape of
   [`./03-service-layer.md`](./03-service-layer.md) and the required-tenant rule
   of [`./16-multitenant-performance.md`](./16-multitenant-performance.md) —
   there is no overload without `workspaceId`, and no "all workspaces" mode.

   ```ts
   // src/services/agent-service.ts
   export class AgentService {
     async listAgents(
       workspaceId: string, // required, first positional — impossible to omit
       { signal }: { signal?: AbortSignal } = {},
     ): Promise<Agent[]> {
       const res = await fetch(`/ui-api/w/${workspaceId}/agents`, { signal })
       if (!res.ok) throw new Error(`listAgents failed: ${res.status}`)
       return res.json()
     }
   }
   export const agentService = new AgentService()
   ```

5. **The proxy route is where authorization actually happens.** Following the
   proxy-route contract in [`./02-proxy-routes.md`](./02-proxy-routes.md), it
   reads the session (per [`./11-auth0-recipe.md`](./11-auth0-recipe.md)),
   confirms the user is a member of the path's `workspaceId` with the required
   capability, and only then calls the backend. Everything above this line was
   UX; this line is the security boundary.

   ```ts
   // app/ui-api/w/[workspaceId]/agents/route.ts
   import { NextRequest, NextResponse } from 'next/server'
   import { getSessionSafely } from '@/src/lib/auth0'
   import { assertMembership } from '@/src/lib/authz.server'

   export async function GET(
     req: NextRequest,
     { params }: { params: Promise<{ workspaceId: string }> },
   ) {
     const { workspaceId } = await params
     const session = await getSessionSafely()
     if (!session?.user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

     // Throws 403 if the user is not a member of workspaceId with 'agent:read'.
     // This is the enforcement the first product left to a query param the
     // client supplied — moved server-side, made non-optional.
     await assertMembership(session.user, workspaceId, 'agent:read')

     const agents = await callBackendListAgents(workspaceId) // backend host lives only here
     return NextResponse.json(agents)
   }
   ```

6. **Switching a workspace is navigation, not a store reset.** Because the
   active tenant is the URL, switching just changes the URL; the
   `[workspaceId]` layout subtree remounts and its scoped slices rehydrate.
   There is no global `reset()` and no `reaction`.

   ```tsx
   // src/components/shared/WorkspaceSwitcher.tsx
   'use client'

   import { useRouter } from 'next/navigation'
   import { useWorkspace } from '@/src/components/providers/WorkspaceProvider'
   import type { Membership } from '@/src/lib/tenancy'

   export function WorkspaceSwitcher({ memberships }: { memberships: Membership[] }) {
     const router = useRouter()
     const { workspaceId } = useWorkspace()

     return (
       <select
         value={workspaceId}
         onChange={(e) => {
           // Remember the choice only as the default for the bare "/" entry —
           // NOT as the source of truth for the active tenant.
           document.cookie = `lastWorkspaceId=${e.target.value}; path=/; max-age=31536000`
           router.push(`/w/${e.target.value}/agents`)
         }}
       >
         {memberships.map((m) => (
           <option key={m.workspaceId} value={m.workspaceId}>
             {m.workspaceId}
           </option>
         ))}
       </select>
     )
   }
   ```

7. **The bare `/` picks a default, then hands off to the path.** localStorage /
   cookie is used *only* here — to choose which workspace to land in — never to
   answer "which workspace am I in" once inside a `/w/[workspaceId]` route.

   ```tsx
   // app/page.tsx
   import { redirect } from 'next/navigation'
   import { cookies } from 'next/headers'
   import { getSessionSafely } from '@/src/lib/auth0'
   import { getMembershipsForUser } from '@/src/lib/authz.server'

   export default async function RootPage() {
     const session = await getSessionSafely()
     if (!session?.user) redirect('/')

     const memberships = await getMembershipsForUser(session.user)
     if (memberships.length === 0) redirect('/onboarding') // no workspace yet

     const preferred = (await cookies()).get('lastWorkspaceId')?.value
     const target =
       memberships.find((m) => m.workspaceId === preferred)?.workspaceId ??
       memberships[0].workspaceId
     redirect(`/w/${target}/agents`)
   }
   ```

8. **Invitations and member roles are workspace-scoped.** An invite is
   email + token bound to one `workspaceId`; accepting it creates a `Membership`
   with a role the inviter chose. The invite proxy route reuses the same
   `assertMembership(..., 'member:invite')` seam from step 5, so a `viewer`
   physically cannot issue one — the button being hidden by `can()` is only the
   UX half.

   ```ts
   // app/ui-api/w/[workspaceId]/invites/route.ts (POST) — enforcement excerpt
   await assertMembership(session.user, workspaceId, 'member:invite')
   await callBackendCreateInvite(workspaceId, { email, role }) // role ∈ WorkspaceRole
   ```

## Rules & gotchas

- **`workspaceId` is a required path segment and a required argument — never an
  ambient default.** Every tenant-scoped route lives under `/w/[workspaceId]`
  and every tenant-scoped service method takes `workspaceId` as a non-optional
  parameter. There is no "current workspace" global read inside a service and no
  "all workspaces" mode. This is the direct correction of the first product's
  `localStorage["activeOrganization"]` + optional `organization_id` query param,
  and it's the same required-tenant rule
  [`./16-multitenant-performance.md`](./16-multitenant-performance.md) enforces
  for performance — one rule, two payoffs (no leaks, no over-fetch). This is not
  left to review: the `tenant-scope` CI gate in
  [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md)
  (config: [`../seed/ci/eslint-tenant-scope.config.mjs`](../seed/ci/eslint-tenant-scope.config.mjs))
  fails the build on a function that builds a `/ui-api/w/...` URL without a
  `workspaceId` parameter — the `/w/` path prefix is exactly the AST-visible
  signature that makes the rule mechanically enforceable.
- **The URL is the single source of truth for the active tenant; localStorage /
  cookie only seeds the `/` redirect.** The moment code inside a
  `/w/[workspaceId]` route reads a stored "active workspace" to decide what to
  fetch, the four failure modes from
  [What & why](#what--why) come back. Storage answers *"where should a fresh
  visit land?"* — never *"which tenant is this view?"* The `tenant-scope` gate
  (see [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md))
  fails the build on any `localStorage`/`sessionStorage` read keyed by
  workspace/tenant/organization used to scope a request.
- **Switching a workspace is navigation, not a manual store reset.** Change the
  URL; let the `[workspaceId]` subtree remount and rehydrate. Do not port the
  first product's `reaction(() => activeOrg, () => { reset(); refetch() })` —
  a global reset is the brittle pattern this model removes. Scoped slices are
  keyed by `workspaceId` and hydrate through the core store per
  [`./05-zustand-slice-store.md`](./05-zustand-slice-store.md) and
  [`./07-hydration-adapters.md`](./07-hydration-adapters.md).
- **Frontend role checks are UX; the proxy is the security boundary.** `can()`
  hides buttons and routes; it authorizes nothing. Every tenant-scoped proxy
  route calls `assertMembership(user, workspaceId, capability)` before touching
  the backend. If a capability gates UI but no proxy enforces it, you have
  rebuilt the first product's `Space.permission` field — a permission that
  existed in the model and was never checked. **Every UI-gating capability must
  map to a proxy-enforced permission**; if it can't, don't model it. The
  `tenant-scope` gate (see
  [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md)) fails
  the build on a proxy route under `app/ui-api/w/[workspaceId]/**` whose handler
  never calls `assertMembership` — the mechanical floor under this rule, though
  it can only check that the assertion *exists*, not that the capability is the
  right one (that's a Layer 2 review concern).
- **One user-wide JWT; verify membership per request. Don't reach for Auth0
  Organizations or org-scoped tokens.** The first product used a single token
  for all a user's tenants and verified membership server-side per call, and
  that was the right call — it's simpler than minting per-tenant tokens and it
  composes with the permissive-proxy posture in
  [`./11-auth0-recipe.md`](./11-auth0-recipe.md). Membership is authoritative at
  the proxy (step 5), derived from the backend, not from a token claim the
  client could stale-cache.
- **`organizationId` is a nullable field, not a feature.** It exists so an
  enterprise org umbrella (shared billing/SSO across several workspaces) can be
  added without a migration. Until an organization actually *owns* something
  (billing, SSO config, cross-workspace membership), build no org routes, no org
  switcher, and no org settings — a half-built org layer is worse than none,
  because it invites code to start branching on a boundary that isn't real yet.
- **Two tabs are two tenants — never share a mutable "active workspace"
  singleton.** Because the active tenant is the URL, a user viewing workspace A
  in one tab and workspace B in another Just Works. Introducing a module-level
  `let activeWorkspace` (or a non-URL Zustand field the whole app reads)
  re-breaks this the instant a second tab exists, and the bug is invisible until
  someone opens one.
- **A non-member hitting a workspace URL is a 404 in the UI and a 403 at the
  proxy — and both must exist.** `WorkspaceProvider` calls `notFound()` so a
  guessed/stale link doesn't render a shell around empty data; the proxy
  independently returns 403 so the data never leaves the server regardless of
  what the client rendered. Relying on only one of the two leaks either data
  (no proxy check) or a confusing empty shell (no UI check).

## Source lineage

Net-new for arche-ui — the single-tenant source app (the ClickHouse ETL UI) had
no tenancy model to extract. The pattern here is distilled from GlassFlow's
**first product**, a separate Preact + MobX State Tree repo, whose
organization → space → pipeline model and its localStorage/query-param scoping
are the lineage this doc keeps in part and corrects in part:

- frontend/src/api/api.model.ts (Organisation, Space, Member, Profile models —
  the entity shapes; `Space.permission` is the unenforced-role lesson)
- frontend/src/pages/Organization/page.model.ts (org-level `admin`/`member`
  roles, `isAdmin` UI check, `saveSelectedOrganization`,
  `findStoredOrganizationId` — the localStorage active-tenant mechanism)
- frontend/src/app/index.tsx (the `reaction` that reset stores on org switch —
  the brittle switch this model replaces with navigation)
- frontend/src/pages/Pipelines/page.model.ts,
  frontend/src/pages/Spaces/page.model.ts (inline
  `organization_id: localStorage.getItem("activeOrganization")` at each call
  site — the ambient-scope anti-pattern)
- frontend/src/modals/InviteToOrganization/modal.model.ts,
  frontend/src/pages/Organization/page.model.ts `acceptInvite` (email+token
  invitation flow, kept and re-scoped to the workspace)
- frontend/src/app/app.model.ts (single user-wide Auth0 JWT set on the shared
  client — kept)
