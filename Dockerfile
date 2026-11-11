# ─── Stage 1: Build ──────────────────────────────────────────────────────────
# Node 22.22 on bookworm (the same Debian, so the same ffmpeg 5.1, as the node:20-slim image before): the Mila engine's
# Mastra packages need node >= 22.22. This image is SHARED WITH PRODUCTION: the next promote ships Node 22 to prod too
# (what was verified: docs/release/mila-engine-mastra-cutover.md).
FROM node:22.22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

COPY tsconfig.server.json ./
COPY server/ ./server/
COPY shared/ ./shared/

RUN npx esbuild server/index.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=cjs \
      --tsconfig=tsconfig.server.json \
      --out-extension:.js=.cjs \
      --outdir=server_dist

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22.22-bookworm-slim AS runtime

WORKDIR /app

# ffmpeg — used by the media-poster cron worker to extract a video poster frame and
# transcode uploaded clips to web-friendly 1080p H.264 (server/services/videoPoster.ts).
RUN apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

COPY --from=builder /app/server_dist ./server_dist/
COPY --from=builder /app/server/public ./server/public/
# The agent harness's skills: markdown procedures read at run time (server/agent/jobs.ts), not bundled by esbuild.
COPY --from=builder /app/server/agent/jobs ./server/agent/jobs/
# Mila's definition markdown, read at run time for the turns the server shapes itself (agent/proactive/turn.ts preface,
# waitlist/turn.ts surface + playbook, Mastra's skills, jobs/waitlist.md's {{include mila/waitlist}}): instructions/,
# surfaces/, proactive.md and skills/<name>/SKILL.md + nomila.yaml. server/agent/mila/load.ts MILA_DIR finds it here
# when bundled.
COPY --from=builder /app/server/agent/mila ./server/agent/mila/
# Mila's avatar loops + still, served by the public athlete page (/p/_a/mila/*, server/routes/publicPage.ts).
COPY assets/mila/ ./assets/mila/

ENV PORT=8080
ENV NODE_ENV=production
# Mastra (the Mila engine, server/agent/engine/mastra) ships PostHog feature telemetry, on unless this is set.
ENV MASTRA_TELEMETRY_DISABLED=1

EXPOSE 8080

CMD ["node", "server_dist/index.cjs"]
