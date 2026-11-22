import { useRef, useState } from 'react'
import { Loader2, Reply, CornerUpLeft } from 'lucide-react'
import Markdown from './Markdown'

type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'system'
  content: string
  model?: string
  meta?: { attempt?: number | null; streaming?: boolean }
  citations?: number
  onCite?: (n: number) => void
  onReply?: () => void
}

// Server wraps replies as: [In reply to my|the assistant's earlier message: "..."]\n\n<text>
const REPLY_RE = /^\[In reply to (my|the assistant's) earlier message: "([\s\S]*?)"\]\n\n([\s\S]*)$/

export function parseReply(content: string): { who: 'user' | 'assistant'; quote: string; body: string } | null {
  const m = content.match(REPLY_RE)
  if (!m) return null
  return { who: m[1] === 'my' ? 'user' : 'assistant', quote: m[2], body: m[3] }
}

export function QuoteChip({ who, quote, onClear }: { who: 'user' | 'assistant'; quote: string; onClear?: () => void }) {
  return (
    <div className="flex items-stretch gap-2 rounded-lg bg-black/25 overflow-hidden">
      <div className={`w-1 shrink-0 ${who === 'user' ? 'bg-brand-400' : 'bg-success'}`} />
      <div className="py-1.5 pr-2 min-w-0 flex-1">
        <div className={`text-[10px] font-semibold ${who === 'user' ? 'text-brand-400' : 'text-success'}`}>{who === 'user' ? 'You' : 'AI'}</div>
        <div className="text-xs text-ink-300 line-clamp-2 break-words">{quote}</div>
      </div>
      {onClear && (
        <button type="button" onClick={onClear} className="px-2 text-ink-400 hover:text-ink-100" aria-label="Cancel reply">✕</button>
      )}
    </div>
  )
}

export default function MessageBubble({ role, content, model, meta, citations = 0, onCite, onReply }: MessageBubbleProps) {
  const isUser = role === 'user'
  const reply = isUser ? parseReply(content) : null
  const body = reply ? reply.body : content

  // swipe right to reply
  const start = useRef<{ x: number; y: number } | null>(null)
  const [dx, setDx] = useState(0)
  const onTouchStart = (e: React.TouchEvent) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!start.current) return
    const mx = e.touches[0].clientX - start.current.x
    const my = Math.abs(e.touches[0].clientY - start.current.y)
    if (my > 30 && dx === 0) { start.current = null; return }
    if (mx > 0) setDx(Math.min(mx, 80))
  }
  const onTouchEnd = () => {
    if (dx > 55) { onReply?.(); if (navigator.vibrate) navigator.vibrate(10) }
    setDx(0); start.current = null
  }

  const bubbleClass = isUser
    ? 'bg-brand-600 text-white border-brand-600/30 rounded-tl-none rounded-tr-xl rounded-bl-xl rounded-br-xl'
    : 'bg-surface-card text-ink-50 border-surface-border rounded-tr-none rounded-tl-xl rounded-br-xl rounded-bl-xl'

  const metaItems: React.ReactNode[] = []
  if (model) metaItems.push(
    <span key="model" className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-brand-500" /><span>{model}</span></span>
  )
  if (meta?.attempt != null) metaItems.push(
    <span key="attempt" className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-ink-500" /><span>attempt {meta.attempt}</span></span>
  )
  if (meta?.streaming) metaItems.push(
    <span key="streaming" className="flex items-center gap-1 animate-pulse"><Loader2 className="w-3 h-3 text-brand-500 animate-spin" /><span className="text-brand-400">streaming…</span></span>
  )

  return (
    <div
      className={`group relative flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
    >
      {dx > 8 && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 text-brand-400" style={{ opacity: Math.min(1, dx / 55), transform: `translateY(-50%) scale(${0.7 + Math.min(0.5, dx / 110)})` }}>
          <CornerUpLeft className="w-5 h-5" />
        </div>
      )}
      <div
        className={`relative max-w-[88%] md:max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-glow border break-words ${bubbleClass}`}
        style={{ transform: `translateX(${dx}px)`, transition: dx ? 'none' : 'transform .2s ease' }}
      >
        {reply && <div className="mb-2"><QuoteChip who={reply.who} quote={reply.quote} /></div>}
        {isUser
          ? <div className="whitespace-pre-wrap">{body}</div>
          : <Markdown text={body} citations={citations} onCite={onCite} />}
        {!isUser && meta && (
          <div className="mt-3 pt-2 border-t border-surface-border/50 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[10px] text-ink-600">{metaItems}</div>
          </div>
        )}
        {onReply && (
          <button
            type="button" onClick={onReply} title="Reply"
            className={`hidden md:flex absolute top-1 ${isUser ? '-left-9' : '-right-9'} h-7 w-7 items-center justify-center rounded-full bg-surface-card border border-surface-border text-ink-300 opacity-0 group-hover:opacity-100 transition-opacity hover:text-ink-50`}
          >
            <Reply className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
