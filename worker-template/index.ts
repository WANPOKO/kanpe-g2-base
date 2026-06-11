// Cue personal Cloudflare Worker — proxies the glasses-to-Deepgram audio
// stream + caches the rolling transcript so the LLM call can use it as
// context. Each Cue user deploys their own Worker with their own
// Deepgram + Anthropic + AI Search keys; the plugin never sees the keys.
//
// Endpoints:
//   GET /ws?token=<bearer>      — WebSocket. Plugin sends raw 16kHz mono
//                                 16-bit PCM frames; we proxy to Deepgram
//                                 and stream interim+final transcripts back
//                                 as JSON text frames {"type":"transcript",
//                                 "text": "...", "isFinal": bool}.
//
//   POST /suggest               — body { mode, transcript, customPrompt? }
//                                 Auth: Authorization: Bearer <SHARED_SECRET>
//                                 Returns { ok, suggestions: string[] }.
//
//   POST /ask                   — body { transcript, mode?, conditions? }
//                                 Auth: Authorization: Bearer <SHARED_SECRET>
//                                 Searches Cloudflare AI Search, injects
//                                 chunks into Claude, returns { ok, answer }.
//
//   GET /healthz                — sanity check
//
// All cookies/keys live in Worker secrets, set via:
//   wrangler secret put SHARED_SECRET
//   wrangler secret put DEEPGRAM_API_KEY
//   wrangler secret put ANTHROPIC_API_KEY
//   wrangler secret put AISEARCH_TOKEN
//   wrangler secret put CF_ACCOUNT_ID

import { correctRecognizedText } from '../src/termCorrection'

interface Env {
  SHARED_SECRET: string
  DEEPGRAM_API_KEY: string
  ANTHROPIC_API_KEY: string
  AISEARCH_TOKEN: string
  CF_ACCOUNT_ID: string
  CLAUDE_MODEL?: string
  CLAUDE_MAX_TOKENS?: string
  AISEARCH_INSTANCE?: string
  AISEARCH_MAX_RESULTS?: string
  DEEPGRAM_MODEL?: string
  KEYTERMS?: string
}

const SAMPLE_RATE = 16000
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7'
const DEFAULT_CLAUDE_MAX_TOKENS = 2000
const DEFAULT_AISEARCH_INSTANCE = 'soft-pond-d91c'
const DEFAULT_AISEARCH_MAX_RESULTS = 8
const DEFAULT_DEEPGRAM_MODEL = 'nova-3'
const MAX_DEEPGRAM_KEYTERMS = 100

interface AskBody {
  mode?: string
  transcript?: string
  conditions?: string
}

interface SuggestBody {
  mode?: string
  transcript?: string
  customPrompt?: string
  recentSuggestions?: string[]
}

interface AiSearchChunk {
  id: string
  text: string
  source: string
  score: number
  metadata: Record<string, unknown>
}

