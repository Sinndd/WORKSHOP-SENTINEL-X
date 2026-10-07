import { useCallback, useState } from "react";
import { getJson, send } from "./api";
import { Card, Icon, StatTile, StatusBadge, type Status } from "./components/ui";
import { ago, dateTime } from "./format";
import { useAction, usePolling } from "./hooks";
import type { BlockedIp, SecurityEvent, SecuritySummary, SessionRow, Severity } from "./types";

const EVENT_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: "Connexion réussie",
  LOGIN_FAILURE: "Échec de connexion",
  LOGIN_REFUSED_LOCKED: "Connexion refusée (compte verrouillé)",
  LOGIN_REFUSED_DISABLED: "Connexion refusée (compte désactivé)",
  ACCOUNT_LOCKED: "Compte verrouillé",
  ACCOUNT_UNLOCKED: "Compte déverrouillé",
  IP_BLOCKED: "Adresse IP bloquée",
  IP_UNBLOCKED: "Adresse IP débloquée",
  ACCESS_DENIED: "Droits insuffisants",
  LOGOUT: "Déconnexion",
  PASSWORD_CHANGED: "Mot de passe changé",
  PASSWORD_CHANGE_REFUSED: "Changement de mot de passe refusé",
  PASSWORD_RESET: "Mot de passe réinitialisé",
  USER_CREATED: "Compte créé",
  USER_UPDATED: "Compte modifié",
  SESSION_REVOKED: "Session fermée",
  TOTP_ENABLED: "2FA activée",
  TOTP_DISABLED: "2FA désactivée",
  TOTP_RESET: "2FA réinitialisée",
};
const SEVERITY: Record<Severity, { status: Status; label: string }> = {
  CRITICAL: { status: "critical", label: "Critique" },
  WARNING: { status: "warning", label: "Avertissement" },
  INFO: { status: "neutral", label: "Info" },
};
const FILTERS: { id: Severity | "ALL"; label: string }[] = [
  { id: "ALL", label: "Tout" }, { id: "CRITICAL", label: "Critiques" }, { id: "WARNING", label: "Avertissements" }, { id: "INFO", label: "Infos" },
];

function remaining(s: number): string {
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
}

export default function SecurityView({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [blocked, setBlocked] = useState<BlockedIp[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [severity, setSeverity] = useState<Severity | "ALL">("ALL");
  const [now, setNow] = useState(Date.now());
  const { error, notice, run } = useAction(onExpired);

  const load = useCallback(() => {
    run(async () => {
      const q = severity === "ALL" ? "" : `&severity=${severity}`;
      const [s, e, b, ss] = await Promise.all([
        getJson<SecuritySummary>("/api/v1/security/summary", token),
        getJson<SecurityEvent[]>(`/api/v1/security/events?limit=300${q}`, token),
        getJson<BlockedIp[]>("/api/v1/security/blocked-ips", token),
        getJson<SessionRow[]>("/api/v1/security/sessions", token),
      ]);
      setSummary(s); setEvents(e); setBlocked(b); setSessions(ss); setNow(Date.now());
    });
  }, [token, severity, run]);
  usePolling(load, 5_000);

  const release = async (ip: string) => {
    if (!window.confirm(`Débloquer ${ip} ?`)) return;
    await run(() => send("DELETE", `/api/v1/security/blocked-ips/${encodeURIComponent(ip)}`, token), "Adresse débloquée.");
    load();
  };
  const revoke = async (s: SessionRow) => {
    if (!window.confirm(`Fermer la session de ${s.username} (${s.ip ?? "IP inconnue"}) ?`)) return;
    await run(() => send("DELETE", `/api/v1/security/sessions/${s.id}`, token), "Session fermée.");
    load();
  };

  const threat = (summary?.intrusions_24h ?? 0) > 0 || blocked.length > 0;

  return (
    <div>
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      {notice && <div className="alert-banner success-banner" role="status">{notice}</div>}
      {threat && (
        <div className="alert-banner error-banner" role="alert">
          ⚠ Tentative d'intrusion détectée : {summary?.intrusions_24h ?? 0} blocage(s) ces dernières 24 h
          {blocked.length > 0 && `, ${blocked.length} adresse(s) actuellement bloquée(s)`}.
        </div>
      )}

      <div className="grid tiles">
        <StatTile label="Connexions réussies (24 h)" value={String(summary?.logins_24h ?? "—")} />
        <StatTile label="Échecs de connexion (24 h)" value={String(summary?.failures_24h ?? "—")} />
        <StatTile label="Intrusions bloquées (24 h)" value={String(summary?.intrusions_24h ?? "—")} detail="verrouillages + IP bloquées" />
        <StatTile label="Comptes verrouillés" value={String(summary?.locked_accounts ?? "—")} />
        <StatTile label="IP bloquées" value={String(summary?.blocked_ips ?? "—")} />
        <StatTile label="Sessions actives" value={String(summary?.active_sessions ?? "—")} />
      </div>

      <div className="grid panels" style={{ marginTop: 12 }}>
        <Card title="Adresses IP bloquées">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Adresse IP</th><th>Reste</th><th /></tr></thead>
              <tbody>
                {blocked.map((b) => (
                  <tr key={b.ip}><td className="mono">{b.ip}</td><td>{remaining(b.remaining_s)}</td>
                    <td><button className="icon-btn" onClick={() => release(b.ip)} aria-label="Débloquer" title="Débloquer"><Icon name="unlock" size={15} /></button></td></tr>
                ))}
                {!blocked.length && <tr><td colSpan={3} className="muted">Aucune adresse bloquée</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Sessions actives">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Compte</th><th>Adresse IP</th><th>Activité</th><th /></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.full_name}<div className="muted mono">{s.username}</div></td>
                    <td className="mono">{s.ip ?? "—"}</td>
                    <td>{ago(s.last_seen, now)}</td>
                    <td><button className="icon-btn danger" onClick={() => revoke(s)} aria-label="Fermer la session" title="Fermer la session"><Icon name="logout" size={15} /></button></td>
                  </tr>
                ))}
                {!sessions.length && <tr><td colSpan={4} className="muted">Aucune session</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 12 }}>
        <Card title="Journal de sécurité">
          <div className="segmented" role="group" aria-label="Gravité" style={{ marginBottom: 10 }}>
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={severity === f.id} onClick={() => setSeverity(f.id)}>{f.label}</button>
            ))}
          </div>
          <div className="table-wrap tall">
            <table>
              <thead><tr><th>Heure</th><th>Gravité</th><th>Événement</th><th>Compte</th><th>Adresse IP</th><th>Détails</th></tr></thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>{dateTime(ev.ts)}</td>
                    <td><StatusBadge status={SEVERITY[ev.severity].status}>{SEVERITY[ev.severity].label}</StatusBadge></td>
                    <td>{EVENT_LABELS[ev.event_type] ?? ev.event_type}</td>
                    <td>{ev.username ?? <span className="muted">—</span>}{ev.actor && <div className="muted">par {ev.actor}</div>}</td>
                    <td className="mono">{ev.ip ?? "—"}</td>
                    <td>{ev.details ?? "—"}{ev.user_agent && <div className="muted ua" title={ev.user_agent}>{ev.user_agent}</div>}</td>
                  </tr>
                ))}
                {!events.length && <tr><td colSpan={6} className="muted">Aucun événement</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
