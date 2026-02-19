# Exotel + AI + ElevenLabs Voice Flow

Node.js (Fastify). **Flow:** Caller speaks → Exotel sends recording → Server (STT → AI → TTS) → Exotel plays response.

## Quick start

```bash
# Create .env in this folder (see Environment below)
npm install
npm start
```

Server runs on **port 3000** (set `PORT` in `.env` if needed). You need **ffmpeg** installed for audio conversion.

---

## Environment

Create a `.env` file in this folder with:

| Variable | Description |
|----------|-------------|
| `BASE_URL` | Public URL of your server (e.g. `https://your-app.onrender.com`), no trailing slash |
| `EXOTEL_ACCOUNT_SID` | From Exotel dashboard → API settings |
| `EXOTEL_API_KEY` | From Exotel dashboard |
| `EXOTEL_API_TOKEN` | From Exotel dashboard |
| `EXOTEL_SUBDOMAIN` | e.g. `api.in.exotel.com` |
| `EXOTEL_CALLER_ID` | Your Exotel virtual number |
| `EXOTEL_APP_ID` | Applet ID of the playback applet (after you create it) |
| `OPENAI_API_KEY` | From OpenAI |
| `ELEVENLABS_API_KEY` | From ElevenLabs |
| `ELEVENLABS_VOICE_ID` | (Optional) Voice ID; default used if not set |
| `EXOTEL_CALLBACK_PLAY_RESPONSE` | (Optional) `true` or `false`; default `true` |

---

## Flow

1. **Caller speaks** – User calls your Exotel number.
2. **Exotel sends recording/webhook** – Applet plays greeting, records, then POSTs `recording_url` to your server when the call ends.
3. **Server: speech → text** – OpenAI Whisper.
4. **AI generates response** – OpenAI Chat (e.g. `gpt-4o-mini`).
5. **ElevenLabs: response → voice** – TTS; converted to 8kHz mono WAV for Exotel.
6. **Exotel plays response** – Server can call the user back and play the WAV via an Exotel applet.

---

## Exotel configuration

- **Incoming call:** Create an applet with **dynamic URL** = `https://<BASE_URL>/exotel/greeting`, enable **call recording**, and set the **call/status callback** URL to `https://<BASE_URL>/exotel/webhook`. Assign this applet to your Exotel number.
- **Callback (play response):** Create a second applet with **dynamic URL** = `https://<BASE_URL>/exotel/playback`. Put this applet’s **App ID** in `.env` as `EXOTEL_APP_ID`.

**Local dev:** Exotel must reach your server. Use **ngrok**, e.g. `ngrok http 3000`, and set `BASE_URL` in `.env` to the `https://...ngrok.io` URL (no trailing slash).

---

## Deploy to Render.com

The app includes a **Dockerfile** (Node + ffmpeg). Deploy as a **Web Service** on Render:

1. **Push your code** to GitHub (Dockerfile and app files at repo root).

2. **Create a Web Service** on [Render](https://render.com):
   - **New** → **Web Service** → connect your repo
   - **Root Directory:** leave **blank** (app is at repo root)
   - **Environment:** **Docker**
   - **Instance type:** Free or paid

3. **Environment variables** (Render dashboard → **Environment**):
   - `BASE_URL` = your Render URL, e.g. `https://exotel-voice-ai.onrender.com` (no trailing slash; set after first deploy, then redeploy)
   - `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`, `EXOTEL_CALLER_ID`, `EXOTEL_APP_ID`
   - `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` (optional: `ELEVENLABS_VOICE_ID`)

4. **Deploy.** Then set `BASE_URL` to your service URL and **Redeploy** so Exotel uses the correct URLs.

5. **Exotel:** Use that URL in applet URLs (e.g. `https://your-service.onrender.com/exotel/greeting`).

**Note:** Free tier may spin down after inactivity; first request after idle can be slow.

---

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|--------|
| `/exotel/greeting` | GET | Exotel dynamic URL for incoming call (greeting). |
| `/exotel/webhook` | POST | Exotel call end callback; runs pipeline and optionally calls user back. |
| `/exotel/playback` | GET | Exotel dynamic URL for callback call (play generated WAV). |
| `/audio/:id.wav` | GET | Serves 8kHz mono WAV files. |
| `/health` | GET | Health check. |
