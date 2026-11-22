import { X, BookOpen } from 'lucide-react'
import Markdown from './Markdown'

// Strip source-markdown artifacts: anchor spans and internal #page links.
const clean = (t: string) =>
  t.replace(/<span id="[^"]*"><\/span>/g, '').replace(/\[([^\]]*)\]\(#[^)]*\)/g, '$1')

export default function CitationModal({ hit, onClose }: { hit: any; onClose: () => void }) {
  const body = hit.type === 'equation' ? `$$\n${hit.text}\n$$` : hit.text
  return (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/70 p-0 md:p-6" onClick={onClose}>
      <div
        className="w-full md:max-w-2xl max-h-[85dvh] flex flex-col rounded-t-3xl md:rounded-3xl bg-surface-card border border-surface-border shadow-glass slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-4 border-b border-surface-border">
          <div className="mt-0.5 h-7 min-w-7 px-2 rounded-lg bg-brand-500/15 text-brand-400 text-xs font-semibold flex items-center justify-center">{hit.n}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-50 flex items-center gap-1.5"><BookOpen className="w-3.5 h-3.5 text-ink-400" />{hit.doc}</div>
            <div className="text-[11px] text-ink-500 truncate">
              {hit.section ? `${clean(String(hit.section)).replace(/<[^>]+>/g, '')} · ` : ''}{hit.type}{hit.label ? ` (${hit.label})` : ''} · lines {hit.lines}
            </div>
          </div>
          <button onClick={onClose} className="p-2 -m-1 rounded-xl text-ink-400 hover:bg-surface-border" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 overflow-y-auto ink-scroll text-sm leading-relaxed">
          <Markdown text={clean(body)} />
        </div>
      </div>
    </div>
  )
}
