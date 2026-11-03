// Settings › AI: the model providers the assistant can use. Keys are write-only: the page shows
// "••••• set" and never gets the key back. A test sends one tiny request and reports the outcome.
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { researchStatusFn } from '~/lib/wizard.functions'
import { listAiProvidersFn, saveAiProviderFn, deleteAiProviderFn, setDefaultAiProviderFn, testAiProviderFn } from '~/lib/llm-settings.functions'
import type { ProviderView } from '~/lib/llm-settings.server'

export const Route = createFileRoute('/_authed/settings/ai')({
  loader: () => listAiProvidersFn(),
  component: AiSettings,
})

type Kind = ProviderView['kind']

const KIND_LABEL: Record<Kind, string> = {
  'foundry-claude': 'Claude on Microsoft Foundry',
  'azure-openai': 'Azure OpenAI',
  'openai-compatible': 'Local model (Ollama, LM Studio, llama.cpp, vLLM)',
}

const KIND_HELP: Record<Kind, { endpoint: string; endpointHint: string; model: string; modelHint: string }> = {
  'foundry-claude': {
    endpoint: 'Resource name or endpoint URL',
    endpointHint: 'my-resource, or https://my-resource.services.ai.azure.com/anthropic/',
    model: 'Deployment name',
    modelHint: 'claude-opus-5-5',
  },
  'azure-openai': {
    endpoint: 'Endpoint',
    endpointHint: 'https://my-resource.openai.azure.com',
    model: 'Deployment name',
    modelHint: 'gpt-5-deployment',
  },
  'openai-compatible': {
    endpoint: 'Base URL (include /v1)',
    endpointHint: 'http://127.0.0.1:11434/v1 (Ollama) or http://127.0.0.1:1234/v1 (LM Studio)',
    model: 'Model name',
    modelHint: 'qwen2.5:7b, llama3.1, ...',
  },
}

interface FormState {
  id?: string
  kind: Kind
  scope: 'user' | 'workspace'
  name: string
  endpoint: string
  defaultModel: string
  apiVersion: string
  structured: 'auto' | 'json_schema' | 'tools' | 'prompt'
  supportsImages: boolean
  compactPrompts: boolean
  disableThinking: boolean
  reasoningEffort: '' | 'low' | 'medium' | 'high'
  apiKey: string
  makeDefault: boolean
  hasSecret: boolean
}

