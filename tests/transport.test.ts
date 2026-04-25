// Unit tests for the transport layer's HTTP path. We mock fetch globally so
// these tests don't make real network calls — the goal is to verify the
// request shape and response handling, not to exercise a real Worker.
//
// The WebSocket path can't be tested cleanly here without a full WS mock
// (and in practice the audio pipeline only has value when run end-to-end
// against real glasses + a real deployed Worker — covered manually).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../src/transport'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe('createTransport', () => {
  it('reports not-ready when URL or token missing', () => {
    expect(createTransport('', '').ready).toBe(false)
    expect(createTransport('https://x.workers.dev', '').ready).toBe(false)
    expect(createTransport('', 'bearer').ready).toBe(false)
  })

  it('reports ready when both are set', () => {
    expect(createTransport('https://x.workers.dev', 'bearer').ready).toBe(true)
  })

  it('requestSuggestions returns error when not ready', async () => {
    const t = createTransport('', '')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not configured/)
  })

  it('requestSuggestions sends POST with bearer + JSON body', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      // Capture for assertions and return a canned ok response.
      return new Response(
        JSON.stringify({ ok: true, suggestions: ['First', 'Second', 'Third'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({
      mode: 'date',
      transcript: 'How was your day?',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.suggestions).toEqual(['First', 'Second', 'Third'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://cue.example.workers.dev/suggest')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({ mode: 'date', transcript: 'How was your day?', customPrompt: undefined })
  })

  it('requestSuggestions surfaces non-ok HTTP as error result', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/429/)
  })

  it('requestSuggestions surfaces network failure as error result', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Failed to fetch/)
  })

  it('passes customPrompt when provided', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['x'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestions({
      mode: 'custom',
      transcript: 'foo',
      customPrompt: 'You are a butler...',
    })
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.customPrompt).toBe('You are a butler...')
  })
})
