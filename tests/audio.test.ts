import { describe, expect, it } from 'vitest'

import { applyPcm16Gain, clampMicGain } from '../src/audio'

function frameFromInt16(samples: readonly number[], trailingByte?: number): Uint8Array {
  const frame = new Uint8Array(samples.length * 2 + (trailingByte === undefined ? 0 : 1))
  const view = new DataView(frame.buffer)
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true)
  })
  if (trailingByte !== undefined) frame[frame.length - 1] = trailingByte
  return frame
}

function int16FromFrame(frame: Uint8Array): number[] {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const sampleBytes = frame.byteLength - (frame.byteLength % 2)
  const samples: number[] = []
  for (let offset = 0; offset < sampleBytes; offset += 2) {
    samples.push(view.getInt16(offset, true))
  }
  return samples
}

describe('applyPcm16Gain', () => {
  it('applies gain to little-endian Int16 PCM samples', () => {
    const input = frameFromInt16([1000, -1000, 12345])
    const output = applyPcm16Gain(input, 2)

    expect(int16FromFrame(output)).toEqual([2000, -2000, 24690])
  })

  it('keeps the original frame object for unity gain', () => {
    const input = frameFromInt16([1000, -1000])
    const output = applyPcm16Gain(input, 1)

    expect(output).toBe(input)
    expect(int16FromFrame(output)).toEqual([1000, -1000])
  })

  it('clamps amplified samples to the Int16 range', () => {
    const input = frameFromInt16([20_000, -20_000, 16_384, -16_384])
    const output = applyPcm16Gain(input, 2)

    expect(int16FromFrame(output)).toEqual([32767, -32768, 32767, -32768])
  })

  it('preserves an odd trailing byte', () => {
    const input = frameFromInt16([1000], 0xab)
    const output = applyPcm16Gain(input, 2)

    expect(int16FromFrame(output)).toEqual([2000])
    expect(output[output.length - 1]).toBe(0xab)
  })

  it('clamps invalid gain settings to the supported range', () => {
    expect(clampMicGain(Number.NaN)).toBe(3)
    expect(clampMicGain(0.1)).toBe(0.5)
    expect(clampMicGain(20)).toBe(10)
  })
})
