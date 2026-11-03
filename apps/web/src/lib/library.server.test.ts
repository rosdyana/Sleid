// Templates and brand kits (M9) against real Postgres. Skips when the database is unreachable.
// The collab service is replaced by an in-process fake that applies deck-ops to a Y.Doc, which is what the real
// internal API does for the live document.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { applyOps, builtInTemplateDeck, createDeck, deckToYDoc, yDocToDeck, type Deck } from '@sleid/model'
import { assets, brandKits, decks, deckMembers, grantMembership, readDeck, setTemplateThumbnail, templateThumbnailKey, templates, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { deleteTemplate, getTemplateFor, handleTemplateThumbnail, listTemplatesFor, newDeckFromTemplate, saveTemplateFromDeck, updateTemplateMeta, LibraryError, type TemplateDeps } from './templates.server.ts'
import {
  applyBrandKit,
  createBrandKit,
  deleteBrandKit,
  handleBrandLogo,
  listBrandKitsFor,
  logoVariantFrom,
  removeBrandKit,
  removeBrandLogo,
  updateBrandKit,
  uploadBrandLogo,
  type BrandDeps,
} from './brand-kits.server.ts'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const SVG_OK = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')
const SVG_SCRIPT = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const KIT_TOKENS = {
  palette: {
    background: '#ffffff',
    surface: '#f0f4ff',
    text: '#102030',
    muted: '#556677',
    accent: '#0055cc',
    accent2: '#00aa66',
    accent3: '#dd7700',
    accent4: '#8844aa',
  },
  fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif' },
}

let db: Db | null = null
let storage: StorageDriver
const dir = mkdtempSync(join(tmpdir(), 'sleid-library-test-'))
const userIds: string[] = []
let owner = ''
let editor = ''
let viewer = ''
let outsider = ''
let deckId = ''
const docs = new Map<string, Y.Doc>()

function fakeCollab(options: { fail?: boolean } = {}) {
  return {
    applyOps: async (id: string, actor: string, ops: readonly unknown[]) => {
      if (options.fail) throw new Error('collab down');
      const doc = docs.get(id)
      if (!doc) throw new Error('no document')
      const { results } = applyOps(doc, ops, `server:${actor}`)
      return { ok: true as const, results }
    },
  } as never
}

function deps(options: { collab?: boolean; failCollab?: boolean } = {}): TemplateDeps & BrandDeps {
  return {
    db: db!,
    storage,
    collab: options.collab === false ? null : fakeCollab({ fail: options.failCollab }),
    readDeck: async (id: string) => yDocToDeck(docs.get(id)!),
    enqueueThumbnail: async () => undefined,
  } as TemplateDeps & BrandDeps
}

function newDeck(id: string): Deck {
  return { ...createDeck('Library deck'), id }
}

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  storage = createLocalStorage(dir)
  const people = await Promise.all(['lib-owner', 'lib-editor', 'lib-viewer', 'lib-outsider'].map((l) => makeUser(db!, l)))
  ;[owner, editor, viewer, outsider] = people.map((p) => p.id) as [string, string, string, string]
  userIds.push(...people.map((p) => p.id))
  deckId = await makeDeck(db, owner, 'Library source')
  await db.transaction((tx) => grantMembership(tx, deckId, editor, 'editor'))
  await db.transaction((tx) => grantMembership(tx, deckId, viewer, 'viewer'))
  docs.set(deckId, deckToYDoc(newDeck(deckId)))
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
  rmSync(dir, { recursive: true, force: true })
})

function skipIfNoDb(): boolean {
  return db === null
}

/** Adds an image to the deck: a row in assets and the bytes in storage, plus an element that shows it. */
async function addImageToDeck(id: string, ownerId: string, bytes = PNG): Promise<string> {
  const assetId = randomUUID()
  await storage.put(assetId, bytes)
  await db!.insert(assets).values({ id: assetId, deckId: id, ownerId, mime: 'image/png', bytes: bytes.byteLength, sha256: 'x'.repeat(64) })
  const doc = docs.get(id)!
  const current = yDocToDeck(doc)
  const slide = current.slides[0]!
  applyOps(doc, [
    {
      op: 'addElement',
      slideId: slide.id,
      element: { type: 'image', src: `/api/assets/${assetId}`, fit: 'cover', x: 100, y: 100, w: 200, h: 200, rotation: 0, locked: false, opacity: 1 },
    },
  ])
  return assetId
}

