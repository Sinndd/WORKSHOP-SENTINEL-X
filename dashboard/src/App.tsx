import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { download, getJson, loginApi, postJson, Unauthorized } from "./api";
import { BarList, Card, StatTile, StatusBadge, type Status } from "./components/ui";
import { LineChart, type Point } from "./components/LineChart";
import { ago, dateTime, num } from "./format";
import type { AccessEvent, Aggregate, Alert, CommandLog, Device, Severity, Telemetry } from "./types";

const NODE = "SENTINEL-X-CORE";
const RANGES = [
  { id: "15m", label: "15 min", ms: 15 * 60_000 },
  { id: "1h", label: "1 h", ms: 3600_000 },
  { id: "6h", label: "6 h", ms: 6 * 3600_000 },
  { id: "24h", label: "24 h", ms: 24 * 3600_000 },
  { id: "7d", label: "7 jours", ms: 7 * 24 * 3600_000 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const REFRESH_MS = 5_000;
const ONLINE_WITHIN_MS = 15_000;
const TOKEN_KEY = "sentinel.apiToken";
const USER_KEY = "sentinel.apiUser";

const EVENT_LABELS: Record<string, string> = {
  INTRUSION_DETECTED: "Intrusion",
  GAS_LEAK_WARNING: "Fuite de gaz",
  THERMAL_RUNAWAY: "Surchauffe",
  UNAUTHORIZED_ACCESS: "Accès refusé",
};
const SEVERITY: Record<Severity, { status: Status; label: string }> = {
  CRITICAL: { status: "critical", label: "Critique" },
  WARNING: { status: "warning", label: "Avertissement" },
  INFO: { status: "neutral", label: "Info" },
};
const ACTUATORS: { key: keyof Telemetry; label: string; on: string; off: string }[] = [
  { key: "airlock_open", label: "Sas principal", on: "Ouvert", off: "Fermé" },
  { key: "gas_valve_open", label: "Vanne gaz", on: "Ouverte", off: "Fermée" },
  { key: "barrier_open", label: "Barrière", on: "Ouverte", off: "Fermée" },
  { key: "ventilation_active", label: "Ventilation", on: "Active", off: "Arrêtée" },
  { key: "alarm_active", label: "Alarme", on: "Active", off: "Inactive" },
];

interface Data {
  device: Device | null;
  latest: Telemetry | null;
  agg: Aggregate;
  alerts: Alert[];
  access: AccessEvent[];
  commands: CommandLog[];
}

function readToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
function readUser(): string {
  try { return sessionStorage.getItem(USER_KEY) ?? "Opérateur"; } catch { return "Opérateur"; }
}

export default function App() {
  const [token, setToken] = useState(readToken);
  const [user, setUser] = useState(readUser);
  const [range, setRange] = useState<RangeId>("1h");
  const [auto, setAuto] = useState(true);
  const [unackOnly, setUnackOnly] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [camRefreshKey, setCamRefreshKey] = useState(Date.now());

  const load = useCallback(async () => {
    if (!token) return;
    const rangeMs = RANGES.find((r) => r.id === range)!.ms;
    const since = new Date(Date.now() - rangeMs).toISOString();
    const q = encodeURIComponent(since);
    setLoading(true);
    try {
      const [devices, latest, agg, alerts, access, commands] = await Promise.all([
        getJson<Device[]>("/api/v1/devices", token),
        getJson<Telemetry>(`/api/v1/telemetry/latest?node_id=${NODE}`, token).catch(() => null),
        getJson<Aggregate>(`/api/v1/telemetry/aggregate?node_id=${NODE}&since=${q}&points=240`, token),
        getJson<Alert[]>(`/api/v1/alerts?since=${q}&limit=1000`, token),
        getJson<AccessEvent[]>(`/api/v1/access/events?since=${q}&limit=200`, token),
        getJson<CommandLog[]>("/api/v1/commands?limit=100", token),
      ]);
      setData({
        device: devices.find((d) => d.node_id === NODE) ?? devices[0] ?? null,
        latest, agg, alerts, access,
        commands: commands.filter((c) => Date.parse(c.created_at) >= Date.parse(since)),
      });
      setError(null);
      setNow(Date.now());
      setCamRefreshKey(Date.now());
    } catch (e) {
      if (e instanceof Unauthorized) {
        try {
          sessionStorage.removeItem(TOKEN_KEY);
          sessionStorage.removeItem(USER_KEY);
        } catch { }
        setToken("");
        setError("Session expirée : veuillez vous reconnecter.");
      } else {
        setError(`Chargement impossible : ${(e as Error).message}`);
      }
    } finally {
      setLoading(false);
    }
  }, [token, range]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, load]);

  const handleLoginSuccess = (newToken: string, newUsername: string) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, newToken);
      sessionStorage.setItem(USER_KEY, newUsername);
    } catch { }
    setToken(newToken);
    setUser(newUsername);
    setError(null);
  };

  const handleLogout = () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch { }
    setToken("");
    setUser("Opérateur");
  };

  if (!token) {
    return <LoginGate error={error} onLogin={handleLoginSuccess} />;
  }

  const acknowledge = async (id: number) => {
    try { await postJson(`/api/v1/alerts/${id}/ack`, token); await load(); }
    catch (e) { setError(`Acquittement impossible : ${(e as Error).message}`); }
  };

  const triggerAirlock = async (state: boolean) => {
    try {
      await postJson("/api/v1/actuators/airlock", token, { state, duration_ms: 3000 });
      setActionSuccess(`Commande Sas ${state ? "OUVERTURE" : "FERMETURE"} transmise`);
      setTimeout(() => setActionSuccess(null), 4000);
      await load();
    } catch (e) { setError(`Erreur Sas : ${(e as Error).message}`); }
  };

  const triggerAlarm = async (state: boolean) => {
    try {
      await postJson("/api/v1/actuators/alarm", token, { state, color: "RED", sound: "SIREN_ALERT" });
      setActionSuccess(`Alarme ${state ? "ACTIVÉE" : "DÉSACTIVÉE"}`);
      setTimeout(() => setActionSuccess(null), 4000);
      await load();
    } catch (e) { setError(`Erreur Alarme : ${(e as Error).message}`); }
  };

  const triggerEmergencyStop = async () => {
    try {
      await postJson("/api/v1/actuators/emergency_stop", token);
      setActionSuccess("🚨 ARRÊT D'URGENCE GÉNÉRAL ACTIVÉ");
      setTimeout(() => setActionSuccess(null), 5000);
      await load();
    } catch (e) { setError(`Erreur Arrêt Urgence : ${(e as Error).message}`); }
  };

  const exportCsv = async () => {
    const rangeMs = RANGES.find((r) => r.id === range)!.ms;
    const since = new Date(Date.now() - rangeMs).toISOString();
    try {
      await download(`/api/v1/telemetry.csv?node_id=${NODE}&since=${encodeURIComponent(since)}`, token,
        `sentinel_${NODE}_${range}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`);
    } catch (e) { setError(`Export impossible : ${(e as Error).message}`); }
  };

  return (
    <div className="page">
      <header className="header">
        <div className="brand-group">
          <span className="brand-badge">AETHERCORP</span>
          <h1>SENTINEL-X — Centre de Supervision</h1>
        </div>
        <NodeStatus device={data?.device ?? null} now={now} />
        <span className="spacer" />
        <div className="user-badge">
          <span className="user-icon">👤</span>
          <span className="user-name">{user}</span>
        </div>
        <span className="meta">{data ? `MàJ ${new Date(now).toLocaleTimeString("fr-FR")}` : "Chargement…"}</span>
        <button className="btn btn-secondary" onClick={handleLogout}>
          Déconnexion
        </button>
      </header>

      {actionSuccess && <div className="alert-banner success-banner" role="status">{actionSuccess}</div>}
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}

      <div className="filters" role="toolbar" aria-label="Filtres">
        <div className="segmented" role="group" aria-label="Période">
          {RANGES.map((r) => (
            <button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Flux temps réel (5s)
        </label>
        <button className="btn" onClick={load} disabled={loading}>Actualiser</button>
        <button className="btn" onClick={exportCsv}>Export CSV</button>
      </div>

      {data && (
        <Dashboard
          data={data}
          now={now}
          loading={loading}
          hoverT={hoverT}
          setHoverT={setHoverT}
          unackOnly={unackOnly}
          setUnackOnly={setUnackOnly}
          onAck={acknowledge}
          onAirlock={triggerAirlock}
          onAlarm={triggerAlarm}
          onEmergencyStop={triggerEmergencyStop}
          camRefreshKey={camRefreshKey}
        />
      )}
    </div>
  );
}

function LoginGate({ error, onLogin }: { error: string | null; onLogin: (token: string, user: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [useTokenDirect, setUseTokenDirect] = useState(false);
  const [directToken, setDirectToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(error);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoginErr(null);

    if (useTokenDirect) {
      if (directToken.trim()) {
        onLogin(directToken.trim(), "Opérateur Token");
      }
      return;
    }

    if (!username.trim() || !password.trim()) {
      setLoginErr("Veuillez renseigner votre identifiant et votre mot de passe.");
      return;
    }

    setLoading(true);
    try {
      const res = await loginApi(username.trim(), password.trim());
      onLogin(res.token, res.username || username.trim());
    } catch (err) {
      setLoginErr((err as Error).message || "Identifiants invalides");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <form className="card gate login-card" onSubmit={handleSubmit}>
        <div className="login-header">
          <span className="corp-tag">AETHERCORP INDUSTRIAL SOLUTIONS</span>
          <h2>SENTINEL-X — TERMINAL TACTIQUE</h2>
          <p className="sub">Accès sécurisé au centre de commandement local.</p>
        </div>

        {loginErr && <div className="alert-banner error-banner" role="alert">{loginErr}</div>}

        {!useTokenDirect ? (
          <>
            <div className="field-group">
              <label htmlFor="login-user">Identifiant Opérateur</label>
              <input
                id="login-user"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ex: admin"
                autoFocus
                required
              />
            </div>

            <div className="field-group">
              <label htmlFor="login-pass">Mot de Passe</label>
              <input
                id="login-pass"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
              />
            </div>
          </>
        ) : (
          <div className="field-group">
            <label htmlFor="login-token">Jeton Secret API_TOKEN</label>
            <input
              id="login-token"
              type="password"
              autoComplete="off"
              value={directToken}
              onChange={(e) => setDirectToken(e.target.value)}
              placeholder="Coller la clé API..."
              required
            />
          </div>
        )}

        <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
          {loading ? "Vérification…" : "Connexion au Système"}
        </button>

        <div className="login-toggle">
          <button
            type="button"
            className="link-button"
            onClick={() => { setUseTokenDirect(!useTokenDirect); setLoginErr(null); }}
          >
            {useTokenDirect ? "← Revenir à la connexion identifiant/mot de passe" : "Utiliser un jeton API direct"}
          </button>
        </div>
      </form>
    </div>
  );
}

function NodeStatus({ device, now }: { device: Device | null; now: number }) {
  if (!device) return <StatusBadge status="neutral">Aucun module</StatusBadge>;
  const online = device.last_seen != null && now - Date.parse(device.last_seen) < ONLINE_WITHIN_MS;
  return (
    <StatusBadge status={online ? "good" : "critical"}>
      {device.node_id} · {online ? "EN LIGNE" : `HORS LIGNE (dernier signal ${ago(device.last_seen, now)})`}
    </StatusBadge>
  );
}

interface DashboardProps {
  data: Data;
  now: number;
  loading: boolean;
  hoverT: number | null;
  setHoverT: (t: number | null) => void;
  unackOnly: boolean;
  setUnackOnly: (v: boolean) => void;
  onAck: (id: number) => void;
  onAirlock: (state: boolean) => void;
  onAlarm: (state: boolean) => void;
  onEmergencyStop: () => void;
  camRefreshKey: number;
}

function Dashboard({
  data, now: _now, loading, hoverT, setHoverT, unackOnly, setUnackOnly, onAck,
  onAirlock, onAlarm, onEmergencyStop, camRefreshKey
}: DashboardProps) {
  const { agg, latest, alerts, access, commands, device } = data;
  const s = agg.summary;
  const start = Date.parse(agg.since), end = Date.parse(agg.until), bucketMs = agg.bucket_s * 1000;
  const series = useMemo(() => {
    const pts = (pick: (b: Aggregate["buckets"][number]) => number | null): Point[] =>
      agg.buckets.map((b) => ({ t: Date.parse(b.bucket), v: pick(b) }));
    return {
      temp: pts((b) => b.temperature_avg),
      hum: pts((b) => b.humidity_avg),
      gas: pts((b) => b.gas_max),
      presence: pts((b) => (b.presence_ratio == null ? null : b.presence_ratio * 100)),
    };
  }, [agg]);
  const unack = alerts.filter((a) => !a.acknowledged);
  const byType = Object.keys(EVENT_LABELS).map((k) => ({ label: EVENT_LABELS[k], value: alerts.filter((a) => a.event_type === k).length }));
  const shownAlerts = (unackOnly ? unack : alerts).slice(0, 100);
  const granted = access.filter((a) => a.access_granted).length;
  const chartProps = { start, end, bucketMs, hoverT, onHover: setHoverT };
  const bucketLabel = agg.bucket_s < 60 ? `${agg.bucket_s} s` : agg.bucket_s < 3600 ? `${Math.round(agg.bucket_s / 60)} min` : `${num(agg.bucket_s / 3600, 1)} h`;

  return (
    <div className={loading ? "loading" : undefined}>
      <div className="grid tiles">
        <StatTile label="Température DHT22" value={num(latest?.temperature_celsius)} unit="°C"
          detail={`min ${num(s.temperature_min)} · moy ${num(s.temperature_avg)} · max ${num(s.temperature_max)}`} />
        <StatTile label="Humidité DHT22" value={num(latest?.humidity_percent, 0)} unit="%"
          detail={`min ${num(s.humidity_min, 0)} · moy ${num(s.humidity_avg, 0)} · max ${num(s.humidity_max, 0)}`} />
        <StatTile label="Niveau Gaz MQ-2 (A0)" value={num(latest?.gas_raw_ppm, 0)}
          detail={`moy ${num(s.gas_avg, 0)} · pic ${num(s.gas_max, 0)}`} />
        <StatTile label="Présence PIR" value={latest?.presence_detected == null ? "—" : latest.presence_detected ? "DÉTECTÉE" : "AUCUNE"}
          detail={`${num(s.presence_ratio == null ? null : s.presence_ratio * 100, 0)} % du temps`} />
        <StatTile label="Alertes non acquittées" value={String(unack.length)}
          detail={`${alerts.length} alerte(s) sur la période`} />
        <StatTile label="Signal Wi-Fi NodeMCU" value={num(device?.last_wifi_rssi_dbm, 0)} unit="dBm"
          detail={`RAM libre : ${num(device?.last_free_heap_bytes == null ? null : device.last_free_heap_bytes / 1024, 0)} Ko`} />
      </div>

      <div className="grid panels-split" style={{ marginTop: 12 }}>
        <Card title="🎮 Panneau de Commande des Actionneurs" sub="Pilotage interactif de l'ESP8266 (Sas, Alarme, Arrêt)">
          <div className="action-panel">
            <div className="action-row">
              <div className="action-info">
                <strong>Sas Principal (Moteur Pas-à-Pas)</strong>
                <span className="muted">État : {latest?.airlock_open ? "🟢 Ouvert" : "⚪ Fermé"}</span>
              </div>
              <div className="action-btns">
                <button className="btn btn-action" onClick={() => onAirlock(true)}>Ouvrir le Sas</button>
                <button className="btn btn-action" onClick={() => onAirlock(false)}>Fermer le Sas</button>
              </div>
            </div>

            <div className="action-row">
              <div className="action-info">
                <strong>Alarme Sonore & Visuelle (Buzzer + LED)</strong>
                <span className="muted">État : {latest?.alarm_active ? "🔴 Alarme Active" : "⚪ Veille"}</span>
              </div>
              <div className="action-btns">
                <button className="btn btn-danger" onClick={() => onAlarm(true)}>🚨 Déclencher Alarme</button>
                <button className="btn btn-action" onClick={() => onAlarm(false)}>Couper Alarme</button>
              </div>
            </div>

            <div className="action-row emergency-row">
              <div className="action-info">
                <strong className="danger-text">Arrêt d'Urgence Total</strong>
                <span className="muted">Coupe toutes les bobines immédiatement</span>
              </div>
              <div className="action-btns">
                <button className="btn btn-emergency" onClick={onEmergencyStop}>🛑 ARRÊT D'URGENCE</button>
              </div>
            </div>
          </div>

          <div className="actuators-status-summary">
            {ACTUATORS.map((a) => {
              const v = latest?.[a.key] as boolean | null | undefined;
              return (
                <div className="actuator-chip" key={a.key}>
                  <span className="chip-name">{a.label}</span>
                  <span className={`chip-badge ${v ? "chip-on" : "chip-off"}`}>
                    {v == null ? "Non reçu" : v ? `● ${a.on}` : `○ ${a.off}`}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="📷 Retour Vidéo Webcam & Inférence IA (YOLO)" sub="Surveillance de table en direct & Détection d'intrus">
          <div className="camera-feed-box">
            <img
              src={`/api/v1/vision/snapshot?t=${camRefreshKey}`}
              alt="Retour direct Webcam IA"
              className="camera-stream-img"
              onError={(e) => {
                (e.target as HTMLElement).style.display = "none";
              }}
            />
            <div className="camera-overlay">
              <span className="cam-badge live-dot">● DIRECT</span>
              <span className="cam-node">PC SERVEUR LOCAL</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid charts" style={{ marginTop: 12 }}>
        <Card title="Température (°C)" sub={`Moyenne par intervalle de ${bucketLabel}`}>
          <LineChart title="Température" unit="°C" points={series.temp} {...chartProps} />
        </Card>
        <Card title="Humidité (%)" sub={`Moyenne par intervalle de ${bucketLabel}`}>
          <LineChart title="Humidité" unit="%" digits={0} domain={[0, 100]} points={series.hum} {...chartProps} />
        </Card>
        <Card title="Gaz — pic par intervalle (ADC 0–4095)" sub={`Valeur maximale par intervalle de ${bucketLabel}`}>
          <LineChart title="Gaz (pic)" unit="" digits={0} points={series.gas} {...chartProps} />
        </Card>
        <Card title="Présence détectée (% du temps)" sub={`Part des mesures avec présence, par intervalle de ${bucketLabel}`}>
          <LineChart title="Présence" unit="%" digits={0} domain={[0, 100]} points={series.presence} {...chartProps} />
        </Card>
      </div>

      <div className="grid panels" style={{ marginTop: 12 }}>
        <Card title="Alertes par type" sub={`${alerts.length} alerte(s) sur la période`}>
          <BarList rows={byType} />
        </Card>
        <Card title="Contrôle d'accès RFID" sub={`${access.length} passage(s) : ${granted} accordé(s), ${access.length - granted} refusé(s)`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Heure</th><th>Badge</th><th>Agent</th><th>Décision</th></tr></thead>
              <tbody>
                {access.map((a) => (
                  <tr key={a.id}>
                    <td>{dateTime(a.ts)}</td>
                    <td className="mono">{a.card_uid}</td>
                    <td>{a.user_name ?? <span className="muted">inconnu</span>}{a.clearance_level && <div className="muted">{a.clearance_level}</div>}</td>
                    <td><StatusBadge status={a.access_granted ? "good" : "critical"}>{a.access_granted ? "Accordé" : "Refusé"}</StatusBadge></td>
                  </tr>
                ))}
                {!access.length && <tr><td colSpan={4} className="muted">Aucun passage sur la période</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 12 }}>
        <Card title="Journal des Alertes" sub={
          <label className="check"><input type="checkbox" checked={unackOnly} onChange={(e) => setUnackOnly(e.target.checked)} />
            Non acquittées uniquement</label>}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Heure</th><th>Gravité</th><th>Type</th><th>Capteur</th><th>Valeur</th><th>Détails</th><th>Canal</th><th>Action</th></tr></thead>
              <tbody>
                {shownAlerts.map((a) => (
                  <tr key={a.id}>
                    <td>{dateTime(a.ts)}</td>
                    <td><StatusBadge status={SEVERITY[a.severity].status}>{SEVERITY[a.severity].label}</StatusBadge></td>
                    <td>{EVENT_LABELS[a.event_type] ?? a.event_type}</td>
                    <td className="mono">{a.source_sensor ?? "—"}</td>
                    <td className="num">{num(a.value, 1)}</td>
                    <td>{a.details ?? "—"}</td>
                    <td className="muted">{a.channel}</td>
                    <td>{a.acknowledged
                      ? <span className="muted">Acquittée</span>
                      : <button className="btn btn-sm" onClick={() => onAck(a.id)}>Acquitter</button>}</td>
                  </tr>
                ))}
                {!shownAlerts.length && <tr><td colSpan={8} className="muted">Aucune alerte</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 12 }}>
        <Card title="Commandes transmises à l'ESP8266" sub="Ordres superviseur & réponses d'accès RFID (sentinel/commands)">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Heure</th><th>Action</th><th>Message MQTT</th></tr></thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id}>
                    <td>{dateTime(c.created_at)}</td>
                    <td><strong>{c.action ?? "—"}</strong></td>
                    <td className="mono">{JSON.stringify(c.payload)}</td>
                  </tr>
                ))}
                {!commands.length && <tr><td colSpan={3} className="muted">Aucune commande sur la période</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
