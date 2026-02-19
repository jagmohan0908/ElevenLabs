# Real-Time AI Voice Call Agent (Twilio)

Node.js (Fastify + WebSocket). **Flow:** Caller dials Twilio number → Media Streams → streaming STT (Deepgram) → AI (OpenAI) → TTS (ElevenLabs) → audio streamed back to caller. Real-time conversation with context memory.

## Quick start

```bash
# Create .env (see Environment below)
npm install
npm start
```

Server runs on **port 3000**. You need **ffmpeg** installed for audio conversion (TTS → 8 kHz mulaw for Twilio).

---

## End-to-end call flow (Twilio)

1. **Caller dials** your Twilio phone number.
2. **Twilio answers** and requests your **Voice webhook** (GET/POST).
3. **Server returns TwiML** with `<Start><Stream url="wss://..."/></Start>`, `<Say>` greeting, and `<Pause>`.
4. **Twilio opens WebSocket** to your server at `/twilio-stream`.
5. **Twilio streams** caller audio (base64 mulaw 8 kHz) to the server.
6. **Server** decodes audio → **Deepgram** (streaming STT) → transcript.
7. **Server** sends transcript to **OpenAI** → AI reply (with conversation history).
8. **Server** sends reply to **ElevenLabs** → TTS → convert to mulaw 8 kHz → stream base64 **media** events back to Twilio.
9. **Caller hears** the AI response in real time. Loop continues until hangup.

---

## Architecture

```
Caller → Twilio Voice → Media Streams (WebSocket) → Backend (Node.js)
                                                          ↓
                                              Speech-to-Text (Deepgram, streaming)
                                                          ↓
                                              AI (OpenAI GPT, context memory)
                                                          ↓
                                              Text-to-Speech (ElevenLabs)
                                                          ↓
                                              Audio stream (mulaw 8 kHz) → Twilio → Caller
```

---

## Environment

Create a `.env` file:

| Variable | Description |
|----------|-------------|
| `BASE_URL` | Public HTTPS URL of your server (e.g. `https://your-app.onrender.com`), no trailing slash |
| `BASE_WS_URL` | (Optional) Public WSS URL for Media Streams; defaults to `BASE_URL` with `https`→`wss` |
| `PORT` | Server port (default `3000`) |
| `OPENAI_API_KEY` | OpenAI API key (GPT + optional Whisper) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | (Optional) ElevenLabs voice ID |
| `DEEPGRAM_API_KEY` | **Required for Twilio flow.** Deepgram API key for streaming STT (mulaw 8 kHz, Hindi + English) |
| `TWILIO_ACCOUNT_SID` | (For "Call me") From Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | (For "Call me") From Twilio Console → Account Info |
| `TWILIO_PHONE_NUMBER` | (For "Call me") Your Twilio number in E.164 (e.g. `+1234567890`) |

**Exotel (optional, legacy):** `EXOTEL_*` variables only if you still use Exotel endpoints.

---

## Twilio configuration

1. **Twilio account** – [twilio.com](https://www.twilio.com); get a phone number with **Voice** enabled.
2. **Public server** – Your app must be reachable over **HTTPS** and **WSS** (same host; WSS typically same port or proxy).
3. **Voice webhook** – In Twilio Console → Phone Numbers → your number → **Voice & Fax**:
   - **A CALL COMES IN:** Webhook, `https://<BASE_URL>/twilio/voice`, HTTP GET (or POST).
4. **Media Streams** – No extra toggle; using `<Stream>` in TwiML enables streaming.

### Best testing: Twilio calls you (no international charges, works on trial)

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` in `.env` (and on Render).
2. Open **https://&lt;BASE_URL&gt;/twilio/call-me** in a browser.
3. Enter your phone number (E.164, e.g. `+919876543210`) and click **Call me now**.
4. Twilio calls you; when you answer, you hear the greeting and the same AI voice flow runs.

You can also trigger a call with a direct link:  
`https://&lt;BASE_URL&gt;/twilio/call-me?to=+919876543210`

**Local dev:** Use **ngrok** (or similar) so Twilio can reach your machine:

```bash
ngrok http 3000
```

Set in `.env`:

- `BASE_URL=https://xxxx.ngrok.io`
- `BASE_WS_URL=wss://xxxx.ngrok.io` (ngrok exposes WSS on the same URL)

---

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|--------|
| `/twilio/voice` | GET / POST | Twilio Voice webhook; returns TwiML with `<Stream>` + greeting. |
| `/twilio/call-me` | GET | "Call me" test: no query = form to enter number; `?to=+123...` = start outbound call. |
| `/twilio-stream` | WebSocket | Twilio Media Streams; receives/sends audio; runs STT → AI → TTS. |
| `/health` | GET | Health check. |
| `/exotel/*` | various | Optional Exotel flow (greeting, webhook, voice-loop, playback). |
| `/audio/:id.wav` | GET | Serves 8 kHz WAV (Exotel/voice-loop). |

---

## Technical notes

- **Streaming STT:** Deepgram live API with `encoding=mulaw`, `sample_rate=8000`, `language=en`, model `base`.
- **Context:** Each call keeps an in-memory conversation (user + assistant messages) for the duration of the WebSocket.
- **Latency:** Aim for &lt; 1.5 s per response; streaming STT and turbo TTS help.
- **Audio out:** ElevenLabs returns MP3; server converts to 8 kHz mono mulaw via ffmpeg and sends 20 ms chunks to Twilio.

---

## Deploy (e.g. Render)

1. Push code to GitHub (Dockerfile at repo root).
2. Create a **Web Service** on [Render](https://render.com), Docker, connect repo.
3. Set **Environment**: `BASE_URL` = your Render URL (e.g. `https://twilio-voice-ai.onrender.com`), `BASE_WS_URL` = `wss://twilio-voice-ai.onrender.com`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, optional `ELEVENLABS_VOICE_ID`.
4. Deploy. Set Twilio Voice URL to `https://<your-service>.onrender.com/twilio/voice`.

**Note:** Free tier may spin down; first request after idle can be slow.

**ElevenLabs 401 "Unusual activity" / "Free Tier usage disabled":** When the app runs from a cloud host (e.g. Render), ElevenLabs may block free-tier API use from datacenter IPs. To fix: use an ElevenLabs **paid plan**, or run the app from a residential network (e.g. local + ngrok) for testing.