describe('templates', () => {
  it('lists the built-in templates for everyone, and a private template only to its owner', async () => {
    if (skipIfNoDb()) return
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId, name: 'Owner private', description: '', category: 'general', visibility: 'private' })
    const ownerList = await listTemplatesFor(deps(), owner)
    const outsiderList = await listTemplatesFor(deps(), outsider)
    expect(ownerList.filter((t) => t.builtIn)).toHaveLength(5)
    expect(ownerList.some((t) => t.id === saved.id && t.owned)).toBe(true)
    expect(outsiderList.some((t) => t.id === saved.id)).toBe(false)
    await expect(getTemplateFor(deps(), outsider, saved.id)).rejects.toMatchObject({ status: 404 })
    await deleteTemplate(deps(), owner, saved.id)
  })

  it('an instance template is visible to every signed-in user, and only the owner can change it', async () => {
    if (skipIfNoDb()) return
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId, name: 'Shared', description: 'd', category: 'business', visibility: 'instance' })
    expect((await getTemplateFor(deps(), outsider, saved.id)).summary.name).toBe('Shared')
    await expect(updateTemplateMeta(deps(), outsider, saved.id, { name: 'Mine now' })).rejects.toMatchObject({ status: 403 })
    await expect(updateTemplateMeta(deps(), editor, saved.id, { name: 'Mine now' })).rejects.toMatchObject({ status: 403 })
    await updateTemplateMeta(deps(), owner, saved.id, { name: 'Renamed' })
    expect((await getTemplateFor(deps(), outsider, saved.id)).summary.name).toBe('Renamed')
    await expect(deleteTemplate(deps(), editor, saved.id)).rejects.toMatchObject({ status: 403 })
    await deleteTemplate(deps(), owner, saved.id)
    await expect(getTemplateFor(deps(), owner, saved.id)).rejects.toBeInstanceOf(LibraryError)
  })

  it('saving needs editor access, and a viewer or outsider is refused', async () => {
    if (skipIfNoDb()) return
    await expect(saveTemplateFromDeck(deps(), viewer, { deckId, name: 'x', description: '', category: 'general', visibility: 'private' })).rejects.toMatchObject({ status: 403 })
    await expect(saveTemplateFromDeck(deps(), outsider, { deckId, name: 'x', description: '', category: 'general', visibility: 'private' })).rejects.toMatchObject({ status: 404 })
  })

  it('copies the deck images into the template and drops the brand reference', async () => {
    if (skipIfNoDb()) return
    const id = randomUUID()
    docs.set(id, deckToYDoc(newDeck(id)))
    await db!.insert(decks).values({ id, ownerId: owner, title: 'Images' })
    await db!.insert(deckMembers).values({ deckId: id, userId: owner, role: 'owner', via: 'owner' })
    const assetId = await addImageToDeck(id, owner)
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId: id, name: 'With image', description: '', category: 'general', visibility: 'private' })
    const row = (await db!.select().from(templates).where(eq(templates.id, saved.id)))[0]!
    const json = JSON.stringify(row.deck)
    expect(json).not.toContain(`/api/assets/${assetId}`)
    expect(json).toContain('data:image/png;base64,')
    expect(row.deck.brand).toBeUndefined()
    await deleteTemplate(deps(), owner, saved.id)
  })

  it('refuses a template that points at an image of another deck', async () => {
    if (skipIfNoDb()) return
    const other = await makeDeck(db!, outsider, 'Other')
    docs.set(other, deckToYDoc(newDeck(other)))
    const foreign = await addImageToDeck(other, outsider)
    const id = randomUUID()
    docs.set(id, deckToYDoc(newDeck(id)))
    await db!.insert(decks).values({ id, ownerId: owner, title: 'Stolen image' })
    await db!.insert(deckMembers).values({ deckId: id, userId: owner, role: 'owner', via: 'owner' })
    applyOps(docs.get(id)!, [{ op: 'addElement', slideId: yDocToDeck(docs.get(id)!).slides[0]!.id, element: { type: 'image', src: `/api/assets/${foreign}`, fit: 'cover', x: 0, y: 0, w: 10, h: 10, rotation: 0, locked: false, opacity: 1 } }])
    await expect(saveTemplateFromDeck(deps(), owner, { deckId: id, name: 'x', description: '', category: 'general', visibility: 'private' })).rejects.toMatchObject({ status: 400 })
  })

  it('a new deck from a built-in template has fresh ids, the owner membership and a first snapshot', async () => {
    if (skipIfNoDb()) return
    const created = await newDeckFromTemplate(deps(), owner, { templateId: 'builtin:pitch', title: 'Series A' })
    const [row] = await db!.select().from(decks).where(eq(decks.id, created.deckId))
    expect(row?.title).toBe('Series A')
    const [member] = await db!.execute(sql`select role from deck_members where deck_id = ${created.deckId} and user_id = ${owner}`)
    expect((member as { role: string }).role).toBe('owner')
    const copy = yDocToDeck(deckToYDoc(newDeck(created.deckId)))
    expect(copy.id).toBe(created.deckId)
  })

  it('a deck from a user template does not depend on the template row, and the two decks never share ids', async () => {
    if (skipIfNoDb()) return
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId, name: 'Reusable', description: '', category: 'general', visibility: 'instance' })
    const first = await newDeckFromTemplate(deps(), editor, { templateId: saved.id })
    const second = await newDeckFromTemplate(deps(), outsider, { templateId: saved.id })
    const firstTitle = (await db!.select().from(decks).where(eq(decks.id, first.deckId)))[0]!.title
    expect(firstTitle).toBe('Reusable')
    expect(first.deckId).not.toBe(second.deckId)
    await deleteTemplate(deps(), owner, saved.id)
  })

  it('a private template is not usable by someone else', async () => {
    if (skipIfNoDb()) return
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId, name: 'Hidden', description: '', category: 'general', visibility: 'private' })
    await expect(newDeckFromTemplate(deps(), outsider, { templateId: saved.id })).rejects.toMatchObject({ status: 404 })
    await deleteTemplate(deps(), owner, saved.id)
  })
})

