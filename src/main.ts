// Cue — multi-mode conversation coach for Even G2 glasses.
//
// See ~/Documents/Pulse/ROADMAP.md § "Plan: Cue" for the full plan.

import { connectEvenRuntime, type EvenRuntime, type InputSource, type SwipeDir } from './even'
import { DEFAULT_MODE, MODES, type Mode, type ModeId, modeById, nextMode } from './modes'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from './mock'
import {
  DEFAULT_IDLE_AUTO_PAUSE_MIN,
  DEFAULT_WEARER_SPEAKER_ID,
  getCustomPrompt,
  getIdleAutoPauseMin,
  getMode,
  getShowDebugOverlay,
  getWearerSpeakerId,
  getWorkerToken,
  getWorkerUrl,
  hasAgreedToPrivacy,
  setCustomPrompt,
  setIdleAutoPauseMin,
  setMode,
  setPrivacyAgreed,
  clearSessionHistory,
  getCalibrating,
  setCalibrating,
  setShowDebugOverlay,
  setStorageBridge,
  setWearerSpeakerId,
  setWorkerToken,
  setWorkerUrl,
} from './storage'
import { createTransport, setTransportLogger, type CueFetchLog, type CueTransport, type TranscriptEvent } from './transport'
import {
  appendTurn,
  batteryHeaderSuffix,
  pruneTurns,
  speakerLabel,
  trimToSentences,
  wrapWords,
  type ConversationTurn,
} from './utterance'

// --- module state ---

let even: EvenRuntime | null = null
let currentMode: ModeId = DEFAULT_MODE
let micOn = false

type AppState = 'off' | 'waiting' | 'active' | 'processing' | 'answer_display'
type CommandType = 'start' | 'end' | 'next' | 'prev' | 'repeat' | 'finish'

type VoiceCommand = {
  type: CommandType
  phrases: string[]
}

const DEFAULT_VOICE_COMMANDS: readonly VoiceCommand[] = [
  { type: 'start', phrases: ['では確認しましょう'] },
  { type: 'end', phrases: ['ありがとうございました'] },
  { type: 'next', phrases: ['次'] },
  { type: 'prev', phrases: ['戻って'] },
  { type: 'repeat', phrases: ['もう一度'] },
  { type: 'finish', phrases: ['終わり'] },
]

function normalizeCommandText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[。、，．.,!！?？「」『』（）()【】\[\]{}]/g, '')
}

function detectVoiceCommand(
  text: string,
  commands: readonly VoiceCommand[] = DEFAULT_VOICE_COMMANDS,
): CommandType | null {
  const normalizedText = normalizeCommandText(text)
  if (!normalizedText) return null

  for (const command of commands) {
    for (const phrase of command.phrases) {
      const normalizedPhrase = normalizeCommandText(phrase)
      if (!normalizedPhrase) continue
      if (normalizedText === normalizedPhrase) return command.type
      if (normalizedPhrase.length > 1 && normalizedText.includes(normalizedPhrase)) return command.type
    }
  }
  return null
}

function splitLongSegment(segment: string, maxChars: number): string[] {
  const pages: string[] = []
  for (let start = 0; start < segment.length; start += maxChars) {
    const page = segment.slice(start, start + maxChars).trim()
    if (page) pages.push(page)
  }
  return pages
}

function splitAnswerPages(text: string, maxChars = MAX_CHARS_PER_ANSWER_PAGE): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const segments = normalized
    .split(/(?<=[。、\n])/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  const pages: string[] = []
  let current = ''

  for (const segment of segments) {
    if (segment.length > maxChars) {
      if (current) {
        pages.push(current)
        current = ''
      }
      pages.push(...splitLongSegment(segment, maxChars))
      continue
    }

    const next = current ? `${current}${segment}` : segment
    if (next.length <= maxChars) {
      current = next
      continue
    }

    if (current) pages.push(current)
    current = segment
  }

  if (current) pages.push(current)
  return pages
}

function clearSessionState(): void {
  questionBuffer = ''
  answerPages = []
  answerPageIndex = 0
  suggestions = []
  liveTranscript = ''
  lastTranscript = ''
  proactiveActive = false
  conversation.length = 0
}

function handleAnswerDisplayCommand(command: CommandType): boolean {
  switch (command) {
    case 'next':
      answerPageIndex = Math.min(answerPageIndex + 1, Math.max(answerPages.length - 1, 0))
      return true
    case 'prev':
      answerPageIndex = Math.max(answerPageIndex - 1, 0)
      return true
    case 'repeat':
      return true
    case 'finish':
      answerPages = []
      answerPageIndex = 0
      questionBuffer = ''
      appState = 'active'
      return true
    case 'start':
    case 'end':
      return false
  }
}

let appState: AppState = 'off'
let questionBuffer = ''
let answerPages: string[] = []
let answerPageIndex = 0

let agreedToPrivacy = false
let lastTranscript = ''
let suggestions: string[] = []
let proactiveActive = false // true when user just ring-tapped for topics
let mockTimer: number | null = null
// Single tick while mic is on — handles the silence-based suggestion
// trigger, idle auto-pause, battery refresh, and stats-line repaint.
let micTickTimer: number | null = null

const MOCK_TICK_MS = 8_000

