# Cue personal Cloudflare Worker

Deploy this once. Cue connects to it for real STT (Deepgram) and LLM
suggestions (Claude Haiku via Anthropic, or 4o-mini via OpenAI). All
keys live as Worker secrets — Cue never sees them.

## Prereqs

- Cloudflare account (free) — https://dash.cloudflare.com
- `wrangler` CLI: `npm install -g wrangler`
- Deepgram API key — https://console.deepgram.com (free $200 credit)
- Anthropic API key OR OpenAI API key for the LLM step

## Deploy

```bash
cd worker-template
npm install
wrangler login                               # one-time

# Random 32+ char string. Use this same value in Cue's phone settings as Bearer token.
wrangler secret put SHARED_SECRET

wrangler secret put DEEPGRAM_API_KEY
wrangler secret put ANTHROPIC_API_KEY        # OR set OPENAI_API_KEY instead

wrangler deploy
```

Wrangler prints a URL like `https://cue-worker.<your-sub>.workers.dev`.

## Wire it to Cue

In the Cue phone-side settings (under "Worker"):
1. Paste the Worker URL
2. Paste the SHARED_SECRET as Bearer token
3. Save

That's it. Open Cue on glasses, accept privacy, tap to start mic. The
plugin will:
1. Open a WebSocket to `<worker>/ws?token=<bearer>` and stream PCM frames
2. Receive interim transcripts back as `{type:'transcript', text:'...', isFinal:bool}` JSON frames
3. POST `<worker>/suggest` with `{mode, transcript, customPrompt?}` to get LLM suggestions

If the Worker is unconfigured / unreachable, Cue falls back to the
mock-mode suggestions from v0.1.0 so the app stays usable.

## Costs

- **Cloudflare Workers**: free tier (100k requests/day) covers any single user comfortably. WebSocket connections count as one request each.
- **Deepgram**: ~$0.0043/min via the Nova-2 model. $200 free credit lasts a single user months.
- **Anthropic Claude Haiku**: ~$0.001 per suggestion call. Heavy use ~$1-2/day.
- **OpenAI 4o-mini**: ~$0.0008 per call. Slightly cheaper but slower than Haiku.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/ws?token=<bearer>` | query token | WebSocket for streaming PCM → transcripts |
| POST | `/suggest` | `Authorization: Bearer <bearer>` | LLM suggestion request given a transcript |
| GET | `/healthz` | none | Sanity check |

## Audio format

Cue sends raw 16kHz mono 16-bit signed PCM little-endian. The Deepgram
URL the Worker opens hardcodes those parameters — change the
`DEEPGRAM_WS` URL in `index.ts` if you need a different rate.

## Limitations

- **iOS WKWebView** has no native WebSocket-binary-frames support in some plugin contexts. If audio doesn't reach the Worker, check the plugin console for "WebSocket failed" and verify the WS endpoint is reachable.
- **Deepgram free tier**: rate-limited at ~5 concurrent streams per account. Single user fine; not suited for many simultaneous users on one Worker.
- **No persistence**: transcripts live only in the open WebSocket connection. Once the user pauses the mic, the transcript is gone. Intentional for privacy.
