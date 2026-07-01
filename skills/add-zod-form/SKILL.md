---
name: add-zod-form
description: Use when adding a schema-first form — creates the Zod schema, field config, Manager (useForm + submit), and pure Renderer in the correct order.
---

# Add a Zod form

Add a new form the same way every other form in the pack is built: a Zod
schema as the single source of truth for shape and validation, a plain
config object for field metadata, a Manager that owns `useForm` and submit,
and a pure Renderer that lays out fields over `control`. Background and
rules live in
[`../../docs/06-forms-zod-manager-renderer.md`](../../docs/06-forms-zod-manager-renderer.md)
— this file is the procedure, not the rationale.

## When to use this

You're adding a new form to the app — a create/edit surface for a domain
object (an alert rule, a connection, a notification target) — and no
existing schema/config/Manager/Renderer set already covers it. If you're
adding one field to a form that already exists, add it to that form's
existing schema, config, and Renderer instead of starting a new set.

## Procedure

1. **Define the Zod schema.**
   File: `src/schemas/<feature>.schema.ts` (new file).
   This is the single source of truth for shape and validation — every
   constraint the form must enforce lives here, not in the Renderer. Export
   the schema (`export const <feature>Schema = z.object({ ... })`) and infer
   the values type from it: `export type <Feature>FormValues = z.infer<typeof <feature>Schema>`.
   Never hand-write a parallel interface — it silently drifts the next time
   the schema changes.

