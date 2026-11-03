import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * Header for every page except the dashboard. The logo and the right-hand link both go to `backTo`, so the way back is
 * the same everywhere. The title is cut with CSS, so a long prompt does not push the right side off the bar.
 */
export function AppHeader({
  title,
  backTo = '/',
  backLabel = 'Back to decks',
  children,
}: {
  title: string
  backTo?: string
  backLabel?: string
  children?: ReactNode
}) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-rule bg-white px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to={backTo}
          className="grid size-8 shrink-0 place-items-center rounded bg-accent font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={backLabel}
        >
          S
        </Link>
        <h1 className="max-w-[60vw] truncate text-lg font-medium" title={title}>
          {title}
        </h1>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {children}
        <Link
          to={backTo}
          className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {backLabel}
        </Link>
      </div>
    </header>
  )
}
