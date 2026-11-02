// Menu bar and the menu tree. Items that belong to later milestones are listed
// but disabled, with the milestone in the note, so nothing is silently missing.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CHART_TYPES, SHAPE_KINDS, SLIDE_LAYOUTS, TRANSITIONS, type Deck } from '@sleid/model'
import type { Actions, PromptRequest, UiState } from './actions.ts'
import { CHART_LABELS, SHAPE_LABELS } from './commands.ts'
import { MenuList, type MenuEntry } from './Overlays.tsx'

export interface MenuDeps {
  actions: Actions
  /** Commenters and viewers: only items that do not change the deck stay enabled. */
  readOnly: boolean
  deck: Deck
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
  ui: UiState
  setUi: (patch: Partial<UiState>) => void
  undo: () => void
  redo: () => void
  focusTitle: () => void
  pickImage: () => void
  prompt: (request: PromptRequest) => void
  openShortcuts: () => void
  toast: (message: string) => void
}

type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

const TODO = (milestone: string): Pick<Extract<MenuEntry, { kind: 'item' }>, 'disabled' | 'note'> => ({ disabled: true, note: milestone })

type Menu = { label: string; items: MenuEntry[] }

// Items that stay enabled for viewers and commenters. Everything else is disabled in read-only mode.
const VIEWER_ITEMS = new Set([
  'New deck',
  'Make a copy',
  'JSON (.json)',
  'Markdown (.md)',
  'HTML (.html)',
  'Present from beginning',
  'Present from current slide',
  'Show speaker notes',
  'Show grid and guides',
  'Fit',
  '50%',
  '75%',
  '100%',
  '150%',
  'Copy',
  'Select all',
  'Keyboard shortcuts',
])

function restrictForViewer(menus: Menu[]): Menu[] {
  const walk = (entries: MenuEntry[]): MenuEntry[] =>
    entries.map((entry) => {
      if (entry.kind === 'group') return { ...entry, items: walk(entry.items) }
      if (entry.kind === 'sep') return entry
      const plain = entry.label.replace(/^✓ /, '')
      if (entry.disabled || VIEWER_ITEMS.has(plain)) return entry
      return { ...entry, disabled: true, note: entry.note ?? 'View only' }
    })
  return menus.map((m) => ({ ...m, items: walk(m.items) }))
}

export function buildMenus(d: MenuDeps): Menu[] {
  const a = d.actions
  const menus: Menu[] = buildAllMenus(d)
  return d.readOnly ? restrictForViewer(menus) : menus
}

