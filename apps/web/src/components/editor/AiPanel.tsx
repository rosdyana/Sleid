// The AI side panel: provider choice, the conversation, and proposal cards. A card's buttons are
// Preview (a throwaway copy of the deck is shown with a ribbon), Apply (the change, through the live
// document so Undo works), and Discard. Viewers and commenters never see this panel.
import { useState, type KeyboardEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import type { Usage } from '@sleid/llm'
import type { useAssistant, ProposalCard, TimelineItem } from './assistant.ts'

type Assistant = ReturnType<typeof useAssistant>

function usageLine(usage: Usage | undefined): string {
  if (!usage) return ''
  const tokens = `${usage.inputTokens} in / ${usage.outputTokens} out${usage.estimated ? ' (estimated)' : ''}`
  return tokens
}

export function AiPanel({
  assistant,
  selectionIds,
  slideId,
}: {
  assistant: Assistant
  selectionIds: readonly string[]
  slideId: string
}) {
  const [draft, setDraft] = useState('')
  const { providers, providerId, items, busy } = assistant
  const noProvider = providers !== null && providers.length === 0

  function submit() {
    const text = draft.trim()
    if (!text || busy || !providerId) return
    setDraft('')
    void assistant.send(text, { slideId, selectionIds: [...selectionIds] })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={14} aria-hidden className="text-accent" />
        <span className="font-medium">Assistant</span>
      </div>

      {providers === null && <p className="text-ink-muted">Loading providers…</p>}
      {noProvider && (
        <p className="mb-3 rounded border border-rule bg-hover p-2 text-ink-muted">
          No AI provider is set up yet.{' '}
          <Link to="/settings/ai" className="text-accent underline">
            Add one in Settings › AI
          </Link>
          .
        </p>
      )}
      {providers && providers.length > 0 && (
        <label className="mb-2 flex items-center gap-2">
          <span className="shrink-0 text-ink-muted">Provider</span>
          <select
            aria-label="AI provider"
            className="h-7 min-w-0 flex-1 rounded border border-rule bg-white px-1 text-[12px]"
            value={providerId}
            onChange={(e) => assistant.setProviderId(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.defaultModel}
                {p.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" aria-live="polite" data-testid="ai-timeline">
        {items.length === 0 && providers && providers.length > 0 && (
          <p className="text-ink-muted">
            Ask for a change, or use ✨ Ask AI in the formula bar and the Tools menu. Examples: “add a slide about our pricing”, “make the title shorter”, “chart monthly sales as a line”.
          </p>
        )}
        {items.map((item) => (
          <TimelineRow key={item.id} item={item} assistant={assistant} />
        ))}
      </div>

      <div className="mt-2 border-t border-rule-soft pt-2">
        <label htmlFor="ai-composer" className="sr-only">
          Message the assistant
        </label>
        <textarea
          id="ai-composer"
          aria-label="Message the assistant"
          rows={3}
          value={draft}
          disabled={noProvider || !providerId}
          placeholder="Ask for a change…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="w-full resize-none rounded border border-rule p-1.5 outline-none focus:border-accent disabled:opacity-60"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] text-ink-muted">{busy ? `${busy}…` : 'Enter to send, Shift+Enter for a new line'}</span>
          {busy ? (
            <button type="button" onClick={assistant.stop} className="rounded px-3 py-1 font-medium text-ink-muted hover:bg-hover">
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || noProvider || !providerId}
              className="rounded bg-accent px-3 py-1 font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function TimelineRow({ item, assistant }: { item: TimelineItem; assistant: Assistant }) {
  if (item.kind === 'user') {
    return <div className="ml-6 rounded-lg bg-accent-soft/60 px-2.5 py-1.5 text-ink">{item.text}</div>
  }
  if (item.kind === 'assistant') {
    return <div className="mr-4 whitespace-pre-wrap rounded-lg border border-rule-soft bg-white px-2.5 py-1.5">{item.text || '…'}</div>
  }
  if (item.kind === 'note') {
    return (
      <p role={item.tone === 'error' ? 'alert' : undefined} className={`text-[12px] ${item.tone === 'error' ? 'text-red-700' : 'text-ink-muted'}`}>
        {item.text}
      </p>
    )
  }
  return <CardView card={item} assistant={assistant} />
}

const STATUS_TEXT: Record<ProposalCard['status'], string> = {
  ready: '',
  previewing: 'Previewing',
  applied: 'Applied',
  discarded: 'Discarded',
  failed: 'Failed',
}

function CardView({ card, assistant }: { card: ProposalCard; assistant: Assistant }) {
  const changes = card.ops.length
  const done = card.status === 'applied' || card.status === 'discarded'
  return (
    <section aria-label={`Proposal: ${card.title}`} data-status={card.status} className="rounded-lg border border-rule bg-white p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{card.title}</p>
        {STATUS_TEXT[card.status] && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${card.status === 'applied' ? 'bg-green-100 text-green-800' : card.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-hover text-ink-muted'}`}>
            {STATUS_TEXT[card.status]}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-muted">
        {changes > 0 ? `${changes} change${changes === 1 ? '' : 's'}` : 'No change'}
        {card.model ? ` · ${card.provider ?? 'AI'} (${card.model})` : ''}
        {card.usage ? ` · ${usageLine(card.usage)}` : ''}
      </p>
      {card.warnings.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[12px] text-amber-800">
          {card.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {card.error && (
        <p role="alert" className="mt-1.5 text-[12px] text-red-700">
          {card.error}
        </p>
      )}
      {!done && changes > 0 && card.status !== 'failed' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {card.status !== 'previewing' && (
            <button type="button" onClick={() => assistant.previewCard(card)} className="rounded border border-rule px-2.5 py-1 font-medium hover:bg-hover">
              Preview
            </button>
          )}
          <button type="button" onClick={() => assistant.applyCard(card)} className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:brightness-95">
            Apply
          </button>
          <button type="button" onClick={() => assistant.discardCard(card)} className="rounded px-2.5 py-1 text-ink-muted hover:bg-hover">
            Discard
          </button>
        </div>
      )}
      {card.status === 'failed' && card.retry && (
        <button type="button" onClick={card.retry} className="mt-2 rounded border border-rule px-2.5 py-1 font-medium hover:bg-hover">
          Try again
        </button>
      )}
      {card.status === 'applied' && <p className="mt-1.5 text-[11px] text-ink-muted">Undo with Ctrl+Z or the Undo button.</p>}
    </section>
  )
}
