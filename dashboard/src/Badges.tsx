import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getJson, send } from "./api";
import { Card, Icon, StatusBadge } from "./components/ui";
import { dateTime } from "./format";
import { useAction, usePolling } from "./hooks";
import type { BadgeRow, Enrollment, UserRow } from "./types";

const LEVELS = ["LEVEL_1", "LEVEL_2", "LEVEL_3", "LEVEL_4"];

const END_MESSAGES: Record<string, string> = {
  TIMEOUT: "Délai écoulé : aucun badge n'a été écrit. Relancez l'enrôlement.",
  CANCELLED: "Enrôlement annulé.",
  FAILED: "L'enrôlement a échoué.",
};

/** Suivi d'un enrôlement en cours : interroge l'API jusqu'à la fin (succès, délai, annulation). */
function EnrollProgress({ token, enrollment, onDone, onExpired }:
  { token: string; enrollment: Enrollment; onDone: (e: Enrollment) => void; onExpired: () => void }) {
  const [current, setCurrent] = useState(enrollment);
  const [now, setNow] = useState(Date.now());
  const { busy, run } = useAction(onExpired);

  useEffect(() => {
    if (current.status !== "PENDING") return;
    const id = setInterval(async () => {
      setNow(Date.now());
      try {
        const e = await getJson<Enrollment>(`/api/v1/enrollments/${current.id}`, token);
        setCurrent(e);
        if (e.status !== "PENDING") onDone(e);
      } catch { /* nouvelle tentative au prochain tour */ }
    }, 1500);
    return () => clearInterval(id);
  }, [current.id, current.status, token, onDone]);

  const total = Date.parse(current.expires_at) - Date.parse(current.created_at);
  const left = Math.max(0, Date.parse(current.expires_at) - now);
  const cancel = () => run(async () => {
    const e = await send<Enrollment>("DELETE", `/api/v1/enrollments/${current.id}`, token);
    setCurrent(e); onDone(e);
  });

  return (
    <div className="alert-banner" role="status" style={{ display: "block" }}>
      <strong>Mode écriture actif sur le lecteur</strong> — posez un badge <em>vierge</em> sur le lecteur RFID pour
      <strong> {current.user_name}</strong>.
      <div style={{ height: 6, background: "rgba(127,127,127,.25)", borderRadius: 3, margin: "10px 0" }}>
        <div style={{ height: "100%", width: `${total > 0 ? (100 * left) / total : 0}%`, background: "currentColor", borderRadius: 3, transition: "width 1.4s linear" }} />
      </div>
      <span className="muted">Il reste {Math.ceil(left / 1000)} s. L'écran de la carte affiche « MODE ECRITURE » (LED bleue).</span>
      {current.error && <div className="muted" style={{ marginTop: 6 }}>Dernier essai : {current.error}</div>}
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-sm" onClick={cancel} disabled={busy}>Annuler l'enrôlement</button>
      </div>
    </div>
  );
}

