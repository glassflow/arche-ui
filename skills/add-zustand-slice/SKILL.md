---
name: add-zustand-slice
description: Use when adding a new Zustand feature slice — creates the slice factory, composes it into the root store, registers it in the global reset, and wires an optional hydration hook.
---

# Add a Zustand slice

Add a new feature's state the same way every other slice in the pack is built: one
factory function owning one key on the root store, composed in `store/index.ts`,
registered in the global reset, and — if the feature loads from a backend config —
hydrated through the standard adapter/hydrator pipeline instead of a bespoke
mapping. Background and rules live in
[`../../docs/05-zustand-slice-store.md`](../../docs/05-zustand-slice-store.md) (and
[`../../docs/07-hydration-adapters.md`](../../docs/07-hydration-adapters.md) for step
4) — this file is the procedure, not the rationale.

## When to use this

You're adding state for a feature that doesn't fit inside an existing slice's
key — a new page, panel, or cross-cutting concern (filters, selection, a new
domain object) that needs its own reset lifecycle. If the state belongs inside an
existing slice's responsibility (e.g. one more field on `filtersStore`), just add
the field and its setter to that slice's existing factory instead of starting a
new one.

## Procedure

1. **Create the slice factory.**
   File: `store/<feature>.store.ts` (new file).
   Define the four-part shape from the reference doc: a `<Feature>StoreProps`
   interface (plain data only), a `<Feature>Store` interface extending it (adds
   action methods, including `reset<Feature>Store`), a `<Feature>Slice` interface
   (`{ <feature>Store: <Feature>Store }` — the single key this slice contributes),
   and `createXSlice: StateCreator<<Feature>Slice>` — actually named
   `create<Feature>Slice` — that returns `{ <feature>Store: { ...initialState,
   ...actions } }`. Every action's `set()` call is scoped to `<feature>Store`
   (`set((state) => ({ <feature>Store: { ...state.<feature>Store, ... } }))`) —
   never a bare `set({ someField })`, which drops every other slice's state.

2. **Extend the `Store` interface and compose the factory.**
   File: `store/index.ts`.
   Add `<Feature>Slice` to the `interface Store extends ...` list, import
   `create<Feature>Slice` from the new file, and add
   `...create<Feature>Slice(set, get, store)` inside the `create<Store>()(devtools(subscribeWithSelector((set, get, store) => ({ ... }))))`
   call alongside every other slice's spread. `store/index.ts` is the only file
   that imports every slice; the new slice file never imports a sibling slice.

3. **Register the slice's reset in the global reset orchestrator.**
   File: `store/index.ts` (the `resetAllState` function), or the core slice's
   reset method (e.g. `coreStore.resetAllPipelineState`) on a larger store.
   Add `state.<feature>Store.reset<Feature>Store()` to that one call site. Skip
   this and the new slice silently survives a "clear everything" action while
   every other slice resets — the bug shows up later as stale state that
   shouldn't have survived a reset.

4. **Add a hydration function if the slice loads from a backend config.**
   File: `store/hydration/<feature>.ts` (new file), wired into
   `coreStore.hydrateSection`'s switch statement in `store/core.ts` (or
   equivalent orchestrator).
   Skip this step entirely if the slice is populated only by user interaction
   (e.g. a pure UI-state slice like filters or selection) — not every slice needs
   a hydrator. If it does load from a saved/backend config, follow
   [`../../docs/07-hydration-adapters.md`](../../docs/07-hydration-adapters.md):
   write a `hydrate<Feature>(config)` function that takes the already-normalized
   canonical config shape (never a raw versioned payload — that branching belongs
   in a version adapter, not here) and calls only this slice's own setter(s).
   Add a `case '<feature>':` to `hydrateSection`'s switch and to its `'all'`
   branch.

5. **Verify via devtools.**
   Run the dev server, open Redux DevTools, and confirm the new `<feature>Store`
   key appears in the state tree under the store's devtools name. Dispatch each
   new action from a component or the console and confirm only `<feature>Store`
   changes in the diff — not a sibling slice. Then trigger whatever the app's
   "reset everything" action is (e.g. starting a new session/pipeline) and
   confirm `<feature>Store` snaps back to its initial state alongside every other
   slice.

