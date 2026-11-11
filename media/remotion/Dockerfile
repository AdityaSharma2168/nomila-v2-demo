# The motion renderer (Remotion). Build context: the REPO ROOT (it needs shared/remotionProps.ts):
#   docker build -f media/remotion/Dockerfile .
FROM node:22-bookworm-slim

# Chrome Headless Shell's libraries (remotion.dev/docs/miscellaneous/linux-dependencies) + fonts for fallback glyphs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
      libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      fonts-noto-color-emoji fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/media/remotion
COPY media/remotion/package.json media/remotion/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY shared/remotionProps.ts /app/shared/remotionProps.ts
COPY media/remotion/ ./

# The browser and the bundle at build time, so a cold render starts rendering.
RUN npx remotion browser ensure && npx tsx server/bundle.ts

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
