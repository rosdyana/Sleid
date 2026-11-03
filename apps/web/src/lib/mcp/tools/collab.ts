// Collaboration tools: sharing, comments, versions, the AI assistant, and the prompt-to-deck wizard.
import { z } from 'zod'
import { canGrant, createInvite, createThread, listThreadViews, listVersions, readVersion, tokenHasScope } from '@sleid/db'
import { commentPlainText, validateCommentBody } from '@sleid/model'
import { anchorFor, announceThreadChange } from '~/lib/comment-placement'
import { runAbilityForDeck } from '~/lib/ai.server'
import { createDeckFromPrompt, getRun as getWizardRunView } from '~/lib/wizard.server'
import { ToolError } from '../errors.ts'
import { asText, deckIdField, toolValue, type ServerContext } from '../call.ts'

/** The abilities generate_with_ai runs. The description lists them for the agent. */
export const ABILITIES = ['rewriteText', 'generateSlide', 'generateChart', 'generateDiagram', 'generateTheme', 'suggestEffects', 'speakerNotes', 'altText', 'explain', 'translate'] as const

export function registerCollabTools(ctx: ServerContext): void {
  const { tool, deps, principal } = ctx

  tool(
    'share_deck',
    {
      scope: 'decks:write',
      description:
        'Share a deck by email with a role: editor, commenter or viewer. Owners and editors can share. A person without an account yet gets access when they sign in with that email.',
      shape: {
        deckId: deckIdField,
        email: z.email().max(320),
        role: z.enum(['editor', 'commenter', 'viewer']),
      },
    },
    async (args, call) => {
      const role = await call.role(args.deckId, 'editor')
      if (!canGrant(role, args.role)) throw new ToolError('You need editor access to share this deck.')
      const result = await createInvite(deps.db, { deckId: args.deckId, invitedBy: principal.userId, email: args.email, role: args.role })
      return asText({
        deckId: args.deckId,
        email: args.email.toLowerCase(),
        role: args.role,
        accepted: result.accepted,
        note: result.accepted ? 'They already have an account, so they can open the deck now.' : 'They get access when they sign in with that email.',
      })
    },
  )

  tool(
    'generate_with_ai',
    {
      scope: 'ai',
      description:
        'Ask the Sleid assistant (your default AI provider) for a change, such as a new slide, a chart, a diagram, a rewrite, a theme or a translation. It returns proposed ops and changes nothing. Review them, then call apply_ops with the ops. ability is one of: ' +
        ABILITIES.join(', ') +
        '. input is ability-specific, for example {"prompt": "..."} for generateSlide, or {"prompt": "...", "elementId": "..."} for rewriteText. translate takes {"language": "zh-TW", "slideId": "..."}: both optional. language is the target (default the deck\'s secondary language), and slideId limits it to one slide. It fills the secondary lines of the components.',
      shape: {
        deckId: deckIdField,
        ability: z.enum(ABILITIES),
        input: z.record(z.string(), z.unknown()),
      },
    },
    async (args, call) => {
      await call.role(args.deckId, 'editor')
      const result = await runAbilityForDeck(
        { db: deps.db, env: deps.env, live: deps.live, storage: deps.assetStorage },
        { id: principal.userId, email: principal.userEmail },
        { deckId: args.deckId, providerId: null, ability: args.ability, input: args.input },
      )
      const proposal = result.proposal
      return asText({
        ability: proposal.ability,
        summary: proposal.summary,
        warnings: proposal.warnings,
        model: proposal.model,
        ops: proposal.ops,
        applied: false,
        next: 'Nothing was changed. Review the ops, then call apply_ops with them to apply.',
      })
    },
  )

  tool(
    'create_deck_from_prompt',
    {
      scope: 'decks:create',
      description:
        'Make a whole deck from a prompt, the same wizard as the New from prompt button. It needs the decks:create and ai scopes. It drafts an outline and starts generation; slides appear in the editor as they are written. urls are added as references (up to 10). research: true lets the assistant search the web (only when the server has a search provider). It waits up to about a minute for references, then returns deckId and runId; use get_wizard_status to follow the run.',
      shape: {
        prompt: z.string().min(1).max(4000),
        slideCount: z.number().int().min(3).max(30).optional(),
        audience: z.string().max(200).optional(),
        language: z.string().min(2).max(35).optional(),
        urls: z.array(z.string().min(1).max(2000)).max(10).optional(),
        research: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!tokenHasScope(principal, 'ai')) throw new ToolError('This token does not have the ai scope, so create_deck_from_prompt is not allowed.')
      const result = await createDeckFromPrompt(await ctx.wizardDepsFor(), { id: principal.userId }, {
        brief: {
          prompt: args.prompt,
          ...(args.slideCount !== undefined ? { slideCount: args.slideCount } : {}),
          ...(args.audience !== undefined ? { audience: args.audience } : {}),
          ...(args.language !== undefined ? { language: args.language } : {}),
        },
        ...(args.urls?.length ? { urls: args.urls } : {}),
        research: args.research ?? false,
      })
      return asText({
        deckId: result.deckId,
        runId: result.runId,
        status: result.status,
        url: result.deckId ? `${deps.publicUrl}/d/${result.deckId}` : `${deps.publicUrl}/wizard/${result.runId}`,
        next: result.deckId ? 'Slides are being written into the deck now. Call get_wizard_status with runId to follow progress.' : 'The references are still being read. Call get_wizard_status with runId, then draft the outline in the web app.',
      })
    },
  )

  tool(
    'get_wizard_status',
    {
      scope: 'decks:read',
      description: 'The status of a prompt-to-deck run: draft, ingesting, outlining, ready, generating, done, failed or cancelled, with progress, the references, any error, and failedSlides (the 1-based numbers of slides the model could not write; they are placeholders).',
      shape: { runId: z.uuid() },
    },
    async (args) => {
      const run = await getWizardRunView(await ctx.wizardDepsFor(), { id: principal.userId }, args.runId).catch((err: unknown) => {
        throw new ToolError(err instanceof Error ? err.message : 'That run was not found.')
      })
      return asText({
        runId: run.id,
        status: run.status,
        progress: run.progress,
        total: run.total,
        deckId: run.deckId,
        error: run.error,
        /** Slide numbers (1-based) the model could not write. They are placeholders until the run is retried in the web app. */
        failedSlides: run.failedSlides,
        sources: run.sources.map((s) => ({ title: s.title, url: s.url, status: s.status, words: s.wordCount })),
      })
    },
  )

  tool(
    'list_comments',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'List the comment threads of a deck: id, slide, element, whether resolved, and each comment (author, text, time). Optionally only one slide, and resolved threads too. Viewers and up can read comments.',
      shape: {
        deckId: deckIdField,
        slideId: z.string().min(1).max(100).optional().describe('Only this slide. Slide ids come from get_deck.'),
        includeResolved: z.boolean().optional().describe('Include resolved threads (default false).'),
      },
    },
    async (args, call) => {
      await call.role(args.deckId, 'viewer')
      const threads = await listThreadViews(deps.db, args.deckId, {
        ...(args.slideId ? { slideId: args.slideId } : {}),
        includeResolved: args.includeResolved ?? false,
      })
      return asText({
        threads: threads.map((t) => ({
          id: t.id,
          slideId: t.slideId,
          elementId: t.elementId,
          resolved: t.resolved,
          comments: t.comments.map((c) => ({ id: c.id, author: c.authorName, text: c.deletedAt ? '(deleted)' : commentPlainText(c.body), createdAt: c.createdAt })),
        })),
      })
    },
  )

  tool(
    'add_comment',
    {
      scope: 'decks:write',
      description:
        'Start a comment thread on a slide, or on one element of that slide. The body is plain text (up to 5000 characters). Write @[Name](userId) to mention a member of the deck. Commenters, editors and owners can do this. Returns the thread id.',
      shape: {
        deckId: deckIdField,
        slideId: z.string().min(1).max(100).describe('Slide id from get_deck.'),
        elementId: z.string().min(1).max(100).optional().describe('Element id on that slide, from get_deck.'),
        body: z.string().min(1).max(5000),
      },
    },
    async (args, call) => {
      await call.role(args.deckId, 'commenter')
      const body = toolValue(() => validateCommentBody(args.body))
      const deck = await call.read(args.deckId)
      const placed = toolValue(() => anchorFor(deck, args.slideId, args.elementId ?? null, null))
      const { threadId } = await createThread(deps.db, {
        deckId: args.deckId,
        authorId: principal.userId,
        slideId: args.slideId,
        elementId: placed.elementId,
        anchor: placed.anchor,
        body,
      })
      if (deps.collab) await announceThreadChange(deps.collab, args.deckId, threadId)
      return asText({ threadId, slideId: args.slideId, elementId: placed.elementId, url: `${deps.publicUrl}/d/${args.deckId}` })
    },
  )

  tool(
    'list_versions',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'List the saved versions of a deck, newest first: named versions and automatic checkpoints, with their time and the people who edited. Use a versionId with restore_version. Viewers and up.',
      shape: { deckId: deckIdField },
    },
    async (args, call) => {
      await call.role(args.deckId, 'viewer')
      const versions = await listVersions(deps.db, args.deckId, 100)
      return asText({ versions: versions.map((v) => ({ id: v.id, kind: v.kind, name: v.name, createdAt: v.createdAt, editors: v.editors.map((e) => e.name) })) })
    },
  )

  tool(
    'restore_version',
    {
      scope: 'decks:write',
      description:
        'Restore a version of a deck. The deck becomes that version, live for everyone who has it open. The state before the restore is kept first as the named version "Before restore", so the restore can be undone with another restore. Editors and owners. Use list_versions for ids.',
      shape: { deckId: deckIdField, versionId: z.uuid() },
    },
    async (args, call) => {
      await call.role(args.deckId, 'editor')
      const version = await readVersion(deps.db, args.deckId, args.versionId)
      if (!version) throw new ToolError('That version was not found in this deck.')
      if (!deps.collab) throw new ToolError('The live editing service is not configured on this server, so nothing was restored.')
      const result = await deps.collab.restore(args.deckId, { userId: principal.userId, deck: version.deck })
      return asText({ ok: true, restored: version.name ?? version.createdAt.toISOString(), beforeSnapshotId: result.beforeSnapshotId })
    },
  )
}
