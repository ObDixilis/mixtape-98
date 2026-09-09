"use client";

/* eslint-disable jsx-a11y/media-has-caption */

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cleanSunoUrl, createShareUrl, decodeMix, inputTokens, parseSunoLink, shouldResumeNavigation } from "../lib/mixtape";

type MetadataState = "idle" | "loading" | "ready" | "unavailable";

type Track = {
  id: string;
  sourceUrl: string;
  label: string;
  title: string;
  artist: string;
  audioUrl: string | null;
  imageUrl: string | null;
  duration: number | null;
  metadataState: MetadataState;
  modelVersion: string | null;
  message: string | null;
  availability: "ready" | "processing";
};

type TrackDetails = {
  id: string;
  sourceUrl: string;
  title: string;
  artist: string;
  audioUrl: string | null;
  modelVersion: string | null;
  message: string | null;
  availability: "ready" | "processing";
  imageUrl: string | null;
  duration: number | null;
};

const BARS = [
  35, 62, 44, 78, 54, 84, 61, 43, 70, 48, 82, 55, 39, 66, 46, 32, 50, 72,
  58, 38, 64, 88, 53, 35, 60, 76, 48, 67, 42, 31, 56, 79,
];

async function resolveInputUrls(value: string) {
  const tokens = inputTokens(value);
  const results: Array<string | null> = Array(tokens.length).fill(null);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, tokens.length) }, async () => {
    while (cursor < tokens.length) {
      const index = cursor++;
      const link = parseSunoLink(tokens[index]);
      if (link?.kind === "song") { results[index] = link.url; continue; }
      if (link?.kind !== "short") continue;
      try {
        const response = await fetch(`/api/resolve-short?url=${encodeURIComponent(link.url)}`, { signal: AbortSignal.timeout(10_000) });
        const body = await response.json();
        if (response.ok) results[index] = cleanSunoUrl(body.sourceUrl);
      } catch { /* Keep the original failed link visible for correction. */ }
    }
  }));
  return { urls: [...new Set(results.filter((url): url is string => !!url))],
    failed: results.filter(url => !url).length, rejected: tokens.filter((_, index) => !results[index]) };
}

function makeTracks(urls: string[]) {
  return urls.map((sourceUrl, index): Track => ({
    id: parseSunoLink(sourceUrl)?.id ?? sourceUrl,
    sourceUrl,
    label: `SUNO TRACK ${String(index + 1).padStart(2, "0")}`,
    title: `Suno track ${String(index + 1).padStart(2, "0")}`,
    artist: "Loading creator…",
    audioUrl: null,
    imageUrl: null,
    duration: null,
    metadataState: "idle",
    modelVersion: null,
    message: null,
    availability: "ready",
  }));
}

async function fetchTrackDetails(id: string, signal?: AbortSignal): Promise<TrackDetails | null> {
  try {
    const response = await fetch(`/api/track?id=${encodeURIComponent(id)}`, { signal, cache: "no-cache" });
    const payload = await response.json();
    if (!response.ok || !payload || payload.id !== id || typeof payload.title !== "string" || typeof payload.artist !== "string") return null;
    return {
      id, sourceUrl: `https://suno.com/song/${id}`, title: payload.title, artist: payload.artist,
      audioUrl: typeof payload.audioUrl === "string" ? payload.audioUrl : null,
      imageUrl: typeof payload.imageUrl === "string" ? payload.imageUrl : null,
      duration: typeof payload.duration === "number" && Number.isFinite(payload.duration) ? payload.duration : null,
      modelVersion: typeof payload.modelVersion === "string" ? payload.modelVersion : null,
      message: typeof payload.message === "string" ? payload.message : null,
      availability: payload.availability === "processing" ? "processing" : "ready",
    };
  } catch { return null; }
}

function shuffledIndices(length: number, avoidFirst?: number) {
  const values = Array.from({ length }, (_, index) => index);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [values[index], values[next]] = [values[next], values[index]];
  }
  if (values.length > 1 && values[0] === avoidFirst) {
    [values[0], values[1]] = [values[1], values[0]];
  }
  return values;
}

