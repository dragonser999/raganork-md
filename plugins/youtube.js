const fs = require("fs");
const path = require("path");
const axios = require("axios");

const YT_SEARCH_BASE =
  process.env.YT_SEARCH_API || "https://eliteprotech-apis.zone.id";

const YT_INFO_BASE =
  process.env.YT_INFO_API || "https://yt-api-pial.vercel.app";

const YT_MP4_API =
  process.env.YT_MP4_API ||
  "https://jerrycoder.oggyapi.workers.dev/down/ytmp4";

const YT_MP3_API =
  process.env.YT_MP3_API ||
  "https://jerrycoder.oggyapi.workers.dev/down/ytmp3";

const SPOTIFY_BASE =
  process.env.SPOTIFY_API || "https://api-faa.my.id";

const API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

const TEMP_DIR = path.join(
  require("os").tmpdir(),
  "yt-api-bot"
);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
}

/* =========================================================
   API REQUEST
========================================================= */

async function apiGet(url, params = {}) {
  const response = await axios.get(url, {
    params,
    headers: API_HEADERS,
    timeout: 45000,
    maxContentLength: 20 * 1024 * 1024,
  });

  return response.data;
}

/* =========================================================
   URL FINDER
========================================================= */

function firstUrl(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return /^https?:\/\//i.test(value)
      ? value
      : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item);

      if (url) {
        return url;
      }
    }

    return null;
  }

  if (typeof value === "object") {
    const keys = [
      "url",
      "download",
      "downloadUrl",
      "link",
      "src",
      "videoUrl",
      "audioUrl",
    ];

    for (const key of keys) {
      const url = firstUrl(value[key]);

      if (url) {
        return url;
      }
    }
  }

  return null;
}

/* =========================================================
   API RESULT NORMALIZER
========================================================= */

function pickResult(data) {
  return (
    data?.result ||
    data?.data ||
    data?.response ||
    data
  );
}

/* =========================================================
   YOUTUBE SEARCH
========================================================= */

function normalizeSearch(data) {
  const root = pickResult(data);

  const list =
    data?.results?.videos ||
    root?.results?.videos ||
    root?.videos ||
    root?.results ||
    data?.results ||
    (Array.isArray(root) ? root : []);

  return (Array.isArray(list) ? list : [])
    .map((video) => ({
      title:
        video.title ||
        video.name ||
        "Unknown title",

      duration:
        video.duration ||
        video.timestamp ||
        "N/A",

      views:
        video.views ??
        video.view_count ??
        video.viewCount,

      uploadedAt:
        video.uploaded ||
        video.uploadedAt ||
        video.publishDate ||
        null,

      channel: {
        name:
          video.author ||
          video.channel ||
          video.uploader ||
          "Unknown",
      },

      url:
        video.url ||
        video.link ||
        (
          video.id
            ? `https://www.youtube.com/watch?v=${video.id}`
            : null
        ),

      thumbnail:
        video.thumbnail ||
        video.image ||
        video.imageUrl ||
        video.thumbnails?.[0]?.url,
    }))
    .filter((video) => video.url);
}

async function searchYoutube(query, limit = 10) {
  const data = await apiGet(
    `${YT_SEARCH_BASE}/ytsearch`,
    {
      q: query,
    }
  );

  return normalizeSearch(data).slice(
    0,
    limit
  );
}

/* =========================================================
   FORMAT NORMALIZER
========================================================= */

function normalizeFormats(data) {
  const root = pickResult(data);

  const raw =
    root?.formats ||
    root?.links ||
    root?.qualities ||
    data?.formats ||
    data?.links ||
    [];

  const formats = [];

  function add(item, fallbackType) {
    if (!item) {
      return;
    }

    const url = firstUrl(item);

    const quality =
      item.quality ||
      item.resolution ||
      item.label ||
      (
        item.height
          ? `${item.height}p`
          : null
      );

    if (!url || !quality) {
      return;
    }

    let type =
      item.type ||
      fallbackType ||
      "video";

    if (
      item.mimeType &&
      item.mimeType.startsWith("audio")
    ) {
      type = "audio";
    }

    formats.push({
      type,

      quality:
        String(quality).match(/\d+p/i)
          ? String(quality).match(/\d+p/i)[0]
          : String(quality),

      size:
        item.size ||
        item.filesize ||
        item.fileSize ||
        null,

      url,
    });
  }

  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      add(item);
    });
  } else if (
    raw &&
    typeof raw === "object"
  ) {
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          add(
            {
              ...item,
              quality:
                item?.quality || key,
            },
            "video"
          );
        });
      } else {
        add(
          {
            ...(typeof value === "object"
              ? value
              : { url: value }),

            quality: key,
          },
          "video"
        );
      }
    }
  }

  return formats;
}

/* =========================================================
   YOUTUBE VIDEO INFO
========================================================= */

async function getVideoInfo(url) {
  const data = await apiGet(
    `${YT_INFO_BASE}/api/info`,
    {
      url,
    }
  );

  const root = pickResult(data);

  let formats =
    normalizeFormats(data);

  if (!formats.length) {
    const direct =
      firstUrl(root);

    if (direct) {
      formats.push({
        type: "video",

        quality:
          root?.quality ||
          "720p",

        size:
          root?.size ||
          null,

        url: direct,
      });
    }
  }

  const title =
    root?.title ||
    root?.name ||
    data?.title ||
    "YouTube Video";

  const videoId =
    root?.videoId ||
    root?.id ||
    (
      url.match(
        /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/
      ) || []
    )[1] ||
    "";

  return {
    title,

    videoId,

    channel: {
      name:
        root?.channel ||
        root?.author ||
        root?.uploader ||
        "YouTube",
    },

    thumbnail:
      root?.thumbnail ||
      root?.image ||
      null,

    formats,
  };
}


