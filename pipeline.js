/**
 * Pipeline: Recording URL → download → STT → AI → TTS → 8kHz WAV.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import OpenAI, { toFile } from "openai";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
  AUDIO_DIR,
  EXOTEL_SAMPLE_RATE,
  EXOTEL_CHANNELS,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
} from "./config.js";
import { getProducts, getProductById, createDraftOrder } from "./shopify.js";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });

export async function downloadRecording(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function speechToText(audioBuffer) {
  const file = await toFile(audioBuffer, "recording.mp3");
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "text",
  });
  return typeof transcription === "string" ? transcription : transcription.text;
}

const SYSTEM_PROMPT =
  "You are a helpful voice assistant. Reply in 1-3 short sentences. Be clear and concise for phone playback. Support Hindi and English.";

const NEHA_SYSTEM_PROMPT = `You are Neha, a real person on a phone call from Siya Ayurveda. You speak naturally in Hindi and English (Hinglish) like a friendly shop assistant. Keep replies short for a call: 1-3 sentences. Be warm and human.

When the customer asks about products, use the get_products tool (with optional search query) to fetch real products, then describe them in a natural way and ask if they want to know more or order.
When they want to buy, ask for: full name, full address (address line, city, state, pincode), phone, and how they want to pay (COD, online, etc.). Then use create_draft_order with the collected details to create their order. Confirm the order and tell them next steps (e.g. we will send payment link / COD confirmation).

Always sound like a real person on a call—use "ji", "bilkul", "theek hai", natural fillers. Never sound like a robot or list bullet points.`;

const SHOPIFY_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_products",
      description: "Fetch products from Siya Ayurveda store. Use when customer asks what products we have, or to search by name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional search term (product name or keyword)" },
          limit: { type: "number", description: "Max products to return (default 15)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product",
      description: "Get details of one product by ID. Use after listing products when customer asks about a specific product.",
      parameters: {
        type: "object",
        properties: { product_id: { type: "number", description: "Shopify product ID" } },
        required: ["product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_draft_order",
      description: "Create a draft order for the customer. Call only after you have collected: full name, full address (address1, city, province, country, zip), phone, and at least one line item (variant_id and quantity).",
      parameters: {
        type: "object",
        properties: {
          line_items: {
            type: "array",
            items: {
              type: "object",
              properties: { variant_id: { type: "number" }, quantity: { type: "number" } },
              required: ["variant_id", "quantity"],
            },
            description: "Items to order: variant_id from product, quantity",
          },
          first_name: { type: "string" },
          last_name: { type: "string" },
          address1: { type: "string" },
          city: { type: "string" },
          province: { type: "string", description: "State" },
          country: { type: "string", description: "e.g. India" },
          zip: { type: "string", description: "Pincode" },
          phone: { type: "string" },
          note: { type: "string", description: "Payment method or customer note" },
        },
        required: ["line_items", "first_name", "last_name", "address1", "city", "country", "zip", "phone"],
      },
    },
  },
];

async function runTool(name, args) {
  if (name === "get_products") {
    const { products, error } = await getProducts(args?.limit || 15, args?.query || "");
    return JSON.stringify(error ? { error } : { products: products.slice(0, 15) });
  }
  if (name === "get_product") {
    const { product, error } = await getProductById(args?.product_id);
    return JSON.stringify(error ? { error } : { product });
  }
  if (name === "create_draft_order") {
    const shippingAddress = {
      first_name: args?.first_name || "",
      last_name: args?.last_name || "",
      address1: args?.address1 || "",
      city: args?.city || "",
      province: args?.province || "",
      country: args?.country || "India",
      zip: args?.zip || "",
      phone: args?.phone || "",
    };
    const { draft_order, error } = await createDraftOrder({
      lineItems: args?.line_items || [],
      shippingAddress,
      note: args?.note || "",
    });
    return JSON.stringify(error ? { error } : { draft_order, invoice_url: draft_order?.invoice_url });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

/** Agentic turn: chat with tools (Shopify) for Neha. Returns final assistant message text. */
export async function nehaResponseWithHistory(messages) {
  const allMessages = [{ role: "system", content: NEHA_SYSTEM_PROMPT }, ...messages];
  let maxTurns = 8;
  while (maxTurns-- > 0) {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: allMessages,
      tools: SHOPIFY_TOOLS,
      tool_choice: "auto",
      max_tokens: 300,
    });
    const msg = r.choices[0]?.message;
    if (!msg) return "Sorry, main abhi respond nahi de paayi. Phir try karein.";
    if (msg.tool_calls?.length) {
      allMessages.push(msg);
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch (_) {}
        const result = await runTool(name, args);
        allMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
      continue;
    }
    const text = msg.content?.trim();
    return text || "Aur bataiye, main kaise help kar sakti hoon?";
  }
  return "Thoda time lagega, baad mein phir try karein.";
}

export async function aiResponse(userText) {
  if (!userText || !String(userText).trim()) {
    return "I didn't catch that. Please call again and say your question clearly.";
  }
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    max_tokens: 150,
  });
  return r.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response.";
}

/** AI response with full conversation history (generic assistant). */
export async function aiResponseWithHistory(messages) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    max_tokens: 150,
  });
  return r.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response.";
}

