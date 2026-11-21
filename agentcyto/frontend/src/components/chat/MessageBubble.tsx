import { Loader2 } from 'lucide-react'

type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'system'
  content: string
  model?: string
  meta?: { attempt?: number | null; streaming?: boolean }
}

export default function MessageBubble({ role, content, model, meta }: MessageBubbleProps) {
  const isUser = role === 'user'

  const bubbleClass = isUser
    ? 'bg-brand-600 text-white border-brand-600/30 rounded-tl-none rounded-tr-xl rounded-bl-xl rounded-br-xl'
    : 'bg-surface-card text-ink-50 border-surface-border rounded-tr-none rounded-tl-xl rounded-br-xl rounded-bl-xl'

  const metaItems: React.ReactNode[] = []
  if (model) {
    metaItems.push(
      <span key="model" className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
        <span>{model}</span>
      </span>
    )
  }
  if (meta?.attempt != null) {
    metaItems.push(
      <span key="attempt" className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-500" />
        <span>attempt {meta.attempt}</span>
      </span>
    )
  }
  if (meta?.streaming) {
    metaItems.push(
      <span key="streaming" className="flex items-center gap-1 animate-pulse">
        <Loader2 className="w-3 h-3 text-brand-500" />
        <span className="text-brand-400">streaming…</span>
      </span>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-glow border break-words ${bubbleClass}`}
      >
        <div className="whitespace-pre-wrap">{content}</div>
        {!isUser && meta && (
          <div className="mt-3 pt-2 border-t border-surface-border/50 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[10px] text-ink-600">{metaItems}</div>
          </div>
        )}
      </div>
    </div>
  )
}
