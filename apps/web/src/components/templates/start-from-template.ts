// Creates a deck from a template (built-in or the caller's own or instance-shared) and opens it. One start at a time:
// a second click while one is running is ignored, so a double click makes one deck.
import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { newDeckFromTemplateFn } from '~/lib/templates.functions'

export function useStartFromTemplate() {
  const navigate = useNavigate()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  async function start(templateId: string) {
    if (running.current) return
    running.current = true
    setBusyId(templateId)
    setError(null)
    try {
      const { deckId } = await newDeckFromTemplateFn({ data: { templateId } })
      await navigate({ to: '/d/$deckId', params: { deckId } })
    } catch (err) {
      running.current = false
      setBusyId(null)
      setError(err instanceof Error ? err.message : 'The deck could not be created from this template.')
    }
  }

  return { busyId, error, start }
}