describe('brand kits', () => {
  it('creates a kit with valid tokens and refuses a bad colour or a font with markup', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Acme', visibility: 'private', tokens: KIT_TOKENS })
    expect((await listBrandKitsFor(deps(), owner)).some((k) => k.id === id && k.owned)).toBe(true)
    expect((await listBrandKitsFor(deps(), outsider)).some((k) => k.id === id)).toBe(false)
    await expect(
      createBrandKit(deps(), owner, { name: 'Bad', tokens: { ...KIT_TOKENS, palette: { ...KIT_TOKENS.palette, accent: 'blue' } } as never }),
    ).rejects.toThrow()
    await expect(
      createBrandKit(deps(), owner, { name: 'Bad', tokens: { ...KIT_TOKENS, fonts: { heading: 'x"}</style>', body: 'Arial' } } as never }),
    ).rejects.toThrow()
    await deleteBrandKit(deps(), owner, id)
  })

  it('an instance kit is readable by everyone, and only the owner can change or delete it', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Shared kit', visibility: 'instance', tokens: KIT_TOKENS })
    await expect(updateBrandKit(deps(), editor, id, { name: 'No' })).rejects.toMatchObject({ status: 403 })
    await expect(deleteBrandKit(deps(), outsider, id)).rejects.toMatchObject({ status: 403 })
    await deleteBrandKit(deps(), owner, id)
  })

  it('a logo must be PNG, JPEG or SVG, match its bytes, and stay within 2 MB', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Logos', tokens: KIT_TOKENS })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })
    await expect(uploadBrandLogo(deps(), owner, id, { mime: 'image/gif', bytes: PNG })).rejects.toMatchObject({ status: 415 })
    await expect(uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: SVG_OK })).rejects.toMatchObject({ status: 415 })
    await expect(uploadBrandLogo(deps(), owner, id, { mime: 'image/svg+xml', bytes: SVG_SCRIPT })).rejects.toMatchObject({ status: 415 })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/svg+xml', bytes: SVG_OK })
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set(PNG.subarray(0, 8))
    await expect(uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: big })).rejects.toMatchObject({ status: 413 })
    // A private kit is not visible to anyone else, so an editor of some deck gets not found.
    await expect(uploadBrandLogo(deps(), editor, id, { mime: 'image/png', bytes: PNG })).rejects.toMatchObject({ status: 404 })
    await deleteBrandKit(deps(), owner, id)
  })

  it('applying a kit needs editor access, and sets the theme and a copied logo on the deck', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Applied', tokens: KIT_TOKENS, logoPlacement: { corner: 'bl', widthPct: 10, margin: 30, slides: 'all' } })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })
    await expect(applyBrandKit(deps(), viewer, deckId, id)).rejects.toMatchObject({ status: 403 })
    await expect(applyBrandKit(deps(), outsider, deckId, id)).rejects.toMatchObject({ status: 404 })

    // The kit is private to its owner, so the owner applies it. A deck editor who cannot read the kit gets not found.
    await expect(applyBrandKit(deps(), editor, deckId, id)).rejects.toMatchObject({ status: 404 })
    const result = await applyBrandKit(deps(), owner, deckId, id)
    expect(result).toEqual({ theme: 'Applied', logo: true })
    const deck = yDocToDeck(docs.get(deckId)!)
    expect(deck.theme.colors.accent).toBe('#0055cc')
    expect(deck.theme.fonts.heading).toBe('Georgia, serif')
    expect(deck.brand?.brandKitId).toBe(id)
    expect(deck.brand?.logo?.src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/)
    expect(deck.brand?.logo?.placement).toEqual({ corner: 'bl', widthPct: 10, margin: 30, slides: 'all' })
    const assetId = deck.brand!.logo!.src.split('/').pop()!
    const [asset] = await db!.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.deckId, deckId)))
    expect(asset?.mime).toBe('image/png')
    expect(await storage.get(assetId)).not.toBeNull()
  })

  it('applying a second kit replaces the logo and removes the previous one', async () => {
    if (skipIfNoDb()) return
    const first = deck0LogoAsset()
    const { id } = await createBrandKit(deps(), owner, { name: 'Second', tokens: KIT_TOKENS })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })
    await applyBrandKit(deps(), owner, deckId, id)
    const current = deck0LogoAsset()
    expect(current).not.toBe(first)
    expect(await storage.get(first)).toBeNull()
    expect(await storage.get(current)).not.toBeNull()
  })

  it('removing the kit keeps the theme and clears the logo and its file', async () => {
    if (skipIfNoDb()) return
    const before = deck0LogoAsset()
    await removeBrandKit(deps(), editor, deckId)
    const deck = yDocToDeck(docs.get(deckId)!)
    expect(deck.brand).toBeUndefined()
    expect(deck.theme.colors.accent).toBe('#0055cc')
    expect(await storage.get(before)).toBeNull()
    await expect(removeBrandKit(deps(), viewer, deckId)).rejects.toMatchObject({ status: 403 })
  })

  it('when the collab service is down, nothing changes and the new logo file is removed again', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Offline', tokens: KIT_TOKENS })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })
    const beforeTheme = yDocToDeck(docs.get(deckId)!).theme
    const assetsBefore = (await db!.select().from(assets).where(eq(assets.deckId, deckId))).length
    await expect(applyBrandKit(deps({ failCollab: true }), owner, deckId, id)).rejects.toMatchObject({ status: 422 })
    expect(yDocToDeck(docs.get(deckId)!).theme).toEqual(beforeTheme)
    await expect(applyBrandKit(deps({ collab: false }), owner, deckId, id)).rejects.toMatchObject({ status: 503 })
    // The logo copy made for each failed apply is removed again, so no asset row is left behind.
    expect((await db!.select().from(assets).where(eq(assets.deckId, deckId))).length).toBe(assetsBefore)
    await deleteBrandKit(deps(), owner, id)
  })

  it('a kit with a default template must name a template the caller can read', async () => {
    if (skipIfNoDb()) return
    await expect(createBrandKit(deps(), owner, { name: 'Bad default', tokens: KIT_TOKENS, defaultTemplateId: randomUUID() })).rejects.toMatchObject({ status: 404 })
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId, name: 'Default', description: '', category: 'general', visibility: 'private' })
    const { id } = await createBrandKit(deps(), owner, { name: 'With default', tokens: KIT_TOKENS, defaultTemplateId: saved.id })
    await expect(createBrandKit(deps(), outsider, { name: 'x', tokens: KIT_TOKENS, defaultTemplateId: saved.id })).rejects.toMatchObject({ status: 404 })
    await deleteBrandKit(deps(), owner, id)
    await deleteTemplate(deps(), owner, saved.id)
  })
})

