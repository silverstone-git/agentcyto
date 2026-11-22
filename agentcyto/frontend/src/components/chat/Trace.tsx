import { useState } from 'react'
import { Brain, Search, ChevronDown, ChevronRight } from 'lucide-react'

export type TraceItem = { step: string; text: string; query?: string; tool?: string; docs?: string[] }
export type Retrieval = { method: string; terms: string[]; hits: any[] }
export type Turn = { text: string; thinking: string; trace: TraceItem[]; retrieval: Retrieval | null }

export const emptyTurn = (): Turn => ({ text: '', thinking: '', trace: [], retrieval: null })

const stepStyle: Record<string, string> = {
  decision: 'text-warn',
  method: 'text-brand-400',
  search: 'text-success',
  error: 'text-danger',
}

function Fold({ icon, title, badge, open: initial, children }: any) {
  const [open, setOpen] = useState(!!initial)
  return (
    <div className="mb-2 rounded-xl border border-surface-border bg-surface-elevated/60 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-300 hover:bg-surface-border/40">
        {icon}
        <span className="font-medium">{title}</span>
        {badge && <span className="ml-auto text-[10px] text-ink-500">{badge}</span>}
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && <div className="px-3 pb-3 text-xs">{children}</div>}
    </div>
  )
}

export default function Trace({ turn, live }: { turn: Turn; live?: boolean }) {
  const { trace, retrieval, thinking } = turn
  return (
    <div className="max-w-[85%] w-full">
      {trace.length > 0 && (
        <Fold
          icon={<Search className="w-3.5 h-3.5 text-brand-400" />}
          title="Knowledge-base retrieval"
          badge={retrieval ? `${retrieval.hits.length} passages · ${retrieval.method}` : live ? 'searching…' : ''}
          open={live}
        >
          <ol className="space-y-1.5">
            {trace.map((t, i) => (
              <li key={i} className="leading-snug">
                <span className={`uppercase tracking-wide text-[9px] mr-1.5 ${stepStyle[t.step] || 'text-ink-500'}`}>{t.step}</span>
                <span className="text-ink-200">{t.text}</span>
                {t.query && <code className="block mt-0.5 text-[10px] text-ink-400 bg-surface-base rounded px-1.5 py-0.5 break-all">MATCH {t.query}</code>}
                {t.docs && <span className="block text-[10px] text-ink-500">{t.docs.join(' · ')}</span>}
              </li>
            ))}
          </ol>
          {retrieval && (
            <div className="mt-2 pt-2 border-t border-surface-border space-y-1">
              {retrieval.hits.map((h) => (
                <div key={h.n} className="text-[10px] text-ink-400">
                  <span className="text-brand-400">[{h.n}]</span> {h.type}{h.label ? ` (${h.label})` : ''} · {h.doc}{h.section ? ` › ${h.section}` : ''} · lines {h.lines}
                  <div className="text-ink-600 truncate">{h.preview}</div>
                </div>
              ))}
            </div>
          )}
        </Fold>
      )}
      {thinking && (
        <Fold icon={<Brain className="w-3.5 h-3.5 text-ink-400" />} title="Thinking" badge={live && !turn.text ? 'in progress…' : `${thinking.length} chars`} open={live && !turn.text}>
          <div className="whitespace-pre-wrap text-ink-400 max-h-60 overflow-y-auto ink-scroll">{thinking}</div>
        </Fold>
      )}
    </div>
  )
}
