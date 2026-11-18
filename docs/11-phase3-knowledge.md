# 11 — Phase 3: Knowledge OS (implemented)

## Source types
| Type | Input | Pipeline | Credits (reserve → settle) |
|---|---|---|---|
| Web page | URL | Firecrawl `/v2/scrape` (markdown) → clean → chunk → embed → summary | 0.2 → 0.2 (0 if unchanged) |
| Whole website | URL, page limit, include/exclude paths | Firecrawl `/v2/crawl` → poll → child sources per page → cross-page boilerplate removal → index each page | 0.1/page × limit → pages actually crawled |
| Document | Upload (PDF, DOCX, PPTX, XLSX, HTML, TXT, MD, CSV) | magic-byte sniff → Docling Serve (PDF/Office/HTML) · plain text · CSV parser → chunk → embed | ≤300 pages × 0.05 → actual text (~3,000 chars/page) |
| Google Drive | Picker selection (`drive.file`) | encrypted short-lived token → Drive v3 download/export (Docs→text, Sheets→CSV, Slides→PDF) → same as Document | same as Document |
| Video / audio | Upload, spoken language, max minutes | FFmpeg probe → mono 16 kHz Opus 10-min segments → Whisper per segment (resumable) → timestamped transcript → time-ranged chunks | 0.5/min × max → minutes transcribed |
| Note | Title + text | chunk → embed | by length |
| Social post | Platform, text, optional link (own posts only) | chunk → embed | by length |
| Images / logos / assets | Upload or image URL | Media library (not chunked): sniff, dimensions, SVG refused, URL import copies the file (SSRF-checked per redirect, 20 MB cap) | free |

Every source records: type, title, URL / file reference, owner, visibility (`brand` or `private`), status (`pending → processing → ready | failed`), error, parser, language, size/duration, chunk and embedding counts, embedding model, tags, AI summary, `last_ingested_at`, refresh interval (staleness shown in the UI), and the last job.

## Retrieval
- `search_knowledge` (SQL, SECURITY INVOKER so RLS applies): reciprocal-rank fusion of pgvector cosine similarity and Postgres full-text rank; filters by source type and tags; uses `hnsw.iterative_scan` so brand filtering doesn't starve results.
- Works without an embedding service (keyword only) — ingestion and search degrade instead of failing.
- Embedding text = title + heading path + chunk, so short passages keep their context.
- **Generation now uses knowledge**: `generateContent` retrieves the top passages for the topic and passes them as delimited, untrusted `<knowledge>` to the model; cited chunk ids are recorded on the content version.
- Website pages read during Brand Kit analysis are indexed automatically.

## Privacy & safety
- Private sources: only the owner and workspace admins/owners see them, their chunks, or search hits (RLS); API-key and service-role paths apply the same rule in code; generation uses a private source only for its owner's own requests.
- Re-indexing replaces chunks and embeddings in one transaction (`replace_source_chunks`).
- File types are detected from bytes, never extension or browser MIME; SVG is refused (script risk).
- Google Drive: `drive.file` scope (only picked files); the access token is AES-256-GCM encrypted (AAD = workspace + purpose) in `ephemeral_secrets` for ≤55 min and never enters Temporal history. Drive sources can't auto-refresh — re-pick to update.
- Firecrawl crawl pagination links are only followed back to the Firecrawl origin.
- Residual risk: DNS rebinding between our SSRF check and the fetch. Mitigation in staging/prod: egress proxy that blocks private ranges.

## Services (compose profile `ingest`)
Firecrawl (own compose), Docling Serve `:5001`, TEI + `BAAI/bge-m3` `:8080`, Whisper (speaches) `:9000`. Worker image `infrastructure/worker.Dockerfile` installs ffmpeg.
Env: `DOCLING_SERVICE_URL`, `EMBEDDINGS_PROVIDER` (`tei`|`voyage`), `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `VOYAGE_API_KEY`, `WHISPER_URL`, `WHISPER_MODEL`, `FFMPEG_PATH`, `FFPROBE_PATH`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID|API_KEY|APP_ID`.

## Verified vs not yet verified
| Item | Status |
|---|---|
| Migration 0008, RLS for private sources, hybrid search ranking, keyword fallback, atomic re-index, outsider isolation | **Verified** — Postgres 17 + pgvector smoke test |
| Chunking (Markdown, transcript, CSV), cleaning, boilerplate removal, file sniffing, image dimensions | **Verified** — unit tests incl. Telugu |
| Docling Serve contract | **Verified against source** (`docling/service_client/client.py`, response models) + fixture test; not run against a live server |
| Firecrawl crawl/scrape/map contract | Verified against source (Phase 2) + fixture tests |
| Ingestion workflow (URL, unchanged URL, crawl with page failure, summary failure, parse failure → credits released) | **Verified** — Temporal time-skipping tests |
| TEI / Voyage embeddings, Whisper server, Google Drive / Picker | **Not verifiable locally** (not in folder, need credentials); clients follow public APIs, fixture-tested |
| ffmpeg commands | Argument builders + probe parser unit-tested; ffmpeg not installed on this machine, so not executed |
| End-to-end on Supabase + Temporal + services | Not run |

## Recommended before production
1. Start `--profile ingest`, ingest one PDF, one Telugu video, one 25-page crawl; check passages, timestamps and search quality.
2. Build a retrieval eval (30 Telugu/English questions per test brand, expected source) and compare bge-m3 vs Voyage.
3. Create the Google Cloud OAuth client + Picker key and test a Drive import; submit for `drive.file` (non-sensitive) branding verification.
4. Pin image tags for docling-serve, TEI and speaches.
