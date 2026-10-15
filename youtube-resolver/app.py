import json
import os
import subprocess
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Query

app = FastAPI(title="AI Audio Transcriber YouTube Resolver")

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
RESOLVER_API_KEY = os.getenv("RESOLVER_API_KEY", "").strip()


def validate_youtube_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or (host not in YOUTUBE_HOSTS and not host.endswith(".youtube.com")):
        raise HTTPException(status_code=400, detail="Only HTTPS YouTube URLs are supported.")
    if len(raw_url) > 2048:
        raise HTTPException(status_code=400, detail="URL is too long.")
    return raw_url


def run_ytdlp(raw_url: str) -> dict:
    command = [
        "yt-dlp", "--no-playlist", "--no-warnings", "--no-progress",
        "--skip-download", "--dump-single-json", "--format", "bestaudio/best",
        "--extractor-args", "youtubepot-bgutilscript:script_path=/opt/bgutil/server/build/generate_once.js",
        "--extractor-args", "youtube:player-client=mweb",
        raw_url,
    ]

    result = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "yt-dlp failed").strip()
        raise HTTPException(status_code=502, detail=detail[-4000:])

    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise HTTPException(status_code=502, detail="yt-dlp returned no metadata.")

    try:
        info = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="yt-dlp returned invalid JSON.") from exc

    fmt = (info.get("requested_formats") or [info])[0]
    audio_url = fmt.get("url")
    if not audio_url:
        raise HTTPException(status_code=502, detail="yt-dlp did not return an audio stream URL.")

    content_length = fmt.get("filesize") or fmt.get("filesize_approx")
    return {
        "videoId": info.get("id"),
        "title": info.get("title") or "YouTube Podcast",
        "audioUrl": audio_url,
        "mimeType": str(fmt.get("mime_type") or "audio/mp4").split(";", 1)[0].strip(),
        "contentLength": int(content_length) if content_length else None,
        "durationSeconds": float(info["duration"]) if info.get("duration") else None,
    }


@app.get("/")
def health():
    return {"ok": True, "service": "youtube-resolver"}


@app.get("/resolve")
def resolve(url: str = Query(..., min_length=1), x_resolver_key: str | None = Header(default=None)):
    if RESOLVER_API_KEY and x_resolver_key != RESOLVER_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized.")
    return run_ytdlp(validate_youtube_url(url))
