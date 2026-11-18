# Arcatic web (Next.js). NEXT_PUBLIC_* values are baked into the browser bundle at BUILD time,
# so they are build args; the running container needs no secrets at all.
#   docker build -f infrastructure/web.Dockerfile -t arcatic-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... --build-arg NEXT_PUBLIC_API_URL=... .
FROM node:22-bookworm-slim AS build
# bake pnpm into the image (readable by the non-root runtime user) so a container start never downloads it
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate && chmod -R a+rX /usr/local/share/corepack
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @arcatic/web...
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_GOOGLE_API_KEY
ARG NEXT_PUBLIC_GOOGLE_APP_ID
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @arcatic/web build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
# bake pnpm into the image (readable by the non-root runtime user) so a container start never downloads it
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate && chmod -R a+rX /usr/local/share/corepack
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -fsS http://127.0.0.1:3000/offline || exit 1
CMD ["pnpm", "--filter", "@arcatic/web", "start"]
