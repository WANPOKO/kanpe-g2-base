import { describe, expect, it } from 'vitest'

import { correctRecognizedText, TERM_CORRECTION_DICTIONARY } from '../src/termCorrection'

describe('correctRecognizedText', () => {
  it('replaces known misrecognitions with the formal term', () => {
    const result = correctRecognizedText('二乗補正の必要性を教えてください')

    expect(result.correctedText).toBe('事情補正の必要性を教えてください')
    expect(result.corrections).toEqual([{ from: '二乗補正', to: '事情補正' }])
  })

  it('keeps text unchanged when no aliases are present', () => {
    const result = correctRecognizedText('正常価格とは何ですか')

    expect(result.correctedText).toBe('正常価格とは何ですか')
    expect(result.corrections).toEqual([])
  })

  it('uses term, reading, aliases dictionary entries for future reading-based matching', () => {
    expect(TERM_CORRECTION_DICTIONARY[0]).toEqual({
      term: '事情補正',
      reading: 'じじょうほせい',
      aliases: ['二乗補正', '異常補正', '地上補正'],
    })
  })
})
