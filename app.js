/**
 * Real-time AI voice call agent (Twilio Media Streams) + optional Exotel flow.
 *
 * Twilio: Incoming call → GET/POST /twilio/voice → TwiML with Stream → WSS /twilio-stream → STT → AI → TTS → caller.
 */
import Fastify from "fastify";
import formBody from "@fastify/formbody";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import {
  BASE_URL,
  BASE_WS_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
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
import { handleTwilioStream } from "./twilioStream.js";

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

const VOICE_LOOP_URL = `${BASE_URL}/exotel/voice-loop`;

async function handleVoiceLoopRequest(recordingUrl, callSid, fromNumber) {
  const recordActionUrl = VOICE_LOOP_URL;
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
  return buildPlayRecordXml(playAudioUrl, recordActionUrl, 8, 2);
}

// Conversation loop: GET = initial instructions (Play greeting + Record). POST = after recording (process, then Play AI + Record).
app.get("/exotel/voice-loop", async (request, reply) => {
  try {
    const xml = await handleVoiceLoopRequest("", request.query?.CallSid ?? "", request.query?.From ?? "");
    return reply.type("application/xml").send(xml);
  } catch (err) {
    app.log.error(err, "Voice loop GET error");
    const xml = buildPlayRecordXml(`${BASE_URL}/audio/greeting.wav`, VOICE_LOOP_URL, 8, 2);
    return reply.type("application/xml").send(xml);
  }
});

app.post("/exotel/voice-loop", async (request, reply) => {
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
    const xml = await handleVoiceLoopRequest(recordingUrl, callSid, fromNumber);
    return reply.type("application/xml").send(xml);
  } catch (err) {
    app.log.error(err, "Voice loop POST error");
    const xml = buildPlayRecordXml(`${BASE_URL}/audio/greeting.wav`, VOICE_LOOP_URL, 8, 2);
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

// ----- Twilio: voice webhook (return TwiML with Media Stream) -----
const TWILIO_STREAM_PATH = "/twilio-stream";
const streamUrl = `${BASE_WS_URL.replace(/\/$/, "")}${TWILIO_STREAM_PATH}`;

// Use <Connect><Stream> for BIDIRECTIONAL stream so we can send reply audio to the caller.
// <Start><Stream> is unidirectional (receive only) – reply audio would never play.
function twilioVoiceTwiML() {
  const streamUrlEscaped = streamUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrlEscaped}" />
  </Connect>
</Response>`;
}

app.get("/twilio/voice", async (_, reply) => {
  return reply.type("application/xml").send(twilioVoiceTwiML());
});
app.post("/twilio/voice", async (_, reply) => {
  return reply.type("application/xml").send(twilioVoiceTwiML());
});

// ----- Twilio: "Call me" (outbound call for testing – no international charges) -----
const VOICE_WEBHOOK_URL = `${BASE_URL}/twilio/voice`;
const CALL_ME_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Call me – AI voice</title></head>
<body style="font-family:sans-serif;max-width:360px;margin:2rem auto;padding:1rem;">
  <h2>Call me</h2>
  <p>Enter your phone number (E.164, e.g. +919876543210). Twilio will call you and connect you to the AI.</p>
  <form action="/twilio/call-me" method="get">
    <input type="tel" name="to" placeholder="+919876543210" required style="width:100%;padding:8px;box-sizing:border-box;margin-bottom:8px;">
    <button type="submit" style="padding:8px 16px;">Call me now</button>
  </form>
  <p style="color:#666;font-size:0.9rem;">Uses your Twilio number; works on trial.</p>
</body>
</html>`;

async function twilioOutboundCall(to) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({
    To: to,
    From: TWILIO_PHONE_NUMBER,
    Url: VOICE_WEBHOOK_URL,
  });
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio API: ${res.status} ${err}`);
  }
  return res.json();
}

app.get("/twilio/call-me", async (request, reply) => {
  const to = (request.query?.to || "").trim();
  if (!to) {
    return reply.type("text/html").send(CALL_ME_HTML);
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    return reply.status(500).send({
      error: "Call-me not configured",
      message: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env",
    });
  }
  try {
    const call = await twilioOutboundCall(to);
    return reply.send({
      ok: true,
      message: "Calling you now. Answer the phone!",
      callSid: call.sid,
    });
  } catch (err) {
    app.log.error({ err }, "Twilio call-me error");
    return reply.status(500).send({
      ok: false,
      error: err.message || "Failed to start call",
    });
  }
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });
const server = app.server;

const wss = new WebSocketServer({ server, path: TWILIO_STREAM_PATH });
wss.on("connection", (ws) => {
  app.log.info("Twilio Media Stream WebSocket connected");
  handleTwilioStream(ws, app.log);
});

console.log(`Server listening on http://${host}:${port}`);
console.log(`Twilio stream: ${streamUrl}`);
