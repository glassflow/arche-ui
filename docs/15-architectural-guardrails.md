# Architectural guardrails

> **Net-new / prescriptive** — designed for the new project, not extracted from a shipped codebase.

## What & why

A multi-tenant AI-observability frontend accumulates the same three kinds of
drift every hosted product accumulates, and each kind has a different half-life.
Boundary violations (a `shared/` component quietly importing a `modules/*`
component) rot in days — the first PR that does it makes the second one look
normal. Token-contract violations (a hardcoded `#e22c2c` instead of
`hsl(var(--status-error))`) rot in hours — whoever's under deadline pressure
reaches for the literal because it's faster to type. Bundle and Web Vitals
regressions rot in single commits — one unlazy-loaded chart library added to
a shared layout can blow every route's budget at once. None of these are bugs
a code reviewer reliably catches by eye at PR #40, let alone PR #400, because
by then the "obviously wrong" pattern has three precedents already merged.

The fix is to stop treating these as review checklist items and start
treating them as CI gates that fail the build, from commit #1 — before there
is a single precedent to point to, and before the team is large enough that
"just review it carefully" scales. This doc exists because prose rules that
live only in a CLAUDE.md or a `.cursor/*.mdc` file are read once, remembered
imperfectly, and enforced inconsistently — the exact three properties a
guardrail cannot have. Every rule in this doc already existed as prose in the
donor codebase (`glassflow-etl-ui/CLAUDE.md`, `.cursor/styling.mdc`,
`.cursor/components.mdc`); the change here is not the rule, it's the
enforcement mechanism. A rule that lints is a rule that's actually followed.

The chosen posture is **hard gates that fail the build**, not warnings. A
multi-tenant service has one codebase serving every tenant — a bundle
regression or a boundary violation doesn't degrade gracefully per tenant, it
degrades for all of them simultaneously the moment it ships. See
[`./16-multitenant-performance.md`](./16-multitenant-performance.md) for why
per-route budgets specifically (not an app-wide average) are the unit that
matters in a multi-tenant shell where one tenant's dashboard shouldn't be able
to regress another tenant's load time.

## The shape

Three enforcement layers, in decreasing order of mechanical certainty and
increasing order of judgment required:

```
Layer 1 — Hard gates (CI-failing, every PR)
    │  dependency-cruiser · token-contract lint · tenant-scope lint ·
    │  size-limit · Lighthouse CI · tsc --noEmit · ESLint no-explicit-any
    │  Deterministic. No judgment call. Red X blocks merge.
    ▼
Layer 2 — Agentic review (on-demand + PR)
    │  review-changes skill
    │  Judgment-level issues: is this abstraction actually reusable,
    │  does this Manager/Renderer split make sense, is this the right
    │  layer for this component. Advisory — a human or the PR author
    │  decides what to do with the findings.
    ▼
Layer 3 — Recurring drift audit (scheduled, weekly)
    │  drift-audit workflow → ranked triage list
    │  Trend-level erosion no single PR shows: dead code accumulating,
    │  files creeping past a size ceiling, near-miss boundary patterns,
    │  bundle-size trend line. Not a gate — a standing to-do list with
    │  ranked severity, assigned owners, and a paper trail.
```

Layer 1 catches what a regex or a static graph can prove mechanically —
"this import crosses a forbidden boundary," "this literal is a hex code,"
"this route's bundle exceeds N KB." It runs on every PR, requires no one to
remember anything, and produces a binary pass/fail. Layer 2 catches what
requires reading the code and understanding intent — "this component is
correctly placed in `common/` by the letter of the rule but is actually only
used by one feature and should move to that module." It runs on-demand or on
PR and produces a review comment, not a merge block. Layer 3 catches what
only shows up as a trend across many commits — "average file size in
`modules/dashboard/` has grown 40% this quarter," "three PRs this month added
near-miss boundary imports that a slightly different refactor would have
turned into real violations." It runs on a schedule (not per-PR, because the
signal only exists in aggregate) and produces a ranked list a human triages,
not an alert that fires and is dismissed.

The layers are ordered by cost of a false negative. A hard gate that misses a
violation ships it into production, on every tenant, immediately — so Layer 1
only takes checks a machine can prove without ambiguity. A review skill that
misses a judgment call gets caught on the next pass or the next drift audit —
so Layer 2 can afford probabilistic reasoning. A drift audit that misses a
trend this week catches it next week — so Layer 3 can afford to be
retrospective. Nothing in Layers 2 or 3 is a substitute for Layer 1; they
exist because Layer 1 structurally cannot express "is this actually the right
abstraction," only "does this violate a provable, mechanical rule."

## Build it

### Layer 1 — CI job list

Seven jobs, each mapped to a seed config in [`../seed/ci/`](../seed/ci/). Every
job is a required status check — a red job blocks merge, full stop.

