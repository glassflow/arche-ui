# Forms: Zod schema, config object, Manager/Renderer

## What & why

Every form in the app follows the same split: a Zod schema is the single
source of truth for shape and validation, a plain config object supplies
field metadata (labels, placeholders, options), a **Manager** component owns
form lifecycle (`useForm`, resolver, defaults, submit, discard), and a pure
**Renderer** component lays out fields over React Hook Form's `control`. No
component ever renders a field it also validates, and no component ever
validates a field it doesn't render.

This exists because forms are the place business logic and presentation
logic are most tempted to fuse — "just check `value.length` before rendering
the error" starts in a Renderer and, two forms later, every Renderer has its
own slightly different validation dialect that Zod never sees. Once that
happens, the schema stops being trustworthy: some invalid states are caught by
Zod, some by ad-hoc JSX conditionals, and nobody can tell which without
reading every field. Centralizing validation in the schema and rendering in
the Renderer keeps exactly one artifact answerable for "is this value valid"
and exactly one answerable for "how does this look."

The Manager/Renderer split solves a second, narrower problem: testability and
reuse. A Manager wires `useForm` to a specific submit path (create an alert
rule, edit one, autosave a draft) — that part legitimately differs per call
site. The Renderer never changes based on *why* the form is open; it only
needs a `control` object and it lays out the same fields whether the Manager
behind it is creating, editing, or read-only-viewing. That means a Renderer
can be reused across a create Manager and an edit Manager without
duplicating a single `<FormField>`.

## The shape

```
Zod schema              src/schemas/alert-rule.schema.ts
    │  alertRuleSchema = z.object({ ... })
    │  export type AlertRuleFormValues = z.infer<typeof alertRuleSchema>
    ▼
Field config             src/config/alert-rule-form-config.ts
    │  AlertRuleFormConfig.fields.threshold = { name, label, placeholder, type, ... }
    │  no validation logic — only what the Renderer needs to draw the field
    ▼
Manager                  src/modules/alerts/AlertRuleFormManager.tsx
    │  useForm<AlertRuleFormValues>({ resolver: zodResolver(alertRuleSchema), defaultValues, mode })
    │  owns: submit, discard, defaults (from store — see ./07-hydration-adapters.md)
    ▼
Renderer                 src/modules/alerts/AlertRuleFormRenderer.tsx
    │  ({ control }) => <FormField control={control} name="threshold" render={...} />
    │  pure: no useForm, no submit, no store access — only reads `control`
    ▼
Rendered <form>          Manager wraps Renderer + submit/discard buttons
```

Four artifacts, four responsibilities, one direction of dependency
(Renderer never imports the Manager; the schema and config never import
either):

- **Schema** (`src/schemas/*.schema.ts`) — the shape of the data and every
  rule it must satisfy. Types are inferred from it (`z.infer<...>`), never
  hand-written in parallel. If a value can be invalid, the schema is where
  that gets encoded, not a conditional in the Renderer.
- **Config** (`src/config/*-form-config.ts`) — a plain object keyed by field
  name, holding *only* what the Renderer needs to draw a field: `label`,
  `placeholder`, `type`, `options` for selects, `required` message text for
  UI display. The config never contains a validation rule the schema doesn't
  already enforce — it describes presentation, the schema decides validity.
- **Manager** — the only component that calls `useForm`. It builds the
  resolver from the schema, supplies `defaultValues` (sourced from the store,
  never inlined — see [`./07-hydration-adapters.md`](./07-hydration-adapters.md)),
  wraps children in `<FormProvider>` or passes `control` down explicitly, and
  owns `handleSubmit`, discard/reset, and read-only gating.
- **Renderer** — a function of `control` (and static config) to JSX. It
  renders `<FormField>` / `<FormItem>` / `<FormControl>` / `<FormMessage>`
  for each field and nothing else: no `useForm`, no submit handler, no store
  read, no side effects. Given the same `control` and config, it always
  renders the same tree.

