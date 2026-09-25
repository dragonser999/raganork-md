const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

// Updated API Base URLs
const SEARCH_BASE = "https://zellrayy.com";
const SPOTIFY_BASE = "https://zellrayy.com";
const YT_QUALITY_BASE = "https://yt-quality-api.vercel.app";
const YT_SINGLE_BASE = "https://api.nexray.eu.cc";

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

// Helper to make API requests with retry mechanism
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
  const data = await apiGet(`${SEARCH_BASE}/search/youtube`, { q: query });

  if (!data || !data.status || !Array.isArray(data.result)) return [];

  return data.result.slice(0, limit).map((v) => ({
    title: v.title,
    duration: v.duration,
    views: v.views,
    uploadedAt: v.published,
    channel: { name: v.channel?.name },
    url: v.url,
    thumbnail: v.thumbnail,
  }));
}

/**
 * Fetch video metadata & formats using new API endpoints provided in the doc
 */
async function getVideoInfo(url) {
  let resData;
  
  // First try the quality options API
  try {
    resData = await apiGet(`${YT_QUALITY_BASE}/api/ytmp4`, { url });
  } catch (e) {
    // Fallback to single resolusi API
    resData = await apiGet(`${YT_SINGLE_BASE}/downloader/v1/ytmp4`, { url, resolusi: "1080" });
  }

  if (!resData || !resData.status || !resData.result) {
    throw new Error("Failed to fetch video info");
  }

  const r = resData.result;
  const formats = [];

  if (r.downloads && Array.isArray(r.downloads)) {
    r.downloads.forEach((item) => {
      formats.push({
        type: "video",
        quality: item.quality,
        size: null,
        url: item.url,
      });
    });
  } else if (r.url) {
    formats.push({
      type: "video",
      quality: r.quality || "default",
      size: null,
      url: r.url,
    });
  }

  // Audio track format fallback using lowest video quality stream or single stream URL
  const audioUrl = r.downloads && r.downloads.length > 0
    ? r.downloads[r.downloads.length - 1].url
    : r.url;

  if (audioUrl) {
    formats.push({
      type: "audio",
      quality: "audio",
      size: null,
      url: audioUrl,
    });
  }

  return {
    title: r.title,
    videoId: null,
    channel: { name: r.author },
    thumbnail: r.thumbnail || null,
    formats,
  };
}

/**
 * Download video in specified quality
 */
async function downloadVideo(url, quality) {
  const info = await getVideoInfo(url);
  let match = info.formats.find((f) => f.type === "video" && f.quality === quality);

  if (!match) {
    // Fallback to first available video format
    match = info.formats.find((f) => f.type === "video");
  }

  if (!match) throw new Error(`Video format not available`);

  const filePath = await downloadFile(match.url, `${info.title}.mp4`);
  return { path: filePath, title: info.title };
}

/**
 * Download audio track
 */
async function downloadAudio(url) {
  const info = await getVideoInfo(url);
  const audio = info.formats.find((f) => f.type === "audio");

  if (!audio) throw new Error("Audio not available");

  const filePath = await downloadFile(audio.url, `${info.title}.mp3`);

  return {
    path: filePath,
    title: info.title,
    info: { channel: info.channel, thumbnail: info.thumbnail },
  };
}

/**
 * Spotify track info
 */
async function spotifyTrack(url) {
  const data = await apiGet(`${SPOTIFY_BASE}/download/spotify`, { url });

  if (!data || !data.status || !data.result) {
    throw new Error("Failed to fetch Spotify track info");
  }

  const r = data.result;
  return {
    title: r.title,
    artist: r.artist,
    thumbnail: r.cover || null,
    downloadUrl: r.download || null,
  };
}

/**
 * Download Spotify track
 */
async function downloadSpotifyTrack(spotifyUrl) {
  const track = await spotifyTrack(spotifyUrl);
  if (!track.downloadUrl) throw new Error("No downloadable audio found");

  const filePath = await downloadFile(track.downloadUrl, `${track.title}.mp3`);
  return {
    path: filePath,
    title: track.title,
    info: { channel: { name: track.artist }, thumbnail: track.thumbnail },
  };
}

/**
 * Converts audio & adds ID3 tags using ffmpeg
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
  args.push("-c:a", "libmp3lame", "-id3v2_version", "3");
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
