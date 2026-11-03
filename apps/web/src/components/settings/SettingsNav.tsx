// The links shared by the settings pages (AI, MCP tokens, Brand kits, Templates).
import { Link } from '@tanstack/react-router'

const LINKS = [
  { to: '/settings/ai', label: 'AI' },
  { to: '/settings/tokens', label: 'MCP tokens' },
  { to: '/settings/brand-kits', label: 'Brand kits' },
  { to: '/settings/templates', label: 'Templates' },
] as const

export function SettingsNav() {
  return (
    <nav aria-label="Settings" className="flex flex-wrap gap-1 border-b border-rule pb-2 text-[13px]">
      {LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          data-testid={`settings-nav-${link.to.split('/').pop()}`}
          className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover"
          activeProps={{ className: 'rounded px-3 py-1.5 bg-accent-soft font-medium text-[#001d35]' }}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  )
}
