// Client de l'API : jeton Bearer (API_TOKEN), même origine que la page.
export class Unauthorized extends Error {}

async function request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 401) throw new Unauthorized("Jeton refusé");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} sur ${path}`);
  return res;
}

export async function getJson<T>(path: string, token: string): Promise<T> {
  return (await request(path, token)).json() as Promise<T>;
}

export async function postJson<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await request(path, token, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json() as Promise<T>;
}

export async function loginApi(username: string, password: string): Promise<{ token: string; username: string }> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) throw new Unauthorized("Identifiant ou mot de passe incorrect");
  if (!res.ok) throw new Error(`Erreur ${res.status}: ${res.statusText}`);
  return res.json();
}

/** Télécharge un fichier protégé par le jeton (un lien <a> simple ne peut pas envoyer l'en-tête). */
export async function download(path: string, token: string, filename: string): Promise<void> {
  const blob = await (await request(path, token)).blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
