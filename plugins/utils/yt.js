const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const axios = require("axios");

const TEMP_DIR = path.join(os.tmpdir(), "yt-bot-temp");
const SPOTIFY_BASE = "https://api-faa.my.id"; // metadata only (title/artist/thumbnail), unrelated to the YT CDN issue

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Runs yt-dlp with the given args, returns stdout. maxBuffer bumped up since
// --dump-json output for a video with many formats can be large.
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      args,
      { maxBuffer: 1024 * 1024 * 30, timeout: 90000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        resolve(stdout);
      }
    );
  });
}

/**
 * Search YouTube (yt-dlp's own search extractor, flat/fast mode)
 */
async function searchYoutube(query, limit = 10) {
  const stdout = await runYtDlp([
    `ytsearch${limit}:${query}`,
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
  ]);

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((v) => ({
      title: v.title,
      duration: v.duration,
      views: v.view_count,
      uploadedAt: null,
      channel: { name: v.channel || v.uploader },
      url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
      thumbnail: v.thumbnails?.at(-1)?.url || v.thumbnail,
    }));
}

const VIDEO_QUALITIES = ["1080", "720", "480", "360", "240", "144"];

/**
 * Get video metadata + which of the standard qualities are actually
 * available for this video (based on real format heights)
 */
async function getVideoInfo(url) {
  const stdout = await runYtDlp(["--dump-json", "--no-warnings", url]);
  const data = JSON.parse(stdout);

  const availableHeights = new Set(
    (data.formats || [])
      .filter((f) => f.vcodec && f.vcodec !== "none" && f.height)
      .map((f) => f.height)
  );

  const formats = VIDEO_QUALITIES.filter((q) => availableHeights.has(Number(q))).map(
    (q) => ({ type: "video", quality: `${q}p`, size: null })
  );

  return {
    title: data.title,
    videoId: data.id,
    channel: { name: data.channel || data.uploader },
    thumbnail: data.thumbnail,
    formats,
  };
}

/**
 * Download a specific video quality (e.g. "720p"). yt-dlp downloads
 * directly to disk on this same server — no cross-IP redirect, no 403s.
 */
async function downloadVideo(url, quality) {
  const heightNum = String(quality).replace(/p$/i, "");
  const uid = Date.now();
  const outputTemplate = path.join(TEMP_DIR, `${uid}.%(ext)s`);

  const info = await getVideoInfo(url);

  await runYtDlp([
    "-f",
    `bestvideo[height<=${heightNum}]+bestaudio/best[height<=${heightNum}]`,
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    "--no-warnings",
    url,
  ]);

  return { path: path.join(TEMP_DIR, `${uid}.mp4`), title: info.title };
}

/**
 * Download audio (mp3) directly via yt-dlp + ffmpeg extraction
 */
async function downloadAudio(url) {
  const uid = Date.now();
  const outputTemplate = path.join(TEMP_DIR, `${uid}.%(ext)s`);

  const info = await getVideoInfo(url);

  await runYtDlp([
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "128K",
    "-o",
    outputTemplate,
    "--no-warnings",
    url,
  ]);

  return {
    path: path.join(TEMP_DIR, `${uid}.mp3`),
    title: info.title,
    info: { channel: info.channel, thumbnail: info.thumbnail },
  };
}

async function downloadFile(fileUrl, filename) {
  const destPath = path.join(TEMP_DIR, `${Date.now()}_${(filename || "file").replace(/[\\/:*?"<>|]/g, "").slice(0, 80)}`);
  const response = await axios.get(fileUrl, {
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
 * Spotify: get title/artist/thumbnail from the metadata API, then find and
 * download the matching track from YouTube via yt-dlp (reliable + no CDN issues)
 */
async function spotifyTrack(url) {
  const { data } = await axios.get(`${SPOTIFY_BASE}/faa/aio`, {
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
