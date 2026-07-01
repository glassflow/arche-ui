---
name: review-changes
description: Use when reviewing a branch/diff for architectural and performance drift — checks against the arche-ui architecture docs and a performance heuristics checklist, and reports ranked findings.
---

# Review changes

Review a branch or diff for the class of issue a linter structurally cannot
catch: is this the right layer for this component, does this still respect
the token contract in spirit as well as letter, and does this new code
introduce a multi-tenant performance problem that only shows up under load.
Background and the full guardrail picture live in
[`../../docs/15-architectural-guardrails.md`](../../docs/15-architectural-guardrails.md)
— this file is the procedure, not the rationale.

## This complements CI. It does not replace it.

[`../../docs/15-architectural-guardrails.md`](../../docs/15-architectural-guardrails.md)
defines three enforcement layers. This skill **is** Layer 2 — "agentic
review." Layer 1 (`dependency-cruiser`, the token-contract lint, `size-limit`,
Lighthouse CI, `tsc --noEmit`, ESLint) is the hard gate: deterministic,
CI-failing, catches what a regex or a static graph can prove mechanically. If
Layer 1 is red, fix that first — this skill is not a substitute for making CI
pass, and it will not re-derive checks CI already runs deterministically and
cheaply. This skill exists for the judgment-level issues that pass every hard
gate by the letter of the rule while violating its intent: a component
correctly placed in `common/` by import-count that has quietly grown
domain-specific props, a Manager/Renderer split where a `useEffect` crept into
the Renderer, a virtualized table that virtualizes correctly but still
fetches all 50k rows up front. Findings from this skill are advisory — output
a review comment with ranked findings, never a merge block. A human (often
the PR author, reading this output before requesting human review) decides
what to act on now versus follow up later.

## When to use this

On demand against a local branch before opening a PR, or run against an
already-open PR's diff. Use it any time a change touches
`src/components/**`, `src/modules/**/components/**`, `src/themes/**`, a
service or hook that fetches data, or any component rendering a
tenant-scoped list. Skip it for changes with no rendering or data-fetching
surface (e.g., a docs-only change, a config file rename) — there's nothing
this skill's checks apply to.

## Procedure

1. **Get the diff.**

   ```bash
   git diff <base>...HEAD
   ```

   Use the branch's actual merge-base (typically `main` or the PR's target
   branch) as `<base>`. If reviewing an already-open PR, `gh pr diff
   <number>` is equivalent. Read the full diff before starting the checks
   below — a finding in step 4 (e.g., an unbounded fetch) is often only
   correctly diagnosed by also seeing the component in step 2 that calls it.

