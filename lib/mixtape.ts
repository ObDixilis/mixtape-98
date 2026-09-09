export const MAX_TRACKS = 50;
export const SONG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Mix = { v: 1; name: string; urls: string[]; shuffle?: boolean };

export function shouldResumeNavigation(playing: boolean, pending: boolean, targetLoading: boolean, targetHasAudio: boolean): boolean {
  return (playing || pending) && (targetLoading || targetHasAudio);
}

/** Canonicalize only links explicitly supplied by a listener. */
export function parseSunoLink(value: unknown): { kind: "song" | "short"; id: string; url: string } | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["suno.com", "www.suno.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
    const song = url.pathname.match(/^\/(?:song|embed)\/([^/]+)\/?$/i);
    if (song && SONG_ID.test(song[1])) {
      const id = song[1].toLowerCase();
      return { kind: "song", id, url: `https://suno.com/song/${id}` };
    }
    const short = url.pathname.match(/^\/s\/([a-z0-9]{16})\/?$/i);
    return short ? { kind: "short", id: short[1], url: `https://suno.com/s/${short[1]}` } : null;
  } catch { return null; }
}

export function inputTokens(value: string): string[] {
  // Handles copied Markdown, embed snippets, punctuation, and plain link lists.
  const matches = value.match(/https?:\/\/[^\s,;<>"'`[\]()]+/gi);
  const tokens = matches ?? value.trim().split(/[\s,]+/);
  return [...new Set(tokens.map(token => token.replace(/[*,;.!?]+$/, "")).filter(Boolean))];
}

export function cleanSunoUrl(value: unknown): string | null {
  const link = parseSunoLink(value);
  return link?.kind === "song" ? link.url : null;
}

export function encodeMix(payload: Mix): string {
  const compact = { v: 2, name: payload.name.slice(0, 48), ids: payload.urls.map(url => parseSunoLink(url)?.id), shuffle: payload.shuffle ?? true };
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeMix(value: string): Mix | null {
  if (!value || value.length > 12_000 || !/^[a-z0-9_-]+$/i.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (!parsed || typeof parsed.name !== "string" || ![1, 2].includes(parsed.v)) return null;
    const entries = parsed.v === 2 ? parsed.ids : parsed.urls;
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_TRACKS) return null;
    const urls = entries.map(value => parsed.v === 2 && typeof value === "string" && SONG_ID.test(value)
      ? `https://suno.com/song/${value.toLowerCase()}` : parsed.v === 1 ? cleanSunoUrl(value) : null);
    if (urls.some(url => !url)) return null;
    return { v: 1, name: parsed.name.slice(0, 48) || "Random access mix", urls: [...new Set(urls)] as string[], shuffle: parsed.shuffle !== false };
  } catch { return null; }
}

export function createShareUrl(origin: string, mix: Mix, startingTrack: string | null): string {
  const url = new URL(origin);
  url.search = "";
  url.hash = "";
  url.searchParams.set("mix", encodeMix(mix));
  if (startingTrack && mix.urls.some(source => parseSunoLink(source)?.id === startingTrack)) url.searchParams.set("track", startingTrack);
  return url.toString();
}
