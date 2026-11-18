# Arcatic worker: Node + Temporal worker + ffmpeg/ffprobe for media ingestion.
# Debian's ffmpeg package is a GPL-enabled build; Arcatic only runs it as a separate CLI process
# (SaaS use, not distributed). Swap for an LGPL static build if images are ever shipped to customers (docs/00).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
# bake pnpm into the image (readable by the non-root runtime user) so a container start never downloads it
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate && chmod -R a+rX /usr/local/share/corepack
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @arcatic/worker...
USER node
CMD ["pnpm", "--filter", "@arcatic/worker", "start"]
