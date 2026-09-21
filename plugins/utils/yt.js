const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const BASE = "https://jerrycoder.oggyapi.workers.dev";
const TEMP_DIR = path.join(os.tmpdir(), "yt-bot-temp");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const api = axios.create({
  headers: BROWSER_HEADERS,
  timeout: 20000,
});

// Calls the API with browser-like headers, retrying once on a transient
// server error (502/503/504/timeout) — Cloudflare Workers occasionally
// bounce a request, a single retry after a short wait clears most of these.
async function apiGet(endpoint, params, retries = 1) {
  try {
    const { data } = await api.get(`${BASE}${endpoint}`, { params });
    return data;
  } catch (error) {
    const status = error.response?.status;
    const isTransient = !status || [502, 503, 504].includes(status);
    if (isTransient && retries > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return apiGet(endpoint, params, retries - 1);
    }
    throw new Error(`API error: ${status || error.message}`);
  }
}

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function safeName(str) {
  return (str || "file")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 80);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

// Downloads a remote file (direct CDN link) to a local temp path
async function downloadFile(url, filename) {
  const destPath = path.join(TEMP_DIR, `${Date.now()}_${safeName(filename)}`);
  const response = await axios.get(url, {
    responseType: "stream",
    headers: BROWSER_HEADERS,
    timeout: 60000,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return destPath;
}

/**
 * Search YouTube
 * @param {string} query
 * @param {number} limit
 */
async function searchYoutube(query, limit = 10) {
  const data = await apiGet("/search/youtube", { q: query });

  if (!data || data.status !== "success" || !Array.isArray(data.result)) {
    return [];
  }

  return data.result.slice(0, limit).map((v) => ({
    title: v.title,
    duration: v.duration,
    views: null, // not provided by this API
    uploadedAt: null, // not provided by this API
    channel: { name: v.channel },
    url: v.link,
    thumbnail: v.imageUrl,
  }));
}

/**
 * Get full video info + all available qualities
 * @param {string} url
 */
async function getVideoInfo(url) {
  const data = await apiGet("/down/youtube", { url });

  if (!data || data.status !== "success") {
    throw new Error("Failed to fetch video info");
  }

  const durationSec = data.duration || 0;

  // Normalize video formats: "mp4 (720p)" -> "720p", estimate size from bitrate
  const seen = new Set();
  const videoFormats = (data.medias || [])
    .filter((m) => m.type === "video")
    .sort((a, b) => (a.ext === "mp4" ? -1 : 1)) // prefer mp4 over webm on duplicates
    .map((m) => {
      const qMatch = (m.quality || m.label || "").match(/(\d+p)/);
      const quality = qMatch ? qMatch[1] : m.quality;
      const bytes = m.bitrate ? (m.bitrate / 8) * durationSec : 0;
      return {
        type: "video",
        quality,
        size: formatBytes(bytes),
        url: m.url,
        ext: m.ext,
      };
    })
    .filter((f) => {
      if (seen.has(f.quality)) return false;
      seen.add(f.quality);
      return true;
    });

  // This API has no dedicated audio-only stream; audio is fetched separately
  // via /down/ytmp3 at download time. This entry just makes the "Audio Only"
  // option show up in the quality list.
  const audioFormat = { type: "audio", quality: "Audio", size: null };

  return {
    title: data.title,
    videoId: null, // youtube.js falls back to extracting this from the url itself
    channel: { name: data.channel },
    thumbnail: data.thumbnail,
    formats: [...videoFormats, audioFormat],
  };
}

/**
 * Download a specific video quality (e.g. "720p", "360p")
 * @param {string} url
 * @param {string} quality
 */
async function downloadVideo(url, quality) {
  const data = await apiGet("/down/youtube", { url });

  if (!data || data.status !== "success") {
    throw new Error("Failed to fetch video info");
  }

  const media = (data.medias || [])
    .filter((m) => m.type === "video")
    .sort((a, b) => (a.ext === "mp4" ? -1 : 1))
    .find((m) => (m.quality || m.label || "").includes(quality));

  if (!media) {
    // fall back to the quick single-quality endpoint (usually 720p)
    const alt = await apiGet("/down/ytmp4-v1", { url });
    if (!alt || alt.status !== "success" || !alt.url) {
      throw new Error(`Quality ${quality} not available`);
    }
    const filePath = await downloadFile(alt.url, `${alt.title}.mp4`);
    return { path: filePath, title: alt.title };
  }

  const filePath = await downloadFile(media.url, `${data.title}.${media.ext}`);
  return { path: filePath, title: data.title };
}

/**
 * Download audio (mp3) for a YouTube link
 * @param {string} url
 */
async function downloadAudio(url) {
  const data = await apiGet("/down/ytmp3", { url });

  if (!data || data.status !== "success" || !data.url) {
    throw new Error("Failed to fetch audio");
  }

  const filePath = await downloadFile(data.url, `${data.title}.mp3`);

  // Best-effort extra call to get channel + thumbnail for ID3 tagging.
  // If it fails, we still return the audio file successfully.
  let info = {};
  try {
    const videoInfo = await getVideoInfo(url);
    info = { channel: videoInfo.channel, thumbnail: videoInfo.thumbnail };
  } catch (_) {
    // ignore, tagging will just skip channel/thumbnail
  }

  return { path: filePath, title: data.title, info };
}

/**
 * Tags an mp3 with title / artist / cover art using ffmpeg.
 * Kept under the old name so youtube.js doesn't need to change its calls.
 * (The API above already returns real mp3s, so this only adds metadata now.)
 */
async function convertM4aToMp3(audioPath, meta = {}) {
  const { title, artist, thumbnail } = meta;
  const outputPath = audioPath.replace(/\.[^.]+$/, "") + "_tagged.mp3";

  let coverPath = null;
  if (thumbnail) {
    try {
      coverPath = await downloadFile(thumbnail, "cover.jpg");
    } catch (_) {
      coverPath = null;
    }
  }

  const args = ["-y", "-i", audioPath];
  if (coverPath) args.push("-i", coverPath);
  args.push("-map", "0:a");
  if (coverPath) args.push("-map", "1:0", "-c:v", "mjpeg", "-disposition:v", "attached_cover");
  args.push("-c:a", "copy", "-id3v2_version", "3");
  if (title) args.push("-metadata", `title=${title}`);
  if (artist) args.push("-metadata", `artist=${artist}`);
  args.push(outputPath);

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });

  // cleanup originals
  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);

  return outputPath;
}

/**
 * Get Spotify track title/artist/thumbnail
 * @param {string} url
 */
async function spotifyTrack(url) {
  const data = await apiGet("/down/spotify", { url });

  if (!data || data.status !== "success") {
    throw new Error("Failed to fetch Spotify track info");
  }

  return {
    title: data.title,
    artist: data.artist,
    thumbnail: data.thumbnail,
  };
}

module.exports = {
  searchYoutube,
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  convertM4aToMp3,
  spotifyTrack,
};
