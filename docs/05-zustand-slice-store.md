# Zustand slice store

## What & why

The app has one global store, but no single file owns all of it. Each feature —
services, traces, filters, alerts — gets its own **slice**: a typed chunk of state
plus the actions that mutate it, built by a factory function and merged into one
root store at composition time. `useStore()` returns the whole tree, but a
component only ever reads and calls actions on the slice it cares about
(`useStore((s) => s.filtersStore)`), so slices stay independently testable and a
new feature never requires touching the internals of an existing one.

This exists because a single flat store — one big `create<AppState>()` with every
field and every setter inlined — degrades the moment a second feature shows up.
Every contributor edits the same file, unrelated state gets tangled by proximity
("while I'm here, filters can just read traces' state directly"), and there is no
natural place to put a feature's reset logic, so resets get skipped or
half-written per feature. Slices fix this by giving every feature exactly one
file, one factory function, one interface, and one place to register its reset —
so the store scales by adding files, not by growing one file forever.

The second reason is orchestration versus ownership. A slice owns its own state
completely — it is the only code that calls `set()` on its own keys — but it
never reaches into another slice's state to mutate it directly. Cross-slice
concerns (does changing the selected service invalidate an in-flight query? does
switching time windows reset a slice's staleness flag?) are real and do happen,
but they belong in a core/orchestrator slice that reads multiple slices and calls
*their* actions — never in ad-hoc cross-slice writes buried inside an unrelated
slice's factory.

## The shape

```
Slice factory           src/store/filters.store.ts
    │  createFiltersSlice: StateCreator<FiltersSlice>
    │  owns: FiltersStore state + actions, all writes scoped to `filtersStore` key
    ▼
Root Store interface    src/store/index.ts
    │  interface Store extends FiltersSlice, TracesSlice, CoreSlice, ... { ... }
    ▼
Store composition       src/store/index.ts
    │  create<Store>()(devtools(subscribeWithSelector((set, get, store) => ({
    │    ...createFiltersSlice(set, get, store),
    │    ...createTracesSlice(set, get, store),
    │    ...createCoreSlice(set, get, store),
    │    resetAllState: (...) => { /* calls every slice's own reset action */ },
    │  }))))
    ▼
useStore()               exported hook — components read via useStore(s => s.filtersStore)
```

Every slice in `src/store/*.store.ts` follows the same four-part shape:

- **A `*StoreProps` interface** — the plain-data fields (no functions). This is
  what gets serialized to devtools and what a reset restores.
- **A `*Store` interface extending `*StoreProps`** — adds the action methods
  (`setX`, `resetXStore`, etc.) that operate on this slice only.
- **A `*Slice` interface** — `{ xStore: XStore }`. This is the single key this
  slice contributes to the root `Store`, and the only thing other slices are
  allowed to see of it (read-only, via `get()`, never written).
- **A `createXSlice: StateCreator<XSlice>` factory** — takes Zustand's
  `(set, get, store)` and returns `{ xStore: { ...initialState, ...actions } }`.
  This is the only place `xStore`'s keys are ever assigned.

The root store in `src/store/index.ts` does three things: declares one `Store`
interface that extends every slice interface, spreads every `createXSlice(set,
get, store)` call inside a single `create<Store>()(...)`, and wraps the whole
thing in `devtools(subscribeWithSelector(...))` — devtools for time-travel
debugging in dev, `subscribeWithSelector` so callers can subscribe to one slim
slice of state instead of re-rendering on every root change.

## Build it

Worked example: a `filtersSlice` holding the currently selected service and the
active time window — the two filters that scope every query on an observability
dashboard.

1. **Define the slice's state and actions, then the four interfaces.** State is
   plain data; actions are the only way to change it.

   ```ts
   // src/store/filters.store.ts
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
   ```

2. **Write the factory.** Every action is a `set()` call scoped to the
   `filtersStore` key — never a bare `set({ selectedService })`, which would blow
   away every other slice's state on the next render read.

   ```ts
   // src/store/filters.store.ts (continued)
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

3. **Extend the root `Store` interface and compose the factory.** `index.ts` is
   the only file that imports every slice; a slice never imports a sibling slice.

   ```ts
   // src/store/index.ts
   import { create } from 'zustand'
   import { devtools, subscribeWithSelector } from 'zustand/middleware'
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

4. **Register the slice in the global reset orchestrator.** `resetAllState`
   above is the orchestrator itself for a small store; on a larger store it may
   live in the core slice instead (see `coreStore.resetAllPipelineState` in the
   lineage). Either way, adding `filtersStore.resetFiltersStore()` to that one
   call site is the only wiring a new slice needs to participate in a full reset
   — skip this step and `filtersSlice` silently survives a "clear everything"
   action while every other slice clears.

5. **Read and write from a component.**

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

## Rules & gotchas

- **Access state through `useStore()`, never by importing a slice's factory
  into a component.** `createFiltersSlice` is composition-time plumbing; a
  component wants the live `filtersStore` off the root hook, with
  `subscribeWithSelector` narrowing re-renders to the slice it selects.
- **Register every slice in the global reset.** A slice that owns a
  `resetXStore()` action but isn't called from the orchestrator (`resetAllState`,
  or the core slice's reset method in a larger store) will retain stale state
  across a "new session" / "clear all" action while everything else resets —
  a bug that only shows up as "why is the old service still selected."
- **Slices don't write to each other.** A slice may *read* another slice via
  `get()` inside its own actions (the core slice's mode-orchestration logic does
  this), but it never calls `set()` on a key it doesn't own. If selecting a new
  service needs to invalidate cached trace data, that orchestration is a core
  (or dedicated orchestrator) slice action that calls `tracesStore.invalidate()`
  — it is not a line inside `filtersSlice` that reaches into `tracesStore`
  directly.
- **One key per slice on the root `Store`.** `filtersSlice` contributes exactly
  `filtersStore`; it never adds top-level fields directly to `Store`. This is
  what keeps `useStore((s) => s.filtersStore)` a stable, narrow selector.
- **`set()` calls are always scoped to the slice's own key.** `set((state) => ({
  filtersStore: { ...state.filtersStore, ... } }))` — never `set({ selectedService
  })`, which replaces the entire root state object with just that one field and
  drops every other slice.
- **Hydrating a slice from a loaded config is a separate concern from the slice
  itself.** A slice's factory only knows its own initial state and actions; how
  a persisted or server-provided config gets mapped into that shape on load is
  covered in [`./07-hydration-adapters.md`](./07-hydration-adapters.md) — don't
  duplicate hydration logic inside the slice factory.
- **Devtools names and trace flags are opt-in for dev only.** `enabled:
  process.env.NODE_ENV !== 'production'` on the `devtools` middleware keeps the
  Redux DevTools connection out of production bundles; don't hardcode `true`.

## Source lineage

- glassflow-etl-ui/src/store/index.ts
- glassflow-etl-ui/src/store/core.ts
- glassflow-etl-ui/src/store/filter.store.ts
- glassflow-etl-ui/.cursor/architecture/STATE_MANAGEMENT.md
