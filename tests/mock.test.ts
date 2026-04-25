import { beforeEach, describe, expect, it } from 'vitest'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from '../src/mock'
import { MODES } from '../src/modes'

describe('mock driver', () => {
  beforeEach(() => resetMock())

  it('returns transcript + suggestions for every reactive mode', () => {
    for (const mode of MODES) {
      resetMock()
      const ex = nextMockExchange(mode.id)
      expect(ex.transcript.length).toBeGreaterThan(10)
      expect(ex.suggestions.length).toBeGreaterThan(0)
      // Every suggestion is non-empty string under a reasonable cap.
      for (const s of ex.suggestions) {
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(2)
        expect(s.length).toBeLessThan(200)
      }
    }
  })

  it('cycles through script entries (script length > 1)', () => {
    const a = nextMockExchange('date').transcript
    const b = nextMockExchange('date').transcript
    expect(a).not.toBe(b)
  })

  it('proactive topics defined for date mode', () => {
    const topics = nextMockProactiveTopics('date')
    expect(topics.length).toBeGreaterThan(0)
    for (const t of topics) {
      expect(t.length).toBeGreaterThan(5)
    }
  })

  it('proactive topics gracefully degrade for modes without them', () => {
    const topics = nextMockProactiveTopics('argue-calm')
    expect(topics.length).toBe(1)
    expect(topics[0]).toMatch(/not available/i)
  })
})
