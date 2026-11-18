# Arcatic API (Hono). Runs TypeScript directly with tsx, like the worker.
# Build from the repo root:  docker build -f infrastructure/api.Dockerfile -t arcatic-api .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
# bake pnpm into the image (readable by the non-root runtime user) so a container start never downloads it
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate && chmod -R a+rX /usr/local/share/corepack
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @arcatic/api...
ENV NODE_ENV=production API_PORT=4000
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:4000/health || exit 1
CMD ["pnpm", "--filter", "@arcatic/api", "start"]
