const MAX_PROXY_CHUNK = 4 * 1024 * 1024;

function json(res, status, body, extraHeaders = {}) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function extractVideoId(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();

  if (!(host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" ||
        host === "music.youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com"))) {
    throw new Error("Only YouTube URLs are supported.");
  }

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (id) return id;
  }

  const queryId = url.searchParams.get("v");
  if (queryId) return queryId;

  const parts = url.pathname.split("/").filter(Boolean);
  const markerIndex = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
  if (markerIndex >= 0 && parts[markerIndex + 1]) return parts[markerIndex + 1];

  throw new Error("Could not find a YouTube video ID in that URL.");
}

function getResolverUrl() {
  const value = String(process.env.YOUTUBE_RESOLVER_URL || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("YouTube resolver is not configured.");
  return value;
}

async function resolveWithExternalResolver(rawUrl) {
  const target = new URL("/resolve", getResolverUrl());
  target.searchParams.set("url", rawUrl);

  const headers = { Accept: "application/json" };
  const apiKey = String(process.env.YOUTUBE_RESOLVER_API_KEY || "").trim();
  if (apiKey) headers["X-Resolver-Key"] = apiKey;

  const upstream = await fetch(target, { headers });
  const bodyText = await upstream.text();

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { error: bodyText || "Resolver returned an invalid response." };
  }

  if (!upstream.ok) {
    throw new Error(body?.detail || body?.error || `YouTube resolver HTTP ${upstream.status}`);
  }
  if (!body?.audioUrl) throw new Error("Resolver did not return an audio stream.");

  return body;
}

function validateProxySource(rawSource) {
  const source = new URL(rawSource);
  const host = source.hostname.toLowerCase();
  const allowed = host === "googlevideo.com" || host.endsWith(".googlevideo.com");
  if (source.protocol !== "https:" || !allowed) throw new Error("Invalid audio source.");
  return source;
}

function parseRangeHeader(value, totalLength) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(value || ""));
  if (!match) throw new Error("Invalid byte range.");

  const start = Number(match[1]);
  const end = Math.min(match[2], totalLength ? totalLength - 1 : start + MAX_PROXY_CHUNK - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error("Invalid byte range.");
  }
  if (end - start + 1 > MAX_PROXY_CHUNK) throw new Error("Requested range is too large.");
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

      extractVideoId(rawUrl);
      return json(res, 200, await resolveWithExternalResolver(rawUrl));
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
