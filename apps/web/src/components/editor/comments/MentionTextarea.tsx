// A textarea with @mention autocomplete. Typing "@" and some letters offers the deck's members; Enter or Tab picks one,
// and the picked name is written as mention markup (see mentionMarkup in @sleid/model), which the server reads.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { mentionMarkup } from '@sleid/model'

export interface MentionMember {
  id: string
  name: string
  image: string | null
}

const MENTION_AT_CARET = /(^|\s)@([^\s@[\]()]{0,40})$/

export function MentionTextarea({
  value,
  onChange,
  members,
  onNeedMembers,
  placeholder,
  label,
  rows = 3,
  autoFocus,
  onSubmit,
  testId,
}: {
  value: string
  onChange: (next: string) => void
  /** Null while the member list loads. */
  members: MentionMember[] | null
  onNeedMembers: () => void
  placeholder?: string
  label: string
  rows?: number
  autoFocus?: boolean
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void
  testId?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const pendingCaret = useRef<number | null>(null)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const match = useMemo(() => {
    const before = value.slice(0, caret)
    const m = MENTION_AT_CARET.exec(before)
    if (!m) return null
    return { start: before.length - m[2]!.length - 1, query: m[2]! }
  }, [value, caret])

  const options = useMemo(() => {
    if (!match || !members || dismissed) return []
    const q = match.query.toLowerCase()
    return members.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 6)
  }, [match, members, dismissed])

  useEffect(() => setActive(0), [match?.query])
  useEffect(() => setDismissed(false), [value])

  useEffect(() => {
    if (match && !members) onNeedMembers()
  }, [match, members, onNeedMembers])

  // The caret goes where the mention ends. It is set in a layout effect, once the new value is in the DOM, so the
  // next keystroke lands after the mention and not in the middle of the text.
  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null || !ref.current) return
    pendingCaret.current = null
    ref.current.setSelectionRange(at, at)
    setCaret(at)
  }, [value])

  function pick(member: MentionMember) {
    if (!match) return
    const insert = `${mentionMarkup(member.name, member.id)} `
    const next = value.slice(0, match.start) + insert + value.slice(caret)
    pendingCaret.current = match.start + insert.length
    onChange(next)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (options.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % options.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + options.length) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[active]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        data-testid={testId}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={options.length > 0 ? listId : undefined}
        aria-expanded={options.length > 0}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className="w-full resize-y rounded border border-rule bg-white px-2 py-1.5 text-[13px] outline-none focus:border-accent"
      />
      {options.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Mention a member" data-testid="mention-options" className="absolute left-0 right-0 top-full z-20 mt-0.5 max-h-48 overflow-y-auto rounded border border-rule bg-white py-1 shadow-md">
          {options.map((member, i) => (
            <li
              key={member.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(member)
              }}
              className={`cursor-pointer px-2 py-1 text-[13px] ${i === active ? 'bg-accent/10 text-accent' : 'text-ink'}`}
            >
              {member.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
