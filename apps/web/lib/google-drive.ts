"use client";
/**
 * Google Picker with the drive.file scope: Arcatic can read only the files the user picks.
 * The short-lived access token is sent once to the API, stored encrypted for under an hour,
 * and never saved for re-use.
 */
declare global {
  interface Window {
    google?: any;
    gapi?: any;
  }
}
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
const APP_ID = process.env.NEXT_PUBLIC_GOOGLE_APP_ID;
export const driveConfigured = !!CLIENT_ID && !!API_KEY;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

/** Sign in (drive.file), open the Picker, return the token and up to 20 picked files. */
export async function pickDriveFiles(opts: { mimeTypes?: string } = {}): Promise<{ token: string; files: Array<{ id: string; name: string }> }> {
  if (!driveConfigured) throw new Error("Google Drive isn't configured for this installation.");
  await Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")]);
  await new Promise<void>((r) => window.gapi.load("picker", r));
  const token: string = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (resp: { access_token?: string; error?: string }) => (resp.access_token ? resolve(resp.access_token) : reject(new Error(resp.error ?? "Google sign-in was cancelled"))),
    });
    client.requestAccessToken({ prompt: "" });
  });
  const files: Array<{ id: string; name: string }> = await new Promise((resolve) => {
    const view = new window.google.picker.DocsView().setIncludeFolders(false).setSelectFolderEnabled(false);
    if (opts.mimeTypes) view.setMimeTypes(opts.mimeTypes);
    new window.google.picker.PickerBuilder()
      .setAppId(APP_ID)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .addView(view)
      .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data: any) => {
        if (data.action === window.google.picker.Action.PICKED) resolve(data.docs.slice(0, 20).map((d: any) => ({ id: d.id, name: d.name })));
        if (data.action === window.google.picker.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
  return { token, files };
}
