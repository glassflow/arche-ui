# Observability Platform Pattern Pack — Design

- **Date:** 2026-07-01
- **Status:** Approved (design); implementation plan to follow
- **Author:** Vladimir Cutkovic (with Claude Code)
- **Source project:** `glassflow-etl-ui` (this repo — being archived / open-sourced)
- **Deliverable repo:** `arche-ui` — a clean base/template repo for architectural patterns
- **First consumer:** a new AI-observability platform frontend (multi-tenant hosted managed service)

---

## 1. Context & motivation

The company is pivoting away from the GlassFlow ClickHouse ETL product toward AI infrastructure and
AI-agent observability. This repo will be open-sourced but no longer actively developed. Its frontend,
however, contains a set of unusually mature, battle-tested patterns worth carrying into the new project.

The goal is **`arche-ui`** — a clean base/template repo holding a self-contained bundle of reference docs,
invokable skills, and seedable starter code, extracted from this project and rewritten to be portable.
Each new frontend project clones/copies `arche-ui` and adjusts, so it starts from proven ground instead
of a blank page. The AI-observability platform is the first consumer, so illustrative code examples are
observability-flavored (traces / spans / metrics); the patterns themselves are domain-agnostic and the
examples are meant to be adapted per project.

Two categories of content, deliberately kept distinct:

1. **Extracted / proven** (docs 00–14) — distilled from patterns that shipped and hardened here.
   The work is *distillation*: de-domain them, make them prescriptive, and illustrate with
   observability-domain examples.
2. **Net-new / prescriptive** (docs 15–16 + the `review-changes` skill) — guardrails that never existed
   here because they were never needed. The old app served a single company; the new one is a
   multi-tenant hosted service where **performance and architectural drift are existential concerns**.
   These are designed fresh, not extracted.

## 2. Goals & non-goals

**Goals**
- A standalone, git-tracked pattern pack seedable into the new project.
- Every crown-jewel pattern captured as a portable, prescriptive doc (not a description of this app).
- A small set of invokable skills for the highest-frequency build actions.
- Seedable starter code for the two artifacts worth copying near-verbatim (gallery scaffold, mock toggle).
- Day-one architectural + performance guardrails specified concretely enough to wire into CI.

**Non-goals**
- Refactoring or changing this (archived) repo, beyond adding this spec.
- Copying domain data/fixtures (Kafka/ClickHouse specifics) — those are regenerated, not ported.
- Building the new project. This pack seeds it; it does not scaffold it.
- Authoring skills whose shape depends on decisions the new project hasn't made yet (deferred — see §8).

## 3. Deliverable

**Location:** the clean `arche-ui` base repo (already initialized, on `main`, no commits yet):

```
/Users/vladimir.cutkovic/Documents/code/glassflow/arche-ui/
```

**Structure:**

```
arche-ui/
  README.md                          # index + "how to seed a new project" guide
  docs/
    00-architecture-overview.md
    01-runtime-env-injection.md
    02-proxy-routes.md
    03-service-layer.md
    04-sse-streaming.md
    05-zustand-slice-store.md
    06-forms-zod-manager-renderer.md
    07-hydration-adapters.md
    08-design-tokens.md
    09-component-architecture.md
    10-providers.md
    11-auth0-recipe.md
    12-deployment.md
    13-component-gallery.md
    14-mock-api-layer.md
    15-architectural-guardrails.md    # NET-NEW / prescriptive
    16-multitenant-performance.md     # NET-NEW / prescriptive
  skills/
    add-proxy-route/SKILL.md
    add-zustand-slice/SKILL.md
    add-zod-form/SKILL.md
    setup-auth0/SKILL.md
    review-changes/SKILL.md
  seed/
    gallery/                          # Section.tsx, GalleryNav.tsx, empty category structure
    mock/                             # mock-api.ts toggle helper (generic)
    ci/                               # example guardrail configs (see §7)
```

## 4. Doc template

Every doc (00–16) follows a fixed 5-part structure so they read consistently and *teach* rather than
merely describe:

