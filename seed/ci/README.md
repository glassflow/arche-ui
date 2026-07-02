# CI guardrail seed configs

Copy-in configs backing the Layer 1 hard gates in
[`../../docs/15-architectural-guardrails.md`](../../docs/15-architectural-guardrails.md).
Every job below is a **hard gate** — it fails the build, it does not warn.
Per that doc's posture: a red required status check blocks merge, full stop.
None of these are pre-commit hooks or editor-only lint rules, because both of
those are skippable (`--no-verify`, closing the editor tab) by anyone in a
hurry — and "in a hurry" is exactly the condition under which the violation
gets introduced.

## Job → config map

| CI job | Tool | Config file | Fails on |
|---|---|---|---|
| `boundaries` | `dependency-cruiser` | [`dependency-cruiser.config.cjs`](./dependency-cruiser.config.cjs) | `shared/` importing `modules/*`; `ui/` importing `common/`, `shared/`, or `modules/*`; any circular dependency; a module importing another module's `components/` directly |
| `token-contract` | custom ESLint rule + regex script | [`eslint-token-contract.config.mjs`](./eslint-token-contract.config.mjs) | hardcoded hex (`#e22c2c`), `rgba(...)` literals, raw Tailwind color utilities (`bg-red-500`, `text-gray-400`, `border-zinc-700`) anywhere outside `base.css`/`theme.css` |
| `tenant-scope` | custom ESLint plugin | [`eslint-tenant-scope.config.mjs`](./eslint-tenant-scope.config.mjs) | a function building a `/ui-api/w/...` URL with no `workspaceId` parameter; reading the active tenant from `localStorage`/`sessionStorage` to scope a request; a proxy route under `app/ui-api/w/[workspaceId]/**` that never calls `assertMembership` |
| `bundle-budget` | `size-limit` | [`size-limit.config.json`](./size-limit.config.json) | any route's first-load JS exceeding its per-route ceiling |
| `web-vitals` | Lighthouse CI | [`lighthouserc.cjs`](./lighthouserc.cjs) | LCP, CLS, or TBT regressing past the threshold recorded against the last accepted baseline |
| `typecheck` | `tsc --noEmit` | [`tsconfig.ci.json`](./tsconfig.ci.json) | any type error; `strict: true`, run in isolation from the app build |
| `lint` | ESLint | [`eslint.config.mjs`](./eslint.config.mjs) | `@typescript-eslint/no-explicit-any: 'error'` (no `any`, no escape hatch via `// eslint-disable`) plus the standard React/Next.js rule set |

This table mirrors the job table in
[`../../docs/15-architectural-guardrails.md`](../../docs/15-architectural-guardrails.md)
verbatim — that doc is the authority on *why* each gate exists and how to
read its failure output; this README is the pointer from "which file backs
which job" to the actual config.

## Bundle budgets are per route class, not an app-wide average

`size-limit.config.json`'s ceilings ("120 kB", "180 kB", "220 kB", "150 kB")
are set per route class, not as a single app-wide number — see
[`../../docs/16-multitenant-performance.md`](../../docs/16-multitenant-performance.md)
for the route-class table and why an app-wide average would let one
tenant-facing route regress badly while an unrelated route improves and hides
it. The same route classes back the LCP thresholds in `lighthouserc.cjs`.

## These are copy-in configs — repoint before running

None of these configs run standalone inside `arche-ui`; they reference tools
(`dependency-cruiser`, `size-limit`, `@lhci/cli`, `eslint`, `typescript-eslint`)
that a consuming project installs itself, and they reference paths that are
placeholders for a consumer's actual project layout. Unresolved-tool errors
in this repo are expected, not defects. On copy, repoint:

- `dependency-cruiser.config.cjs` — the `from`/`to` path regexes (`^src/components/...`,
  `^src/modules/...`) to your project's actual source root if it differs.
- `eslint-token-contract.config.mjs` — the `files`/`ignores` globs to your
  source root, and confirm the exempt filenames (`base.css`, `theme.css`)
  match your actual token files.
- `eslint-tenant-scope.config.mjs` — the `files` globs to your source root,
  and, if your project names them differently, the `TENANT_PATH_PREFIX`
  (`/ui-api/w/`) and `ASSERT_FN` (`assertMembership`) constants at the top so
  they match your actual tenant path prefix and membership-assertion helper
  from [`../../docs/17-workspace-tenancy-model.md`](../../docs/17-workspace-tenancy-model.md).
- `size-limit.config.json` — the `path` globs (currently `.next/static/chunks/...`
  placeholders) to your build output's real chunk names per route.
- `lighthouserc.cjs` — the `url` array to your project's real routes and
  `startServerCommand` to however the app is built/served in CI.
- `tsconfig.ci.json` — `"extends": "../tsconfig.json"` to your project's
  actual base tsconfig path.
- `eslint.config.mjs` — spread in your project's base React/Next.js config
  (e.g. `eslint-config-next`) alongside the `no-explicit-any` rule this file
  asserts; this seed is intentionally minimal, not a full lint setup.

See [`../../docs/15-architectural-guardrails.md`](../../docs/15-architectural-guardrails.md)
for the full rationale, the three-layer enforcement model (hard gates,
agentic review, drift audit), and why the posture is hard gates that fail the
build rather than warnings.