| CI job | Tool | Config file | Fails on |
|---|---|---|---|
| `boundaries` | `dependency-cruiser` | `../seed/ci/dependency-cruiser.config.cjs` | `shared/` importing `modules/*`; `ui/` importing `common/`, `shared/`, or `modules/*`; any circular dependency; a module importing another module's `components/` directly |
| `token-contract` | custom ESLint rule + regex script | `../seed/ci/eslint-token-contract.config.mjs` | hardcoded hex (`#e22c2c`), `rgba(...)` literals, raw Tailwind color utilities (`bg-red-500`, `text-gray-400`, `border-zinc-700`) anywhere outside `base.css`/`theme.css` |
| `tenant-scope` | custom ESLint plugin | `../seed/ci/eslint-tenant-scope.config.mjs` | a function building a `/ui-api/w/...` URL with no `workspaceId` parameter; reading the active tenant from `localStorage`/`sessionStorage` to scope a request; a proxy route under `app/ui-api/w/[workspaceId]/**` that never calls `assertMembership` |
| `bundle-budget` | `size-limit` | `../seed/ci/size-limit.config.json` | any route's first-load JS exceeding its per-route ceiling (see [`./16-multitenant-performance.md`](./16-multitenant-performance.md) for how ceilings are set per route class) |
| `web-vitals` | Lighthouse CI | `../seed/ci/lighthouserc.cjs` | LCP, CLS, or TBT regressing past the threshold recorded against the last accepted baseline |
| `typecheck` | `tsc --noEmit` | `../seed/ci/tsconfig.ci.json` | any type error; this config sets `strict: true` and is the same `tsconfig` the app builds with, run in isolation so a slow build doesn't hide a fast typecheck failure |
| `lint` | ESLint | `../seed/ci/eslint.config.mjs` | `@typescript-eslint/no-explicit-any: 'error'` (no `any`, no escape hatch via `// eslint-disable`) plus the standard React/Next.js rule set |

`boundaries` is the direct enforcement of the layer rule in
[`./09-component-architecture.md`](./09-component-architecture.md): `ui/` →
`common/` → `shared/` → `modules/*` is a one-way dependency chain, and
`dependency-cruiser`'s `forbidden` rules encode that chain as a graph
constraint rather than a sentence someone has to remember. `token-contract` is
the direct enforcement of the token rule in
[`./08-design-tokens.md`](./08-design-tokens.md): every color is a CSS
variable reference, never a literal, and this job is what turns "never a
literal" from a sentence in a doc into a build failure on line N of a diff.
`tenant-scope` is the direct enforcement of the tenancy rules in
[`./17-workspace-tenancy-model.md`](./17-workspace-tenancy-model.md): because
that doc makes `workspaceId` a required path segment (`/ui-api/w/[workspaceId]`),
every tenant-scoped call has an AST-visible signature, so "never forget to scope
a tenant call" becomes a mechanical rule rather than a review-checklist item —
the first product's optional `organization_id` query param had no such signature
and could not have been gated this way. It is also the mechanical floor under
[`./16-multitenant-performance.md`](./16-multitenant-performance.md)'s
required-`tenantId`-argument rule: a missing scope is a cross-tenant leak, which
in a hosted product is an incident, not a lint nit.

**Example scenario.** A PR adds:

```tsx
<span style={{ color: '#ff0000' }}>Error</span>
```

The `token-contract` job's regex matches the hex literal, the job exits
non-zero, the required status check goes red, and the PR cannot merge until
the line is rewritten as `style={{ color: 'hsl(var(--status-error))' }}` (or
`<Badge variant="error">`, which resolves the same token internally). No
reviewer had to notice it — the gate did.

### Layer 2 — agentic review

The [`review-changes` skill](../skills/review-changes/SKILL.md) runs against
a diff — on-demand from a local session or wired into the PR flow — and looks
for exactly the class of issue Layer 1 cannot express as a mechanical rule:

- A component sits in `common/` and technically has zero cross-module
  imports pointing at it, but its props already leak a domain concept
  (`traceId`, `spanStatus`) — the letter of the boundary rule passes,
  the intent of the rule ("domain-neutral") doesn't.
- A Manager/Renderer split exists but the Renderer has grown a `useEffect`
  that belongs in the Manager — no import crosses a forbidden boundary, so
  `dependency-cruiser` is silent, but the separation of concerns the pattern
  exists for has quietly eroded.
- A new config-driven component's config object has grown a callback,
  which is exactly the anti-pattern [`./09-component-architecture.md`](./09-component-architecture.md)
  calls out — a lint rule can't reliably distinguish "this callback is a
  behavior" from "this callback is a formatter," but a review pass reading
  the diff can.

The skill's output is a review comment with findings and severity, not a
merge block — a human (often the PR author, reading the skill's own output
before requesting human review) decides whether the finding is worth acting
on before merge or worth a follow-up ticket. This is deliberate: judgment
calls that get wrongly hard-blocked train people to route around the gate
(force-merge, disable the check "just this once") — which is worse than not
having the check.