1. **What & why** — one paragraph: the problem the pattern solves.
2. **The shape** — the abstraction, interfaces, and file layout.
3. **Build it** — step-by-step to create a new instance, with **observability-domain code examples**
   (traces / spans / metrics / alert rules), never Kafka/ClickHouse.
4. **Rules & gotchas** — the non-obvious constraints and hard-won lessons (see per-doc notes below).
5. **Source lineage** — footer pointing to the battle-tested file(s) in this repo the pattern was
   distilled from, for ground-truth reference.

## 5. Doc catalog

Each entry: scope + key gotchas to preserve + source lineage anchors (paths in this repo).

### Extracted / proven (00–14)

- **00 — Architecture overview.** The two lifecycles the rest plug into: **request flow**
  (component → client API → service → proxy route → backend) and **hydration flow**
  (backend config → version adapter → `hydrateFromConfig` → store slice → form defaults).
  Lineage: `docs/architecture/ARCHITECTURE_OVERVIEW.md`, `.cursor/architecture/*`.

- **01 — Runtime env injection.** The crux of runtime config for a containerized app.
  Gotcha: in **production it is `startup.sh` (container entrypoint)** that regenerates
  `public/env.js` at container start — *not* `generate-env.mjs` (dev-only). Bake **no**
  `NEXT_PUBLIC_*` that must vary per deploy — a baked value is frozen and ignores the k8s ConfigMap.
  Server code reads non-prefixed vars (`API_URL`) at request time.
  Lineage: `startup.sh`, `generate-env.mjs`, `public/env.js`, `src/utils/common.client.ts`,
  `src/app/ui-api/config.ts`, `.cursor/architecture/ENVIRONMENT.md`.

- **02 — Proxy routes.** `ui-api/*` routes shield the backend/secrets; browser never talks to the
  backend directly. Mock detection, request validation, error normalization live here.
  Lineage: `src/app/ui-api/*/route.ts`, `src/app/ui-api/config.ts`, `src/proxy.ts`.

- **03 — Service layer.** Typed services with timeouts + `AbortController` cleanup; pluggable via
  factory. Ports directly to trace/metric/log services.
  Lineage: `src/services/kafka-service.ts`, `clickhouse-service.ts`, `src/lib/kafka-client-*.ts`.

- **04 — SSE / streaming.** Singleton `EventSource` manager, subscription multiplexing, exponential
  backoff, heartbeat, polling fallback behind one interface.
  Gotcha: **do not bind the upstream fetch/teardown to `req.signal`** — it aborts prematurely on the
  k8s cluster (broke prod logs once). Central for an observability UI where streaming is the product.
  Lineage: `src/services/pipeline-sse-manager.ts`, `pipeline-state-manager.ts`, `src/types/sse.ts`,
  `docs/implementations/SSE_PIPELINE_STATUS_STREAMING.md`.

- **05 — Zustand slice store.** Slice-per-feature composed into one `Store`; devtools +
  `subscribeWithSelector`; global reset orchestration.
  Lineage: `src/store/index.ts`, `core.ts`, `*.store.ts`, `.cursor/architecture/STATE_MANAGEMENT.md`.

- **06 — Forms: Zod + Manager/Renderer.** Zod schema is the single source of truth; config object
  supplies UI metadata; Manager owns `useForm`/submit; Renderer is pure over `control`.
  Multi-step wizard variant included.
  Lineage: `src/scheme/*.ts`, `src/config/*-form-config.ts`, `src/modules/*/*FormManager.tsx` +
  `*FormRenderer.tsx`, `.cursor/architecture/FORM_ARCHITECTURE.md`.

- **07 — Hydration & adapters.** Version adapters normalize backend payloads to an internal shape;
  section-based hydration into store slices; rehydration on discard.
  Lineage: `src/store/hydration/*.ts`, `src/store/core.ts` (`hydrateFromConfig`/`hydrateSection`),
  `src/types/pipeline.ts`, `src/modules/pipeline-adapters/`.