// Sliding transcript window we send to the LLM. Char budget is soft —
// trimToSentences may emit slightly less to keep sentence boundaries clean.
const TRANSCRIPT_WINDOW_CHARS = 1500
// How often the mic-tick fires while listening. 1s is fast enough to feel
// reactive on a sentence-final pause, slow enough not to hammer BLE.
const MIC_TICK_MS = 1_000
const QUESTION_SILENCE_MS = 2_000
// Real glasses confirmed the answer-only HUD still had room at 150 chars.
// Re-test from 200 chars; increase later if real-device testing still shows room.
const MAX_CHARS_PER_ANSWER_PAGE = 200
const GLASSES_CLEAR_TEXT = ' '.repeat(240)
// Set false before production use: the temporary trigger design must not
// let glasses temple taps start kanpe-g2. Emergency recovery is phone-side;
// a future left+right simultaneous tap fallback is a separate design item.
const DEV_TAP_ENABLED = true
// Auto-pause after this much idle. Idle = no non-empty transcript chunk.
// 0 disables. Sourced from phone settings on bootstrap; falls back to default.
let idleAutoPauseMs = DEFAULT_IDLE_AUTO_PAUSE_MIN * 60_000

let transport: CueTransport | null = null
let isRealMode = false // true when transport.ready (Worker configured)
let liveTranscript = '' // accumulated final transcripts
let suggestionInFlight = false
let lastChunkAt = 0
// Tracking for idle auto-pause — set on every non-empty transcript chunk
// AND on mic-on (so the timer doesn't fire instantly on a quiet start).
let lastTranscriptAt = 0
// Cached so renderGlasses doesn't have to await. Refreshed on the mic tick.
let cachedBatteryLevel: number | undefined
let batteryRefreshInFlight = false
// One-shot reason string shown on the idle screen after auto-pause.
// Cleared when the user manually re-engages the mic.
let autoPausedReason = ''

// v0.4.0 settings — hydrated from storage on bootstrap.
let showDebugOverlay = false  // diagnostic stats line on glasses
let wearerSpeakerId = DEFAULT_WEARER_SPEAKER_ID  // -1 = none / no filter
// v0.4.2: when true, the next non-empty utterance's speaker is anchored
// as wearer + the flag is cleared. Set by phone-side "Calibrate me".
let calibratingNow = false

// v0.4.0 transcript display: per-speaker rolling buffer. Pure helpers
// in utterance.ts (appendTurn / pruneTurns / speakerLabel) — covered
// by unit tests there.
const conversation: ConversationTurn[] = []
const MAX_DISPLAYED_TURNS = 4

// Phone-side fetch debug log. Captures every /transcribe + /suggest
// call so we can see exactly what URL / status / error is happening
// when mic-on doesn't produce transcripts. In-memory, capped.
const FETCH_LOG_CAP = 50
const fetchLog: CueFetchLog[] = []
function pushFetchLog(entry: CueFetchLog): void {
  fetchLog.unshift(entry)
  if (fetchLog.length > FETCH_LOG_CAP) fetchLog.length = FETCH_LOG_CAP
  renderFetchLog()
}

function fmtAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function renderFetchLog(): void {
  if (!fetchLogEl) return
  if (fetchLog.length === 0) {
    fetchLogEl.innerHTML = '<div style="color: #7b7b7b;">No fetches yet. Tap to start a mic session — chunks POST to /transcribe every ~2.5s.</div>'
    return
  }
  fetchLogEl.innerHTML = fetchLog
    .map(e => {
      const statusBadge = e.ok
        ? `<span style="color: #2a2;">${e.status ?? '?'}</span>`
        : `<span style="color: #c00;">${e.status ?? 'NET'}</span>`
      const ms = `${e.ms}ms`
      const bytes = e.bytes !== undefined ? ` ${(e.bytes / 1024).toFixed(1)}KB` : ''
      const err = e.error ? `<div style="color: #c00; margin-top: .15rem;">↳ ${escapeHtml(e.error)}</div>` : ''
      const url = e.url.length > 70 ? `${e.url.slice(0, 67)}…` : e.url
      return `<div style="padding: .35rem 0; border-bottom: 1px solid #f0f0f0;">
        <div style="display: flex; gap: .5rem; align-items: center;">
          <span style="color: #999; min-width: 6em;">${fmtAgo(e.ts)}</span>
          ${statusBadge}
          <span style="color: #555;">${e.method} ${ms}${bytes}</span>
        </div>
        <div style="color: #232323; word-break: break-all;">${escapeHtml(url)}</div>
        ${err}
      </div>`
    })
    .join('')
}

// --- DOM scaffold (phone-side) ---

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('App root missing')

