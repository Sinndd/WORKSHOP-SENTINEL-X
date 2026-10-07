import { useCallback, useState, type FormEvent } from "react";
import { getJson, send } from "./api";
import { ROLE_LABELS } from "./Account";
import { Card, Icon, StatusBadge } from "./components/ui";
import { ago } from "./format";
import { useAction, usePolling } from "./hooks";
import type { Me, Role, UserRow } from "./types";

function accountStatus(u: UserRow, now: number) {
  if (!u.active) return <StatusBadge status="neutral">Désactivé</StatusBadge>;
  if (u.locked_until && Date.parse(u.locked_until) > now)
    return <StatusBadge status="critical">Verrouillé jusqu'à {new Date(u.locked_until).toLocaleTimeString("fr-FR")}</StatusBadge>;
  if (u.must_change_password) return <StatusBadge status="warning">Mot de passe à changer</StatusBadge>;
  return <StatusBadge status="good">Actif</StatusBadge>;
}

function CreateUser({ token, existingNames, onCreated, onExpired }:
  { token: string; existingNames: string[]; onCreated: (u: UserRow) => void; onExpired: () => void }) {
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [password, setPassword] = useState("");
  const { error, busy, run } = useAction(onExpired);

  const suggest = (name: string) => {
    setFullName(name);
    if (!username) {
      const base = name.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
      setUsername(base.slice(0, 32));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const created = await run(() => send<UserRow>("POST", "/api/v1/users", token,
      { username, full_name: fullName, role, ...(password ? { password } : {}) }));
    if (created) { setFullName(""); setUsername(""); setPassword(""); onCreated(created); }
  };

  const samePerson = existingNames.filter((n) => n.toLowerCase() === fullName.trim().toLowerCase()).length;

  return (
    <Card title="Créer un compte">
      <form onSubmit={submit} className="form-grid">
        {error && <div className="alert-banner error-banner" role="alert" style={{ gridColumn: "1 / -1" }}>{error}</div>}
        <div className="field-group">
          <label htmlFor="nu-name">Nom complet (titulaire)</label>
          <input id="nu-name" list="known-people" value={fullName} onChange={(e) => suggest(e.target.value)} required maxLength={128} />
          <datalist id="known-people">{[...new Set(existingNames)].map((n) => <option key={n} value={n} />)}</datalist>
          {samePerson > 0 && <span className="muted">Cette personne a déjà {samePerson} compte(s) : un compte supplémentaire sera ajouté.</span>}
        </div>
        <div className="field-group">
          <label htmlFor="nu-user">Identifiant de connexion</label>
          <input id="nu-user" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} required
                 pattern="[a-z0-9][a-z0-9._-]{2,31}" title="3 à 32 caractères : a-z, 0-9, point, tiret, tiret bas" autoComplete="off" />
        </div>
        <div className="field-group">
          <label htmlFor="nu-role">Rôle</label>
          <select id="nu-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">Lecteur — consultation seule</option>
            <option value="operator">Opérateur — commandes, badges, alertes</option>
            <option value="admin">Administrateur — comptes et sécurité</option>
          </select>
        </div>
        <div className="field-group">
          <label htmlFor="nu-pass">Mot de passe temporaire (facultatif)</label>
          <input id="nu-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 autoComplete="new-password" placeholder="vide = généré automatiquement" />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Création…" : "Créer le compte"}</button>
        </div>
      </form>
    </Card>
  );
}

