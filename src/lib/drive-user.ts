// Uploads to Henri's own Google Drive as Henri, with the narrow drive.file scope:
// the app sees only the files and folder it created itself, nothing else in his
// Drive. A service account can't do this: it has no storage quota of its own, so
// it can only edit files a person already owns (the dashboard file).
// Sign-in once with `drive-login` (device code, an OAuth client of type "TVs and
// Limited Input devices" in the family-agent Google Cloud project). The refresh
// token is a secret file the wrapper loads as GOOGLE_DRIVE_REFRESH_TOKEN.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface DriveCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function driveCredsFromEnv(): DriveCreds | undefined {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
}

export interface DriveApi {
  /** Creates a folder at the top of My Drive and returns its id. */
  createFolder(name: string): Promise<string>;
  /** Uploads one file into the folder; returns its id and a link Henri can open. */
  upload(folderId: string, name: string, mime: string, body: Buffer): Promise<{ id: string; link: string }>;
}

async function accessToken(c: DriveCreds): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in for Drive failed (${j.error ?? res.status}); run drive-login again`);
  return j.access_token;
}

export function userDrive(c: DriveCreds): DriveApi {
  return {
    async createFolder(name) {
      const token = await accessToken(c);
      const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
      });
      if (!res.ok) throw new Error(`Drive folder ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return ((await res.json()) as { id: string }).id;
    },
    async upload(folderId, name, mime, body) {
      const token = await accessToken(c);
      const boundary = `fa${Date.now().toString(36)}`;
      const meta = JSON.stringify({ name, parents: [folderId] });
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`),
        body,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
        body: multipart,
      });
      if (!res.ok) throw new Error(`Drive upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { id: string; webViewLink?: string };
      return { id: j.id, link: j.webViewLink ?? `https://drive.google.com/file/d/${j.id}/view` };
    },
  };
}

/** Device-code sign-in: prints where to go and the code, waits, returns the refresh token. */
export async function driveLogin(clientId: string, clientSecret: string, say: (s: string) => void): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: DRIVE_SCOPE }),
  });
  const d = (await res.json()) as { device_code: string; user_code: string; verification_url: string; interval?: number; expires_in: number; error?: string };
  if (!res.ok) throw new Error(`device code: ${d.error ?? res.status}`);
  say(`Open ${d.verification_url} as janttiho@gmail.com and enter the code ${d.user_code}`);
  const until = Date.now() + d.expires_in * 1000;
  let wait = (d.interval ?? 5) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, wait));
    const t = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = (await t.json()) as { refresh_token?: string; error?: string };
    if (j.refresh_token) return j.refresh_token;
    if (j.error === "slow_down") wait += 5000;
    else if (j.error !== "authorization_pending") throw new Error(`sign-in failed: ${j.error ?? t.status}`);
  }
  throw new Error("the code expired; run drive-login again");
}
