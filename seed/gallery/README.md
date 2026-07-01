# Gallery seed

Copy-in source for a project's live component gallery. These files are not
built or imported inside `arche-ui` itself — they reference `react`, `next`,
`lucide-react`, and a consuming project's own `@/src/components/ui/*`
primitives and `theme.css` tokens, none of which exist in this repo. Copy
them into a consuming project and they become real, working code there.

See [`../../docs/13-component-gallery.md`](../../docs/13-component-gallery.md)
for the full rationale, the worked "add a section" example, and the rules
that keep the gallery from going stale.

## Where these go

```
src/app/(main)/dev/components/
├── layout.tsx               # sidebar shell — server component (project-authored)
├── page.tsx                 # overview grid — server component (project-authored)
├── GalleryNav.tsx            # ← this file
├── _components/
│   └── Section.tsx           # ← this file (PageHeader, Section, VariantGrid, Preview, CodeBlock)
├── foundations/page.tsx
├── buttons/page.tsx
├── display/page.tsx
├── forms/page.tsx
├── feedback/page.tsx
└── anti-patterns/page.tsx
```

`Section.tsx` goes in `_components/` — the underscore prefix tells Next.js
App Router to skip creating a route segment for it, so the shared authoring
primitives live next to the pages that consume them without becoming a
`/dev/components/_components` URL. `GalleryNav.tsx` goes one level up, next
to `layout.tsx`.

`layout.tsx` and `page.tsx` are not part of this seed — they're thin,
project-specific shell code (the sidebar frame, the overview grid) that a
project authors itself once it has category pages to link to.

## Adding a section

A category page is `PageHeader` once, then one or more `Section`s, each
holding a `VariantGrid` of `Preview`s and a trailing `CodeBlock`:

```tsx
// src/app/(main)/dev/components/display/page.tsx (excerpt)
'use client'

import { Badge } from '@/src/components/ui/badge'
import { PageHeader, Section, VariantGrid, Preview, CodeBlock } from '../_components/Section'

export default function DisplayPage() {
  return (
    <>
      <PageHeader title="Display" description="Cards, chips, and data-display composites." />
      <Section title="Badge" description="Status and label chip.">
        <VariantGrid columns={4}>
          <Preview label="success"><Badge variant="success">Active</Badge></Preview>
          <Preview label="warning"><Badge variant="warning">Degraded</Badge></Preview>
          <Preview label="error"><Badge variant="error">Failed</Badge></Preview>
          <Preview label="outline"><Badge variant="outline">Draft</Badge></Preview>
        </VariantGrid>
        <CodeBlock code={`<Badge variant="success">Active</Badge>`} />
      </Section>
    </>
  )
}
```

Then register it so it's discoverable, not just present:

1. Add the route to the sidebar `sections` array in `GalleryNav.tsx`.
2. Add the component, its variants, and any new tokens to the `components`
   / `variants` / `tokens` search-index arrays in the same file, so Cmd-K
   surfaces it.
3. Add the category to the overview grid in the project's `page.tsx`.

A category page category is only "done" once you've opened the route and
watched it render — a broken token or a missing provider shows up as a
visibly broken preview, which is the entire point of building the gallery
inside the real app shell instead of an isolated tool.

## Scoping rule

**Showcase the branded layer, tokens, and composite patterns — never
re-document vanilla shadcn.** A page for a component that is pure,
unmodified shadcn with no project-specific variant, token wiring, or
composition adds nothing a contributor couldn't get from the shadcn docs,
and it's the fastest way for the gallery to accumulate pages nobody keeps in
sync.

Before adding a section, ask: what did *this project* add on top of the
primitive? If the answer is "nothing," the section doesn't belong here.
Good candidates:

- A primitive wired to project tokens (a `Button` whose `primary` variant
  resolves through `--primary`, not a generic shadcn default).
- A composite built from two or more primitives (a `StatusBadge` that maps a
  status enum onto `Badge`).
- A pattern demonstrating a token contract (`foundations/page.tsx` rendering
  every `--status-*` / `--metric-*` swatch live).

The `anti-patterns` category is the one exception to the `Section` +
`VariantGrid` + `Preview` shape: each `Section` there holds a BAD/GOOD pair
backed by an actual lint rule, not a live component render. Keep it wired to
the real ESLint config — an anti-pattern the linter no longer catches is
worse than no anti-patterns page at all.
