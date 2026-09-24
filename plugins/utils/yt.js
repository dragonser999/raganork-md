const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

// ===============================
// ZELLRAYY API
// ===============================

const SEARCH_API = "https://zellrayy.com/search/youtube";
const VIDEO_API = "https://zellrayy.com/download/youtube/v3";
const AUDIO_API = "https://zellrayy.com/download/ytplaymusic";
const SPOTIFY_API = "https://zellrayy.com/download/spotify";

const TEMP_DIR = path.join(os.tmpdir(), "yt-bot-temp");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const api = axios.create({
  headers: BROWSER_HEADERS,
  timeout: 60000,
});

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ===============================
// HELPERS
// ===============================

function safeName(str) {
  return (str || "file")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, params, retries = 1) {
  try {
    const { data } = await api.get(url, { params });
    return data;
  } catch (error) {
    const status = error.response?.status;

    const transient =
      !status ||
      [408, 429, 500, 502, 503, 504].includes(status);

    if (transient && retries > 0) {
      await sleep(1200);
      return apiGet(url, params, retries - 1);
    }

    throw new Error(
      `API request failed: ${status || error.message}`
    );
  }
}

async function downloadFile(url, filename) {
  if (!url) {
    throw new Error("Download URL is missing");
  }

  const safe = safeName(filename);
  const destPath = path.join(
    TEMP_DIR,
    `${Date.now()}_${safe}`
  );

  const response = await axios.get(url, {
    responseType: "stream",
    headers: BROWSER_HEADERS,
    timeout: 120000,
    maxRedirects: 10,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);

    response.data.pipe(writer);

    writer.on("finish", resolve);

    writer.on("error", (err) => {
      try {
        writer.destroy();
      } catch (_) {}

      reject(err);
    });

    response.data.on("error", reject);
  });

  return destPath;
}

// ===============================
// YOUTUBE SEARCH
// ===============================

async function searchYoutube(query, limit = 10) {
  if (!query || !String(query).trim()) {
    return [];
  }

  const data = await apiGet(SEARCH_API, {
    q: String(query).trim(),
  });

  if (
    !data ||
    data.status !== true ||
    !Array.isArray(data.result)
  ) {
    return [];
  }

  return data.result.slice(0, limit).map((v) => ({
    title: v.title || "Unknown title",

    duration:
      v.duration ||
      v.durationLabel ||
      "Unknown",

    views:
      v.views ||
      v.shortViews ||
      null,

    uploadedAt:
      v.published ||
      null,

    channel: {
      name:
        v.channel?.name ||
        "Unknown",
      id:
        v.channel?.id ||
        null,
      url:
        v.channel?.url ||
        null,
      verified:
        v.channel?.verified ||
        false,
    },

    url:
      v.url ||
      `https://www.youtube.com/watch?v=${v.videoId}`,

    thumbnail:
      v.thumbnail ||
      `https://i.ytimg.com/vi/${v.videoId}/hq720.jpg`,

    videoId:
      v.videoId ||
      null,

    description:
      v.description ||
      null,
  }));
}

// ===============================
// YOUTUBE VIDEO INFO
// ===============================

async function getVideoInfo(url) {
  if (!url) {
    throw new Error("YouTube URL is required");
  }

  const data = await apiGet(VIDEO_API, {
    url: url,
    format: "mp4",
  });

  if (
    !data ||
    data.status !== true ||
    !data.result
  ) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Failed to fetch YouTube video info"
    );
  }

  const r = data.result;

  const formats = [];

  // ZellRayy currently returns one MP4 format
  // from this endpoint.
  if (r.download) {
    formats.push({
      type: "video",
      quality:
        String(r.quality || "720P").toLowerCase(),
      size:
        r.size || null,
      url: r.download,
      format:
        r.format || "MP4",
    });
  }

  return {
    title:
      r.title ||
      "YouTube Video",

    videoId:
      extractYoutubeId(url) ||
      null,

    thumbnail:
      r.thumbnail ||
      null,

    duration:
      r.duration ||
      null,

    quality:
      r.quality ||
      "720P",

    format:
      r.format ||
      "MP4",

    size:
      r.size ||
      null,

    formats,
  };
}

// ===============================
// EXTRACT YOUTUBE ID
// ===============================

function extractYoutubeId(url) {
  if (!url) return null;

  try {
    const value = String(url).trim();

    const patterns = [
      /youtu\.be\/([A-Za-z0-9_-]{11})/,
      /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
      /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
      /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
      /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);

      if (match && match[1]) {
        return match[1];
      }
    }
  } catch (_) {}

  return null;
}

// ===============================
// YOUTUBE VIDEO DOWNLOAD
// ===============================

async function downloadVideo(url, quality) {
  if (!url) {
    throw new Error("YouTube URL is required");
  }

  const info = await getVideoInfo(url);

  let requestedQuality =
    String(quality || "").toLowerCase();

  requestedQuality = requestedQuality
    .replace(/p$/i, "")
    .trim();

  let match = info.formats.find((f) => {
    const q = String(f.quality || "")
      .toLowerCase()
      .replace(/p$/i, "")
      .trim();

    return q === requestedQuality;
  });

  // If caller asks for the API's available quality,
  // use it.
  if (!match && info.formats.length === 1) {
    const available =
      String(info.formats[0].quality || "")
        .toLowerCase()
        .replace(/p$/i, "")
        .trim();

    if (
      !requestedQuality ||
      requestedQuality === available
    ) {
      match = info.formats[0];
    }
  }

  if (!match) {
    const available =
      info.formats
        .map((f) => f.quality)
        .filter(Boolean)
        .join(", ") || "none";

    throw new Error(
      `Quality ${quality || "requested"} not available. Available: ${available}`
    );
  }

  const extension =
    String(match.format || "MP4")
      .toLowerCase()
      .includes("mp4")
      ? "mp4"
      : "mp4";

  const filePath = await downloadFile(
    match.url,
    `${info.title}.${extension}`
  );

  return {
    path: filePath,
    title: info.title,
    quality: match.quality,
    thumbnail: info.thumbnail,
  };
}

