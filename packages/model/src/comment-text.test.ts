import { describe, expect, it } from 'vitest'
import { commentPlainText, extractMentionIds, mentionMarkup, parseCommentBody, validateCommentBody, COMMENT_MAX_LENGTH } from './comment-text.ts'

describe('comment mentions', () => {
  it('writes markup that reads back as the same name and id', () => {
    const markup = mentionMarkup('Ana [admin] (ops)', 'user_123-abc')
    expect(markup).toBe('@[Ana admin ops](user_123-abc)')
    expect(extractMentionIds(`hi ${markup}`)).toEqual(['user_123-abc'])
  })

  it('returns each mentioned id once, in order', () => {
    const body = '@[A](u1) and @[B](u2) and again @[A](u1)'
    expect(extractMentionIds(body)).toEqual(['u1', 'u2'])
  })

  it('ignores text that looks like a mention but has bad characters in the id', () => {
    expect(extractMentionIds('@[Eve](bad id here) @[Mal](../../x)')).toEqual([])
  })
})

describe('comment body parsing', () => {
  it('turns markup into inline nodes and keeps plain text as text', () => {
    const [line] = parseCommentBody('Check **this** and *that* with `x+1` for @[Bo](u9)!')
    expect(line).toEqual([
      { kind: 'text', text: 'Check ' },
      { kind: 'strong', text: 'this' },
      { kind: 'text', text: ' and ' },
      { kind: 'em', text: 'that' },
      { kind: 'text', text: ' with ' },
      { kind: 'code', text: 'x+1' },
      { kind: 'text', text: ' for ' },
      { kind: 'mention', name: 'Bo', userId: 'u9' },
      { kind: 'text', text: '!' },
    ])
  })

  it('splits lines on line breaks and keeps unclosed markers literal', () => {
    const lines = parseCommentBody('first *open\nsecond **ok**')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual([{ kind: 'text', text: 'first *open' }])
    expect(lines[1]).toEqual([
      { kind: 'text', text: 'second ' },
      { kind: 'strong', text: 'ok' },
    ])
  })

  it('never produces markup: script tags stay as text', () => {
    const [line] = parseCommentBody('<script>alert(1)</script>')
    expect(line).toEqual([{ kind: 'text', text: '<script>alert(1)</script>' }])
  })

  it('plain text shows mentions as @Name and drops the markers', () => {
    expect(commentPlainText('Hi @[Ana](u1), **see** *this* `now`')).toBe('Hi @Ana, see this now')
  })
})

describe('comment body validation', () => {
  it('trims, and rejects empty or too long bodies', () => {
    expect(validateCommentBody('  hello  ')).toBe('hello')
    expect(() => validateCommentBody('   ')).toThrow('empty')
    expect(() => validateCommentBody('x'.repeat(COMMENT_MAX_LENGTH + 1))).toThrow('5000')
    expect(validateCommentBody('x'.repeat(COMMENT_MAX_LENGTH))).toHaveLength(COMMENT_MAX_LENGTH)
  })
})