interface AiSearchApiChunk {
  id?: string
  text?: string
  score?: number
  type?: string
  item?: {
    key?: string
    metadata?: Record<string, unknown>
    timestamp?: number
  }
  scoring_details?: Record<string, unknown>
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function claudeModel(env: Env): string {
  return env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL
}

function claudeMaxTokens(env: Env): number {
  return parsePositiveInt(env.CLAUDE_MAX_TOKENS, DEFAULT_CLAUDE_MAX_TOKENS)
}

function aiSearchInstance(env: Env): string {
  return env.AISEARCH_INSTANCE?.trim() || DEFAULT_AISEARCH_INSTANCE
}

function aiSearchMaxResults(env: Env): number {
  return parsePositiveInt(env.AISEARCH_MAX_RESULTS, DEFAULT_AISEARCH_MAX_RESULTS)
}

function deepgramModel(env: Env): string {
  return env.DEEPGRAM_MODEL?.trim() || DEFAULT_DEEPGRAM_MODEL
}

function deepgramKeyterms(env: Env): string[] {
  if (!env.KEYTERMS) return []
  return env.KEYTERMS
    .split(',')
    .map(term => term.trim())
    .filter(term => term.length > 0)
    .slice(0, MAX_DEEPGRAM_KEYTERMS)
}

function appendDeepgramKeyterms(params: URLSearchParams, env: Env): void {
  for (const term of deepgramKeyterms(env)) {
    params.append('keyterm', term)
  }
}

function buildDeepgramWsUrl(env: Env): string {
  // IMPORTANT: must be https:// not wss:// — Cloudflare Workers' fetch() only
  // accepts http(s) schemes for outbound WebSocket negotiation.
  const params = new URLSearchParams({
    model: deepgramModel(env),
    language: 'ja',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  })
  appendDeepgramKeyterms(params, env)
  return `https://api.deepgram.com/v1/listen?${params.toString()}`
}

function buildDeepgramHttpUrl(env: Env): string {
  // Batch endpoint used by /transcribe; no interim results per chunk.
  const params = new URLSearchParams({
    model: deepgramModel(env),
    language: 'ja',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
    smart_format: 'true',
  })
  appendDeepgramKeyterms(params, env)
  return `https://api.deepgram.com/v1/listen?${params.toString()}`
}

// WAV-wrap raw PCM16 mono so Deepgram's HTTP endpoint (which sniffs the
// container) accepts it. Same shape used by typical clients.
function wavWrap(pcm: Uint8Array): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46) // "RIFF"
  view.setUint32(4, 36 + dataSize, true)
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45) // "WAVE"
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20) // "fmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61) // "data"
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(pcm)
  return new Uint8Array(buffer)
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  // POST /transcribe — body is raw PCM16 mono 16kHz audio. Bearer-gated.
  // Wraps as WAV and sends to Deepgram's HTTP /v1/listen endpoint, which
  // returns a single transcript for the chunk. This bypasses WebSockets
  // entirely so the plugin's WebView (which can't open outbound WS) can
  // still get real STT via fetch() — same network permission as /suggest.
  if (request.method !== 'POST') {
    // Echo what we ACTUALLY received in the body so the plugin's debug
    // log shows whether something is downgrading POST→GET in transit
    // (Cloudflare WAF, redirect, WebView quirk, etc.). Plain text body
    // so it's readable when curl-tested.
    const cf = (request as unknown as { cf?: Record<string, unknown> }).cf
    const headerKeys: string[] = []
    request.headers.forEach((_v, k) => headerKeys.push(k))
    return new Response(
      `POST only. Received: method=${request.method}, url=${request.url}, ` +
      `headers=[${headerKeys.join(',')}], cf-ray=${request.headers.get('cf-ray') ?? 'none'}, ` +
      `cf-country=${(cf as { country?: string } | undefined)?.country ?? 'none'}`,
      { status: 405, headers: { 'Content-Type': 'text/plain', ...corsHeaders() } },
    )
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (!env.SHARED_SECRET || auth !== `Bearer ${env.SHARED_SECRET}`) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  if (!env.DEEPGRAM_API_KEY) {
    return jsonResponse(500, { ok: false, error: 'DEEPGRAM_API_KEY not configured' })
  }
  const pcm = new Uint8Array(await request.arrayBuffer())
  if (pcm.byteLength < 1600) {
    // < ~50ms of audio at 16k. Don't burn quota on near-empty chunks.
    return jsonResponse(200, { ok: true, text: '' })
  }
  const wav = wavWrap(pcm)
  const dgRes = await fetch(buildDeepgramHttpUrl(env), {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  })
  if (!dgRes.ok) {
    const errText = await dgRes.text()
    return jsonResponse(dgRes.status, { ok: false, error: `deepgram ${dgRes.status}: ${errText.slice(0, 200)}` })
  }
  const json = (await dgRes.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: Array<{ word?: string; speaker?: number; confidence?: number }> }> }>
      utterances?: Array<{ start?: number; end?: number; speaker?: number; transcript?: string; confidence?: number }>
    }
  }
  const text = (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
  // Per-speaker utterances. Each is a turn — same speaker until they
  // stop. Plugin uses these to show speaker labels and to exclude the
  // wearer's own speech from the suggestion-prompt context.
  const utterances = (json.results?.utterances ?? [])
    .map(u => ({
      speaker: typeof u.speaker === 'number' ? u.speaker : 0,
      text: (u.transcript ?? '').trim(),
      confidence: typeof u.confidence === 'number' ? u.confidence : 0,
    }))
    .filter(u => u.text.length > 0)
  return jsonResponse(200, { ok: true, text, utterances })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') ?? ''
  return !!env.SHARED_SECRET && auth === `Bearer ${env.SHARED_SECRET}`
}