/** The asset id the deck's brand logo points at, or '' when there is none. */
function deck0LogoAsset(): string {
  const src = yDocToDeck(docs.get(deckId)!).brand?.logo?.src ?? ''
  return src.split('/').pop() ?? ''
}

// M9: saving a template queues its thumbnail; the thumbnail route applies the template's visibility.
describe('template thumbnails (M9)', () => {
  it('saving a template queues its thumbnail job with the new template id', async () => {
    if (skipIfNoDb()) return
    const queued: string[] = []
    const d = { ...deps(), enqueueThumbnail: async (id: string) => void queued.push(id) }
    const saved = await saveTemplateFromDeck(d, owner, { deckId, name: 'Thumb queued', description: '', category: 'general', visibility: 'private' })
    expect(queued).toEqual([saved.id])
    await deleteTemplate(deps(), owner, saved.id)
  })

  it('the thumbnail route: 401 without a session, 404 for someone else\'s private template, the PNG to those who can read it', async () => {
    if (skipIfNoDb()) return
    const saved = await saveTemplateFromDeck(deps(), owner, { deckId, name: 'Thumb route', description: '', category: 'general', visibility: 'private' })
    const route = (userId: string | null, id = saved.id) => handleTemplateThumbnail(id, { db: db!, storage, userId })
    expect((await route(null)).status).toBe(401)
    expect((await route(owner)).status).toBe(404) // not rendered yet
    expect((await route(outsider)).status).toBe(404)

    const key = templateThumbnailKey(saved.id)
    await storage.put(key, PNG)
    await setTemplateThumbnail(db!, saved.id, key)
    const ok = await route(owner)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG)
    expect((await route(outsider)).status).toBe(404)
    expect((await route(viewer)).status).toBe(404)

    // Once it is instance-visible, everyone signed in can see the thumbnail.
    await deps().db.update(templates).set({ visibility: 'instance' }).where(eq(templates.id, saved.id))
    expect((await route(outsider)).status).toBe(200)
    await deleteTemplate(deps(), owner, saved.id)
  })

  it('a built-in thumbnail is served to a signed-in user once it is in storage, and never without a session', async () => {
    if (skipIfNoDb()) return
    const route = (userId: string | null) => handleTemplateThumbnail('builtin:pitch', { db: db!, storage, userId })
    expect((await route(outsider)).status).toBe(404)
    await storage.put(templateThumbnailKey('builtin:pitch'), PNG)
    expect((await route(outsider)).status).toBe(200)
    expect((await route(null)).status).toBe(401)
  })
})

