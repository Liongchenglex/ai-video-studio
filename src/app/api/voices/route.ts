/**
 * GET /api/voices
 * Lists the ElevenLabs voice library (premade narration voices) with
 * preview URLs, proxied server-side so the API key never reaches the
 * client. Responses are cached in-memory for an hour — the library
 * changes rarely and this avoids hammering ElevenLabs on every editor
 * mount. Auth-required; read-only (no CSRF/rate-limit, mirroring the
 * project's other authenticated GETs).
 */
import { NextResponse } from "next/server";
import { getSession, unauthorizedResponse } from "@/lib/api-utils";

export interface VoiceOption {
  id: string;
  name: string;
  gender: string | null;
  accent: string | null;
  descriptive: string | null;
  previewUrl: string | null;
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
  labels?: Record<string, string | undefined>;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { at: number; voices: VoiceOption[] } | null = null;

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ voices: cache.voices });
  }

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    });
    if (!res.ok) {
      console.error(`[voices] ElevenLabs list failed: ${res.status} ${await res.text()}`);
      return NextResponse.json({ error: "Voice list unavailable" }, { status: 502 });
    }
    const data = (await res.json()) as { voices?: ElevenLabsVoice[] };
    const voices: VoiceOption[] = (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender ?? null,
      accent: v.labels?.accent ?? null,
      descriptive: v.labels?.descriptive ?? v.labels?.description ?? null,
      previewUrl: v.preview_url ?? null,
    }));

    cache = { at: Date.now(), voices };
    return NextResponse.json({ voices });
  } catch (err) {
    console.error("[voices] ElevenLabs list error:", err);
    return NextResponse.json({ error: "Voice list unavailable" }, { status: 502 });
  }
}