- **08 — Design tokens.** Two layers: shadcn canonical + semantic; CSS variables; Figma sync.
  No hardcoded colors — the enforceable contract (see doc 15).
  Lineage: `src/themes/base.css`, `theme.css`, `src/app/styles/*`, `docs/architecture/DESIGN_SYSTEM.md`,
  `docs/design/FIGMA_TOKEN_REFERENCE.md`.

- **09 — Component architecture.** `ui/ → common/ → shared/` dependency direction; `modules/*` for
  feature code; `shared/` must not import `modules/`. Variant props over class names.
  Lineage: `.cursor/architecture/COMPONENT_ARCHITECTURE.md`, `src/components/*`.

- **10 — Providers.** Layered context composition (theme → observability → analytics/consent → health
  → platform → notifications → auth); consent flow synced to store.
  Lineage: `src/components/providers/*.tsx`, `src/app/layout.tsx`.

- **11 — Auth0 recipe.** `@auth0/nextjs-auth0` v4. `AUTH0_ENABLED` (server) is the single source of
  truth; `startup.sh` syncs `NEXT_PUBLIC_AUTH0_ENABLED` into `env.js`. Secrets stay non-`NEXT_PUBLIC_`.
  Gotchas: `getSessionSafely()` swallows `ERR_JWE_DECRYPTION_FAILED` after secret rotation; proxy is
  permissive (enforcement is in page components); a known hook-after-conditional FIXME in `UserSection`.
  Lineage: `src/lib/auth0.ts`, `src/utils/auth-config.server.ts`, `src/app/api/auth/[auth0]/route.ts`,
  `src/components/providers/AuthProvider.tsx`, `.cursor/architecture/AUTH0_ENV.md`.

- **12 — Deployment (Docker + CI/CD + k8s).** Multi-stage Dockerfile (deps/builder/runner), standalone
  Next output, non-root + OpenShift-friendly perms, `startup.sh` entrypoint regenerates env at boot.
  GHA: `test` → `build_image` (multi-arch to ghcr.io) driven by PR/main/tag workflows. Helm chart
  injects config via ConfigMap; init container runs migrations. End-to-end env trace:
  Helm value → ConfigMap → pod env → `startup.sh` → `env.js`/server config → browser/server.
  Gotcha: the `NEXT_PUBLIC_*` inlining trap is the whole reason the runtime split works.
  Lineage: `Dockerfile`, `startup.sh`, `migrate.js`, `.github/workflows/*`,
  `charts-ee/charts/glassflow-etl/` (templates + values).

- **13 — Component gallery.** In-app living showcase at `/dev/components`; live token-contract test;
  renders in real app context (superior to Storybook for that); **agent-consultable example corpus**;
  keep the `anti-patterns` page. Scope discipline: showcase the *branded layer + tokens + composite
  patterns only*, never re-document vanilla shadcn.
  Lineage: `src/app/(main)/dev/components/*`, `docs/architecture/COMPONENT_GALLERY.md`.

- **14 — Mock API layer.** Toggle (`isMockMode()` + `getApiUrl()`, runtime, client+server) → interception →
  schema-typed fixtures → in-memory stateful managers. **Drift-protection via shared types is the crown
  jewel — preserve it (ideally derive fixtures from Zod schemas).**
  Rework recommendations for the new project: (a) collapse the parallel `/ui-api/mock/*` route tree —
  prefer **MSW** (handlers double as test mocks) or internal per-route branching; (b) **make streaming a
  first-class mock** — a synthetic trace/span/metric event generator, which doubles as demo mode and a
  UX/load testing tool (this closes the current SSE-mock gap, which is disqualifying for an observability
  UI). Port the mechanism; regenerate the data.
  Lineage: `src/utils/mock-api.ts`, `src/app/ui-api/mock/*`, `src/app/ui-api/mock/data/*`.

### Net-new / prescriptive (15–16)

