// The provider interface every adapter implements. Deliberately small: one request
// shape, one result shape, one stream event union.

export type ProviderKind = 'foundry-claude' | 'azure-openai' | 'openai-compatible'

export interface ImagePart {
  /** e.g. image/png. */
  mediaType: string
  /** Base64 without the data: prefix. */
  base64: string
}

export interface ToolCall {
  id: string
  name: string
  /** The parsed JSON input the model chose. */
  input: unknown
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant turns that asked for tools. */
  toolCalls?: ToolCall[]
  /** Tool turns: the id of the call being answered. */
  toolCallId?: string
  /** User turns: images the model may look at (only sent when the provider supports images). */
  images?: ImagePart[]
}

export interface ToolDef {
  name: string
  description: string
  /** A JSON Schema object (type: object). */
  inputSchema: Record<string, unknown>
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** True when the provider did not report usage and the numbers are a character-based estimate. */
  estimated?: boolean
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'

export interface GenerateRequest {
  system: string
  messages: Message[]
  tools?: ToolDef[]
  /** When set, the reply must be JSON matching this schema. Returned in `text`. */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  maxTokens: number
  temperature: number
  signal?: AbortSignal
}

export interface GenerateResult {
  text: string
  toolCalls: ToolCall[]
  usage: Usage
  stopReason: StopReason
  model: string
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage: Usage; stopReason: StopReason; model: string }

export interface LlmProvider {
  readonly kind: ProviderKind
  readonly model: string
  /** Whether image parts are sent to the model. */
  readonly supportsImages: boolean
  generate(request: GenerateRequest): Promise<GenerateResult>
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.estimated || b.estimated ? { estimated: true } : {}),
  }
}