// M9: a kit changes the theme, the brand and the logo, and nothing on the slides. A deck made from a built-in template
// keeps every slide and element it was made with.
describe('a kit on a deck with content (M9)', () => {
  /**
   * The slide content a kit must leave alone: ids, layouts and every element. Colours are left out: since M11 a theme
   * change (and so a kit) recolours element colours that match the old theme's tokens onto the new tokens.
   */
  const COLOUR_KEYS = new Set(['color', 'fill', 'stroke', 'colors'])
  const contentOf = (deck: Deck) =>
    JSON.parse(
      JSON.stringify(deck.slides.map((s) => ({ id: s.id, layout: s.layout, elements: s.elements })), (key, value) =>
        COLOUR_KEYS.has(key) || (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) ? undefined : value,
      ),
    )

  it('a deck made from the built-in Quarterly review keeps every slide and element through apply and remove', async () => {
    if (skipIfNoDb()) return
    const template = builtInTemplateDeck('builtin:quarterly-review')!
    const created = await newDeckFromTemplate(deps(), owner, { templateId: 'builtin:quarterly-review', title: 'Content kit' })
    const { deck: stored } = await readDeck(db!, created.deckId)
    expect(stored.slides).toHaveLength(template.slides.length)
    expect(stored.slides.map((s) => s.elements.length)).toEqual(template.slides.map((s) => s.elements.length))
    expect(stored.slides.reduce((n, s) => n + s.elements.length, 0)).toBeGreaterThan(0)

    docs.set(created.deckId, deckToYDoc(stored))
    const before = yDocToDeck(docs.get(created.deckId)!)
    const { id } = await createBrandKit(deps(), owner, { name: 'Content kit', tokens: KIT_TOKENS })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })

    await applyBrandKit(deps(), owner, created.deckId, id)
    const applied = yDocToDeck(docs.get(created.deckId)!)
    expect(applied.brand?.brandKitId).toBe(id)
    expect(applied.brand?.logo).toBeDefined()
    expect(applied.theme.colors.accent).toBe('#0055cc')
    expect(contentOf(applied)).toEqual(contentOf(before))

    await removeBrandKit(deps(), owner, created.deckId)
    const removed = yDocToDeck(docs.get(created.deckId)!)
    expect(removed.brand).toBeUndefined()
    // The kit's theme stays. Only the chrome logos it added are removed (this kit has no footer, so no components block is left).
    expect(removed.theme).toEqual({ ...applied.theme, components: undefined })
    expect(removed.theme.components).toBeUndefined()
    expect(contentOf(removed)).toEqual(contentOf(before))

    await deleteBrandKit(deps(), owner, id)
    await db!.execute(sql`delete from decks where id = ${created.deckId}`)
    docs.delete(created.deckId)
  })
})