### Layer 3 — recurring drift audit

A scheduled workflow (weekly cadence, off the default branch, no PR trigger)
runs a fixed set of structural scans across the whole tree and produces one
artifact: a ranked, actionable triage list. Not a dashboard, not a Slack
notification that gets muted after week two — a list with a severity, a file,
and a suggested next action per line, e.g.:

```
1. [HIGH]   modules/dashboard/components/AlertRulesTable.tsx — 812 lines,
            3x the module's average. Split candidates: filter-bar (own
            component), row-actions menu (own component).
2. [HIGH]   components/shared/AppSidebar.tsx — imports
            modules/traces/hooks/useRecentTraces (near-miss: hook import,
            not component import, so dependency-cruiser's component-boundary
            rule doesn't fire, but this is the same violation in spirit).
3. [MED]    bundle-size trend for /dashboard/[tenantId]: +18% over 4 weeks,
            driven by modules/dashboard/charts — no single PR crossed the
            size-limit ceiling, each added ~2KB.
4. [LOW]    modules/alerts/components/legacy/ — 6 files, zero imports
            anywhere in the tree. Dead code candidate.
```

The scans behind that list: a dependency graph diff run in "advisory" mode
against boundary rules that are directionally correct but not yet
`dependency-cruiser`-strict (catching near-misses hard gates can't see by
construction, like a hook that reaches across a module boundary even though
no component does); a file-size census per module compared against that
module's own rolling average, not a global constant; a bundle-size trend
line per route pulled from the `size-limit` job's historical output, so
sub-threshold creep across many small PRs is visible even though no single
PR tripped the Layer 1 ceiling; and a dead-code scan (unused exports, unused
files) run against the whole tree. The list is triaged by a human on a
schedule (e.g., the first working session of the week) — it is input to
prioritization, not an automatic action.

## Rules & gotchas

- **Gates fail the build. They do not warn.** A `size-limit` job configured
  to print a warning and exit 0 is not a guardrail, it's a comment nobody
  reads after the first month. Every Layer 1 job in the table above must be
  wired as a required status check with a non-zero exit on violation — if a
  tool's default behavior is warn-only (some ESLint rules default to `warn`),
  the seed config overrides it to `error`.
- **A reminder people can ignore is not a guardrail.** This is the reason
  Layer 1 exists as CI jobs instead of a pre-commit hook or a linter running
  only in editors — those are both skippable (`--no-verify`, closing the
  editor tab) by anyone in a hurry, and "in a hurry" is exactly the condition
  under which the violation gets introduced. CI is the layer nobody can skip
  without an explicit, visible override.
- **Layer 1 must stay mechanical — resist the urge to make it judge intent.**
  The moment a "hard gate" starts trying to decide whether a boundary
  violation was "justified," it needs an escape hatch, and escape hatches are
  where the gate's authority leaks away. Judgment calls belong in Layer 2, not
  bolted onto Layer 1 as a growing exception list.
- **Layer 3's output must stay a ranked, actionable list — never a passive
  score or badge.** A dashboard number that goes up or down without a
  next-action attached gets checked twice and ignored forever after. Every
  finding in the drift audit names a file (or file set) and a suggested next
  step; "health score: 74/100" is explicitly the anti-pattern this layer is
  designed to avoid.
- **Per-route budgets, not an app-wide bundle average.** In a multi-tenant
  shell, an app-wide average can hide one tenant-facing route regressing
  badly while an unrelated route improves. `size-limit`'s config sets a
  ceiling per route class — see
  [`./16-multitenant-performance.md`](./16-multitenant-performance.md) for
  how route classes are defined and budgeted.
- **A near-miss caught by Layer 3 becomes a Layer 1 rule, not a one-off
  fix.** If the drift audit repeatedly flags the same *shape* of violation
  (e.g., hooks reaching across module boundaries the same way components are
  forbidden to), that's a signal the `dependency-cruiser` config in
  `../seed/ci/dependency-cruiser.config.cjs` has a gap — close the gap, don't
  just fix the flagged instance and wait for the next audit to flag the next
  one.
- **`@typescript-eslint/no-explicit-any` has no per-line escape valve by
  convention.** A single `// eslint-disable-next-line` on an `any` is a
  judgment call that belongs in a PR description and a Layer 2 review
  comment, not a silent, permanent bypass — if `any` is genuinely
  unavoidable (an untyped third-party callback shape, for instance), the
  disable comment must carry a reason, and the reason is exactly the kind of
  thing Layer 2 review checks for.

## Source lineage

- glassflow-etl-ui/CLAUDE.md
- glassflow-etl-ui/.cursor/styling.mdc
- glassflow-etl-ui/.cursor/components.mdc
