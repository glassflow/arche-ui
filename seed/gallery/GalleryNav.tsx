'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { SearchIcon } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/src/components/ui/command'

// ─── Sections (sidebar nav) ────────────────────────────────────────────────────
//
// This is a minimal generic starting set. Add a folder + a matching entry
// here for every new category page — see seed/gallery/README.md.

const sections = [
  { href: '/dev/components', label: 'Overview', exact: true },
  { href: '/dev/components/foundations', label: 'Foundations' },
  { href: '/dev/components/buttons', label: 'Buttons' },
  { href: '/dev/components/display', label: 'Display' },
  { href: '/dev/components/forms', label: 'Forms' },
  { href: '/dev/components/feedback', label: 'Feedback' },
  { href: '/dev/components/anti-patterns', label: 'Anti-patterns' },
]

// ─── Cmd-K search index ────────────────────────────────────────────────────────

type SearchEntry = {
  label: string
  href: string
  group: 'Sections' | 'Components' | 'Tokens' | 'Variants'
  hint?: string
}

const components: SearchEntry[] = [
  // Buttons
  {
    label: 'Button',
    href: '/dev/components/buttons',
    group: 'Components',
    hint: 'primary · destructive · outline · ghost',
  },
  // Display
  { label: 'Badge', href: '/dev/components/display', group: 'Components', hint: 'success · warning · error · outline' },
  { label: 'Card', href: '/dev/components/display', group: 'Components', hint: 'default · outline' },
  { label: 'Avatar', href: '/dev/components/display', group: 'Components' },
  // Forms
  { label: 'Input', href: '/dev/components/forms', group: 'Components', hint: 'variant: default · error' },
  { label: 'Select', href: '/dev/components/forms', group: 'Components' },
  { label: 'Checkbox', href: '/dev/components/forms', group: 'Components' },
  { label: 'Switch', href: '/dev/components/forms', group: 'Components' },
  { label: 'Textarea', href: '/dev/components/forms', group: 'Components' },
  { label: 'Label', href: '/dev/components/forms', group: 'Components' },
  // Feedback
  { label: 'Skeleton', href: '/dev/components/feedback', group: 'Components' },
  { label: 'Sonner (Toast)', href: '/dev/components/feedback', group: 'Components' },
  { label: 'Form (FormField, FormMessage)', href: '/dev/components/feedback', group: 'Components' },
]

const variants: SearchEntry[] = [
  { label: 'Button variant="primary"', href: '/dev/components/buttons', group: 'Variants' },
  { label: 'Button variant="destructive"', href: '/dev/components/buttons', group: 'Variants' },
  { label: 'Button variant="ghost"', href: '/dev/components/buttons', group: 'Variants' },
  { label: 'Card variant="default"', href: '/dev/components/display', group: 'Variants' },
  { label: 'Card variant="outline"', href: '/dev/components/display', group: 'Variants' },
  { label: 'Badge variant="success"', href: '/dev/components/display', group: 'Variants' },
  { label: 'Badge variant="warning"', href: '/dev/components/display', group: 'Variants' },
  { label: 'Badge variant="error"', href: '/dev/components/display', group: 'Variants' },
  { label: 'Input variant="error"', href: '/dev/components/forms', group: 'Variants' },
]

const tokens: SearchEntry[] = [
  { label: '--status-error', href: '/dev/components/foundations', group: 'Tokens', hint: 'failed status, error text' },
  { label: '--status-warning', href: '/dev/components/foundations', group: 'Tokens', hint: 'degraded, paused' },
  { label: '--status-running', href: '/dev/components/foundations', group: 'Tokens', hint: 'success, healthy' },
  { label: '--status-degraded', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--metric-positive', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--metric-negative', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--metric-neutral', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--muted-foreground', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--surface-base', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--surface-raised', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--surface-overlay', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--border', href: '/dev/components/foundations', group: 'Tokens' },
  { label: '--ring', href: '/dev/components/foundations', group: 'Tokens', hint: 'focus ring' },
  { label: '--destructive', href: '/dev/components/foundations', group: 'Tokens' },
]

const searchIndex: SearchEntry[] = [
  ...sections.map((s) => ({ label: s.label, href: s.href, group: 'Sections' as const })),
  ...components,
  ...variants,
  ...tokens,
]

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function GalleryNav() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // Cmd+K / Ctrl+K opens the palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onSelect = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  // Group entries for the dialog
  const grouped: Record<SearchEntry['group'], SearchEntry[]> = {
    Sections: [],
    Components: [],
    Variants: [],
    Tokens: [],
  }
  for (const entry of searchIndex) grouped[entry.group].push(entry)

  return (
    <nav className="sticky top-8 flex flex-col gap-0.5">
      <p className="body-3 text-[hsl(var(--muted-foreground))] uppercase tracking-widest mb-3 px-3 font-medium">Components</p>

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 mb-2 rounded-md body-3 text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))] hover:border-[hsl(var(--ring))] hover:text-[hsl(var(--foreground))] transition-colors text-left focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
        aria-label="Open search palette (Cmd+K)"
      >
        <SearchIcon size={14} className="shrink-0 opacity-60" />
        <span className="flex-1">Search…</span>
        <kbd className="caption-1 font-mono text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))] rounded px-1.5 py-0.5">
          ⌘K
        </kbd>
      </button>

      {sections.map(({ href, label, exact }) => {
        const isActive = exact ? pathname === href : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={[
              'relative flex items-center px-3 py-2 rounded-md body-3 transition-colors',
              isActive
                ? 'text-[hsl(var(--foreground))] bg-[hsl(var(--accent))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]',
            ].join(' ')}
          >
            {isActive && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-[hsl(var(--foreground))]" />
            )}
            {label}
          </Link>
        )
      })}

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Component search"
        description="Find components, variants, and design tokens."
      >
        <CommandInput placeholder="Search components, variants, tokens…" />
        <CommandList>
          <CommandEmpty>No matches found.</CommandEmpty>
          {(['Sections', 'Components', 'Variants', 'Tokens'] as const).map((group) =>
            grouped[group].length > 0 ? (
              <CommandGroup key={group} heading={group}>
                {grouped[group].map((entry) => (
                  <CommandItem
                    key={`${group}:${entry.label}`}
                    value={`${entry.label} ${entry.hint ?? ''}`}
                    onSelect={() => onSelect(entry.href)}
                  >
                    <span className="font-mono text-sm">{entry.label}</span>
                    {entry.hint && (
                      <span className="ml-auto caption-1 text-[hsl(var(--muted-foreground))] truncate max-w-[280px]">
                        {entry.hint}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null,
          )}
        </CommandList>
      </CommandDialog>
    </nav>
  )
}