## Build it

Worked example: an **alert rule** form — a threshold, a rolling time window,
and a severity — used identically for both "create rule" and "edit rule."

1. **Schema first.** Every constraint the form must enforce lives here, not
   in the Renderer.

   ```ts
   // src/schemas/alert-rule.schema.ts
   import { z } from 'zod'

   export const alertRuleSchema = z.object({
     name: z.string().min(1, 'Name is required'),
     metric: z.enum(['error_rate', 'latency_p99', 'token_cost']),
     threshold: z.coerce.number().positive('Threshold must be greater than 0'),
     window: z.enum(['5m', '15m', '1h', '24h']),
     severity: z.enum(['info', 'warning', 'critical']),
   })

   export type AlertRuleFormValues = z.infer<typeof alertRuleSchema>
   ```

2. **Config supplies field metadata.** Same field names as the schema, but
   the config only ever describes *how to draw* the field — labels, options,
   placeholders — never a validity rule.

   ```ts
   // src/config/alert-rule-form-config.ts
   export const AlertRuleFormConfig = {
     fields: {
       name: {
         name: 'name',
         label: 'Rule name',
         placeholder: 'e.g. High error rate on checkout-service',
         type: 'text',
       },
       metric: {
         name: 'metric',
         label: 'Metric',
         type: 'select',
         options: [
           { label: 'Error rate', value: 'error_rate' },
           { label: 'Latency (p99)', value: 'latency_p99' },
           { label: 'Token cost', value: 'token_cost' },
         ],
       },
       threshold: {
         name: 'threshold',
         label: 'Threshold',
         placeholder: 'e.g. 0.05',
         type: 'text',
       },
       window: {
         name: 'window',
         label: 'Rolling window',
         type: 'select',
         options: [
           { label: '5 minutes', value: '5m' },
           { label: '15 minutes', value: '15m' },
           { label: '1 hour', value: '1h' },
           { label: '24 hours', value: '24h' },
         ],
       },
       severity: {
         name: 'severity',
         label: 'Severity',
         type: 'select',
         options: [
           { label: 'Info', value: 'info' },
           { label: 'Warning', value: 'warning' },
           { label: 'Critical', value: 'critical' },
         ],
       },
     },
   }
   ```

3. **Manager owns `useForm` and submit.** Defaults come from the store for
   edit mode, or schema-level fallbacks for create mode — never hardcoded
   per-Manager duplicate literals (see
   [`./07-hydration-adapters.md`](./07-hydration-adapters.md) for how a
   loaded rule becomes `defaultValues`).

   ```tsx
   // src/modules/alerts/AlertRuleFormManager.tsx
   'use client'

   import { useForm, FormProvider } from 'react-hook-form'
   import { zodResolver } from '@hookform/resolvers/zod'
   import { Button } from '@/src/components/ui/button'
   import { AlertRuleFormRenderer } from './AlertRuleFormRenderer'
   import { alertRuleSchema, type AlertRuleFormValues } from '@/src/schemas/alert-rule.schema'

   interface AlertRuleFormManagerProps {
     defaultValues: AlertRuleFormValues
     readOnly?: boolean
     onSave: (values: AlertRuleFormValues) => void | Promise<void>
     onDiscard?: () => void
   }

   export function AlertRuleFormManager({
     defaultValues,
     readOnly,
     onSave,
     onDiscard,
   }: AlertRuleFormManagerProps) {
     const form = useForm<AlertRuleFormValues>({
       resolver: zodResolver(alertRuleSchema),
       defaultValues,
       mode: 'onBlur',
     })

     const handleSubmit = form.handleSubmit(async (values) => {
       await onSave(values)
     })

     return (
       <FormProvider {...form}>
         <form onSubmit={handleSubmit} className="space-y-6">
           <AlertRuleFormRenderer control={form.control} readOnly={readOnly} />
           <div className="flex justify-end gap-2">
             <Button variant="outline" type="button" onClick={onDiscard}>
               Cancel
             </Button>
             <Button variant="primary" type="submit" disabled={readOnly}>
               Save rule
             </Button>
           </div>
         </form>
       </FormProvider>
     )
   }
   ```

