// Deck-level tools: list, create (blank, theme or template), import, plan, validate, brand kits and deck options.
import { and, desc, eq, ilike, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { LANGUAGE_TAG_RE, validateDeckJson } from '@sleid/model'
import { decks, deckMembers } from '@sleid/db'
import { ImportError, decodeBase64, startImport } from '~/lib/import.server'
import { applyBrandKit, listBrandKitsFor, removeBrandKit } from '~/lib/brand-kits.server'
import { listTemplatesFor, newDeckFromTemplate } from '~/lib/templates.server'
import { ToolError } from '../errors.ts'
import { asText, deckIdField, escapeLike, waitForImport, type ServerContext } from '../call.ts'
import { buildPlan } from '../plan.ts'
import { builtInTheme, builtInThemeNames } from '../compile.ts'

const IMPORT_WAIT_MS = 60_000
const IMPORT_EXTENSIONS: Record<'pptx' | 'markdown' | 'json', string> = { pptx: 'pptx', markdown: 'md', json: 'json' }

export function registerDeckTools(ctx: ServerContext): void {
  const { tool, deps, principal } = ctx

  tool(
    'list_decks',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'List the decks you can access: id, title, your role, last updated time and URL. Use query to filter by title. Call this first to find a deckId.',
      shape: {
        query: z.string().max(100).optional().describe('Words to match in the title.'),
        limit: z.number().int().min(1).max(100).optional().describe('Most decks to return (default 25).'),
      },
    },
    async (args) => {
      const conditions = [eq(deckMembers.userId, principal.userId), isNull(decks.deletedAt)]
      if (principal.deckIds) conditions.push(inArray(decks.id, principal.deckIds))
      if (args.query) conditions.push(ilike(decks.title, `%${escapeLike(args.query)}%`))
      const rows = await deps.db
        .select({ id: decks.id, title: decks.title, role: deckMembers.role, updatedAt: decks.updatedAt })
        .from(deckMembers)
        .innerJoin(decks, eq(decks.id, deckMembers.deckId))
        .where(and(...conditions))
        .orderBy(desc(decks.updatedAt))
        .limit(args.limit ?? 25)
      return asText({
        decks: rows.map((r) => ({ id: r.id, title: r.title, role: r.role, updatedAt: r.updatedAt.toISOString(), url: `${deps.publicUrl}/d/${r.id}` })),
      })
    },
  )

  tool(
    'create_deck',
    {
      scope: 'decks:create',
      description:
        'Create a deck that you own. With no templateId: an empty deck with one title slide, and theme is an optional built-in theme name (see sleid://themes). With templateId (from list_templates): a deck with the template\'s theme and slides, and title replaces the template name. Returns the deck id and URL. Then use plan_deck and add_slide with components, or get_deck to see the slides.',
      shape: {
        title: z.string().min(1).max(120).describe('The deck title.'),
        theme: z.string().max(60).optional().describe('A built-in theme name, such as "Midnight". Not used with templateId.'),
        templateId: z.string().min(1).max(80).optional().describe('A template id from list_templates. Not used with theme.'),
        startEmpty: z.boolean().optional().describe('Make the deck with no slides, instead of one empty title slide. Use it when add_slide builds every slide. Not used with templateId.'),
      },
    },
    async (args, call) => {
      if (args.templateId) {
        if (args.theme) throw new ToolError('Pass either theme or templateId, not both.')
        if (args.startEmpty) throw new ToolError('startEmpty is not used with templateId.')
        const created = await newDeckFromTemplate(ctx.templateDepsFor(), principal.userId, { templateId: args.templateId, title: args.title.trim() })
        call.deckId = created.deckId
        return asText({ id: created.deckId, title: args.title.trim(), template: args.templateId, url: `${deps.publicUrl}/d/${created.deckId}` })
      }
      const theme = args.theme ? builtInTheme(args.theme) : undefined
      if (args.theme && !theme) throw new ToolError(`Unknown theme "${args.theme}". Built-in themes: ${builtInThemeNames().join(', ')}.`)
      const id = await deps.db.transaction(async (tx) => {
        const [deck] = await tx.insert(decks).values({ ownerId: principal.userId, title: args.title.trim() }).returning({ id: decks.id })
        if (!deck) throw new Error('could not create the deck')
        await tx.insert(deckMembers).values({ deckId: deck.id, userId: principal.userId, role: 'owner', via: 'owner' })
        return deck.id
      })
      call.deckId = id
      if (theme) {
        try {
          await call.write(id, [{ op: 'setTheme', theme }])
        } catch (err) {
          // The theme could not be applied, so the empty deck would not match the request. Remove it again.
          await deps.db.delete(decks).where(eq(decks.id, id)).catch(() => undefined)
          throw err
        }
      }
      if (args.startEmpty) {
        // A new deck starts with one empty title slide. The model allows a deck with no slides, so that slide is removed.
        const fresh = await call.read(id)
        if (fresh.slides.length > 0) await call.write(id, fresh.slides.map((slide) => ({ op: 'deleteSlide', slideId: slide.id })))
      }
      return asText({ id, title: args.title.trim(), theme: theme?.name ?? null, url: `${deps.publicUrl}/d/${id}` })
    },
  )

  tool(
    'plan_deck',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'Plan a deck before building it. No model is called and nothing is created. Give the brief, and optionally the audience, a slide count (3 to 30, default 10), a reference deck you can read (its look and slide types are reused) and a second language. Returns the style to use, the slides (each with its purpose, variant and the components to place, with placeholder text to replace), and the exact tool calls, in order, to build it. Start here, then follow the calls.',
      shape: {
        brief: z.string().min(1).max(2000).describe('What the deck is about, and what it should make the audience do.'),
        audience: z.string().max(200).optional(),
        slideCount: z.number().int().min(3).max(30).optional().describe('How many slides (default 10).'),
        referenceDeckId: deckIdField.optional().describe('A deck you can read whose look and slide types to reuse.'),
        secondaryLanguage: z.string().regex(LANGUAGE_TAG_RE).optional().describe('A second language tag, such as zh-TW, for the secondary lines.'),
      },
    },
    async (args, call) => {
      const reference = args.referenceDeckId ? { deckId: args.referenceDeckId, deck: await call.read(args.referenceDeckId) } : undefined
      return asText(
        buildPlan({
          brief: args.brief,
          audience: args.audience,
          slideCount: args.slideCount ?? 10,
          secondaryLanguage: args.secondaryLanguage,
          reference,
        }),
      )
    },
  )

  tool(
    'list_templates',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'List the templates you can use: the built-in ones, your own, and the ones shared with everyone on this server. Each has an id (pass it to create_deck as templateId), a name, a description, a category and its slide count.',
      shape: {},
    },
    async () => {
      const list = await listTemplatesFor(ctx.templateDepsFor(), principal.userId)
      return asText({
        templates: list.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category,
          builtIn: t.builtIn,
          owned: t.owned,
          visibility: t.visibility,
          slideCount: t.slideCount,
        })),
      })
    },
  )

  tool(
    'list_brand_kits',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'List the brand kits you can use: your own, and the ones shared with everyone on this server. Each has an id (pass it to apply_brand_kit), a name, its fonts, its accent colour and whether it has a logo.',
      shape: {},
    },
    async () => {
      const kits = await listBrandKitsFor(ctx.brandDepsFor(), principal.userId)
      return asText({
        brandKits: kits.map((k) => ({
          id: k.id,
          name: k.name,
          owned: k.owned,
          visibility: k.visibility,
          fonts: k.tokens.fonts,
          accent: k.tokens.palette.accent,
          hasLogo: k.hasLogo,
          logoCorner: k.logoPlacement.corner,
        })),
      })
    },
  )

  tool(
    'apply_brand_kit',
    {
      scope: 'decks:write',
      description:
        'Apply a brand kit to a deck you can edit. The deck takes the kit\'s palette and fonts as its theme, and the kit\'s logo is placed on its slides. AI tools on the deck then stay within the kit. Pass brandKitId null to remove the kit: the theme stays and the logo goes. The change reaches open editors live. Needs editor access on the deck.',
      shape: {
        deckId: deckIdField,
        brandKitId: z.uuid().nullable().describe('A brand kit id from list_brand_kits, or null to remove the kit.'),
      },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      const actor = `mcp:${principal.tokenId}`
      if (args.brandKitId === null) {
        await removeBrandKit(ctx.brandDepsFor(), principal.userId, args.deckId, actor)
        return asText({ deckId: args.deckId, brandKitId: null, removed: true })
      }
      const result = await applyBrandKit(ctx.brandDepsFor(), principal.userId, args.deckId, args.brandKitId, actor)
      return asText({ deckId: args.deckId, brandKitId: args.brandKitId, theme: result.theme, logo: result.logo })
    },
  )

  tool(
    'import_deck',
    {
      scope: 'decks:create',
      description:
        'Make a new deck you own from a file. format is pptx, markdown or json. For pptx send contentBase64 (the .pptx file, base64 encoded). For markdown or json send either the text in text, or the file in contentBase64; send exactly one of the two. Markdown slides are split on "---" lines, and the title comes from the front matter or the first slide. title overrides the title in the file. A json deck needs only slides with elements; id, version, size, sections, slide and element ids and element defaults are filled in, and data: images become assets. A minimal valid json example: {"title":"Q3","slides":[{"elements":[{"type":"text","x":120,"y":80,"w":1680,"h":160,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]},"style":{}}]}]}. Use validate_deck first to check a json file. Returns deckId, url and warnings. It waits up to 60 seconds for the import. Limits: through this tool a pptx can be about 12 MB at most (the request body is capped at 16 MB and base64 adds a third); markdown or json up to 5 MB; 10 imports per user per hour. Larger decks: upload the file in the editor (File > Import slides) or import a public Google Slides link there.',
      shape: {
        format: z.enum(['pptx', 'markdown', 'json']),
        contentBase64: z.string().min(1).max(16 * 1024 * 1024).optional().describe('The file, base64 encoded. Required for pptx. At most 16 MB of text, so a pptx of about 12 MB.'),
        text: z.string().min(1).max(5 * 1024 * 1024).optional().describe('The text of a markdown or json file.'),
        title: z.string().min(1).max(200).optional().describe('Deck title. Defaults to the title in the file.'),
      },
    },
    async (args, call) => {
      if ((args.contentBase64 === undefined) === (args.text === undefined)) throw new ToolError('Send exactly one of contentBase64 or text.')
      if (args.format === 'pptx' && args.contentBase64 === undefined) throw new ToolError('A pptx import needs contentBase64: the .pptx file, base64 encoded.')
      let importId: string
      try {
        const bytes = args.contentBase64 !== undefined ? decodeBase64(args.contentBase64) : new TextEncoder().encode(args.text ?? '')
        const started = await startImport(ctx.importDepsFor(), { id: principal.userId }, {
          format: args.format,
          fileName: `import.${IMPORT_EXTENSIONS[args.format]}`,
          bytes,
          ...(args.title ? { title: args.title } : {}),
        })
        importId = started.importId
      } catch (err) {
        if (err instanceof ImportError) throw new ToolError(err.message)
        throw err
      }
      const row = await waitForImport(deps, importId, IMPORT_WAIT_MS)
      if (row.status === 'failed') throw new ToolError(row.error ?? 'The import failed.')
      if (row.status !== 'done' || !row.deckId) {
        throw new ToolError(`The import is still running after 60 seconds (import ${importId}). It keeps running in the background, so look for the new deck with list_decks shortly.`)
      }
      call.deckId = row.deckId
      return asText({ deckId: row.deckId, url: `${deps.publicUrl}/d/${row.deckId}`, warnings: row.warnings })
    },
  )

  tool(
    'validate_deck',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'Check the text of a json deck without importing it or changing anything. Returns ok, and every problem with its path, such as slides[3].elements[2].style.align, so you can fix the file before import_deck.',
      shape: { text: z.string().min(1).max(5 * 1024 * 1024).describe('The json deck, as text.') },
    },
    async (args) => {
      const result = validateDeckJson(args.text)
      return asText({ ok: result.ok, issues: result.issues })
    },
  )

  tool(
    'set_deck_options',
    {
      scope: 'decks:write',
      description:
        'Set the deck options. secondaryLanguage is a BCP 47 tag such as zh-TW: the deck then has a second line under headings and items (the secondary field of a component). Pass null to remove the second language. Needs editor access.',
      shape: {
        deckId: deckIdField,
        secondaryLanguage: z.string().regex(LANGUAGE_TAG_RE).nullable(),
      },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      await call.write(args.deckId, [{ op: 'setDeckOptions', secondaryLanguage: args.secondaryLanguage }])
      return asText({ deckId: args.deckId, secondaryLanguage: args.secondaryLanguage })
    },
  )
}
