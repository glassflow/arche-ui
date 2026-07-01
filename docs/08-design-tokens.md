# Design tokens

## What & why

Every color, radius, and shadow in the app is a CSS variable, never a literal
value. That single rule is what makes a Figma sync possible: the design tool
and the codebase both point at the same set of names, so a designer changing
a color in Figma and an engineer changing a color in CSS are editing the same
contract instead of two things that happen to look similar today and drift
apart next sprint.

The reason this needs two layers, not one big flat list, is that two
different audiences read these tokens for two different reasons:

1. **shadcn/ui components** (`Button`, `Card`, `Dialog`, `Input`, ...) ship
   already wired to a fixed set of ~25 variable names — `--background`,
   `--primary`, `--border`, and so on. Renaming or skipping one of these
   breaks a primitive's built-in styling, so this layer is closed: don't add
   to it, don't rename it, just fill in values.
2. **Everything the vanilla shadcn set doesn't cover** — surface elevation
   (which gray is "raised" vs "base"?), domain status (is a trace span
   `error`, `warning`, or `ok`?), metric polarity (is this delta good or
   bad?) — needs its own vocabulary. This is the semantic layer, and it's
   open: when a new UI concept shows up that no existing token names, add
   one here.

Both layers resolve, at the bottom, to raw HSL primitives — a handful of
named color scales (grays, brand accent, status colors) that nothing outside
`base.css` ever references directly. A component never asks for "the gray
that is HSL `240 3.7% 46.1%`"; it asks for `--muted-foreground`, and the
primitive underneath can move without the component ever knowing.

The payoff: a hardcoded `#e22c2c` in a component is a value that exists in
exactly one place and silently disagrees with Figma the moment either side
changes. A `hsl(var(--status-error))` is a *reference* — change the primitive
once, in one file, and every consumer (React components, Tailwind classes,
the Figma variable collection) updates together.

## The shape

```
base.css                    theme.css                        Component
(raw HSL primitives)        (semantic references)

--zinc-950: 240 10% 3.9%          │
--red-500:  0 84.2% 60.2%   ──▶   --background: var(--zinc-950)   ──▶  className="bg-background"
--orange-400: ...                --status-error: var(--red-500)  ──▶  style={{ color: 'hsl(var(--status-error))' }}
                             │
                             ▼
                    Layer 1 — shadcn canonical (~25 tokens)
                    --background, --foreground, --card, --popover,
                    --primary, --secondary, --muted, --accent,
                    --destructive, --border, --input, --ring, --radius,
                    --chart-1…5, --sidebar-*
                             │
                             ▼
                    Layer 2 — semantic (open, extend as needed)
                    Surface elevation: --surface-base, --surface-raised,
                                        --surface-overlay
                    Status:            --status-running, --status-stopped,
                                        --status-error, --status-warning,
                                        --status-degraded
                    Metrics:           --metric-positive, --metric-negative,
                                        --metric-neutral
```

**File map:**

| File | Owns | Rule |
|---|---|---|
| `src/themes/base.css` | Raw HSL primitives (color scales, typography scale, spacing, radius, shadows, z-index). No `hsl()` wrapper — bare tuples, shadcn convention, so consumers can compose opacity with `hsl(var(--x) / 0.1)`. | Never imported by components directly. |
| `src/themes/theme.css` | Layer 1 (shadcn canonical) + Layer 2 (semantic). Both scoped to `:root, [data-theme='dark']` — see Rules & gotchas on dark-only. | The *only* file components reference. |
| `src/app/styles/typography.css` | `.title-1`…`.title-6`, `.body-1`…`.body-3`, `.caption-1`…`.caption-2`, `.featured-1`…`.featured-3` utility classes, built from the `--font-size-*` / `--line-height-*` / `--letter-spacing-*` primitives in `base.css`. | Use the class, never assemble the underlying vars by hand in a component. |