## Worked example: `filtersSlice`

An observability dashboard's filter bar needs the currently selected service and
the active time window — two fields every query on the page needs to read.

**1. The factory:**

```ts
// store/filters.store.ts
import { StateCreator } from 'zustand'

export type TimeWindow = '15m' | '1h' | '6h' | '24h' | '7d'

interface FiltersStoreProps {
  selectedService: string | null // null = "all services"
  timeWindow: TimeWindow
}

interface FiltersStore extends FiltersStoreProps {
  setSelectedService: (service: string | null) => void
  setTimeWindow: (window: TimeWindow) => void
  resetFiltersStore: () => void
}

export interface FiltersSlice {
  filtersStore: FiltersStore
}

const initialFiltersStore: FiltersStoreProps = {
  selectedService: null,
  timeWindow: '1h',
}

export const createFiltersSlice: StateCreator<FiltersSlice> = (set) => ({
  filtersStore: {
    ...initialFiltersStore,

    setSelectedService: (service) =>
      set((state) => ({
        filtersStore: { ...state.filtersStore, selectedService: service },
      })),

    setTimeWindow: (window) =>
      set((state) => ({
        filtersStore: { ...state.filtersStore, timeWindow: window },
      })),

    resetFiltersStore: () =>
      set((state) => ({
        filtersStore: { ...state.filtersStore, ...initialFiltersStore },
      })),
  },
})
```

**2. Compose it into the root store:**

```ts
// store/index.ts
import { createFiltersSlice, FiltersSlice } from './filters.store'
import { createTracesSlice, TracesSlice } from './traces.store'
import { createCoreSlice, CoreSlice } from './core'

interface Store extends FiltersSlice, TracesSlice, CoreSlice {
  resetAllState: () => void
}

export const useStore = create<Store>()(
  devtools(
    subscribeWithSelector((set, get, store) => ({
      ...createFiltersSlice(set, get, store),
      ...createTracesSlice(set, get, store),
      ...createCoreSlice(set, get, store),

      resetAllState: () => {
        const state = get()
        state.filtersStore.resetFiltersStore()
        state.tracesStore.resetTracesStore()
        state.coreStore.resetCoreStore()
      },
    })),
    { name: 'app-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
)
```

**3. Reset registration is the `state.filtersStore.resetFiltersStore()` line
inside `resetAllState` above** — no separate file, just the one call site.

**4. Hydration (optional, skip if not backend-loaded):** a dashboard-level
filter default saved server-side would get a `hydrateFilters(config)` in
`store/hydration/filters.ts` that calls `setSelectedService` /
`setTimeWindow`, wired into `hydrateSection`'s switch — see
[`../../docs/07-hydration-adapters.md`](../../docs/07-hydration-adapters.md) for
the full adapter-then-hydrator shape. A pure client-side filter bar with no
saved default skips this step.

**5. Verify:** open DevTools, confirm `filtersStore` shows up with
`selectedService: null` and `timeWindow: '1h'`, call `setTimeWindow('6h')` from
a component and confirm only `filtersStore.timeWindow` changes in the DevTools
diff, then trigger the app's reset action and confirm it snaps back to `'1h'`.

**6. Read/write from a component:**

```tsx
function TimeWindowPicker() {
  const { timeWindow, setTimeWindow } = useStore((s) => s.filtersStore)
  return (
    <select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}>
      <option value="15m">15m</option>
      <option value="1h">1h</option>
      <option value="6h">6h</option>
      <option value="24h">24h</option>
      <option value="7d">7d</option>
    </select>
  )
}
```

## Rules carried over from the reference docs

- Access state through `useStore()` in components — never import a slice
  factory outside `store/index.ts`.
- A slice never calls `set()` on a key it doesn't own; cross-slice
  orchestration (does selecting a new service invalidate cached data?) lives in
  a core/orchestrator slice that calls the other slice's own actions.
- One key per slice on the root `Store` — a slice contributes exactly
  `<feature>Store`, never top-level fields directly on `Store`.
- Hydration is a separate concern from the slice factory itself — a slice's
  factory only knows its own initial state and actions, never a raw backend
  payload shape or a `schemaVersion` check.
