// Checks the 0001 migration's data copy: decks.starred becomes deck_members.starred.
// Runs against a scratch database that the test creates and drops (needs CREATEDB).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { TEST_DATABASE_URL } from '@sleid/db/testing'

const MIGRATIONS = new URL('../../../apps/web/drizzle/', import.meta.url)

function statements(file: string): string[] {
  return readFileSync(new URL(file, MIGRATIONS), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

const scratchName = `sleid_mig_${randomUUID().replace(/-/g, '').slice(0, 16)}`
let admin: ReturnType<typeof postgres> | null = null
let scratch: ReturnType<typeof postgres> | null = null
let ready = false

beforeAll(async () => {
  try {
    admin = postgres(withDatabase(TEST_DATABASE_URL, 'postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`create database "${scratchName}"`)
    scratch = postgres(withDatabase(TEST_DATABASE_URL, scratchName), { max: 1, onnotice: () => {} })
    ready = true
  } catch (err) {
    console.warn(`[migrations.test] skipped: cannot create a scratch database (${err instanceof Error ? err.message : String(err)})`)
  }
})

afterAll(async () => {
  await scratch?.end({ timeout: 1 })
  if (admin) {
    await admin.unsafe(`drop database if exists "${scratchName}" with (force)`).catch(() => undefined)
    await admin.end({ timeout: 1 })
  }
})

describe('0001 migration: starred moves from decks to deck_members', () => {
  it('copies the star to every member of a starred deck and drops decks.starred', async (ctx) => {
    if (!ready || !scratch) return ctx.skip()
    for (const s of statements('0000_round_rawhide_kid.sql')) await scratch.unsafe(s)

    const ownerId = `mig-owner-${randomUUID()}`
    const memberId = `mig-member-${randomUUID()}`
    await scratch`insert into "user" (id, name, email) values (${ownerId}, 'Owner', ${ownerId + '@example.com'}), (${memberId}, 'Member', ${memberId + '@example.com'})`
    const starredDeck = randomUUID()
    const plainDeck = randomUUID()
    await scratch`insert into decks (id, owner_id, title, starred) values (${starredDeck}, ${ownerId}, 'Starred', true), (${plainDeck}, ${ownerId}, 'Plain', false)`
    await scratch`insert into deck_members (deck_id, user_id, role) values (${starredDeck}, ${ownerId}, 'owner'), (${starredDeck}, ${memberId}, 'viewer'), (${plainDeck}, ${ownerId}, 'owner')`

    for (const s of statements('0001_overconfident_pandemic.sql')) await scratch.unsafe(s)

    const members = await scratch<{ deck_id: string; user_id: string; starred: boolean }[]>`select deck_id, user_id, starred from deck_members order by deck_id, user_id`
    const byKey = new Map(members.map((m) => [`${m.deck_id}:${m.user_id}`, m.starred]))
    expect(byKey.get(`${starredDeck}:${ownerId}`)).toBe(true)
    expect(byKey.get(`${starredDeck}:${memberId}`)).toBe(true)
    expect(byKey.get(`${plainDeck}:${ownerId}`)).toBe(false)

    const cols = await scratch<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'decks' and column_name = 'starred'`
    expect(cols).toHaveLength(0)
  })
})
