// The MCP resources: the JSON schemas, the built-in themes, the templates, a deck's outline, and the element guide.
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BUILT_IN_THEMES, deckJsonSchema } from '@sleid/model'
import { tokenHasScope, type VerifiedToken } from '@sleid/db'
import { listTemplatesFor, type TemplateDeps } from '~/lib/templates.server'
import { messageFor } from './call.ts'
import { Call } from './call.ts'
import { outlineOf } from './compile.ts'
import type { McpDeps } from './deps.ts'
import { GUIDE_ELEMENTS_MD } from './guide-elements.ts'

export interface ResourceDeps {
  server: McpServer
  deps: McpDeps
  principal: VerifiedToken
  templateDepsFor: () => TemplateDeps
}

export function registerResources({ server, deps, principal, templateDepsFor }: ResourceDeps): void {
  const jsonResource = (uri: string, title: string, description: string, value: () => unknown) => {
    server.registerResource(title, uri, { title, description, mimeType: 'application/json' }, async (location) => ({
      contents: [{ uri: location.href, mimeType: 'application/json', text: JSON.stringify(value(), null, 2) }],
    }))
  }
  jsonResource('sleid://schema/deck', 'Deck JSON Schema', 'The deck document (what get_deck format=json returns).', () => deckJsonSchema().deck)
  jsonResource(
    'sleid://schema/ops',
    'Deck-ops JSON Schema',
    'The operations apply_ops accepts, one schema per op. The element defaults and the component props are in sleid://guide/elements.',
    () => deckJsonSchema().op,
  )
  jsonResource('sleid://themes', 'Built-in themes', 'The built-in themes, with their colours, fonts and sizes.', () => BUILT_IN_THEMES)
  server.registerResource(
    'Element guide',
    'sleid://guide/elements',
    {
      title: 'Element guide',
      description: 'How to build slides: the components and their props, the raw element defaults, text marks, icons, images and checks. Read it before add_slide with components or apply_ops.',
      mimeType: 'text/markdown',
    },
    async (location) => ({ contents: [{ uri: location.href, mimeType: 'text/markdown', text: GUIDE_ELEMENTS_MD }] }),
  )
  server.registerResource(
    'Templates',
    'sleid://templates',
    { title: 'Templates', description: 'The templates you can use: id, name, description, category and slide count.', mimeType: 'application/json' },
    async (location) => {
      if (!tokenHasScope(principal, 'decks:read')) throw new Error('This token does not have the decks:read scope.')
      const list = await listTemplatesFor(templateDepsFor(), principal.userId)
      const text = JSON.stringify(
        list.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, slideCount: t.slideCount, builtIn: t.builtIn })),
        null,
        2,
      )
      return { contents: [{ uri: location.href, mimeType: 'application/json', text }] }
    },
  )

  server.registerResource(
    'Deck outline',
    new ResourceTemplate('sleid://decks/{deckId}', { list: undefined }),
    { title: 'Deck outline', description: 'The outline of a deck you can read (same as get_deck, format outline).', mimeType: 'application/json' },
    async (location, variables) => {
      if (!tokenHasScope(principal, 'decks:read')) throw new Error('This token does not have the decks:read scope.')
      const call = new Call(deps, principal)
      const deckId = String(variables.deckId)
      const deck = await call.read(deckId).catch((err: unknown) => {
        throw new Error(messageFor(err, deps, 'resource'))
      })
      return { contents: [{ uri: location.href, mimeType: 'application/json', text: JSON.stringify(outlineOf(deck), null, 2) }] }
    },
  )
}
