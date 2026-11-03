// The Theme tab's Brand kit section. Applies a kit the caller can read to this deck, or removes it, and shows what is
// applied: its swatches, fonts and logo (from the deck's brand reference, so it shows the kit as it was applied).
// The change goes through the live document, so Undo works and collaborators see it.
import { useEffect, useState } from 'react'
import type { Deck } from '@sleid/model'
import { applyBrandKitFn, listBrandKitsFn, removeBrandKitFn } from '~/lib/brand-kits.functions'

type KitItem = Awaited<ReturnType<typeof listBrandKitsFn>>[number]

const NONE = ''
const selectClass = 'h-7 w-full rounded border border-rule bg-white px-1.5 text-[13px] outline-none focus:border-accent disabled:bg-hover'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

export function BrandKitSection({ deckId, brand, readOnly }: { deckId: string; brand: Deck['brand']; readOnly: boolean }) {
  const [kits, setKits] = useState<KitItem[] | null>(null)
  const [choice, setChoice] = useState(brand?.brandKitId ?? NONE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listBrandKitsFn()
      .then((list) => live && setKits(list))
      .catch((err: unknown) => live && setError(messageOf(err)))
    return () => {
      live = false
    }
  }, [])

  // Follow the applied kit when it changes (applied here, or by a collaborator).
  useEffect(() => setChoice(brand?.brandKitId ?? NONE), [brand?.brandKitId])

  const applied = brand ? kits?.find((k) => k.id === brand.brandKitId) : undefined
  const swatches = Object.entries(brand?.palette ?? {})
  const canApply = !readOnly && !busy && choice !== NONE && choice !== (brand?.brandKitId ?? NONE)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      await applyBrandKitFn({ data: { deckId, brandKitId: choice } })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await removeBrandKitFn({ data: { deckId } })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Brand kit" data-testid="brand-kit-section" className="mb-5 space-y-3 border-b border-rule pb-4">
      <p className="font-medium">Brand kit</p>
      <label className="block">
        <span className="mb-1 block text-ink-muted">Kit</span>
        <select aria-label="Brand kit" data-testid="brand-kit-select" className={selectClass} value={choice} disabled={readOnly || busy || kits === null} onChange={(e) => setChoice(e.target.value)}>
          <option value={NONE}>{kits === null ? 'Loading kits…' : 'Choose a kit'}</option>
          {(kits ?? []).map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
              {k.owned ? '' : ' (shared)'}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="brand-kit-apply"
          disabled={!canApply}
          onClick={() => void apply()}
          className="rounded bg-accent px-3 py-1 font-medium text-white hover:brightness-95 disabled:opacity-50"
        >
          Apply
        </button>
        <button
          type="button"
          data-testid="brand-kit-remove"
          disabled={readOnly || busy || !brand}
          onClick={() => void remove()}
          className="rounded border border-rule px-3 py-1 font-medium hover:bg-hover disabled:opacity-50"
        >
          Remove
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 px-2 py-1.5 text-[12px] text-red-800">
          {error}
        </p>
      )}
      {brand ? (
        <div data-testid="brand-kit-applied" className="space-y-2 rounded border border-rule-soft p-2">
          <p className="text-[12px] text-ink-muted">Applied: {applied?.name ?? 'a brand kit no longer in your list'}</p>
          {swatches.length > 0 && (
            <div data-testid="brand-kit-swatches" className="flex flex-wrap gap-1">
              {swatches.map(([key, colour]) => (
                <span key={key} title={`${key} ${colour}`} aria-label={`${key} ${colour}`} className="size-5 rounded border border-rule" style={{ background: colour }} />
              ))}
            </div>
          )}
          {brand.fonts && (
            <p className="text-[12px] text-ink-muted">
              Heading {brand.fonts.heading} · Body {brand.fonts.body}
            </p>
          )}
          {brand.logo && (
            <div className="flex h-14 items-center justify-center overflow-hidden rounded bg-hover p-1">
              <img data-testid="brand-kit-logo-preview" src={brand.logo.src} alt="Brand logo" className="h-10 w-auto max-w-full object-contain" />
            </div>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-ink-muted">No brand kit is applied. Applying one replaces the theme and places its logo on the slides.</p>
      )}
      {kits !== null && kits.length === 0 && <p className="text-[12px] text-ink-muted">You have no brand kits yet.</p>}
      <a href="/settings/brand-kits" target="_blank" rel="noopener" data-testid="brand-kit-manage" className="inline-block text-[13px] font-medium text-accent hover:underline">
        Manage brand kits
      </a>
    </section>
  )
}