function uniqueIndices(values: number[], length: number) {
  return Array.from(new Set(values)).filter(
    (value) => value >= 0 && value < length,
  );
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "--:--";
  const wholeSeconds = Math.floor(value);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function Home() {
  const [mixName, setMixName] = useState("Midnight random access");
  const [linkInput, setLinkInput] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [upNext, setUpNext] = useState<number[]>([]);
  const [showBuilder, setShowBuilder] = useState(true);
  const [status, setStatus] = useState("READY — DROP IN YOUR SUNO LINKS");
  const [shuffleOn, setShuffleOn] = useState(true);
  const [copied, setCopied] = useState<"mix" | "track" | null>(null);
  const [invalidCount, setInvalidCount] = useState(0);
  const [rejectedLinks, setRejectedLinks] = useState<string[]>([]);
  const [manualCopy, setManualCopy] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.82);
  const [nativeAudioFailed, setNativeAudioFailed] = useState(false);
  const [trackGeneration, setTrackGeneration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const embedRef = useRef<HTMLIFrameElement>(null);
  const resumeAfterLoadRef = useRef(false);

  const currentTrack = tracks[currentIndex] ?? null;
  const embedUrl = currentTrack
    ? `https://suno.com/embed/${currentTrack.id}`
    : null;
  const nativeReady = Boolean(currentTrack?.audioUrl && !nativeAudioFailed);
  const metadataLoading = Boolean(
    currentTrack &&
      (currentTrack.metadataState === "idle" ||
        currentTrack.metadataState === "loading"),
  );
  const showEmbedFallback = Boolean(
    currentTrack &&
      !metadataLoading &&
      (!currentTrack.audioUrl || nativeAudioFailed),
  );
  const totalDuration = duration || currentTrack?.duration || 0;

  const artworkStyle = currentTrack?.imageUrl
    ? ({
        "--track-art": `url(${JSON.stringify(currentTrack.imageUrl)})`,
      } as CSSProperties)
    : undefined;

  const shareUrl = useMemo(() => {
    if (!tracks.length || typeof window === "undefined") return "";
    return createShareUrl(window.location.href, {
      v: 1, name: mixName.trim().slice(0, 48) || "Random access mix",
      urls: tracks.map(track => track.sourceUrl), shuffle: shuffleOn,
    }, currentTrack?.id ?? null);
  }, [mixName, tracks, currentTrack?.id, shuffleOn]);

  const queueOrder = useMemo(() => {
    if (!tracks.length) return [];

    if (!shuffleOn) {
      return Array.from({ length: tracks.length }, (_, index) => index);
    }

    const played = history
      .slice(0, historyCursor)
      .filter((index) => index !== currentIndex);
    const forward = history
      .slice(historyCursor + 1)
      .filter((index) => index !== currentIndex);
    const combined = uniqueIndices(
      [...played, currentIndex, ...forward, ...upNext],
      tracks.length,
    );
    const seen = new Set(combined);
    return [
      ...combined,
      ...Array.from({ length: tracks.length }, (_, index) => index).filter(
        (index) => !seen.has(index),
      ),
    ];
  }, [currentIndex, history, historyCursor, shuffleOn, tracks.length, upNext]);

  const loadTracks = useCallback(
    (
      urls: string[],
      preferredTrack?: string,
      updateAddress = false,
      addressName = "Random access mix",
      useShuffle = true,
    ) => {
      const nextTracks = makeTracks(urls);
      resumeAfterLoadRef.current = false;
      setShuffleOn(useShuffle);
      setManualCopy("");
      let order = useShuffle ? shuffledIndices(nextTracks.length) : nextTracks.map((_, index) => index);
      if (preferredTrack) {
        const preferredIndex = nextTracks.findIndex(
          (track) => track.id === preferredTrack.toLowerCase(),
        );
        if (preferredIndex >= 0) {
          order = [
            preferredIndex,
            ...order.filter((index) => index !== preferredIndex),
          ];
        }
      }

      const firstIndex = order[0] ?? 0;
      setTracks(nextTracks);
      setTrackGeneration((value) => value + 1);
      setCurrentIndex(firstIndex);
      setHistory(nextTracks.length ? [firstIndex] : []);
      setHistoryCursor(0);
      setUpNext(order.slice(1));
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setNativeAudioFailed(false);
      setShowBuilder(false);
      setStatus(
        `${nextTracks.length} TRACK${nextTracks.length === 1 ? "" : "S"} READY · LOADING AUDIO`,
      );

      if (updateAddress && typeof window !== "undefined") {
        window.history.replaceState({}, "", createShareUrl(window.location.href, {
          v: 1, name: addressName.trim().slice(0, 48) || "Random access mix",
          urls, shuffle: useShuffle,
        }, nextTracks[firstIndex]?.id ?? null));
      }
    },
    [],
  );

  useEffect(() => {
    const initialize = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const encoded = params.get("mix");

      if (!encoded) {
        try {
          const saved = window.localStorage.getItem("mixtape98:last-mix");
          if (saved) {
            const local = JSON.parse(saved);
            if (typeof local.name === "string") setMixName(local.name.slice(0, 48));
            if (Array.isArray(local.urls)) setLinkInput(local.urls.filter((url: unknown) => cleanSunoUrl(url)).slice(0, 50).join("\n"));
          }
        } catch { /* Storage is optional; building and sharing still work. */ }
        return;
      }

      const decoded = decodeMix(encoded);
      if (!decoded) {
        setStatus("THIS MIX LINK IS DAMAGED — MAKE A NEW ONE");
        return;
      }
      setMixName(decoded.name);
      setLinkInput(decoded.urls.join("\n"));
      loadTracks(decoded.urls, params.get("track") ?? undefined, false, decoded.name, decoded.shuffle);
    }, 0);

    return () => window.clearTimeout(initialize);
  }, [loadTracks]);

  useEffect(() => {
    if (!tracks.length) return;
    const pending = tracks.filter((track) => track.metadataState === "idle");
    if (!pending.length) return;

    let active = true;
    const controller = new AbortController();
    const currentId = tracks[currentIndex]?.id;
    const prioritized = [...pending.filter(track => track.id === currentId), ...pending.filter(track => track.id !== currentId)];
    let cursor = 0;
    void Promise.all(Array.from({ length: Math.min(4, prioritized.length) }, async () => {
      while (active && cursor < prioritized.length) {
        const track = prioritized[cursor++];
        const details = await fetchTrackDetails(track.id, controller.signal);
        if (!active) return;
        setTracks(previous => previous.map(item => item.id !== track.id ? item : details
          ? { ...item, ...details, metadataState: "ready" }
          : { ...item, artist: "Details unavailable", message: "Song details could not load. Try Refresh song or use the embedded player.", metadataState: "unavailable" }));
      }
    }));
    return () => { active = false; controller.abort(); };
    // Navigation must not cancel metadata hydration for the active mix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackGeneration]);

  useEffect(() => {
    if (!currentTrack || metadataLoading) return;
    if (showEmbedFallback) resumeAfterLoadRef.current = false;
    const timer = window.setTimeout(() => {
      if (showEmbedFallback) setStatus(currentTrack.availability === "processing"
        ? "SONG IS STILL GENERATING · REFRESH WHEN READY"
        : "SUNO PLAYER READY · PRESS PLAY IN THE SONG WINDOW");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentTrack, metadataLoading, showEmbedFallback]);

  useEffect(() => {
    if (
      !currentTrack ||
      !("mediaSession" in navigator) ||
      !("MediaMetadata" in window)
    ) {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: mixName,
      artwork: currentTrack.imageUrl
        ? [{ src: currentTrack.imageUrl, sizes: "512x512" }]
        : [],
    });
  }, [currentTrack, mixName]);

  async function buildMix() {
    const candidateCount = inputTokens(linkInput).length;
    if (!candidateCount) {
      setStatus("PASTE AT LEAST ONE SUNO LINK");
      return;
    }
    if (candidateCount > 50) {
      setStatus("MAXIMUM 50 SONGS PER MIX");
      return;
    }

    setIsResolving(true);
    setInvalidCount(0);
    setRejectedLinks([]);
    setStatus(
      `RESOLVING ${candidateCount} SUNO LINK${candidateCount === 1 ? "" : "S"}...`,
    );
    const { urls, failed, rejected } = await resolveInputUrls(linkInput);
    setRejectedLinks(rejected);
    setIsResolving(false);
    setInvalidCount(failed);

    if (!urls.length) {
      setStatus("NO PLAYABLE SUNO LINKS FOUND");
      return;
    }

    try {
      window.localStorage.setItem("mixtape98:last-mix", JSON.stringify({ name: mixName, urls }));
    } catch { /* Browser storage must never block the mix. */ }
    loadTracks(urls, undefined, true, mixName, shuffleOn);
    if (failed) setShowBuilder(true);
    if (failed) {
      setStatus(
        `${urls.length} TRACK${urls.length === 1 ? "" : "S"} READY · ${failed} LINK${failed === 1 ? "" : "S"} SKIPPED`,
      );
    }
  }

  function switchTrack(nextIndex: number, resume: boolean) {
    if (nextIndex === currentIndex) return;
    const target = tracks[nextIndex];
    resumeAfterLoadRef.current = shouldResumeNavigation(resume, resumeAfterLoadRef.current,
      target?.metadataState === "idle" || target?.metadataState === "loading", Boolean(target?.audioUrl));
    setCurrentIndex(nextIndex);
    setIsPlaying(false);
    setManualCopy("");
    setCurrentTime(0);
    setDuration(tracks[nextIndex]?.duration ?? 0);
    setNativeAudioFailed(false);
    setStatus(
      `LOADING ${tracks[nextIndex]?.title.toUpperCase() ?? "NEXT TRACK"}...`,
    );
  }

  function goNext(forceResume = false) {
    if (!tracks.length) return;
    const shouldResume = forceResume || isPlaying;

    if (historyCursor < history.length - 1) {
      const nextCursor = historyCursor + 1;
      const nextIndex = history[nextCursor];
      setHistoryCursor(nextCursor);
      switchTrack(nextIndex, shouldResume);
      return;
    }

    if (tracks.length === 1) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        setCurrentTime(0);
        if (shouldResume) void audio.play();
      }
      return;
    }

    let nextIndex: number;
    if (shuffleOn) {
      let bag = upNext.filter((index) => index !== currentIndex);
      if (!bag.length) {
        bag = shuffledIndices(tracks.length, currentIndex).filter(
          (index) => index !== currentIndex,
        );
      }
      nextIndex = bag[0];
      setUpNext(bag.slice(1));
    } else {
      nextIndex = (currentIndex + 1) % tracks.length;
    }

    setHistory((previous) => [
      ...previous.slice(0, historyCursor + 1),
      nextIndex,
    ]);
    setHistoryCursor(historyCursor + 1);
    switchTrack(nextIndex, shouldResume);
  }

  function goPrevious() {
    if (!tracks.length || historyCursor <= 0) return;
    const previousCursor = historyCursor - 1;
    const previousIndex = history[previousCursor];
    setHistoryCursor(previousCursor);
    switchTrack(previousIndex, isPlaying);
  }

  function selectTrack(index: number) {
    if (index === currentIndex) return;
    setHistory((previous) => [
      ...previous.slice(0, historyCursor + 1),
      index,
    ]);
    setHistoryCursor(historyCursor + 1);
    setUpNext((previous) => previous.filter((value) => value !== index));
    switchTrack(index, isPlaying);
  }

  function reshuffle() {
    if (!tracks.length) return;
    setHistory((previous) => previous.slice(0, historyCursor + 1));
    setUpNext(
      shuffledIndices(tracks.length, currentIndex).filter(
        (index) => index !== currentIndex,
      ),
    );
    setStatus("UP NEXT RESHUFFLED · CURRENT SONG UNCHANGED");
  }

  function toggleShuffle() {
    const nextValue = !shuffleOn;
    setShuffleOn(nextValue);
    if (nextValue && !upNext.length) {
      setUpNext(
        shuffledIndices(tracks.length, currentIndex).filter(
          (index) => index !== currentIndex,
        ),
      );
    }
    setStatus(nextValue ? "SHUFFLE ON · FUTURE SONGS RANDOMIZED" : "SHUFFLE OFF · SOURCE ORDER NEXT");
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !nativeReady) {
      embedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      embedRef.current?.focus();
      setStatus("USE PLAY INSIDE THE SUNO PLAYER");
      return;
    }

    if (audio.paused) {
      try {
        await audio.play();
        setStatus("PLAYING");
      } catch {
        setStatus("PLAYBACK WAS BLOCKED · PRESS PLAY AGAIN");
      }
    } else {
      resumeAfterLoadRef.current = false;
      audio.pause();
      setStatus("PAUSED");
    }
  }

  function restartTrack() {
    const audio = audioRef.current;
    if (!audio || !nativeReady) return;
    audio.currentTime = 0;
    setCurrentTime(0);
    setStatus("TRACK RESTARTED");
    if (isPlaying) void audio.play();
  }

  function seekTrack(value: number) {
    const audio = audioRef.current;
    if (!audio || !nativeReady) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }

  function refreshSong() {
    if (!currentTrack || metadataLoading) return;
    const id = currentTrack.id;
    setNativeAudioFailed(false);
    setTracks(previous => previous.map(track => track.id === id ? { ...track, metadataState: "idle" } : track));
    setTrackGeneration(value => value + 1);
  }

  async function copyText(value: string, type: "mix" | "track") {
    if (!value) return;
    let success = false;
    try { await navigator.clipboard.writeText(value); success = true; }
    catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      try { success = document.execCommand("copy"); } catch { /* Manual field below. */ }
      helper.remove();
    }
    if (!success) {
      setManualCopy(value);
      setStatus("COPY WAS BLOCKED · SELECT AND COPY THE LINK BELOW");
      return;
    }
    setManualCopy("");
    setCopied(type);
    setStatus(type === "mix" ? "MIX LINK COPIED · STARTS ON THIS SONG" : "SONG LINK COPIED");
    window.setTimeout(() => setCopied(null), 1800);
  }

  function copyMix() {
    void copyText(shareUrl, "mix");
  }

  function copyTrack() {
    if (!currentTrack) return;
    void copyText(currentTrack.sourceUrl, "track");
  }

  function queueStatus(index: number) {
    if (index === currentIndex) return isPlaying ? "PLAYING" : "LOADED";
    if (history.slice(0, historyCursor).includes(index)) return "VISITED";
    const nextIndex =
      history[historyCursor + 1] ??
      (shuffleOn ? upNext[0] : tracks.length ? (currentIndex + 1) % tracks.length : -1);
    if (index === nextIndex) return "UP NEXT";
    return "QUEUED";
  }

  return (
    <main
      className={`desktop ${currentTrack?.imageUrl ? "hasArtwork" : ""} ${isPlaying ? "isPlaying" : ""}`}
      style={artworkStyle}
    >
      <div className="ambientCanvas" aria-hidden="true">
        <div className="ambientArt ambientArtLeft" />
        <div className="ambientArt ambientArtRight" />
        <div className="ambientShard ambientShardOne" />
        <div className="ambientShard ambientShardTwo" />
        <div className="ambientVignette" />
      </div>
      <div className="desktopGlow" aria-hidden="true" />
      <div className="shortcut shortcutOne" aria-hidden="true">
        <span className="shortcutIcon">♫</span>
        <span>MY_MIXES</span>
      </div>
      <div className="shortcut shortcutTwo" aria-hidden="true">
        <span className="shortcutIcon">?</span>
        <span>README.TXT</span>
      </div>

      <div className="appStack">
        <header className="brandStrip">
          <p>YOUR SONGS // READY TO SHARE</p>
          <p className="online"><span aria-hidden="true" /> SIGNAL ONLINE</p>
        </header>

        <div className="workspaceGrid">
          <section className="window playerWindow" aria-label="MIXTAPE 98 media player">
            <div className="titleBar">
              <div className="titleIdentity">
                <span className="appIcon" aria-hidden="true">M</span>
                <span>MIXTAPE_98.EXE</span>
              </div>
              <div className="windowButtons" aria-hidden="true">
                <span>_</span><span>□</span><span>×</span>
              </div>
            </div>

            <nav className="menuBar" aria-label="Player menu">
              <button type="button" onClick={() => setShowBuilder((value) => !value)}>
                <u>F</u>ILE
              </button>
              <button type="button" onClick={reshuffle} disabled={!tracks.length}>
                <u>S</u>HUFFLE UP NEXT
              </button>
              <button
                type="button"
                onClick={() => setStatus("SHARE A MIX · VISIT PREVIOUS SONGS · PUBLIC OR LINK ONLY")}
              >
                <u>A</u>BOUT
              </button>
            </nav>

            <div className="playerBody">
              <div className={`lcdPanel ${currentTrack ? "hasTrack" : ""} ${showEmbedFallback ? "usesEmbed" : ""}`}>
                <div className="lcdTopline">
                  <span>{mixName || "RANDOM ACCESS MIX"}</span>
                  <span>
                    {currentTrack
                      ? `${String(currentIndex + 1).padStart(2, "0")}/${String(tracks.length).padStart(2, "0")}`
                      : "00/00"}
                  </span>
                </div>

                {currentTrack ? (
                  <>
                    <div className="nowPlayingGrid">
                      <div className={`coverFrame ${currentTrack.imageUrl ? "hasCover" : ""}`}>
                        <div className="coverArt" aria-hidden="true" />
                        <span className="coverFallback" aria-hidden="true">♫</span>
                        <span className="coverScan" aria-hidden="true" />
                      </div>
                      <div className="trackHeroCopy">
                        <p className="nowLabel">{metadataLoading ? "LOADING SONG" : isPlaying ? "NOW PLAYING" : "ON THE DECK"}</p>
                        <h1>{currentTrack.title}</h1>
                        <p className="artistLine">{currentTrack.artist}</p>
                        <div className="songBadges">
                          {currentTrack.modelVersion && <span>SUNO {currentTrack.modelVersion.toUpperCase()}</span>}
                          <span>{metadataLoading ? "LOADING" : currentTrack.availability === "processing" ? "STILL GENERATING" : showEmbedFallback ? "SUNO PLAYER" : "DIRECT AUDIO"}</span>
                        </div>
                        <div className="trackActions">
                          <a href={currentTrack.sourceUrl} target="_blank" rel="noreferrer">OPEN SONG ↗</a>
                          <button type="button" onClick={copyTrack}>{copied === "track" ? "COPIED ✓" : "COPY SONG URL"}</button>
                          <button type="button" onClick={refreshSong} disabled={metadataLoading}>REFRESH SONG</button>
                        </div>
                      </div>
                    </div>
                    {showEmbedFallback && embedUrl && (
                      <div className="embedStage">
                        <div className="embedLabel"><span>PLAY HERE</span><strong>Suno playback controls</strong></div>
                        <iframe
                          key={currentTrack.id}
                          ref={embedRef}
                          src={embedUrl}
                          title={`${currentTrack.title} — Suno player`}
                          loading="eager"
                          allow="autoplay; encrypted-media; fullscreen"
                          referrerPolicy="strict-origin-when-cross-origin"
                        />
                        <p className="providerHint">{currentTrack.message ?? "Use Play in this window. Next and Back below move through your mix."}</p>
                      </div>
                    )}

                    {!showEmbedFallback && (
                      <div className={`spectrum ${isPlaying ? "isPlaying" : ""}`} aria-hidden="true">
                        {BARS.map((height, index) => (
                          <span
                            key={`${height}-${index}`}
                            style={{
                              height: `${height}%`,
                              animationDelay: `${(index % 7) * -0.08}s`,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="emptyReadout">
                    <p className="nowLabel">RANDOM ACCESS AUDIO</p>
                    <h1>MIXTAPE_98</h1>
                    <p>SHUFFLE THE SONGS. SKIP THE SIGN-UP.</p>
                  </div>
                )}

                <div className="statusLine" role="status" aria-live="polite">
                  <span className={`statusDot ${metadataLoading ? "isLoading" : ""}`} aria-hidden="true" />
                  <span>{status}</span>
                </div>
              </div>

              <div className="seekRow">
                <span>{formatTime(currentTime)}</span>
                <input
                  type="range"
                  min="0"
                  max={Math.max(totalDuration, 0.1)}
                  step="0.1"
                  value={Math.min(currentTime, Math.max(totalDuration, 0.1))}
                  onChange={(event) => seekTrack(Number(event.target.value))}
                  disabled={!nativeReady}
                  aria-label="Seek through current song"
                  style={{
                    "--range-progress": `${totalDuration ? (currentTime / totalDuration) * 100 : 0}%`,
                  } as CSSProperties}
                />
                <span>{formatTime(totalDuration)}</span>
              </div>

              <div className="transportDeck">
                <div className="transportControls" aria-label="Playback controls">
                  <button
                    type="button"
                    className="transportButton"
                    onClick={goPrevious}
                    disabled={!tracks.length || historyCursor === 0}
                    aria-label="Previous visited song"
                    title="Previous visited song"
                  >
                    <span>◀|</span><small>BACK</small>
                  </button>
                  <button
                    type="button"
                    className="transportButton playButton"
                    onClick={() => void togglePlayback()}
                    disabled={!tracks.length || metadataLoading}
                    aria-label={showEmbedFallback ? "Focus Suno playback controls" : isPlaying ? "Pause current song" : "Play current song"}
                  >
                    <span>{showEmbedFallback ? "↑" : isPlaying ? "Ⅱ" : "▶"}</span>
                    <small>{showEmbedFallback ? "SUNO PLAY" : isPlaying ? "PAUSE" : "PLAY"}</small>
                  </button>
                  <button
                    type="button"
                    className="transportButton"
                    onClick={() => goNext(false)}
                    disabled={!tracks.length}
                    aria-label="Next song"
                    title="Next song"
                  >
                    <span>|▶</span><small>NEXT</small>
                  </button>
                  <button
                    type="button"
                    className="squareButton"
                    onClick={restartTrack}
                    disabled={!nativeReady}
                    aria-label="Restart current song"
                    title="Restart current song"
                  >
                    <span>↺</span><small>RESTART</small>
                  </button>
                  <button
                    type="button"
                    className={`squareButton ${shuffleOn ? "active" : ""}`}
                    onClick={toggleShuffle}
                    disabled={!tracks.length}
                    aria-label="Toggle shuffle"
                    aria-pressed={shuffleOn}
                    title="Toggle shuffle for future songs"
                  >
                    <span>⇄</span><small>SHUFFLE</small>
                  </button>
                  <button
                    type="button"
                    className={`squareButton ${copied === "mix" ? "copied" : ""}`}
                    onClick={copyMix}
                    disabled={!tracks.length}
                    aria-label="Copy shareable mix link"
                    title="Copy shareable mix link"
                  >
                    <span>{copied === "mix" ? "✓" : "↗"}</span><small>SHARE</small>
                  </button>
                </div>

                <label className="volumeControl">
                  <span>VOL</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(event) => {
                      const nextVolume = Number(event.target.value);
                      setVolume(nextVolume);
                      if (audioRef.current) audioRef.current.volume = nextVolume;
                    }}
                    disabled={!nativeReady}
                    aria-label="Volume"
                    style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
                  />
                </label>
              </div>

              <div className="embedHint">
                <span aria-hidden="true">i</span>
                <p>
                  {showEmbedFallback
                    ? "Suno handles play, pause, and seeking above. Use NEXT to advance; automatic next is available only for direct audio."
                    : "BACK returns to the previous song you visited. Direct audio uses these controls and advances automatically."}
                </p>
              </div>

              {manualCopy && <label className="manualCopy">Select and copy your link
                <input readOnly value={manualCopy} onFocus={event => event.target.select()} aria-label="Link to copy manually" />
              </label>}
              {currentTrack?.audioUrl && !nativeAudioFailed && (
                <audio
                  key={currentTrack.id}
                  ref={audioRef}
                  className="nativeAudio"
                  src={currentTrack.audioUrl}
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    const nextDuration = event.currentTarget.duration;
                    event.currentTarget.volume = volume;
                    if (Number.isFinite(nextDuration)) setDuration(nextDuration);
                  }}
                  onCanPlay={(event) => {
                    if (resumeAfterLoadRef.current) {
                      resumeAfterLoadRef.current = false;
                      void event.currentTarget.play().catch(() => {
                        setStatus("PRESS PLAY TO CONTINUE");
                      });
                    } else if (event.currentTarget.paused) {
                      setStatus("PLAYER READY · PRESS PLAY");
                    }
                  }}
                  onPlay={() => {
                    setIsPlaying(true);
                    setStatus("PLAYING");
                  }}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  onEnded={() => goNext(true)}
                  onError={() => {
                    resumeAfterLoadRef.current = false;
                    setIsPlaying(false);
                    setNativeAudioFailed(true);
                    setStatus("NATIVE AUDIO UNAVAILABLE · FALLBACK READY");
                  }}
                />
              )}
            </div>
          </section>

          <section className="window playlistWindow" aria-label={showBuilder ? "Mix builder" : "Playlist"}>
            <div className="titleBar compactTitleBar">
              <div className="titleIdentity">
                <span className="tinyIcon" aria-hidden="true">≡</span>
                <span>{showBuilder ? "NEW_MIX.WIZ" : `${mixName || "UNTITLED"}.M3U`}</span>
              </div>
              <button
                type="button"
                className="titleAction"
                onClick={() => setShowBuilder((value) => !value)}
              >
                {showBuilder ? (tracks.length ? "VIEW QUEUE" : "HIDE") : "EDIT LINKS"}
              </button>
            </div>

            {showBuilder ? (
              <div className="builderPanel">
                <div className="builderIntro">
                  <div>
                    <p className="eyebrow">BUILD A BROADCAST</p>
                    <h2>Paste your Suno song links.</h2>
                  </div>
                  <span className="stepBadge">01—50 TRACKS</span>
                </div>

                <label className="fieldLabel" htmlFor="mix-name">MIX TITLE</label>
                <input
                  id="mix-name"
                  className="textField"
                  value={mixName}
                  maxLength={48}
                  onChange={(event) => setMixName(event.target.value)}
                  placeholder="Midnight random access"
                />

                <label className="fieldLabel" htmlFor="song-links">SHORT, SONG, OR EMBED LINKS — ONE PER LINE</label>
                <textarea
                  id="song-links"
                  className="linkArea"
                  value={linkInput}
                  onChange={(event) => setLinkInput(event.target.value)}
                  placeholder={"https://suno.com/s/…\nhttps://suno.com/song/…\nhttps://suno.com/embed/…"}
                  spellCheck={false}
                />

                <div className="builderActions">
                  <button
                    type="button"
                    className="primaryButton"
                    onClick={() => void buildMix()}
                    disabled={isResolving}
                  >
                    <span aria-hidden="true">▶</span>
                    {isResolving ? "RESOLVING LINKS..." : "BUILD + SHUFFLE"}
                  </button>
                  <p>
                    Paste Public or Link Only songs from any Suno model. Each song uses the playback controls available for it.
                  </p>
                </div>
                {invalidCount > 0 && (
                  <div className="inputWarning" role="alert">
                    <p>{invalidCount} link{invalidCount === 1 ? "" : "s"} could not be resolved. Correct them below and rebuild, or view the accepted songs.</p>
                    <ul>{rejectedLinks.map(link => <li key={link}>{link}</li>)}</ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="queuePanel">
                <div className="queueHeader">
                  <div>
                    <span>#</span><span>PLAY PATH</span>
                  </div>
                  <div className="queueHeaderActions">
                    <button type="button" onClick={copyTrack} disabled={!currentTrack}>
                      {copied === "track" ? "SONG COPIED" : "COPY SONG"}
                    </button>
                    <button type="button" onClick={copyMix}>SHARE MIX</button>
                  </div>
                </div>
                <ol className="trackList">
                  {queueOrder.map((trackIndex, queuePosition) => {
                    const track = tracks[trackIndex];
                    const active = trackIndex === currentIndex;
                    const rowArtwork = track.imageUrl
                      ? ({ backgroundImage: `url(${JSON.stringify(track.imageUrl)})` } as CSSProperties)
                      : undefined;
                    return (
                      <li key={track.id} className={active ? "activeTrack" : ""}>
                        <button type="button" onClick={() => selectTrack(trackIndex)} aria-current={active ? "true" : undefined}>
                          <span className="trackNumber">{active ? "▶" : String(queuePosition + 1).padStart(2, "0")}</span>
                          <span className={`rowCover ${track.imageUrl ? "hasCover" : ""}`} style={rowArtwork} aria-hidden="true">♫</span>
                          <span className="rowCopy">
                            <strong>{track.title}</strong>
                            <small>{track.artist}{track.modelVersion ? ` · ${track.modelVersion}` : ""} · {formatTime(track.duration ?? 0)}</small>
                          </span>
                          <span className="rowStatus">{queueStatus(trackIndex)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                <div className="queueFooter">
                  <span>{tracks.length} FILE{tracks.length === 1 ? "" : "S"}</span>
                  <span>{shuffleOn ? "RANDOMIZED FUTURE" : "SOURCE ORDER"} · SESSION HISTORY</span>
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="infoRail" aria-label="How MIXTAPE 98 works">
          <div><span>01</span><p><strong>PLAY</strong> inside the song’s available player.</p></div>
          <div><span>02</span><p><strong>BACK</strong> returns to the previous visited song.</p></div>
          <div><span>03</span><p><strong>SHARE</strong> the exact mix and starting song.</p></div>
        </section>

        <footer>
          <p>MIXTAPE_98 // MADE FOR SONGS THAT DESERVE A LISTEN</p>
          <p><a href="https://github.com/ObDixilis/mixtape-98" target="_blank" rel="noreferrer">OPEN SOURCE ↗</a> · Independent of Suno</p>
        </footer>
      </div>
    </main>
  );
}