function buildAllMenus(d: MenuDeps): Menu[] {
  const a = d.actions
  const sel = d.hasSelection
  const item = (label: string, onSelect: () => void, shortcut?: string): Extract<MenuEntry, { kind: 'item' }> => ({ kind: 'item', label, onSelect, shortcut })
  const sep: MenuEntry = { kind: 'sep' }
  const group = (label: string, items: MenuEntry[]): MenuEntry => ({ kind: 'group', label, items })
  const selItem = (label: string, onSelect: () => void, shortcut?: string): MenuEntry => ({ ...item(label, onSelect, shortcut), disabled: !sel })

  return [
    {
      label: 'File',
      items: [
        item('New deck', () => void a.newDeck()),
        item('Make a copy', () => void a.makeCopy()),
        sep,
        group('Download', [
          item('JSON (.json)', () => a.download('json')),
          item('Markdown (.md)', () => a.download('markdown')),
          item('HTML (.html)', () => a.download('html')),
          { kind: 'item', label: 'PDF (.pdf)', ...TODO('M3') },
          { kind: 'item', label: 'PowerPoint (.pptx)', ...TODO('M3') },
          { kind: 'item', label: 'PNG per slide', ...TODO('M3') },
        ]),
        sep,
        item('Rename', d.focusTitle),
      ],
    },
    {
      label: 'Edit',
      items: [
        { kind: 'item', label: 'Undo', shortcut: 'Ctrl+Z', onSelect: d.undo, disabled: !d.canUndo },
        { kind: 'item', label: 'Redo', shortcut: 'Ctrl+Shift+Z', onSelect: d.redo, disabled: !d.canRedo },
        sep,
        selItem('Cut', () => a.copySelection(true), 'Ctrl+X'),
        selItem('Copy', () => a.copySelection(false), 'Ctrl+C'),
        item('Paste', () => void a.pasteElements(), 'Ctrl+V'),
        selItem('Duplicate', a.duplicateSelection, 'Ctrl+D'),
        selItem('Delete', a.deleteSelection, 'Del'),
        sep,
        item('Select all', a.selectAll, 'Ctrl+A'),
      ],
    },
    {
      label: 'View',
      items: [
        item('Present from beginning', () => a.present(true), 'F5'),
        item('Present from current slide', () => a.present(false)),
        sep,
        { kind: 'item', label: `${d.ui.showNotes ? '✓ ' : ''}Show speaker notes`, onSelect: () => d.setUi({ showNotes: !d.ui.showNotes }) },
        { kind: 'item', label: `${d.ui.showGuides ? '✓ ' : ''}Show grid and guides`, onSelect: () => d.setUi({ showGuides: !d.ui.showGuides }) },
        sep,
        group(
          'Zoom',
          [
            { label: 'Fit', zoom: 'fit' as const },
            { label: '50%', zoom: 50 },
            { label: '75%', zoom: 75 },
            { label: '100%', zoom: 100 },
            { label: '150%', zoom: 150 },
          ].map((z) => item(z.label, () => d.setUi({ zoom: z.zoom }))),
        ),
      ],
    },
    {
      label: 'Insert',
      items: [
        item('Text box', a.insertText),
        group('Image', [item('From URL…', a.insertImageUrl), item('Upload (up to 2 MB)…', d.pickImage)]),
        group(
          'Shape',
          SHAPE_KINDS.map((k) => item(SHAPE_LABELS[k] ?? k, () => a.insertShape(k))),
        ),
        group(
          'Chart',
          CHART_TYPES.map((k) => item(CHART_LABELS[k] ?? k, () => a.insertChart(k))),
        ),
        item('Table', a.insertTable),
        item('Code', a.insertCode),
        item('Diagram (Mermaid)', a.insertDiagram),
        sep,
        item('New slide', () => a.newSlide(), 'Ctrl+Enter'),
      ],
    },
    {
      label: 'Format',
      items: [
        { kind: 'item', label: 'Bold', shortcut: 'Ctrl+B', onSelect: () => a.toggleMark('bold') },
        { kind: 'item', label: 'Italic', shortcut: 'Ctrl+I', onSelect: () => a.toggleMark('italic') },
        { kind: 'item', label: 'Underline', shortcut: 'Ctrl+U', onSelect: () => a.toggleMark('underline') },
        { kind: 'item', label: 'Strikethrough', onSelect: () => a.toggleMark('strike') },
        sep,
        group(
          'Align',
          [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']].map(([v, l]) =>
            item(l!, () => a.setTextStyle({ align: v })),
          ),
        ),
        group(
          'Font size',
          [12, 18, 24, 32, 40, 56, 72].map((n) => item(String(n), () => a.setTextStyle({ fontSize: n }))),
        ),
        group(
          'Opacity',
          [100, 75, 50, 25].map((p) => selItem(`${p}%`, () => a.setOpacity(p / 100))),
        ),
        sep,
        selItem('Clear formatting', a.clearFormatting, 'Ctrl+\\'),
      ],
    },
    {
      label: 'Slide',
      items: [
        group(
          'New slide',
          SLIDE_LAYOUTS.map((l) => item(l, () => a.newSlide(l))),
        ),
        item('Duplicate slide', () => a.duplicateSlide()),
        item('Delete slide', () => a.deleteSlide()),
        item('Hide slide', () => a.toggleHidden()),
        item('Change background…', () =>
          d.prompt({
            title: 'Slide background',
            label: 'Colour (#rrggbb)',
            initial: '#ffffff',
            submitLabel: 'Set',
            onSubmit: (v) => {
              if (/^#[0-9a-f]{6}$/i.test(v.trim())) a.setSlideBackground(v.trim())
              else d.toast('Use a colour like #1a73e8')
            },
          }),
        ),
        group(
          'Transition',
          TRANSITIONS.map((t) => item(t, () => a.setTransition(t))),
        ),
        item('Toggle auto-animate', a.toggleAutoAnimate),
        sep,
        item('Move slide up', () => a.moveSlideBy(-1)),
        item('Move slide down', () => a.moveSlideBy(1)),
        group(
          'Move to section',
          [{ id: null as string | null, name: 'None' }, ...d.deck.sections.map((s) => ({ id: s.id as string | null, name: s.name }))].map((s) =>
            item(s.name, () => a.moveToSection(s.id)),
          ),
        ),
      ],
    },
    {
      label: 'Arrange',
      items: [
        selItem('Bring to front', () => a.arrange('front')),
        selItem('Bring forward', () => a.arrange('forward')),
        selItem('Send backward', () => a.arrange('backward')),
        selItem('Send to back', () => a.arrange('back')),
        sep,
        group(
          'Align to slide',
          [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']].map(([v, l]) =>
            selItem(l!, () => a.align(v as AlignKind)),
          ),
        ),
        group('Distribute', [selItem('Horizontally', () => a.distribute('x')), selItem('Vertically', () => a.distribute('y'))]),
      ],
    },
    {
      label: 'Tools',
      items: [{ kind: 'item', label: 'AI assistant', ...TODO('M4') }],
    },
    {
      label: 'Extensions',
      items: [{ kind: 'item', label: 'MCP access tokens', ...TODO('M5') }],
    },
    {
      label: 'Help',
      items: [item('Keyboard shortcuts', d.openShortcuts, 'Ctrl+/')],
    },
  ]
}

export function MenuBar({ menus }: { menus: Array<{ label: string; items: MenuEntry[] }> }) {
  const [open, setOpen] = useState<string | null>(null)
  const barRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !barRef.current?.contains(e.target)) setOpen(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  function focusTrigger(label: string) {
    barRef.current?.querySelector<HTMLButtonElement>(`[data-menu="${label}"]`)?.focus()
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = menus[(index + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length]!
      setOpen(open ? next.label : null)
      focusTrigger(next.label)
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(menus[index]!.label)
    }
  }

  return (
    <nav aria-label="Menu" className="flex h-7 shrink-0 items-center gap-0.5 px-2">
      <ul role="menubar" ref={barRef} className="flex items-center gap-0.5">
        {menus.map((m, i) => (
          <li key={m.label} role="none" className="relative">
            <button
              type="button"
              role="menuitem"
              data-menu={m.label}
              aria-haspopup="menu"
              aria-expanded={open === m.label}
              onClick={() => setOpen(open === m.label ? null : m.label)}
              onMouseEnter={() => open && setOpen(m.label)}
              onKeyDown={(e) => onTriggerKey(e, i)}
              className={`rounded px-2 py-0.5 ${open === m.label ? 'bg-hover' : 'hover:bg-hover'}`}
            >
              {m.label}
            </button>
            {open === m.label && (
              <div className="absolute left-0 top-full z-40 mt-0.5">
                <MenuList
                  items={m.items}
                  onClose={(restore) => {
                    setOpen(null)
                    if (restore) focusTrigger(m.label)
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}
