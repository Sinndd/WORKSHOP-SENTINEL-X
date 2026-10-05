import { useCallback, useState, type FormEvent } from "react";
import { getJson, send } from "./api";
import { Card } from "./components/ui";
import { dateTime } from "./format";
import { useAction, usePolling } from "./hooks";
import type { Me, SessionRow } from "./types";

export const ROLE_LABELS = { admin: "Administrateur", operator: "Opérateur", viewer: "Lecteur" } as const;

/** Règles affichées en direct ; la validation réelle est faite côté serveur (api/app/auth.py). */
function policyHints(pw: string, username: string): { ok: boolean; label: string }[] {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return [
    { ok: pw.length >= 12, label: "12 caractères minimum" },
    { ok: classes >= 3 || pw.length >= 20, label: "3 types parmi minuscules, majuscules, chiffres, symboles (ou 20+ caractères)" },
    { ok: username.length < 3 || !pw.toLowerCase().includes(username.toLowerCase()), label: "ne contient pas l'identifiant" },
  ];
}

export function PasswordForm({ token, username, onDone, onExpired }:
  { token: string; username: string; onDone: () => void; onExpired: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const { error, busy, run, setError } = useAction(onExpired);
  const hints = policyHints(next, username);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { setError("La confirmation ne correspond pas au nouveau mot de passe."); return; }
    const done = await run(() => send("POST", "/api/v1/auth/password", token, { current_password: current, new_password: next }).then(() => true));
    if (done) { setCurrent(""); setNext(""); setConfirm(""); onDone(); }
  };

  return (
    <form onSubmit={submit}>
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      <div className="field-group">
        <label htmlFor="pw-current">Mot de passe actuel</label>
        <input id="pw-current" type="password" autoComplete="current-password" value={current}
               onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="field-group">
        <label htmlFor="pw-new">Nouveau mot de passe</label>
        <input id="pw-new" type="password" autoComplete="new-password" value={next}
               onChange={(e) => setNext(e.target.value)} required />
        <ul className="hints">
          {hints.map((h) => <li key={h.label} className={h.ok ? "ok" : ""}>{h.ok ? "✓" : "○"} {h.label}</li>)}
        </ul>
      </div>
      <div className="field-group">
        <label htmlFor="pw-confirm">Confirmer le nouveau mot de passe</label>
        <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm}
               onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy || hints.some((h) => !h.ok)}>
        {busy ? "Enregistrement…" : "Changer le mot de passe"}
      </button>
      <p className="sub" style={{ marginTop: 8 }}>
        Les autres sessions ouvertes avec ce compte seront fermées.
      </p>
    </form>
  );
}

