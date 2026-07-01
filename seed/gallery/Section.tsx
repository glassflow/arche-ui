import { cn } from '@/src/utils/common.client'

interface SectionProps {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}

export function Section({ title, description, children, className }: SectionProps) {
  return (
    <section className={cn('mb-12', className)}>
      <div className="mb-5 pb-3 border-b border-[hsl(var(--border))]">
        <h2 className="title-5 text-[hsl(var(--foreground))]">{title}</h2>
        {description && (
          <p className="body-3 text-[hsl(var(--muted-foreground))] mt-1">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}

interface VariantGridProps {
  children: React.ReactNode
  columns?: 2 | 3 | 4 | 5 | 6
}

export function VariantGrid({ children, columns = 4 }: VariantGridProps) {
  const colClass = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-5',
    6: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  }[columns]

  return <div className={cn('grid gap-3', colClass)}>{children}</div>
}

interface PreviewProps {
  label?: string
  children: React.ReactNode
  className?: string
  center?: boolean
}

export function Preview({ label, children, className, center = true }: PreviewProps) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          'rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4',
          center && 'flex items-center justify-center',
          className,
        )}
      >
        {children}
      </div>
      {label && (
        <p className="text-xs text-[hsl(var(--muted-foreground))] text-center">{label}</p>
      )}
    </div>
  )
}

interface CodeBlockProps {
  code: string
}

export function CodeBlock({ code }: CodeBlockProps) {
  return (
    <pre className="mt-3 rounded-md bg-[hsl(var(--surface-raised))] border border-[hsl(var(--border))] px-4 py-3 text-xs font-mono text-[hsl(var(--muted-foreground))] overflow-x-auto">
      <code>{code}</code>
    </pre>
  )
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-10">
      <h1 className="title-3 text-[hsl(var(--primary))]">{title}</h1>
      {description && (
        <p className="body-2 text-[hsl(var(--muted-foreground))] mt-2 max-w-xl">{description}</p>
      )}
    </div>
  )
}
