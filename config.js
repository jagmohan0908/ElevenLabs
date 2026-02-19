import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

export const EXOTEL_ACCOUNT_SID = process.env.EXOTEL_ACCOUNT_SID || "";
export const EXOTEL_API_KEY = process.env.EXOTEL_API_KEY || "";
export const EXOTEL_API_TOKEN = process.env.EXOTEL_API_TOKEN || "";
export const EXOTEL_SUBDOMAIN = process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";
export const EXOTEL_CALLER_ID = process.env.EXOTEL_CALLER_ID || "";
export const EXOTEL_APP_ID = process.env.EXOTEL_APP_ID || "";
export const EXOTEL_CALLBACK_PLAY_RESPONSE =
  (process.env.EXOTEL_CALLBACK_PLAY_RESPONSE || "true").toLowerCase() === "true";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

export const AUDIO_DIR = path.resolve(process.env.AUDIO_DIR || path.join(__dirname, "audio_out"));
export const EXOTEL_SAMPLE_RATE = 8000;
export const EXOTEL_CHANNELS = 1;