/** Default voice that works on ElevenLabs free tier (Rachel). Library voices need a paid plan. */
const FREE_TIER_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Free fallback TTS when ElevenLabs returns 401/403 (e.g. from cloud/datacenter). Uses Google Translate TTS. */
async function googleTtsFallback(text, preferredLang = "hi") {
  const t = String(text || "").trim();
  if (!t) throw new Error("googleTtsFallback: empty text");
  const lang = /^[\x00-\x7F\s.,?!;:'"-]+$/.test(t) ? "en" : preferredLang;
  const maxChunk = 180;
  const chunks = [];
  for (let i = 0; i < t.length; i += maxChunk) {
    const part = t.slice(i, i + maxChunk);
    const q = encodeURIComponent(part);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${q}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Google TTS: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error("Google TTS: response too small (likely HTML)");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function textToSpeech(text, voiceIdOverride = null) {
  const voiceId = voiceIdOverride ?? ELEVENLABS_VOICE_ID ?? FREE_TIER_VOICE_ID;
  try {
    const result = await elevenlabs.textToSpeech.convert(voiceId, {
      text,
      modelId: "eleven_turbo_v2_5",
    });
    if (Buffer.isBuffer(result)) return result;
    if (result instanceof Uint8Array) return Buffer.from(result);
    const chunks = [];
    for await (const chunk of result) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err) {
    if (err?.statusCode === 402 && voiceId !== FREE_TIER_VOICE_ID) {
      return textToSpeech(text, FREE_TIER_VOICE_ID);
    }
    if (err?.statusCode === 401 || err?.statusCode === 403) {
      return googleTtsFallback(text, "hi");
    }
    throw err;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Convert MP3 buffer to 8kHz mono mu-law raw for Twilio Media Streams (requires ffmpeg on PATH).
 */
export async function mp3ToMulaw8k(mp3Buffer) {
  if (!mp3Buffer || !mp3Buffer.length) {
    return Promise.reject(new Error("mp3ToMulaw8k: empty input"));
  }
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-i", "pipe:0", "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"],
      { stdio: ["pipe", "pipe", "ignore"] }
    );
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`ffmpeg exited with code ${code}`));
    });
    if (!ff.stdout || !ff.stdin) {
      reject(new Error("ffmpeg spawn: missing stdout or stdin"));
      return;
    }
    const chunks = [];
    ff.stdout.on("data", (chunk) => chunks.push(chunk));
    ff.stdout.on("end", () => {
      const out = Buffer.concat(chunks);
      if (!out.length) return reject(new Error("ffmpeg produced no output (invalid audio?)"));
      resolve(out);
    });
    if (ff.stderr) ff.stderr.on("data", () => {});
    ff.stdin.write(mp3Buffer);
    ff.stdin.end();
  });
}

/**
 * Convert MP3 buffer to 8kHz mono 16-bit WAV for Exotel (requires ffmpeg on PATH).
 */
export async function toExotelWav(mp3Buffer) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const tmpMp3 = path.join(AUDIO_DIR, `tmp_${randomUUID()}.mp3`);
  const tmpWav = path.join(AUDIO_DIR, `tmp_${randomUUID()}.wav`);
  fs.writeFileSync(tmpMp3, mp3Buffer);
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", tmpMp3, "-ar", String(EXOTEL_SAMPLE_RATE), "-ac", "1", "-acodec", "pcm_s16le", tmpWav],
      { timeout: 30000 }
    );
    const wav = fs.readFileSync(tmpWav);
    return wav;
  } finally {
    try {
      if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3);
      if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
    } catch (_) {}
  }
}

export async function runPipeline(recordingUrl) {
  console.log("Downloading recording:", recordingUrl.slice(0, 80));
  const raw = await downloadRecording(recordingUrl);

  console.log("Speech to text");
  const transcript = await speechToText(raw);
  console.log("Transcript:", transcript?.slice(0, 200) || "(empty)");

  console.log("AI response");
  const reply = await aiResponse(transcript);
  console.log("Reply:", reply?.slice(0, 200));

  console.log("Text to speech");
  const mp3Buffer = await textToSpeech(reply);
  const wavBuffer = await toExotelWav(mp3Buffer);

  const audioId = randomUUID();
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const wavPath = path.join(AUDIO_DIR, `${audioId}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);
  console.log("Saved WAV:", wavPath);

  return { transcript, wavPath, audioId };
}

const GREETING_WAV_ID = "greeting";
const GREETING_TEXT = "Hello. How can I help you today? Speak after the beep.";

/** Generate and cache greeting WAV for conversation loop (8kHz mono). */
export async function ensureGreetingWav() {
  const wavPath = path.join(AUDIO_DIR, `${GREETING_WAV_ID}.wav`);
  if (fs.existsSync(wavPath)) return GREETING_WAV_ID;
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const mp3Buffer = await textToSpeech(GREETING_TEXT);
  const wavBuffer = await toExotelWav(mp3Buffer);
  fs.writeFileSync(wavPath, wavBuffer);
  console.log("Saved greeting WAV:", wavPath);
  return GREETING_WAV_ID;
}
