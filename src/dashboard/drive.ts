import { requireEnv } from "../config.js";
import { parseServiceAccountKey, serviceAccountToken } from "../calendar/google.js";

// Henri's copy of the dashboard in Claude: the page goes into one Google Drive
// file that Henri owns and shared with the service account as an editor
// (config dashboard.drive_file_id); his Claude artifact reads that file through his
// Google Drive connector. The account can only touch files shared with it.

const SCOPE = "https://www.googleapis.com/auth/drive";

export type DashboardUpload = (html: string) => Promise<void>;

export function driveUploader(fileId: string): DashboardUpload {
  return async (html) => {
    const key = parseServiceAccountKey(requireEnv("GOOGLE_SA_KEY"));
    const token = await serviceAccountToken(key, SCOPE);
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token.value}`, "content-type": "text/html; charset=utf-8" },
      body: html,
    });
    if (!res.ok) throw new Error(`Google Drive upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}
