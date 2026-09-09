import { SONG_ID } from "../../../lib/mixtape";

const SUNO_API_ORIGIN = "https://studio-api.prod.suno.com";
const AUDIO_HOSTS = new Set(["cdn1.suno.ai", "cdn2.suno.ai"]);
const IMAGE_HOSTS = new Set(["cdn1.suno.ai", "cdn2.suno.ai"]);

function json(body: unknown, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache,
  } });
}

function cleanAssetUrl(value: unknown, hosts: Set<string>): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port || url.hash) return null;
    return url.toString();
  } catch { return null; }
}

function cleanText(value: unknown, fallback: string, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) || fallback : fallback;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const ids = params.getAll("id");
  if (ids.length !== 1 || [...params.keys()].some(key => key !== "id") || !SONG_ID.test(ids[0])) {
    return json({ error: "Provide exactly one valid Suno song id." }, 400);
  }
  const id = ids[0].toLowerCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${SUNO_API_ORIGIN}/api/clip/${id}/`, {
      headers: { Accept: "application/json", "User-Agent": "MIXTAPE_98/2.0" },
      redirect: "manual", signal: controller.signal,
    });
    if (response.status === 404) return json({ error: "This song was removed or is unavailable." }, 404);
    if (!response.ok) return json({ error: "Suno could not load this song. Try again shortly." }, 502);
    const reader = response.body?.getReader();
    if (!reader) return json({ error: "Suno returned an empty response." }, 502);
    let body = "";
    let size = 0;
    const decoder = new TextDecoder();
    // Keep timeout active through body consumption, not just response headers.
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); return json({ error: "Suno returned an oversized response." }, 502); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    const payload = JSON.parse(body + decoder.decode());
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.id !== "string" || payload.id.toLowerCase() !== id) {
      return json({ error: "Suno returned an invalid song response." }, 502);
    }
    if (payload.is_hidden === true || payload.is_trashed === true) return json({ error: "This song is unavailable." }, 404);
    if (typeof payload.is_public !== "boolean") return json({ error: "Suno could not confirm this share link." }, 422);
    // Both Public and Link Only songs can be shared. Resolve only supplied IDs;
    // never enumerate a creator's library or obtain authenticated content.
    const complete = payload.status === "complete";
    const audioUrl = complete ? cleanAssetUrl(payload.audio_url, AUDIO_HOSTS) : null;
    const imageUrl = cleanAssetUrl(payload.image_large_url, IMAGE_HOSTS) ?? cleanAssetUrl(payload.image_url, IMAGE_HOSTS);
    const rawDuration = Number(payload.metadata?.duration);
    const model = cleanText(payload.major_model_version, "", 24);
    const modelVersion = /^v\d+(?:\.\d+)*(?:[-\w .]*)?$/i.test(model) ? model : null;
    // Encoded media_urls require Suno's player. Never derive alternate URLs or
    // attempt decoding. Retain song details even when native audio is absent.
    return json({
      id, title: cleanText(payload.title, "Untitled Suno song", 160),
      artist: cleanText(payload.display_name, "Suno creator", 120),
      audioUrl, imageUrl, modelVersion,
      duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
      sourceUrl: `https://suno.com/song/${id}`,
      playback: audioUrl ? "native" : "embed",
      availability: complete ? "ready" : "processing",
      visibility: payload.is_public ? "public" : "link-only",
      message: !complete ? "Suno is still preparing this song. Refresh it when generation finishes."
        : !audioUrl ? "Use Play in the Suno window. Next and Back here move through your mix." : null,
    }, 200, payload.is_public && complete ? "public, max-age=120, s-maxage=300" : "private, no-store");
  } catch (error) {
    console.error("Suno metadata lookup failed:", error instanceof Error ? error.message : "Unknown upstream error");
    return json({ error: controller.signal.aborted ? "Suno took too long to respond. Try again." : "Could not load song details from Suno. Try again." }, 502);
  } finally { clearTimeout(timeout); }
}
