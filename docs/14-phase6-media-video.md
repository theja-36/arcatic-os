# 14 — Phase 6: Media workspace & video editor

A practical branded-video workflow: put clips, photos, logo, text and music on one timeline, render it with FFmpeg at the right size for each platform, and send the finished video into the normal content approval flow. It is **not** a general-purpose design tool: no keyframe animation, transitions beyond fade-in, multi-track video, or effects.

## 1. What was built

| Area | Where | Notes |
|---|---|---|
| Folders (collections) | migration `…0011_media_video.sql`, `apps/api/src/routes/media.ts` | Nested up to 8 deep; trigger blocks cycles and cross-workspace parents; deleting a folder keeps its files (`on delete set null`) |
| Library actions | `routes/media.ts`, `apps/web/app/w/[workspaceId]/media/page.tsx` | Upload (into the open folder), URL import, **Google Drive import**, search by name or `#tag`, filter by kind/folder, multi-select move, rename/alt text/tags, **replace file** (same kind; every timeline and post that uses the asset gets the new file), preview image/video/audio, delete |
| Media processing | `packages/jobs/src/media-activities.ts` (`probeMedia`) | Every uploaded/imported/replaced video or audio file is probed with ffprobe (duration, size, has-sound) and gets a poster frame; status `processing → ready/failed` |
| Drive → media | `importDriveMedia` workflow | Picker `drive.file` scope; token encrypted in `ephemeral_secrets` (< 1 h); ≤ 500 MB per file; real type sniffed; images, video, audio only |
| Secure URLs | `GET /media/:id/url[?poster=1][&download=1]` | 5-minute signed Storage URLs; the bucket stays private |
| AI assets | existing Phase 5 flows | AI images and exported visuals are already saved as media assets and appear in the library (`source` badge) |
| Timeline model | `packages/core/src/video/timeline.ts` | Clips (video/image), overlays (text/image/logo/shape), audio tracks; pure edit functions; `validateTimeline` |
| Platform presets | `core/video/presets.ts` | Instagram Reel/Feed, Facebook Reel, YouTube Short/16:9, TikTok, LinkedIn, X, Square — size, fps, max length |
| Render plan | `core/video/ffmpeg.ts` | One FFmpeg `filter_complex`: scale/crop or pad per clip, concat, silence for silent clips, overlays with time windows, audio mix with trims/fades/volume, H.264 + AAC, progress to the job |
| Render job | `renderVideo` workflow (render queue) | Revision-pinned; previews free (360-wide), finals 0.5 credits per started minute, reserved then settled; failure releases credits and marks the project failed |
| Video projects API | `apps/api/src/routes/video.ts` | See §3 |
| Editor UI | `app/w/[ws]/b/[brand]/videos/…`, `components/video/*` | Live preview stage (drag overlays), timeline with zoom, inspector, undo, checks list, preview/final render with progress, send to content |
| Content hand-off | `POST …/send-to-content` | Creates a `video` content item whose version carries `{doc: caption+hashtags, video: {assetId, projectId, revision}}`; it then goes through validation → approval like any post (scheduling is Phase 7) |

## 2. Telugu and other complex scripts

FFmpeg's `drawtext` in the Debian build we ship (5.1) has no text shaping, so Telugu conjuncts render wrongly. Text overlays are therefore **drawn in the browser** (canvas, same font stack as the stage) when the project is saved, uploaded as PNGs and composited by FFmpeg. Each PNG is tied to a key of the overlay's text/style/size (`overlayRenderKey`); any change invalidates it. Validation **blocks rendering** if non-Latin text has no current PNG. `drawtext` is only a fallback for Latin text saved by API clients that don't render.

## 3. API

All under `/v1/workspaces/:ws`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET/POST | `/media/collections` | media.read / media.create | `{name, parentId?, brandId?}` |
| PATCH/DELETE | `/media/collections/:id` | media.update / media.delete | |
| POST | `/media/move` | media.update | `{ids[], collectionId|null}` |
| POST | `/media/:id/replace` → `/media/:id/replace/finalize` | media.update | signed upload, then sniff + same-kind check + re-probe; old file removed |
| POST | `/media/import-drive` | media.create | idempotent; `{accessToken, files[], collectionId?}` → one job per file |
| GET | `/media?collectionId=<id>|none&source=&tag=&q=&kind=` | media.read | |
| GET/POST | `/brands/:b/video-projects` | media.read / media.create | create with `{title, preset, assetIds[]}` (clips in pick order) |
| GET | `/brands/:b/video-projects/:p` | media.read | includes `validation` |
| PUT | `/brands/:b/video-projects/:p/timeline` | media.update | `{revision, timeline, title?}`; 409 on stale revision or while rendering; every referenced asset must be in the workspace |
| POST | `/brands/:b/video-projects/:p/render` | media.update | `Idempotency-Key`; `{mode: preview|final}`; 422 if checks fail; 409 if already rendering |
| POST | `/brands/:b/video-projects/:p/send-to-content` | content.create | `{channel, caption, hashtags}`; 409 unless the final render matches the current revision |
| DELETE | `/brands/:b/video-projects/:p` | media.delete | rendered files stay in the library |

## 4. Verification

| Check | Result |
|---|---|
| `pnpm test` | core 129, api 50, jobs 22 (+1 opt-in Docker test), ai 25, integrations 20, database 2 — all pass |
| `pnpm verify:render` (real FFmpeg in the worker's Debian image) | Mixed timeline (trim, still, portrait clip, split, shape, logo, Telugu text PNG, drawtext CTA, music with fades): duration, size, streams and sampled pixel colours all correct. **60-s 1080p final render: 14–22 s on a laptop CPU** (target: < 2 min) |
| RLS smoke (`supabase/tests/smoke`) | Sections 16–17 cover folders and video projects (cross-workspace isolation, viewer can't write, timeline writes only via the API) |
| `next build` | passes |

## 5. Gaps and limits (honest list)

- **Not tested end-to-end in a browser** against live Supabase + Temporal: the editor UI, canvas text PNGs and signed-URL playback were type-checked and built, not clicked through.
- **Preview stage is an approximation** (the browser plays each source); the free FFmpeg preview render is the exact result.
- No transitions other than per-clip fade-in, no keyframes/Ken Burns, no speed change, single video track, max 10 audio tracks, ≤ 200 clips.
- Text-overlay PNGs are stored as ordinary media assets (`video-text-*.png`), so they show in the library.
- No GPU encoding path yet (`h264_nvenc`); CPU x264 already meets the target. Long (10-min) exports were not benchmarked.
- AI video generation (ComfyUI video workflows) is not part of this phase; `short_video` remains a script generator.
- Drive import requires the Google Cloud OAuth client + Picker key (`NEXT_PUBLIC_GOOGLE_*`) and `ENCRYPTION_KEY`.

## 6. Configuration

| Var | Default | Used for |
|---|---|---|
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | worker |
| `RENDER_FONT_FILE` | `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` | drawtext fallback (Latin only) |
| `ARCATIC_RENDER_TASK_QUEUE` | default queue | API starts renders on this queue; run a render worker with `ARCATIC_TASK_QUEUE` set to the same value to isolate heavy encodes |

`infrastructure/worker.Dockerfile` installs FFmpeg plus DejaVu and Noto fonts; `infrastructure/ffmpeg.Dockerfile` is the same toolchain used by `pnpm verify:render`.
