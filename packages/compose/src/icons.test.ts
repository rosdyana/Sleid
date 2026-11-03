import { describe, expect, it } from 'vitest'
import { VECTOR_PATH_D_RE, VectorPathSchema, ElementSchema } from '@sleid/model'
import { closestIconNames, iconElement, iconPaths, listIcons, resolveIconName } from './icons.ts'

describe('icons', () => {
  it.each(['lock', 'link', 'eye-off', 'copy', 'key', 'check', 'x'])('%s resolves to paths that pass the vector regex', (name) => {
    const paths = iconPaths(name)
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      expect(VECTOR_PATH_D_RE.test(p.d)).toBe(true)
    }
  })

  it('accepts kebab, Pascal and lowercase names alike', () => {
    expect(resolveIconName('eye-off')).toBe('EyeOff')
    expect(resolveIconName('EyeOff')).toBe('EyeOff')
    expect(resolveIconName('eyeoff')).toBe('EyeOff')
    expect(resolveIconName('lock')).toBe('Lock')
    expect(resolveIconName('no-such-icon-xyz')).toBeUndefined()
  })

  it('throws for an unknown name, listing up to five close names', () => {
    let message = ''
    try {
      iconPaths('lokc')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/Unknown icon "lokc"/)
    const named = message.match(/Closest: (.*)\. Use/)?.[1]?.split(', ') ?? []
    expect(named.length).toBeGreaterThan(0)
    expect(named.length).toBeLessThanOrEqual(5)
    expect(named).toContain('lock')
  })

  it('closestIconNames returns at most the limit', () => {
    expect(closestIconNames('zzz', 3)).toHaveLength(3)
  })

  it('builds a stroked vector element in a 24 box', () => {
    const el = iconElement('check', { x: 10, y: 20, size: 34 }, '#2d62c9')
    expect(el).toMatchObject({ type: 'vector', x: 10, y: 20, w: 34, h: 34, viewBox: { x: 0, y: 0, w: 24, h: 24 }, preserveAspectRatio: true })
    const paths = (el as { paths: unknown[] }).paths
    for (const p of paths) {
      expect(VectorPathSchema.safeParse(p).success).toBe(true)
      expect(p).toMatchObject({ fill: 'transparent', stroke: '#2d62c9', strokeWidth: 2, lineCap: 'round', lineJoin: 'round' })
    }
    expect(ElementSchema.safeParse({ ...el, id: 'i', z: 0, rotation: 0, locked: false, opacity: 1 }).success).toBe(true)
  })

  it('lists icons, filtered by query', () => {
    expect(listIcons().length).toBeGreaterThan(2000)
    const eye = listIcons('eye-off')
    expect(eye).toContain('eye-off')
    expect(listIcons('zzzzqqq')).toEqual([])
  })
})
