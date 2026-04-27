// Round-trip tests for the new v0.4.0 storage helpers (debug-overlay
// toggle + wearer-speaker assignment).
//
// jsdom for window.localStorage — storage.ts falls back to that when
// no bridge is set, and the default node test environment has no window.

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WEARER_SPEAKER_ID,
  getShowDebugOverlay,
  getWearerSpeakerId,
  setShowDebugOverlay,
  setStorageBridge,
  setWearerSpeakerId,
} from '../src/storage'

beforeEach(() => {
  // Stub localStorage with an in-memory map for the round-trip path
  // when no bridge is set.
  const store: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length },
  } as Storage
  setStorageBridge(null)
})

afterEach(() => {
  setStorageBridge(null)
})

describe('show-debug-overlay round-trip', () => {
  it('defaults to false when unset', async () => {
    expect(await getShowDebugOverlay()).toBe(false)
  })

  it('persists true', async () => {
    await setShowDebugOverlay(true)
    expect(await getShowDebugOverlay()).toBe(true)
  })

  it('persists false (explicit off)', async () => {
    await setShowDebugOverlay(true)
    await setShowDebugOverlay(false)
    expect(await getShowDebugOverlay()).toBe(false)
  })
})

describe('wearer-speaker-id round-trip', () => {
  it('defaults to -1 (no filter / auto)', async () => {
    expect(await getWearerSpeakerId()).toBe(DEFAULT_WEARER_SPEAKER_ID)
    expect(DEFAULT_WEARER_SPEAKER_ID).toBe(-1)
  })

  it('persists 0 (Speaker A is me)', async () => {
    await setWearerSpeakerId(0)
    expect(await getWearerSpeakerId()).toBe(0)
  })

  it('persists 1 (Speaker B is me)', async () => {
    await setWearerSpeakerId(1)
    expect(await getWearerSpeakerId()).toBe(1)
  })

  it('back to -1 returns to no-filter', async () => {
    await setWearerSpeakerId(2)
    await setWearerSpeakerId(-1)
    expect(await getWearerSpeakerId()).toBe(-1)
  })

  it('floors fractional input', async () => {
    await setWearerSpeakerId(2.7)
    expect(await getWearerSpeakerId()).toBe(2)
  })
})