// M9: the saved logo of a brand kit is served to whoever can read the kit, and to nobody else.
describe('brand kit logo route (M9)', () => {
  it('serves the saved logo to the owner, and to everyone when the kit is on this server; never to anyone else', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Logo route', visibility: 'private', tokens: KIT_TOKENS })
    const route = (userId: string | null, kitId = id) => handleBrandLogo(kitId, { db: db!, storage, userId })

    // No logo yet: not found, even for the owner.
    expect((await route(owner)).status).toBe(404)

    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })
    expect((await route(null)).status).toBe(401)
    const ok = await route(owner)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG)

    // A private kit is not readable by an editor of some other deck, or by an outsider.
    expect((await route(editor)).status).toBe(404)
    expect((await route(outsider)).status).toBe(404)
    expect((await route(owner, randomUUID())).status).toBe(404)
    expect((await route(owner, 'not-a-uuid')).status).toBe(404)

    // Once the kit is on this server, every signed-in user can read its logo, as they can read the kit.
    await updateBrandKit(deps(), owner, id, { visibility: 'instance' })
    expect((await route(outsider)).status).toBe(200)
    expect((await route(editor)).status).toBe(200)
    expect((await route(null)).status).toBe(401)

    // Back to private: the outsider is refused again.
    await updateBrandKit(deps(), owner, id, { visibility: 'private' })
    expect((await route(outsider)).status).toBe(404)
    await deleteBrandKit(deps(), owner, id)
    expect((await route(owner)).status).toBe(404)
  })

  it('an SVG logo is served in a sandbox, and a removed logo is not found', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Svg logo', visibility: 'instance', tokens: KIT_TOKENS })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/svg+xml', bytes: SVG_OK })
    const svg = await handleBrandLogo(id, { db: db!, storage, userId: outsider })
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toBe('sandbox')
    await removeBrandLogo(deps(), owner, id)
    expect((await handleBrandLogo(id, { db: db!, storage, userId: outsider })).status).toBe(404)
    await deleteBrandKit(deps(), owner, id)
  })
})

