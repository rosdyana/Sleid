// Client side of the assistant. One hook holds the timeline (messages and proposal cards), the
// chosen provider, the running request and the preview.
//
// Apply path: a proposal's ops are applied to the local document with origin LOCAL_ORIGIN, the same
// as any edit, so Undo works and the change is saved and sent to collaborators like a human edit. The
// server only proposes; it never writes to the live document. Preview applies the ops to a throwaway
// copy of the document and renders that copy, so nothing is saved until Apply.
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { applyOps, yDocToDeck, type Deck, type Op } from '@sleid/model'
import type { Usage } from '@sleid/llm'
import { runAbilityFn } from '~/lib/ai.functions'
import { listAiProvidersFn } from '~/lib/llm-settings.functions'
import type { ProviderView } from '~/lib/llm-settings.server'
import type { CollabSession } from './collab-session.ts'

export type AbilityName = 'rewriteText' | 'generateSlide' | 'generateChart' | 'generateDiagram' | 'generateTheme' | 'suggestEffects' | 'speakerNotes' | 'altText' | 'explain'

export type CardStatus = 'ready' | 'previewing' | 'applied' | 'discarded' | 'failed'

export interface ProposalCard {
  kind: 'card'
  id: string
  title: string
  ops: Op[]
  warnings: string[]
  usage?: Usage
  provider?: string
  model?: string
  status: CardStatus
  error?: string
  focusSlideId?: string
  /** Set for single-purpose runs, so the card can run again. */
  retry?: () => void
}

export type TimelineItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'note'; id: string; text: string; tone: 'info' | 'error' }
  | ProposalCard

export interface PreviewState {
  cardId: string
  deck: Deck
  slideId: string
}

export interface ProviderInfoWire {
  id: string
  name: string
  kind: string
  model: string
}

/** Server reply shapes. The single-purpose run sends ops as JSON text (see ai.functions.ts). */
interface RunReply {
  proposal: { id: string; ability: string; summary: string; opsJson: string; warnings: string[]; usage: Usage; model: string; focusSlideId?: string; text?: string }
  provider: ProviderInfoWire
}

type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: { id: string; ability: string; summary: string; ops: Op[]; warnings: string[]; usage: Usage; model: string; focusSlideId?: string }; provider: ProviderInfoWire }
  | { type: 'error'; message: string }
  | { type: 'done'; usage: Usage; model: string }

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}

/** Reads the NDJSON stream from the chat route. Calls onEvent for each line. */
export async function streamChat(
  deckId: string,
  body: { providerId: string | null; messages: Array<{ role: 'user' | 'assistant'; content: string }>; focusSlideId?: string; selectionIds?: string[] },
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(detail?.error ?? `The assistant answered ${response.status}`)
  }
  if (!response.body) throw new Error('The assistant sent no reply')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onEvent(JSON.parse(line) as ChatEvent)
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer.trim()) as ChatEvent)
}

export interface AssistantOptions {
  deckId: string
  session: CollabSession
  onOpenPanel: () => void
  toast: (message: string) => void
  /** False for viewers and commenters: no provider list is loaded and nothing is sent. */
  enabled: boolean
}

