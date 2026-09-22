FROM node:20-bullseye

# ffmpeg (for MP3 tagging/cover art) + build tools (sqlite3 is a native module and needs to compile)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      make \
      g++ \
      build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json yarn.lock* ./
RUN yarn install --production

# Copy the rest of the app
COPY . .

# pm2 is already a dependency in package.json, no need to install it globally
CMD ["node_modules/.bin/pm2-runtime", "start", "index.js", "--name", "raganork-md"]
