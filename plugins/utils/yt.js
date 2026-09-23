const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const BASE = "https://metropolitan-lauri-anuansad-5e57a404.koyeb.app";

const TEMP_DIR = path.join(os.tmpdir(), "yt-bot-temp");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const api = axios.create({ headers: BROWSER_HEADERS, timeout: 45000 });

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function safeName(str) {
  return (str || "file").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80);
}

// GET with browser headers + 1 retry on transient errors (502/503/504/timeout)
async function apiGet(url, params, retries = 1) {
  try {
    const { data } = await api.get(url, { params });
    return data;
  } catch (error) {
    const status = error.response?.status;
    const isTransient = !status || [502, 503, 504].includes(status);
    if (isTransient && retries > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return apiGet(url, params, retries - 1);
    }
    throw new Error(`API error: ${status || error.message}`);
  }
}

async function downloadFile(url, filename) {
  const destPath = path.join(TEMP_DIR, `${Date.now()}_${safeName(filename)}`);
  const response = await axios.get(url, {
    responseType: "stream",
    headers: BROWSER_HEADERS,
    timeout: 90000,
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
 */
async function searchYoutube(query, limit = 10) {
  const data = await apiGet(`${BASE}/api/search`, { q: query });

  if (!data || data.status !== "success" || !Array.isArray(data.result)) return [];

  return data.result.slice(0, limit).map((v) => ({
    title: v.title,
    duration: v.duration,
    views: null,
    uploadedAt: null,
    channel: { name: v.channel },
    url: v.link,
    thumbnail: v.imageUrl,
  }));
}

/**
 * Get video metadata + every available quality (video + audio).
 * Each entry's "url" is this API's own /api/fetch proxy link — not a raw
 * googlevideo link — so downloading it doesn't hit the cross-IP 403 issue.
 */
async function getVideoInfo(url) {
  const data = await apiGet(`${BASE}/api/info`, { url });

  if (!data || !data.status || !data.result) {
    throw new Error("Failed to fetch video info");
  }

  const r = data.result;

  const formats = (r.downloads || []).map((d) => ({
    type: d.format === "mp3" ? "audio" : "video",
    quality: d.quality, // e.g. "720p" or "Audio (192kbps)"
    size: null,
    url: d.url,
  }));

  return {
    title: r.title,
    videoId: r.videoId,
    thumbnail: r.thumbnail,
    formats,
  };
}

/**
 * Download a specific video quality (e.g. "720p")
 */
async function downloadVideo(url, quality) {
  const info = await getVideoInfo(url);
  const match = info.formats.find(
    (f) => f.type === "video" && f.quality.includes(quality)
  );

  if (!match) throw new Error(`Quality ${quality} not available`);

  const filePath = await downloadFile(match.url, `${info.title}.mp4`);
  return { path: filePath, title: info.title };
}

/**
 * Download audio (mp3)
 */
async function downloadAudio(url) {
  const info = await getVideoInfo(url);
  const audio = info.formats.find((f) => f.type === "audio");

  if (!audio) throw new Error("Audio not available");

  const filePath = await downloadFile(audio.url, `${info.title}.mp3`);

  return {
    path: filePath,
    title: info.title,
    info: { channel: { name: null }, thumbnail: info.thumbnail },
  };
}

/**
 * Spotify: no dedicated endpoint on this API, so we get title/artist from
 * a lightweight metadata lookup, then search + download the matching
 * track from YouTube using the same reliable API above.
 */
async function spotifyTrack(url) {
  const { data } = await axios.get("https://api-faa.my.id/faa/aio", {
    params: { url },
    headers: BROWSER_HEADERS,
    timeout: 20000,
  });

  if (!data || !data.status || !data.result) {
    throw new Error("Failed to fetch Spotify track info");
  }

  const r = data.result;
  return { title: r.title, artist: r.artist, thumbnail: r.thumbnail || null };
}

async function downloadSpotifyTrack(spotifyUrl) {
  const track = await spotifyTrack(spotifyUrl);
  const query = `${track.title} ${track.artist || ""}`.trim();

  const results = await searchYoutube(query, 1);
  if (!results.length) throw new Error("No matching track found on YouTube");

  const result = await downloadAudio(results[0].url);
  return {
    path: result.path,
    title: track.title,
    info: {
      channel: { name: track.artist },
      thumbnail: track.thumbnail || result.info?.thumbnail,
    },
  };
}

/**
 * Tags an mp3 with title / artist / cover art using ffmpeg.
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
  if (coverPath) args.push("-map", "1:0", "-c:v", "mjpeg", "-disposition:v", "attached_pic");
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

  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);

  return outputPath;
}

module.exports = {
  searchYoutube,
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  convertM4aToMp3,
  spotifyTrack,
  downloadSpotifyTrack,
};