**Layer 1 — shadcn canonical (~25 tokens).** Fixed set consumed by every
shadcn primitive: `--background`, `--foreground`, `--card` /
`--card-foreground`, `--popover` / `--popover-foreground`, `--primary` /
`--primary-foreground`, `--secondary` / `--secondary-foreground`, `--muted`
/ `--muted-foreground`, `--accent` / `--accent-foreground`, `--destructive`
/ `--destructive-foreground`, `--border`, `--input`, `--ring`, `--radius`,
the chart palette (`--chart-1`…`--chart-5`), and the sidebar set
(`--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, ...). Each of
these is assigned a primitive from `base.css` in `theme.css` — for example
`--background: var(--zinc-950);` — and every shadcn component reads the
canonical name, never the primitive.

**Layer 2 — semantic (surface elevation, status, metrics).** Tokens for
concepts the canonical set doesn't name:

```css
/* Surface elevation — three steps of "how lifted off the page" */
--surface-base:    var(--zinc-950);  /* page background */
--surface-raised:  var(--zinc-900);  /* cards, panels */
--surface-overlay: var(--zinc-800);  /* modals, popovers, floating UI */

/* Status — domain state, not raw color */
--status-running:  var(--green-400);
--status-stopped:  var(--zinc-400);  /* intentional stop, not failure */
--status-error:    var(--red-500);
--status-warning:  var(--amber-300);
--status-degraded: var(--orange-400);

/* Metrics — polarity of a delta, not a fixed hue */
--metric-positive: var(--green-400);
--metric-negative: var(--red-500);
--metric-neutral:  var(--zinc-400);
```

This layer is intentionally small and named by *meaning*, not by color.
`--status-error` reads as "this thing failed" everywhere it's used; if the
brand palette changes red for something else later, every consumer updates
by editing one line in `theme.css`, and no component needs to know a color
name changed at all.

**Typography utility classes** wrap the `base.css` type scale so components
never assemble `font-size` + `line-height` + `font-family` + `letter-spacing`
by hand:

```tsx
<h1 className="title-1">Trace detail</h1>
<p className="body-2 text-muted-foreground">42 spans, 3 errors</p>
<span className="caption-1">span_id: 8f3a2c</span>
```

**Figma sync** closes the loop: the same token names live as Figma
Variables, so a designer picks `status-error` from a dropdown in Figma and
an engineer writes `hsl(var(--status-error))` in code — same name, same
value, checked by a sync script rather than by two people remembering to
agree.

## Build it

Worked example: an AI-observability trace viewer needs to color a span red
when it errored. There's no existing token for "errored trace span" — the
closest is the generic `--status-error`, but spans are a domain concept with
their own visual language (a filled bar in a waterfall chart), so it gets
its own semantic token rather than overloading the generic status token.
Three edits, in order.

**1. Add the primitive to `base.css`.** If an existing color scale already
has the right hue, reuse it — reach for a new primitive only when nothing
fits. Here, the app's `--red-500` primitive is already the right red for
"error" everywhere else, so no new primitive is strictly required — but to
show the full three-edit path, assume this trace UI wants a slightly
different, more saturated red reserved for span bars specifically, distinct
from the generic destructive/error red used on buttons and toasts:

```css
/* src/themes/base.css, inside :root, in the Red scale block */
--red-400: 0 90.6% 70.8%;
--red-500: 0 84.2% 60.2%;
--red-600: 0 72.2% 50.6%;
--red-700: 0 74% 42%;
--span-error-red: 355 78% 56%;   /* new: dedicated span-bar red */
```

**2. Add the semantic reference in `theme.css`.** This is the name
components will actually use — it lives in the Layer 2 block, grouped with
other trace/observability tokens, and points at the primitive from step 1:

```css
/* src/themes/theme.css, inside :root, [data-theme='dark'], Layer 2 block */
--trace-span-error: var(--span-error-red);
```

**3. Consume it with `hsl(var(...))`.** Never the primitive, never a literal
hex — always the semantic name, wrapped in `hsl()` because both layers store
bare HSL tuples:

```tsx
// Waterfall bar for a span that errored
<div
  className="h-4 rounded-sm"
  style={{ backgroundColor: 'hsl(var(--trace-span-error))' }}
/>

// Or as an arbitrary Tailwind value, same token, same rule
<div className="h-4 rounded-sm bg-[hsl(var(--trace-span-error))]" />
```

That's the whole pattern for any new semantic concept: primitive in
`base.css` → semantic name in `theme.css` → `hsl(var(--name))` at the call
site. Nothing else in the codebase needs to change, and the new name is
immediately available to the Figma sync script the next time it runs.

## Rules & gotchas

- **No hardcoded hex, `rgba()`, or raw Tailwind color utilities.** Not
  `style={{ color: '#e22c2c' }}`, not `style={{ backgroundColor: 'rgba(226, 44, 44, 0.1)' }}`,
  not `className="bg-red-500 text-gray-400 border-zinc-700"`. Any of these
  breaks the token contract: the value now lives in exactly one file and
  silently disagrees with Figma (and with every other place the "same"
  color is spelled out by hand) the moment either side changes. This is a
  **CI-enforced hard gate**, not a style suggestion — see
  [`./15-architectural-guardrails.md`](./15-architectural-guardrails.md) for
  the exact check and how it scans a diff.
- **Tailwind is for layout, spacing, and typography only** —
  `flex`, `gap-4`, `p-6`, `grid-cols-3`, `text-sm` are fine. Color and
  visual state route through tokens (`bg-background`, `text-muted-foreground`,
  or `bg-[hsl(var(--token))]` for a semantic name Tailwind's config doesn't
  know about) — never a raw Tailwind color scale utility.
- **Dark-only — there is no light theme branch.** `base.css` and `theme.css`
  both scope to `:root, [data-theme='dark']` and nothing branches on a light
  variant. Don't add a `[data-theme='light']` override block, and don't
  write a component that conditionally picks a color based on a light/dark
  check — there's only one theme, and every token already resolves for it.
- **Components read `theme.css` names, never `base.css` primitives.** A
  component reaching for `hsl(var(--zinc-900))` directly has skipped the
  semantic layer — the fix is either an existing `theme.css` token that
  already maps to that primitive, or a new semantic token added the same
  way as the worked example above. The primitive scale is allowed to
  change its underlying values without every component needing to change;
  that guarantee only holds if nothing outside `theme.css` names a
  primitive directly.
- **Extending Layer 1 (the shadcn canonical set) is the wrong move.**
  If a shadcn component needs a new visual state, it's very likely already
  expressible as a Layer 2 token consumed via `className`/`style` on the
  wrapper, or as a variant prop — not as a 26th canonical variable. Layer 1
  stays fixed at the shadcn contract; all new vocabulary goes in Layer 2.
- **Run the Figma sync after any token edit**, not just color edits —
  radius, spacing, and shadow changes matter too:
  ```bash
  FIGMA_ACCESS_TOKEN=... FIGMA_FILE_KEY=... pnpm sync-tokens
  ```
  Skipping this step means the codebase and the Figma file silently
  disagree until someone notices in a design review.

## Source lineage

glassflow-etl-ui/src/themes/base.css
glassflow-etl-ui/src/themes/theme.css
glassflow-etl-ui/src/app/styles/typography.css
glassflow-etl-ui/docs/architecture/DESIGN_SYSTEM.md
glassflow-etl-ui/docs/design/FIGMA_TOKEN_REFERENCE.md
