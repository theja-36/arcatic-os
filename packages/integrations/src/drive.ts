import { AppError } from "@arcatic/core";

/**
 * Google Drive REST v3 (drive.file scope via the Picker: the app sees only files the user picks).
 *  GET /drive/v3/files/{id}?fields=…       metadata
 *  GET /drive/v3/files/{id}?alt=media      binary download
 *  GET /drive/v3/files/{id}/export?mimeType=…   Google Docs/Sheets/Slides export
 */
export const DRIVE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf" },
};

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

export class GoogleDriveClient {
  constructor(private readonly accessToken: string, private readonly opts: { fetchImpl?: typeof fetch; baseUrl?: string; maxBytes?: number } = {}) {}

  private async get(path: string, signal?: AbortSignal) {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseUrl ?? "https://www.googleapis.com"}${path}`, { headers: { authorization: `Bearer ${this.accessToken}` }, signal });
    if (res.status === 401 || res.status === 403) throw new AppError("forbidden", "Google Drive access expired or was not granted for this file. Pick the file again.");
    if (res.status === 404) throw new AppError("not_found", "File not found in Google Drive.");
    if (!res.ok) throw new AppError("upstream_error", `Google Drive → ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
    return res;
  }

  async metadata(id: string, signal?: AbortSignal): Promise<DriveFileMeta> {
    return (await this.get(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,modifiedTime,md5Checksum&supportsAllDrives=true`, signal)).json() as Promise<DriveFileMeta>;
  }

  /** Downloads (or exports) a file, enforcing the size cap while streaming. */
  async download(meta: DriveFileMeta, signal?: AbortSignal): Promise<{ bytes: Uint8Array; filename: string }> {
    const max = this.opts.maxBytes ?? 50 * 1024 * 1024;
    if (meta.size && Number(meta.size) > max) throw new AppError("validation_failed", `${meta.name} is larger than ${Math.round(max / 1048576)} MB.`);
    const exp = DRIVE_EXPORTS[meta.mimeType];
    if (!exp && meta.mimeType.startsWith("application/vnd.google-apps.")) throw new AppError("validation_failed", `${meta.name}: this Google file type can't be imported.`);
    const path = exp
      ? `/drive/v3/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`
      : `/drive/v3/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`;
    const res = await this.get(path, signal);
    const reader = res.body?.getReader();
    if (!reader) throw new AppError("upstream_error", "Empty response from Google Drive.");
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new AppError("validation_failed", `${meta.name} is larger than ${Math.round(max / 1048576)} MB.`);
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) bytes.set(p, off), (off += p.byteLength);
    const filename = exp && !meta.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${meta.name}.${exp.ext}` : meta.name;
    return { bytes, filename };
  }
}
