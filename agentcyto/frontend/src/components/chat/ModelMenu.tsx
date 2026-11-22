import { RotateCcw, KeyRound, Check, Sparkles, Globe } from 'lucide-react'
import type { ModesConfig } from '../../lib/api'
import { ChatSettings, DEFAULT_SETTINGS, Provider } from '../../lib/providers'

type Props = {
  settings: ChatSettings
  onChange: (patch: Partial<ChatSettings>) => void
  modes: ModesConfig | null
  providers: Provider[]
  onProviderModel: (id: string, model: string) => void
  onManageProviders: () => void
}

const chip = (on: boolean) =>
  `px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${on
    ? 'bg-brand-500/15 border-brand-500/40 text-brand-400'
    : 'border-surface-border text-ink-300 hover:bg-surface-border'}`

const label = 'text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1.5'

function Toggle({ on, onClick, icon, title, desc, disabled }: {
  on: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string; disabled?: boolean
}) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onClick} disabled={disabled}
      className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-surface-border disabled:opacity-40 disabled:hover:bg-transparent">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-ink-100">{title}</span>
        <span className="block text-[11px] text-ink-500 leading-snug">{desc}</span>
      </span>
      <span className={`mt-0.5 shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${on ? 'bg-brand-500' : 'bg-surface-border'}`}>
        <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  )
}

export default function ModelMenu({ settings, onChange, modes, providers, onProviderModel, onManageProviders }: Props) {
  const provider = providers.find((p) => p.id === settings.providerId)
  const modeKeys = modes ? Object.keys(modes.modes) : ['heavy', 'heavy-tool', 'light', 'light-tool']
  const modelList = (settings.role === 'agent' ? modes?.agent_models : modes?.chat_models) || []

  return (
    <div className="space-y-4 text-ink-100">
      <div>
        <div className={label}>Provider</div>
        <div className="space-y-1">
          <button type="button" onClick={() => onChange({ providerId: '' })}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-left ${!provider ? 'bg-brand-500/10 text-brand-400' : 'hover:bg-surface-border'}`}>
            <span className="flex-1">agentcyto gateway</span>
            {!provider && <Check className="w-4 h-4" />}
          </button>
          {providers.map((p) => (
            <button type="button" key={p.id} onClick={() => onChange({ providerId: p.id, role: 'chat' })}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-left ${provider?.id === p.id ? 'bg-brand-500/10 text-brand-400' : 'hover:bg-surface-border'}`}>
              <KeyRound className="w-3.5 h-3.5 shrink-0 text-ink-500" />
              <span className="flex-1 min-w-0 truncate">{p.label}<span className="text-ink-500"> · {p.model || 'no model'}</span></span>
              {provider?.id === p.id && <Check className="w-4 h-4" />}
            </button>
          ))}
          <button type="button" onClick={onManageProviders}
            className="w-full px-3 py-2 rounded-xl text-xs text-left text-brand-400 hover:bg-surface-border">
            + Bring your own key / manage providers…
          </button>
        </div>
      </div>

      {provider ? (
        <div>
          <div className={label}>Model · {provider.label}</div>
          {provider.models?.length ? (
            <select value={provider.model} onChange={(e) => onProviderModel(provider.id, e.target.value)}
              className="w-full rounded-xl bg-surface-base border border-surface-border px-3 py-2 text-sm">
              {!provider.models.includes(provider.model) && <option value={provider.model}>{provider.model || 'choose…'}</option>}
              {provider.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input value={provider.model} onChange={(e) => onProviderModel(provider.id, e.target.value)}
              placeholder="model id, e.g. gpt-4o-mini"
              className="w-full rounded-xl bg-surface-base border border-surface-border px-3 py-2 text-sm outline-none focus:border-brand-500/60" />
          )}
        </div>
      ) : (
        <>
          <div>
            <div className={label}>Mode</div>
            <div className="flex flex-wrap gap-1.5">
              {modeKeys.map((m) => (
                <button type="button" key={m} onClick={() => onChange({ mode: m })} className={chip(settings.mode === m)}
                  title={modes?.modes[m]?.description}>{modes?.modes[m]?.label || m}</button>
              ))}
            </div>
          </div>
          <div>
            <div className={label}>Role</div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => onChange({ role: 'chat', model: '' })} className={chip(settings.role === 'chat')}>Chat</button>
              <button type="button" onClick={() => onChange({ role: 'agent', model: '' })} className={chip(settings.role === 'agent')}>Agent (workspace tools)</button>
            </div>
          </div>
          <div>
            <div className={label}>Model</div>
            <select value={settings.model} onChange={(e) => onChange({ model: e.target.value })}
              className="w-full rounded-xl bg-surface-base border border-surface-border px-3 py-2 text-sm">
              <option value="">Auto (follow mode)</option>
              {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </>
      )}

      <div>
        <div className={label}>Search &amp; retrieval</div>
        <div className="-mx-1 space-y-0.5">
          <Toggle on={settings.llmSearch} onClick={() => onChange({ llmSearch: !settings.llmSearch })}
            icon={<Sparkles className="w-4 h-4 text-brand-400" />} title="LLM-assisted search"
            desc={`${modes?.retrieval?.model || 'A fast model'} reads the book outlines, plans precise searches and reranks passages. Uses extra tokens; off = keyword search only.`} />
          <Toggle on={settings.webSearch} onClick={() => onChange({ webSearch: !settings.webSearch })}
            disabled={modes?.web_search_available === false && !settings.webSearch}
            icon={<Globe className="w-4 h-4 text-success" />} title="Web search"
            desc={modes?.web_search_available === false ? 'Not configured on the server (BRAVE_API_KEY missing).' : 'Search the web and read the top pages (Wikipedia etc.); cited as clickable sources.'} />
        </div>
      </div>

      <div>
        <div className={label}>System instructions</div>
        <textarea value={settings.systemPrompt} onChange={(e) => onChange({ systemPrompt: e.target.value })}
          rows={3} maxLength={8000} placeholder="Optional: tone, format, persona… applied to every message."
          className="w-full resize-y rounded-xl bg-surface-base border border-surface-border px-3 py-2 text-sm outline-none focus:border-brand-500/60 placeholder-ink-600" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className={label}>Temperature {settings.temperature === null ? '· default' : `· ${settings.temperature.toFixed(1)}`}</div>
          <input type="range" min={0} max={2} step={0.1} value={settings.temperature ?? 1}
            onChange={(e) => onChange({ temperature: Number(e.target.value) })} className="w-full accent-[#0a84ff]" />
          {settings.temperature !== null && (
            <button type="button" onClick={() => onChange({ temperature: null })} className="text-[11px] text-ink-500 hover:text-ink-200">use default</button>
          )}
        </div>
        <div>
          <div className={label}>Max tokens</div>
          <input type="number" min={1} max={200000} value={settings.maxTokens ?? ''} placeholder="default"
            onChange={(e) => onChange({ maxTokens: e.target.value ? Math.max(1, Number(e.target.value)) : null })}
            className="w-full rounded-xl bg-surface-base border border-surface-border px-3 py-2 text-sm outline-none focus:border-brand-500/60" />
        </div>
      </div>

      <button type="button" onClick={() => onChange({ ...DEFAULT_SETTINGS, providerId: '' })}
        className="flex items-center gap-1.5 text-xs text-ink-500 hover:text-ink-200">
        <RotateCcw className="w-3 h-3" /> Reset all settings
      </button>
    </div>
  )
}
