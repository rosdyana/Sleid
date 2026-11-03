import { describe, expect, it } from 'vitest'
import { NOT_A_SLIDES_LINK, SlidesLinkError, isExportRedirectAllowed, parseSlidesLink, testGoogleExportOrigin } from './google-slides'

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-012'

describe('parseSlidesLink (strict)', () => {
  it('reads the id from the usual edit link and from the shorter forms', () => {
    expect(parseSlidesLink(`https://docs.google.com/presentation/d/${ID}/edit`)).toEqual({ presentationId: ID })
    expect(parseSlidesLink(`https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`)).toEqual({ presentationId: ID })
    expect(parseSlidesLink(`https://docs.google.com/presentation/d/${ID}`)).toEqual({ presentationId: ID })
    expect(parseSlidesLink(`  https://docs.google.com/presentation/d/${ID}/pub  `)).toEqual({ presentationId: ID })
  })

  it('refuses other hosts, including look-alikes and other Google products', () => {
    for (const host of ['evil.example', 'docs.google.com.evil.example', 'drive.google.com', 'sheets.google.com', 'www.docs.google.com', 'docs-google.com']) {
      expect(() => parseSlidesLink(`https://${host}/presentation/d/${ID}/edit`), host).toThrow(SlidesLinkError)
    }
  })

  it('refuses http, a port, and user information', () => {
    expect(() => parseSlidesLink(`http://docs.google.com/presentation/d/${ID}/edit`)).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`https://docs.google.com:8443/presentation/d/${ID}/edit`)).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`https://user@docs.google.com/presentation/d/${ID}/edit`)).toThrow(SlidesLinkError)
  })

  it('refuses paths that are not a presentation, and short or odd ids', () => {
    expect(() => parseSlidesLink(`https://docs.google.com/document/d/${ID}/edit`)).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink('https://docs.google.com/presentation/d/short/edit')).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`https://docs.google.com/presentation/d/${ID}.x/edit`)).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`https://docs.google.com/presentation/d/${ID}%2F../edit`)).toThrow(SlidesLinkError)
    // Dot segments are normalised by the URL parser, so this path leaves the presentation and is refused.
    expect(() => parseSlidesLink(`https://docs.google.com/presentation/d/${ID}1/../../../etc/passwd`)).toThrow(SlidesLinkError)
  })

  it('refuses empty, over-long and non-URL input with the message the user sees', () => {
    expect(() => parseSlidesLink('')).toThrow(NOT_A_SLIDES_LINK)
    expect(() => parseSlidesLink('   ')).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`docs.google.com/presentation/d/${ID}/edit`)).toThrow(SlidesLinkError)
    expect(() => parseSlidesLink(`https://docs.google.com/presentation/d/${ID}/edit?x=${'a'.repeat(2000)}`)).toThrow(SlidesLinkError)
  })
})

describe('isExportRedirectAllowed', () => {
  it('allows docs.google.com and subdomains of googleusercontent.com over https on the default port', () => {
    expect(isExportRedirectAllowed(new URL('https://docs.google.com/export/abc'))).toBe(true)
    expect(isExportRedirectAllowed(new URL('https://lh3.googleusercontent.com/presentation/d/x'))).toBe(true)
    expect(isExportRedirectAllowed(new URL('https://doc-0k.googleusercontent.com/f'))).toBe(true)
  })

  it('refuses any other host, the bare googleusercontent.com domain, and look-alikes', () => {
    for (const href of [
      'https://evil.example/x',
      'https://googleusercontent.com/x',
      'https://evilgoogleusercontent.com/x',
      'https://docs.google.com.evil.example/x',
      'https://accounts.google.com/ServiceLogin',
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/x',
      'https://localhost/x',
    ]) {
      expect(isExportRedirectAllowed(new URL(href)), href).toBe(false)
    }
  })

  it('refuses http, other ports and user information even on an allowed host', () => {
    expect(isExportRedirectAllowed(new URL('http://docs.google.com/x'))).toBe(false)
    expect(isExportRedirectAllowed(new URL('https://docs.google.com:444/x'))).toBe(false)
    expect(isExportRedirectAllowed(new URL('https://a@docs.google.com/x'))).toBe(false)
  })

  it('allows only the test origin when one is given (and only that origin)', () => {
    const testOrigin = new URL('http://127.0.0.1:4413')
    expect(isExportRedirectAllowed(new URL('http://127.0.0.1:4413/file.pptx'), testOrigin)).toBe(true)
    expect(isExportRedirectAllowed(new URL('http://127.0.0.1:4414/file.pptx'), testOrigin)).toBe(false)
    expect(isExportRedirectAllowed(new URL('https://evil.example/x'), testOrigin)).toBe(false)
  })
})

describe('testGoogleExportOrigin (test-only override)', () => {
  const origin = 'http://127.0.0.1:4413'

  it('is off unless the variable is set', () => {
    expect(testGoogleExportOrigin({ SLEID_TEST_AUTH: '1' })).toBeNull()
  })

  it('is ignored without SLEID_TEST_AUTH=1', () => {
    expect(testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin })).toBeNull()
    expect(testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin, SLEID_TEST_AUTH: '0' })).toBeNull()
  })

  it('is refused outright when NODE_ENV=production', () => {
    expect(() => testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin, SLEID_TEST_AUTH: '1', NODE_ENV: 'production' })).toThrow(/production/)
  })

  it('must be a local http origin', () => {
    expect(testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin, SLEID_TEST_AUTH: '1' })?.origin).toBe(origin)
    expect(() => testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: 'https://docs.google.com', SLEID_TEST_AUTH: '1' })).toThrow(/local http/)
    expect(() => testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: 'http://10.0.0.5:4413', SLEID_TEST_AUTH: '1' })).toThrow(/local http/)
    expect(() => testGoogleExportOrigin({ SLEID_TEST_GOOGLE_EXPORT_ORIGIN: 'not a url', SLEID_TEST_AUTH: '1' })).toThrow(/origin/)
  })
})
