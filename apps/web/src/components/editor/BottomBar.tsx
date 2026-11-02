// Speaker notes (toggle in View) and the section tabs, styled like sheet tabs.
// Clicking a section tab scrolls the filmstrip to its first slide. Double-click
// renames, and right-click opens rename and delete.
import type { MouseEvent } from 'react'
import { Plus } from 'lucide-react'
import type { Deck, Slide } from '@sleid/model'
import type { Actions, UiState } from './actions.ts'
import { thumbId } from './Filmstrip.tsx'

export function BottomBar({
  deck,
  slide,
  ui,
  setUi,
  actions,
  onSectionMenu,
}: {
  deck: Deck
  slide: Slide
  ui: UiState
  setUi: (patch: Partial<UiState>) => void
  actions: Actions
  onSectionMenu: (x: number, y: number, sectionId: string) => void
}) {
  function openSection(sectionId: string | null) {
    setUi({ section: sectionId })
    const first = deck.slides.find((s) => (sectionId === null ? true : s.sectionId === sectionId))
    if (first) document.getElementById(thumbId(first.id))?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div className="shrink-0">
      {ui.showNotes && <NotesArea key={slide.id} slide={slide} onSave={(notes) => actions.setNotes(notes)} />}
      <div className="flex h-8 items-end gap-1 border-t border-rule bg-[#f1f3f4] px-2">
        <button type="button" aria-label="Add section" title="Add section" onClick={actions.addSection} className="mb-1 grid size-6 place-items-center rounded text-ink-muted hover:bg-hover">
          <Plus size={16} aria-hidden />
        </button>
        <SectionTab label="Slides" active={ui.section === null} onClick={() => openSection(null)} />
        {deck.sections.map((section) => (
          <SectionTab
            key={section.id}
            label={section.name}
            active={ui.section === section.id}
            onClick={() => openSection(section.id)}
            onDoubleClick={() => actions.renameSection(section.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              onSectionMenu(e.clientX, e.clientY, section.id)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function SectionTab({
  label,
  active,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  label: string
  active: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={`h-7 max-w-40 truncate rounded-t border border-b-0 px-4 font-medium ${
        active ? 'border-rule bg-white text-accent' : 'border-transparent text-ink-muted hover:bg-hover'
      }`}
    >
      {label}
    </button>
  )
}

function NotesArea({ slide, onSave }: { slide: Slide; onSave: (notes: string) => void }) {
  return (
    <div className="flex h-24 shrink-0 flex-col border-t border-rule bg-white px-4 py-2">
      <label className="mb-1 text-[11px] font-medium text-ink-muted" htmlFor="speaker-notes">
        Speaker notes
      </label>
      <textarea
        id="speaker-notes"
        className="min-h-0 flex-1 resize-none rounded border border-rule-soft p-1.5 text-[13px] outline-none focus:border-accent"
        defaultValue={slide.notes}
        onBlur={(e) => e.target.value !== slide.notes && onSave(e.target.value)}
      />
    </div>
  )
}