4. **Renderer is pure over `control`.** It never calls `useForm`, never
   reads the store, never knows whether it's inside a create flow or an edit
   flow — that distinction lives entirely in the Manager above it.

   ```tsx
   // src/modules/alerts/AlertRuleFormRenderer.tsx
   'use client'

   import type { Control } from 'react-hook-form'
   import {
     FormField,
     FormItem,
     FormLabel,
     FormControl,
     FormMessage,
   } from '@/src/components/ui/form'
   import { Input } from '@/src/components/ui/input'
   import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/src/components/ui/select'
   import { AlertRuleFormConfig } from '@/src/config/alert-rule-form-config'
   import type { AlertRuleFormValues } from '@/src/schemas/alert-rule.schema'

   interface AlertRuleFormRendererProps {
     control: Control<AlertRuleFormValues>
     readOnly?: boolean
   }

   export function AlertRuleFormRenderer({ control, readOnly }: AlertRuleFormRendererProps) {
     const { name, metric, threshold, window, severity } = AlertRuleFormConfig.fields

     return (
       <div className="space-y-4">
         <FormField
           control={control}
           name={name.name as 'name'}
           render={({ field }) => (
             <FormItem>
               <FormLabel>{name.label}</FormLabel>
               <FormControl>
                 <Input {...field} placeholder={name.placeholder} disabled={readOnly} />
               </FormControl>
               <FormMessage />
             </FormItem>
           )}
         />

         <FormField
           control={control}
           name={threshold.name as 'threshold'}
           render={({ field }) => (
             <FormItem>
               <FormLabel>{threshold.label}</FormLabel>
               <FormControl>
                 <Input {...field} placeholder={threshold.placeholder} disabled={readOnly} />
               </FormControl>
               <FormMessage />
             </FormItem>
           )}
         />

         <FormField
           control={control}
           name={window.name as 'window'}
           render={({ field }) => (
             <FormItem>
               <FormLabel>{window.label}</FormLabel>
               <Select onValueChange={field.onChange} value={field.value} disabled={readOnly}>
                 <FormControl>
                   <SelectTrigger>
                     <SelectValue />
                   </SelectTrigger>
                 </FormControl>
                 <SelectContent>
                   {window.options.map((opt) => (
                     <SelectItem key={opt.value} value={opt.value}>
                       {opt.label}
                     </SelectItem>
                   ))}
                 </SelectContent>
               </Select>
               <FormMessage />
             </FormItem>
           )}
         />

         <FormField
           control={control}
           name={severity.name as 'severity'}
           render={({ field }) => (
             <FormItem>
               <FormLabel>{severity.label}</FormLabel>
               <Select onValueChange={field.onChange} value={field.value} disabled={readOnly}>
                 <FormControl>
                   <SelectTrigger>
                     <SelectValue />
                   </SelectTrigger>
                 </FormControl>
                 <SelectContent>
                   {severity.options.map((opt) => (
                     <SelectItem key={opt.value} value={opt.value}>
                       {opt.label}
                     </SelectItem>
                   ))}
                 </SelectContent>
               </Select>
               <FormMessage />
             </FormItem>
           )}
         />
       </div>
     )
   }
   ```

   Note `metric` from the config is omitted from this Renderer intentionally
   in some flows (e.g. when the rule is scoped to a metric already chosen
   upstream) — that is exactly the kind of per-call-site variation a pure
   Renderer supports: the same config and schema, a slightly different
   subset of `<FormField>`s per Renderer, with the schema still validating
   the full shape at submit time.