function TwoFactor({ token, me, onChanged, onExpired }:
  { token: string; me: Me; onChanged: () => void; onExpired: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const { error, notice, busy, run } = useAction(onExpired);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const res = await run(() => send<{ secret: string; uri: string }>("POST", "/api/v1/auth/2fa/setup", token, { password }));
    if (res) { setSetup(res); setPassword(""); }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => send("POST", "/api/v1/auth/2fa/enable", token, { code }).then(() => true),
      "Double authentification activée.");
    if (ok) { setSetup(null); setCode(""); onChanged(); }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => send("POST", "/api/v1/auth/2fa/disable", token, { password, code }).then(() => true),
      "Double authentification désactivée.");
    if (ok) { setPassword(""); setCode(""); onChanged(); }
  };

  return (
    <Card title="Double authentification (TOTP)" sub="Code à 6 chiffres généré par une application (Google Authenticator, Aegis, 1Password…)">
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      {notice && <div className="alert-banner success-banner" role="status">{notice}</div>}
      {me.totp_enabled ? (
        <form onSubmit={disable}>
          <p>✅ Activée sur ce compte. Pour la désactiver, confirmez avec votre mot de passe et un code valide.</p>
          <div className="row-fields">
            <input type="password" placeholder="Mot de passe" autoComplete="current-password" value={password}
                   onChange={(e) => setPassword(e.target.value)} required aria-label="Mot de passe" />
            <input inputMode="numeric" placeholder="Code à 6 chiffres" autoComplete="one-time-code" value={code}
                   onChange={(e) => setCode(e.target.value)} required aria-label="Code TOTP" />
            <button className="btn btn-danger" disabled={busy}>Désactiver</button>
          </div>
        </form>
      ) : setup ? (
        <form onSubmit={enable}>
          <p>1. Ajoutez ce compte dans votre application d'authentification avec la clé secrète ci-dessous
            (saisie manuelle, type « basé sur le temps »).</p>
          <p><code className="secret">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code></p>
          <details><summary>URI otpauth:// (import par QR ou lien)</summary><code className="mono">{setup.uri}</code></details>
          <p>2. Saisissez le code affiché pour terminer l'activation.</p>
          <div className="row-fields">
            <input inputMode="numeric" placeholder="Code à 6 chiffres" autoComplete="one-time-code" value={code}
                   onChange={(e) => setCode(e.target.value)} required aria-label="Code TOTP" autoFocus />
            <button className="btn btn-primary" disabled={busy}>Activer</button>
            <button type="button" className="btn" onClick={() => setSetup(null)}>Annuler</button>
          </div>
        </form>
      ) : (
        <form onSubmit={start}>
          <p>Non activée. Elle protège le compte même si le mot de passe est découvert.</p>
          <div className="row-fields">
            <input type="password" placeholder="Mot de passe actuel" autoComplete="current-password" value={password}
                   onChange={(e) => setPassword(e.target.value)} required aria-label="Mot de passe actuel" />
            <button className="btn btn-primary" disabled={busy}>Configurer</button>
          </div>
        </form>
      )}
    </Card>
  );
}

function MySessions({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const { error, notice, run } = useAction(onExpired);
  const load = useCallback(() => {
    run(async () => setRows(await getJson<SessionRow[]>("/api/v1/auth/sessions", token)));
  }, [token, run]);
  usePolling(load, 15_000);

  const revoke = async (id: number) => {
    await run(() => send("DELETE", `/api/v1/auth/sessions/${id}`, token), "Session fermée.");
    load();
  };

  return (
    <Card title="Mes sessions actives" sub="Connexions ouvertes avec ce compte (une session inconnue ? fermez-la et changez de mot de passe)">
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      {notice && <div className="alert-banner success-banner" role="status">{notice}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ouverte</th><th>Dernière activité</th><th>Adresse IP</th><th>Navigateur</th><th /></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{dateTime(s.created_at)}</td>
                <td>{dateTime(s.last_seen)}</td>
                <td className="mono">{s.ip ?? "—"}</td>
                <td className="ua" title={s.user_agent ?? ""}>{s.user_agent ?? "—"}</td>
                <td>{s.current ? <span className="muted">session actuelle</span>
                  : <button className="btn btn-sm" onClick={() => revoke(s.id)}>Fermer</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="muted">Aucune session</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function AccountView({ token, me, onChanged, onExpired }:
  { token: string; me: Me; onChanged: () => void; onExpired: () => void }) {
  if (me.service) {
    return <Card title="Jeton de service" sub="Accès automate (API_TOKEN)">
      <p>Ce jeton n'est pas un compte personnel : il n'a ni mot de passe, ni double authentification, ni droits d'administration.</p>
    </Card>;
  }
  return (
    <div className="grid panels">
      <Card title="Mon compte" sub={`${me.full_name} · ${ROLE_LABELS[me.role]}`}>
        <dl className="kv">
          <dt>Identifiant</dt><dd className="mono">{me.username}</dd>
          <dt>Dernière connexion</dt><dd>{dateTime(me.last_login_at ?? null)}{me.last_login_ip ? ` depuis ${me.last_login_ip}` : ""}</dd>
          <dt>Double authentification</dt><dd>{me.totp_enabled ? "activée" : "désactivée"}</dd>
        </dl>
      </Card>
      <Card title="Changer le mot de passe">
        <PasswordForm token={token} username={me.username} onDone={onChanged} onExpired={onExpired} />
      </Card>
      <TwoFactor token={token} me={me} onChanged={onChanged} onExpired={onExpired} />
      <MySessions token={token} onExpired={onExpired} />
    </div>
  );
}
