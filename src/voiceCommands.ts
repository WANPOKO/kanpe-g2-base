export type CommandType = 'start' | 'end' | 'next' | 'prev' | 'repeat' | 'finish' | 'confirm' | 'retry'

export interface VoiceCommand {
  type: CommandType
  phrases: string[]
}

export const DEFAULT_VOICE_COMMANDS: readonly VoiceCommand[] = [
  { type: 'start', phrases: ['では確認しましょう'] },
  { type: 'end', phrases: ['ありがとうございました'] },
  { type: 'next', phrases: ['次'] },
  { type: 'prev', phrases: ['戻って'] },
  { type: 'repeat', phrases: ['もう一度'] },
  { type: 'finish', phrases: ['終わり'] },
  { type: 'confirm', phrases: ['うん'] },
  { type: 'retry', phrases: ['やり直し'] },
]
