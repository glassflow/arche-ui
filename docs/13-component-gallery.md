# Component gallery

## What & why

The gallery is a live, in-app component workbench mounted at `/dev/components`
inside the real application shell — not a separate build, not an iframe, not
Storybook. Every primitive and composite pattern in the design system gets a
page that renders it with real tokens, real fonts, and the real CSS cascade
the app ships with. That single fact is what makes it more useful than a
component-explorer tool bolted on beside the app: a Storybook instance runs
its own webpack config, its own theme wiring, its own CSS reset, and can
render a button that looks perfect in isolation while the same button is
broken in the app because a provider, a global style, or a token override
never reached the story. The gallery cannot lie that way — if a token is
missing or misconfigured, the gallery page breaks exactly the way the app
page would, because it *is* an app page.

That gives the gallery three jobs at once:

- **Live token-contract test.** Every preview renders with `hsl(var(--token))`
  values pulled from the same CSS the app uses. Break a token — rename it,
  drop it from `theme.css`, typo it — and the gallery shows the breakage
  immediately, in the same render path a real feature page would hit. No
  separate visual-regression pipeline is required to catch it; opening
  `/dev/components` is the check.
- **Copy-paste usage reference for humans.** Each section pairs a live
  `<Preview>` with a `<CodeBlock>` showing the exact JSX that produced it, so
  a contributor can find "what does the `destructive` button variant look
  like and what's the prop" in one page instead of reading the primitive's
  source.
- **Agent-consultable example corpus.** This is the part that matters most
  for this repo. An agent implementing a new feature should be able to open
  `/dev/components/<category>` and find the canonical shape for a pattern —
  the props a primitive actually takes, the token it actually resolves
  through, the composition an anti-pattern gets rewritten into — rather than
  guessing from a component's prop types alone or, worse, inventing a new
  one-off pattern that duplicates an existing primitive under a different
  name. The gallery is written *as* context, not just *documented as* a
  feature. See [`./09-component-architecture.md`](./09-component-architecture.md)
  for the layer rules the gallery's own examples must respect, and
  [`./08-design-tokens.md`](./08-design-tokens.md) for the token contract it
  tests live.

## The shape

The gallery is rooted at `src/app/(main)/dev/components/`. The exact set of
category folders will vary by project and grows as the design system does —
what follows is a representative layout, not an exhaustive list of every
category a given repo happens to have today:

```
src/app/(main)/dev/components/
├── layout.tsx               # sidebar shell — server component
├── page.tsx                 # overview grid — server component
├── GalleryNav.tsx            # sidebar nav + Cmd-K search palette — client
├── _components/
│   └── Section.tsx           # shared primitives: PageHeader, Section,
│                              # VariantGrid, Preview, CodeBlock
├── foundations/page.tsx       # typography, tokens, spacing, radius
├── buttons/page.tsx           # branded Button variants, sizes, states
├── display/page.tsx           # cards, chips, and data-display composites
├── forms/page.tsx              # form field primitives and their states
├── overlays/page.tsx           # dialogs, popovers, menus, tooltips
├── navigation/page.tsx         # tabbed and disclosure-style navigation
├── feedback/page.tsx           # alerts, toasts, loading and status chips
├── patterns/page.tsx            # composite, multi-primitive patterns
└── anti-patterns/page.tsx        # BAD vs GOOD, side by side, lint-backed
```

Categories such as `display`, `forms`, `overlays`, `navigation`, and
`feedback` are the common shapes most design systems end up needing, but a
given repo may add more (drawers, shell chrome, utility primitives) as its
component inventory grows. The two folders that are **not** optional are
`_components/` — the private, route-less home for the shared authoring
primitives — and `anti-patterns/` — the lint-backed enforcement page
described below. Treat the rest of the list as a starting point to adapt,
not a spec to replicate verbatim; a gallery that hardcodes an exhaustive
category list will itself go stale the moment a real project adds a
category the list doesn't mention.

The `_components/` prefix is load-bearing, not cosmetic — Next.js App Router
treats an underscore-prefixed folder as private and never creates a route
segment for it, so the shared primitives live next to the pages that consume
them without becoming a `/dev/components/_components` URL.

Each category page is a `'use client'` component — the demos need real
interactivity (a dialog has to actually open, a switch has to actually
toggle, a loading button has to actually spin) — while `layout.tsx` and the
overview `page.tsx` stay server components, since they render static shell
and navigation only.

**Shared primitives (`_components/Section.tsx`)** are the vocabulary every
category page is written in:

| Export | Purpose |
|---|---|
| `<PageHeader title description>` | Page-level `h1` + one-line description |
| `<Section title description>` | Bordered subsection with its own heading |
| `<VariantGrid columns={2\|3\|4\|5\|6}>` | Responsive grid for variant previews |
| `<Preview label center>` | One live component instance in a bordered box |
| `<CodeBlock code>` | Monospace snippet showing the JSX that produced it |

A category page is nothing more than `PageHeader` once, then one or more
`Section`s, each containing a `VariantGrid` of `Preview`s and a trailing
`CodeBlock`. That's the entire authoring surface — no page-specific layout
invention needed, which is exactly what keeps every category page visually
and structurally consistent with every other one.

