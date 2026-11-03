// Menus, context menus, the prompt dialog, the shortcuts dialog and toasts.
// Menu entries are plain data (see menus.ts). Disabled entries stay visible,
// with a note saying which milestone brings them.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PromptRequest } from './actions.ts'

export type MenuEntry =
  | { kind: 'item'; label: string; onSelect?: () => void; shortcut?: string; disabled?: boolean; note?: string }
  | { kind: 'sep' }
  | { kind: 'group'; label: string; items: MenuEntry[] }

/** Keyboard-friendly list: arrows move, Enter activates (native button), Escape closes. */
export type CloseMenu = (restoreFocus?: boolean) => void

export function MenuList({ items, onClose, onAction }: { items: MenuEntry[]; onClose: CloseMenu; onAction?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled])')?.focus()
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled])') ?? [])
    if (all.length === 0) return
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % all.length : (at - 1 + all.length) % all.length
    all[next]?.focus()
  }

  return (
    <div ref={ref} role="menu" onKeyDown={onKeyDown} className="min-w-64 rounded-md border border-rule bg-white py-1 text-[13px] shadow-lg">
      {items.map((entry, i) => renderEntry(entry, i, onClose, onAction))}
    </div>
  )
}

function renderEntry(entry: MenuEntry, key: number, onClose: CloseMenu, onAction?: () => void): ReactNode {
  if (entry.kind === 'sep') return <div key={key} role="separator" className="my-1 border-t border-rule-soft" />
  if (entry.kind === 'group') {
    return (
      <div key={key} role="group" aria-label={entry.label}>
        <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">{entry.label}</div>
        {entry.items.map((child, i) => renderEntry(child, i, onClose, onAction))}
      </div>
    )
  }
  return (
    <button
      key={key}
      type="button"
      role="menuitem"
      disabled={entry.disabled}
      title={entry.note}
      onClick={() => {
        onClose()
        onAction?.()
        entry.onSelect?.()
      }}
      className="flex w-full items-center gap-6 px-3 py-1.5 text-left hover:bg-hover focus:bg-hover focus:outline-none disabled:cursor-not-allowed disabled:text-ink-muted/60 disabled:hover:bg-transparent"
    >
      <span className="flex-1 whitespace-nowrap">{entry.label}</span>
      {entry.note && <span className="text-[11px] text-ink-muted">{entry.note}</span>}
      {entry.shortcut && <span className="text-[11px] text-ink-muted">{entry.shortcut}</span>}
    </button>
  )
}

/** Fixed-position menu at the pointer. Closes on outside click or Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: CloseMenu }) {
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-context-menu]')) onClose()
    }
    window.addEventListener('pointerdown', onPointer, true)
    return () => window.removeEventListener('pointerdown', onPointer, true)
  }, [onClose])
  return (
    <div data-context-menu className="fixed z-50" style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - 320) }}>
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

export function PromptDialog({ request, onClose }: { request: PromptRequest; onClose: () => void }) {
  const [value, setValue] = useState(request.initial ?? '')
  function submit() {
    onClose()
    request.onSubmit(value)
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-96 rounded-lg bg-white p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <h2 className="mb-3 text-base font-medium">{request.title}</h2>
        <label className="block text-ink-muted" htmlFor="prompt-input">
          {request.label}
        </label>
        <input
          id="prompt-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 h-9 w-full rounded border border-rule px-2 outline-none focus:border-accent"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
            Cancel
          </button>
          <button type="submit" className="rounded bg-accent px-3 py-1.5 font-medium text-white">
            {request.submitLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}

export const SHORTCUTS: Array<[string, string]> = [
  ['Cmd/Ctrl + Alt + M', 'Comment on the selected element, or on the slide'],
  ['Cmd/Ctrl + Z', 'Undo'],
  ['Cmd/Ctrl + Shift + Z, or Ctrl + Y', 'Redo'],
  ['Cmd/Ctrl + C, X, V', 'Copy, cut, paste elements'],
  ['Cmd/Ctrl + D', 'Duplicate selected elements (or the slide, if none selected)'],
  ['Cmd/Ctrl + A', 'Select all elements on the slide'],
  ['Delete or Backspace', 'Delete selected elements'],
  ['Arrow keys', 'Nudge selected elements by 1 px (Shift: 10 px)'],
  ['Double-click text', 'Edit text in place (Esc to finish)'],
  ['Cmd/Ctrl + Enter', 'New slide after the current one'],
  ['Escape', 'Clear the selection or close a dialog'],
  ['F5', 'Present from the first slide'],
  ['S (in the presentation window)', 'Open the presenter view for that presentation'],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="w-[32rem] rounded-lg bg-white p-4 shadow-xl" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 className="mb-3 text-base font-medium">Keyboard shortcuts</h2>
        <table className="w-full text-[13px]">
          <tbody>
            {SHORTCUTS.map(([keys, what]) => (
              <tr key={keys} className="border-t border-rule-soft">
                <td className="py-1.5 pr-4 font-mono text-[12px] text-ink-muted">{keys}</td>
                <td className="py-1.5">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-4 flex justify-end">
          <button type="button" autoFocus onClick={onClose} className="rounded bg-accent px-3 py-1.5 font-medium text-white">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onDone, 3500)
    return () => clearTimeout(t)
  }, [message, onDone])
  if (!message) return null
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-14 left-1/2 z-50 -translate-x-1/2 rounded bg-[#202124] px-4 py-2 text-[13px] text-white shadow-lg">
      {message}
    </div>
  )
}
