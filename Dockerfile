# EufyView server - self-hosted Eufy camera viewer.
# Node 20 + FFmpeg on Debian slim. No build step; `node main.js` serves on 3001.
FROM node:20-bookworm-slim

# FFmpeg powers every transcode/snapshot/talkback path. The server modules call
# `ffmpeg` on PATH (FFMPEG_PATH env), so a system install is all they need.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    FFMPEG_PATH=ffmpeg

WORKDIR /app

# Install dependencies first for better layer caching. patch-package (a prod
# dependency) runs on `postinstall` and needs the patches/ dir present - it
# reapplies our eufy-security-client patch inside the image.
COPY package.json package-lock.json ./
COPY patches/ ./patches/
RUN npm ci --omit=dev && npm cache clean --force

# Application code (node_modules/, node/, ffmpeg/, data/ are excluded via
# .dockerignore so the host's Windows builds never leak in).
COPY . .

# All persisted state (auth.json, push subscriptions, snapshots, clips, logs)
# lives under data/. Keep it on a volume so it survives image upgrades - this
# mirrors the app's rule: everything in data/ persists, everything else is
# replaceable app code.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 3001

# Reuse the app's own /health endpoint so `docker ps` / compose report real health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "main.js"]