- **15 — Architectural guardrails.** Three enforcement layers, **hard-gating from commit #1** (chosen):
  1. **Hard gates (CI-failing):** boundary rules (`eslint-plugin-boundaries` / `dependency-cruiser`)
     encoding the doc-09 direction; token-contract lint (fail on hardcoded hex / `rgba()` / raw Tailwind
     color utilities); bundle budgets (`size-limit` / `@next/bundle-analyzer`, hard per-route ceiling);
     Web Vitals via Lighthouse CI with regression thresholds; `tsc --noEmit` + `no-explicit-any` as error.
  2. **Agentic review (on-demand + PR):** the `review-changes` skill (see §6) for judgment-level issues
     lint can't see — unvirtualized large tables, fetch waterfalls, unmemoized expensive renders,
     cross-tenant over-fetch, missing `AbortController`.
  3. **Recurring drift audit:** a scheduled agent/workflow producing a ranked, actionable triage list
     (dead code, oversized files, boundary erosion, bundle-creep trend) — not a passive nag.
  Includes example CI configs in `seed/ci/`.

- **16 — Multi-tenant performance.** The concerns absent in the old single-tenant app: data virtualization
  for large trace/log tables, streaming + pagination over full fetches, request cancellation (the
  `AbortController` service pattern transfers directly), memoization discipline, avoiding cross-tenant
  over-fetch, per-tenant cost awareness, Web Vitals budgets, and **dogfooding your own observability
  product** to watch the app's own performance. Reframes docs 03/04 through a load lens.

## 6. Skills

Invokable playbooks (numbered steps, files to touch, wiring order) — not doc restatements.

- **`add-proxy-route`** — scaffold a `ui-api` route + wire the service call + error normalization.
- **`add-zustand-slice`** — new slice + compose in `index.ts` + reset registration + hydration hook.
- **`add-zod-form`** — Zod schema + config object + Manager + Renderer, in the correct order.
- **`setup-auth0`** — enable/disable toggle, server-only secret wiring, `env.js` sync, session gotchas;
  written for agentic setup + debugging (explicitly requested).
- **`review-changes`** — diff a branch against the architecture docs + a performance-heuristics
  checklist; report ranked findings. This *is* the "triage reminder," made concrete and invokable.

## 7. Seeded starter code

Copyable near-verbatim into the new project:

- **`seed/gallery/`** — `_components/Section.tsx` (Section / VariantGrid / Preview / CodeBlock),
  `GalleryNav.tsx`, and an empty category structure, so the workbench exists from day one.
- **`seed/mock/`** — the generic `mock-api.ts` toggle helper (~20 lines; domain-agnostic).
- **`seed/ci/`** — example guardrail configs referenced by doc 15 (boundaries config, token-contract
  lint rule, `size-limit` budget stub, Lighthouse CI config).

## 8. Cross-cutting principles

- **De-domained + observability-flavored.** Patterns generic; examples in the new domain.
- **Drift-protection first.** Wherever a contract exists (types, tokens, boundaries), prefer a mechanism
  the type system or CI keeps honest over prose that relies on discipline.
- **Agent-consultability.** Docs, gallery, and mocks are all context surfaces an agent reads before
  building. Write them to be useful to an agent, not only a human.

## 9. Deferred (fast-follow, not in this pack)

- **`add-mock-endpoint` skill** — shape depends on the interception approach the new project picks
  (MSW vs internal branching); author once that's decided.
- Any skill for gallery sections (low-frequency, mechanical; the doc + seed scaffold cover it).

## 10. Build sequence (high level; detailed plan via writing-plans)

1. Scaffold `arche-ui`: directory structure + `README.md` skeleton + copy this spec into
   `arche-ui/docs/superpowers/specs/` so the design travels with the base repo; first commit.
2. Write docs 00–14 (extracted), pulling ground truth from the lineage anchors.
3. Write docs 15–16 (prescriptive guardrails + performance).
4. Author the 5 skills.
5. Assemble `seed/` (gallery, mock, ci configs).
6. Write the `README.md` "how to seed a new project" guide tying it together.
