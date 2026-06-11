export const DEFAULT_MIC_GAIN = 3
export const MIN_MIC_GAIN = 0.5
export const MAX_MIC_GAIN = 10
export const UNITY_MIC_GAIN = 1

export function clampMicGain(gain: number): number {
  if (!Number.isFinite(gain)) return DEFAULT_MIC_GAIN
  return Math.min(MAX_MIC_GAIN, Math.max(MIN_MIC_GAIN, gain))
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767
  if (value < -32768) return -32768
  return value
}

export function applyPcm16Gain(frame: Uint8Array, gain: number): Uint8Array {
  const safeGain = clampMicGain(gain)
  if (safeGain === UNITY_MIC_GAIN) return frame

  const out = new Uint8Array(frame.byteLength)
  out.set(frame)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const sampleBytes = out.byteLength - (out.byteLength % 2)

  for (let offset = 0; offset < sampleBytes; offset += 2) {
    const sample = view.getInt16(offset, true)
    view.setInt16(offset, clampInt16(Math.round(sample * safeGain)), true)
  }

  return out
}