function requireAnthropicKey(env: Env): string | Response {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse(500, { ok: false, error: 'ANTHROPIC_API_KEY not configured' })
  }
  return env.ANTHROPIC_API_KEY
}

function cleanAiSearchText(text: string): string {
  return text
    .replace(/<div\b[^>]*>\s*<img\b[^>]*\/?>\s*<\/div>/gi, ' ')
    .replace(/<img\b[^>]*\/?>/gi, ' ')
    .replace(/---\s*Page\s+\d+\s*---/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function searchAiSearch(env: Env, query: string): Promise<AiSearchChunk[]> {
  if (!env.AISEARCH_TOKEN) throw new Error('AISEARCH_TOKEN not configured')
  if (!env.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID not configured')

  const accountId = encodeURIComponent(env.CF_ACCOUNT_ID)
  const instance = encodeURIComponent(aiSearchInstance(env))
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/${instance}/search`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AISEARCH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      ai_search_options: {
        retrieval: {
          retrieval_type: 'hybrid',
          max_num_results: aiSearchMaxResults(env),
        },
      },
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`AI Search HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = JSON.parse(text) as {
    success?: boolean
    errors?: Array<{ message?: string }>
    result?: {
      chunks?: AiSearchApiChunk[]
      search_query?: string
    }
  }
  if (json.success === false) {
    const msg = json.errors?.map(e => e.message).filter(Boolean).join('; ') || 'AI Search request failed'
    throw new Error(msg)
  }
  return (json.result?.chunks ?? [])
    .map(chunk => {
      const cleaned = cleanAiSearchText(chunk.text ?? '')
      return {
        id: chunk.id ?? '',
        text: cleaned,
        source: chunk.item?.key ?? 'unknown',
        score: typeof chunk.score === 'number' ? chunk.score : 0,
        metadata: chunk.item?.metadata ?? {},
      }
    })
    .filter(chunk => chunk.text.length > 0)
}

function formatChunksForPrompt(chunks: AiSearchChunk[]): string {
  if (chunks.length === 0) return '検索結果なし。'
  return chunks.map((chunk, i) => {
    return [
      `【資料${i + 1}】`,
      `出典: ${chunk.source}`,
      `score: ${chunk.score}`,
      chunk.text,
    ].join('\n')
  }).join('\n\n')
}

function askSystemPrompt(): string {
  return [
    'あなたは、アップロードされた資料の分野の専門家として回答する日本語アシスタントです。',
    '以下の資料検索結果とユーザーの質問を読み、HUDで読みやすい日本語で直接回答してください。',
    '特定分野名を事前に決め打ちせず、資料内の用語・定義・手順・論理を優先してください。',
    '資料に基づく回答では、文中または文末に「（ファイル名 より）」の形で出典を明示してください。',
    '資料の手順や定義を使って推論・計算する場合は「（資料に基づく試算）」と明示し、計算過程を簡潔に示してください。',
    '検索結果が質問に関連しない場合は、冒頭に「【資料外の一般情報】」を付け、断定しすぎないでください。',
    '確実な根拠がない場合は無理に答えず、「資料にない」または「資料での確認が必要」と明示してください。',
    '複数チャンクを組み合わせ、質問の前提・関連概念も資料から拾って論理的に構成してください。',
    '資料にない内容で補わないでください。補足する場合は資料外であることを明示してください。',
    'Markdown記法は使わないでください。#や##の見出し、**強調**、-や*の箇条書き記号は出力しないでください。',
    '見出しが必要な場合は「【見出し】」のように全角かっこで囲み、本文はプレーンテキストで書いてください。',
    '前置きや挨拶は不要です。答えから入ってください。',
  ].join('\n')
}

function askUserMessage(question: string, chunks: AiSearchChunk[], conditions?: string): string {
  const conditionBlock = conditions?.trim()
    ? `\n\n【条件セッション（将来拡張用）】\n${conditions.trim()}`
    : ''
  return [
    '【ユーザーの質問】',
    question,
    conditionBlock,
    '',
    '【AI Search 検索結果】',
    formatChunksForPrompt(chunks),
    '',
    '上記資料検索結果に基づいて回答してください。',
  ].join('\n')
}

async function handleAsk(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: 'POST only' })
  if (!isAuthorized(request, env)) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  let body: AskBody
  try {
    body = (await request.json()) as AskBody
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid JSON body' })
  }
  if (!body.transcript || typeof body.transcript !== 'string') {
    return jsonResponse(400, { ok: false, error: 'transcript required' })
  }
  const apiKey = requireAnthropicKey(env)
  if (apiKey instanceof Response) return apiKey
  try {
    const correction = correctRecognizedText(body.transcript)
    const question = correction.correctedText
    const chunks = await searchAiSearch(env, question)
    const answer = await callAnthropicText(
      env,
      apiKey,
      askSystemPrompt(),
      askUserMessage(question, chunks, body.conditions),
    )
    return jsonResponse(200, {
      ok: true,
      answer,
      correctedQuestion: question,
      corrections: correction.corrections,
      chunks: chunks.map(c => ({ source: c.source, score: c.score })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return jsonResponse(500, { ok: false, error: msg.slice(0, 200) })
  }
}

async function handleSuggest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: 'POST only' })
  if (!isAuthorized(request, env)) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  let body: SuggestBody
  try {
    body = (await request.json()) as SuggestBody
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid JSON body' })
  }
  if (!body.transcript || typeof body.transcript !== 'string') {
    return jsonResponse(400, { ok: false, error: 'transcript required' })
  }
  // v0.4.2: client passes its rolling list of recent suggestions; we
  // append a "don't repeat these" instruction to the system prompt so
  // the LLM doesn't re-surface the same phrasing.
  const baseSystem = body.customPrompt?.trim() || systemPromptForMode(body.mode ?? 'date')
  const recent = (body.recentSuggestions ?? []).filter(s => typeof s === 'string').slice(-12)
  const dedupeNote = recent.length > 0
    ? `\n\nDO NOT repeat any of these recent suggestions verbatim or near-verbatim — find a different angle:\n${recent.map(s => `- ${s}`).join('\n')}`
    : ''
  const systemPrompt = baseSystem + dedupeNote

  const apiKey = requireAnthropicKey(env)
  if (apiKey instanceof Response) return apiKey
  return await callAnthropicSuggest(env, apiKey, systemPrompt, body.transcript)
}

function systemPromptForMode(mode: string): string {
  // Mirror of src/modes.ts on the plugin side. Kept simple — the plugin
  // sends the full prompt for custom mode, but we ship default fallbacks
  // here in case the plugin doesn't pass one.
  const basePrompt = [
    'あなたは不動産鑑定、会計、民法などの専門分野について、装着者の質問に直接回答する日本語アシスタントです。',
    '質問に対して、定義・要件・解説を辞書や参考書のように正確かつ簡潔に述べてください。',
    '「次にこう言いましょう」のような会話コーチ型の提案はしないでください。',
    '専門用語は正式な表現や原文に近い表現を保ち、曖昧な言い換えで意味を弱めないでください。',
    '確実な知識のみ述べ、不確かな条文番号・数値・個別資料依存事項は推測で断定せず、「正確な確認が必要」または「資料での確認が必要」と明示してください。',
    '資料RAGは未実装のため、一般的な専門知識ベースで回答してください。',
    '回答はG2 HUDで読む前提で、前置きや挨拶なしに答えから入り、500トークン以内で簡潔にまとめてください。',
  ].join('\n')
  const PROMPTS: Record<string, string> = {
    date: basePrompt,
    'argue-calm': basePrompt,
    'sales-close': basePrompt,
    sting: basePrompt,
    listen: basePrompt,
    interview: basePrompt,
  }
  return PROMPTS[mode] ?? PROMPTS.date!
}

async function callAnthropicText(
  env: Env,
  apiKey: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: claudeModel(env),
      max_tokens: claudeMaxTokens(env),
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { content?: Array<{ text?: string }> }
  return json.content?.[0]?.text ?? ''
}

function anthropicStatusFromError(message: string): number {
  const m = message.match(/^anthropic (\d+):/)
  if (!m?.[1]) return 500
  const status = Number.parseInt(m[1], 10)
  return Number.isFinite(status) ? status : 500
}

function anthropicErrorResponse(err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err)
  return jsonResponse(anthropicStatusFromError(msg), { ok: false, error: msg.slice(0, 200) })
}