root.innerHTML = `
  <main style="font-family: system-ui; padding: 1rem; max-width: 720px; margin: 0 auto; color: #232323;">
    <h1 style="margin: 0 0 .25rem 0;">kanpe-g2 <span style="font-size: .55em; color: #7b7b7b; font-weight: 400;">v${__APP_VERSION__}</span></h1>
    <p style="color: #7b7b7b; margin: 0 0 1rem 0;">専門商談の即時回答をG2に表示します。</p>
    <p id="status" style="margin: 0 0 1rem 0;">接続中…</p>

    <div id="privacy-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); align-items: center; justify-content: center; z-index: 100;">
      <div style="background: #fff; max-width: 520px; padding: 1.5rem; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.3);">
        <h2 style="margin: 0 0 .5rem 0;">開始前の確認</h2>
        <p>
          kanpe-g2 はG2のマイク音声を文字起こしし、回答候補を表示します。
          音声は文字起こしサービスへ送信されますが、録音ファイルとして保存しません。
        </p>
        <p style="font-weight: 600;">
          利用場所の法令・同意要件はユーザー自身で確認してください。
          相手に知らせない録音や音声処理が違法または不適切となる場合があります。
        </p>
        <p>
          マイクは初期状態でOFFです。マイク動作中はG2上に状態表示を出します。
        </p>
        <div style="display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem;">
          <button id="privacy-decline" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #eee;">中止</button>
          <button id="privacy-accept" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #232323; color: #fff;">理解して続行</button>
        </div>
      </div>
    </div>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">モード</h2>
      <div id="mode-list" style="display: grid; gap: .5rem; max-width: 520px;"></div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">カスタムプロンプト（モード=カスタム時）</h2>
      <textarea id="custom-prompt" rows="4" style="width: 100%; max-width: 520px; padding: .5rem; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: .9em;" placeholder="専門商談向けに、短い日本語回答を2〜3個提案してください。"></textarea>
      <button id="save-custom" type="button" style="margin-top: .35rem; padding: .35rem .7rem; cursor: pointer;">保存</button>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Worker設定</h2>
      <p style="color: #7b7b7b; font-size: .9em; max-width: 520px;">
        実際のSTT + LLMは個人用Cloudflare Worker経由で動作します。
        Worker URL と Bearer token を事前に設定してください。
      </p>
      <div style="display: grid; gap: .25rem; max-width: 520px;">
        <label>Worker URL <input id="worker-url" type="url" placeholder="https://kanpe-g2-worker.example.workers.dev" style="padding: .35rem; width: 100%; box-sizing: border-box;" /></label>
        <label>Bearer token <input id="worker-token" type="password" placeholder="WorkerのSHARED_SECRET" style="padding: .35rem; width: 100%; box-sizing: border-box; font-family: monospace;" /></label>
        <button id="save-worker" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">Worker設定を保存</button>
        <p id="worker-status" style="color: #2a2; font-size: .85em; min-height: 1.2em;"></p>
      </div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">動作設定</h2>
      <div style="display: grid; gap: .5rem; max-width: 520px;">
        <label>無音時の自動停止（分、0で無効） <input id="idle-auto-pause-min" type="number" min="0" step="1" style="padding: .35rem; width: 6em; box-sizing: border-box;" /></label>
        <button id="save-idle" type="button" style="padding: .35rem .7rem; cursor: pointer; max-width: 200px;">保存</button>
        <p id="idle-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label style="display: flex; align-items: center; gap: .5rem; cursor: pointer;">
          <input id="show-debug-overlay" type="checkbox" />
          G2に診断表示を出す（音声フレーム / chunk / error）
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">通常はOFF。マイクや通信が動かない時の切り分け用です。</p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label>自分の話者ID
          <select id="wearer-speaker-id" style="padding: .35rem; margin-left: .5rem;">
            <option value="-1">未指定 / 自動（除外しない）</option>
            <option value="0">話者Aが自分</option>
            <option value="1">話者Bが自分</option>
            <option value="2">話者Cが自分</option>
            <option value="3">話者Dが自分</option>
          </select>
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">設定すると自分の発話は表示のみ行い、回答生成の入力から除外します。G2上の[A]/[B]表示を見て選択してください。</p>
        <p id="wearer-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>

        <button id="calibrate-me" type="button" style="padding: .35rem .7rem; cursor: pointer; max-width: 220px; margin-top: .25rem;">自分の声を登録</button>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">押した後にG2をかけて短く発話すると、次に検出された話者IDを自分として保存します。</p>
        <p id="calibrate-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>
      </div>
    </section>

    <section style="margin-top: 2rem;">
      <details>
        <summary style="cursor: pointer; color: #232323;">Session history (disabled)</summary>
        <p style="color: #7b7b7b; margin: .5rem 0; font-size: .85em; max-width: 520px;">
          kanpe-g2 does not save transcripts, questions, or answers to device
          storage. Use Clear stored records to remove old Cue history from this device.
        </p>
        <div style="display: flex; gap: .5rem; margin-bottom: .5rem;">
          <button id="session-history-clear" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Clear stored records</button>
        </div>
        <div id="session-history" style="max-width: 720px; max-height: 360px; overflow-y: auto; font-size: .85em; border: 1px solid #ddd; padding: .5rem;"></div>
      </details>
    </section>

    <section style="margin-top: 2rem;">
      <details>
        <summary style="cursor: pointer; color: #232323;">Recent fetches (debug)</summary>
        <p style="color: #7b7b7b; margin: .5rem 0; font-size: .85em; max-width: 520px;">
          Last 50 calls to your Worker (/transcribe + /suggest) with status, latency,
          and any error message. Use this to figure out why mic-on isn't producing
          transcripts — 405 = wrong/old worker URL, 401 = bearer mismatch,
          500 with "DEEPGRAM_API_KEY" = worker secret missing.
        </p>
        <div style="display: flex; gap: .5rem; margin-bottom: .5rem;">
          <button id="fetch-log-clear" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Clear</button>
          <button id="fetch-log-refresh" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Refresh</button>
        </div>
        <div id="fetch-log" style="max-width: 720px; max-height: 320px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: .8em; border: 1px solid #ddd; padding: .5rem;"></div>
      </details>
    </section>

    <section style="margin-top: 2rem; color: #7b7b7b; font-size: .85em;">
      <h3 style="font-size: 1em; margin: 0 0 .5rem 0;">How to use</h3>
      <ol style="padding-left: 1.25rem; line-height: 1.5;">
        <li>Pick a mode from the list above.</li>
        <li>Put on the glasses and open Cue from the Even Hub launcher.</li>
        <li>Tap glasses to toggle mic on/off (privacy escape: glasses double-tap or remove glasses).</li>
        <li>v0.1.0 produces mock suggestions on a timer so you can try the flow. Real STT + LLM lands in v0.2+.</li>
      </ol>
    </section>
  </main>
`

