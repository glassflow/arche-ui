# arche-ui Base Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the clean `arche-ui` base repo with portable, prescriptive architecture docs, invokable skills, and seedable starter code distilled from the `glassflow-etl-ui` project, so future frontend projects clone it and adjust.

**Architecture:** A documentation-and-seed repo. Content is authored as Markdown (17 docs, 5 SKILL.md files) plus a small amount of framework-agnostic starter code (mock toggle, gallery scaffold, CI guardrail configs). A dependency-free Node validator (`scripts/validate-docs.mjs`) gates every doc: it enforces the 5-section template, resolves internal links, and rejects placeholder tokens. This validator is each doc task's test.

**Tech Stack:** Markdown; Node 22 (ESM, no dependencies) for the validator; the seed code targets Next.js 16 / React / TypeScript / Zustand / Zod / shadcn but lives as copy-in source (not built inside `arche-ui`).

## Global Constraints

- **Deliverable repo:** `/Users/vladimir.cutkovic/Documents/code/glassflow/arche-ui` (git, on `main`, no commits yet).
- **Source-of-truth repo (read-only for lineage):** `/Users/vladimir.cutkovic/Documents/code/glassflow/glassflow-ee/glassflow-etl-ui`.
- **Doc template — every file `docs/NN-*.md` (00–16) MUST have these five `##` sections, in order, exact titles:** `## What & why`, `## The shape`, `## Build it`, `## Rules & gotchas`, `## Source lineage`.
- **Examples are observability-flavored** (traces / spans / metrics / alert rules) — never Kafka/ClickHouse. Patterns stay domain-agnostic; examples are illustrative and adaptable.
- **No placeholder tokens** anywhere in `docs/**` or `skills/**`: the strings `TODO`, `TBD`, `FIXME`, `coming soon`, `fill in`, `lorem ipsum` are forbidden (the validator fails on them). (The archived repo's real "FIXME" gotcha is referenced in prose as "a hook-after-conditional bug" — do not use the literal token.)
- **Two content tiers, marked explicitly:** docs 00–14 = *Extracted / proven*; docs 15–16 + the `review-changes` skill = *Net-new / prescriptive*. Each of docs 15–16 opens with a one-line callout: `> **Net-new / prescriptive** — designed for the new project, not extracted from a shipped codebase.`
- **Guardrail posture:** hard gates from commit #1 (boundaries, token contract, bundle budget, Web Vitals, tsc/no-any all CI-failing).
- **Commit after every task.** Commit messages end with the Co-Authored-By trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Never edit files in `glassflow-etl-ui`** during execution except reading for lineage. All writes land in `arche-ui`.

---

## Conventions for doc tasks (read once; every doc task follows this)

Every doc task (Tasks 2–18) uses this identical mechanical cycle. Each task body supplies only the *content brief* (what goes in each of the 5 sections), the *lineage files to read*, the *gotchas to preserve*, and the *example scenario*. The steps are always:

1. **Read the lineage files** listed in the task from `glassflow-etl-ui` to get ground truth. Do not summarize from memory.
2. **Write the doc** at the given path, filling all five template sections from the content brief. Use an observability example. End with a `## Source lineage` section listing the lineage file paths (as plain text, prefixed `glassflow-etl-ui/…`, since those files won't exist in `arche-ui`).
3. **Run the validator:** `node scripts/validate-docs.mjs docs/<file>.md` — Expected: `PASS`. (Per-doc runs check template sections + placeholder tokens only; internal cross-links are validated in the full-set pass in Task 27, since sibling docs may not exist yet.)
4. **Commit** the single doc file.

If the validator reports a missing section, add it; if it reports a broken internal link, fix the target or the link; if it reports a placeholder token, rewrite the sentence.

---

## Task 1: Scaffold arche-ui + doc validator

**Files:**
- Create: `arche-ui/README.md` (skeleton — expanded in Task 27)
- Create: `arche-ui/scripts/validate-docs.mjs`
- Create: `arche-ui/.gitignore`
- Create dirs (via placeholder `.gitkeep`): `arche-ui/docs/`, `arche-ui/skills/`, `arche-ui/seed/gallery/`, `arche-ui/seed/mock/`, `arche-ui/seed/ci/`
- Copy: this repo's `docs/superpowers/specs/2026-07-01-observability-pattern-pack-design.md` → `arche-ui/docs/superpowers/specs/2026-07-01-observability-pattern-pack-design.md`
- Copy: this plan → `arche-ui/docs/superpowers/plans/2026-07-01-arche-ui-base-repo.md`

**Interfaces:**
- Produces: `node scripts/validate-docs.mjs [file...]` — validates one or more doc files (or all of `docs/[0-1][0-9]-*.md` when no args). Exit 0 on pass, 1 on any failure. Prints `PASS`/`FAIL: <reason>` per file.

- [ ] **Step 1: Create directory skeleton and .gitignore**

```bash
cd /Users/vladimir.cutkovic/Documents/code/glassflow/arche-ui
mkdir -p docs/superpowers/specs docs/superpowers/plans scripts skills seed/gallery seed/mock seed/ci
printf 'node_modules/\n.DS_Store\n*.log\n.superpowers/\n' > .gitignore
touch skills/.gitkeep seed/gallery/.gitkeep seed/mock/.gitkeep seed/ci/.gitkeep
```

- [ ] **Step 2: Write the validator** at `scripts/validate-docs.mjs`

```js
#!/usr/bin/env node
// Dependency-free doc validator for arche-ui. Node 22 ESM.
// Checks: 5-section template, internal-link resolution, forbidden placeholder tokens.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

const REQUIRED = ['What & why', 'The shape', 'Build it', 'Rules & gotchas', 'Source lineage']
const FORBIDDEN = ['TODO', 'TBD', 'FIXME', 'coming soon', 'fill in', 'lorem ipsum']

function targets() {
  const args = process.argv.slice(2)
  if (args.length) return args
  return readdirSync('docs')
    .filter((f) => /^[0-1][0-9]-.*\.md$/.test(f))
    .map((f) => join('docs', f))
}

// Link resolution is only meaningful once ALL docs exist, so it runs in the
// full-set pass (no file args, used in the final task). Per-doc runs (explicit
// file args, used mid-build) skip it — sibling docs may not exist yet.
const CHECK_LINKS = process.argv.slice(2).length === 0

function checkFile(path) {
  const errors = []
  const text = readFileSync(path, 'utf8')
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1])
  for (const sec of REQUIRED) {
    if (!headings.includes(sec)) errors.push(`missing section "## ${sec}"`)
  }
  for (const tok of FORBIDDEN) {
    if (text.toLowerCase().includes(tok.toLowerCase())) errors.push(`forbidden token "${tok}"`)
  }
  if (CHECK_LINKS) {
    // Internal relative links only: [txt](./x.md) or [txt](../x.md) or [txt](x.md#anchor)
    for (const m of text.matchAll(/\[[^\]]+\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
      const rel = m[1].split('#')[0]
      if (!rel) continue
      if (!existsSync(resolve(dirname(path), rel))) errors.push(`broken link -> ${rel}`)
    }
  }
  return errors
}

let failed = false
for (const path of targets()) {
  if (!existsSync(path)) { console.log(`FAIL: ${path} (not found)`); failed = true; continue }
  const errors = checkFile(path)
  if (errors.length) { failed = true; console.log(`FAIL: ${path}\n  - ${errors.join('\n  - ')}`) }
  else console.log(`PASS: ${path}`)
}
process.exit(failed ? 1 : 0)
```

- [ ] **Step 3: Write the README skeleton** at `README.md`

```markdown
# arche-ui

Base repository of proven frontend architecture patterns. Clone or copy into a new
project and adjust. Distilled from the GlassFlow ClickHouse ETL UI; first consumer is
the AI-observability platform frontend.

- **`docs/`** — reference docs, one pattern each. See the index below (added in the final task).
- **`skills/`** — invokable Claude Code skills for high-frequency build actions.
- **`seed/`** — copy-in starter code (mock toggle, gallery scaffold, CI guardrail configs).
- **`scripts/validate-docs.mjs`** — `node scripts/validate-docs.mjs` validates all docs.

Full index and "how to seed a new project" guide: see the end of this file (populated last).
```

- [ ] **Step 4: Copy the spec and plan into arche-ui**

```bash
SRC=/Users/vladimir.cutkovic/Documents/code/glassflow/glassflow-ee/glassflow-etl-ui
cp "$SRC/docs/superpowers/specs/2026-07-01-observability-pattern-pack-design.md" docs/superpowers/specs/
cp "$SRC/docs/superpowers/plans/2026-07-01-arche-ui-base-repo.md" docs/superpowers/plans/
```

- [ ] **Step 5: Verify the validator runs** (no docs yet, so it should pass on empty set)

Run: `node scripts/validate-docs.mjs`
Expected: no `FAIL` lines, exit 0 (empty match set → prints nothing, exits 0).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Scaffold arche-ui: structure, doc validator, spec + plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Extracted / proven docs (Tasks 2–16)

All Phase B tasks follow the **Conventions for doc tasks** above. Each ends with `node scripts/validate-docs.mjs docs/<file>.md` → PASS, then a commit of that one file.

### Task 2: doc `00-architecture-overview.md`

**Files:** Create `arche-ui/docs/00-architecture-overview.md`

**Content brief:**
- *What & why:* The map that ties the pack together — the two lifecycles every other doc plugs into.
- *The shape:* Describe the **request lifecycle** (component → client API → service → proxy route → backend) and the **hydration lifecycle** (backend config → version adapter → `hydrateFromConfig` → store slice → form defaults). Include a simple ASCII diagram of each.
- *Build it:* Show how a single feature (e.g. "span detail panel") threads through both lifecycles end to end, linking to the relevant docs (`./02-proxy-routes.md`, `./03-service-layer.md`, `./05-zustand-slice-store.md`, `./07-hydration-adapters.md`).
- *Rules & gotchas:* Layers are one-directional; the browser never calls the backend directly; hydration always goes through the core store, never raw slice writes.
- *Source lineage:* `glassflow-etl-ui/docs/architecture/ARCHITECTURE_OVERVIEW.md`, `glassflow-etl-ui/.cursor/architecture/*`.

**Example scenario:** loading a trace's span list into a detail view.

### Task 3: doc `01-runtime-env-injection.md`

**Files:** Create `arche-ui/docs/01-runtime-env-injection.md`

**Lineage to read:** `glassflow-etl-ui/startup.sh`, `generate-env.mjs`, `src/app/layout.tsx` (env.js `<Script beforeInteractive>`), `src/utils/common.client.ts`, `src/app/ui-api/config.ts`, `.cursor/architecture/ENVIRONMENT.md`.

**Content brief:**
- *What & why:* Make env vars mutable after the image is built, so one image runs in every environment.
- *The shape:* `window.__ENV__` injected by a `<Script beforeInteractive>` from `public/env.js`; a `getRuntimeEnv()` client helper reading `window.__ENV__` first then `process.env`; server code reads non-prefixed vars at request time.
- *Build it:* Add a new runtime var end to end: define default → emit into `env.js` → read via `getRuntimeEnv()` (client) or `process.env` (server). Show the `getRuntimeEnv()` helper code.
- *Rules & gotchas:* **Production regenerates `env.js` via the container entrypoint (`startup.sh`), not `generate-env.mjs` (dev-only).** Never bake a per-deploy `NEXT_PUBLIC_*` as a build ARG — it is frozen at `next build` and will ignore the k8s ConfigMap (the inlining trap). Server truth uses non-prefixed names (e.g. `API_URL`).
- *Source lineage:* the files above.

**Example scenario:** `NEXT_PUBLIC_TELEMETRY_INGEST_URL`.

### Task 4: doc `02-proxy-routes.md`

**Files:** Create `arche-ui/docs/02-proxy-routes.md`

**Lineage to read:** `glassflow-etl-ui/src/app/ui-api/*/route.ts` (pick 1–2), `src/app/ui-api/config.ts`, `src/proxy.ts`.

**Content brief:**
- *What & why:* Shield the backend and secrets; the browser only ever talks to same-origin `ui-api` routes.
- *The shape:* Thin route handlers under `app/ui-api/*` that validate input, call a service, normalize errors to a stable JSON shape. Runtime API base from server config.
- *Build it:* Create a `ui-api/traces/route.ts` that validates a query with Zod, calls `TraceService`, and returns normalized JSON. Show the handler skeleton and the error-normalization helper.
- *Rules & gotchas:* Routes stay thin (no business logic); never expose backend URLs/secrets to the client; validate every request body; keep a consistent error envelope.
- *Source lineage:* the files above.

**Example scenario:** `GET /ui-api/traces?service=checkout`.

### Task 5: doc `03-service-layer.md`

**Files:** Create `arche-ui/docs/03-service-layer.md`

**Lineage to read:** `glassflow-etl-ui/src/services/kafka-service.ts`, `clickhouse-service.ts`, `src/lib/kafka-client-interface.ts`, `kafka-client-factory.ts`.

**Content brief:**
- *What & why:* One typed place for backend interactions, with timeouts and cancellation.
- *The shape:* Class/singleton services; every call takes `{ signal }`; `AbortController` cleanup; pluggable backend via a factory + interface.
- *Build it:* Implement a `TraceService` with `listSpans(traceId, { signal })` and a timeout wrapper. Show the timeout+abort helper and the factory pattern.
- *Rules & gotchas:* Always thread `AbortController`; services are UI-agnostic (no React); log structured errors; keep transport swappable behind the interface.
- *Source lineage:* the files above.

**Example scenario:** `TraceService.listSpans`.

### Task 6: doc `04-sse-streaming.md`

**Files:** Create `arche-ui/docs/04-sse-streaming.md`

**Lineage to read:** `glassflow-etl-ui/src/services/pipeline-sse-manager.ts`, `pipeline-state-manager.ts`, `src/types/sse.ts`, `docs/implementations/SSE_PIPELINE_STATUS_STREAMING.md`.

**Content brief:**
- *What & why:* One resilient live stream per tab, with a transparent polling fallback.
- *The shape:* Singleton `EventSource` manager; subscription multiplexing; exponential backoff; heartbeat; a polling manager with the *same* callback interface so consumers don't know which is active.
- *Build it:* Build a `LiveMetricsManager` singleton that multiplexes subscriptions and falls back to polling. Show the subscribe/unsubscribe API and reconnect logic.
- *Rules & gotchas:* **Do not bind the upstream fetch/teardown to `req.signal`** — it aborts prematurely on the k8s cluster and silently kills the stream (this broke prod logs once). Prefer one connection per tab; clean up on `visibilitychange`.
- *Source lineage:* the files above.

**Example scenario:** live tail of a service's error-rate metric.

### Task 7: doc `05-zustand-slice-store.md`

**Files:** Create `arche-ui/docs/05-zustand-slice-store.md`

**Lineage to read:** `glassflow-etl-ui/src/store/index.ts`, `core.ts`, one `*.store.ts`, `.cursor/architecture/STATE_MANAGEMENT.md`.

**Content brief:**
- *What & why:* Modular, strongly-typed global state that scales by feature.
- *The shape:* `createXxxSlice: StateCreator<XxxSlice>` per feature; composed into one `Store` in `index.ts`; devtools + `subscribeWithSelector`; global reset orchestration.
- *Build it:* Add a `filtersSlice` (selected service, time range) and compose it. Show the slice factory, the `Store` interface extension, and registration in the reset orchestrator.
- *Rules & gotchas:* Access via `useStore()`; register every slice in the global reset; keep slices free of cross-slice writes (orchestrate in core).
- *Source lineage:* the files above.

**Example scenario:** a `filtersSlice` holding the active service + time window.

### Task 8: doc `06-forms-zod-manager-renderer.md`

**Files:** Create `arche-ui/docs/06-forms-zod-manager-renderer.md`

**Lineage to read:** `glassflow-etl-ui/src/scheme/*.scheme.ts` (one), `src/config/*-form-config.ts` (one), a `*FormManager.tsx` + `*FormRenderer.tsx` pair, `.cursor/architecture/FORM_ARCHITECTURE.md`.

**Content brief:**
- *What & why:* Schema-first forms with a clean split between logic and presentation.
- *The shape:* Zod schema = single source of truth; a config object supplies field metadata; Manager owns `useForm(zodResolver)` + submit; Renderer is pure over `control` using shadcn `<FormField>`.
- *Build it:* Build an "alert rule" form: schema → config → Manager → Renderer. Show all four artifacts (compact). Include the multi-step variant note.
- *Rules & gotchas:* Never manage error display manually when `<FormMessage>` covers it; Renderer stays pure; defaults come from the store (see `./07-hydration-adapters.md`).
- *Source lineage:* the files above.

**Example scenario:** create/edit an alert rule (threshold + window + severity).

### Task 9: doc `07-hydration-adapters.md`

**Files:** Create `arche-ui/docs/07-hydration-adapters.md`

**Lineage to read:** `glassflow-etl-ui/src/store/hydration/*.ts` (one or two), `src/store/core.ts` (`hydrateFromConfig`/`hydrateSection`), `src/types/pipeline.ts`, `src/modules/pipeline-adapters/`.

**Content brief:**
- *What & why:* Load backend config into the store/forms without coupling to backend version drift.
- *The shape:* Version adapters normalize payloads to an internal shape; section-specific hydration functions map into slices; `hydrateFromConfig` orchestrates; `hydrateSection` supports partial re-hydration (e.g. on form discard).
- *Build it:* Hydrate a "dashboard config" with a v1/v2 adapter and two section hydrators. Show the adapter signature and one hydrator.
- *Rules & gotchas:* Always hydrate through core (never raw slice writes); mark a section invalidated on hydration error; adapters own all version branching.
- *Source lineage:* the files above.

**Example scenario:** dashboard config with a v1→v2 layout migration.

### Task 10: doc `08-design-tokens.md`

**Files:** Create `arche-ui/docs/08-design-tokens.md`

**Lineage to read:** `glassflow-etl-ui/src/themes/base.css`, `theme.css`, `src/app/styles/typography.css`, `docs/architecture/DESIGN_SYSTEM.md`, `docs/design/FIGMA_TOKEN_REFERENCE.md`.

**Content brief:**
- *What & why:* A stable, Figma-synced token contract so color/spacing never gets hardcoded.
- *The shape:* Two layers — shadcn canonical (~25 tokens) + semantic (surface elevation, status, metrics); raw HSL primitives in `base.css`, semantic refs in `theme.css`; typography utility classes; Figma sync.
- *Build it:* Add a new semantic token (e.g. `--trace-span-error`): primitive in `base.css` → semantic in `theme.css` → use as `hsl(var(--trace-span-error))`. Show the three edits.
- *Rules & gotchas:* No hardcoded hex/`rgba()`/raw Tailwind color utilities (enforced by CI — see `./15-architectural-guardrails.md`); Tailwind only for layout/spacing/typography; dark-only.
- *Source lineage:* the files above.

**Example scenario:** a semantic color token for errored spans.

### Task 11: doc `09-component-architecture.md`

**Files:** Create `arche-ui/docs/09-component-architecture.md`

**Lineage to read:** `glassflow-etl-ui/.cursor/architecture/COMPONENT_ARCHITECTURE.md`, `src/components/` layout.

**Content brief:**
- *What & why:* A dependency-directed component hierarchy that stays untangled as the app grows.
- *The shape:* `ui/` (primitives) → `common/` (domain-neutral) → `shared/` (app shell) → `modules/*` (feature code). Composition patterns: Container/Presenter, Manager/Renderer, config-driven rendering.
- *Build it:* Decide where a new "SpanWaterfall" component lives and why; show the import-direction rule in practice.
- *Rules & gotchas:* `shared/` must NOT import `modules/`; dependency direction is one-way; visual state lives in variant props, `className` for layout only. **This is enforced by CI (`./15-architectural-guardrails.md`).**
- *Source lineage:* the files above.

**Example scenario:** placing `SpanWaterfall` in `modules/traces/`.

### Task 12: doc `10-providers.md`

**Files:** Create `arche-ui/docs/10-providers.md`

**Lineage to read:** `glassflow-etl-ui/src/components/providers/*.tsx`, `src/app/layout.tsx`.

**Content brief:**
- *What & why:* Ordered, composable React context for cross-cutting concerns.
- *The shape:* Layered nesting (theme → observability → analytics/consent → health → platform → notifications → auth); each a `'use client'` wrapper; consent flow synced to the store.
- *Build it:* Add a `TenantProvider` and place it correctly in the nesting order. Show the provider and the layout insertion.
- *Rules & gotchas:* Order matters (theme outermost, auth innermost); a provider needing store access must sit inside the store's availability; keep providers thin.
- *Source lineage:* the files above.

**Example scenario:** a `TenantProvider` exposing the active tenant.

### Task 13: doc `11-auth0-recipe.md`

**Files:** Create `arche-ui/docs/11-auth0-recipe.md`

**Lineage to read:** `glassflow-etl-ui/src/lib/auth0.ts`, `src/utils/auth-config.server.ts`, `src/app/api/auth/[auth0]/route.ts`, `src/components/providers/AuthProvider.tsx`, `.cursor/architecture/AUTH0_ENV.md`.

**Content brief:**
- *What & why:* Drop-in Auth0 with a clean enable/disable toggle and server-only secrets.
- *The shape:* `@auth0/nextjs-auth0` v4; `Auth0Client` + auth route; `AuthProvider` wraps only when enabled; `isAuthEnabled()` reads server truth.
- *Build it:* Wire Auth0 from scratch: env vars → `Auth0Client` → auth route → conditional provider → protect a page. Show the env table (name / build-vs-runtime / secret?) and the conditional provider.
- *Rules & gotchas:* `AUTH0_ENABLED` (server) is the single source of truth; `startup.sh` syncs `NEXT_PUBLIC_AUTH0_ENABLED` into `env.js`; secrets stay non-`NEXT_PUBLIC_`; `getSessionSafely()` swallows `ERR_JWE_DECRYPTION_FAILED` after secret rotation; the proxy is permissive — enforce in page components; avoid the hook-after-conditional bug (call hooks before any early return).
- *Source lineage:* the files above.

**Example scenario:** protecting `/dashboard` behind login.

### Task 14: doc `12-deployment.md`

**Files:** Create `arche-ui/docs/12-deployment.md`

**Lineage to read:** `glassflow-etl-ui/Dockerfile`, `startup.sh`, `migrate.js`, `.github/workflows/*.yaml`, `charts-ee/charts/glassflow-etl/` (templates + `values.yaml`).

**Content brief:**
- *What & why:* Ship one image that runs anywhere via runtime config; automate build/test/publish.
- *The shape:* Multi-stage Dockerfile (deps/builder/runner), Next standalone output, non-root + OpenShift-friendly perms, `startup.sh` entrypoint regenerating env at boot; GHA `test` → `build_image` (multi-arch → ghcr.io) driven by PR/main/tag; Helm ConfigMap injection + migration init container.
- *Build it:* Trace one var (`API_URL`) Helm value → ConfigMap → pod env → `startup.sh` → server/browser. Show the entrypoint's env-gen step and the GHA workflow call graph.
- *Rules & gotchas:* The `NEXT_PUBLIC_*` inlining trap is the whole reason the runtime split works — bake only vars that never change per deploy; secrets belong in k8s Secrets (the sample chart passes some as plaintext ConfigMap — harden with sealed/external secrets).
- *Source lineage:* the files above.

**Example scenario:** the telemetry ingest URL flowing from Helm to the browser.

### Task 15: doc `13-component-gallery.md`

**Files:** Create `arche-ui/docs/13-component-gallery.md`

**Lineage to read:** `glassflow-etl-ui/docs/architecture/COMPONENT_GALLERY.md`, `src/app/(main)/dev/components/` (layout + a section page + `_components/Section.tsx`).

**Content brief:**
- *What & why:* A live, in-app component workbench that doubles as a token-contract test and an agent-consultable example corpus.
- *The shape:* Routes under `/dev/components`; category pages; shared `Section`/`VariantGrid`/`Preview`/`CodeBlock` primitives; an `anti-patterns` page; renders in the real app context (not Storybook).
- *Build it:* Add a gallery section for a new component. Point to the seed scaffold (`../seed/gallery/`). Show a minimal section page.
- *Rules & gotchas:* Showcase only the *branded layer + tokens + composite patterns* — never re-document vanilla shadcn (that is where redundancy creeps in); keep the anti-patterns page; treat it as agent context, not just human docs; a stale gallery misleads — update it when a variant is added (candidate CI check in `./15-architectural-guardrails.md`).
- *Source lineage:* the files above.

**Example scenario:** a `StatusBadge` section with all severity variants.

### Task 16: doc `14-mock-api-layer.md`

**Files:** Create `arche-ui/docs/14-mock-api-layer.md`

**Lineage to read:** `glassflow-etl-ui/src/utils/mock-api.ts`, `src/app/ui-api/mock/` (structure), `src/app/ui-api/mock/data/` (structure + one stateful manager).

**Content brief:**
- *What & why:* Run the whole app in dev with zero external backend.
- *The shape:* Runtime toggle (`isMockMode()` + `getApiUrl()`, client+server); interception at the route layer; schema-typed fixtures; in-memory stateful managers.
- *Build it:* Stand up a mocked endpoint two ways — the current parallel-route approach AND the recommended MSW handler — and note the trade-off. Point to `../seed/mock/mock-api.ts`. Show a schema-derived fixture (typed against the same Zod schema as the real response).
- *Rules & gotchas:* **Drift-protection via shared types is the crown jewel — keep it (ideally generate fixtures from Zod).** For the new project: (a) collapse the parallel `/ui-api/mock/*` tree — prefer MSW (handlers double as test mocks); (b) **make streaming a first-class mock** — a synthetic trace/span/metric event generator, which doubles as demo mode + a UX/load tool and closes the SSE-mock gap that is disqualifying for an observability UI. Port the mechanism; regenerate the data.
- *Source lineage:* the files above.

**Example scenario:** a mocked `/ui-api/traces` plus a synthetic live-span event generator.

---

## Phase C — Net-new / prescriptive docs (Tasks 17–18)

Same doc cycle. Each of these two docs opens (immediately after the H1) with:
`> **Net-new / prescriptive** — designed for the new project, not extracted from a shipped codebase.`

### Task 17: doc `15-architectural-guardrails.md`

**Files:** Create `arche-ui/docs/15-architectural-guardrails.md`

**Content brief:**
- *What & why:* Prevent architectural + performance drift in a multi-tenant hosted service, starting at commit #1.
- *The shape:* Three layers — (1) hard CI gates, (2) agentic review, (3) recurring drift audit.
- *Build it:* Wire each hard gate, pointing at `../seed/ci/` configs:
  - Boundaries via `dependency-cruiser` (encode the `./09-component-architecture.md` direction: `shared/` may not import `modules/`, etc.).
  - Token-contract lint: fail on hardcoded hex / `rgba()` / raw Tailwind color utilities (regex ESLint rule or a `validate` script).
  - Bundle budget via `size-limit` (hard per-route ceiling).
  - Web Vitals via Lighthouse CI (regression threshold).
  - `tsc --noEmit` + ESLint `@typescript-eslint/no-explicit-any: error`.
  Show the CI job list and reference each config file by name.
  Then describe layer 2 (the `../skills/review-changes/SKILL.md` skill) and layer 3 (a scheduled agent producing a ranked triage list: dead code, oversized files, boundary erosion, bundle-creep trend).
- *Rules & gotchas:* Gates must fail the build, not warn (chosen posture); a reminder people can ignore is not a guardrail; keep the audit output actionable (ranked list), not a nag badge.
- *Source lineage:* Net-new — cites `glassflow-etl-ui/CLAUDE.md` and `.cursor/*.mdc` as the *prose rules* being promoted to *enforced gates*.

**Example scenario:** a PR that hardcodes `#ff0000` fails the token-contract gate.

### Task 18: doc `16-multitenant-performance.md`

**Files:** Create `arche-ui/docs/16-multitenant-performance.md`

**Content brief:**
- *What & why:* Load and performance are existential for a multi-tenant hosted observability app (they were non-issues in the single-tenant source app).
- *The shape:* A checklist of load-lens patterns layered onto the existing service/streaming/store docs.
- *Build it:* Apply the patterns to a large trace/log table view: virtualization; streaming + pagination over full fetch; request cancellation (reuse the `./03-service-layer.md` `AbortController` pattern); memoization; avoid cross-tenant over-fetch; per-tenant cost awareness; Web Vitals budgets; dogfood your own observability product on the app itself. Show a virtualized-list snippet and a cancellation snippet.
- *Rules & gotchas:* Never fetch all tenants' data; every long-running fetch is cancellable; big lists are always virtualized; measure with real user monitoring, not just lab.
- *Source lineage:* Net-new — reuses the `AbortController` pattern from `glassflow-etl-ui/src/services/*`.

**Example scenario:** a 50k-row span table scoped to one tenant.

---

## Phase D — Skills (Tasks 19–23)

Each skill task: write `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`), a numbered procedure, exact files-to-touch, and a worked example. Verify with `node scripts/validate-docs.mjs` still passing on docs (skills aren't validated by the doc validator, so also **manually confirm the frontmatter has `name` + `description` and steps are numbered**). Commit each skill.

### Task 19: skill `add-proxy-route`

**Files:** Create `arche-ui/skills/add-proxy-route/SKILL.md`

- [ ] **Step 1: Write the skill.** Frontmatter:
  `name: add-proxy-route`, `description: Use when adding a new ui-api proxy route that shields a backend call — scaffolds the route, request validation, service invocation, and error normalization.`
  Procedure (numbered): (1) define/extend the Zod request schema; (2) create `app/ui-api/<name>/route.ts` (thin handler); (3) add/extend the service method with `{ signal }`; (4) normalize the response + errors to the standard envelope; (5) add the mock counterpart (see `add-mock-endpoint` note); (6) verify with a curl/test. Reference `../../docs/02-proxy-routes.md` and `../../docs/03-service-layer.md`.
- [ ] **Step 2: Confirm frontmatter + numbered steps present.**
- [ ] **Step 3: Commit.**

### Task 20: skill `add-zustand-slice`

**Files:** Create `arche-ui/skills/add-zustand-slice/SKILL.md`

- [ ] **Step 1: Write the skill.** Frontmatter: `name: add-zustand-slice`, `description: Use when adding a new Zustand feature slice — creates the slice factory, composes it into the root store, registers it in the global reset, and wires an optional hydration hook.`
  Procedure: (1) create `store/<feature>.store.ts` with `createXSlice`; (2) extend the `Store` interface + compose in `store/index.ts`; (3) register in the reset orchestrator; (4) add a hydration function if the slice loads from backend (link `../../docs/07-hydration-adapters.md`); (5) verify via devtools. Reference `../../docs/05-zustand-slice-store.md`.
- [ ] **Step 2: Confirm frontmatter + numbered steps present.**
- [ ] **Step 3: Commit.**

### Task 21: skill `add-zod-form`

**Files:** Create `arche-ui/skills/add-zod-form/SKILL.md`

- [ ] **Step 1: Write the skill.** Frontmatter: `name: add-zod-form`, `description: Use when adding a schema-first form — creates the Zod schema, field config, Manager (useForm + submit), and pure Renderer in the correct order.`
  Procedure: (1) Zod schema in `scheme/`; (2) config object in `config/`; (3) Manager with `useForm(zodResolver)` + submit; (4) pure Renderer over `control` using `<FormField>`; (5) defaults from store; (6) verify validation + error display. Reference `../../docs/06-forms-zod-manager-renderer.md`.
- [ ] **Step 2: Confirm frontmatter + numbered steps present.**
- [ ] **Step 3: Commit.**

### Task 22: skill `setup-auth0`

**Files:** Create `arche-ui/skills/setup-auth0/SKILL.md`

- [ ] **Step 1: Write the skill.** Frontmatter: `name: setup-auth0`, `description: Use when enabling or debugging Auth0 auth — wires the toggle, server-only secrets, env.js sync, conditional provider, and page protection, with the known session gotchas.`
  Procedure: (1) set env vars (server-only secrets, non-prefixed); (2) instantiate `Auth0Client` + auth route; (3) conditional `AuthProvider`; (4) `startup.sh` sync of `NEXT_PUBLIC_AUTH0_ENABLED`; (5) protect a page via server-side session check; (6) debug checklist (decryption-after-rotation, hook-after-conditional, permissive proxy). Reference `../../docs/11-auth0-recipe.md`.
- [ ] **Step 2: Confirm frontmatter + numbered steps present.**
- [ ] **Step 3: Commit.**

### Task 23: skill `review-changes` (net-new / prescriptive)

**Files:** Create `arche-ui/skills/review-changes/SKILL.md`

- [ ] **Step 1: Write the skill.** Frontmatter: `name: review-changes`, `description: Use when reviewing a branch/diff for architectural and performance drift — checks against the arche-ui architecture docs and a performance heuristics checklist, and reports ranked findings.`
  Procedure: (1) get the diff (`git diff <base>...HEAD`); (2) check boundary/direction violations against `../../docs/09-component-architecture.md`; (3) check token-contract violations against `../../docs/08-design-tokens.md`; (4) performance heuristics vs `../../docs/16-multitenant-performance.md` (unvirtualized large lists, fetch waterfalls, unmemoized expensive renders, cross-tenant over-fetch, missing `AbortController`); (5) rank findings by severity; (6) output an actionable list (file:line + fix). Note it complements — does not replace — the CI hard gates in `../../docs/15-architectural-guardrails.md`.
- [ ] **Step 2: Confirm frontmatter + numbered steps present.**
- [ ] **Step 3: Commit.**

---

## Phase E — Seed code (Tasks 24–26)

### Task 24: seed `mock/mock-api.ts`

**Files:** Create `arche-ui/seed/mock/mock-api.ts`, `arche-ui/seed/mock/README.md`

- [ ] **Step 1: Write the generic toggle** at `seed/mock/mock-api.ts`

```ts
// arche-ui seed — runtime mock-mode toggle. Copy into src/utils/ and adapt as needed.
// Domain-agnostic. See docs/14-mock-api-layer.md and docs/01-runtime-env-injection.md.
declare global {
  interface Window {
    __ENV__?: Record<string, string | undefined>
  }
}

/** True when the app should serve mock responses instead of calling the real backend. */
export function isMockMode(): boolean {
  if (typeof window !== 'undefined' && window.__ENV__) {
    return window.__ENV__.NEXT_PUBLIC_USE_MOCK_API === 'true'
  }
  return process.env.NEXT_PUBLIC_USE_MOCK_API === 'true'
}

/** Resolve an endpoint name to the mock route prefix or the real proxy prefix. */
export function getApiUrl(endpoint: string): string {
  const clean = endpoint.replace(/^\/+/, '')
  return isMockMode() ? `/ui-api/mock/${clean}` : `/ui-api/${clean}`
}

export {}
```

- [ ] **Step 2: Write `seed/mock/README.md`** — one paragraph: what this is, where to copy it (`src/utils/mock-api.ts`), and that fixtures should be typed against the same Zod schemas as real responses (link back conceptually to `docs/14-mock-api-layer.md`).

- [ ] **Step 3: Commit** both files.

### Task 25: seed `gallery/` scaffold

**Files:** Create `arche-ui/seed/gallery/Section.tsx`, `arche-ui/seed/gallery/GalleryNav.tsx`, `arche-ui/seed/gallery/README.md`

**Lineage to read (port from):** `glassflow-etl-ui/src/app/(main)/dev/components/_components/Section.tsx` and `GalleryNav.tsx`.

- [ ] **Step 1: Port `Section.tsx`** — read the source, copy the `PageHeader`, `Section`, `VariantGrid`, `Preview`, `CodeBlock` exports, and **de-brand**: replace any GlassFlow-specific token names with the canonical/semantic token names from `docs/08-design-tokens.md`, and strip domain copy. Keep the token-only styling (no hardcoded colors).
- [ ] **Step 2: Port `GalleryNav.tsx`** — read the source, copy the nav, replace the `sections` array with a minimal generic set (`foundations`, `buttons`, `display`, `forms`, `feedback`, `anti-patterns`).
- [ ] **Step 3: Write `seed/gallery/README.md`** — where these go in a project (`src/app/(main)/dev/components/`), how to add a section, and the scoping rule (branded layer + tokens + composite patterns only). Link conceptually to `docs/13-component-gallery.md`.
- [ ] **Step 4: Commit** the three files.

*Note: these seed components are copy-in source; they intentionally reference tokens/shadcn that exist only in a consuming project, so they are not built inside `arche-ui`.*

### Task 26: seed `ci/` guardrail configs

**Files:** Create `arche-ui/seed/ci/.dependency-cruiser.cjs`, `arche-ui/seed/ci/.size-limit.json`, `arche-ui/seed/ci/lighthouserc.json`, `arche-ui/seed/ci/token-contract.eslint.cjs`, `arche-ui/seed/ci/README.md`

- [ ] **Step 1: Write `.dependency-cruiser.cjs`** encoding the boundary rules from `docs/09-component-architecture.md`:

```js
// arche-ui seed — architectural boundary rules. Copy to repo root; run `depcruise src`.
module.exports = {
  forbidden: [
    {
      name: 'shared-not-import-modules',
      severity: 'error',
      from: { path: '^src/components/shared' },
      to: { path: '^src/modules' },
    },
    {
      name: 'ui-stays-primitive',
      severity: 'error',
      from: { path: '^src/components/ui' },
      to: { path: '^src/(modules|components/(shared|common))' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: { tsPreCompilationDeps: true, doNotFollow: { path: 'node_modules' } },
}
```

- [ ] **Step 2: Write `.size-limit.json`** (hard per-route ceilings — placeholder paths a project fills in):

```json
[
  { "name": "app entry", "path": ".next/static/chunks/main-*.js", "limit": "120 kB" },
  { "name": "dashboard route", "path": ".next/static/chunks/app/dashboard-*.js", "limit": "180 kB" }
]
```

- [ ] **Step 3: Write `lighthouserc.json`** (Web Vitals thresholds):

```json
{
  "ci": {
    "collect": { "numberOfRuns": 3 },
    "assert": {
      "assertions": {
        "categories:performance": ["error", { "minScore": 0.9 }],
        "largest-contentful-paint": ["error", { "maxNumericValue": 2500 }],
        "cumulative-layout-shift": ["error", { "maxNumericValue": 0.1 }]
      }
    }
  }
}
```

- [ ] **Step 4: Write `token-contract.eslint.cjs`** — an ESLint flat-config fragment with a `no-restricted-syntax`/regex rule that errors on hardcoded hex, `rgba(`, and raw Tailwind color utilities in `className`/style strings. Include a short comment showing the forbidden patterns (`#RRGGBB`, `rgba(`, `bg-red-`, `text-gray-`, `border-zinc-`).

- [ ] **Step 5: Write `seed/ci/README.md`** — map each file to its gate in `docs/15-architectural-guardrails.md`, and note all are hard gates (fail CI) per the chosen posture.

- [ ] **Step 6: Commit** all five files.

---

## Phase F — Index & finalize (Task 27)

### Task 27: README index + "how to seed" + final validation

**Files:** Modify `arche-ui/README.md`; remove now-unneeded `.gitkeep` files where a real file exists.

- [ ] **Step 1: Add the docs index** to `README.md` — a table listing docs 00–16 with one-line descriptions and the Extracted vs Net-new tier marked.
- [ ] **Step 2: Add the skills index** — list the 5 skills with their `description`.
- [ ] **Step 3: Add the "How to seed a new project" section** — the concrete steps: clone/copy `arche-ui`, delete `docs/superpowers/`, copy `seed/mock/mock-api.ts` → `src/utils/`, copy `seed/gallery/*` → `src/app/(main)/dev/components/`, copy `seed/ci/*` → repo root + wire into CI, then read docs in order 00 → 16.
- [ ] **Step 4: Remove obsolete `.gitkeep`** files in `skills/` and `seed/*` (real files now exist).

```bash
cd /Users/vladimir.cutkovic/Documents/code/glassflow/arche-ui
rm -f skills/.gitkeep seed/gallery/.gitkeep seed/mock/.gitkeep seed/ci/.gitkeep
```

- [ ] **Step 5: Run the full validator**

Run: `node scripts/validate-docs.mjs`
Expected: `PASS` for all of `docs/00-*.md` … `docs/16-*.md`, exit 0.

- [ ] **Step 6: Manually confirm** all 5 `skills/*/SKILL.md` have `name` + `description` frontmatter.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Finalize arche-ui: README index + how-to-seed guide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Location/framing (arche-ui base repo) → Task 1. ✓
- Docs 00–16 → Tasks 2–18. ✓
- 5 skills → Tasks 19–23. ✓
- Seed: mock → Task 24; gallery → Task 25; ci → Task 26. ✓
- Doc template (5 sections) → enforced by validator (Task 1) on every doc task. ✓
- Extracted vs net-new tiers → Global Constraints + Task 17/18 callout + README index (Task 27). ✓
- Hard-gates posture → Task 18/26 configs + doc 15. ✓
- Drift-audit workflow → described in doc 15 (Task 17). ✓
- Deferred `add-mock-endpoint` → referenced in Task 19; not authored (matches spec §9). ✓
- README "how to seed" → Task 27. ✓
- Spec + plan travel with the repo → Task 1 Step 4. ✓

**2. Placeholder scan:** No forbidden tokens used as real content; the one reference to the archived "hook-after-conditional bug" is phrased without the literal token so the validator passes. Seed `.size-limit.json` uses example ceilings a consuming project adjusts (documented as such), not a plan placeholder.

**3. Type/name consistency:** Validator interface (`node scripts/validate-docs.mjs [file...]`, PASS/FAIL, exit 0/1) is defined in Task 1 and used identically in Tasks 2–18, 27. Seed exports `isMockMode()` / `getApiUrl()` match the names used in doc 14 (Task 16) and skill `add-proxy-route` (Task 19). Section-title list is identical between Global Constraints, the validator's `REQUIRED` array, and the doc cycle.
