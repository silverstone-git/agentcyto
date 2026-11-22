import { useState } from 'react'
import { X, Trash2, Loader2, Plug, ShieldAlert } from 'lucide-react'
import { api } from '../../lib/api'
import { API_TYPE_LABEL, ApiType, PRESETS, Provider } from '../../lib/providers'

type Props = {
  providers: Provider[]
  onChange: (p: Provider[]) => void
  onUse: (id: string) => void
  onClose: () => void
}

const field = 'w-full rounded-xl bg-surface-base border border-surface-border px-3 py-2 text-sm outline-none focus:border-brand-500/60 placeholder-ink-600'
const lab = 'block text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1'

const blank = (): Provider => ({ id: crypto.randomUUID?.() || String(Date.now()), label: '', api_type: 'openai', base_url: '', api_key: '', model: '' })

export default function ProvidersModal({ providers, onChange, onUse, onClose }: Props) {
  const [draft, setDraft] = useState<Provider | null>(null)
  const [preset, setPreset] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const patch = (p: Partial<Provider>) => setDraft((d) => (d ? { ...d, ...p } : d))

  const pickPreset = (key: string) => {
    setPreset(key)
    const pr = PRESETS.find((x) => x.key === key)
    if (pr) patch({ label: draft?.label || pr.label, api_type: pr.api_type, base_url: pr.base_url, model: pr.model || '', models: undefined })
  }

  const test = async () => {
    if (!draft) return
    setBusy(true); setNote(null)
    try {
      const r = await api.byokModels({ api_type: draft.api_type, base_url: draft.base_url, api_key: draft.api_key })
      setDraft({ ...draft, models: r.models, model: draft.model || r.models[0] || '' })
      setNote({ ok: true, text: `Connected. ${r.models.length} model(s) available.` })
    } catch (e: any) { setNote({ ok: false, text: e.message }) }
    finally { setBusy(false) }
  }

  const save = () => {
    if (!draft || !draft.base_url.trim() || !draft.api_key.trim()) { setNote({ ok: false, text: 'URL and API key are required.' }); return }
    const d = { ...draft, label: draft.label.trim() || new URL(draft.base_url).hostname, base_url: draft.base_url.trim().replace(/\/+$/, '') }
    const exists = providers.some((p) => p.id === d.id)
    onChange(exists ? providers.map((p) => (p.id === d.id ? d : p)) : [...providers, d])
    setDraft(null); setNote(null); setPreset('')
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl bg-surface-elevated border border-surface-border shadow-glass slide-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
          <h2 className="text-sm font-semibold text-ink-100">Bring your own key</h2>
          <button onClick={onClose} className="p-1 text-ink-500 hover:text-ink-100" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto ink-scroll p-4 space-y-4">
          {!draft && (
            <>
              <p className="text-xs text-ink-400 leading-relaxed">
                Use your own LLM account with any OpenAI-compatible, Anthropic or Gemini endpoint. Keys stay in this
                browser and are forwarded only for the request; the server never stores them.
              </p>
              {providers.length === 0 && <div className="text-xs text-ink-600 italic">No providers yet.</div>}
              <div className="space-y-1.5">
                {providers.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-xl border border-surface-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink-100 truncate">{p.label}</div>
                      <div className="text-[11px] text-ink-500 truncate">{API_TYPE_LABEL[p.api_type]} · {p.model || 'no model'} · {p.base_url}</div>
                    </div>
                    <button onClick={() => { onUse(p.id); onClose() }} className="px-2.5 py-1 rounded-lg text-xs bg-brand-500/15 text-brand-400 hover:bg-brand-500/25">Use</button>
                    <button onClick={() => setDraft(p)} className="px-2.5 py-1 rounded-lg text-xs text-ink-300 hover:bg-surface-border">Edit</button>
                    <button onClick={() => onChange(providers.filter((x) => x.id !== p.id))} className="p-1.5 rounded-lg text-ink-500 hover:text-danger hover:bg-danger/10" aria-label="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
              <button onClick={() => { setDraft(blank()); setPreset('') }}
                className="w-full py-2.5 rounded-xl bg-brand-600 text-white text-sm font-medium hover:bg-brand-500">+ Add provider</button>
            </>
          )}

          {draft && (
            <div className="space-y-3">
              <div>
                <label className={lab}>Provider</label>
                <select value={preset} onChange={(e) => pickPreset(e.target.value)} className={field}>
                  <option value="">Choose a preset…</option>
                  {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className={lab}>Name</label>
                <input value={draft.label} onChange={(e) => patch({ label: e.target.value })} placeholder="My OpenAI" className={field} />
              </div>
              <div>
                <label className={lab}>API type</label>
                <select value={draft.api_type} onChange={(e) => patch({ api_type: e.target.value as ApiType, models: undefined })} className={field}>
                  {(Object.keys(API_TYPE_LABEL) as ApiType[]).map((t) => <option key={t} value={t}>{API_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div>
                <label className={lab}>Provider URL</label>
                <input value={draft.base_url} onChange={(e) => patch({ base_url: e.target.value, models: undefined })} placeholder="https://api.example.com/v1"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} className={field} />
              </div>
              <div>
                <label className={lab}>API key</label>
                <input type="password" value={draft.api_key} onChange={(e) => patch({ api_key: e.target.value, models: undefined })} placeholder="sk-…"
                  autoComplete="off" className={field} />
              </div>
              <div>
                <label className={lab}>Model</label>
                {draft.models?.length ? (
                  <select value={draft.model} onChange={(e) => patch({ model: e.target.value })} className={field}>
                    {draft.models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input value={draft.model} onChange={(e) => patch({ model: e.target.value })} placeholder="model id (or press Test to list)" className={field} />
                )}
              </div>
              {note && <div className={`text-xs ${note.ok ? 'text-success' : 'text-danger'} break-words`}>{note.text}</div>}
              <div className="flex gap-2">
                <button onClick={test} disabled={busy || !draft.api_key || !draft.base_url}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl border border-surface-border text-sm text-ink-200 hover:bg-surface-border disabled:opacity-40">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test &amp; list models
                </button>
                <button onClick={save} className="flex-1 py-2 rounded-xl bg-brand-600 text-white text-sm font-medium hover:bg-brand-500">Save</button>
                <button onClick={() => { setDraft(null); setNote(null) }} className="px-3 py-2 rounded-xl text-sm text-ink-400 hover:bg-surface-border">Cancel</button>
              </div>
              <div className="flex gap-2 text-[11px] text-ink-500 leading-relaxed">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>The key is saved in this browser's local storage. Only public endpoints are allowed (no localhost or private networks).</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
