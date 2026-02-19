/**
 * Exotel + STT + AI + ElevenLabs voice flow (Node.js + Fastify).
 *
 * - Incoming call: Exotel GETs /exotel/greeting → we return "Please say your message and hang up."
 * - Call ends: Exotel POSTs /exotel/webhook with recording_url → we process and optionally call back.
 * - Callback: Exotel GETs /exotel/playback with From= → we return audio to play.
 */
import Fastify from "fastify";
import formBody from "@fastify/formbody";
import fs from "fs";
import path from "path";
import {
  BASE_URL,
  EXOTEL_ACCOUNT_SID,
  EXOTEL_API_KEY,
  EXOTEL_API_TOKEN,
  EXOTEL_SUBDOMAIN,
  EXOTEL_CALLER_ID,
  EXOTEL_APP_ID,
  EXOTEL_CALLBACK_PLAY_RESPONSE,
  AUDIO_DIR,
} from "./config.js";
import { runPipeline, ensureGreetingWav } from "./pipeline.js";

const STORE_TTL_MS = 10 * 60 * 1000; // 10 min
const playbackStore = new Map(); // fromNumber -> { audioUrl, expiry }

const app = Fastify({ logger: true });

await app.register(formBody);

function exotelConnectApi(fromNumber, appId) {
  const url = `https://${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}@${EXOTEL_SUBDOMAIN}/v1/Accounts/${EXOTEL_ACCOUNT_SID}/Calls/connect`;
  const exomlUrl = `http://my.exotel.com/${EXOTEL_ACCOUNT_SID}/exoml/start_voice/${appId}`;
  const body = new URLSearchParams({
    From: fromNumber,
    CallerId: EXOTEL_CALLER_ID,
    Url: exomlUrl,
  });
  return fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }).then((r) => {
    if (!r.ok) throw new Error(`Exotel connect: ${r.status}`);
    return r.json();
  });
}

async function processRecordingAndCallback(recordingUrl, fromNumber) {
  try {
    const { transcript, audioId } = await runPipeline(recordingUrl);
    const audioUrl = `${BASE_URL}/audio/${audioId}.wav`;
    playbackStore.set(fromNumber, { audioUrl, expiry: Date.now() + STORE_TTL_MS });
    if (EXOTEL_CALLBACK_PLAY_RESPONSE && fromNumber && EXOTEL_APP_ID) {
      await exotelConnectApi(fromNumber, EXOTEL_APP_ID);
    }
  } catch (err) {
    app.log.error(err, "Pipeline/callback error");
  }
}

// Exotel dynamic URL: greeting for incoming call
app.get("/exotel/greeting", async (request, reply) => {
  if (request.method === "HEAD") {
    return reply.header("Content-Type", "application/json").send();
  }
  return reply
    .type("application/json")
    .send({
      start_call_playback: {
        playback_to: "caller",
        type: "text",
        value:
          "Please say your question or message after the beep. Hang up when you are done.",
      },
    });
});

// When we call the user back, Exotel GETs this; we return the generated audio URL
app.get("/exotel/playback", async (request, reply) => {
  if (request.method === "HEAD") {
    return reply.header("Content-Type", "application/json").send();
  }
  const now = Date.now();
  for (const [k, v] of playbackStore) {
    if (v.expiry < now) playbackStore.delete(k);
  }
  const from = request.query?.From;
  const entry = from ? playbackStore.get(from) : null;
  if (!entry) {
    return reply.type("application/json").send({
      start_call_playback: {
        playback_to: "caller",
        type: "text",
        value: "Sorry, your response is no longer available. Please call again.",
      },
    });
  }
  return reply.type("application/json").send({
    start_call_playback: {
      playback_to: "caller",
      type: "audio_url",
      value: entry.audioUrl,
    },
  });
});

/** Build TwiML/ExoML-style XML for conversation loop: Play audio then Record, POST back to action URL. */
function buildPlayRecordXml(playAudioUrl, recordActionUrl, maxLengthSec = 8, timeoutSec = 2) {
  const escapedPlay = playAudioUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const escapedAction = recordActionUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapedPlay}</Play>
  <Record action="${escapedAction}" maxLength="${maxLengthSec}" timeout="${timeoutSec}" />
</Response>`;
}

// Conversation loop: receive recording (or first hit), process, return XML with Play + Record to continue loop
app.post("/exotel/voice-loop", async (request, reply) => {
  const recordActionUrl = `${BASE_URL}/exotel/voice-loop`;
  try {
    const contentType = request.headers["content-type"] || "";
    let data = request.body;
    if (typeof data !== "object" || data === null) data = {};
    if (contentType.includes("application/json") && typeof request.body === "object") {
      data = request.body;
    }
    const recordingUrl = data.RecordingUrl ?? data.recording_url ?? data.RecordingSid ?? "";
    const callSid = data.CallSid ?? data.call_sid ?? "";
    const fromNumber = data.From ?? data.from ?? "";

    let playAudioUrl;
    if (recordingUrl && !["null", "none", ""].includes(String(recordingUrl).toLowerCase())) {
      app.log.info({ callSid, fromNumber }, "Voice loop: processing recording");
      const { audioId } = await runPipeline(recordingUrl);
      playAudioUrl = `${BASE_URL}/audio/${audioId}.wav`;
    } else {
      app.log.info({ callSid }, "Voice loop: first request, playing greeting");
      await ensureGreetingWav();
      playAudioUrl = `${BASE_URL}/audio/greeting.wav`;
    }
    const xml = buildPlayRecordXml(playAudioUrl, recordActionUrl, 8, 2);
    return reply.type("application/xml").send(xml);
  } catch (err) {
    app.log.error(err, "Voice loop error");
    const fallbackUrl = `${BASE_URL}/audio/greeting.wav`;
    const xml = buildPlayRecordXml(fallbackUrl, recordActionUrl, 8, 2);
    return reply.type("application/xml").send(xml);
  }
});

// Exotel call event callback (call end with recording_url)
app.post("/exotel/webhook", async (request, reply) => {
  try {
    const contentType = request.headers["content-type"] || "";
    let data = request.body;
    if (typeof data !== "object" || data === null) data = {};
    if (contentType.includes("application/json") && typeof request.body === "object") {
      data = request.body;
    }
    const callSid = data.CallSid ?? data.call_sid ?? "";
    const fromNumber = data.From ?? data.from ?? "";
    const recordingUrl = data.RecordingUrl ?? data.recording_url ?? "";
    app.log.info({ callSid, fromNumber, recordingUrl: recordingUrl?.slice(0, 80) }, "Webhook");
    if (!recordingUrl || ["null", "none", ""].includes(recordingUrl.toLowerCase())) {
      return reply.send({ ok: true, message: "No recording" });
    }
    processRecordingAndCallback(recordingUrl, fromNumber).catch(() => {});
    return reply.send({ ok: true, message: "Processing in background" });
  } catch (err) {
    app.log.error(err, "Webhook error");
    return reply.status(500).send({ ok: false, error: String(err.message) });
  }
});

// Serve generated WAV for Exotel
app.get("/audio/:audioId.wav", async (request, reply) => {
  const wavPath = path.join(AUDIO_DIR, `${request.params.audioId}.wav`);
  if (!fs.existsSync(wavPath)) return reply.status(404).send();
  return reply.type("audio/wav").send(fs.createReadStream(wavPath));
});

app.get("/health", async (_, reply) => reply.send({ status: "ok" }));

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });
console.log(`Server listening on http://${host}:${port}`);
