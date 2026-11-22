import { PREFIX } from '../lib/prefix'
import { useCallback, useEffect, useRef } from 'react'

export interface StreamEvent {
  type: string
  data: any
  seq?: number
}

export function useSSEStream(
  jobId: string | null,
  onEvent: (ev: StreamEvent) => void,
  enabled: boolean = true
) {
  const controllerRef = useRef<AbortController | null>(null)
  const cursorRef = useRef(0)
  const seqRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
      controllerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled || !jobId) {
      stop()
      return
    }

    const saved = localStorage.getItem(`agentcyto.seq.${jobId}`)
    const savedSeq = saved ? Number(saved) : 0
    cursorRef.current = Math.max(cursorRef.current, savedSeq)
    seqRef.current = null

    const jobIdStr = jobId

    let cancelled = false

    async function run() {
      try {
        const res = await fetch(
          `${PREFIX}/api/stream?job_id=${encodeURIComponent(jobIdStr)}&after=${cursorRef.current}`,
          { credentials: 'omit' }
        )
        if (!res.ok || !res.body) {
          if (!cancelled) onEvent({ type: 'stream_error', data: { status: res.status } })
          return
        }

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
              const seq = Number(id)
              seqRef.current = seq
              cursorRef.current = Math.max(cursorRef.current, seq)
              localStorage.setItem(`agentcyto.seq.${jobIdStr}`, id)
            }
            if (!data) continue
            let payload: any
            try {
              payload = JSON.parse(data)
            } catch (_) {
              continue
            }

            if (!cancelled) {
              onEvent({ type: eventType, data: payload, seq: seqRef.current ?? undefined })
            }
          }
        }
      } catch (err: any) {
        if (!cancelled && err.name !== 'AbortError') {
          onEvent({ type: 'stream_error', data: { error: err.message } })
        }
      }
    }

    run().catch(() => {
      // errors handled inside run
    })

    return () => {
      cancelled = true
      stop()
    }
  }, [jobId, enabled, onEvent])

  return { stop, cursor: cursorRef.current }
}