const EMPTY: FormState = {
  kind: 'foundry-claude',
  scope: 'user',
  name: '',
  endpoint: '',
  defaultModel: '',
  apiVersion: '',
  structured: 'auto',
  supportsImages: false,
  compactPrompts: false,
  disableThinking: false,
  reasoningEffort: '',
  apiKey: '',
  makeDefault: false,
  hasSecret: false,
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function AiSettings() {
  const loaded = Route.useLoaderData()
  const [providers, setProviders] = useState(loaded.providers)
  const [isAdmin] = useState(loaded.isAdmin)
  const [form, setForm] = useState<FormState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, string>>({})

  async function reload() {
    const next = await listAiProvidersFn()
    setProviders(next.providers)
  }

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label)
    setError(null)
    try {
      await action()
      await reload()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  async function test(id: string) {
    setBusy(`test-${id}`)
    try {
      const result = await testAiProviderFn({ data: { id } })
      setTests((prev) => ({
        ...prev,
        [id]: result.ok
          ? `OK · ${result.model || 'model'} · ${result.latencyMs} ms`
          : `Failed · ${result.error ?? 'no reply'}${result.latencyMs ? ` · ${result.latencyMs} ms` : ''}`,
      }))
    } catch (err) {
      setTests((prev) => ({ ...prev, [id]: `Failed · ${messageOf(err)}` }))
    } finally {
      setBusy(null)
    }
  }

  function edit(p: ProviderView) {
    setForm({
      id: p.id,
      kind: p.kind,
      scope: p.scope === 'workspace' ? 'workspace' : 'user',
      name: p.name,
      endpoint: p.endpoint,
      defaultModel: p.defaultModel,
      apiVersion: p.apiVersion ?? '',
      structured: (p.structured as FormState['structured'] | null) ?? 'auto',
      supportsImages: p.supportsImages,
      compactPrompts: p.compactPrompts,
      disableThinking: p.disableThinking,
      reasoningEffort: p.reasoningEffort ?? '',
      apiKey: '',
      makeDefault: p.isDefault,
      hasSecret: p.hasSecret,
    })
    setError(null)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form) return
    setBusy('save')
    setError(null)
    try {
      await saveAiProviderFn({
        data: {
          ...(form.id ? { id: form.id } : {}),
          kind: form.kind,
          scope: form.scope,
          name: form.name,
          endpoint: form.endpoint,
          defaultModel: form.defaultModel,
          ...(form.kind === 'azure-openai' && form.apiVersion ? { apiVersion: form.apiVersion } : {}),
          structured: form.structured,
          supportsImages: form.supportsImages,
          compactPrompts: form.compactPrompts,
          ...(form.kind === 'openai-compatible' ? { disableThinking: form.disableThinking } : {}),
          ...(form.kind === 'openai-compatible' && form.reasoningEffort ? { reasoningEffort: form.reasoningEffort } : {}),
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          makeDefault: form.makeDefault,
        },
      })
      setForm(null)
      await reload()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const help = form ? KIND_HELP[form.kind] : null
  const userProviders = providers.filter((p) => p.source === 'database')
  const envProvider = providers.find((p) => p.source === 'environment')

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-rule bg-white px-4">
        <div className="flex items-center gap-2">
          <Link to="/" className="grid size-8 place-items-center rounded bg-accent font-semibold text-white" aria-label="Back to decks">
            S
          </Link>
          <h1 className="text-lg font-medium">AI providers</h1>
        </div>
        <Link to="/" className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
          Back to decks
        </Link>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <ResearchStatus />
        <section className="space-y-2 text-[14px] text-ink-muted">
          <p>
            The assistant sends deck content to the provider you pick, for each request. Choose a provider you trust with that content. A deployment
            can also set one provider for everyone with the SLEID_LLM_* variables (see README.md).
          </p>
          <p>
            Keys are encrypted with LLM_SECRET_KEY before they are stored. They are never shown again: the page shows “••••• set” and you can replace the key by
            typing a new one.
          </p>
        </section>

        {error && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
            {error}
          </p>
        )}

        <section aria-label="Providers" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">Your providers</h2>
            <button
              type="button"
              onClick={() => {
                setForm({ ...EMPTY })
                setError(null)
              }}
              className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:brightness-95"
            >
              Add provider
            </button>
          </div>
          {userProviders.length === 0 && <p className="text-ink-muted">No providers yet.</p>}
          <ul className="divide-y divide-rule-soft rounded-lg border border-rule bg-white">
            {userProviders.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                busy={busy}
                testResult={tests[p.id]}
                onTest={() => void test(p.id)}
                onEdit={() => edit(p)}
                onDefault={() => void run('default', () => setDefaultAiProviderFn({ data: { id: p.id } }))}
                onDelete={() => {
                  if (window.confirm(`Delete “${p.name}”? Its stored key is deleted with it.`)) void run('delete', () => deleteAiProviderFn({ data: { id: p.id } }))
                }}
              />
            ))}
          </ul>
        </section>

        {(isAdmin || providers.some((p) => p.scope === 'workspace')) && (
          <section aria-label="Workspace providers" className="space-y-3">
            <h2 className="text-base font-medium">Workspace providers</h2>
            <p className="text-ink-muted">Available to everyone on this instance. Only administrators (ADMIN_EMAILS) can change them.</p>
            <ul className="divide-y divide-rule-soft rounded-lg border border-rule bg-white">
              {providers
                .filter((p) => p.scope === 'workspace')
                .map((p) => (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    busy={busy}
                    testResult={tests[p.id]}
                    onTest={() => void test(p.id)}
                    onEdit={() => edit(p)}
                    onDefault={() => void run('default', () => setDefaultAiProviderFn({ data: { id: p.id } }))}
                    onDelete={() => {
                      if (window.confirm(`Delete “${p.name}” for everyone?`)) void run('delete', () => deleteAiProviderFn({ data: { id: p.id } }))
                    }}
                  />
                ))}
            </ul>
          </section>
        )}

        {envProvider && (
          <section aria-label="Server default" className="space-y-2">
            <h2 className="text-base font-medium">Server default</h2>
            <ul className="rounded-lg border border-rule bg-white">
              <ProviderRow
                provider={envProvider}
                busy={busy}
                testResult={tests[envProvider.id]}
                onTest={() => void test(envProvider.id)}
                readOnly
              />
            </ul>
            <p className="text-[12px] text-ink-muted">Set by the server through SLEID_LLM_* variables. Change it in the environment, then restart.</p>
          </section>
        )}

        {form && (
          <form aria-label={form.id ? 'Edit provider' : 'Add provider'} onSubmit={save} className="space-y-3 rounded-lg border border-rule bg-white p-4">
            <h2 className="text-base font-medium">{form.id ? 'Edit provider' : 'Add provider'}</h2>
            <Field id="ai-kind" label="Kind">
              <select
                id="ai-kind"
                className={inputClass}
                value={form.kind}
                disabled={!!form.id}
                onChange={(e) => {
                  const kind = e.target.value as Kind
                  // Compact prompts follow the kind's default, until the user sets it.
                  setForm({ ...form, kind, endpoint: '', defaultModel: '', apiVersion: '', compactPrompts: kind === 'openai-compatible' })
                }}
              >
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="ai-scope" label="Who can use it">
              <select id="ai-scope" className={inputClass} value={form.scope} disabled={!!form.id} onChange={(e) => setForm({ ...form, scope: e.target.value as FormState['scope'] })}>
                <option value="user">Only me</option>
                {isAdmin && <option value="workspace">Everyone on this instance</option>}
              </select>
            </Field>
            <Field id="ai-name" label="Name">
              <input id="ai-name" className={inputClass} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="For example: Work Foundry" />
            </Field>
            <Field id="ai-endpoint" label={help!.endpoint}>
              <input id="ai-endpoint" className={inputClass} required value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder={help!.endpointHint} />
            </Field>
            <Field id="ai-model" label={help!.model}>
              <input id="ai-model" className={inputClass} required value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })} placeholder={help!.modelHint} />
            </Field>
            {form.kind === 'azure-openai' && (
              <Field id="ai-api-version" label="API version (optional)">
                <input id="ai-api-version" className={inputClass} value={form.apiVersion} onChange={(e) => setForm({ ...form, apiVersion: e.target.value })} placeholder="2024-10-21" />
              </Field>
            )}
            <Field id="ai-structured" label="Structured output">
              <select id="ai-structured" className={inputClass} value={form.structured} onChange={(e) => setForm({ ...form, structured: e.target.value as FormState['structured'] })}>
                <option value="auto">Automatic (recommended)</option>
                <option value="json_schema">JSON schema (response_format)</option>
                <option value="tools">Forced tool call</option>
                <option value="prompt">JSON-only prompt (for small local models)</option>
              </select>
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.supportsImages} onChange={(e) => setForm({ ...form, supportsImages: e.target.checked })} />
              <span>This model accepts pictures (used for alt text)</span>
            </label>
            <label className="flex items-center gap-2">
              <input id="ai-compact" type="checkbox" checked={form.compactPrompts} onChange={(e) => setForm({ ...form, compactPrompts: e.target.checked })} />
              <span>Compact prompts: smaller schemas, for small models (on by default for local servers)</span>
            </label>
            {form.kind === 'openai-compatible' && (
              <>
                <label className="flex items-center gap-2">
                  <input id="ai-thinking" type="checkbox" checked={form.disableThinking} onChange={(e) => setForm({ ...form, disableThinking: e.target.checked })} />
                  <span>Turn off thinking (reasoning models: sends enable_thinking = false; the server must accept it, otherwise it is ignored)</span>
                </label>
                <Field id="ai-effort" label="Reasoning effort (optional)">
                  <select id="ai-effort" className={inputClass} value={form.reasoningEffort} onChange={(e) => setForm({ ...form, reasoningEffort: e.target.value as FormState['reasoningEffort'] })}>
                    <option value="">Server default</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </Field>
              </>
            )}
            <Field id="ai-key" label={form.hasSecret ? 'API key (leave empty to keep the stored key)' : 'API key (optional for local servers)'}>
              <input
                id="ai-key"
                className={inputClass}
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={form.hasSecret ? '••••• set' : ''}
              />
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.makeDefault} onChange={(e) => setForm({ ...form, makeDefault: e.target.checked })} />
              <span>Use as my default</span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setForm(null)} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
                Cancel
              </button>
              <button type="submit" disabled={busy === 'save'} className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-60">
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  )
}

