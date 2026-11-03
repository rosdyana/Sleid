// The build_deck prompt: the component-first workflow for building a deck with plan_deck and the component tools.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export function buildDeckPromptText(args: { brief: string; audience?: string | undefined; slideCount: string; referenceDeckId?: string | undefined }): string {
  return [
    `Build a slide deck. Brief: ${args.brief}`,
    args.audience ? `The audience is: ${args.audience}.` : 'The audience is not given, so assume a general audience.',
    `Aim for about ${args.slideCount} slides.`,
    args.referenceDeckId ? `Match the look of reference deck ${args.referenceDeckId} (you need read access to it).` : 'Use a clean built-in theme that suits the topic (see sleid://themes).',
    '',
    'Workflow (components first):',
    '1. Call plan_deck with the brief, the slide count, the audience and the reference deck if there is one. Follow its calls in order.',
    '2. create_deck with the title. With a reference deck, call apply_style_from_deck next, before any slide is added.',
    '3. For each screenshot, upload_asset with deckId and keep the assetId.',
    '4. add_slide for each slide, with components. Use variant "dark" for the cover and the closing ask. Start a slide with a header (label, heading, subtitle), then add a card_grid, comparison, browser_frame (assetId), stat_row, timeline, bullets_with_sublines or numbered_cards. Read sleid://guide/elements for each component\'s props. Put what the presenter says in notes.',
    '5. lint_deck. Fix every error and warning with update_component, insert_component or apply_ops, then run it again. Then render_deck (mode sheet) and look at the picture: check for overlap, cut-off text and empty frames.',
    '6. When it is right, export_deck (pptx or pdf) and give the user the download link.',
    '',
    'Stay under 40 tool calls. Do not invent figures: use only numbers from the brief, and mark any sample data as sample data.',
  ].join('\n')
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'build_deck',
    {
      title: 'Build a deck',
      description:
        'A component-first workflow for building a slide deck: plan it with plan_deck, create it, add slides from components, check with lint_deck and render_deck, then export.',
      argsSchema: {
        brief: z.string().min(1).max(2000).optional().describe('What the deck is about. Required, or give topic.'),
        topic: z.string().min(1).max(200).optional().describe('An older name for brief, kept for compatibility.'),
        audience: z.string().max(200).optional(),
        slide_count: z.string().regex(/^\d{1,2}$/).optional(),
        reference_deck_id: z.string().max(60).optional().describe('A deck you can read whose look to match.'),
      },
    },
    ({ brief, topic, audience, slide_count, reference_deck_id }) => {
      const text = brief ?? topic
      if (!text) throw new Error('Give brief (what the deck is about).')
      const body = buildDeckPromptText({
        brief: text,
        audience,
        slideCount: slide_count ?? '10',
        referenceDeckId: reference_deck_id,
      })
      return { messages: [{ role: 'user', content: { type: 'text', text: body } }] }
    },
  )
}