2. **Check boundary and direction violations against
   [`../../docs/09-component-architecture.md`](../../docs/09-component-architecture.md).**

   For every new or moved file under `src/components/**` or
   `src/modules/**/components/**` in the diff:
   - Confirm the file's layer (`ui/` / `common/` / `shared/` / `modules/*`)
     matches what it actually knows. A component that references a domain
     concept (`traceId`, `spanStatus`, `tenantId`) does not belong in
     `common/` or `shared/` regardless of import count — the "does this
     component know what a trace is" test from doc 09 overrides the
     mechanical "does anything import it twice" test `dependency-cruiser`
     runs.
   - Confirm no new import crosses a forbidden direction (`shared/` →
     `modules/*`, `common/` → `shared/`/`modules/*`, `ui/` → anything to its
     right, one module → another module's `components/`). `dependency-cruiser`
     already fails the build on a direct component import; this check is for
     the near-miss version — a `shared/` component importing a `modules/*`
     **hook** or **util** instead of a component, which is the same violation
     in spirit but doesn't trip the CI graph rule.
   - For any Manager/Renderer or Container/Presenter pair touched by the
     diff, confirm the split still holds: no `useForm`, submit handler, store
     read, or side effect has crept into the Renderer/Presenter half. This is
     the specific erosion doc 09 and doc 15 call out — it never crosses an
     import boundary a lint rule can see.
   - For any config-driven component touched by the diff, confirm the config
     object holds only data, never a callback implementing validation or a
     side effect (see doc 09's config-driven rendering section).
   - Flag a `common/` promotion that has exactly one real call site today —
     the two-call-site bar is doc 09's explicit test, and "might be reusable
     later" is the named anti-pattern.

3. **Check token-contract violations against
   [`../../docs/08-design-tokens.md`](../../docs/08-design-tokens.md).**

   The `token-contract` CI lint already fails the build on a literal hex,
   `rgba()`, or raw Tailwind color utility — don't re-run that regex. Check
   instead for violations the regex is blind to:
   - A component reaching for a `base.css` primitive directly
     (`hsl(var(--zinc-900))`) instead of the semantic name in `theme.css` —
     passes the lint (it's a `var()` reference, not a literal) but breaks the
     "primitives can move without components knowing" guarantee doc 08
     exists for.
   - A new semantic concept (a new status, a new surface, a new metric
     polarity) added without a corresponding Layer 2 token in `theme.css` —
     look for a `className`/`style` that conditionally picks between two
     *existing* tokens to fake a concept that deserves its own name (e.g.,
     toggling between `--status-warning` and `--status-error` in JS to
     represent a third state that isn't really either).
   - `className` on a `ui/`, `common/`, or `shared/` component carrying
     anything beyond layout (margin, padding, width, flex/grid) — visual
     state passed in as a raw class instead of a variant prop breaks the
     contract in doc 09 and doc 08 both describe.
   - Any new light-theme branch or conditional light/dark color pick — the
     app is dark-only; there should never be one.

4. **Run the performance heuristics checklist against
   [`../../docs/16-multitenant-performance.md`](../../docs/16-multitenant-performance.md).**

   Walk this list item by item against every new or changed component, hook,
   and service method in the diff. Each item names the pattern doc 16 defines
   and the failure mode it prevents.

   | # | Check | Fails when | Doc 16 reference |
   |---|---|---|---|
   | 1 | **Unvirtualized large lists.** Does any new/changed table or list component render a data-shaped array (traces, spans, logs, alerts) without `useVirtualizer` or equivalent? | The component maps the full array straight into JSX with no windowing, regardless of today's row count — "only 300 rows today" is not an exemption. | Load-lens 1 |
   | 2 | **Fetch waterfalls.** Does a component's data dependencies fetch sequentially when they could fetch in parallel (a `useEffect` that awaits fetch A, then fetches B using nothing from A's result)? Does any view fetch the full dataset instead of a cursor/limit page? | A service call has no `cursor`/`limit`-shaped parameter, or a hook awaits one fetch before starting an independent second one. | Load-lens 2 |
   | 3 | **Unmemoized expensive renders.** Does a component re-derive a sort/filter/aggregation over a large array on every render instead of at a memoized boundary? | A `.sort()`, `.filter()`, or `.reduce()` over a data-shaped array sits directly in render body, not inside `useMemo` keyed on the array reference. | Load-lens 4 |
   | 4 | **Cross-tenant over-fetch.** Does every new service method that queries tenant-scoped data take a required `tenantId` (or equivalent) parameter with no "fetch all" path? | A method can be called without a tenant scope, or an "admin" view loops across tenants and concatenates client-side instead of using an explicitly audited aggregate path. | Load-lens 5, Rules & gotchas |
   | 5 | **Missing `AbortController`.** Does every fetch that can outlive a UI interaction (filter change, navigation, scroll-triggered page load) accept `{ signal }` and get aborted by the caller before starting the next one? | A hook fires a new fetch on a dependency change without aborting the prior in-flight request, or a service method has no `signal` parameter at all. | Load-lens 3, Rules & gotchas |

   Additionally, for any new route or route segment touched by the diff,
   note which route class it falls into (shell/list, heavy data view,
   settings/low-traffic — see doc 16's table) so the ranked findings in step
   5 can flag if the change plausibly pushes that route past its bundle or
   LCP ceiling ahead of the `bundle-budget`/`web-vitals` CI jobs actually
   running.

5. **Rank findings by severity.**

   Use three tiers, applied consistently:
   - **HIGH** — will misbehave in production under realistic multi-tenant
     load or will actively mislead the next person who extends this code:
     missing tenant scoping (checklist item 4), an unvirtualized list on a
     view that can plausibly see thousands of rows, a fetch with no
     cancellation on a filter that changes rapidly (search-as-you-type,
     live filters), or a boundary violation that lets `shared/` depend on a
     module.
   - **MEDIUM** — real erosion of an established pattern that won't cause an
     incident today but compounds: a Manager/Renderer split with logic
     leaking across it, a token-contract violation that isn't a literal but
     breaks the semantic-layer guarantee, a `common/` promotion with only
     one call site, an unmemoized derivation on a moderately sized list.
   - **LOW** — style/consistency drift worth a follow-up but not worth
     blocking on: a missed opportunity to reuse an existing token name, a
     component that could be split for readability but isn't wrong.

   Severity tracks doc 15's own posture: Layer 2 findings are advisory, so
   rank by production impact, not by how easy the fix is to make.

6. **Output an actionable list.**

   One line per finding: `file:line` (or file + component name if the diff
   doesn't give a stable line number), the specific rule violated (cite the
   doc), and the concrete fix — not just what's wrong. Sort HIGH → MEDIUM →
   LOW. Example shape:

   ```
   1. [HIGH]   src/modules/traces/components/SpanTable.tsx:42 — renders
               `spans.map(...)` directly with no virtualization. Fix: wrap
               in `useVirtualizer` per docs/16-multitenant-performance.md
               Load-lens 1 (see SpanTable worked example in that doc).
   2. [HIGH]   src/services/trace-service.ts:18 — `listSpans(traceId,
               config)` has no `tenantId` parameter; query can cross tenant
               boundaries. Fix: add required `tenantId` argument threaded
               into the query, per docs/16 Load-lens 5.
   3. [MEDIUM] src/modules/alerts/AlertRuleFormRenderer.tsx:67 — Renderer
               calls `useEffect` to refetch severities on mount. Fix: move
               the fetch into AlertRuleFormManager; Renderer stays a pure
               function of `control` per docs/09-component-architecture.md
               Manager/Renderer contract.
   4. [LOW]    src/components/common/MetricDelta.tsx:12 — reads
               `hsl(var(--green-400))` directly. Fix: use the existing
               `--metric-positive` semantic token per
               docs/08-design-tokens.md instead of the base.css primitive.
   ```

   If the diff has zero findings across steps 2–4, say so explicitly rather
   than omitting the section — "no boundary, token, or performance findings
   in this diff" is itself useful signal to the person reading the review.

## Rules & gotchas

- **This skill is advisory, not a merge gate.** It never blocks a PR and
  never substitutes for making the Layer 1 CI jobs in doc 15 pass — if a
  literal hex or a forbidden import is in the diff, that's already a red CI
  check, not a step-3 finding to rediscover.
- **Don't re-run what CI already runs deterministically.** Skip re-scanning
  for exact hex literals, exact forbidden component-to-component imports,
  or `tsc` type errors — those are Layer 1's job and this skill's value is
  in the checks Layer 1 structurally cannot express (see the "does this
  component know what a trace is" example in step 2).
- **A finding this skill repeatedly surfaces on the same shape of change is
  a signal to close the Layer 1 gap, not just fix the instance.** Per doc
  15's own rule: if the same near-miss (e.g., a hook reaching across a
  module boundary) shows up review after review, that's a
  `dependency-cruiser` config gap, not a permanently manual check.
- **Rank by production impact, not by fix difficulty.** A one-line fix that
  prevents a cross-tenant data leak is still HIGH; a large refactor that
  only improves readability is still LOW.
- **When in doubt about a boundary call, read the component's props, not
  its file path.** A component sitting in `common/` that accepts a `span:
  Span` prop has already leaked the domain concept in through the type
  signature even if its own code never mentions "trace" — doc 09's test is
  "does it know," and a prop type is knowing.

## Source lineage

Net-new. Defined as Layer 2 of the enforcement model in
[`../../docs/15-architectural-guardrails.md`](../../docs/15-architectural-guardrails.md);
checks are drawn from [`../../docs/09-component-architecture.md`](../../docs/09-component-architecture.md),
[`../../docs/08-design-tokens.md`](../../docs/08-design-tokens.md), and
[`../../docs/16-multitenant-performance.md`](../../docs/16-multitenant-performance.md).
