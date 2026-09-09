import { parseSunoLink } from "../../../lib/mixtape";
const SONG_PATH_PATTERN =
  /^\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUNO_HOSTS = new Set(["suno.com", "www.suno.com"]);
const REQUEST_TIMEOUT_MS = 8_000;

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const ERROR_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": JSON_CONTENT_TYPE,
};

function jsonError(status: 400 | 422 | 502, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: ERROR_HEADERS,
  });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const sourceCandidates = requestUrl.searchParams.getAll("url");
  const hasUnexpectedParameters = Array.from(
    requestUrl.searchParams.keys(),
  ).some((key) => key !== "url");

  if (sourceCandidates.length !== 1 || hasUnexpectedParameters) {
    return jsonError(
      400,
      "Provide exactly one url query parameter containing a Suno short link.",
    );
  }

  const link = parseSunoLink(sourceCandidates[0]);
  if (!link || link.kind !== "short") {
    return jsonError(
      400,
      "Use a Suno short link beginning with https://suno.com/s/.",
    );
  }
  const sourceUrl = link.url;
  const shortCode = link.id;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(sourceUrl, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    return jsonError(
      502,
      "Could not reach Suno to resolve this short link. Please try again.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!REDIRECT_STATUSES.has(response.status)) {
    return jsonError(
      422,
      `Suno returned HTTP ${response.status} instead of a supported song redirect.`,
    );
  }

  const location = response.headers.get("Location");
  if (!location) {
    return jsonError(502, "Suno returned a redirect without a destination.");
  }

  let destination: URL;
  try {
    destination = new URL(location, sourceUrl);
  } catch {
    return jsonError(502, "Suno returned an invalid redirect destination.");
  }

  const songMatch = destination.pathname.match(SONG_PATH_PATTERN);
  const redirectShareValues = destination.searchParams.getAll("sh");
  const hasOnlyMatchingShareQuery =
    destination.search === "" ||
    (redirectShareValues.length === 1 &&
      redirectShareValues[0] === shortCode &&
      Array.from(destination.searchParams.keys()).every((key) => key === "sh"));
  if (
    destination.protocol !== "https:" ||
    !SUNO_HOSTS.has(destination.hostname.toLowerCase()) ||
    destination.username !== "" ||
    destination.password !== "" ||
    destination.port !== "" ||
    !hasOnlyMatchingShareQuery ||
    destination.hash !== "" ||
    !songMatch
  ) {
    return jsonError(
      422,
      "The short link did not resolve directly to a supported Suno song URL.",
    );
  }

  const id = songMatch[1].toLowerCase();
  return new Response(
    JSON.stringify({ sourceUrl: `https://suno.com/song/${id}`, id }),
    {
      status: 200,
      headers: {
        "Cache-Control":
          "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
        "Content-Type": JSON_CONTENT_TYPE,
      },
    },
  );
}
