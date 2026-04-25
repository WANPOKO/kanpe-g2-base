import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE, MODES, modeById, nextMode } from '../src/modes'

describe('mode registry', () => {
  it('ships at least the 6 documented modes', () => {
    expect(MODES.length).toBeGreaterThanOrEqual(6)
  })

  it('every mode has required fields populated', () => {
    for (const m of MODES) {
      expect(m.id).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(m.glyph.length).toBeGreaterThan(0)
      expect(m.description).toBeTruthy()
      // System prompt empty only for 'custom'
      if (m.id === 'custom') {
        expect(m.systemPrompt).toBe('')
      } else {
        expect(m.systemPrompt.length).toBeGreaterThan(20)
      }
      expect(typeof m.proactiveSupported).toBe('boolean')
    }
  })

  it('all mode ids are unique', () => {
    const ids = new Set(MODES.map(m => m.id))
    expect(ids.size).toBe(MODES.length)
  })

  it('default mode is in the registry', () => {
    expect(MODES.find(m => m.id === DEFAULT_MODE)).toBeTruthy()
  })

  it('modeById throws on unknown id', () => {
    expect(() => modeById('nonexistent' as 'date')).toThrow()
  })

  it('nextMode cycles through every mode then wraps', () => {
    let cur = MODES[0]!.id
    const visited = new Set<string>([cur])
    for (let i = 0; i < MODES.length; i += 1) {
      cur = nextMode(cur)
      visited.add(cur)
    }
    expect(visited.size).toBe(MODES.length)
    // After cycling len-times we should be back at start.
    let again = MODES[0]!.id
    for (let i = 0; i < MODES.length; i += 1) again = nextMode(again)
    expect(again).toBe(MODES[0]!.id)
  })
})
