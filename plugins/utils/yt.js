const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const axios = require("axios");

const TEMP_DIR = path.join(os.tmpdir(), "yt-bot-temp");

const YTDLP_BIN = "/opt/ytdlp/bin/yt-dlp";
const DENO_BIN = "/root/.deno/bin/deno";
const COOKIES_FILE = "/root/youtube-cookies.txt";

const SPOTIFY_BASE = "https://api-faa.my.id";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36",
};

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function hasCookies() {
  try {
    return (
      fs.existsSync(COOKIES_FILE) &&
      fs.statSync(COOKIES_FILE).size > 0
    );
  } catch {
    return false;
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const finalArgs = [
      "--js-runtimes",
      `deno:${DENO_BIN}`,

      "--no-warnings",
      "--no-playlist",

      ...(hasCookies()
        ? ["--cookies", COOKIES_FILE]
        : []),

      ...args,
    ];

    execFile(
      YTDLP_BIN,
      finalArgs,
      {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 180000,

        env: {
          ...process.env,
          PATH:
            `/root/.deno/bin:/opt/ytdlp/bin:` +
            `${process.env.PATH || ""}`,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          return reject(
            new Error(
              (stderr || error.message).trim()
            )
          );
        }

        resolve(stdout);
      }
    );
  });
}

/* =========================
   YOUTUBE SEARCH
========================= */

async function searchYoutube(query, limit = 10) {
  try {
    const output = await runYtDlp([
      `ytsearch${limit}:${query}`,
      "--flat-playlist",
      "--dump-json",
      "--skip-download",
    ]);

    const lines = output
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const data = JSON.parse(line);

      return {
        title: data.title || "Unknown",
        duration: data.duration || 0,
        views: data.view_count || 0,
        channel:
          data.channel ||
          data.uploader ||
          "Unknown",

        url:
          data.webpage_url ||
          (data.id
            ? `https://www.youtube.com/watch?v=${data.id}`
            : null),

        thumbnail:
          data.thumbnail ||
          (data.id
            ? `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`
            : null),
      };
    });
  } catch (error) {
    throw new Error(
      `YouTube search failed: ${error.message}`
    );
  }
}

/* =========================
   VIDEO QUALITIES
========================= */

const VIDEO_QUALITIES = [
  "1440",
  "1080",
  "720",
  "480",
  "360",
  "240",
  "144",
];

/* =========================
   VIDEO INFO
========================= */

async function getVideoInfo(url) {
  try {
    const output = await runYtDlp([
      "--dump-single-json",
      "--skip-download",
      url,
    ]);

    const data = JSON.parse(output);

    const formats = Array.isArray(data.formats)
      ? data.formats
      : [];

    const availableHeights = [
      ...new Set(
        formats
          .map((format) => Number(format.height))
          .filter(
            (height) =>
              Number.isFinite(height) &&
              height > 0
          )
      ),
    ].sort((a, b) => b - a);

    return {
      id: data.id,

      title:
        data.title ||
        "YouTube Video",

      duration:
        data.duration || 0,

      uploader:
        data.uploader ||
        data.channel ||
        "Unknown",

      thumbnail:
        data.thumbnail || null,

      webpage_url:
        data.webpage_url || url,

      formats:
        availableHeights,
    };
  } catch (error) {
    throw new Error(
      `Unable to get video info: ${error.message}`
    );
  }
}

/* =========================
   QUALITY PARSER
========================= */

function getRequestedHeight(quality) {
  const requested = parseInt(
    String(quality).replace("p", ""),
    10
  );

  if (!Number.isFinite(requested)) {
    return 720;
  }

  return requested;
}

/* =========================
   VIDEO DOWNLOAD
========================= */

