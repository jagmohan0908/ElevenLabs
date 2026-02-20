/**
 * Twilio Media Streams WebSocket handler.
 * Flow: Twilio sends base64 mulaw → Deepgram STT → OpenAI → ElevenLabs TTS → mulaw → Twilio.
 */
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import {
  DEEPGRAM_API_KEY,
  TWILIO_MULAW_BYTES_PER_CHUNK,
} from "./config.js";
import { nehaResponseWithHistory, textToSpeech, mp3ToMulaw8k } from "./pipeline.js";

const DEEPGRAM_KEEP_ALIVE_MS = 4000;

const FILLER_PHRASES = new Set([
  "sir", "ji", "जी", "है", "तो", "ok", "ठीक", "उम", "ओके", "um", "uh", "thank you", "thanks",
  "हाँ", "हां", "ना", "no", "yes", "the", "this", "that", "इसके बारे में", "बारे में",
  "सर", "सिर", "जी जी", "ji ji", "sir sir", "ok ok", "ठीक है", "theek hai", "मुझे मुझे है", "मुझे है",
  "right", "so", "it", "i", "a", "the",
]);
const MIN_REAL_LENGTH = 12;

function isFillerOnly(text) {
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (t.length < MIN_REAL_LENGTH) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1 && FILLER_PHRASES.has(t)) return true;
  const allFiller = words.every((w) => FILLER_PHRASES.has(w) || FILLER_PHRASES.has(w.replace(/[।?!.]/g, "")));
  if (allFiller && words.length <= 4) return true;
  return false;
}

function isRepetitiveNoise(text) {
  const words = text.replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const count = {};
  for (const w of words) {
    const k = w.toLowerCase().replace(/[।?!.]/g, "");
    count[k] = (count[k] || 0) + 1;
  }
  const max = Math.max(...Object.values(count));
  const repeatedWord = Object.entries(count).find(([, n]) => n === max)?.[0];
  if (max >= 3 && max / words.length >= 0.6) {
    if (FILLER_PHRASES.has(repeatedWord) || repeatedWord?.length <= 3) return true;
  }
  return false;
}

function shouldIgnoreTranscript(text) {
  if (!text || text.trim().length < MIN_REAL_LENGTH) return true;
  if (isFillerOnly(text)) return true;
  if (isRepetitiveNoise(text)) return true;
  return false;
}

/**
 * Handle one Twilio Media Streams WebSocket connection.
 * @param {import("ws").WebSocket} twilioWs - Twilio's WebSocket
 * @param {object} log - Logger (e.g. app.log)
 */
