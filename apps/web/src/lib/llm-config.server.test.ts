import { describe, expect, it } from 'vitest'
import { adminEmails, allowPrivateUserUrls, envProvider, isAdminEmail, llmSecretKey, networkPolicyFor, rateLimitFromEnv } from './llm-config.server.ts'

describe('assistant configuration from the environment', () => {
  it('reads admin emails case-insensitively', () => {
    const env = { ADMIN_EMAILS: ' Boss@Example.com, second@example.com ,' }
    expect(adminEmails(env)).toEqual(['boss@example.com', 'second@example.com'])
    expect(isAdminEmail('BOSS@example.com', env)).toBe(true)
    expect(isAdminEmail('someone@example.com', env)).toBe(false)
    expect(isAdminEmail('x@y.z', {})).toBe(false)
  })

  it('reads the secret key only when it is set', () => {
    expect(llmSecretKey({})).toBeUndefined()
    expect(llmSecretKey({ LLM_SECRET_KEY: '  abc=  ' })).toBe('abc=')
  })

  it('builds the environment default for each kind, and needs its required values', () => {
    expect(envProvider({})).toBeNull()
    expect(envProvider({ SLEID_LLM_KIND: 'foundry-claude', SLEID_LLM_ENDPOINT: 'res', SLEID_LLM_API_KEY: 'k', SLEID_LLM_MODEL: 'claude-opus-5-5' })).toMatchObject({
      kind: 'foundry-claude',
      name: 'Server default',
      hasKey: true,
      spec: { kind: 'foundry-claude', endpoint: 'res', apiKey: 'k', model: 'claude-opus-5-5' },
    })
    expect(envProvider({ SLEID_LLM_KIND: 'foundry-claude', SLEID_LLM_ENDPOINT: 'res', SLEID_LLM_MODEL: 'm' })).toBeNull()
    expect(envProvider({ SLEID_LLM_KIND: 'azure-openai', SLEID_LLM_ENDPOINT: 'https://r.openai.azure.com', SLEID_LLM_API_KEY: 'k', SLEID_LLM_MODEL: 'dep', SLEID_LLM_API_VERSION: '2024-10-21' })?.spec).toMatchObject({
      kind: 'azure-openai',
      deployment: 'dep',
      apiVersion: '2024-10-21',
    })
    const local = envProvider({ SLEID_LLM_KIND: 'openai-compatible', SLEID_LLM_ENDPOINT: 'http://127.0.0.1:11434/v1', SLEID_LLM_MODEL: 'qwen', SLEID_LLM_SUPPORTS_IMAGES: 'true', SLEID_LLM_NAME: 'Ollama' })
    expect(local).toMatchObject({ kind: 'openai-compatible', name: 'Ollama', hasKey: false, supportsImages: true })
    expect(local?.spec).toMatchObject({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', structured: 'auto' })
    expect(envProvider({ SLEID_LLM_KIND: 'nope' })).toBeNull()
  })

  it('reads the rate limit, with the defaults of 30 requests per 600 seconds', () => {
    expect(rateLimitFromEnv({})).toEqual({ max: 30, windowMs: 600_000 })
    expect(rateLimitFromEnv({ AI_RATE_LIMIT_MAX: '5', AI_RATE_LIMIT_WINDOW_SECONDS: '60' })).toEqual({ max: 5, windowMs: 60_000 })
    expect(rateLimitFromEnv({ AI_RATE_LIMIT_MAX: 'lots' })).toEqual({ max: 30, windowMs: 600_000 })
  })
})

describe('network policy by scope', () => {
  it('only the exact value 1 turns on private addresses for user providers', () => {
    expect(allowPrivateUserUrls({ LLM_USER_ALLOW_PRIVATE_URLS: '1' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(allowPrivateUserUrls({ LLM_USER_ALLOW_PRIVATE_URLS: value })).toBe(false)
    }
  })

  it('user providers follow the flag; workspace and environment providers always may use private addresses', () => {
    expect(networkPolicyFor('user', {})).toEqual({ allowPrivate: false })
    expect(networkPolicyFor('user', { LLM_USER_ALLOW_PRIVATE_URLS: '1' })).toEqual({ allowPrivate: true })
    expect(networkPolicyFor('workspace', {})).toEqual({ allowPrivate: true })
    expect(networkPolicyFor('environment', {})).toEqual({ allowPrivate: true })
  })
})
