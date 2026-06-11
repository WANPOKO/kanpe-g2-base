export interface CorrectionEntry {
  term: string
  reading: string
  aliases: string[]
}

export interface AppliedCorrection {
  from: string
  to: string
}

export interface CorrectionResult {
  originalText: string
  correctedText: string
  corrections: AppliedCorrection[]
}

export const TERM_CORRECTION_DICTIONARY: readonly CorrectionEntry[] = [
  {
    term: '事情補正',
    reading: 'じじょうほせい',
    aliases: ['二乗補正', '異常補正', '地上補正'],
  },
]

export function correctRecognizedText(
  text: string,
  dictionary: readonly CorrectionEntry[] = TERM_CORRECTION_DICTIONARY,
): CorrectionResult {
  let correctedText = text
  const corrections: AppliedCorrection[] = []

  for (const entry of dictionary) {
    for (const alias of entry.aliases) {
      if (!alias || alias === entry.term || !correctedText.includes(alias)) continue
      correctedText = correctedText.split(alias).join(entry.term)
      corrections.push({ from: alias, to: entry.term })
    }
  }

  return {
    originalText: text,
    correctedText,
    corrections,
  }
}
