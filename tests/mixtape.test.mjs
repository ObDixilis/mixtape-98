import test from "node:test";
import assert from "node:assert/strict";
import { createShareUrl, decodeMix, encodeMix, inputTokens, parseSunoLink, shouldResumeNavigation } from "../lib/mixtape.ts";

const id = "008a5970-f769-4d76-ac50-bfff1a23f349";
const second = "41ff6ec7-950a-4a0a-8586-70d898c80252";
const song = `https://suno.com/song/${id}`;
const mix = { v: 1, name: "A new release 🌙", urls: [song, `https://suno.com/song/${second}`], shuffle: false };

test("rapid navigation preserves pending native playback but does not carry it through an embed", () => {
  let pending = shouldResumeNavigation(true, false, true, false);
  assert.equal(pending, true);
  pending = shouldResumeNavigation(false, pending, true, false);
  assert.equal(pending, true);
  pending = shouldResumeNavigation(false, pending, false, false);
  assert.equal(pending, false);
  assert.equal(shouldResumeNavigation(false, pending, false, true), false);
});

test("new share URLs retain selected song, Unicode title, and source-order preference", () => {
  const url = new URL(createShareUrl("https://example.com/?old=1#old", mix, second));
  assert.equal(url.searchParams.get("track"), second);
  assert.equal(url.hash, "");
  assert.deepEqual(decodeMix(url.searchParams.get("mix")), mix);
  assert.ok(encodeMix(mix).length < Buffer.from(JSON.stringify(mix)).toString("base64url").length);
});

test("previously shared v1 mixes still load; malformed and oversized mixes do not", () => {
  const legacy = { v: 1, name: mix.name, urls: mix.urls };
  assert.deepEqual(decodeMix(Buffer.from(JSON.stringify(legacy)).toString("base64url")), { ...legacy, shuffle: true });
  for (const payload of [null, { v: 1, name: "bad", urls: [1] }, {v:2,name:"bad",ids:["garbage"]}, {v:2,name:"large",ids:Array(51).fill(id)}]) {
    assert.equal(decodeMix(Buffer.from(JSON.stringify(payload)).toString("base64url")), null);
  }
  assert.equal(decodeMix("x".repeat(12001)), null);
});

test("copied Markdown, short-link slashes, and tracking parameters normalize safely", () => {
  const pasted = `[listen](${song})\nhttps://suno.com/s/WsgQt4CyruuRWFQ8/**\n${song}`;
  assert.deepEqual(inputTokens(pasted), [song, "https://suno.com/s/WsgQt4CyruuRWFQ8/"]);
  assert.deepEqual(inputTokens(`${song},https://suno.com/song/${second};${song}`), mix.urls);
  assert.equal(parseSunoLink("https://suno.com/s/WsgQt4CyruuRWFQ8/?utm_source=copy#share").url, "https://suno.com/s/WsgQt4CyruuRWFQ8");
  for (const input of ["https://suno.com.evil.test/s/WsgQt4CyruuRWFQ8", "https://secret@suno.com/s/WsgQt4CyruuRWFQ8", `${song}/extra`, `http://suno.com/song/${id}`]) assert.equal(parseSunoLink(input), null);
});

async function routeWith(payload, responseStatus = 200) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: responseStatus });
  try {
    const { default: worker } = await import("../dist/server/index.js");
    const response = await worker.fetch(new Request(`https://example.com/api/track?id=${id}`), {}, { waitUntil() {} });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  } finally { globalThis.fetch = originalFetch; }
}
const clip = { id, status: "complete", is_public: true, title: "Release", display_name: "Creator", major_model_version: "v6", metadata: { duration: 204 }, audio_url: `https://cdn1.suno.ai/${id}.mp3`, image_url: `https://cdn2.suno.ai/image_${id}.jpeg` };

test("future model labels do not require a version gate (synthetic v6 fixture)", async () => {
  const result = await routeWith(clip);
  assert.equal(result.status, 200);
  assert.equal(result.body.modelVersion, "v6");
  assert.equal(result.body.playback, "native");
});

test("encoded Suno media uses embed playback while keeping artwork, title and model", async () => {
  const result = await routeWith({ ...clip, audio_url: "https://studio-api.prod.suno.com/api/forbidden", media_urls: [{ url: "https://example.com/encoded.m4a", encoding: "1.0.0" }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.audioUrl, null);
  assert.equal(result.body.playback, "embed");
  assert.equal(result.body.title, "Release");
  assert.equal(result.body.imageUrl, clip.image_url);
});

test("Link Only remains shareable; generating songs can be refreshed; hidden songs stay unavailable", async () => {
  const unlisted = await routeWith({ ...clip, is_public: false });
  assert.equal(unlisted.status, 200);
  assert.match(unlisted.cache, /private, no-store/);
  const pending = await routeWith({ ...clip, status: "streaming" });
  assert.equal(pending.body.availability, "processing");
  assert.equal(pending.body.audioUrl, null);
  assert.equal((await routeWith({ ...clip, is_hidden: true })).status, 404);
});

test("invalid upstream JSON and redirects fail with controlled responses", async () => {
  assert.equal((await routeWith(null)).status, 502);
  assert.equal((await routeWith([])).status, 502);
  assert.equal((await routeWith({}, 302)).status, 502);
});
