/**
 * Pipeline: Recording URL → download → STT → AI → TTS → 8kHz WAV.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
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

export async function aiResponse(userText) {
  if (!userText || !String(userText).trim()) {
    return "I didn't catch that. Please call again and say your question clearly.";
  }
  const r = await openai.chat.completions
    .create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful voice assistant. Reply in 1-3 short sentences. Be clear and concise for phone playback.",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 150,
    });
  return r.choices[0]?.message?.content || "I'm sorry, I couldn't generate a response.";
}

export async function textToSpeech(text) {
  const voiceId = ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  const result = await elevenlabs.textToSpeech.convert(voiceId, {
    text,
    modelId: "eleven_turbo_v2_5",
  });
  if (Buffer.isBuffer(result)) return result;
  if (result instanceof Uint8Array) return Buffer.from(result);
  const chunks = [];
  for await (const chunk of result) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const execFileAsync = promisify(execFile);

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
