// Default deck, built-in themes and layout placeholders.
import { nanoid } from 'nanoid'
import { CANVAS_HEIGHT, CANVAS_WIDTH, DeckSchema, type Deck, type Element, type Slide, type SlideLayout, type Theme } from './schema.ts'

const SHEETS_LIGHT: Theme = {
  name: 'Sheets Light',
  colors: {
    background: '#ffffff',
    surface: '#f8f9fa',
    text: '#202124',
    muted: '#5f6368',
    accent: '#0b57d0',
    accent2: '#188038',
    accent3: '#e37400',
    accent4: '#a142f4',
  },
  fonts: { heading: 'Inter', body: 'Inter', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  sizes: { title: 120, heading: 72, body: 40, small: 28 },
  radius: 12,
  backgroundStyle: 'solid',
}

export const BUILT_IN_THEMES: readonly Theme[] = [
  SHEETS_LIGHT,
  {
    name: 'Midnight',
    colors: {
      background: '#0f1115',
      surface: '#181b22',
      text: '#f5f7fa',
      muted: '#9aa3b2',
      accent: '#8ab4f8',
      accent2: '#81c995',
      accent3: '#fdd663',
      accent4: '#c58af9',
    },
    fonts: { heading: 'Inter', body: 'Inter', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    sizes: { title: 120, heading: 72, body: 40, small: 28 },
    radius: 16,
    backgroundStyle: 'solid',
  },
  {
    name: 'Warm Paper',
    colors: {
      background: '#faf6ef',
      surface: '#f1e9db',
      text: '#3b2f25',
      muted: '#7a6a58',
      accent: '#b5541c',
      accent2: '#6b8f3a',
      accent3: '#c9962b',
      accent4: '#8a4b7a',
    },
    fonts: { heading: 'Georgia, serif', body: 'Georgia, serif', mono: 'Menlo, monospace' },
    sizes: { title: 116, heading: 72, body: 42, small: 28 },
    radius: 8,
    backgroundStyle: 'solid',
  },
  {
    name: 'High Contrast',
    colors: {
      background: '#000000',
      surface: '#111111',
      text: '#ffffff',
      muted: '#d0d0d0',
      accent: '#ffd400',
      accent2: '#00e5ff',
      accent3: '#ff4d4d',
      accent4: '#7cff6b',
    },
    fonts: { heading: 'Arial, sans-serif', body: 'Arial, sans-serif', mono: 'Courier New, monospace' },
    sizes: { title: 124, heading: 76, body: 44, small: 32 },
    radius: 0,
    backgroundStyle: 'solid',
  },
]

export const DEFAULT_THEME: Theme = SHEETS_LIGHT

export function cloneTheme(theme: Theme): Theme {
  return structuredClone(theme)
}

function emptyRichText() {
  return { type: 'doc' as const, content: [{ type: 'paragraph' as const }] }
}

type IdFor = (index: number) => string

// Placeholder elements for a layout. Styles come from the theme at creation
// time and are stored on each element, so later theme edits do not move them.
// `idFor` lets callers choose deterministic ids (applyOps does this so that
// later ops in the same batch can address placeholders).
export function layoutElements(layout: SlideLayout, theme: Theme, idFor: IdFor = () => nanoid()): Element[] {
  const { colors, fonts, sizes } = theme
  const base = { rotation: 0, locked: false, opacity: 1 }
  const titleStyle = { fontFamily: fonts.heading, fontSize: sizes.heading, color: colors.text }
  const bodyStyle = { fontFamily: fonts.body, fontSize: sizes.body, color: colors.text }

  const specs: Array<Record<string, unknown>> = []
  const text = (
    x: number,
    y: number,
    w: number,
    h: number,
    role: 'title' | 'subtitle' | 'body',
    style: Record<string, unknown>,
    content = emptyRichText(),
  ) => specs.push({ ...base, type: 'text', x, y, w, h, role, content, style })

  switch (layout) {
    case 'title':
      text(160, 340, 1600, 240, 'title', { ...titleStyle, align: 'center', valign: 'bottom' })
      text(160, 600, 1600, 160, 'subtitle', { ...bodyStyle, color: colors.muted, align: 'center', valign: 'top' })
      break
    case 'title-content':
      text(120, 72, 1680, 160, 'title', { ...titleStyle, fontSize: sizes.heading, align: 'left', valign: 'middle' })
      text(120, 272, 1680, 728, 'body', { ...bodyStyle, align: 'left', valign: 'top' })
      break
    case 'two-column':
      text(120, 72, 1680, 160, 'title', { ...titleStyle, fontSize: sizes.heading, align: 'left', valign: 'middle' })
      text(120, 272, 812, 728, 'body', { ...bodyStyle, align: 'left', valign: 'top' })
      text(988, 272, 812, 728, 'body', { ...bodyStyle, align: 'left', valign: 'top' })
      break
    case 'section':
      text(160, 380, 1600, 200, 'title', { ...titleStyle, align: 'left', valign: 'bottom' })
      text(160, 600, 1600, 160, 'subtitle', { ...bodyStyle, color: colors.muted, align: 'left', valign: 'top' })
      break
    case 'blank':
      break
    case 'image-left':
      specs.push({ ...base, type: 'image', x: 0, y: 0, w: CANVAS_WIDTH / 2, h: CANVAS_HEIGHT, src: '', fit: 'cover' })
      text(1040, 300, 800, 200, 'title', { ...titleStyle, fontSize: sizes.heading, align: 'left', valign: 'bottom' })
      text(1040, 520, 800, 480, 'body', { ...bodyStyle, align: 'left', valign: 'top' })
      break
    case 'quote':
      text(240, 300, 1440, 480, 'body', { ...bodyStyle, fontSize: sizes.heading, align: 'center', valign: 'middle' })
      break
  }
  return specs.map((spec, index) => ({ ...spec, id: idFor(index), z: index }) as unknown as Element)
}

// Ids for new entities. Callers outside the model use this rather than importing nanoid.
export function newId(): string {
  return nanoid()
}

export function createSlide(layout: SlideLayout, theme: Theme): Slide {
  return {
    id: newId(),
    layout,
    notes: '',
    transition: 'none',
    autoAnimate: false,
    hidden: false,
    elements: layoutElements(layout, theme),
  }
}

export function createDeck(title = 'Untitled deck'): Deck {
  const theme = cloneTheme(DEFAULT_THEME)
  return DeckSchema.parse({
    id: newId(),
    title,
    size: { w: CANVAS_WIDTH, h: CANVAS_HEIGHT },
    theme,
    sections: [],
    slides: [createSlide('title', theme)],
    version: 1,
  })
}
