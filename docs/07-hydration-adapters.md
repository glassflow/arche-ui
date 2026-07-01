# Hydration adapters

## What & why

A saved dashboard config comes back from the backend as a JSON blob whose
shape depends on *when* it was written — a dashboard saved eight months ago
is a v1 payload, one saved yesterday is v2, and both need to open in the
same edit form today. Hydration is the pipeline that turns that blob into
live store state (and, from there, form defaults) without every component,
slice, and form downstream having to know which wire version it received.

Two concerns get tangled if they're not kept separate, so this doc keeps
them in two different layers:

1. **Version drift** — the backend's payload shape changes over time
   (a field renamed, a nested object flattened, a new required key added).
   This is absorbed once, by a **version adapter**, before hydration ever
   starts.
2. **Fan-out into slices** — a dashboard config touches multiple slices
   (layout, widgets, filters, ...). Each slice needs its own mapping logic
   from the canonical config shape into that slice's fields. This is a
   **section hydrator**, one per slice, and it never sees a raw v1 or v2
   payload — only the adapter's already-normalized output.

Splitting it this way means a new wire version is a new adapter file, not a
sweep through every hydrator and every slice looking for version checks.
And a new slice is a new hydrator function, not a change to the adapter.

## The shape

```
Backend config          (raw JSON, e.g. { schemaVersion: 1, panels: [...] })
    │
    ▼
Version adapter         src/adapters/version/dashboard/
    │  normalize(rawConfig): DashboardConfigForHydration
    │  owns ALL v1 → v2 → canonical branching; nothing downstream checks a version
    ▼
coreStore.hydrateFromConfig(config)   — single entry point, calls hydrateSection('all', config)
    │
    ├──▶ hydrateSection('layout', config)   → src/store/hydration/layout.ts   → layoutStore
    └──▶ hydrateSection('widgets', config)  → src/store/hydration/widgets.ts  → widgetsStore
    │
    ▼
Store slices             layoutStore, widgetsStore  (canonical, typed, UI-facing)
    │
    ▼
Form defaults            Manager reads the slice, seeds useForm()  — see ./06-forms-zod-manager-renderer.md
```

Three moving pieces, each with exactly one job:

- **Version adapter** (`src/adapters/version/<domain>/`) — a small set of
  functions keyed by wire version, plus a factory that picks the right one
  for the payload it's handed. Its output type is the canonical
  `*ConfigForHydration` shape — the *only* shape anything past this point is
  allowed to assume. Nothing downstream ever branches on `schemaVersion`
  again.
- **Section hydrator** (`src/store/hydration/*.ts`) — one function per
  slice (or per closely related pair of slices). Takes the canonical config
  and calls that slice's own setter(s) — never another slice's setter, and
  never a raw backend field name the adapter hasn't already normalized.
- **`coreStore.hydrateFromConfig` / `hydrateSection`** — the orchestrator.
  `hydrateFromConfig` sets the top-level identity fields (id, name, version)
  and then delegates to `hydrateSection('all', config)`, which switches over
  every known section and calls its hydrator. `hydrateSection(section,
  config)` alone lets a caller re-hydrate *one* section — the case that
  matters most is a user hitting "discard" on one form panel, which should
  restore just that panel's slice from the last-saved config, not force a
  full-page reload.

## Build it

Worked example: a **dashboard config** that a backend has shipped in two
wire shapes. v1 stores panel layout as a flat `x`/`y`/`w`/`h` per panel; v2
groups the same fields under `layout: { x, y, w, h }` and adds a `title`
field the UI needs. Both versions are hydrated into the same two slices:
`layoutStore` (panel positions) and `widgetsStore` (panel content/config).

**1. The version adapter — normalizes v1 and v2 into one canonical shape.**

```ts
// src/adapters/version/dashboard/types.ts
export interface DashboardConfigForHydration {
  dashboardId: string
  name: string
  panels: Array<{
    id: string
    title: string
    layout: { x: number; y: number; w: number; h: number }
    widget: { type: string; query: string }
  }>
}

// src/adapters/version/dashboard/index.ts
import { DashboardConfigForHydration } from './types'

interface RawDashboardConfigV1 {
  schemaVersion: 1
  id: string
  name: string
  panels: Array<{
    id: string
    x: number; y: number; w: number; h: number
    widgetType: string
    query: string
  }>
}

interface RawDashboardConfigV2 {
  schemaVersion: 2
  id: string
  name: string
  panels: Array<{
    id: string
    title: string
    layout: { x: number; y: number; w: number; h: number }
    widget: { type: string; query: string }
  }>
}

type RawDashboardConfig = RawDashboardConfigV1 | RawDashboardConfigV2

/**
 * Normalizes any known wire version of a dashboard config into the
 * canonical shape hydration functions consume. This is the ONLY place
 * that is allowed to branch on `schemaVersion`.
 */
export function normalizeDashboardConfig(raw: RawDashboardConfig): DashboardConfigForHydration {
  if (raw.schemaVersion === 1) {
    return {
      dashboardId: raw.id,
      name: raw.name,
      panels: raw.panels.map((p) => ({
        id: p.id,
        title: p.widgetType, // v1 had no title field — fall back to widget type
        layout: { x: p.x, y: p.y, w: p.w, h: p.h },
        widget: { type: p.widgetType, query: p.query },
      })),
    }
  }
  // v2 already matches the canonical shape field-for-field.
  return {
    dashboardId: raw.id,
    name: raw.name,
    panels: raw.panels.map((p) => ({
      id: p.id,
      title: p.title,
      layout: { ...p.layout },
      widget: { ...p.widget },
    })),
  }
}
```

