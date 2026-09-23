FROM node:20-bookworm

# ffmpeg (mp3 tagging + video merging) + build tools (sqlite3 native module) + python3/pip (for yt-dlp)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      make \
      g++ \
      build-essential && \
    rm -rf /var/lib/apt/lists/*

# yt-dlp: does the actual YouTube search/download itself, on this same
# server, so there's no cross-IP CDN redirect and no 403s.
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json yarn.lock* ./
RUN yarn install --production

# Copy the rest of the app
COPY . .

# pm2 is already a dependency in package.json, no need to install it globally
CMD ["node_modules/.bin/pm2-runtime", "start", "index.js", "--name", "raganork-md"]