The **`anti-patterns` page** is structurally different on purpose: instead of
`VariantGrid` + `Preview`, each `Section` holds an `AntiPatternRow` — a BAD
code block (styled with a "Banned" header, backed by the actual
`no-restricted-syntax` ESLint rule that rejects it in CI) next to a GOOD code
block (styled "Canonical," often with a live render of the fix). This page
is where the gallery stops being a component catalog and starts being an
enforcement artifact — every BAD example is something CI already blocks, so
the page can never drift into aspirational advice that the linter doesn't
actually back.

## Build it

Worked example: adding a gallery section for **`StatusBadge`** — a composite
built on top of the branded `Badge` primitive that maps a status enum (and an
optional `degraded` flag) to a labeled chip. It isn't in the gallery yet, and
it's exactly the kind of component the gallery exists to cover: not a raw
shadcn primitive, but a branded pattern with a real prop contract and a small
number of severity variants a consumer needs to see side by side before
reaching for it.

1. **Confirm the seed scaffold exists first.** `../seed/gallery/` ships the
   category directories, `_components/Section.tsx`, and a stub
   `anti-patterns` page pre-wired to this repo's own lint rule — don't
   hand-roll the shared primitives again per project. If `StatusBadge` lives
   in a `display`-equivalent category already, add a `Section` to that page
   rather than inventing a new route.

2. **Write the section using only the shared primitives:**

   ```tsx
   // src/app/(main)/dev/components/display/page.tsx (excerpt)
   import { StatusBadge } from '@/components/shared/StatusBadge'
   import { Section, VariantGrid, Preview, CodeBlock } from '../_components/Section'

   ;<Section
     title="StatusBadge"
     description="Severity-mapped status chip. Use over raw Badge whenever the value is a known status enum."
   >
     <VariantGrid columns={5}>
       <Preview label="running"><StatusBadge status="running" /></Preview>
       <Preview label="stopped"><StatusBadge status="stopped" /></Preview>
       <Preview label="failed"><StatusBadge status="failed" /></Preview>
       <Preview label="paused"><StatusBadge status="paused" /></Preview>
       <Preview label="degraded"><StatusBadge status="running" degraded /></Preview>
     </VariantGrid>
     <CodeBlock code={`<StatusBadge status="running" />
   <StatusBadge status="failed" />
   <StatusBadge status="running" degraded />  // hard failure always wins over degraded`} />
   </Section>
   ```

3. **Register the section so it's discoverable, not just present.** Add the
   component (and any new variant strings) to the search index in
   `GalleryNav.tsx` so Cmd-K surfaces it — a section that only Ctrl-F finds is
   half-shipped. If the category is new rather than an addition to an
   existing page, add its route to the sidebar `sections` array and to the
   overview grid in `page.tsx`.

4. **Verify by opening the route, not by reading the code.** The whole point
   of the pattern is that a broken token or a missing provider shows up as a
   visibly broken chip on `/dev/components/display` — confirm the page
   actually renders every severity correctly before calling the section
   done.

## Rules & gotchas

- **Showcase the branded layer, tokens, and composite patterns — never
  re-document vanilla shadcn.** A gallery page for a component that is pure
  unmodified shadcn with no project-specific variant, token wiring, or
  composition adds nothing a contributor couldn't get from the shadcn docs,
  and it's the single fastest way for the gallery to accumulate redundant
  pages that nobody keeps in sync. Every category page should be answering
  "what did *this project* add on top of the primitive," not "what does the
  primitive do."
- **Keep the anti-patterns page current with the lint config, not just with
  intent.** Its entire value is that every BAD example is mechanically
  rejected by CI right now. An anti-pattern documented here that the linter
  no longer catches (rule removed, rule loosened) is worse than no
  anti-patterns page — it teaches a rule that isn't actually enforced.
- **Treat the gallery as agent context, not only human-facing docs.** Write
  section descriptions and code blocks the way you'd write an example for an
  agent implementing a similar feature: complete enough to copy, accurate
  enough to trust, and free of hand-wavy "roughly like this" gestures. An
  agent that lands on `/dev/components/display` while building a new
  status-driven UI should be able to copy the `StatusBadge` snippet verbatim
  and be correct.
- **A stale gallery actively misleads — it's worse than no gallery.** Adding
  a new component or a new variant to a primitive without adding it to the
  matching category page means the gallery now under-represents the design
  system, and both humans and agents consulting it will assume the missing
  variant doesn't exist (and re-invent it) or won't know the canonical prop
  shape for it. Update the gallery in the same PR that adds the
  variant — don't defer it. This is a strong candidate for a CI check
  (diff a new `variant` string in a `ui/` or `common/` component against
  gallery coverage) rather than relying on review discipline alone; see
  [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md) for
  where that kind of structural check lives in this repo.

## Source lineage

glassflow-etl-ui/docs/architecture/COMPONENT_GALLERY.md
glassflow-etl-ui/src/app/(main)/dev/components/layout.tsx
glassflow-etl-ui/src/app/(main)/dev/components/GalleryNav.tsx
glassflow-etl-ui/src/app/(main)/dev/components/_components/Section.tsx
glassflow-etl-ui/src/app/(main)/dev/components/buttons/page.tsx
glassflow-etl-ui/src/app/(main)/dev/components/anti-patterns/page.tsx
glassflow-etl-ui/src/components/shared/StatusBadge.tsx