export default function UsersView({ token, me, onExpired }: { token: string; me: Me; onExpired: () => void }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const { error, notice, busy, run } = useAction(onExpired);

  const load = useCallback(() => {
    run(async () => { setUsers(await getJson<UserRow[]>("/api/v1/users", token)); setNow(Date.now()); });
  }, [token, run]);
  usePolling(load, 10_000);

  const act = async (label: string, call: () => Promise<unknown>, ok: string) => {
    if (!window.confirm(label)) return;
    await run(call, ok);
    load();
  };
  const patch = (u: UserRow, body: object, ok: string, confirmMsg: string) =>
    act(confirmMsg, () => send("PATCH", `/api/v1/users/${u.id}`, token, body), ok);
  const resetPassword = async (u: UserRow) => {
    if (!window.confirm(`Réinitialiser le mot de passe de ${u.username} ? Ses sessions seront fermées.`)) return;
    const res = await run(() => send<{ temporary_password: string }>("POST", `/api/v1/users/${u.id}/reset-password`, token));
    if (res) setSecret({ who: u.username, password: res.temporary_password });
    load();
  };

  const people = new Map<string, UserRow[]>();
  users.forEach((u) => people.set(u.full_name, [...(people.get(u.full_name) ?? []), u]));
  const names = users.map((u) => u.full_name);

  return (
    <div>
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      {notice && <div className="alert-banner success-banner" role="status">{notice}</div>}
      {secret && (
        <div className="alert-banner secret-banner" role="alert">
          <div>
            Mot de passe temporaire de <strong>{secret.who}</strong> (affiché une seule fois — à transmettre de façon sûre) :{" "}
            <code className="secret">{secret.password}</code>
          </div>
          <span>
            <button className="icon-btn" onClick={() => navigator.clipboard?.writeText(secret.password)} aria-label="Copier le mot de passe" title="Copier"><Icon name="copy" size={15} /></button>{" "}
            <button className="icon-btn" onClick={() => setSecret(null)} aria-label="Masquer" title="Masquer"><Icon name="close" size={15} /></button>
          </span>
        </div>
      )}

      <CreateUser token={token} existingNames={names} onExpired={onExpired}
                  onCreated={(u) => {
                    if (u.temporary_password) setSecret({ who: u.username, password: u.temporary_password });
                    load();
                  }} />

      <div style={{ marginTop: 12 }}>
        <Card title={`Comptes (${users.length})`}>
          <div className="table-wrap tall">
            <table>
              <thead><tr><th>Titulaire</th><th>Identifiant</th><th>Rôle</th><th>État</th><th>2FA</th><th>Sessions</th><th>Dernière connexion</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map((u) => {
                  const self = u.username === me.username;
                  const locked = !!u.locked_until && Date.parse(u.locked_until) > now;
                  return (
                    <tr key={u.id}>
                      <td>{u.full_name}{(people.get(u.full_name)?.length ?? 0) > 1 && <div className="muted">{people.get(u.full_name)!.length} comptes</div>}</td>
                      <td className="mono">{u.username}{self && <span className="muted"> (vous)</span>}</td>
                      <td>
                        <select value={u.role} disabled={self || busy} aria-label={`Rôle de ${u.username}`}
                                onChange={(e) => patch(u, { role: e.target.value }, "Rôle modifié.",
                                  `Passer ${u.username} en « ${ROLE_LABELS[e.target.value as Role]} » ? Ses sessions seront fermées.`)}>
                          {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                      </td>
                      <td>{accountStatus(u, now)}{u.failed_attempts > 0 && <div className="muted">{u.failed_attempts} échec(s)</div>}</td>
                      <td>{u.totp_enabled ? "✓" : <span className="muted">—</span>}</td>
                      <td className="num">{u.active_sessions ?? 0}</td>
                      <td>{ago(u.last_login_at, now)}{u.last_login_ip && <div className="muted mono">{u.last_login_ip}</div>}</td>
                      <td className="actions-cell">
                        {locked && <button className="icon-btn" onClick={() => act(`Déverrouiller ${u.username} ?`,
                          () => send("POST", `/api/v1/users/${u.id}/unlock`, token), "Compte déverrouillé.")} aria-label="Déverrouiller" title="Déverrouiller"><Icon name="unlock" size={15} /></button>}
                        <button className="icon-btn" onClick={() => resetPassword(u)} aria-label="Réinitialiser le mot de passe" title="Réinitialiser le mot de passe"><Icon name="key" size={15} /></button>
                        {u.totp_enabled && <button className="icon-btn" onClick={() => act(`Retirer la double authentification de ${u.username} ?`,
                          () => send("POST", `/api/v1/users/${u.id}/reset-2fa`, token), "2FA retirée.")} aria-label="Retirer la double authentification" title="Retirer la double authentification"><Icon name="shield-off" size={15} /></button>}
                        {(u.active_sessions ?? 0) > 0 && !self && <button className="icon-btn" onClick={() => act(`Fermer toutes les sessions de ${u.username} ?`,
                          () => send("POST", `/api/v1/users/${u.id}/revoke-sessions`, token), "Sessions fermées.")} aria-label="Fermer ses sessions" title="Fermer ses sessions"><Icon name="logout" size={15} /></button>}
                        {!self && (u.active
                          ? <button className="icon-btn danger" onClick={() => patch(u, { active: false }, "Compte désactivé.", `Désactiver ${u.username} ? Il sera déconnecté immédiatement.`)} aria-label="Désactiver" title="Désactiver"><Icon name="user-off" size={15} /></button>
                          : <button className="icon-btn" onClick={() => patch(u, { active: true }, "Compte réactivé.", `Réactiver ${u.username} ?`)} aria-label="Réactiver" title="Réactiver"><Icon name="user-on" size={15} /></button>)}
                      </td>
                    </tr>
                  );
                })}
                {!users.length && <tr><td colSpan={8} className="muted">Aucun compte</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
