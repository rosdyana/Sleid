import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

export interface BrowserPool {
  get(): Promise<Browser>
  close(): Promise<void>
}

/** One Chrome for the whole worker, relaunched when it has died. */
export function createBrowserPool(executablePath?: string): BrowserPool {
  let browser: Browser | null = null
  return {
    async get() {
      if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({ headless: true, executablePath })
      }
      return browser
    },
    async close() {
      const current = browser
      browser = null
      await current?.close()
    },
  }
}

/** Only the local bundle server and inline data may be loaded. Everything else is blocked, so an export never reaches the open internet. */
export function isAllowedExportUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'data:' || u.protocol === 'blob:') return true
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
  } catch {
    return false
  }
}

/** A fresh context with network blocking. The caller closes it. */
export async function newExportContext(browser: Browser, options: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    serviceWorkers: 'block',
    acceptDownloads: false,
  })
  await context.route('**/*', (route) => {
    if (isAllowedExportUrl(route.request().url())) return route.continue()
    return route.abort('blockedbyclient')
  })
  return context
}

export async function withPage<T>(context: BrowserContext, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await context.newPage()
  try {
    return await fn(page)
  } finally {
    await page.close().catch(() => undefined)
  }
}
