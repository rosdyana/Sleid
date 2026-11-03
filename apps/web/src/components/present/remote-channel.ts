// The collab side of the presenter session. The audience window connects to the deck's document (read-only
// is enough) and does two things over stateless messages: it receives phone commands and follow state, and when
// it is presenting it publishes its own state (slide, notes) for the phone and for followers.
import { HocuspocusProvider } from '@hocuspocus/provider'
import { COLLAB_URL } from '~/components/editor/collab-session'
import { isRemoteAction, remoteChannelName, type RemoteAction } from './present-channel'

/** How often a presenter repeats its state. The phone treats a presenter silent for 10 s as not open, and a late follower needs the current slide. */
export const HEARTBEAT_MS = 3000

export interface PublishedState {
  slide: number
  total: number
  slideId: string
  notes: string
  title: string
}

export interface RemoteChannelOptions {
  deckId: string
  /** The session whose messages this channel listens to: its own when presenting, the followed one when following. */
  sid: string
  /** Presenting: publish this session's state. Following: false. */
  publish: boolean
  fetchToken: () => Promise<string>
  onCommand?: (action: RemoteAction) => void
  onState?: (state: PublishedState) => void
  onClosed?: () => void
  url?: string
}

interface Incoming {
  channel?: unknown
  type?: unknown
  action?: unknown
}

export class RemoteChannel {
  private readonly provider: HocuspocusProvider
  private last: PublishedState | null = null
  private destroyed = false
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: RemoteChannelOptions) {
    const channel = remoteChannelName(options.sid)
    this.provider = new HocuspocusProvider({
      url: options.url ?? COLLAB_URL,
      name: options.deckId,
      token: () => options.fetchToken(),
      onStateless: ({ payload }: { payload: string }) => {
        if (this.destroyed) return
        let message: Incoming
        try {
          message = JSON.parse(payload) as Incoming
        } catch {
          return
        }
        if (message.channel !== channel) return
        if (message.type === 'command' && isRemoteAction(message.action)) options.onCommand?.(message.action)
        if (message.type === 'closed') options.onClosed?.()
        if (message.type === 'state') options.onState?.(message as unknown as PublishedState)
      },
      onSynced: () => {
        // The first state may have been sent before the connection was ready. Send the latest again.
        if (this.last) this.send(this.last)
      },
    })
    if (options.publish) {
      this.heartbeat = setInterval(() => {
        if (this.last && !this.destroyed) this.send(this.last)
      }, HEARTBEAT_MS)
    }
  }

  /** Publishes this session's state (presenting only). Sent again after a reconnect. */
  publish(state: PublishedState): void {
    if (!this.options.publish || this.destroyed) return
    this.last = state
    this.send(state)
  }

  private send(state: PublishedState) {
    try {
      this.provider.sendStateless(JSON.stringify({ channel: remoteChannelName(this.options.sid), type: 'state', ...state }))
    } catch {
      // Not connected yet: the onSynced handler sends the latest state once it is.
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.provider.destroy()
  }
}