export function useAssistant({ deckId, session, onOpenPanel, toast, enabled }: AssistantOptions) {
  const [providers, setProviders] = useState<ProviderView[] | null>(null)
  const [providerId, setProviderId] = useState('')
  const [items, setItems] = useState<TimelineItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const seq = useRef(0)
  const nextId = () => `a${seq.current++}`

  useEffect(() => {
    if (!enabled) return
    let alive = true
    listAiProvidersFn()
      .then((res) => {
        if (!alive) return
        setProviders(res.providers)
        const chosen = res.providers.find((p) => p.isDefault) ?? res.providers[0]
        setProviderId(chosen?.id ?? '')
      })
      .catch((err: unknown) => {
        if (alive) setProviders([])
        toast(messageOf(err))
      })
    return () => {
      alive = false
    }
    // Loaded once per editor; the settings page changes providers and the next editor load sees them.
  }, [enabled])

  const push = (item: TimelineItem) => setItems((prev) => [...prev, item])
  const remove = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id))
  const patchCard = (id: string, patch: Partial<ProposalCard>) =>
    setItems((prev) => prev.map((i) => (i.kind === 'card' && i.id === id ? { ...i, ...patch } : i)))
  const patchText = (id: string, text: string) =>
    setItems((prev) => prev.map((i) => (i.id === id && i.kind === 'assistant' ? { ...i, text } : i)))

  /** One single-purpose run (fx bar, Tools menu, context menu). The result is a proposal card. */
  async function run(label: string, ability: AbilityName, input: Record<string, unknown>): Promise<void> {
    onOpenPanel()
    const workingId = nextId()
    push({ kind: 'note', id: workingId, text: `${label}…`, tone: 'info' })
    setBusy(label)
    try {
      const reply = (await runAbilityFn({ data: { deckId, providerId: providerId || null, ability, input } })) as RunReply
      remove(workingId)
      const ops = JSON.parse(reply.proposal.opsJson) as Op[]
      const meta = { usage: reply.proposal.usage, provider: reply.provider.name, model: reply.provider.model }
      if (ops.length === 0 && reply.proposal.text) {
        push({ kind: 'assistant', id: nextId(), text: reply.proposal.text })
      } else {
        push({
          kind: 'card',
          id: reply.proposal.id,
          title: reply.proposal.summary,
          ops,
          warnings: reply.proposal.warnings,
          status: 'ready',
          ...(reply.proposal.focusSlideId ? { focusSlideId: reply.proposal.focusSlideId } : {}),
          ...meta,
          retry: () => void run(label, ability, input),
        })
      }
    } catch (err) {
      remove(workingId)
      const id = nextId()
      push({ kind: 'card', id, title: label, ops: [], warnings: [], status: 'failed', error: messageOf(err), retry: () => void run(label, ability, input) })
    } finally {
      setBusy(null)
    }
  }

  /** A chat message. Text streams into one assistant bubble; tool results become proposal cards. */
  async function send(text: string, focus: { slideId?: string; selectionIds?: string[] }): Promise<void> {
    if (busy) return
    onOpenPanel()
    const history = [...items, { kind: 'user' as const, id: 'pending', text }]
      .filter((i): i is Extract<TimelineItem, { kind: 'user' | 'assistant' }> => (i.kind === 'user' || i.kind === 'assistant') && i.text.length > 0)
      .slice(-12)
      .map((i) => ({ role: i.kind === 'user' ? ('user' as const) : ('assistant' as const), content: i.text }))
    push({ kind: 'user', id: nextId(), text })
    const assistantId = nextId()
    push({ kind: 'assistant', id: assistantId, text: '' })
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy('Assistant')
    let streamed = ''
    try {
      await streamChat(
        deckId,
        {
          providerId: providerId || null,
          messages: history,
          ...(focus.slideId ? { focusSlideId: focus.slideId } : {}),
          ...(focus.selectionIds?.length ? { selectionIds: focus.selectionIds } : {}),
        },
        controller.signal,
        (ev) => {
          if (ev.type === 'text') {
            streamed += ev.delta
            patchText(assistantId, streamed)
          } else if (ev.type === 'tool') {
            push({ kind: 'note', id: nextId(), text: `Preparing a change (${ev.name.replace(/_/g, ' ')})…`, tone: 'info' })
          } else if (ev.type === 'proposal') {
            const p = ev.proposal
            push({
              kind: 'card',
              id: p.id,
              title: p.summary,
              ops: p.ops,
              warnings: p.warnings,
              usage: p.usage,
              provider: ev.provider.name,
              model: ev.provider.model,
              status: 'ready',
              ...(p.focusSlideId ? { focusSlideId: p.focusSlideId } : {}),
            })
          } else if (ev.type === 'error') {
            push({ kind: 'note', id: nextId(), text: ev.message, tone: 'error' })
          }
        },
      )
    } catch (err) {
      if (!controller.signal.aborted) push({ kind: 'note', id: nextId(), text: messageOf(err), tone: 'error' })
    } finally {
      controllerRef.current = null
      setBusy(null)
      if (!streamed) remove(assistantId)
      if (controller.signal.aborted) push({ kind: 'note', id: nextId(), text: 'Stopped.', tone: 'info' })
    }
  }

  function stop() {
    controllerRef.current?.abort()
  }

  /** The deck with the card's ops applied to a throwaway copy. Nothing is saved. */
  function previewCard(card: ProposalCard): void {
    const clone = new Y.Doc()
    try {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(session.doc))
      applyOps(clone, card.ops, 'preview')
      const next = yDocToDeck(clone)
      const slideId = card.focusSlideId && next.slides.some((s) => s.id === card.focusSlideId) ? card.focusSlideId : (next.slides[0]?.id ?? '')
      setPreview({ cardId: card.id, deck: next, slideId })
      patchCard(card.id, { status: 'previewing' })
    } catch (err) {
      patchCard(card.id, { status: 'failed', error: `This change no longer fits the deck: ${messageOf(err)}` })
    } finally {
      clone.destroy()
    }
  }

  function setPreviewSlide(slideId: string): void {
    setPreview((p) => (p ? { ...p, slideId } : p))
  }

  function findCard(cardId: string): ProposalCard | undefined {
    const found = items.find((i) => i.kind === 'card' && i.id === cardId)
    return found && found.kind === 'card' ? found : undefined
  }

  function clearPreview(cardId?: string): void {
    setPreview((p) => (p && (cardId === undefined || p.cardId === cardId) ? null : p))
  }

  /** Applies the card through the live document (origin local, so it is one undo step). */
  function applyCard(card: ProposalCard): void {
    try {
      session.apply(card.ops)
      patchCard(card.id, { status: 'applied', error: undefined })
      clearPreview(card.id)
      toast(`Applied: ${card.title}. Undo with Ctrl+Z.`)
    } catch (err) {
      patchCard(card.id, { status: 'failed', error: `Could not apply: ${messageOf(err)}` })
    }
  }

  function discardCard(card: ProposalCard): void {
    patchCard(card.id, { status: 'discarded' })
    clearPreview(card.id)
  }

  return {
    providers,
    providerId,
    setProviderId,
    items,
    busy,
    preview,
    run,
    send,
    stop,
    previewCard,
    setPreviewSlide,
    findCard,
    clearPreview,
    applyCard,
    discardCard,
    /** Deck to show: the preview's copy while a preview is open, otherwise the live deck. */
    viewDeck: (live: Deck): Deck => preview?.deck ?? live,
  }
}
