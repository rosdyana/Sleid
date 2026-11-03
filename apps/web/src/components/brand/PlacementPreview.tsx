// A 16:9 slide with the logo placed by a kit's placement (corner, size as a share of the width, margin in canvas
// pixels on a 1920 x 1080 slide). Only a preview: the slide rule (which slides show the logo) is written below it.
import type { CSSProperties } from 'react'
import type { LogoPlacement } from '@sleid/model'

const SLIDE_W = 1920
const SLIDE_H = 1080

const SLIDES_TEXT: Record<LogoPlacement['slides'], string> = {
  all: 'Shown on every slide.',
  'all-but-title': 'Shown on every slide except title slides.',
  none: 'Not shown on slides.',
}

export function PlacementPreview({ placement, logoSrc }: { placement: LogoPlacement; logoSrc: string | null }) {
  const vertical = placement.corner.startsWith('t') ? { top: `${(placement.margin / SLIDE_H) * 100}%` } : { bottom: `${(placement.margin / SLIDE_H) * 100}%` }
  const horizontal = placement.corner.endsWith('l') ? { left: `${(placement.margin / SLIDE_W) * 100}%` } : { right: `${(placement.margin / SLIDE_W) * 100}%` }
  const logoStyle: CSSProperties = { position: 'absolute', width: `${placement.widthPct}%`, ...vertical, ...horizontal }
  return (
    <div>
      <div data-testid="kit-placement-preview" className="relative aspect-video w-full overflow-hidden rounded border border-rule bg-white">
        <div className="absolute left-[8%] top-[30%] h-[8%] w-[50%] rounded bg-hover" aria-hidden="true" />
        <div className="absolute left-[8%] top-[42%] h-[4%] w-[70%] rounded bg-hover" aria-hidden="true" />
        <div style={logoStyle} className="grid place-items-center">
          {logoSrc ? (
            <img src={logoSrc} alt="" className="block w-full" />
          ) : (
            <span className="block w-full rounded bg-hover py-1 text-center text-[10px] text-ink-muted">Logo</span>
          )}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-ink-muted">{SLIDES_TEXT[placement.slides]}</p>
    </div>
  )
}