// ===============================
// YOUTUBE AUDIO / MP3
// ===============================

async function downloadAudio(url) {
  if (!url) {
    throw new Error("YouTube URL or search query is required");
  }

  let query = String(url).trim();

  // If a YouTube URL was supplied, first search it
  // to obtain the exact video title.
  if (
    query.includes("youtube.com") ||
    query.includes("youtu.be")
  ) {
    const id = extractYoutubeId(query);

    if (id) {
      try {
        const results = await searchYoutube(id, 1);

        if (results.length > 0) {
          query = results[0].title;
        }
      } catch (_) {
        // Keep original URL as fallback.
      }
    }
  }

  const data = await apiGet(AUDIO_API, {
    q: query,
  });

  if (
    !data ||
    data.status !== true ||
    !data.result
  ) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Failed to download YouTube audio"
    );
  }

  const r = data.result;

  if (!r.download) {
    throw new Error(
      "Audio download URL was not returned by API"
    );
  }

  const title =
    r.title ||
    "YouTube Audio";

  const filePath = await downloadFile(
    r.download,
    `${title}.mp3`
  );

  return {
    path: filePath,
    title: title,

    info: {
      channel: {
        name: null,
      },

      thumbnail:
        r.thumbnail ||
        null,
    },

    duration:
      r.duration ||
      null,

    filesize:
      r.filesize ||
      null,

    sourceUrl:
      r.source_url ||
      url,
  };
}

// ===============================
// SPOTIFY INFO
// ===============================

async function spotifyTrack(url) {
  if (!url) {
    throw new Error("Spotify URL is required");
  }

  const data = await apiGet(SPOTIFY_API, {
    url: url,
  });

  if (
    !data ||
    data.status !== true ||
    !data.result
  ) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Failed to fetch Spotify track"
    );
  }

  const r = data.result;

  return {
    title:
      r.title ||
      "Unknown",

    artist:
      r.artist ||
      "Unknown",

    thumbnail:
      r.cover ||
      null,

    duration:
      r.duration ||
      null,

    download:
      r.download ||
      null,
  };
}

// ===============================
// SPOTIFY DOWNLOAD
// ===============================

async function downloadSpotifyTrack(spotifyUrl) {
  const track =
    await spotifyTrack(spotifyUrl);

  if (!track.download) {
    throw new Error(
      "Spotify download URL was not returned"
    );
  }

  const filePath = await downloadFile(
    track.download,
    `${track.title}.mp3`
  );

  return {
    path: filePath,

    title:
      track.title,

    info: {
      channel: {
        name:
          track.artist,
      },

      thumbnail:
        track.thumbnail ||
        null,
    },
  };
}

// ===============================
// MP3 TAGGING
// ===============================

async function convertM4aToMp3(
  audioPath,
  meta = {}
) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(
      "Audio file not found"
    );
  }

  const {
    title,
    artist,
    thumbnail,
  } = meta;

  const outputPath =
    audioPath.replace(
      /\.[^.]+$/,
      ""
    ) + "_tagged.mp3";

  let coverPath = null;

  // Download cover image if available.
  if (thumbnail) {
    try {
      coverPath =
        await downloadFile(
          thumbnail,
          "cover.jpg"
        );
    } catch (_) {
      coverPath = null;
    }
  }

  const args = [
    "-y",
    "-i",
    audioPath,
  ];

  if (coverPath) {
    args.push(
      "-i",
      coverPath
    );
  }

  args.push(
    "-map",
    "0:a"
  );

  if (coverPath) {
    args.push(
      "-map",
      "1:0",
      "-c:v",
      "mjpeg",
      "-disposition:v",
      "attached_pic"
    );
  }

  args.push(
    "-c:a",
    "copy",
    "-id3v2_version",
    "3"
  );

  if (title) {
    args.push(
      "-metadata",
      `title=${title}`
    );
  }

  if (artist) {
    args.push(
      "-metadata",
      `artist=${artist}`
    );
  }

  args.push(outputPath);

  await new Promise(
    (resolve, reject) => {
      execFile(
        "ffmpeg",
        args,
        {
          timeout: 120000,
        },
        (error) => {
          if (error) {
            return reject(error);
          }

          resolve();
        }
      );
    }
  );

  if (
    fs.existsSync(audioPath)
  ) {
    fs.unlinkSync(audioPath);
  }

  if (
    coverPath &&
    fs.existsSync(coverPath)
  ) {
    fs.unlinkSync(coverPath);
  }

  return outputPath;
}

// ===============================
// EXPORTS
// ===============================

module.exports = {
  searchYoutube,
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  convertM4aToMp3,
  spotifyTrack,
  downloadSpotifyTrack,
};