function EnrollForm({ token, people, onStarted, onExpired, disabled, compact = false }:
  { token: string; people: string[]; onStarted: (e: Enrollment) => void; onExpired: () => void; disabled: boolean; compact?: boolean }) {
  const [userName, setUserName] = useState("");
  const [level, setLevel] = useState("LEVEL_1");
  const [autoUnlock, setAutoUnlock] = useState(true);
  const [duration, setDuration] = useState(30);
  const { error, busy, run } = useAction(onExpired);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const started = await run(() => send<Enrollment>("POST", "/api/v1/enrollments", token,
      { user_name: userName.trim(), clearance_level: level, auto_unlock_door: autoUnlock, duration_s: duration }));
    if (started) onStarted(started);
  };

  return (
    <Card title="Enrôler un badge" icon={compact ? "card" : undefined}
>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="alert-banner error-banner" role="alert" style={{ gridColumn: "1 / -1" }}>{error}</div>}
        <div className="field-group">
          <label htmlFor="eb-user">Utilisateur (titulaire du badge)</label>
          <input id="eb-user" list="badge-people" value={userName} onChange={(e) => setUserName(e.target.value)} required maxLength={128} autoComplete="off" />
          <datalist id="badge-people">{people.map((n) => <option key={n} value={n} />)}</datalist>
        </div>
        <div className="field-group">
          <label htmlFor="eb-level">Niveau d'accès</label>
          <select id="eb-level" value={level} onChange={(e) => setLevel(e.target.value)}>
            {LEVELS.map((l) => <option key={l} value={l}>{l.replace("_", " ")}</option>)}
          </select>
        </div>
        {!compact && <div className="field-group">
          <label htmlFor="eb-dur">Durée du mode écriture</label>
          <select id="eb-dur" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[30, 60, 120].map((s) => <option key={s} value={s}>{s} secondes</option>)}
          </select>
        </div>}
        {!compact && <div className="field-group">
          <label htmlFor="eb-auto">Ouverture de la trappe</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input id="eb-auto" type="checkbox" checked={autoUnlock} onChange={(e) => setAutoUnlock(e.target.checked)} />
            ouvrir automatiquement la trappe à chaque passage
          </label>
        </div>}
        <div style={{ gridColumn: "1 / -1" }}>
          <button className="btn btn-primary" disabled={busy || disabled || !userName.trim()}>
            {busy ? "Envoi…" : "Lancer l'enrôlement"}
          </button>
          {disabled && <span className="muted" style={{ marginLeft: 12 }}>Un enrôlement est déjà en cours.</span>}
        </div>
      </form>
    </Card>
  );
}

/** Enrôlement rapide, affiché sur la page Supervision : même parcours que l'onglet Badges, sans la gestion de la liste. */
export function QuickEnroll({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [people, setPeople] = useState<string[]>([]);
  const [active, setActive] = useState<Enrollment | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    getJson<UserRow[]>("/api/v1/users", token)
      .then((us) => setPeople([...new Set(us.map((u) => u.full_name))]))
      .catch(() => setPeople([]));   // réservé aux administrateurs : saisie libre sinon
  }, [token]);

  const onDone = useCallback((e: Enrollment) => {
    setActive(null);
    setMessage(e.status === "SUCCESS"
      ? { ok: true, text: `Badge ${e.card_uid} enrôlé pour ${e.user_name}. Il ouvre la trappe dès maintenant.` }
      : { ok: false, text: END_MESSAGES[e.status] ?? "Enrôlement terminé." });
  }, []);

  return (
    <div>
      {message && <div className={`alert-banner ${message.ok ? "success-banner" : "error-banner"}`} role="status">{message.text}</div>}
      {active && <EnrollProgress token={token} enrollment={active} onDone={onDone} onExpired={onExpired} />}
      <EnrollForm token={token} people={people} compact disabled={!!active} onExpired={onExpired}
                  onStarted={(e) => { setMessage(null); setActive(e); }} />
    </div>
  );
}

