# FFmpeg + fonts exactly as the worker image uses them; also used by scripts/verify-render.ts.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["ffmpeg"]
