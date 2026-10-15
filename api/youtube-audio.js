const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const MAX_PROXY_CHUNK = 4 * 1024 * 1024; // Keep below Vercel's 4.5 MB response limit.

const YT_CLIENTS = ["WEB", "ANDROID", "YTMUSIC", "YTMUSIC_ANDROID", "TV_EMBEDDED"];
let ytClientPromise = null;

async function getYouTubeClient() {
  if (!ytClientPromise) {
    ytClientPromise = import("youtubei.js").then(({ Innertube }) =>
      Innertube.create({
        lang: "en",
        location: "US",
        generate_session_locally: false,
      })
    );
  }
  return ytClientPromise;
}

function getFormatValue(format, ...keys) {
  for (const key of keys) {
    const value = format?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

async function resolveAudio(rawUrl) {
  const videoId = extractVideoId(rawUrl);
  const yt = await getYouTubeClient();
  const errors = [];

  for (const client of YT_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });

      let format =
        info.chooseFormat({ type: "audio", quality: "best", format: "mp4", codec: "mp4a" }) ||
        info.chooseFormat({ type: "audio", quality: "best", format: "mp4" }) ||
        info.chooseFormat({ type: "audio", quality: "best" });

      if (!format) throw new Error("No compatible audio-only stream was found.");

      const audioUrl = typeof format.decipher === "function"
        ? await format.decipher(yt.session.player)
        : getFormatValue(format, "url");

      if (!audioUrl) throw new Error("YouTube returned an audio format without a usable stream URL.");

      const mimeType = String(getFormatValue(format, "mime_type", "mimeType") || "audio/mp4")
        .split(";")[0]
        .trim();

      const contentLengthRaw = getFormatValue(format, "content_length", "contentLength");
      const contentLength = Number(contentLengthRaw);
      const durationMs =
        Number(getFormatValue(format, "approx_duration_ms", "approxDurationMs")) ||
        Number(info?.basic_info?.duration) * 1000 ||
        0;
      const title = String(info?.basic_info?.title || "YouTube Podcast");

      return {
        videoId,
        title,
        audioUrl,
        mimeType,
        contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
        durationSeconds: durationMs > 0 ? durationMs / 1000 : null,
      };
    } catch (error) {
      const message = error?.message || String(error);
      errors.push(client + ": " + message);
      console.warn("YouTube client " + client + " failed:", error);
    }
  }

  throw new Error("YouTube could not provide a playable audio stream. Attempts: " + errors.join(" | "));
}

function validateProxySource(rawSource) {
  const source = new URL(rawSource);
  const host = source.hostname.toLowerCase();
  const allowed = host === "googlevideo.com" || host.endsWith(".googlevideo.com");
  if (source.protocol !== "https:" || !allowed) {
    throw new Error("Invalid audio source.");
  }
  return source;
}

function parseRangeHeader(value, totalLength) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(value || ""));
  if (!match) throw new Error("Invalid byte range.");

  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), totalLength ? totalLength - 1 : start + MAX_PROXY_CHUNK - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error("Invalid byte range.");
  }
  if (end - start + 1 > MAX_PROXY_CHUNK) {
    throw new Error("Requested range is too large.");
  }
  return { start, end };
}

async function proxyAudio(req, res) {
  let body = req.body;
  if (typeof body === "string") body = JSON.parse(body || "{}");

  const source = validateProxySource(body?.url);
  const range = parseRangeHeader(body?.range, Number(body?.totalLength) || 0);

  const upstream = await fetch(source, {
    headers: {
      Range: `bytes=${range.start}-${range.end}`,
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.youtube.com/",
    },
  });

  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`YouTube audio stream returned HTTP ${upstream.status}.`);
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > MAX_PROXY_CHUNK) throw new Error("Upstream chunk exceeded the proxy limit.");

  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader("Content-Type", String(upstream.headers.get("content-type") || "application/octet-stream"));
  res.setHeader("Content-Length", String(buffer.length));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "bytes");
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);
  res.end(buffer);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const rawUrl = String(req.query?.url || "");
      if (!rawUrl) return json(res, 400, { error: "Missing YouTube URL." });
      const data = await resolveAudio(rawUrl);
      return json(res, 200, data);
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (body.action !== "proxy") return json(res, 400, { error: "Unsupported action." });
      await proxyAudio(req, res);
      return;
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error("youtube-audio error:", error);
    return json(res, 400, { error: error?.message || "YouTube audio extraction failed." });
  }
}