2. **Create the field config object.**
   File: `src/config/<feature>-form-config.ts` (new file).
   A plain object keyed by field name (matching the schema's field names)
   holding *only* what the Renderer needs to draw a field — `label`,
   `placeholder`, `type`, `options` for selects. The config never encodes a
   validation rule the schema doesn't already enforce; it describes
   presentation, the schema decides validity. If a field needs a new
   constraint, add it to the schema first — the config only changes if the
   label or options change.

3. **Build the Manager: `useForm(zodResolver)` + submit.**
   File: `src/modules/<feature>/<Feature>FormManager.tsx` (new file, `'use
   client'`).
   This is the only component that calls `useForm`. Build the resolver from
   the step-1 schema (`resolver: zodResolver(<feature>Schema)`), accept
   `defaultValues` as a prop, wrap children in `<FormProvider>` or pass
   `control` down explicitly, and own `handleSubmit`, discard/reset, and
   read-only gating. `mode` and `criteriaMode` are decided here, not in the
   Renderer.

4. **Build the pure Renderer over `control`.**
   File: `src/modules/<feature>/<Feature>FormRenderer.tsx` (new file, `'use
   client'`).
   A function of `control` (and the step-2 config) to JSX. Render
   `<FormField control={control} name={...} render={...}>` wrapping
   `<FormItem>` / `<FormControl>` / `<FormMessage>` for each field the form
   needs, and nothing else — no `useForm`, no submit handler, no store read,
   no side effects. Given the same `control` and config, it must always
   render the same tree. Pass `readOnly` down as a prop and disable inputs
   in the Renderer rather than forking a second "view mode" Renderer.

5. **Wire defaults from the store, not literals.**
   File: the call site that renders the Manager (e.g. a page or a modal in
   `src/modules/<feature>/`).
   `defaultValues` for the Manager come from the store — schema-level
   fallbacks for a "create" call site, a hydrated record for an "edit" call
   site — never hardcoded per-Manager duplicate literals. See
   [`../../docs/07-hydration-adapters.md`](../../docs/07-hydration-adapters.md)
   for how a loaded record becomes `defaultValues` and how submitted form
   values map back to the store's shape.

6. **Verify validation and error display.**
   Run the dev server, open the form, and submit it empty — confirm every
   required field shows its schema message via `<FormMessage>` (not a
   hand-rolled `<span>`). Enter a value that violates a schema rule (e.g. a
   negative number where the schema requires `.positive()`) and confirm the
   specific message renders next to that field. Then submit valid values
   and confirm `onSave` receives the parsed, typed values and the form
   reaches its submitted state (or the edit Manager reloads the record from
   the store if that's the app's pattern).

## Worked example: an "alert rule" form

A threshold, a rolling time window, and a severity — used identically for
both "create rule" and "edit rule."

1. Schema, in `src/schemas/alert-rule.schema.ts`:

   ```ts
   import { z } from 'zod'

   export const alertRuleSchema = z.object({
     name: z.string().min(1, 'Name is required'),
     threshold: z.coerce.number().positive('Threshold must be greater than 0'),
     window: z.enum(['5m', '15m', '1h', '24h']),
     severity: z.enum(['info', 'warning', 'critical']),
   })

   export type AlertRuleFormValues = z.infer<typeof alertRuleSchema>
   ```

2. Config, in `src/config/alert-rule-form-config.ts`:

   ```ts
   export const AlertRuleFormConfig = {
     fields: {
       name: { name: 'name', label: 'Rule name', placeholder: 'e.g. High error rate', type: 'text' },
       threshold: { name: 'threshold', label: 'Threshold', placeholder: 'e.g. 0.05', type: 'text' },
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

3. Manager, in `src/modules/alerts/AlertRuleFormManager.tsx`:

   ```tsx
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

   export function AlertRuleFormManager({ defaultValues, readOnly, onSave, onDiscard }: AlertRuleFormManagerProps) {
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

4. Renderer, in `src/modules/alerts/AlertRuleFormRenderer.tsx`:

   ```tsx
   'use client'

   import type { Control } from 'react-hook-form'
   import { FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/src/components/ui/form'
   import { Input } from '@/src/components/ui/input'
   import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/src/components/ui/select'
   import { AlertRuleFormConfig } from '@/src/config/alert-rule-form-config'
   import type { AlertRuleFormValues } from '@/src/schemas/alert-rule.schema'

   interface AlertRuleFormRendererProps {
     control: Control<AlertRuleFormValues>
     readOnly?: boolean
   }

   export function AlertRuleFormRenderer({ control, readOnly }: AlertRuleFormRendererProps) {
     const { name, threshold, window, severity } = AlertRuleFormConfig.fields

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

5. Defaults: a "create rule" call site passes schema-level defaults
   (`{ name: '', threshold: 0, window: '15m', severity: 'warning' }`); an
   "edit rule" call site passes `defaultValues` hydrated from the store's
   loaded rule via the pipeline in
   [`../../docs/07-hydration-adapters.md`](../../docs/07-hydration-adapters.md).
   Both go through the identical `AlertRuleFormManager` +
   `AlertRuleFormRenderer` — only `defaultValues` and `onSave` differ.

6. Verify: submit the form empty and confirm "Name is required" and
   "Threshold must be greater than 0" render under their fields via
   `<FormMessage>`; type `-1` into threshold and confirm the same positive-
   number message appears; then fill in valid values and confirm `onSave`
   receives a fully-typed `AlertRuleFormValues`.

## Rules carried over from the reference doc

- Never manage error display manually when `<FormMessage>` covers it — a
  render prop that puts `{fieldState.error?.message}` in a raw `<span>`
  loses shared error styling and any future change to error display app-wide.
- The Renderer stays pure — no `useForm`, no store reads, no submit logic.
  The moment a Renderer imports `useStore` or calls `form.handleSubmit`
  itself, it can no longer be reused across a create Manager and an edit
  Manager.
- The config never encodes a validation rule the schema doesn't already
  enforce — a `required: '...'` string in the config is display text for a
  message the schema already produces, not a second independent check.
- Types are inferred from the schema, never hand-written in parallel.
- Defaults come from the store, not literals inlined in the Manager.
- `mode` and `criteriaMode` on `useForm` are a Manager decision, not a
  Renderer one.
- A read-only view is a prop, not a second component tree.