export default function BadgesView({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [badges, setBadges] = useState<BadgeRow[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [active, setActive] = useState<Enrollment | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ user_name: "", clearance_level: "LEVEL_1", auto_unlock_door: true });
  const { error, notice, busy, run, setNotice } = useAction(onExpired);

  const load = useCallback(() => {
    run(async () => { setBadges(await getJson<BadgeRow[]>("/api/v1/badges", token)); });
  }, [token, run]);
  usePolling(load, 10_000);

  // Suggestions : titulaires des comptes (réservé aux administrateurs ; saisie libre sinon).
  useEffect(() => {
    getJson<UserRow[]>("/api/v1/users", token)
      .then((us) => setPeople([...new Set(us.map((u) => u.full_name))]))
      .catch(() => setPeople([]));
  }, [token]);

  const onDone = useCallback((e: Enrollment) => {
    setActive(null);
    if (e.status === "SUCCESS") setNotice(`Badge ${e.card_uid} enrôlé pour ${e.user_name}. Il ouvre la trappe dès maintenant.`);
    else setNotice(END_MESSAGES[e.status] ?? "Enrôlement terminé.");
    load();
  }, [load, setNotice]);

  const startEdit = (b: BadgeRow) => {
    setEditing(b.card_uid);
    setDraft({ user_name: b.user_name, clearance_level: b.clearance_level, auto_unlock_door: b.auto_unlock_door });
  };
  const save = async (b: BadgeRow) => {
    await run(() => send("PUT", `/api/v1/badges/${b.card_uid}`, token, { ...draft, user_name: draft.user_name.trim(), active: b.active }),
              "Badge mis à jour.");
    setEditing(null);
    load();
  };
  const setActiveFlag = async (b: BadgeRow, active: boolean) => {
    if (!window.confirm(active ? `Réactiver le badge ${b.card_uid} (${b.user_name}) ?` : `Révoquer le badge ${b.card_uid} (${b.user_name}) ? Il n'ouvrira plus la trappe.`)) return;
    await run(() => send("PUT", `/api/v1/badges/${b.card_uid}`, token,
      { user_name: b.user_name, clearance_level: b.clearance_level, auto_unlock_door: b.auto_unlock_door, active }),
      active ? "Badge réactivé." : "Badge révoqué.");
    load();
  };

  return (
    <div>
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      {notice && <div className="alert-banner success-banner" role="status">{notice}</div>}

      {active && <EnrollProgress token={token} enrollment={active} onDone={onDone} onExpired={onExpired} />}
      <EnrollForm token={token} people={people} disabled={!!active} onExpired={onExpired}
                  onStarted={(e) => { setNotice(null); setActive(e); }} />

      <div style={{ marginTop: 12 }}>
        <Card title={`Badges enregistrés (${badges.length})`}>
          <div className="table-wrap tall">
            <table>
              <thead><tr><th>Badge (UID)</th><th>Utilisateur</th><th>Niveau</th><th>Trappe</th><th>État</th><th>Mis à jour</th><th>Actions</th></tr></thead>
              <tbody>
                {badges.map((b) => {
                  const edit = editing === b.card_uid;
                  return (
                    <tr key={b.card_uid}>
                      <td className="mono">{b.card_uid}</td>
                      <td>{edit
                        ? <input value={draft.user_name} onChange={(e) => setDraft({ ...draft, user_name: e.target.value })} list="badge-people" maxLength={128} aria-label="Utilisateur" />
                        : b.user_name}</td>
                      <td>{edit
                        ? <select value={draft.clearance_level} onChange={(e) => setDraft({ ...draft, clearance_level: e.target.value })} aria-label="Niveau">
                            {[...new Set([...LEVELS, draft.clearance_level])].map((l) => <option key={l} value={l}>{l}</option>)}
                          </select>
                        : b.clearance_level}</td>
                      <td>{edit
                        ? <input type="checkbox" checked={draft.auto_unlock_door} onChange={(e) => setDraft({ ...draft, auto_unlock_door: e.target.checked })} aria-label="Ouverture automatique" />
                        : (b.auto_unlock_door ? "ouvre" : <span className="muted">n'ouvre pas</span>)}</td>
                      <td>{b.active ? <StatusBadge status="good">Actif</StatusBadge> : <StatusBadge status="neutral">Révoqué</StatusBadge>}</td>
                      <td>{dateTime(b.updated_at)}</td>
                      <td className="actions-cell">
                        {edit ? (<>
                          <button className="btn btn-sm btn-primary" disabled={busy || !draft.user_name.trim()} onClick={() => save(b)}>Enregistrer</button>
                          <button className="btn btn-sm" onClick={() => setEditing(null)}>Annuler</button>
                        </>) : (<>
                          <button className="icon-btn" onClick={() => startEdit(b)} aria-label="Modifier le badge" title="Modifier"><Icon name="edit" size={15} /></button>
                          {b.active
                            ? <button className="btn btn-sm btn-danger" onClick={() => setActiveFlag(b, false)}>Révoquer</button>
                            : <button className="btn btn-sm" onClick={() => setActiveFlag(b, true)}>Réactiver</button>}
                        </>)}
                      </td>
                    </tr>
                  );
                })}
                {!badges.length && <tr><td colSpan={7} className="muted">Aucun badge</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
