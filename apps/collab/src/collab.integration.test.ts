// Integration: an in-process Hocuspocus server on random ports, real Postgres (127.0.0.1:5433),
// and HocuspocusProvider clients over the `ws` package. Skips when the database is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { applyOps, createDeck, yDocToDeck, type Deck } from '@sleid/model'
import { and, count, eq } from 'drizzle-orm'
import { BEFORE_RESTORE_NAME, COLLAB_TOKEN_TTL_SECONDS, createInvite, deckSnapshots, deckUpdates, decks, grantMembership, listVersions, loadDeckState, redeemShareLink, setGeneralAccess, setMemberRole, removeMember, signCollabToken, type DeckRole, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { createCollabServer, type CollabServer } from './server.ts'
import { RemoteStateStore } from './remote-state.ts'
import { CollabInternalError, createCollabInternalClient } from '../../web/src/lib/collab-client.server.ts'

const TOKEN_SECRET = 'integration-token-secret-0123456789abcdef'
const INTERNAL_SECRET = 'integration-internal-secret-0123'

let db: Db | null = null
let server: CollabServer | null = null
let internal = () => createCollabInternalClient({ baseUrl: server!.internalUrl, secret: INTERNAL_SECRET })
const users: string[] = []
const providers: HocuspocusProvider[] = []
const sockets: HocuspocusProviderWebsocket[] = []

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  server = await createCollabServer({
    db,
    tokenSecret: TOKEN_SECRET,
    internalSecret: INTERNAL_SECRET,
    host: '127.0.0.1',
    port: 0,
    internalHost: '127.0.0.1',
    internalPort: 0,
    debounceMs: 100,
    maxDebounceMs: 300,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
})

afterAll(async () => {
  for (const p of providers) p.destroy()
  for (const s of sockets) s.destroy()
  await server?.close()
  if (db) {
    await removeUsers(db, users)
    await db.$client.end({ timeout: 1 })
  }
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`)
    await sleep(25)
  }
}

async function person(label: string) {
  const u = await makeUser(db!, label)
  users.push(u.id)
  return u
}

function tokenFor(userId: string, deckId: string, role: DeckRole, name = 'Test', now = Date.now()) {
  return signCollabToken({ userId, deckId, role, name, image: null }, TOKEN_SECRET, now)
}

interface Client {
  doc: Y.Doc
  provider: HocuspocusProvider
}

/** A provider for one user on one deck. Resolves when synced, or rejects with the denial reason. */
function connect(deckId: string, token: string): Promise<Client> {
  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({ url: server!.wsUrl, WebSocketPolyfill: WebSocket, maxAttempts: 1 })
  sockets.push(socket)
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      name: deckId,
      document: doc,
      websocketProvider: socket,
      token,
      onAuthenticationFailed: ({ reason }) => reject(new Error(reason)),
      onSynced: ({ state }) => {
        if (state) resolve({ doc, provider })
      },
    })
    providers.push(provider)
    // A shared websocket does not attach providers on its own. The caller attaches.
    provider.attach()
  })
}

async function connectAs(deckId: string, userId: string, role: DeckRole, name = 'Test'): Promise<Client> {
  return connect(deckId, tokenFor(userId, deckId, role, name))
}

async function persistedDeck(deckId: string): Promise<Deck> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await loadDeckState(db!, deckId))
  return yDocToDeck(doc)
}

describe('collab server (real Postgres, in-process Hocuspocus)', () => {
  it('two editors converge after concurrent applyOps', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('conv-owner')
    const editor = await person('conv-editor')
    const deckId = await makeDeck(db, owner.id, 'Converge')
    await db.transaction((tx) => grantMembership(tx, deckId, editor.id, 'editor'))
    const a = await connectAs(deckId, owner.id, 'owner', 'Ada')
    const b = await connectAs(deckId, editor.id, 'editor', 'Bo')

    // Both edit before either update reaches the other side.
    const firstSlide = yDocToDeck(a.doc).slides[0]!.id
    applyOps(a.doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'slide-from-a' } }], 'local')
    applyOps(b.doc, [{ op: 'setNotes', slideId: firstSlide, notes: 'written by b' }, { op: 'setTitle', title: 'Title from b' }], 'local')

    await waitFor(() => {
      const da = yDocToDeck(a.doc)
      const dbDeck = yDocToDeck(b.doc)
      return JSON.stringify(da) === JSON.stringify(dbDeck) && da.slides.some((s) => s.id === 'slide-from-a') && da.slides[0]!.notes === 'written by b'
    }, 'both editors converge')
    expect(yDocToDeck(a.doc).title).toBe('Title from b')
  })

  it('a viewer connection is read-only on the server: its update is ignored', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('ro-owner')
    const viewer = await person('ro-viewer')
    const deckId = await makeDeck(db, owner.id, 'Read only')
    await db.transaction((tx) => grantMembership(tx, deckId, viewer.id, 'viewer'))
    const o = await connectAs(deckId, owner.id, 'owner')
    const v = await connectAs(deckId, viewer.id, 'viewer')
    expect(v.provider.authorizedScope).toBe('readonly')

    applyOps(v.doc, [{ op: 'setTitle', title: 'Hacked by viewer' }], 'local')
    await sleep(700)
    expect(yDocToDeck(o.doc).title).toBe('Read only')
    expect((await persistedDeck(deckId)).title).toBe('Read only')
  })

  it('an internal ops call reaches a connected client and returns per-op results', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('ops-owner')
    const deckId = await makeDeck(db, owner.id, 'Ops')
    const o = await connectAs(deckId, owner.id, 'owner')

    const response = await internal().applyOps(deckId, 'agent-1', [
      { op: 'setTitle', title: 'From the agent' },
      { op: 'addSlide', layout: 'title-content', slide: { id: 'agent-slide' } },
    ])
    expect(response.ok).toBe(true)
    expect(response.results).toEqual([{ ok: true }, { ok: true, id: 'agent-slide' }])

    await waitFor(() => yDocToDeck(o.doc).slides.some((s) => s.id === 'agent-slide') && yDocToDeck(o.doc).title === 'From the agent', 'agent change reaches the client')
    // The change is stored too, so a reload from the database sees it.
    await sleep(400)
    const stored = await persistedDeck(deckId)
    expect(stored.title).toBe('From the agent')
    expect(stored.slides.some((s) => s.id === 'agent-slide')).toBe(true)
  })

  it('an internal ops call with a bad op is rejected whole, with the failing index', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('bad-owner')
    const deckId = await makeDeck(db, owner.id, 'Bad ops')
    const before = (await persistedDeck(deckId)).title
    const error = await internal()
      .applyOps(deckId, 'agent-2', [{ op: 'setTitle', title: 'should not land' }, { op: 'deleteSlide', slideId: 'no-such-slide' }])
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CollabInternalError)
    expect((error as CollabInternalError).status).toBe(422)
    expect((error as CollabInternalError).body).toMatchObject({ error: { opIndex: 1, opName: 'deleteSlide' } })
    await sleep(300)
    expect((await persistedDeck(deckId)).title).toBe(before)
  })

  it('the internal API refuses a wrong secret, a bad deck id, and an unknown deck', async (ctx) => {
    if (!db) return ctx.skip()
    const url = `${server!.internalUrl}/internal/decks/00000000-0000-4000-8000-000000000000/json`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { 'x-sleid-internal': 'wrong-secret-value-000' } })).status).toBe(401)
    const badId = await fetch(`${server!.internalUrl}/internal/decks/not-a-uuid/json`, { headers: { 'x-sleid-internal': INTERNAL_SECRET } })
    expect(badId.status).toBe(400)
    await expect(internal().getDeck('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 })
  })

  it('persists the live state to deck_updates and a reload from the database equals it', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('persist-owner')
    const deckId = await makeDeck(db, owner.id, 'Persist')
    const o = await connectAs(deckId, owner.id, 'owner')
    const slideId = yDocToDeck(o.doc).slides[0]!.id
    applyOps(o.doc, [{ op: 'setNotes', slideId, notes: 'persisted note' }, { op: 'setTitle', title: 'Persisted title' }], 'local')
    applyOps(o.doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'persisted-slide' } }], 'local')

    await sleep(800)
    const [row] = await db.select({ n: count() }).from(deckUpdates).where(eq(deckUpdates.deckId, deckId))
    expect(Number(row?.n ?? 0)).toBeGreaterThan(0)
    const [deck] = await db.select({ title: decks.title }).from(decks).where(eq(decks.id, deckId))
    expect(deck?.title).toBe('Persisted title')
    expect(await persistedDeck(deckId)).toEqual(yDocToDeck(o.doc))
  })

  it('an editor update that breaks the deck is refused and the connection is closed', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('broken-owner')
    const editor = await person('broken-editor')
    const deckId = await makeDeck(db, owner.id, 'Broken')
    await db.transaction((tx) => grantMembership(tx, deckId, editor.id, 'editor'))
    const o = await connectAs(deckId, owner.id, 'owner')
    const e = await connectAs(deckId, editor.id, 'editor')
    const slideCount = yDocToDeck(o.doc).slides.length

    // Replace the slides map with a string. The deck no longer parses.
    e.doc.transact(() => e.doc.getMap('deck').set('slides', 'garbage'))
    await waitFor(() => !e.provider.isAuthenticated, 'editor connection closed', 5000)
    await sleep(400)
    expect(yDocToDeck(o.doc).slides.length).toBe(slideCount)
    expect((await persistedDeck(deckId)).slides.length).toBe(slideCount)
  })

  it('denies connections with a wrong deck, an expired token, a bad signature, or a non-member', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('deny-owner')
    const stranger = await person('deny-stranger')
    const deckId = await makeDeck(db, owner.id, 'Deny')
    const otherDeck = await makeDeck(db, owner.id, 'Other')

    await expect(connect(deckId, tokenFor(owner.id, otherDeck, 'owner'))).rejects.toThrow('wrong-deck')
    const longAgo = Date.now() - (COLLAB_TOKEN_TTL_SECONDS + 60) * 1000
    await expect(connect(deckId, tokenFor(owner.id, deckId, 'owner', 'Old', longAgo))).rejects.toThrow('expired')
    const forged = signCollabToken({ userId: owner.id, deckId, role: 'owner', name: 'x', image: null }, 'a-different-secret-that-is-long-enough')
    await expect(connect(deckId, forged)).rejects.toThrow('bad-signature')
    await expect(connect(deckId, tokenFor(stranger.id, deckId, 'editor'))).rejects.toThrow('not-a-member')
  })

  it('presence shows the authenticated identity, even when a client claims another user', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('pres-owner')
    const editor = await person('pres-editor')
    const deckId = await makeDeck(db, owner.id, 'Presence')
    await db.transaction((tx) => grantMembership(tx, deckId, editor.id, 'editor'))
    const o = await connectAs(deckId, owner.id, 'owner', 'Owner Name')
    const e = await connectAs(deckId, editor.id, 'editor', 'Editor Name')
    // The editor claims to be the owner in its awareness state.
    e.provider.awareness!.setLocalStateField('user', { id: owner.id, name: 'Impostor', color: '#000000' })
    await waitFor(() => {
      const peers = [...o.provider.awareness!.getStates().values()] as Array<{ user?: { id: string; name: string } }>
      return peers.some((p) => p.user?.name === 'Editor Name' && p.user?.id === editor.id)
    }, 'owner sees the editor with the authenticated identity')
    const names = [...o.provider.awareness!.getStates().values()].map((p) => (p as { user?: { name?: string } }).user?.name)
    expect(names).not.toContain('Impostor')
  })

  it('revalidate downgrades an editor in place, and closes a removed member', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('reval-owner')
    const editor = await person('reval-editor')
    const gone = await person('reval-gone')
    const deckId = await makeDeck(db, owner.id, 'Revalidate')
    await db.transaction(async (tx) => {
      await grantMembership(tx, deckId, editor.id, 'editor')
      await grantMembership(tx, deckId, gone.id, 'editor')
    })
    const o = await connectAs(deckId, owner.id, 'owner')
    const e = await connectAs(deckId, editor.id, 'editor')
    const g = await connectAs(deckId, gone.id, 'editor')
    expect(e.provider.authorizedScope).toBe('read-write')

    await setMemberRole(db, deckId, editor.id, 'viewer')
    await removeMember(db, deckId, gone.id)
    const result = await internal().revalidate(deckId)
    expect(result).toMatchObject({ downgraded: 1, closed: 1 })

    await waitFor(() => !g.provider.isAuthenticated, 'removed member disconnected', 5000)
    applyOps(e.doc, [{ op: 'setTitle', title: 'after downgrade' }], 'local')
    await sleep(600)
    expect(yDocToDeck(o.doc).title).toBe('Revalidate')
  })

  it('restricting a link closes the connections of people who joined only through it', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('link-owner')
    const joiner = await person('link-joiner')
    const invited = await person('link-explicit')
    const deckId = await makeDeck(db, owner.id, 'Link restrict')
    const access = await setGeneralAccess(db, deckId, owner.id, 'editor')
    expect(await redeemShareLink(db, joiner.id, deckId, access!.token)).toBe('editor')
    await createInvite(db, { deckId, invitedBy: owner.id, email: invited.email, role: 'editor' })

    const o = await connectAs(deckId, owner.id, 'owner')
    const j = await connectAs(deckId, joiner.id, 'editor')
    const x = await connectAs(deckId, invited.id, 'editor')
    expect(j.provider.authorizedScope).toBe('read-write')

    await setGeneralAccess(db, deckId, owner.id, 'restricted')
    const result = await internal().revalidate(deckId)
    expect(result).toMatchObject({ closed: 1 })
    await waitFor(() => !j.provider.isAuthenticated, 'link-only member disconnected', 5000)

    // The explicitly invited editor keeps working.
    applyOps(x.doc, [{ op: 'setTitle', title: 'still editing' }], 'local')
    await waitFor(() => yDocToDeck(o.doc).title === 'still editing', 'explicit member still syncs', 5000)
  })

  it('a named version keeps the live state, including edits that are not saved yet', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('named-owner')
    const deckId = await makeDeck(db, owner.id, 'Named')
    const o = await connectAs(deckId, owner.id, 'owner')
    applyOps(o.doc, [{ op: 'setTitle', title: 'Typed just now' }], 'local')
    const saved = await internal().snapshot(deckId, { userId: owner.id, name: 'v1' })
    expect(saved.id).toBeTruthy()
    const versions = await listVersions(db, deckId)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ id: saved.id, kind: 'named', name: 'v1' })
    const [row] = await db.select({ ydoc: deckSnapshots.ydoc }).from(deckSnapshots).where(eq(deckSnapshots.id, saved.id))
    const doc = new Y.Doc()
    Y.applyUpdate(doc, row!.ydoc)
    expect(yDocToDeck(doc).title).toBe('Typed just now')
  })

  it('restore makes connected clients show the target, keeps "Before restore", and refuses a bad target', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('restore-owner')
    const editor = await person('restore-editor')
    const deckId = await makeDeck(db, owner.id, 'Restore')
    await db.transaction((tx) => grantMembership(tx, deckId, editor.id, 'editor'))
    const a = await connectAs(deckId, owner.id, 'owner')
    const b = await connectAs(deckId, editor.id, 'editor')
    applyOps(a.doc, [{ op: 'setTitle', title: 'Current title' }], 'local')
    await waitFor(() => yDocToDeck(b.doc).title === 'Current title', 'editor sees the current title')

    const target: Deck = { ...createDeck('Version one'), id: deckId, slides: createDeck('x').slides.map((s) => ({ ...s, id: 'v1-slide' })) }
    const result = await internal().restore(deckId, { userId: owner.id, deck: target })
    expect(result.ok).toBe(true)

    await waitFor(() => JSON.stringify(yDocToDeck(b.doc)) === JSON.stringify(target), 'editor converges to the restored version', 5000)
    expect(JSON.stringify(yDocToDeck(a.doc))).toBe(JSON.stringify(target))
    const versions = await listVersions(db, deckId)
    const before = versions.find((v) => v.name === BEFORE_RESTORE_NAME)
    expect(before).toMatchObject({ kind: 'auto', createdBy: { id: owner.id } })
    expect(before!.id).toBe(result.beforeSnapshotId)

    const countBefore = (await db.select({ n: count() }).from(deckSnapshots).where(eq(deckSnapshots.deckId, deckId)))[0]!.n
    const bad = await fetch(`${server!.internalUrl}/internal/decks/${deckId}/restore`, {
      method: 'POST',
      headers: { 'x-sleid-internal': INTERNAL_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: owner.id, deck: { title: 'not a deck' } }),
    })
    expect(bad.status).toBe(422)
    expect((await db.select({ n: count() }).from(deckSnapshots).where(eq(deckSnapshots.deckId, deckId)))[0]!.n).toBe(countBefore)
    expect(JSON.stringify(yDocToDeck(a.doc))).toBe(JSON.stringify(target))
  })

  it('a broadcast reaches every connected client as a stateless message', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('bcast-owner')
    const viewer = await person('bcast-viewer')
    const deckId = await makeDeck(db, owner.id, 'Broadcast')
    await db.transaction((tx) => grantMembership(tx, deckId, viewer.id, 'viewer'))
    const o = await connectAs(deckId, owner.id, 'owner')
    const v = await connectAs(deckId, viewer.id, 'viewer')
    const seen: string[] = []
    v.provider.on('stateless', ({ payload }: { payload: string }) => seen.push(payload))
    const result = await internal().broadcast(deckId, { channel: 'comments', type: 'comments', threadId: 'thread-1' })
    expect(result.delivered).toBeGreaterThanOrEqual(2)
    await waitFor(() => seen.length === 1, 'viewer got the broadcast')
    expect(JSON.parse(seen[0]!)).toEqual({ channel: 'comments', type: 'comments', threadId: 'thread-1' })
    void o
  })

  it('presenter state is kept for the phone and relayed to followers; commands reach the presenter; other client messages are dropped', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('remote-owner')
    const follower = await person('remote-follower')
    const deckId = await makeDeck(db, owner.id, 'Remote channel')
    await db.transaction((tx) => grantMembership(tx, deckId, follower.id, 'viewer'))
    const sid = 'remote-sid-0123456789ab'
    const presenter = await connectAs(deckId, owner.id, 'owner')
    const watcher = await connectAs(deckId, follower.id, 'viewer')
    const commands: string[] = []
    const relayed: string[] = []
    const dropped: string[] = []
    presenter.provider.on('stateless', ({ payload }: { payload: string }) => commands.push(payload))
    watcher.provider.on('stateless', ({ payload }: { payload: string }) => {
      if (payload.includes('"type":"state"')) relayed.push(payload)
      if (payload.includes('spoofed')) dropped.push(payload)
    })

    presenter.provider.sendStateless(JSON.stringify({ channel: `remote:${sid}`, type: 'state', slide: 2, total: 5, slideId: 'slide-2', notes: 'Notes here', title: 'Deck' }))
    await waitFor(() => relayed.length === 1, 'follower receives the relayed state')
    const stored = await internal().remoteState(deckId, sid)
    expect(stored.state).toMatchObject({ slide: 2, total: 5, notes: 'Notes here' })

    // Commands come only from the internal API. A client that sends one itself reaches nobody.
    watcher.provider.sendStateless(JSON.stringify({ channel: `remote:${sid}`, type: 'command', action: 'next', spoofed: true }))
    watcher.provider.sendStateless(JSON.stringify({ channel: 'comments', type: 'comments', threadId: 'spoofed' }))
    await sleep(300)
    expect(dropped).toEqual([])
    expect(commands.some((c) => c.includes('spoofed'))).toBe(false)

    await internal().remoteCommand(deckId, sid, 'next')
    await waitFor(() => commands.some((c) => c.includes('"action":"next"')), 'presenter receives the next command')
    expect(JSON.parse(commands.find((c) => c.includes('"action":"next"'))!)).toMatchObject({ channel: `remote:${sid}`, type: 'command', action: 'next' })
  })

  it('an edit by a user starts an automatic checkpoint that records them as an editor', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await person('auto-owner')
    const deckId = await makeDeck(db, owner.id, 'Automatic')
    const quick = await createCollabServer({
      db,
      tokenSecret: TOKEN_SECRET,
      internalSecret: INTERNAL_SECRET,
      host: '127.0.0.1',
      port: 0,
      internalHost: '127.0.0.1',
      internalPort: 0,
      debounceMs: 100,
      maxDebounceMs: 300,
      checkpointIdleMs: 400,
      checkpointMaxIntervalMs: 60_000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    try {
      const doc = new Y.Doc()
      const socket = new HocuspocusProviderWebsocket({ url: quick.wsUrl, WebSocketPolyfill: WebSocket, maxAttempts: 1 })
      sockets.push(socket)
      const provider = new HocuspocusProvider({ name: deckId, document: doc, websocketProvider: socket, token: tokenFor(owner.id, deckId, 'owner', 'Owner') })
      providers.push(provider)
      provider.attach()
      await waitFor(() => provider.isSynced, 'quick server synced')
      await sleep(200)
      const before = (await listVersions(db, deckId)).length
      applyOps(doc, [{ op: 'setTitle', title: 'Changed' }], 'local')
      await waitFor(() => quick.checkpoints.pending() === 1, 'the edit is noted for a checkpoint', 5000)
      await waitFor(() => quick.checkpoints.pending() === 0, 'checkpoint timer finished', 5000)
      await sleep(300)
      const versions = await listVersions(db, deckId)
      expect(versions.length).toBeGreaterThan(before)
      expect(versions[0]).toMatchObject({ kind: 'auto', createdBy: { id: owner.id } })
      expect(versions[0]!.editors.map((e) => e.id)).toEqual([owner.id])
    } finally {
      await quick.close()
    }
  })
})