const inputClass = 'h-9 w-full rounded border border-rule bg-white px-2 text-[14px] outline-none focus:border-accent disabled:bg-hover'

/** A labelled control. The label is linked by id, so its name is just the label text. */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="block space-y-1">
      <label htmlFor={id} className="block text-[13px] text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  )
}

function ProviderRow({
  provider,
  busy,
  testResult,
  onTest,
  onEdit,
  onDefault,
  onDelete,
  readOnly,
}: {
  provider: ProviderView
  busy: string | null
  testResult?: string
  onTest: () => void
  onEdit?: () => void
  onDefault?: () => void
  onDelete?: () => void
  readOnly?: boolean
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{provider.name}</span>
          {provider.isDefault && <span className="rounded bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-[#001d35]">Default</span>}
          {provider.scope === 'workspace' && <span className="rounded bg-hover px-2 py-0.5 text-[11px] text-ink-muted">Everyone</span>}
          {provider.scope === 'environment' && <span className="rounded bg-hover px-2 py-0.5 text-[11px] text-ink-muted">Server</span>}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-ink-muted">
          {KIND_LABEL[provider.kind]} · {provider.defaultModel} · {provider.endpoint}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Key: {provider.hasSecret ? '••••• set' : 'none'}
          {provider.supportsImages ? ' · pictures on' : ''}
        </p>
        {testResult && (
          <p role="status" className={`mt-1 text-[12px] ${testResult.startsWith('OK') ? 'text-green-800' : 'text-red-700'}`}>
            {testResult}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={onTest} disabled={busy === `test-${provider.id}`} className="rounded border border-rule px-2.5 py-1 hover:bg-hover disabled:opacity-60">
          {busy === `test-${provider.id}` ? 'Testing…' : 'Test connection'}
        </button>
        {!readOnly && provider.editable && onEdit && (
          <button type="button" onClick={onEdit} className="rounded px-2.5 py-1 text-accent hover:bg-hover">
            Edit
          </button>
        )}
        {!readOnly && provider.editable && !provider.isDefault && onDefault && (
          <button type="button" onClick={onDefault} className="rounded px-2.5 py-1 text-accent hover:bg-hover">
            Make default
          </button>
        )}
        {!readOnly && provider.editable && onDelete && (
          <button type="button" onClick={onDelete} className="rounded px-2.5 py-1 text-red-700 hover:bg-red-50">
            Delete
          </button>
        )}
      </div>
    </li>
  )
}

/** Research (web search) is set by the server's environment, so this line is read-only. */
function ResearchStatus() {
  const [line, setLine] = useState('Research: checking…')
  useEffect(() => {
    void researchStatusFn().then(setLine).catch(() => setLine('Research: unavailable'))
  }, [])
  return (
    <section className="rounded border border-rule bg-white p-3 text-[14px]">
      <h2 className="text-base font-medium">Research (web search)</h2>
      <p className="mt-1 text-ink-muted">{line}</p>
      <p className="mt-1 text-ink-muted">Set SEARXNG_URL, BRAVE_API_KEY or TAVILY_API_KEY on the server. See the README.</p>
    </section>
  )
}
