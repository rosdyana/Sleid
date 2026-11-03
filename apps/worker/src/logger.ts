export interface Logger {
  info(message: string): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export const consoleLogger: Logger = {
  info: (m) => console.info(m),
  warn: (m, d) => console.warn(m, d ?? ''),
  error: (m, d) => console.error(m, d ?? ''),
}
