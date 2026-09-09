import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function request(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: {
        accept: pathname.startsWith("/api/") ? "application/json" : "text/html",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished MIXTAPE_98 player", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MIXTAPE_98 — Share the songs, skip the sign-up<\/title>/i);
  assert.match(html, /MIXTAPE_98\.EXE/);
  assert.match(html, /Paste your Suno song links\./);
  assert.match(html, /BUILD \+ SHUFFLE/);
  assert.match(html, /SHUFFLE THE SONGS\. SKIP THE SIGN-UP\./);
  assert.match(
    html,
    /https?:\/\/(?:localhost|mixtape-98\.promptguyera\.chatgpt\.site)\/og\.png/,
  );
  assert.doesNotMatch(
    html,
    /codex-preview|react-loading-skeleton|Your site is taking shape/i,
  );
});

test("removes the starter and ships the dedicated social preview", async () => {
  const [page, layout, packageJson, socialCard] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    stat(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /https:\/\/suno\.com\/embed\/\$\{currentTrack\.id\}/);
  assert.match(page, /allow="autoplay; encrypted-media; fullscreen"/);
  assert.match(page, /prefers-reduced-motion|spectrum/);
  assert.match(layout, /x-forwarded-host/);
  assert.match(layout, /\/og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.ok(socialCard.size > 100_000);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/resolve/route.ts", import.meta.url)));
  await assert.rejects(access(new URL("public/favicon.svg", projectRoot)));
});

test("ships native playback controls with an anonymous embed fallback", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const links = await readFile(new URL("../lib/mixtape.ts", import.meta.url), "utf8");
  assert.match(links, /\(\?:song\|embed\)/);
  assert.match(page, /parseSunoLink/);
  assert.match(page, /\/api\/resolve-short/);
  assert.match(page, /\/api\/track\?id=/);
  assert.match(page, /Previous visited song/);
  assert.match(page, /onEnded=\{\(\) => goNext\(true\)\}/);
  assert.match(page, /USE PLAY INSIDE THE SUNO PLAYER/);
  assert.doesNotMatch(page, /cdn1\.suno\.ai|twitter:player:stream/);
});

test("short-link resolver rejects non-Suno targets", async () => {
  const response = await request(
    "/api/resolve-short?url=https%3A%2F%2Fexample.com%2Fs%2FWsgQt4CyruuRWFQ8",
  );
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
});

test("track metadata resolver rejects malformed song ids", async () => {
  const response = await request("/api/track?id=not-a-song-id");
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
});
