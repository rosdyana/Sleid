// M9: the wizard brief accepts a template and a brand kit; the template's layouts become the preferred layouts.
import { describe, expect, it } from 'vitest'
import { WizardBrief, wizardLayoutsOf } from './wizard-schema.ts'

describe('wizard brief: template and brand kit', () => {
  it('accepts a built-in template id, a user template uuid and a kit uuid, and leaves them optional', () => {
    expect(WizardBrief.parse({ prompt: 'x' })).not.toHaveProperty('templateId')
    expect(WizardBrief.parse({ prompt: 'x', templateId: 'builtin:pitch' }).templateId).toBe('builtin:pitch')
    const uuid = '0f8b1c2e-4a5d-4e6f-8a9b-0c1d2e3f4a5b'
    expect(WizardBrief.parse({ prompt: 'x', templateId: uuid, brandKitId: uuid }).brandKitId).toBe(uuid)
  })

  it('refuses ids that are neither a uuid nor a built-in key', () => {
    expect(() => WizardBrief.parse({ prompt: 'x', templateId: 'pitch' })).toThrow()
    expect(() => WizardBrief.parse({ prompt: 'x', templateId: 'builtin:Bad Key' })).toThrow()
    expect(() => WizardBrief.parse({ prompt: 'x', brandKitId: 'not-a-uuid' })).toThrow()
  })

  it('lists a deck\'s wizard layouts once each, in first-use order, and drops layouts the wizard does not write', () => {
    expect(wizardLayoutsOf(['title', 'title-content', 'image-left', 'title-content', 'quote', 'section'])).toEqual(['title', 'title-content', 'quote', 'section'])
    expect(wizardLayoutsOf(['image-full'])).toEqual([])
  })
})
