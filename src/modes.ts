// Cue mode registry. Each mode bundles a system prompt that shapes the LLM's
// suggestions, plus per-mode behavior flags (reactive vs proactive).
//
// Modes are exposed both on glasses (cycle via tap) and on the phone
// settings page (radio buttons). User can also write a fully custom prompt
// via the "custom" mode.

export type ModeId = 'date' | 'argue-calm' | 'sales-close' | 'sting' | 'listen' | 'interview' | 'custom'

export interface Mode {
  id: ModeId
  label: string // user-facing display name
  glyph: string // single-char visual indicator on glasses (verified-safe)
  description: string // shown in phone settings
  systemPrompt: string // sent to the LLM
  proactiveSupported: boolean // if true, ring-tap on silence asks for fresh topics
}

const JAPANESE_BUSINESS_PROMPT = [
  'あなたは不動産鑑定、会計、民法などの専門分野について、装着者の質問に直接回答する日本語アシスタントです。',
  '質問に対して、定義・要件・解説を辞書や参考書のように正確かつ簡潔に述べてください。',
  '「次にこう言いましょう」のような会話コーチ型の提案はしないでください。',
  '専門用語は正式な表現や原文に近い表現を保ち、曖昧な言い換えで意味を弱めないでください。',
  '確実な知識のみ述べ、不確かな条文番号・数値・個別資料依存事項は推測で断定せず、「正確な確認が必要」または「資料での確認が必要」と明示してください。',
  '資料RAGは未実装のため、一般的な専門知識ベースで回答してください。',
  '回答はG2 HUDで読む前提で、前置きや挨拶なしに答えから入り、500トークン以内で簡潔にまとめてください。',
].join('\n')

// Single pivot point — change here, propagate everywhere. Order matters:
// it's the cycle order on glasses (tap goes left → right, wraps).
export const MODES: Mode[] = [
  {
    id: 'date',
    label: '商談支援',
    glyph: '★',
    description:
      '専門商談で使える確認質問や回答候補を、日本語で簡潔に提案します。',
    systemPrompt: JAPANESE_BUSINESS_PROMPT,
    proactiveSupported: true,
  },
  {
    id: 'argue-calm',
    label: '冷静確認',
    glyph: '◇',
    description:
      '相手の主張を受け止めつつ、断定しすぎない確認表現を提案します。',
    systemPrompt: JAPANESE_BUSINESS_PROMPT,
    proactiveSupported: false,
  },
  {
    id: 'sales-close',
    label: '論点整理',
    glyph: '▶',
    description:
      '相手の質問や反論から、次に整理すべき論点を短く提案します。',
    systemPrompt: JAPANESE_BUSINESS_PROMPT,
    proactiveSupported: false,
  },
  {
    id: 'sting',
    label: '短答',
    glyph: '⚡',
    description: 'HUDで即読める短い回答候補を優先して提案します。',
    systemPrompt: JAPANESE_BUSINESS_PROMPT,
    proactiveSupported: false,
  },
  {
    id: 'listen',
    label: '聞き返し',
    glyph: '●',
    description:
      '不明点を自然に確認するための聞き返し表現を提案します。',
    systemPrompt: JAPANESE_BUSINESS_PROMPT,
    proactiveSupported: false,
  },
  {
    id: 'interview',
    label: '回答補助',
    glyph: '▣',
    description:
      '専門的な質問に対する簡潔で構造化された回答候補を提案します。',
    systemPrompt: JAPANESE_BUSINESS_PROMPT,
    proactiveSupported: false,
  },
  {
    id: 'custom',
    label: 'カスタム',
    glyph: '◆',
    description:
      'スマホ設定で入力した独自プロンプトを使用します。',
    systemPrompt: '', // user-supplied; falls back to a generic "be helpful" if empty
    proactiveSupported: true,
  },
]

export function modeById(id: ModeId): Mode {
  const m = MODES.find(x => x.id === id)
  if (!m) throw new Error(`unknown mode: ${id}`)
  return m
}

// Cycle helper for tap-to-switch on glasses.
export function nextMode(current: ModeId): ModeId {
  const idx = MODES.findIndex(m => m.id === current)
  const next = (idx + 1) % MODES.length
  return MODES[next]!.id
}

export const DEFAULT_MODE: ModeId = 'date'
