/** A failure the agent should read as-is: a refused permission, a missing deck, an invalid input. Never a stack trace. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}