const status = document.querySelector<HTMLParagraphElement>('#status')!
const modeList = document.querySelector<HTMLDivElement>('#mode-list')!
const customPromptInput = document.querySelector<HTMLTextAreaElement>('#custom-prompt')!
const saveCustomBtn = document.querySelector<HTMLButtonElement>('#save-custom')!
const workerUrlInput = document.querySelector<HTMLInputElement>('#worker-url')!
const workerTokenInput = document.querySelector<HTMLInputElement>('#worker-token')!
const saveWorkerBtn = document.querySelector<HTMLButtonElement>('#save-worker')!
const workerStatus = document.querySelector<HTMLParagraphElement>('#worker-status')!
const privacyModal = document.querySelector<HTMLDivElement>('#privacy-modal')!
const privacyAccept = document.querySelector<HTMLButtonElement>('#privacy-accept')!
const privacyDecline = document.querySelector<HTMLButtonElement>('#privacy-decline')!
const idleAutoPauseInput = document.querySelector<HTMLInputElement>('#idle-auto-pause-min')!
const saveIdleBtn = document.querySelector<HTMLButtonElement>('#save-idle')!
const idleStatus = document.querySelector<HTMLParagraphElement>('#idle-status')!
const showDebugOverlayInput = document.querySelector<HTMLInputElement>('#show-debug-overlay')!
const wearerSpeakerSelect = document.querySelector<HTMLSelectElement>('#wearer-speaker-id')!
const wearerStatus = document.querySelector<HTMLParagraphElement>('#wearer-status')!
const calibrateBtn = document.querySelector<HTMLButtonElement>('#calibrate-me')!
const calibrateStatus = document.querySelector<HTMLParagraphElement>('#calibrate-status')!

calibrateBtn.addEventListener('click', async () => {
  await setCalibrating(true)
  calibratingNow = true
  calibrateStatus.style.color = '#2a2'
  calibrateStatus.textContent = '自分の声を登録中です。10秒以内に短く発話してください。'
  window.setTimeout(() => { calibrateStatus.textContent = '' }, 12_000)
})

showDebugOverlayInput.addEventListener('change', async () => {
  showDebugOverlay = showDebugOverlayInput.checked
  await setShowDebugOverlay(showDebugOverlay)
  void paint()
})