5. **Wire create and edit through the same pair.** A "create rule" call site
   passes schema-level defaults (`{ name: '', metric: 'error_rate', threshold: 0,
   window: '15m', severity: 'warning' }`); an "edit rule" call site passes
   `defaultValues` hydrated from the store's loaded rule. Both go through the
   identical `AlertRuleFormManager` + `AlertRuleFormRenderer` — the only
   difference is what `defaultValues` and `onSave` the Manager is handed.

**Multi-step wizard variant.** When a form is too large for one screen (for
example, an onboarding flow that collects connection details, then alert
defaults, then notification targets), don't inflate a single Renderer with
every field — split by step, and keep the same schema/config/Manager/Renderer
shape *per step*: each step gets its own schema slice (or the same schema
validated against a subset via `.pick()`), its own config, and its own
Renderer, with one Manager per step handling that step's `useForm` and
"Continue" action. A wizard shell component owns the step sequence — which
step is active, which steps are complete, whether "Continue" is enabled —
and reads per-step validity through a shared hook (analogous to
`useStepValidationStatus` in the lineage) rather than each step Manager
knowing about its siblings. The wizard shell never reaches into a step's
form state directly; it only knows "is step N valid" and "advance to step
N+1," exactly the same read-only boundary a slice orchestrator keeps with
slices (see [`./05-zustand-slice-store.md`](./05-zustand-slice-store.md)).

## Rules & gotchas

- **Never manage error display manually when `<FormMessage>` covers it.** A
  `<FormField>` render prop that puts `{fieldState.error?.message}` in a raw
  `<span>` instead of `<FormMessage>` loses the shared error styling and any
  future change to how errors are displayed app-wide. If `<FormMessage>`
  can render it, don't hand-roll it.
- **The Renderer stays pure — no `useForm`, no store reads, no submit
  logic.** The moment a Renderer imports `useStore` or calls
  `form.handleSubmit` itself, it can no longer be reused across a create
  Manager and an edit Manager, which was the entire point of splitting it
  out.
- **The config never encodes a validation rule the schema doesn't already
  enforce.** A `required: 'X is required'` string in the config is display
  text for a message the schema's `.min(1, ...)` produces — it is not a
  second, independent check. If a field needs a new constraint, add it to
  the schema first; the config only needs to change if the *label or
  options* change.
- **Types are inferred from the schema, never hand-written in parallel.**
  `type AlertRuleFormValues = z.infer<typeof alertRuleSchema>` is the only
  type declaration for form values. A hand-written interface that happens to
  match today will silently drift the next time the schema changes.
- **Defaults come from the store, not literals inlined in the Manager.**
  Hardcoding `defaultValues={{ severity: 'warning', ... }}` inside a Manager
  duplicates logic that belongs in the hydration layer the moment there's a
  second call site (create vs. edit) with different defaults. See
  [`./07-hydration-adapters.md`](./07-hydration-adapters.md) for how a
  loaded record becomes `defaultValues` and how form values map back to the
  store's shape on submit.
- **`mode` and `criteriaMode` on `useForm` are a Manager decision, not a
  Renderer one.** Whether validation runs `onBlur` vs `onChange`, and
  whether it surfaces the first error or all errors per field, is form
  lifecycle — it belongs next to the `useForm` call, not scattered into the
  Renderer's field-level props.
- **A read-only view is a prop, not a second component tree.** Pass
  `readOnly` down from the Manager and disable inputs in the Renderer;
  don't fork a separate "view mode" Renderer that can drift from the
  editable one.

## Source lineage

- glassflow-etl-ui/src/scheme/topics.scheme.ts
- glassflow-etl-ui/src/config/clickhouse-connection-form-config.ts
- glassflow-etl-ui/src/config/topic-selection-form-config.ts
- glassflow-etl-ui/src/modules/resources/PipelineResourcesFormManager.tsx
- glassflow-etl-ui/src/modules/resources/PipelineResourcesFormRenderer.tsx
- glassflow-etl-ui/src/modules/create/PipelineWizard.tsx
- glassflow-etl-ui/.cursor/architecture/FORM_ARCHITECTURE.md