/* =========================================================
   DOWNLOAD REMOTE FILE
========================================================= */

async function downloadRemote(
  url,
  extension,
  filenameBase
) {
  const safeName = String(
    filenameBase || "youtube"
  )
    .replace(/[\\/:*?"<>|]/g, "")
    .slice(0, 80);

  const filePath = path.join(
    TEMP_DIR,
    `${Date.now()}_${safeName}.${extension}`
  );

  const response = await axios.get(
    url,
    {
      responseType: "stream",

      headers: API_HEADERS,

      timeout: 120000,

      maxContentLength:
        Infinity,

      maxBodyLength:
        Infinity,
    }
  );

  await new Promise(
    (resolve, reject) => {
      const writer =
        fs.createWriteStream(
          filePath
        );

      response.data.pipe(
        writer
      );

      writer.on(
        "finish",
        resolve
      );

      writer.on(
        "error",
        reject
      );

      response.data.on(
        "error",
        reject
      );
    }
  );

  return filePath;
}

/* =========================================================
   YOUTUBE VIDEO DOWNLOAD
   API ONLY — NO YT-DLP
========================================================= */

async function downloadVideo(
  url,
  quality = "720p"
) {
  const info =
    await getVideoInfo(url);

  const wanted =
    String(quality)
      .replace(/p$/i, "");

  /*
   * First try the URL returned by
   * the YouTube info API.
   */

  let selected =
    info.formats.find(
      (format) =>
        String(format.quality)
          .replace(/p$/i, "") ===
          wanted &&
        format.type !== "audio"
    );

  /*
   * If exact quality isn't available,
   * use the first video format.
   */

  if (!selected) {
    selected =
      info.formats.find(
        (format) =>
          format.type !== "audio"
      );
  }

  let remoteUrl =
    selected?.url;

  /*
   * Fallback to dedicated MP4 API.
   */

  if (!remoteUrl) {
    const data =
      await apiGet(
        YT_MP4_API,
        {
          url,
          quality:
            `${wanted}p`,
        }
      );

    remoteUrl =
      firstUrl(
        pickResult(data)
      ) ||
      firstUrl(data);
  }

  if (!remoteUrl) {
    throw new Error(
      "YouTube MP4 API did not return a download URL"
    );
  }

  const filePath =
    await downloadRemote(
      remoteUrl,
      "mp4",
      info.title
    );

  return {
    path: filePath,

    title:
      info.title,
  };
}

/* =========================================================
   YOUTUBE AUDIO DOWNLOAD
   API ONLY — NO YT-DLP
========================================================= */

async function downloadAudio(
  url
) {
  let info;

  try {
    info =
      await getVideoInfo(url);
  } catch (error) {
    info = {
      title:
        "YouTube Audio",

      channel: {
        name:
          "YouTube",
      },

      thumbnail:
        null,
    };
  }

  const data =
    await apiGet(
      YT_MP3_API,
      {
        url,
      }
    );

  const remoteUrl =
    firstUrl(
      pickResult(data)
    ) ||
    firstUrl(data);

  if (!remoteUrl) {
    throw new Error(
      "YouTube MP3 API did not return a download URL"
    );
  }

  const filePath =
    await downloadRemote(
      remoteUrl,
      "mp3",
      info.title
    );

  return {
    path: filePath,

    title:
      info.title,

    info: {
      channel:
        info.channel,

      thumbnail:
        info.thumbnail,
    },
  };
}

/* =========================================================
   M4A → MP3
   API already gives MP3
========================================================= */

async function convertM4aToMp3(
  audioPath
) {
  /*
   * No ffmpeg required.
   * The MP3 API already returns MP3.
   */

  return audioPath;
}

/* =========================================================
   SPOTIFY TRACK INFO
========================================================= */

async function spotifyTrack(
  url
) {
  const response =
    await axios.get(
      `${SPOTIFY_BASE}/faa/aio`,
      {
        params: {
          url,
        },

        headers:
          API_HEADERS,

        timeout:
          30000,
      }
    );

  const data =
    response.data;

  const result =
    data?.result ||
    data?.data ||
    data;

  if (!result) {
    throw new Error(
      "Failed to fetch Spotify track info"
    );
  }

  return {
    title:
      result.title ||
      result.name,

    artist:
      result.artist ||
      result.artists,

    thumbnail:
      result.thumbnail ||
      result.image ||
      null,
  };
}

/* =========================================================
   SPOTIFY DOWNLOAD
========================================================= */

async function downloadSpotifyTrack(
  spotifyUrl
) {
  const track =
    await spotifyTrack(
      spotifyUrl
    );

  const query =
    `${track.title} ${
      track.artist || ""
    }`.trim();

  const results =
    await searchYoutube(
      query,
      1
    );

  if (!results.length) {
    throw new Error(
      "No matching track found"
    );
  }

  const result =
    await downloadAudio(
      results[0].url
    );

  return {
    path:
      result.path,

    title:
      track.title,

    info: {
      channel: {
        name:
          track.artist,
      },

      thumbnail:
        track.thumbnail ||
        result.info?.thumbnail,
    },
  };
}

/* =========================================================
   MODULE EXPORTS
========================================================= */

module.exports = {
  searchYoutube,
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  convertM4aToMp3,
  spotifyTrack,
  downloadSpotifyTrack,
};