async function downloadVideo(
  url,
  quality = "720"
) {
  const height =
    getRequestedHeight(quality);

  const outputPath = path.join(
    TEMP_DIR,
    `video_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}.mp4`
  );

  try {
    await runYtDlp([
      "-f",

      `bestvideo[height<=${height}]+bestaudio/` +
        `best[height<=${height}]/best`,

      "--merge-output-format",
      "mp4",

      "-o",
      outputPath,

      url,
    ]);

    if (!fs.existsSync(outputPath)) {
      throw new Error(
        "Downloaded video file was not created."
      );
    }

    return outputPath;
  } catch (error) {
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch (_) {}

    throw new Error(
      `Video download failed: ${error.message}`
    );
  }
}

/* =========================
   AUDIO DOWNLOAD
========================= */

async function downloadAudio(url) {
  const outputPath = path.join(
    TEMP_DIR,
    `audio_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}.mp3`
  );

  try {
    await runYtDlp([
      "-x",

      "--audio-format",
      "mp3",

      "--audio-quality",
      "128K",

      "-o",
      outputPath,

      url,
    ]);

    if (!fs.existsSync(outputPath)) {
      throw new Error(
        "Downloaded audio file was not created."
      );
    }

    return outputPath;
  } catch (error) {
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch (_) {}

    throw new Error(
      `Audio download failed: ${error.message}`
    );
  }
}

/* =========================
   GENERIC FILE DOWNLOAD
========================= */

async function downloadFile(
  url,
  outputPath
) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    headers: BROWSER_HEADERS,
    timeout: 120000,
  });

  await new Promise(
    (resolve, reject) => {
      const writer =
        fs.createWriteStream(outputPath);

      response.data.pipe(writer);

      writer.on("finish", resolve);
      writer.on("error", reject);

      response.data.on(
        "error",
        reject
      );
    }
  );

  return outputPath;
}

/* =========================
   SPOTIFY
========================= */

async function spotifySearch(query) {
  try {
    const url =
      `${SPOTIFY_BASE}/faa/aio` +
      `?url=${encodeURIComponent(query)}`;

    const response =
      await axios.get(url, {
        timeout: 30000,
        headers: BROWSER_HEADERS,
      });

    return response.data;
  } catch (error) {
    throw new Error(
      `Spotify API failed: ${error.message}`
    );
  }
}

/* =========================
   SPOTIFY TRACK DOWNLOAD
========================= */

async function downloadSpotifyTrack(query) {
  try {
    const spotifyData =
      await spotifySearch(query);

    const title =
      spotifyData?.title ||
      spotifyData?.name ||
      query;

    const artist =
      spotifyData?.artist ||
      spotifyData?.artists ||
      "";

    const searchQuery =
      `${title} ${artist}`.trim();

    const results =
      await searchYoutube(
        searchQuery,
        5
      );

    if (!results.length) {
      throw new Error(
        "No YouTube result found."
      );
    }

    const first = results[0];

    const audioPath =
      await downloadAudio(
        first.url
      );

    return {
      path: audioPath,

      title,

      artist,

      thumbnail:
        spotifyData?.thumbnail ||
        spotifyData?.image ||
        first.thumbnail ||
        null,

      youtube: first.url,
    };
  } catch (error) {
    throw new Error(
      `Spotify download failed: ${error.message}`
    );
  }
}

/* =========================
   M4A -> MP3
========================= */

async function convertM4aToMp3(
  inputPath,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-y",
          "-i",
          inputPath,

          "-codec:a",
          "libmp3lame",

          "-b:a",
          "128k",

          outputPath,
        ],
        {
          timeout: 120000,
          maxBuffer:
            1024 * 1024 * 20,
        },
        (error, stdout, stderr) => {
          if (error) {
            return reject(
              new Error(
                stderr ||
                  error.message
              )
            );
          }

          resolve(outputPath);
        }
      );
    }
  );
}

/* =========================
   CLEANUP
========================= */

function cleanupFile(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

/* =========================
   EXPORTS
========================= */

module.exports = {
  runYtDlp,
  searchYoutube,
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  downloadFile,
  spotifySearch,
  downloadSpotifyTrack,
  convertM4aToMp3,
  cleanupFile,
  VIDEO_QUALITIES,
};
