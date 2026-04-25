// Storage layer. Wraps the SDK's native bridge.setLocalStorage with
// browser-localStorage fallback for the dev preview. Same pattern as Glance.

import type { ModeId } from './modes'

interface BridgeStorageLike {
  getStorage: (key: string) => Promise<string>
  setStorage: (key: string, value: string) => Promise<boolean>
}

let bridge: BridgeStorageLike | null = null

export function setStorageBridge(b: BridgeStorageLike | null): void {
  bridge = b
}

async function readRaw(key: string): Promise<string | null> {
  try {
    if (bridge) {
      const v = await bridge.getStorage(key)
      return v || null
    }
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

async function writeRaw(key: string, value: string): Promise<void> {
  try {
    if (bridge) {
      await bridge.setStorage(key, value)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    /* swallow — settings will degrade to in-memory for the session */
  }
}

const KEY_AGREED = 'cue:privacy-agreed:v1'
const KEY_MODE = 'cue:mode:v1'
const KEY_CUSTOM_PROMPT = 'cue:custom-prompt:v1'
const KEY_WORKER_URL = 'cue:worker-url:v1'
const KEY_WORKER_TOKEN = 'cue:worker-token:v1'

export async function hasAgreedToPrivacy(): Promise<boolean> {
  const raw = await readRaw(KEY_AGREED)
  return raw === '1'
}

export async function setPrivacyAgreed(): Promise<void> {
  await writeRaw(KEY_AGREED, '1')
}

export async function getMode(): Promise<ModeId | null> {
  const raw = await readRaw(KEY_MODE)
  return (raw as ModeId) || null
}

export async function setMode(mode: ModeId): Promise<void> {
  await writeRaw(KEY_MODE, mode)
}

export async function getCustomPrompt(): Promise<string> {
  return (await readRaw(KEY_CUSTOM_PROMPT)) ?? ''
}

export async function setCustomPrompt(prompt: string): Promise<void> {
  await writeRaw(KEY_CUSTOM_PROMPT, prompt)
}

export async function getWorkerUrl(): Promise<string> {
  return (await readRaw(KEY_WORKER_URL)) ?? ''
}

export async function setWorkerUrl(url: string): Promise<void> {
  await writeRaw(KEY_WORKER_URL, url.trim())
}

export async function getWorkerToken(): Promise<string> {
  return (await readRaw(KEY_WORKER_TOKEN)) ?? ''
}

export async function setWorkerToken(token: string): Promise<void> {
  await writeRaw(KEY_WORKER_TOKEN, token.trim())
}
