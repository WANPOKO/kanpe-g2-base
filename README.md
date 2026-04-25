# Cue

> **Helps you say the right thing.**

A multi-mode conversation coach for Even Realities G2 smart glasses. Listens to the conversation, surfaces 2-3 suggested responses on the display in real time. Pick a mode (Date / Argue calm / Sales close / Sting / Listen well / Custom) to shape the suggestions. The app never speaks for you — it offers cues you say in your own voice.

## Status: v0.2.0 (real STT + LLM via your Cloudflare Worker; mock fallback retained)

If you've deployed the personal Worker (see `worker-template/README.md`) and pasted its URL + bearer token in phone settings, Cue streams audio over WebSocket → Deepgram for live transcription, and POSTs your rolling transcript to the Worker's `/suggest` endpoint for Claude Haiku LLM suggestions. If those settings are blank or the Worker is unreachable, Cue falls back to the v0.1.0 timer-driven mock suggestions so the app stays demonstrable.

| Version | What's in it |
|---|---|
| v0.1.0 | Scaffold, mode picker, privacy opt-in, mic toggle, glasses UI, mock suggestion driver |
| **v0.2.0** *(current)* | Worker template (Deepgram WS proxy + `/suggest` Anthropic/OpenAI bridge), real audio capture via `audioControl`, transport layer, live captions, debounced LLM suggestions. Mock fallback preserved. |
| v0.3.0 *(planned)* | Suggestion quality polish, retry/backoff, transcript trimming heuristics, end-of-utterance detection. |
| v0.4.0 *(planned)* | Battery indicator, auto-pause, mode-specific UI tweaks, edge cases. |

## How it works (current v0.2.0)

1. **One-time** — deploy the personal Cloudflare Worker (see [`worker-template/README.md`](worker-template/README.md)). You get a `https://<sub>.workers.dev` URL and a `SHARED_SECRET` bearer.
2. **Wire it to Cue** — paste both into phone-side settings. (Skip this step and Cue runs in mock mode.)
3. Open Cue from the Even Hub launcher.
4. **Privacy notice** appears on first launch — read and accept (or decline) before the mic can be enabled.
5. Pick a mode in the phone-side settings page.
6. Put on the glasses, open Cue. The idle screen shows `◉ live` if a Worker is configured, `◌ mock` otherwise.
7. Tap glasses to start a session. With a Worker, audio streams to Deepgram and you'll see live transcript captions on glasses; suggestions arrive ~6s after each transcript update. Without a Worker, the timer-driven mock fires.
8. Glasses double-tap when not micced = cycle mode. Ring double-tap during a session = "fresh topics" prompt (date / custom modes).
9. Glasses double-tap during a session = exit (also stops mic).

## Privacy is a real feature, not boilerplate

- **Mic OFF by default** every session. No exceptions.
- **Explicit opt-in** required on first launch via a modal.
- **Mic indicator always visible** when listening — never hidden.
- **No persistence** of audio — when real STT lands in v0.2, audio streams through and is dropped. Transcripts buffered ≤3 min in Worker memory.
- **No analytics** that include conversation content.
- **You are responsible** for ensuring it's legal where you are. Recording someone without their knowledge violates two-party-consent laws in CA, FL, IL, MD, MA, MT, NH, PA, WA, and many countries.

## Modes

| Glyph | Mode | Use it for |
|---|---|---|
| ★ | **Date** | Curious, warm. Suggests questions and follow-ups. Ring-tap for fresh topics when stuck. |
| ◇ | **Argue calm** | Validating, deescalating. For tense conversations. |
| ▶ | **Sales close** | Listens for objections, suggests handlers. |
| ⚡ | **Sting** | Sharp witty comebacks. Banter mode. |
| ● | **Listen well** | Reflective listening prompts ("what I hear is…", "tell me more"). |
| ◆ | **Custom** | Use your own system prompt (write it in phone settings). |

## Glasses gestures

| Gesture | Action |
|---|---|
| Single tap (mic off) | Start mic session |
| Single tap (mic on) | Stop mic session |
| Double tap (mic off) | Cycle to next mode |
| Ring double tap (mic on) | Request fresh topics (proactive — date / custom modes) |
| Glasses double tap (mic on) | Exit app (also stops mic) |

## Development

```bash
npm install
npm run dev          # Vite dev server on :5176
npm run build        # tsc + vite build
npm run pack         # evenhub pack → cue.ehpk
npm run deploy       # build + pack
npm test             # Vitest unit tests
npm run test:watch   # Vitest watch mode
```

Test on real glasses via QR:
```bash
npx evenhub qr --url http://<your-mac-lan-ip>:5176
```

Test in simulator:
```bash
npx evenhub-simulator --glow http://localhost:5176
```

## Source files

| File | Purpose |
|---|---|
| `src/main.ts` | Entry, state machine, phone settings UI, glasses render |
| `src/even.ts` | Glasses bridge wrapper (text container, input routing, mic capture) |
| `src/transport.ts` | Worker transport — WebSocket for audio + REST for suggestions |
| `src/modes.ts` | Mode registry — id, label, glyph, system prompt, behavior flags |
| `src/mock.ts` | Mock-mode timer-driven canned suggestions (fallback when Worker unset) |
| `src/storage.ts` | Native `setLocalStorage` wrapper for mode + privacy + Worker config |
| `worker-template/` | Cloudflare Worker source — Deepgram WS proxy + `/suggest` LLM bridge |
| `tests/*.test.ts` | Vitest unit tests (17 passing) |
| `scripts/regression.mjs` | Simulator-driven e2e flow check (mock-fallback path, 4/4) |

## Roadmap

Full plan in `~/Documents/PhilsHome/ROADMAP.md` § "Plan: Cue". Remaining for v0.3+:
- Suggestion debounce/backoff tuning, end-of-utterance detection so suggestions arrive when there's a natural pause rather than on a fixed timer
- Trim long transcripts more intelligently (currently last 1200 chars rolling window)
- Battery measurement + auto-pause after N min idle
- Per-mode glance-friendly UI tweaks (line wrap, font emphasis on imperative verbs)

## Packaging note

The Worker URL is per-user (each deployer gets their own `*.workers.dev` subdomain). Before running `npm run pack`, replace `https://your-cue-worker.example.workers.dev` in `app.json`'s `permissions[].whitelist` with your own Worker URL — otherwise the WebView in the packaged build will block the request.
