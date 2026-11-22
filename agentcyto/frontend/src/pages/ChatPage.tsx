import { PREFIX } from '../lib/prefix'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Send, StopCircle, Loader2, FileText, Sparkles, BookOpen } from 'lucide-react'
import { api, Message, Session } from '../lib/api'
import MessageBubble from '../components/chat/MessageBubble'
import Trace, { Turn, emptyTurn } from '../components/chat/Trace'
import { MenuButton } from '../components/layout/nav'
import CitationModal from '../components/chat/CitationModal'
import { QuoteChip, parseReply } from '../components/chat/MessageBubble'

// Plain-text snippet for the reply quote (no raw LaTeX / markdown noise).
const cleanQuote = (t: string) =>
  t.replace(/\$\$[\s\S]*?\$\$/g, '[equation]').replace(/\\\[[\s\S]*?\\\]/g, '[equation]')
    .replace(/\$([^$]+)\$/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)

export default function ChatPage() {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [mode, setMode] = useState<string>('heavy')
  const [role, setRole] = useState<'chat' | 'agent'>('chat')
  const [model, setModel] = useState<string>('')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [attempt, setAttempt] = useState<number | null>(null)
  const [kbDocs, setKbDocs] = useState<any[]>([])
  const [attachedKb, setAttachedKb] = useState<Set<string>>(new Set())
  const [logOpen, setLogOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<{ role: 'user' | 'assistant'; content: string } | null>(null)
  const [kbMenu, setKbMenu] = useState(false)
  const [citeHit, setCiteHit] = useState<any | null>(null)
  const [logs, setLogs] = useState<{ type: string; text: string; detail?: string; time: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [kbLoading, setKbLoading] = useState(false)
  const [live, setLive] = useState<Turn>(emptyTurn())
  const liveRef = useRef<Turn>(emptyTurn())
  const attemptRef = useRef<number>(0)
  const [jobId, setJobId] = useState<string | null>(null)
  const activeJobRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const startedAtRef = useRef<number | null>(null)

  const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const log = useCallback((type: string, text: string, detail?: string) => {
    setLogs((prev) => [...prev, { type, text, detail, time: now() }].slice(-200))
  }, [])

  useEffect(() => {
    const t = setInterval(() => {
      setLogs((prev) => prev.map((l) => ({ ...l, time: now() })))
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [])

  useEffect(() => {
    if (streaming) scrollToBottom()
  }, [streaming, messages.length])

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.sessions()
      setSessions(data)
    } catch (err: any) {
      log('err', 'Failed to load sessions', err.message)
    }
  }, [log])

  const loadModes = useCallback(async () => {
    try {
      const cfg = await api.modes()
      setMode(cfg.default_mode || 'heavy')
    } catch (err: any) {
      log('err', 'Failed to load modes', err.message)
    }
  }, [log])

  const loadKBDocs = useCallback(async () => {
    setKbLoading(true)
    try {
      const data = await api.kbDocuments()
      setKbDocs(data)
    } catch (err: any) {
      // KB may not be ingested yet
      setKbDocs([])
    } finally {
      setKbLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSessions()
    loadModes()
    loadKBDocs()
  }, [loadSessions, loadModes, loadKBDocs])

  const selectSession = async (id: string) => {
    setPanelOpen(false)
    setError(null)
    setAttempt(null)
    setSessionId(id)
    try {
      const detail = await api.getSession(id)
      setMessages(detail.messages || [])
      setRole((detail.jobs?.[0]?.role === 'agent' ? 'agent' : 'chat') as 'chat' | 'agent')
      setInput('')
      activeJobRef.current = null
      const active = detail.jobs?.find((j: any) => ['queued', 'running', 'partial'].includes(j.status))
      if (active) {
        activeJobRef.current = active.id
        setStreaming(true)
        startedAtRef.current = Date.now()
        // resume stream handled by useSSEStream
      }
      scrollToBottom()
    } catch (err: any) {
      log('err', 'Failed to load session', err.message)
      setError(err.message)
    }
  }

  // New chats are only created server-side once a first prompt is sent.
  const newSession = () => {
    setPanelOpen(false)
    if (!sessionId && messages.length === 0 && !streaming) return
    setSessionId(null)
    setMessages([])
    resetLive()
    setAttempt(null)
    setInput('')
    setReplyTo(null)
    activeJobRef.current = null
    setJobId(null)
    setStreaming(false)
    setError(null)
  }

  const toggleKB = (docId: string) => {
    setAttachedKb((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
    const d = kbDocs.find((x) => x.id === docId)
    log('info', attachedKb.has(docId) ? 'Detached KB repo' : 'Attached KB repo', d?.title || d?.file_name || docId)
  }

  const attachAllKB = () => {
    setAttachedKb(new Set(kbDocs.map((d) => d.id)))
    log('info', 'Attached all KB repos', `${kbDocs.length} repo(s)`)
  }

  const detachAllKB = () => {
    setAttachedKb(new Set())
    log('info', 'Detached all KB repos')
  }

  const resetLive = () => {
    liveRef.current = emptyTurn()
    attemptRef.current = 0
    setLive(liveRef.current)
  }
  const patchLive = (fn: (t: Turn) => Turn) => {
    liveRef.current = fn(liveRef.current)
    setLive(liveRef.current)
  }

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text) return

    setError(null)
    setAttempt(null)
    setStreaming(true)
    startedAtRef.current = Date.now()

    const userMsg: Message = {
      role: 'user',
      content: replyTo
        ? `[In reply to ${replyTo.role === 'assistant' ? "the assistant's" : 'my'} earlier message: "${replyTo.content.replace(/\s+/g, ' ').slice(0, 600)}"]\n\n${text}`
        : text,
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setReplyTo(null)
    inputRef.current?.focus()

    log('info', 'Message queued', `mode: ${mode} · role: ${role}` + (attachedKb.size ? ` · KB: ${attachedKb.size} repo(s)` : ''))

    try {
      const body: any = {
        message: text,
        mode,
        role,
        kb_docs: Array.from(attachedKb),
      }
      if (replyTo) body.reply_to = replyTo
      if (sessionId) body.session_id = sessionId
      if (model) body.model = model

      const job = await api.chat(body)
      activeJobRef.current = job.job_id
      resetLive()
      setJobId(job.job_id)
      setSessionId(job.session_id)
      loadSessions()
      log('info', 'Job started', `job ${job.job_id.slice(0, 8)}`)
    } catch (err: any) {
      setStreaming(false)
      setError(err.message)
      log('err', 'Send failed', err.message)
    }
  }

  const stopJob = async () => {
    abortRef.current?.abort()
    if (activeJobRef.current) {
      try { await api.cancelJob(activeJobRef.current) } catch (_) {}
    }
    setStreaming(false)
    log('warn', 'Stopped by user')
  }

  const retryJob = async () => {
    if (!error) return
    setError(null)
    setStreaming(true)
    startedAtRef.current = Date.now()
    try {
      const body: any = {
        message: messages[messages.length - 1]?.content || '',
        mode,
        role,
        kb_docs: Array.from(attachedKb),
      }
      if (sessionId) body.session_id = sessionId
      const job = await api.chat(body)
      activeJobRef.current = job.job_id
      resetLive()
      setJobId(job.job_id)
      log('info', 'Retrying', `job ${job.job_id.slice(0, 8)}`)
    } catch (err: any) {
      setStreaming(false)
      setError(err.message)
    }
  }

  // SSE stream
  useEffect(() => {
    if (!jobId) return
    let cancelled = false

    ;(async () => {
      try {
        const saved = localStorage.getItem(`agentcyto.seq.${jobId}`)
        let after = saved ? Number(saved) : 0

        const res = await fetch(`${PREFIX}/api/stream?job_id=${encodeURIComponent(jobId)}&after=${after}`)
        if (!res.ok || !res.body) return

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let idx
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            if (!block.trim()) continue

            let eventType = 'message'
            let data = ''
            let id: string | null = null
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
              else if (line.startsWith('id:')) id = line.slice(3).trim()
            }

            if (id) {
              localStorage.setItem(`agentcyto.seq.${jobId}`, id)
            }
            if (!data) continue
            let payload: any
            try { payload = JSON.parse(data) } catch (_) { continue }

            if (!cancelled) {
              handleEvent(eventType, payload)
            }
          }
        }
      } catch (err: any) {
        if (!cancelled && err.name !== 'AbortError') {
          setStreaming(false)
          setError(err.message)
          log('err', 'Stream interrupted', err.message)
        }
      }
    })()

    return () => { cancelled = true }
  }, [jobId])

  const handleEvent = (eventType: string, payload: any) => {
    if (eventType === 'delta') {
      if (payload.attempt !== attemptRef.current) {
        if (attemptRef.current) log('info', 'Streaming', `attempt ${payload.attempt}`)
        attemptRef.current = payload.attempt
        setAttempt(payload.attempt)
        patchLive((t) => ({ ...t, text: '' }))
      }
      patchLive((t) => ({ ...t, text: t.text + (payload.text || '') }))
    } else if (eventType === 'thinking') {
      patchLive((t) => ({ ...t, thinking: t.thinking + (payload.text || '') }))
    } else if (eventType === 'trace') {
      patchLive((t) => ({ ...t, trace: [...t.trace, payload] }))
      log(payload.step === 'error' ? 'err' : 'info', `KB ${payload.step}`, payload.text)
    } else if (eventType === 'retrieval') {
      patchLive((t) => ({ ...t, retrieval: payload }))
    } else if (eventType === 'done') {
      const duration = startedAtRef.current ? Date.now() - startedAtRef.current : null
      const turn = liveRef.current
      setMessages((prev) => [...prev, {
        role: 'assistant', content: payload.text || turn.text, model: payload.model,
        meta: { trace: turn.trace, retrieval: turn.retrieval, thinking: turn.thinking },
      }])
      resetLive()
      setStreaming(false)
      activeJobRef.current = null
      setJobId(null)
      log('ok', 'Complete', `answered by ${payload.model || 'unknown'}` + (duration ? ` · ${duration}ms` : ''))
      scrollToBottom()
    } else if (eventType === 'status') {
      log('info', payload.detail === 'retrying' ? 'Partial — retrying' : payload.status || '', `attempt ${payload.attempt}`)
    } else if (eventType === 'job_error') {
      setStreaming(false)
      setError(payload.error || 'unknown error')
      activeJobRef.current = null
      log('err', 'Job error', payload.error || 'unknown error')
    } else if (eventType === 'stream_error') {
      setStreaming(false)
      activeJobRef.current = null
      log('err', 'Stream error', String(payload.error || payload.status))
    }
  }

  const toggleLog = () => setLogOpen(!logOpen)

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      <header className="h-14 glass border-b border-surface-border flex items-center justify-between pl-2 pr-3 md:px-6 z-30 gap-2 shrink-0">
        <div className="flex items-center gap-1 md:gap-4 min-w-0">
          <MenuButton />
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            className="p-2 rounded-xl hover:bg-surface-border text-ink-400 transition-colors md:hidden"
            title="Sessions & knowledge base"
          >
            <span className="text-lg leading-none">☷</span>
          </button>
          <button
            onClick={newSession}
            className="p-2 rounded-xl hover:bg-surface-border text-ink-400 transition-colors hidden md:block"
            title="New conversation"
          >
            <Plus className="w-5 h-5" />
          </button>
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-base border border-surface-border">
            <span className="text-xs text-ink-500">Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="bg-transparent text-xs text-ink-100 border-none focus:ring-0 px-1 cursor-pointer appearance-none"
            >
              {['heavy', 'heavy-tool', 'light', 'light-tool'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span className="text-xs text-ink-500">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as any)}
              className="bg-transparent text-xs text-ink-100 border-none focus:ring-0 px-1 cursor-pointer appearance-none"
            >
              <option value="chat">Chat</option>
              <option value="agent">Agent</option>
            </select>
            {model && (
              <>
                <span className="text-xs text-ink-500">Model</span>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="bg-transparent text-xs text-ink-100 border-none focus:ring-0 px-1 cursor-pointer appearance-none"
                >
                  <option value={model}>{model}</option>
                  <option value="">auto</option>
                </select>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden md:block text-xs text-ink-500">{sessionId ? sessionId.slice(0, 12) : 'New session'}</span>
          {streaming ? (
            <button onClick={stopJob} className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-red-900/20 text-red-400 border border-red-900/30 hover:bg-red-900/30 transition-colors">
              <StopCircle className="w-4 h-4" /> <span className="text-xs font-medium">Stop</span>
            </button>
          ) : (
            <button
              onClick={newSession}
              className="inline-flex items-center whitespace-nowrap px-3 md:px-4 py-1.5 rounded-xl bg-brand-600 text-white text-sm font-medium shadow-glow hover:bg-brand-500 transition-colors"
            >
              <Plus className="w-4 h-4 mr-1" /> New chat
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Session list sidebar */}
        <aside className={`${panelOpen ? 'flex' : 'hidden'} md:flex absolute md:static inset-y-0 left-0 w-[85%] max-w-xs md:w-72 shrink-0 min-h-0 overflow-hidden bg-surface-elevated md:bg-surface-elevated/60 md:backdrop-blur-xl border-r border-surface-border flex-col z-40`}>
          <div className="p-4 border-b max-h-[45%] overflow-y-auto ink-scroll shrink-0 border-b border-surface-border">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink-200">Sessions</h2>
              <button
                onClick={newSession}
                className="p-1.5 rounded-lg hover:bg-surface-border text-ink-400 transition-colors"
                title="New session"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1">
              {sessions.filter((s: any) => s.messages > 0 || s.id === sessionId).map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                    sessionId === s.id
                      ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                      : 'text-ink-400 hover:bg-surface-border hover:text-ink-100'
                  }`}
                >
                  <FileText className="w-4 h-4 text-ink-600" />
                  <span className="truncate">{s.name || '(untitled)'}</span>
                  <span className="ml-auto text-[10px] text-ink-600">{s.id.slice(0, 8)}</span>
                </button>
              ))}
              {sessions.filter((s: any) => s.messages > 0).length === 0 && (
                <div className="px-3 py-2 text-xs text-ink-600 italic">No sessions yet</div>
              )}
            </div>
          </div>

          {/* KB attach panel */}
          <div className="flex-1 p-4 overflow-y-auto ink-scroll">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink-200">Knowledge base</h2>
              {kbDocs.length > 0 && (
                <div className="flex gap-1">
                  <button
                    onClick={attachAllKB}
                    className="px-2 py-1 rounded-lg text-[10px] bg-surface-border text-ink-300 hover:bg-surface-border/50 hover:text-ink-100 transition-colors"
                    title="Attach all"
                  >
                    All
                  </button>
                  <button
                    onClick={detachAllKB}
                    className="px-2 py-1 rounded-lg text-[10px] bg-surface-border text-ink-300 hover:bg-surface-border/50 hover:text-ink-100 transition-colors"
                    title="Detach all"
                  >
                    None
                  </button>
                </div>
              )}
            </div>
            {kbLoading ? (
              <div className="flex items-center justify-center py-4 text-xs text-ink-500">
                <Loader2 className="w-3 h-3 animate-spin mr-1" /> Loading…
              </div>
            ) : kbDocs.length === 0 ? (
              <div className="px-3 py-4 text-xs text-ink-600 text-center italic">
                No KB documents ingested yet. Use Admin → Ingest to load the knowledge base.
              </div>
            ) : (
              <div className="space-y-1">
                {kbDocs.map((d) => {
                  const attached = attachedKb.has(d.id)
                  return (
                    <button
                      key={d.id}
                      onClick={() => toggleKB(d.id)}
                      className={`w-full text-left flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                        attached
                          ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                          : 'text-ink-400 hover:bg-surface-border hover:text-ink-100'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="block truncate">{d.title || d.file_name}</span>
                        <span className="text-[10px] text-ink-600">{d.node_count || 0} nodes · {d.equation_count || 0} eqns</span>
                      </div>
                      <span className={`w-2 h-2 shrink-0 rounded-full ${attached ? 'bg-brand-500' : 'bg-surface-border'}`} />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        {panelOpen && <div className="md:hidden absolute inset-0 z-30 bg-black/50" onClick={() => setPanelOpen(false)} />}

        {/* Main chat area */}
        <main className="flex-1 flex flex-col min-w-0 bg-surface-base">
          <div className="flex-1 overflow-y-auto p-6 md:p-8 scroll-smooth ink-scroll" ref={messagesEndRef}>
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-ink-600">
                <Sparkles className="w-12 h-12 mb-3 text-ink-700" />
                <p className="text-sm">Start a conversation.</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className="mb-6">
                {msg.role === 'assistant' && msg.meta && (msg.meta.trace?.length > 0 || msg.meta.thinking) && (
                  <Trace turn={{ text: msg.content, thinking: msg.meta.thinking || '', trace: msg.meta.trace || [], retrieval: msg.meta.retrieval || null }} />
                )}
                <MessageBubble
                  role={msg.role}
                  content={msg.content}
                  model={msg.role === 'assistant' ? (msg.model || undefined) : undefined}
                  citations={msg.meta?.retrieval?.hits?.length || 0}
                  onCite={(n) => { const h = msg.meta?.retrieval?.hits?.find((x: any) => x.n === n); if (h) setCiteHit(h) }}
                  onReply={() => setReplyTo({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: cleanQuote(msg.role === 'user' ? (parseReply(msg.content)?.body ?? msg.content) : msg.content) })}
                />
              </div>
            ))}
            {streaming && (
              <div className="mb-6">
                <Trace turn={live} live />
                <MessageBubble
                  role="assistant" content={live.text} meta={{ attempt, streaming: true }}
                  citations={live.retrieval?.hits?.length || 0}
                  onCite={(n) => { const h = live.retrieval?.hits?.find((x: any) => x.n === n); if (h) setCiteHit(h) }}
                />
              </div>
            )}
            {error && (
              <div className="mb-6 p-4 rounded-xl bg-danger/10 border border-danger/20 text-danger text-sm">
                {error}
                <button
                  onClick={retryJob}
                  className="ml-3 text-xs underline hover:text-danger"
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="glass border-t border-surface-border p-2 md:p-4">
            <form onSubmit={sendMessage} className="max-w-4xl mx-auto relative rounded-2xl border border-surface-border bg-surface-card">
              {replyTo && (
                <div className="px-2 pt-2"><QuoteChip who={replyTo.role} quote={replyTo.content} onClear={() => setReplyTo(null)} /></div>
              )}
              {attachedKb.size > 0 && (
                <div className="flex flex-nowrap items-center gap-1.5 px-3 pt-2 overflow-hidden">
                  <BookOpen className="w-3.5 h-3.5 text-brand-400" />
                  {kbDocs.filter((d) => attachedKb.has(d.id)).slice(0, window.innerWidth < 640 ? 1 : 3).map((d) => (
                    <span key={d.id} className="inline-flex items-center gap-1 max-w-[9.5rem] sm:max-w-[13rem] shrink-0 pl-2 pr-1 py-0.5 rounded-full bg-brand-500/15 border border-brand-500/30 text-[11px] text-brand-400">
                      <span className="truncate">{d.title || d.file_name}</span>
                      <button type="button" onClick={() => toggleKB(d.id)} className="w-4 h-4 rounded-full hover:bg-brand-500/30 flex items-center justify-center" aria-label="Detach">×</button>
                    </span>
                  ))}
                  {attachedKb.size > (window.innerWidth < 640 ? 1 : 3) && (
                    <button type="button" onClick={() => setKbMenu(true)} className="shrink-0 px-2 py-0.5 rounded-full bg-surface-border text-[11px] text-ink-300 hover:text-ink-50">
                      +{attachedKb.size - (window.innerWidth < 640 ? 1 : 3)} more
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-end gap-1 pl-1.5 pr-2 py-2">
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setKbMenu(!kbMenu)}
                  className={`h-10 w-10 rounded-xl flex items-center justify-center transition-colors ${attachedKb.size ? 'bg-brand-500/15 text-brand-400' : 'text-ink-400 hover:bg-surface-border'}`}
                  title="Attach knowledge base"
                  aria-label="Attach knowledge base"
                >
                  <Plus className={`w-5 h-5 transition-transform ${kbMenu ? 'rotate-45' : ''}`} />
                </button>
                {kbMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setKbMenu(false)} />
                    <div className="absolute bottom-12 left-0 z-50 w-72 max-w-[80vw] max-h-72 overflow-y-auto ink-scroll rounded-2xl bg-surface-elevated border border-surface-border shadow-glass p-2 slide-in">
                      <div className="flex items-center justify-between px-2 py-1">
                        <span className="text-xs font-semibold text-ink-200">Knowledge base</span>
                        <span className="flex gap-1">
                          <button type="button" onClick={attachAllKB} className="px-2 py-0.5 rounded-lg text-[10px] bg-surface-border text-ink-300">All</button>
                          <button type="button" onClick={detachAllKB} className="px-2 py-0.5 rounded-lg text-[10px] bg-surface-border text-ink-300">None</button>
                        </span>
                      </div>
                      {kbDocs.length === 0 && <div className="px-2 py-3 text-xs text-ink-500">No documents ingested yet.</div>}
                      {kbDocs.map((d) => {
                        const on = attachedKb.has(d.id)
                        return (
                          <button type="button" key={d.id} onClick={() => toggleKB(d.id)}
                            className={`w-full text-left flex items-center gap-2 px-2 py-2 rounded-xl text-sm ${on ? 'bg-brand-500/10 text-brand-400' : 'text-ink-200 hover:bg-surface-border'}`}>
                            <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${on ? 'bg-brand-500 border-brand-500 text-white' : 'border-ink-600'}`}>{on ? '✓' : ''}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{d.title || d.file_name}</span>
                              <span className="text-[10px] text-ink-500">{d.node_count || 0} nodes · {d.equation_count || 0} eqns</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={replyTo ? 'Reply…' : attachedKb.size ? 'Ask about the attached knowledge base…' : 'Message agentcyto…'}
                rows={1}
                className="flex-1 min-w-0 resize-none bg-transparent border-none outline-none py-2 text-ink-100 text-sm leading-relaxed focus:ring-0 placeholder-ink-600"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage(e as any)
                  }
                }}
                style={{ minHeight: '40px', maxHeight: '200px', height: input ? Math.min(200, Math.max(40, inputRef.current?.scrollHeight || 40)) : 40 }}
              />
              <div className="flex items-center shrink-0">
                {!streaming ? (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    className={`p-2.5 rounded-xl transition-all ${
                      input.trim()
                        ? 'bg-brand-600 text-white shadow-glow hover:bg-brand-500'
                        : 'bg-surface-border text-ink-500 hover:bg-surface-border/50'
                    }`}
                  >
                    <Send className="w-5 h-5" />
                  </button>
                ) : (
                  <button onClick={stopJob} className="p-2.5 rounded-xl bg-red-900/20 text-red-400 hover:bg-red-900/30 transition-colors">
                    <StopCircle className="w-5 h-5" />
                  </button>
                )}
              </div>
              </div>
            </form>
          </div>
        </main>
      </div>

      {citeHit && <CitationModal hit={citeHit} onClose={() => setCiteHit(null)} />}

      {/* System log drawer */}
      <div className="shrink-0 z-30">
        <div className="flex items-center justify-between px-4 py-2 bg-surface-elevated border-t border-surface-border cursor-pointer" onClick={toggleLog}>
          <h3 className="text-xs font-semibold text-ink-300">System log</h3>
          <span className="text-ink-500">{logOpen ? '▲' : '▼'}</span>
        </div>
        {logOpen && (
          <div className="h-44 bg-surface-base border-t border-surface-border overflow-y-auto ink-scroll p-3 space-y-2">
            {logs.map((l, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className={`w-6 text-center ${l.type === 'ok' ? 'text-success' : l.type === 'err' ? 'text-danger' : l.type === 'warn' ? 'text-warn' : 'text-ink-500'}`}>
                  {l.type === 'ok' ? '✓' : l.type === 'err' ? '✗' : l.type === 'warn' ? '⚠' : '•'}
                </span>
                <span className="text-ink-400">{l.time}</span>
                <span className="text-ink-300">{l.text}</span>
                {l.detail && <span className="ml-2 text-ink-600 truncate max-w-xs">{l.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