async function callAnthropicSuggest(
  env: Env,
  apiKey: string,
  systemPrompt: string,
  transcript: string,
): Promise<Response> {
  try {
    const text = await callAnthropicText(
      env,
      apiKey,
      systemPrompt,
      `以下はユーザーからの質問です。\n\n"${transcript}"\n\nこの質問に対して、専門用語を正確に保ちながら日本語で直接回答してください。`,
    )
    return jsonResponse(200, { ok: true, suggestions: parseNumberedList(text) })
  } catch (err) {
    return anthropicErrorResponse(err)
  }
}

// Parse "1. foo\n2. bar\n3. baz" into ["foo", "bar", "baz"]. Tolerates
// LLM preamble / trailing text by only keeping numbered lines.
function parseNumberedList(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (m && m[1]) out.push(m[1].trim())
  }
  return out.length > 0 ? out : [text.trim()]
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  // Auth via query token (WebSocket doesn't support custom headers from
  // browser clients reliably, so we accept the bearer in ?token=).
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (!env.SHARED_SECRET || token !== env.SHARED_SECRET) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }

  const upgrade = request.headers.get('Upgrade') ?? ''
  if (upgrade.toLowerCase() !== 'websocket') {
    return jsonResponse(400, { ok: false, error: 'expected WebSocket upgrade' })
  }

  // Open a WebSocket to Deepgram and pipe frames in both directions.
  // Workers' fetch() supports outbound WS; WebSocketPair gives us the
  // pair to hand back to the client.
  const dgRes = await fetch(buildDeepgramWsUrl(env), {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      Upgrade: 'websocket',
    },
  })
  const dgWs = (dgRes as unknown as { webSocket: WebSocket }).webSocket
  if (!dgWs) return jsonResponse(502, { ok: false, error: 'failed to open Deepgram WS' })
  dgWs.accept()

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()

  // Pipe: glasses audio → Deepgram
  server.addEventListener('message', evt => {
    if (typeof evt.data === 'string') return // ignore text frames from client
    try {
      dgWs.send(evt.data)
    } catch {
      /* ignore */
    }
  })
  server.addEventListener('close', () => {
    try { dgWs.close() } catch { /* ignore */ }
  })

  // Pipe: Deepgram transcripts → glasses (as JSON text frames)
  dgWs.addEventListener('message', evt => {
    try {
      const data = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)
      const parsed = JSON.parse(data) as {
        channel?: { alternatives?: Array<{ transcript?: string }> }
        is_final?: boolean
      }
      const text = parsed.channel?.alternatives?.[0]?.transcript ?? ''
      if (text) {
        server.send(
          JSON.stringify({ type: 'transcript', text, isFinal: !!parsed.is_final }),
        )
      }
    } catch {
      /* ignore parse errors */
    }
  })
  dgWs.addEventListener('close', () => {
    try { server.close() } catch { /* ignore */ }
  })

  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Log every incoming request so `wrangler tail` shows what's actually
    // arriving at the worker (vs what the plugin claims it's sending).
    // Catches the class of bug where Cloudflare WAF / WebView / a redirect
    // mangles the method en route. Cheap — Workers logging is async.
    // eslint-disable-next-line no-console
    console.log(`[req] ${request.method} ${new URL(request.url).pathname} ua=${(request.headers.get('user-agent') ?? '').slice(0, 60)}`)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return jsonResponse(200, { ok: true })
    if (url.pathname === '/ask') return handleAsk(request, env)
    if (url.pathname === '/suggest') return handleSuggest(request, env)
    if (url.pathname === '/transcribe') return handleTranscribe(request, env)
    if (url.pathname === '/ws') return handleWebSocket(request, env)
    return jsonResponse(404, { ok: false, error: 'not found' })
  },
}
