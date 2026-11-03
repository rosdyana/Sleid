// After a role or link change, tells the collab service to re-check open connections.
// Best effort: the database is already correct, and connections are re-checked on reconnect anyway.
import { getCollabInternalClient } from '~/lib/collab-client.server'

export async function revalidateOpenConnections(deckId: string): Promise<void> {
  try {
    await getCollabInternalClient().revalidate(deckId)
  } catch (err) {
    console.warn(`[sharing] could not revalidate open connections for ${deckId}`, err)
  }
}