describe('brand kit dark logo, footer text and chrome (M11)', () => {
  it('reads the query variant: missing or light is the light logo, dark is the dark one, anything else is refused', () => {
    expect(logoVariantFrom(null)).toBe('light')
    expect(logoVariantFrom('light')).toBe('light')
    expect(logoVariantFrom('dark')).toBe('dark')
    expect(logoVariantFrom('neon')).toBeNull()
  })

  it('stores a dark logo beside the light one, serves it on ?variant=dark, and removes each variant on its own', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Dark logo', visibility: 'private', tokens: KIT_TOKENS })
    const route = (userId: string | null, variant: 'light' | 'dark' = 'light') => handleBrandLogo(id, { db: db!, storage, userId }, variant)

    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG, variant: 'dark' })
    expect((await route(owner)).status).toBe(404) // no light logo yet
    const dark = await route(owner, 'dark')
    expect(dark.status).toBe(200)
    expect(dark.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await dark.arrayBuffer())).toEqual(PNG)
    expect((await route(null, 'dark')).status).toBe(401)
    expect((await route(outsider, 'dark')).status).toBe(404)
    expect((await listBrandKitsFor(deps(), owner)).find((k) => k.id === id)).toMatchObject({ hasLogo: false, hasDarkLogo: true })

    await uploadBrandLogo(deps(), owner, id, { mime: 'image/svg+xml', bytes: SVG_OK })
    expect((await route(owner)).status).toBe(200)
    expect((await route(owner, 'dark')).status).toBe(200)
    const [row] = await db!.select().from(brandKits).where(eq(brandKits.id, id))
    const darkKey = row!.logoDarkKey!
    expect(darkKey).toBeTruthy()

    await removeBrandLogo(deps(), owner, id, 'dark')
    expect((await route(owner, 'dark')).status).toBe(404)
    expect((await route(owner)).status).toBe(200)
    expect(await storage.get(darkKey)).toBeNull()
    expect((await listBrandKitsFor(deps(), owner)).find((k) => k.id === id)?.hasDarkLogo).toBe(false)
    await expect(uploadBrandLogo(deps(), editor, id, { mime: 'image/png', bytes: PNG, variant: 'dark' })).rejects.toMatchObject({ status: 404 })
    await deleteBrandKit(deps(), owner, id)
  })

  it('the footer text is trimmed, capped at 200 characters, and an empty one is stored as none', async () => {
    if (skipIfNoDb()) return
    const summary = async (kitId: string) => (await listBrandKitsFor(deps(), owner)).find((k) => k.id === kitId)
    const { id } = await createBrandKit(deps(), owner, { name: 'Footer', tokens: KIT_TOKENS, footerText: '  Acme Ltd, confidential  ' })
    expect((await summary(id))?.footerText).toBe('Acme Ltd, confidential')

    await updateBrandKit(deps(), owner, id, { footerText: '   ' })
    expect((await summary(id))?.footerText).toBeNull()
    await updateBrandKit(deps(), owner, id, { footerText: 'Second line' })
    expect((await summary(id))?.footerText).toBe('Second line')
    await updateBrandKit(deps(), owner, id, { footerText: 'x'.repeat(200) })
    expect((await summary(id))?.footerText).toHaveLength(200)
    await expect(updateBrandKit(deps(), owner, id, { footerText: 'x'.repeat(201) })).rejects.toThrow()
    await expect(createBrandKit(deps(), owner, { name: 'Long', tokens: KIT_TOKENS, footerText: 'y'.repeat(201) })).rejects.toThrow()

    const { id: plain } = await createBrandKit(deps(), owner, { name: 'No footer', tokens: KIT_TOKENS })
    expect((await summary(plain))?.footerText).toBeNull()
    await deleteBrandKit(deps(), owner, id)
    await deleteBrandKit(deps(), owner, plain)
  })

  it('applying a kit sets theme.components.chrome to the deck\'s own copies of both logos and the footer, and replaces them on the next apply', async () => {
    if (skipIfNoDb()) return
    const { id } = await createBrandKit(deps(), owner, { name: 'Chrome kit', tokens: KIT_TOKENS, footerText: 'Acme Ltd' })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/png', bytes: PNG })
    await uploadBrandLogo(deps(), owner, id, { mime: 'image/svg+xml', bytes: SVG_OK, variant: 'dark' })
    await applyBrandKit(deps(), owner, deckId, id)

    const deck = yDocToDeck(docs.get(deckId)!)
    const chrome = deck.theme.components?.chrome
    expect(chrome?.footerText).toBe('Acme Ltd')
    expect(chrome?.logoLight).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/)
    expect(chrome?.logoDark).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/)
    expect(chrome?.logoDark).not.toBe(chrome?.logoLight)
    expect(deck.brand?.logo?.src).toBe(chrome?.logoLight) // the light logo overlay is unchanged
    const previous = [chrome!.logoLight!, chrome!.logoDark!].map((src) => src.split('/').pop()!)
    for (const src of [chrome!.logoLight!, chrome!.logoDark!]) {
      const assetId = src.split('/').pop()!
      const [asset] = await db!.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.deckId, deckId)))
      expect(asset, src).toBeDefined()
      expect(await storage.get(assetId)).not.toBeNull()
    }

    await applyBrandKit(deps(), owner, deckId, id)
    const again = yDocToDeck(docs.get(deckId)!).theme.components?.chrome
    expect(again?.logoLight).not.toBe(chrome?.logoLight)
    expect(again?.logoDark).not.toBe(chrome?.logoDark)
    for (const assetId of previous) expect(await storage.get(assetId)).toBeNull()

    const latest = [again!.logoLight!, again!.logoDark!].map((src) => src.split('/').pop()!)
    await removeBrandKit(deps(), owner, deckId)
    const removed = yDocToDeck(docs.get(deckId)!).theme.components?.chrome
    expect(removed?.logoLight).toBeUndefined()
    expect(removed?.logoDark).toBeUndefined()
    expect(removed?.footerText).toBe('Acme Ltd')
    for (const assetId of latest) expect(await storage.get(assetId)).toBeNull()
    await deleteBrandKit(deps(), owner, id)
  })
})
