import { X, BookOpen, Globe, ExternalLink } from 'lucide-react'
import Markdown from './Markdown'

// Strip source-markdown artifacts: anchor spans and internal #page links.
const clean = (t: string) =>
  t.replace(/<span id="[^"]*"><\/span>/g, '').replace(/\[([^\]]*)\]\(#[^)]*\)/g, '$1')
const plain = (t: string) => clean(String(t)).replace(/<[^>]+>/g, '')

export default function CitationModal({ hit, onClose }: { hit: any; onClose: () => void }) {
  const isWeb = hit.kind === 'web'
  const body = hit.type === 'equation' ? `$$\n${hit.text}\n$$` : hit.text
  const path: string[] = hit.path?.length ? hit.path : hit.section ? [hit.section] : []
  return (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/70 p-0 md:p-6" onClick={onClose}>
      <div
        className="w-full md:max-w-2xl max-h-[85dvh] flex flex-col rounded-t-3xl md:rounded-3xl bg-surface-card border border-surface-border shadow-glass slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-4 border-b border-surface-border">
          <div className={`mt-0.5 h-7 min-w-7 px-2 rounded-lg text-xs font-semibold flex items-center justify-center ${isWeb ? 'bg-success/15 text-success' : 'bg-brand-500/15 text-brand-400'}`}>{hit.n}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-50 flex items-center gap-1.5">
              {isWeb ? <Globe className="w-3.5 h-3.5 shrink-0 text-success" /> : <BookOpen className="w-3.5 h-3.5 shrink-0 text-ink-400" />}
              <span className="truncate">{isWeb ? hit.title || hit.site : hit.doc}</span>
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {isWeb
                ? <>{hit.site}{hit.section ? ` · ${plain(hit.section)}` : ''}</>
                : <>{path.length ? `${path.map(plain).join(' › ')} · ` : ''}{hit.type}{hit.label ? ` (${hit.label})` : ''} · lines {hit.lines}</>}
            </div>
            {hit.why && <div className="text-[11px] text-ink-400 mt-0.5 italic truncate">Picked because: {hit.why}</div>}
          </div>
          <button onClick={onClose} className="p-2 -m-1 rounded-xl text-ink-400 hover:bg-surface-border" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 overflow-y-auto ink-scroll text-sm leading-relaxed">
          <Markdown text={clean(body)} />
        </div>
        {isWeb && hit.url && (
          <div className="p-3 border-t border-surface-border">
            <a href={hit.url} target="_blank" rel="noreferrer noopener"
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-success/15 text-success text-sm font-medium hover:bg-success/25">
              Open source page <ExternalLink className="w-4 h-4" />
            </a>
            <div className="mt-1.5 text-[10px] text-ink-600 text-center truncate">{hit.url}</div>
          </div>
        )}
      </div>
    </div>
  )
}
