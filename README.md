# Cue

> **Helps you say the right thing.**

A multi-mode conversation coach for Even Realities G2 smart glasses. Listens to the conversation, surfaces 2-3 suggested responses on the display in real time. Pick a mode (Date / Argue calm / Sales close / Sting / Listen well / Custom) to shape the suggestions. The app never speaks for you — it offers cues you say in your own voice.

## Status: v0.1.0 (mock-mode demo, sideload-able)

This release scaffolds the full UX with **fake suggestions on a timer** so you can try the flow on real glasses without setting up any cloud services. Real Deepgram STT + LLM integration lands in v0.2.0+ via a personal Cloudflare Worker (same pattern Glance uses).

| Version | What's in it |
|---|---|
| **v0.1.0** *(current)* | Scaffold, mode picker, privacy opt-in, mic toggle, glasses UI, mock suggestion driver |
| v0.2.0 *(planned)* | Real audio capture via `audioControl`, streamed to your Worker, transcribed by Deepgram. Captions visible on glasses. |
| v0.3.0 *(planned)* | LLM suggestions per mode via Worker. The product, fully working. |
| v0.4.0 *(planned)* | Mode cycle gesture, ring-tap-for-topics polish, edge cases. |

## How it works (current v0.1.0)

1. Open Cue from the Even Hub launcher on your phone.
2. **Privacy notice** appears on first launch — read and accept (or decline) before the mic can be enabled.
3. Pick a mode in the phone-side settings page.
4. Put on the glasses, open Cue.
5. Tap glasses to start the (mock) session — suggestions appear on a timer.
6. Glasses double-tap when not micced = cycle mode. Ring double-tap during a session = "fresh topics" prompt (date mode).
7. Glasses double-tap during a session = exit (also stops mic).

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
| `src/even.ts` | Glasses bridge wrapper (text container, input routing) |
| `src/modes.ts` | Mode registry — id, label, glyph, system prompt, behavior flags |
| `src/mock.ts` | v0.1.0 timer-driven canned suggestions for each mode |
| `src/storage.ts` | Native `setLocalStorage` wrapper for mode + privacy + Worker config |
| `tests/*.test.ts` | Vitest unit tests (10 passing) |

## Roadmap

Full plan in `~/Documents/PhilsHome/ROADMAP.md` § "Plan: Cue". Highlights for v0.2+:
- `audioControl(true)` capture + 250ms PCM chunks → Worker WebSocket
- Deepgram streaming STT in Worker
- Anthropic Claude Haiku for suggestions (per-mode system prompts)
- "Custom" mode pulls user's prompt from storage
- Battery measurement + auto-pause after N min idle
