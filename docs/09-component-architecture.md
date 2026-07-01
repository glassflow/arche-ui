# Component architecture

## What & why

Every component in the app belongs to exactly one of four layers, and the
layers form a strict one-way dependency chain: `ui/` → `common/` → `shared/`
→ `modules/*`. A component may only import from its own layer or a layer to
its left. Nothing in `ui/` knows `common/` exists; nothing in `shared/` knows
any `modules/*` exists; a module can reach down into `shared/`, `common/`,
and `ui/`, but no module ever imports from another module's `components/`
directory.

This exists because "where does this component live" is a question every
new feature asks, and without a fixed answer the natural failure mode is a
`common/` folder that slowly fills with things that are really one feature's
business logic wearing a reusable-looking name, and a `shared/` folder that
slowly grows a dependency on whichever module needed something from the app
shell most recently. Once that happens, the app shell (sidebar, topbar,
layout) can no longer be reasoned about, tested, or changed without asking
"which feature module does this secretly depend on now?" — and the answer
is different every time someone checks. A one-way dependency graph makes
that question always answerable by *construction*: `shared/` cannot import
`modules/`, so it structurally cannot develop a hidden dependency on a
feature.

The second reason this shape matters is reuse discipline. A component only
qualifies for `common/` when it is domain-neutral *and* has two or more real
call sites — not "this might be reusable someday," but "this is already
used in two unrelated features today." That bar keeps `common/` a place
engineers can grab from with confidence (whatever's there really is generic)
instead of a junk drawer that requires reading the implementation to find
out whether it secretly assumes it's running inside one particular feature.

## The shape

```
components/ui/          primitives — shadcn/Radix, own all visual state
    │  Button, Input, Dialog, Card, Badge, Form — variant props, not raw CSS
    ▼
components/common/      domain-neutral, reusable across 2+ features
    │  FormModal, SearchableSelect, InputFile, StatusBadge, EventEditor
    ▼
components/shared/      app shell infrastructure only
    │  AppSidebar, AppTopbar, Header, ShellLayoutClient, ConsentDialog
    ▼
modules/*/components/   feature-specific, domain logic lives here
       KafkaConnectionFormManager, ClickhouseMapper, SpanWaterfall, ...
```

`components/providers/` sits alongside this chain rather than inside it —
React context providers (`AuthProvider`, `ThemeProvider`,
`ObservabilityProvider`) that wrap the whole app in `app/layout.tsx`. They
follow the same import-direction discipline (a provider never imports from
`modules/*`) but they're composition roots, not a layer features render
through.

Each layer answers one question:

- **`ui/`** — "how does a single primitive look and behave?" Source of
  truth for buttons, inputs, dialogs, cards, badges, form controls. Visual
  state is a variant prop (`<Button variant="primary">`, `<Badge
  variant="success">`), never a raw CSS class passed in from outside. Do not
  add new primitives here casually — only extend when aligning with an
  upstream shadcn/Radix update. See
  [`./08-design-tokens.md`](./08-design-tokens.md) for how a primitive's
  variants resolve to CSS variables instead of hardcoded colors.
- **`common/`** — "is this pattern generic enough that a second, unrelated
  feature already reuses it?" A component qualifies when it's domain-neutral
  (it doesn't know or care what a "trace" or a "pipeline" is) and has real
  reuse today, not hypothetical reuse. `className` on a `common/` component
  is for layout only (margin, padding, width) — visual state still lives in
  props the component defines, exactly like `ui/`.
- **`shared/`** — "is this part of the app shell every feature renders
  inside of?" Sidebar, topbar, header, the shell layout wrapper, app-wide
  dialogs (consent, health-check). Not a home for generic UI patterns (that's
  `common/`) and not a home for any feature's UI, however small that feature
  is (that's a module). The defining test: if you deleted every feature
  module, would this component still make sense to render? If yes, it's
  `shared/`.
- **`modules/*/components/`** — "does this component only make sense in the
  context of one feature's domain?" Feature-specific components, business
  logic, and the composition patterns below all live here. Cross-module
  imports are avoided — if two modules both need something, that something
  gets promoted to `common/`, not imported sideways between modules.

### Composition patterns

**Container/Presenter.** A container owns data fetching, store interaction,
and side effects; a presenter is a (mostly) pure function of props that
renders. The split exists so a presenter can be tested, Storybook'd, or
reused without standing up the container's data dependencies. Example
lineage: `KafkaConnectionContainer` (container, fetches connection state)
renders `KafkaConnectionFormManager` (presenter).

**Manager/Renderer.** The form-specific specialization of Container/
Presenter: a Manager owns `useForm`, the Zod resolver, submit/discard
handlers; a Renderer is a pure function of `control` that lays out fields.
See [`./06-forms-zod-manager-renderer.md`](./06-forms-zod-manager-renderer.md)
for the full contract — schema, config, Manager, and Renderer as four
separate artifacts with one direction of dependency between them.

**Config-driven rendering.** When a UI shape repeats with only its data
varying — field definitions, column sets, filter groups — prefer a plain
config object over duplicating JSX per call site. The component reads the
config; the config never contains behavior, only the data needed to render
and validate. This is the same discipline the Manager/Renderer config layer
uses, applied outside forms too (e.g., a table's column config, a chart
legend's series config).

## Build it

Worked example: adding a **`SpanWaterfall`** component — a chart that renders
a trace's spans as a horizontal waterfall, used only in the trace detail
view.

1. **Decide the layer by asking what it knows.** `SpanWaterfall` knows what
   a "span" is, what "parent span ID" means, how to compute the timeline
   offsets from span start/end timestamps, and how to color a span by its
   status (`ok` / `error` / `timeout`). None of that is domain-neutral — a
   `common/` waterfall would either need to accept spans as a generic
   prop shape (leaking the domain concept in through the back door) or stay
   forever half-generic waiting for a second consumer that doesn't exist.
   It also isn't app shell — deleting every feature module would leave
   nothing that wants to render a span waterfall. That leaves exactly one
   answer: `modules/traces/components/SpanWaterfall.tsx`.

2. **Split it if it grows a data-fetching half.** If `SpanWaterfall` needs to
   fetch the span list itself rather than receive it as a prop, apply
   Container/Presenter inside the same module: `SpanWaterfallContainer`
   (calls `useSpans(traceId)`, owns loading/error state) renders
   `SpanWaterfall` (pure — spans in, SVG/DOM out). Both stay in
   `modules/traces/components/`; the split is about responsibility, not
   about which layer they live in.

3. **Reach down, never sideways, never up.** `SpanWaterfall` is free to
   import:
   - `components/ui/tooltip` for the hover tooltip on a span bar (`ui/`),
   - `components/common/ChartTooltip`-style primitives if one already exists
     and is genuinely chart-shape-agnostic (`common/`),
   - nothing from `components/shared/` in this case (a waterfall doesn't
     need the app shell), and
   - nothing from `modules/alerts/`, `modules/dashboard/`, or any other
     module. If `SpanWaterfall` needs something another module built (say,
     `modules/dashboard` already has a time-axis formatter), that formatter
     gets promoted to `common/` or a shared util — it is never imported
     module-to-module directly.

4. **The import-direction rule in practice, both ways:**

   ```tsx
   // modules/traces/components/SpanWaterfall.tsx — ALLOWED
   import { Tooltip } from '@/src/components/ui/tooltip'          // ui/  ✅ (down)
   import { StatusBadge } from '@/src/components/common/StatusBadge' // common/ ✅ (down)

   // components/shared/AppSidebar.tsx — FORBIDDEN
   import { SpanWaterfall } from '@/src/modules/traces/components/SpanWaterfall'
   // ❌ shared/ importing from modules/* — breaks the one-way rule,
   //    and CI's dependency-direction check fails the build on this line.
   ```

   The sidebar rendering a "recent traces" preview is a real, plausible
   feature request — but the fix is never `shared/` reaching into a module.
   Either the preview becomes its own small `shared/`-appropriate component
   fed data through props from a page that already has both, or the sidebar
   exposes a slot/children prop that a page (which *can* import from
   `modules/*`) fills in. `shared/` stays ignorant of every module that
   exists.

5. **Register visual state as variant props, not classes.** If
   `SpanWaterfall` needs an "error" visual treatment on a failed span, that's
   a prop on whatever primitive draws the bar (`<Badge variant="error">`, or
   a `status` prop the module component defines itself) — never a
   hand-rolled `className="bg-red-500"` reaching past the primitive's own
   state handling.

## Rules & gotchas

- **Dependency direction is one-way and it is enforced by CI, not just
  convention.** `ui/` → `common/` → `shared/`, and `modules/*` may consume
  all three — but nothing flows back up. A PR that adds a `modules/*` import
  inside `components/shared/` (or `common/`, or `ui/`) fails the
  architectural guardrail check before it merges. See
  [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md) for
  the exact lint rule and how to read its failure output.
- **`shared/` must never import from `modules/*`.** This is the single most
  common violation, because the shell (sidebar, topbar) is exactly where
  someone wants to add a feature-flavored preview or shortcut. Push the
  feature-aware part into a page or a module component and pass the shell
  only props/children/slots.
- **Visual state lives in variant props; `className` is layout-only.** A
  component that accepts `className` and expects the caller to pass
  `"bg-red-500 text-white"` for an error state has broken the contract —
  the component itself should expose `variant="destructive"` or
  `error={true}` and resolve the actual styling internally against design
  tokens. See [`./08-design-tokens.md`](./08-design-tokens.md) for why
  colors are never literals, only token references.
- **`common/` requires two real call sites, not a hypothetical one.** A
  component built for a single feature but placed in `common/` "because it
  might be useful later" inverts the reuse test — it now looks reusable
  without having been proven reusable, and the next person who reaches for
  it inherits whatever assumptions its original feature baked in. Leave it
  in the module until a second feature actually needs it, then promote it.
- **A module never imports another module's `components/`.** If two modules
  converge on needing the same component, that's the signal to promote the
  component to `common/` (if domain-neutral) — not to import across the
  module boundary. Cross-module imports are how the dependency graph stops
  being a tree and starts being unmaintainable.
- **Config-driven rendering configs hold data, never behavior.** The same
  rule that applies to form configs (see
  [`./06-forms-zod-manager-renderer.md`](./06-forms-zod-manager-renderer.md))
  applies to any config-driven component: if a config object starts
  containing a callback that implements a validation rule or a side effect,
  that logic belongs in the component or its Manager, not the config.

## Source lineage

- glassflow-etl-ui/.cursor/architecture/COMPONENT_ARCHITECTURE.md
- glassflow-etl-ui/src/components/ui/
- glassflow-etl-ui/src/components/common/
- glassflow-etl-ui/src/components/shared/
- glassflow-etl-ui/src/components/providers/
- glassflow-etl-ui/src/modules/observability/
- glassflow-etl-ui/src/modules/pipelines/components/
