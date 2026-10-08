import type { Role } from "./types";

// Client de l'API : jeton de session Bearer, même origine que la page.
export class Unauthorized extends Error {}   // 401 : session expirée, révoquée ou jeton inconnu
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function message(res: Response, path: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail)) return body.detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join(" ; ");
  } catch { /* corps non JSON */ }
  return `${res.status} ${res.statusText} sur ${path}`;
}

async function request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 401) throw new Unauthorized(await message(res, path));
  if (!res.ok) throw new ApiError(res.status, await message(res, path));
  return res;
}

export async function getJson<T>(path: string, token: string): Promise<T> {
  return (await request(path, token)).json() as Promise<T>;
}

export async function send<T = void>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, token: string,
                                     body?: unknown): Promise<T> {
  const res = await request(path, token, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const postJson = <T>(path: string, token: string, body?: unknown) => send<T>("POST", path, token, body);

export interface Session {
  token: string;
  expires_at: string;
  username: string;
  full_name: string;
  role: Role;
  must_change_password: boolean;
  totp_enabled: boolean;
}

/** Connexion. Lève OtpRequired si le compte a la double authentification et qu'aucun code n'a été fourni. */
export class OtpRequired extends Error {}

export async function loginApi(username: string, password: string, otp?: string): Promise<Session> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, ...(otp ? { otp } : {}) }),
  });
  if (res.ok) return res.json();
  const msg = await message(res, "/api/v1/auth/login");
  if (res.status === 401 && msg === "otp_required") throw new OtpRequired();
  throw new ApiError(res.status, res.status === 429 ? msg : msg.replace(/ sur \/api.*$/, ""));
}

/** Télécharge un fichier protégé par le jeton (un lien <a> simple ne peut pas envoyer l'en-tête). */
export async function download(path: string, token: string, filename: string): Promise<void> {
  const blob = await (await request(path, token)).blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** Récupère une image protégée (un <img src> ne peut pas envoyer l'en-tête Authorization). */
export async function fetchBlobUrl(path: string, token: string): Promise<string> {
  return URL.createObjectURL(await (await request(path, token)).blob());
}

/** Dernière image de la caméra IA : JPEG récent = flux actif ; image d'attente (SVG) ou image ancienne = caméra éteinte. */
export async function fetchSnapshot(path: string, token: string, maxAgeMs: number): Promise<{ url: string | null; live: boolean }> {
  const res = await request(path, token);
  const ts = Date.parse(res.headers.get("x-snapshot-ts") ?? "");
  const live = (res.headers.get("content-type") ?? "").includes("jpeg") && Number.isFinite(ts) && Date.now() - ts < maxAgeMs;
  if (!live) return { url: null, live: false };
  return { url: URL.createObjectURL(await res.blob()), live: true };
}

const CRLF2 = [13, 10, 13, 10];
function indexOfCrlf2(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  return -1;
}

/** Flux vidéo MJPEG (multipart/x-mixed-replace) authentifié : produit chaque image JPEG au fur et à mesure de son arrivée. */
export async function* mjpegFrames(path: string, token: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const res = await request(path, token, { signal });
  if (!res.body) return;
  const reader = res.body.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf); merged.set(value, buf.length);
      buf = merged;
      for (;;) {
        const head = indexOfCrlf2(buf);
        if (head < 0) break;
        const len = Number(/content-length:\s*(\d+)/i.exec(decoder.decode(buf.subarray(0, head)))?.[1] ?? NaN);
        if (!Number.isFinite(len)) { buf = buf.slice(head + CRLF2.length); continue; }
        const start = head + CRLF2.length;
        if (buf.length < start + len) break;                 // image incomplète : on attend la suite
        yield buf.slice(start, start + len);
        buf = buf.slice(start + len);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