export function handleTwilioStream(twilioWs, log = console) {
  let streamSid = null;
  let deepgramLive = null;
  let keepAliveInterval = null;
  const messages = [];
  let isPlaying = false;
  let pendingTranscript = "";
  let ignoreTranscriptsUntil = 0;

  function sendToTwilio(obj) {
    if (twilioWs.readyState !== 1) return;
    twilioWs.send(JSON.stringify(obj));
  }

  /** Send audio to Twilio (must include streamSid for playback). */
  function sendMediaToTwilio(payloadBase64) {
    if (!streamSid) return;
    sendToTwilio({ event: "media", streamSid, media: { payload: payloadBase64 } });
  }

  function cleanup() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (deepgramLive) {
      try {
        deepgramLive.requestClose?.();
      } catch (_) {}
      deepgramLive = null;
    }
  }

  twilioWs.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const event = msg.event;

      if (event === "start") {
        streamSid = msg.start?.streamSid ?? null;
        log.info({ streamSid }, "Twilio stream started");

        if (!DEEPGRAM_API_KEY) {
          log.error("DEEPGRAM_API_KEY not set");
          sendToTwilio({ event: "error", message: "Server missing STT config" });
          return;
        }

        // Stream greeting as Neha from Siya Ayurveda
        const GREETING_TEXT = "Hello, mai Siya Ayurveda se Neha baat kar rahi hoon. Mai aapki kaisi sahayata kar sakti hoon?";
        (async () => {
          try {
            const mp3Buffer = await textToSpeech(GREETING_TEXT);
            const mulawBuffer = await mp3ToMulaw8k(mp3Buffer);
            for (let i = 0; i < mulawBuffer.length; i += TWILIO_MULAW_BYTES_PER_CHUNK) {
              const chunk = mulawBuffer.subarray(i, i + TWILIO_MULAW_BYTES_PER_CHUNK);
              if (chunk.length === 0) break;
              const payload = chunk.length < TWILIO_MULAW_BYTES_PER_CHUNK
                ? Buffer.concat([chunk, Buffer.alloc(TWILIO_MULAW_BYTES_PER_CHUNK - chunk.length, 0xff)])
                : chunk;
              sendMediaToTwilio(payload.toString("base64"));
            }
          } catch (e) {
            log.warn({ e }, "Greeting TTS failed");
          }
        })();

        const deepgram = createClient(DEEPGRAM_API_KEY);
        deepgramLive = deepgram.listen.live({
          model: "base",
          encoding: "mulaw",
          sample_rate: 8000,
          language: "hi",
          punctuate: true,
          interim_results: true,
          utterance_end_ms: 2200,
        });

        deepgramLive.on(LiveTranscriptionEvents.Open, () => {
          log.info("Deepgram live connected");
          keepAliveInterval = setInterval(() => {
            try {
              if (deepgramLive?.getReadyState?.() === 1) deepgramLive.keepAlive?.();
            } catch (_) {}
          }, DEEPGRAM_KEEP_ALIVE_MS);
        });

        deepgramLive.on(LiveTranscriptionEvents.Close, () => {
          log.info("Deepgram live closed");
          cleanup();
        });

        deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
          log.error({ err }, "Deepgram error");
          cleanup();
        });

        deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
          try {
            const transcript =
              data?.channel?.alternatives?.[0]?.transcript
              ?? data?.results?.channels?.[0]?.alternatives?.[0]?.transcript
              ?? data?.alternatives?.[0]?.transcript
              ?? "";
            const isFinal = data?.is_final === true;
            if (!transcript || !String(transcript).trim()) return;
            if (isFinal) {
              pendingTranscript = (pendingTranscript + " " + transcript).trim();
            } else {
              pendingTranscript = (pendingTranscript + " " + transcript).trim();
            }
          } catch (e) {
            log.error({ e }, "Transcript handler error");
          }
        });

        deepgramLive.on(LiveTranscriptionEvents.UtteranceEnd, () => {
          if (Date.now() < ignoreTranscriptsUntil) {
            pendingTranscript = "";
            return;
          }
          const userText = pendingTranscript.trim();
          pendingTranscript = "";
          if (shouldIgnoreTranscript(userText)) return;
          processTranscript(userText).catch((err) => log.error({ err }, "processTranscript error"));
        });

        deepgramLive.on(LiveTranscriptionEvents.Metadata, () => {});
        return;
      }

      if (event === "media" && msg.media?.payload && deepgramLive) {
        if (isPlaying) return;
        const payload = Buffer.from(msg.media.payload, "base64");
        try {
          if (typeof deepgramLive.send === "function") {
            deepgramLive.send(payload);
          }
        } catch (e) {
          log.warn({ e }, "Deepgram send error");
        }
        return;
      }

      if (event === "stop") {
        log.info({ streamSid }, "Twilio stream stopped");
        cleanup();
      }
    } catch (err) {
      log.error({ err }, "Twilio stream message error");
    }
  });

  async function processTranscript(userText) {
    if (isPlaying) return;
    if (!userText || !userText.trim()) return;

    isPlaying = true;
    messages.push({ role: "user", content: userText });
    log.info({ userText: userText.slice(0, 100) }, "User said");

    try {
      const reply = await nehaResponseWithHistory(messages);
      messages.push({ role: "assistant", content: reply });
      log.info({ reply: reply.slice(0, 100) }, "AI reply");

      const mp3Buffer = await textToSpeech(reply);
      const mulawBuffer = await mp3ToMulaw8k(mp3Buffer);
      if (!mulawBuffer?.length) {
        log.warn("TTS produced no audio, using fallback");
        throw new Error("Empty TTS output");
      }

      for (let i = 0; i < mulawBuffer.length; i += TWILIO_MULAW_BYTES_PER_CHUNK) {
        const chunk = mulawBuffer.subarray(i, i + TWILIO_MULAW_BYTES_PER_CHUNK);
        if (chunk.length === 0) break;
        const payload = chunk.length < TWILIO_MULAW_BYTES_PER_CHUNK
          ? Buffer.concat([chunk, Buffer.alloc(TWILIO_MULAW_BYTES_PER_CHUNK - chunk.length, 0xff)])
          : chunk;
        sendMediaToTwilio(payload.toString("base64"));
      }
    } catch (err) {
      log.error({ err }, "TTS or AI error");
      const fallback = "Sorry, I had a problem. Please try again.";
      try {
        const mp3Buffer = await textToSpeech(fallback);
        const mulawBuffer = await mp3ToMulaw8k(mp3Buffer);
        for (let i = 0; i < mulawBuffer.length; i += TWILIO_MULAW_BYTES_PER_CHUNK) {
          const chunk = mulawBuffer.subarray(i, i + TWILIO_MULAW_BYTES_PER_CHUNK);
          if (chunk.length === 0) break;
          const payload = chunk.length < TWILIO_MULAW_BYTES_PER_CHUNK
            ? Buffer.concat([chunk, Buffer.alloc(TWILIO_MULAW_BYTES_PER_CHUNK - chunk.length, 0xff)])
            : chunk;
          sendMediaToTwilio(payload.toString("base64"));
        }
      } catch (fallbackErr) {
        log.warn({ err: fallbackErr }, "Fallback TTS also failed");
      }
    } finally {
      isPlaying = false;
      ignoreTranscriptsUntil = Date.now() + 1000;
    }
  }

  twilioWs.on("close", () => cleanup());
  twilioWs.on("error", (err) => {
    log.error({ err }, "Twilio WebSocket error");
    cleanup();
  });
}
