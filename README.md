# arche-ui

Base repository of proven frontend architecture patterns. Clone or copy into a new
project and adjust. Distilled from the GlassFlow ClickHouse ETL UI; first consumer is
the AI-observability platform frontend.

- **`docs/`** — reference docs, one pattern each. See the index below.
- **`skills/`** — invokable Claude Code skills for high-frequency build actions.
- **`seed/`** — copy-in starter code (mock toggle, gallery scaffold, CI guardrail configs).
- **`scripts/validate-docs.mjs`** — `node scripts/validate-docs.mjs` validates all docs.

## Docs index

| # | Doc | Title | Tier |
|---|---|---|---|
| 00 | [`architecture-overview.md`](./docs/00-architecture-overview.md) | Architecture overview | Extracted / proven |
| 01 | [`runtime-env-injection.md`](./docs/01-runtime-env-injection.md) | Runtime env injection | Extracted / proven |
| 02 | [`proxy-routes.md`](./docs/02-proxy-routes.md) | Proxy routes | Extracted / proven |
| 03 | [`service-layer.md`](./docs/03-service-layer.md) | Service layer | Extracted / proven |
| 04 | [`sse-streaming.md`](./docs/04-sse-streaming.md) | SSE streaming | Extracted / proven |
| 05 | [`zustand-slice-store.md`](./docs/05-zustand-slice-store.md) | Zustand slice store | Extracted / proven |
| 06 | [`forms-zod-manager-renderer.md`](./docs/06-forms-zod-manager-renderer.md) | Forms: Zod schema, config object, Manager/Renderer | Extracted / proven |
| 07 | [`hydration-adapters.md`](./docs/07-hydration-adapters.md) | Hydration adapters | Extracted / proven |
| 08 | [`design-tokens.md`](./docs/08-design-tokens.md) | Design tokens | Extracted / proven |
| 09 | [`component-architecture.md`](./docs/09-component-architecture.md) | Component architecture | Extracted / proven |
| 10 | [`providers.md`](./docs/10-providers.md) | Providers | Extracted / proven |
| 11 | [`auth0-recipe.md`](./docs/11-auth0-recipe.md) | Auth0 recipe | Extracted / proven |
| 12 | [`deployment.md`](./docs/12-deployment.md) | Deployment | Extracted / proven |
| 13 | [`component-gallery.md`](./docs/13-component-gallery.md) | Component gallery | Extracted / proven |
| 14 | [`mock-api-layer.md`](./docs/14-mock-api-layer.md) | Mock API layer | Extracted / proven |
| 15 | [`architectural-guardrails.md`](./docs/15-architectural-guardrails.md) | Architectural guardrails | Net-new / prescriptive |
| 16 | [`multitenant-performance.md`](./docs/16-multitenant-performance.md) | Multi-tenant performance | Net-new / prescriptive |

Docs 00–14 are pulled from a shipped codebase (GlassFlow ClickHouse ETL UI) and
describe patterns already proven in production. Docs 15–16 are net-new guidance
written for the first downstream consumer, the multi-tenant AI-observability
frontend — they prescribe a posture rather than extract one.

## Skills index

Each skill lives in `skills/<name>/SKILL.md` and is invoked directly by name.

| Skill | Description |
|---|---|
| [`add-proxy-route`](./skills/add-proxy-route/SKILL.md) | Use when adding a new ui-api proxy route that shields a backend call — scaffolds the route, request validation, service invocation, and error normalization. |
| [`add-zustand-slice`](./skills/add-zustand-slice/SKILL.md) | Use when adding a new Zustand feature slice — creates the slice factory, composes it into the root store, registers it in the global reset, and wires an optional hydration hook. |
| [`add-zod-form`](./skills/add-zod-form/SKILL.md) | Use when adding a schema-first form — creates the Zod schema, field config, Manager (useForm + submit), and pure Renderer in the correct order. |
| [`setup-auth0`](./skills/setup-auth0/SKILL.md) | Use when enabling or debugging Auth0 auth — wires the toggle, server-only secrets, env.js sync, conditional provider, and page protection, with the known session gotchas. |
| [`review-changes`](./skills/review-changes/SKILL.md) | Use when reviewing a branch/diff for architectural and performance drift — checks against the arche-ui architecture docs and a performance heuristics checklist, and reports ranked findings. |

## How to seed a new project

1. Clone or copy this repo (`arche-ui`) as the starting point for the new project.
2. Delete `docs/superpowers/` — it holds this repo's own plan and spec history
   (`docs/superpowers/plans/`, `docs/superpowers/specs/`) from building `arche-ui`
   itself, not guidance for a downstream project. It has no cross-links from any
   numbered doc and nothing in the new project depends on it.
3. Copy `seed/mock/mock-api.ts` to `src/utils/mock-api.ts` in the new project.
   Adapt `isMockMode()` and `getApiUrl()` as needed, and type any fixtures against
   the same Zod schemas as the real backend responses — see
   [`docs/14-mock-api-layer.md`](./docs/14-mock-api-layer.md).
4. Copy `seed/gallery/GalleryNav.tsx` and `seed/gallery/Section.tsx` into the new
   project under `src/app/(main)/dev/components/` (`GalleryNav.tsx` alongside
   `layout.tsx`, `Section.tsx` inside `_components/`). Repoint the `cn` import
   (currently `@/src/utils/common.client`) and any other `@/src/...` alias paths
   to match the new project's actual alias and utility location. `layout.tsx` and
   `page.tsx` are project-authored shell code, not part of this seed — see
   [`docs/13-component-gallery.md`](./docs/13-component-gallery.md).
5. Copy the files under `seed/ci/` (`dependency-cruiser.config.cjs`,
   `eslint-token-contract.config.mjs`, `eslint.config.mjs`, `lighthouserc.cjs`,
   `size-limit.config.json`, `tsconfig.ci.json`) to the new project's repo root,
   then wire each into a required CI status check per the job table in
   [`docs/15-architectural-guardrails.md`](./docs/15-architectural-guardrails.md)
   (`boundaries`, `token-contract`, `bundle-budget`, `web-vitals`, `typecheck`,
   `lint`). Repoint the placeholder paths in each config (source root globs,
   build-output chunk paths, route URLs, base tsconfig path) to the new project's
   real layout — see `seed/ci/README.md` for the exact per-file repoint list.
6. Read the docs in order, `00` through `16`, to absorb the conventions before
   writing code.
