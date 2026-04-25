// Transport layer to the user's personal Cue Worker.
//
// Two flows:
//   1. WebSocket /ws — plugin → Worker → Deepgram (audio in, transcripts back)
//   2. POST /suggest — plugin → Worker → LLM (transcript context, suggestion list)
//
// Both gated on a SHARED_SECRET bearer the user pasted into phone settings.
// If the user hasn't configured a Worker, transport.ready returns false and
// main.ts falls back to mock-mode suggestions.

export interface TranscriptEvent {
  type: 'transcript'
  text: string
  isFinal: boolean
}

export interface CueTransport {
  ready: boolean
  startMicSession: (onTranscript: (e: TranscriptEvent) => void, onError: (msg: string) => void) => Promise<void>
  sendAudioFrame: (frame: Uint8Array) => void
  endMicSession: () => Promise<void>
  requestSuggestions: (params: {
    mode: string
    transcript: string
    customPrompt?: string
  }) => Promise<{ ok: true; suggestions: string[] } | { ok: false; error: string }>
}

export function createTransport(workerUrl: string, bearerToken: string): CueTransport {
  const baseHttp = workerUrl.replace(/\/$/, '')
  const baseWs = baseHttp.replace(/^http/, 'ws')
  const ready = !!workerUrl && !!bearerToken

  let socket: WebSocket | null = null

  return {
    ready,
    async startMicSession(onTranscript, onError) {
      if (!ready) {
        onError('Worker not configured')
        return
      }
      if (socket) {
        try { socket.close() } catch { /* ignore */ }
      }
      const wsUrl = `${baseWs}/ws?token=${encodeURIComponent(bearerToken)}`
      const sock = new WebSocket(wsUrl)
      socket = sock
      sock.binaryType = 'arraybuffer'
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS open timed out')), 8_000)
        sock.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        sock.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new Error('WS open failed'))
        }, { once: true })
      })
      sock.addEventListener('message', evt => {
        if (typeof evt.data !== 'string') return // we only consume JSON text frames
        try {
          const parsed = JSON.parse(evt.data) as TranscriptEvent
          if (parsed.type === 'transcript') onTranscript(parsed)
        } catch {
          /* swallow */
        }
      })
      sock.addEventListener('close', () => {
        if (socket === sock) socket = null
      })
      sock.addEventListener('error', () => {
        onError('WebSocket error')
      })
    },
    sendAudioFrame(frame) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      try {
        socket.send(frame.buffer)
      } catch {
        /* ignore — connection may be closing */
      }
    },
    async endMicSession() {
      const s = socket
      socket = null
      if (s) {
        try { s.close() } catch { /* ignore */ }
      }
    },
    async requestSuggestions({ mode, transcript, customPrompt }) {
      if (!ready) return { ok: false as const, error: 'Worker not configured' }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        const resp = await fetch(`${baseHttp}/suggest`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ mode, transcript, customPrompt }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          return { ok: false as const, error: `Worker HTTP ${resp.status}` }
        }
        const json = (await resp.json()) as
          | { ok: true; suggestions: string[] }
          | { ok: false; error: string }
        return json
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, error: msg }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