**2. One section hydrator — maps the canonical config into `layoutStore`.**

```ts
// src/store/hydration/layout.ts
import { useStore } from '../index'
import { DashboardConfigForHydration } from '@/src/adapters/version/dashboard/types'

export function hydrateLayout(config: DashboardConfigForHydration) {
  const panelLayouts = config.panels.map((p) => ({
    panelId: p.id,
    x: p.layout.x,
    y: p.layout.y,
    w: p.layout.w,
    h: p.layout.h,
  }))
  useStore.getState().layoutStore.setPanelLayouts(panelLayouts)
}
```

A second hydrator, `hydrateWidgets(config)`, follows the same shape and
writes `panels.map(p => ({ id, title, type: p.widget.type, query: p.widget.query }))`
into `widgetsStore` — never into `layoutStore`. Each hydrator only ever
calls `set` on the one slice it owns, same as any other slice write (see
[`./05-zustand-slice-store.md`](./05-zustand-slice-store.md)).

**3. The orchestrator wires both hydrators behind one entry point.**

```ts
// src/store/core.ts
hydrateSection: async (section: string, config: DashboardConfigForHydration) => {
  try {
    switch (section) {
      case 'layout':
        hydrateLayout(config)
        break
      case 'widgets':
        hydrateWidgets(config)
        break
      case 'all':
        hydrateLayout(config)
        hydrateWidgets(config)
        break
      default:
        logger.warn('Unknown section for hydration', { section })
    }
  } catch (error) {
    logger.error('Hydration failed for section', { section, error })
    // Mark the affected slice invalidated rather than leaving it half-written.
    useStore.getState().layoutStore.markAsInvalidated('hydration-failed')
    throw error
  }
},

hydrateFromConfig: async (config: DashboardConfigForHydration) => {
  set((state) => ({
    coreStore: {
      ...state.coreStore,
      dashboardId: config.dashboardId,
      name: config.name,
    },
  }))
  await get().coreStore.hydrateSection('all', config)
},
```

A caller loading a saved dashboard does two steps: adapt, then hydrate.

```ts
const raw = await fetchDashboardConfig(dashboardId) // RawDashboardConfig, unknown version
const config = normalizeDashboardConfig(raw)         // DashboardConfigForHydration
await coreStore.hydrateFromConfig(config)
```

A "discard changes on the layout panel" button only needs the second step,
scoped to one section, from whatever config was last saved:

```ts
await coreStore.hydrateSection('layout', lastSavedConfig)
```

## Rules & gotchas

- **Always hydrate through `coreStore.hydrateFromConfig` /
  `hydrateSection` — never write a slice directly from a fetched config.**
  Nothing at the type level stops `layoutStore.setPanelLayouts(rawPanels)`
  from being called with backend-shaped data, but doing so reintroduces the
  version coupling this whole pattern exists to remove: the moment one call
  site skips the adapter, that site now silently breaks on the next wire
  version change. Route every load through the two entry points, full stop.
- **Adapters own all version branching — hydrators never check a version
  field.** If a hydrator needs `if (config.schemaVersion === 1)`, the
  version adapter didn't fully normalize the payload. Fix the adapter, not
  the hydrator.
- **`hydrateSection` exists for partial re-hydration, not just for
  `hydrateFromConfig` to call internally.** The main use case is discard:
  a user edits the widgets panel, decides to bail, and the form should
  reset to `lastSavedConfig` without touching the layout panel's in-progress
  edits. Call `hydrateSection('widgets', lastSavedConfig)`, not a full
  `hydrateFromConfig` that would stomp on unrelated sections.
- **On a hydration error, mark the affected section invalidated — don't
  leave it half-written.** A hydrator that throws partway through (e.g. a
  malformed `widget.query`) can leave a slice with some fields updated and
  others stale. Catch at the orchestrator, call that slice's
  `markAsInvalidated(...)`, and rethrow so the caller (a page load, a form
  submit-then-reload) knows hydration didn't fully succeed instead of
  silently rendering partial state.
- **A section hydrator only calls `set` on the one slice it owns.** Same
  rule as any other slice write — see
  [`./05-zustand-slice-store.md`](./05-zustand-slice-store.md#rules--gotchas).
  If hydrating widgets needs to know something about layout, that's cross-
  slice orchestration and belongs in `hydrateSection`'s `'all'` case, not
  inside `hydrateWidgets`.
- **The canonical `*ConfigForHydration` type is the contract between the
  adapter and every hydrator.** Add a field to a wire version without adding
  it to the canonical type and to every adapter branch, and it silently
  never reaches the store — TypeScript won't catch a missing mapping inside
  an adapter function body the way it catches a missing interface field.
- **Form defaults come from the hydrated slice, never from the raw fetch
  response.** A Manager's `defaultValues` reads `layoutStore`/`widgetsStore`
  after hydration, not the `raw` object returned by the fetch — see
  [`./06-forms-zod-manager-renderer.md`](./06-forms-zod-manager-renderer.md)
  for why defaults are sourced from the store layer, not inlined per call
  site.

## Source lineage

- glassflow-etl-ui/src/store/hydration/clickhouse-connection.ts
- glassflow-etl-ui/src/store/hydration/kafka-connection.ts
- glassflow-etl-ui/src/store/core.ts
- glassflow-etl-ui/src/types/pipeline.ts
- glassflow-etl-ui/src/modules/pipeline-adapters/types.ts
- glassflow-etl-ui/src/modules/pipeline-adapters/factory.ts
- glassflow-etl-ui/src/modules/pipeline-adapters/v1.ts
