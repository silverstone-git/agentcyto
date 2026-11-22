import { useEffect, useRef, useState } from 'react'
import { Search, MessageSquare, X, Loader2 } from 'lucide-react'
import { api, SearchResult } from '../../lib/api'

type Props = { onClose: () => void; onPick: (r: SearchResult) => void }

function Highlight({ text, match }: { text: string; match?: string }) {
  if (!match) return <>{text}</>
  const i = text.toLowerCase().indexOf(match.toLowerCase())
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="bg-brand-500/30 text-ink-50 rounded px-0.5">{text.slice(i, i + match.length)}</mark>{text.slice(i + match.length)}</>
}

export default function SearchModal({ onClose, onPick }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults([]); setErr(null); setLoading(false); return }
    setLoading(true)
    const my = ++seq.current
    const t = setTimeout(async () => {
      try {
        const r = await api.search(term)
        if (my === seq.current) { setResults(r.results); setErr(null) }
      } catch (e: any) { if (my === seq.current) setErr(e.message) }
      finally { if (my === seq.current) setLoading(false) }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 p-3 pt-[8vh]" onClick={onClose}>
      <div className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-2xl bg-surface-elevated border border-surface-border shadow-glass slide-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 border-b border-surface-border">
          <Search className="w-4 h-4 text-ink-500 shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all chats…"
            className="flex-1 min-w-0 bg-transparent py-3.5 text-sm text-ink-50 outline-none placeholder-ink-600" />
          {loading && <Loader2 className="w-4 h-4 animate-spin text-ink-500" />}
          <button onClick={onClose} className="p-1 text-ink-500 hover:text-ink-100" aria-label="Close search"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto ink-scroll p-2">
          {err && <div className="p-3 text-sm text-danger">{err}</div>}
          {!err && q.trim().length < 2 && <div className="p-6 text-center text-xs text-ink-600">Type at least 2 characters to search every conversation.</div>}
          {!err && !loading && q.trim().length >= 2 && results.length === 0 && <div className="p-6 text-center text-xs text-ink-600">No matches.</div>}
          {results.map((r, i) => (
            <button key={`${r.kind}-${r.message_id ?? r.session_id}-${i}`} onClick={() => onPick(r)}
              className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-surface-border flex gap-3">
              <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-ink-600" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm text-ink-100">
                  <span className="truncate"><Highlight text={r.session_name || '(untitled)'} match={r.kind === 'session' ? q.trim() : undefined} /></span>
                  {r.role && <span className="shrink-0 text-[10px] text-ink-500">{r.role === 'user' ? 'you' : 'AI'}</span>}
                </span>
                {r.snippet && <span className="block text-xs text-ink-400 mt-0.5 line-clamp-2 break-words"><Highlight text={r.snippet} match={r.match} /></span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
