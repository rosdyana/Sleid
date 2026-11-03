// A fake SearXNG for the wizard's research check (tests/wizard.mjs). It answers /search?format=json with two results
// that point back at this same server, and serves those pages, so research needs no internet access.
// Routes:
//   GET /search?q=…&format=json  -> { results: [{ title, url, content }] }
//   GET /pages/a, /pages/b, /manual -> small HTML pages (the manual one is the URL the e2e adds by hand)
// Usage from another script: const fake = await startFakeSearxng(); fake.url, await fake.close()
// Run alone: node tests/fake-searxng.mjs 4412   (the research check then sets SEARXNG_URL=http://127.0.0.1:4412)
import { createServer } from 'node:http'

const PAGES = {
  '/pages/a': {
    title: 'Solar power for small bakeries',
    body: 'Rooftop solar panels can cut the electricity bill of a small bakery. Ovens and mixers run in the day, when the panels produce most power.',
  },
  '/pages/b': {
    title: 'Electricity savings from rooftop solar',
    body: 'Owners who install rooftop solar see lower monthly bills. Savings depend on the roof, the tariff and the hours the shop is open.',
  },
  '/manual': {
    title: 'Manual reference: how rooftop solar works',
    body: 'A rooftop system has panels, an inverter that turns direct current into alternating current, and a connection to the grid.',
  },
}

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body><nav>Menu</nav><article><h1>${title}</h1><p>${body}</p></article></body></html>`
}

export async function startFakeSearxng(port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.local')
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          query: url.searchParams.get('q') ?? '',
          results: [
            { title: PAGES['/pages/a'].title, url: `${origin}/pages/a`, content: PAGES['/pages/a'].body },
            { title: PAGES['/pages/b'].title, url: `${origin}/pages/b`, content: PAGES['/pages/b'].body },
          ],
        }),
      )
      return
    }
    const hit = PAGES[url.pathname]
    if (hit) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(hit.title, hit.body))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    manualUrl: `http://127.0.0.1:${address.port}/manual`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// Manual run: node tests/fake-searxng.mjs 4412
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeSearxng(Number(process.argv[2] ?? 4412))
  console.log(`fake SearXNG on ${fake.url}`)
}