wearerSpeakerSelect.addEventListener('change', async () => {
  const id = Number.parseInt(wearerSpeakerSelect.value, 10)
  wearerSpeakerId = Number.isFinite(id) ? id : DEFAULT_WEARER_SPEAKER_ID
  await setWearerSpeakerId(wearerSpeakerId)
  wearerStatus.style.color = '#2a2'
  wearerStatus.textContent = wearerSpeakerId < 0
    ? '自動設定です。発話の除外は行いません。'
    : `話者${speakerLabel(wearerSpeakerId)}を自分として扱います。自分の発話は回答生成から除外します。`
  window.setTimeout(() => { wearerStatus.textContent = '' }, 5000)
  void paint()
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function renderModeList(): void {
  modeList.innerHTML = MODES.map(
    m => `
    <label style="display: flex; gap: .75rem; align-items: flex-start; padding: .6rem .75rem; background: ${m.id === currentMode ? '#fef991' : '#eee'}; border-radius: 4px; cursor: pointer;">
      <input type="radio" name="mode" value="${m.id}" ${m.id === currentMode ? 'checked' : ''} style="margin-top: .2rem;" />
      <div style="flex: 1;">
        <div><span style="margin-right: .5rem;">${m.glyph}</span><strong>${escapeHtml(m.label)}</strong></div>
        <div style="color: #555; font-size: .85em; margin-top: .15rem;">${escapeHtml(m.description)}</div>
      </div>
    </label>
  `,
  ).join('')
  modeList.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(input => {
    input.addEventListener('change', async () => {
      currentMode = input.value as ModeId
      await setMode(currentMode)
      renderModeList()
      await paint()
    })
  })
}

// --- glasses display ---

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Width budget per line on the 576-px greyscale display, derived from the
// existing trunc-to-38 the v0.2 build used. Two lines per suggestion is the
// sweet spot — enough room to land a question without dropping context.
const LINE_WIDTH = 38
const SUGGESTION_MAX_LINES = 2

// Per-mode prefix glyph for suggestions — gives the user a visual cue of
// which coach they're hearing without re-reading the header. Numbers stay
// for accessibility ordering.
const MODE_BULLET: Record<ModeId, string> = {
  date: '★',
  'argue-calm': '◇',
  'sales-close': '▶',
  sting: '⚡',
  listen: '●',
  interview: '▣',
  custom: '◆',
}

function emphasizeFirstWord(s: string): string {
  // Cheap proxy for "imperative-verb emphasis": uppercase the first word.
  // The LLM's suggestion templates put the action verb first in every
  // mode prompt, so this lands the eye on the right word without any
  // English-NLP gymnastics.
  const m = /^(\S+)(\s.*)?$/.exec(s.trim())
  if (!m) return s
  const [, first, rest] = m
  return `${first!.toUpperCase()}${rest ?? ''}`
}

function renderAnswerDisplay(): string {
  const page = answerPages[answerPageIndex] ?? ''
  const total = Math.max(answerPages.length, 1)
  return [
    page || '（回答なし）',
    '',
    `${answerPageIndex + 1}/${total}`,
  ].join('\n')
}

function renderGlasses(): string {
  const mode: Mode = modeById(currentMode)
  const micGlyph = micOn ? '●' : '○'
  const battery = batteryHeaderSuffix(cachedBatteryLevel)
  // Header is fixed-width-ish: mode label left, mic state center, battery right.
  const header = `${mode.glyph} ${mode.label}  ${micGlyph} ${micOn ? '聞取中' : 'マイクOFF'}${battery ? `  ${battery}` : ''}`
  if (appState === 'off' && micOn) return GLASSES_CLEAR_TEXT
  if (appState === 'waiting' && micOn) return GLASSES_CLEAR_TEXT
  if (!agreedToPrivacy) {
    return [
      header,
      '',
      'マイク利用の確認が必要です。',
      'スマホ側で内容を確認し、',
      '同意してから開始してください。',
    ].join('\n')
  }
  if (!micOn) {
    const idleLines: string[] = [
      header,
      '',
      `モード: ${mode.label}`,
      mode.description.length > 64 ? trunc(mode.description, 64) : mode.description,
      '',
    ]
    if (autoPausedReason) {
      idleLines.push(autoPausedReason)
      idleLines.push('')
    }
    idleLines.push(`${isRealMode ? '◉ 本番' : '◌ 模擬'} 待機中`)
    idleLines.push('[tap] マイク開始')
    idleLines.push('[2x] モード切替')
    return idleLines.join('\n')
  }
  if (appState === 'answer_display') return renderAnswerDisplay()
  // Live view.
  const lines: string[] = [header, '']
  // v0.4.0: render up to MAX_DISPLAYED_TURNS of the rolling conversation
  // with [A]/[B] speaker labels. Wearer's turns marked "(you)" so the
  // user knows we're filtering them from the suggestion context.
  pruneTurns(conversation, Date.now())
  const recent = conversation.slice(-MAX_DISPLAYED_TURNS)
  if (recent.length > 0) {
    for (const turn of recent) {
      const label = speakerLabel(turn.speaker)
      const youMarker = turn.speaker === wearerSpeakerId ? ' (you)' : ''
      lines.push(trunc(`[${label}${youMarker}] ${turn.text}`, 76))
    }
  } else if (lastTranscript) {
    // Mock mode + early frames before any conversation turn lands.
    lines.push(trunc(lastTranscript, 100))
  } else {
    lines.push(proactiveActive ? '新しい論点:' : '聞き取り中…')
  }
  // Diagnostic stats — gated on showDebugOverlay. Default OFF; toggle
  // on via phone-side "Show diagnostic overlay on glasses." Same info
  // as before: audio frames flowing, chunk success rate, last error.
  if (showDebugOverlay && isRealMode && transport) {
    const s = transport.stats()
    lines.push(`audio frames=${s.framesReceived} chunks=${s.chunksFlushed}/${s.chunksOk}ok`)
    if (s.lastError) {
      lines.push(`err: ${s.lastError}`)
    }
  }
  lines.push('')
  lines.push('—'.repeat(20))
  if (suggestions.length > 0) {
    const bullet = MODE_BULLET[currentMode] ?? '·'
    const isCustom = currentMode === 'custom'
    suggestions.slice(0, 3).forEach((s, i) => {
      const label = isCustom ? s.trim() : emphasizeFirstWord(s)
      const prefix = `${i + 1}.${bullet} `
      const wrapped = wrapWords(label, LINE_WIDTH - prefix.length, SUGGESTION_MAX_LINES)
      wrapped.forEach((ln, j) => {
        lines.push(j === 0 ? `${prefix}${ln}` : `${' '.repeat(prefix.length)}${ln}`)
      })
    })
  } else {
    lines.push('（回答候補を表示します）')
  }
  lines.push('')
  lines.push(mode.proactiveSupported ? '[ring 2x] 論点  [tap] マイク' : '[tap] マイク切替')
  return lines.join('\n')
}

async function paint(): Promise<void> {
  if (!even) return
  await even.render(renderGlasses())
}

function refreshBatteryLevel(): void {
  if (!even || batteryRefreshInFlight) return
  batteryRefreshInFlight = true
  void even.getBatteryLevel()
    .then(level => {
      cachedBatteryLevel = level
      void paint()
    })
    .catch(() => {})
    .finally(() => {
      batteryRefreshInFlight = false
    })
}

// --- mock-mode driver ---

function startMockTimer(): void {
  stopMockTimer()
  // Fire one immediately so the user sees something on tap-to-start.
  void runMockTick()
  mockTimer = window.setInterval(() => void runMockTick(), MOCK_TICK_MS)
}

function stopMockTimer(): void {
  if (mockTimer !== null) {
    window.clearInterval(mockTimer)
    mockTimer = null
  }
}

async function runMockTick(): Promise<void> {
  if (!micOn) return
  if (proactiveActive) return // ring-tap-driven topics override the reactive cycle until cleared
  const next = nextMockExchange(currentMode)
  lastTranscript = next.transcript
  suggestions = next.suggestions
  await paint()
}

async function showProactiveTopics(): Promise<void> {
  if (!micOn) return
  const mode = modeById(currentMode)
  if (!mode.proactiveSupported) return
  proactiveActive = true
  lastTranscript = '' // hide transcript area while showing fresh topics
  suggestions = nextMockProactiveTopics(currentMode)
  await paint()
  // Auto-clear after 12s and resume reactive cycle.
  window.setTimeout(() => {
    proactiveActive = false
    void paint()
  }, 12_000)
}

// --- input handlers ---

async function toggleMic(): Promise<void> {
  if (!agreedToPrivacy) return
  micOn = !micOn
  appState = micOn ? 'waiting' : 'off'
  questionBuffer = ''
  answerPages = []
  answerPageIndex = 0
  suggestions = []
  lastTranscript = ''
  liveTranscript = ''
  proactiveActive = false
  if (micOn) {
    // User re-engaged after auto-pause — clear the stale notice.
    autoPausedReason = ''
    lastTranscriptAt = Date.now()
    lastChunkAt = Date.now()
    // Reset the LLM transcript window so the new session starts fresh
    liveTranscript = ''
    if (isRealMode && transport && even) {
      await startRealSession()
    } else {
      resetMock()
      startMockTimer()
    }
    startMicTick()
  } else {
    stopMockTimer()
    stopMicTick()
    if (transport) await transport.endMicSession()
    if (even) await even.stopMic()
  }
  await paint()
}

async function startWaitingMic(): Promise<void> {
  if (!agreedToPrivacy) return
  if (micOn) {
    appState = 'waiting'
    await paint()
    return
  }

  micOn = true
  appState = 'waiting'
  clearSessionState()
  autoPausedReason = ''
  lastTranscriptAt = Date.now()
  lastChunkAt = Date.now()
  await paint()

  if (isRealMode && transport && even) {
    void startRealSession().catch(() => {
      autoPausedReason = 'マイク起動に失敗しました'
      void paint()
    })
  } else {
    resetMock()
    startMockTimer()
  }
  startMicTick()
}

function startMicTick(): void {
  stopMicTick()
  micTickTimer = window.setInterval(() => void micTick(), MIC_TICK_MS)
}

function stopMicTick(): void {
  if (micTickTimer !== null) {
    window.clearInterval(micTickTimer)
    micTickTimer = null
  }
}

async function micTick(): Promise<void> {
  if (!micOn) return
  const now = Date.now()
  // Idle auto-pause: no non-empty transcript for idleAutoPauseMs.
  // 0 disables — user can opt out via phone settings.
  if (appState !== 'waiting' && idleAutoPauseMs > 0 && now - lastTranscriptAt > idleAutoPauseMs) {
    autoPausedReason = `${Math.round(idleAutoPauseMs / 60_000)}分無音のため自動停止`
    await toggleMic() // turns mic off + repaints
    return
  }
  // Refresh battery cache (cheap — usually returns the pushed value).
  refreshBatteryLevel()
  // Silence-driven suggestion trigger — sentence-final fires on transcript
  // arrival; this catches the case where the user simply stops talking.
  if (isRealMode) void maybeRequestSuggestions()
  await paint()
}

// --- real (Worker-backed) session ---

async function startRealSession(): Promise<void> {
  if (!transport || !even) return
  liveTranscript = ''
  // Transport now uses chunked HTTP POST instead of WebSocket (the WebView
  // blocks outbound WS handshakes — see transport.ts header comment).
  // startMicSession throws on worker-unreachable / probe-failed; per-chunk
  // network blips during the session come back via the onError callback.
  try {
    await transport.startMicSession(onTranscriptFrame, msg => {
      // Per-chunk transport error mid-session. Log but don't kill the
      // session; the next chunk still has a chance.
      // eslint-disable-next-line no-console
      console.warn('[cue] transcribe error:', msg)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lastTranscript = `(本番モード不可: ${msg.slice(0, 80)})`
    // eslint-disable-next-line no-console
    console.error('[cue] real-mode startMicSession failed:', msg)
    isRealMode = false
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  // Ask the SDK to start the mic. PCM frames flow into transport via
  // sendAudioFrame; transport buffers and POSTs every CHUNK_MS.
  const ok = await even.startMic(frame => {
    transport?.sendAudioFrame(frame)
  })
  if (!ok) {
    lastTranscript = '（マイク許可がありません）'
    isRealMode = false
    await transport.endMicSession()
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  lastTranscript = '（聞き取り中です。発話してください）'
  await paint()
}

function onTranscriptFrame(e: TranscriptEvent): void {
  const detectedCommand = detectVoiceCommand(e.text)
  if (
    detectedCommand === 'end' &&
    (appState === 'active' || appState === 'waiting' || appState === 'answer_display')
  ) {
    clearSessionState()
    lastTranscriptAt = Date.now()
    lastChunkAt = Date.now()
    appState = 'waiting'
    void paint()
    return
  }
  if (appState === 'answer_display') {
    if (detectedCommand) {
      handleAnswerDisplayCommand(detectedCommand)
      void paint()
    }
    return
  }
  if (appState === 'waiting') {
    if (detectedCommand === 'start') {
      appState = 'active'
      questionBuffer = ''
      answerPages = []
      answerPageIndex = 0
      suggestions = []
      lastTranscript = '質問をどうぞ'
      lastChunkAt = Date.now()
      lastTranscriptAt = Date.now()
      void paint()
    }
    return
  }

  // v0.4.0: prefer per-speaker utterances when available so we can show
  // [A]/[B] labels and exclude the wearer's own words from the suggestion
  // prompt. Falls back to whole-chunk text when the worker / Deepgram
  // didn't return utterances (older worker or single-speaker chunk).
  const turns = e.utterances && e.utterances.length > 0
    ? e.utterances.map(u => ({ speaker: u.speaker, text: u.text }))
    : (e.text.trim().length > 0 ? [{ speaker: 0, text: e.text.trim() }] : [])

  // Accumulate into the conversation (same-speaker turns merge so words
  // stream in until the speaker actually changes).
  for (const t of turns) {
    appendTurn(conversation, t.speaker, t.text, Date.now())
  }

  // v0.4.2 calibrate-me: if the user just tapped "Calibrate me" on the
  // phone, anchor the FIRST non-empty speaker we see as wearer + clear
  // the one-shot flag. Persists to storage so it survives reload.
  if (calibratingNow && turns.length > 0) {
    const firstSpeaker = turns[0].speaker
    wearerSpeakerId = firstSpeaker
    calibratingNow = false
    void setWearerSpeakerId(firstSpeaker)
    void setCalibrating(false)
    // Reflect in the UI immediately
    if (wearerSpeakerSelect) wearerSpeakerSelect.value = String(firstSpeaker)
    if (calibrateStatus) {
      calibrateStatus.style.color = '#2a2'
      calibrateStatus.textContent = `Got it — Speaker ${speakerLabel(firstSpeaker)} is you.`
      window.setTimeout(() => { calibrateStatus.textContent = '' }, 5_000)
    }
  }

  // Build the rolling LLM-context buffer EXCLUDING the wearer's lines
  // (so suggestions are responses TO the other person, not echoes of
  // what the wearer just said).
  if (e.isFinal) {
    const questionText = e.text.trim()
    if (!detectedCommand && questionText.length > 0) {
      questionBuffer = trimToSentences(`${questionBuffer} ${questionText}`, TRANSCRIPT_WINDOW_CHARS)
      lastChunkAt = Date.now()
    }

    const otherLines = turns
      .filter(t => wearerSpeakerId < 0 || t.speaker !== wearerSpeakerId)
      .map(t => t.text)
      .join(' ')
    if (otherLines.trim().length > 0) {
      liveTranscript = trimToSentences(`${liveTranscript} ${otherLines}`, TRANSCRIPT_WINDOW_CHARS)
      lastChunkAt = Date.now()
    }
    // Idle auto-pause is "any speech," not "other-only" — we don't want
    // a wearer-only chunk to be considered idle.
    if (e.text.trim().length > 0) lastTranscriptAt = Date.now()
  }
  // Keep lastTranscript for the (now-deprecated) single-line fallback,
  // but renderGlasses now reads from `conversation` directly.
  lastTranscript = e.text
  void paint()
}

async function maybeRequestSuggestions(): Promise<void> {
  if (!transport || !isRealMode) return
  if (appState !== 'active') return
  if (suggestionInFlight) return
  const question = questionBuffer.trim()
  if (!question) return
  if (Date.now() - lastChunkAt < QUESTION_SILENCE_MS) return

  appState = 'processing'
  suggestionInFlight = true
  try {
    const result = await transport.requestAsk({
      mode: currentMode,
      transcript: question,
    })
    if (result.ok) {
      const answerText = result.answer.trim()
      answerPages = splitAnswerPages(answerText)
      answerPageIndex = 0
      appState = 'answer_display'
      suggestions = answerText ? [answerText] : []
    } else {
      const errorText = `エラー: ${result.error.slice(0, 120)}`
      answerPages = splitAnswerPages(errorText)
      answerPageIndex = 0
      appState = 'answer_display'
      suggestions = [errorText]
    }
    await paint()
  } finally {
    suggestionInFlight = false
    questionBuffer = ''
    if (appState === 'processing') appState = micOn ? 'active' : 'off'
  }
}

async function cycleMode(): Promise<void> {
  currentMode = nextMode(currentMode)
  await setMode(currentMode)
  renderModeList()
  await paint()
}

function onTap(_src: InputSource): void {
  if (!DEV_TAP_ENABLED) return
  if (!agreedToPrivacy) return // require phone-side opt-in first
  if (!micOn) {
    void toggleMic()
    return
  }
  // Mic on: tap toggles mic off (so the user can pause quickly).
  void toggleMic()
}

function onDoubleTap(source: InputSource): void {
  if (!DEV_TAP_ENABLED) return
  if (!agreedToPrivacy) {
    if (even) void even.exitApp()
    return
  }
  if (!micOn) {
    // Idle: cycle mode regardless of source.
    void cycleMode()
    return
  }
  // Mic on, ring 2x = proactive topics; glasses 2x = exit (stops mic too).
  if (source === 'ring') {
    void showProactiveTopics()
    return
  }
  if (even) {
    micOn = false
    stopMockTimer()
    stopMicTick()
    void even.exitApp()
  }
}

function onSwipe(_dir: SwipeDir): void {
  // Reserved for v0.2+ — could let the user scroll back through the
  // transcript buffer or page through more suggestions.
}

// --- privacy modal handlers ---

privacyAccept.addEventListener('click', async () => {
  agreedToPrivacy = true
  await setPrivacyAgreed()
  privacyModal.style.display = 'none'
  await paint()
})
privacyDecline.addEventListener('click', () => {
  privacyModal.style.display = 'none'
  status.textContent = '同意しませんでした。再起動後にいつでも同意できます。'
})

// --- form handlers ---

saveCustomBtn.addEventListener('click', async () => {
  await setCustomPrompt(customPromptInput.value)
  saveCustomBtn.textContent = '保存済み ✓'
  window.setTimeout(() => { saveCustomBtn.textContent = '保存' }, 2000)
})

// Wire fetch log accessors + handlers (must come BEFORE bootstrap so
// renderFetchLog has a target element when the first chunk fires).
const fetchLogEl = document.querySelector<HTMLDivElement>('#fetch-log')!
const fetchLogClearBtn = document.querySelector<HTMLButtonElement>('#fetch-log-clear')!
const fetchLogRefreshBtn = document.querySelector<HTMLButtonElement>('#fetch-log-refresh')!
fetchLogClearBtn.addEventListener('click', () => { fetchLog.length = 0; renderFetchLog() })
fetchLogRefreshBtn.addEventListener('click', () => renderFetchLog())
setTransportLogger(pushFetchLog)
renderFetchLog()

// v0.4.3 — Session history panel (past mic sessions)
const sessionHistoryEl = document.querySelector<HTMLDivElement>('#session-history')!
const sessionHistoryClearBtn = document.querySelector<HTMLButtonElement>('#session-history-clear')!
sessionHistoryClearBtn.addEventListener('click', async () => {
  if (!confirm('Delete old Cue session records from this device?')) return
  await clearSessionHistory()
  await renderSessionHistory()
})

async function renderSessionHistory(): Promise<void> {
  if (!sessionHistoryEl) return
  await clearSessionHistory()
  sessionHistoryEl.innerHTML = '<div style="color: #7b7b7b; padding: .5rem;">Session history is disabled. Transcripts, questions, and answers are not saved on this device.</div>'
}

// Initial render + re-render after each mic session ends.
void renderSessionHistory()

saveIdleBtn.addEventListener('click', async () => {
  const raw = Number.parseInt(idleAutoPauseInput.value, 10)
  const min = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_AUTO_PAUSE_MIN
  await setIdleAutoPauseMin(min)
  idleAutoPauseMs = min * 60_000
  idleAutoPauseInput.value = String(min)
  idleStatus.style.color = '#2a2'
  idleStatus.textContent = min === 0
    ? '保存しました。自動停止は無効です。'
    : `保存しました。${min}分無音でマイクを自動停止します。`
  window.setTimeout(() => { idleStatus.textContent = '' }, 4000)
})

saveWorkerBtn.addEventListener('click', async () => {
  await setWorkerUrl(workerUrlInput.value)
  await setWorkerToken(workerTokenInput.value)
  // Re-initialize transport so the next mic session uses the new config.
  transport = createTransport(workerUrlInput.value.trim(), workerTokenInput.value.trim())
  isRealMode = transport.ready
  workerStatus.style.color = '#2a2'
  workerStatus.textContent = isRealMode
    ? '保存しました。次回マイク開始時から本番STT + LLMを使います。'
    : '保存しました。URLまたはtoken未入力のため模擬モードで動きます。'
  window.setTimeout(() => { workerStatus.textContent = '' }, 4000)
  // Force an immediate glasses repaint so the ◉ live / ◌ mock indicator
  // reflects the new state without waiting for the next user gesture.
  void paint()
})

// --- bootstrap ---

async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[cue] bootstrap start')
  status.textContent = 'G2に接続中…'
  even = await connectEvenRuntime(`kanpe-g2 v${__APP_VERSION__}\n\n読み込み中…`)

  if (!even) return
  setStorageBridge({ getStorage: even.getStorage, setStorage: even.setStorage })
  void clearSessionHistory()

  // Hydrate state.
  agreedToPrivacy = await hasAgreedToPrivacy()
  // In dev mode (Vite dev server), auto-accept the privacy gate so the
  // simulator regression test and developer workflow aren't blocked by
  // the phone-side modal. Production .ehpk installs run with
  // import.meta.env.DEV === false and require explicit user opt-in.
  if (!agreedToPrivacy && import.meta.env.DEV) {
    agreedToPrivacy = true
    await setPrivacyAgreed()
    // eslint-disable-next-line no-console
    console.log('[cue:state] dev-mode auto-accepted privacy (production requires real opt-in)')
  }
  const persistedMode = await getMode()
  if (persistedMode) currentMode = persistedMode
  customPromptInput.value = await getCustomPrompt()
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  workerUrlInput.value = wUrl
  workerTokenInput.value = wTok
  const idleMin = await getIdleAutoPauseMin()
  idleAutoPauseInput.value = String(idleMin)
  idleAutoPauseMs = idleMin * 60_000
  // Hydrate v0.4.0 toggles.
  showDebugOverlay = await getShowDebugOverlay()
  showDebugOverlayInput.checked = showDebugOverlay
  wearerSpeakerId = await getWearerSpeakerId()
  wearerSpeakerSelect.value = String(wearerSpeakerId)
  calibratingNow = await getCalibrating()
  // Set up transport if both Worker URL + token are configured. If they're
  // unset or change later, mock mode runs.
  transport = createTransport(wUrl, wTok)
  isRealMode = transport.ready
  renderModeList()

  if (!agreedToPrivacy) {
    privacyModal.style.display = 'flex'
  }

  if (!even) {
    status.textContent = 'Even runtime外で実行中です。ブラウザプレビューのみです。'
    return
  }
  status.textContent = agreedToPrivacy
    ? 'G2接続済み。G2操作でセッションを開始できます。'
    : 'G2接続済み。マイク利用には確認への同意が必要です。'

  even.onTap(onTap)
  even.onSwipe(onSwipe)
  even.onDoubleTap(onDoubleTap)
  even.onForeground(() => { void paint() })

  // One-shot battery read so the idle screen shows the glyph before the
  // first mic-tick. The tick keeps it fresh while mic is on; without this
  // call the battery glyph is invisible on every cold-start idle render.
  refreshBatteryLevel()

  await paint()
  if (agreedToPrivacy) void startWaitingMic()
}

void bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[cue] bootstrap threw:', err?.message ?? err, err?.stack)
})
