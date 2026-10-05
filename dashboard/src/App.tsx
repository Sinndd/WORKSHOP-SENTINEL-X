import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { download, getJson, postJson, Unauthorized } from "./api";
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
const REFRESH_MS = 10_000;
const ONLINE_WITHIN_MS = 15_000;   // télémétrie toutes les 2 s : hors ligne au-delà de 15 s sans message
const TOKEN_KEY = "sentinel.apiToken";

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

export default function App() {
  const [token, setToken] = useState(readToken);
  const [range, setRange] = useState<RangeId>("1h");
  const [auto, setAuto] = useState(true);
  const [unackOnly, setUnackOnly] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

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
    } catch (e) {
      if (e instanceof Unauthorized) {
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* stockage indisponible */ }
        setToken("");
        setError("Jeton refusé : saisir API_TOKEN (fichier .env du serveur).");
      } else {
        setError(`Chargement impossible : ${(e as Error).message}`);   // on garde l'affichage précédent
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

  if (!token) return <TokenGate error={error} onSubmit={(t) => {
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* stockage indisponible : jeton gardé en mémoire */ }
    setError(null);
    setToken(t);
  }} />;

  const acknowledge = async (id: number) => {
    try { await postJson(`/api/v1/alerts/${id}/ack`, token); await load(); }
    catch (e) { setError(`Acquittement impossible : ${(e as Error).message}`); }
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
        <h1>SENTINEL-X — Supervision</h1>
        <NodeStatus device={data?.device ?? null} now={now} />
        <span className="spacer" />
        <span className="meta">{data ? `Mis à jour ${new Date(now).toLocaleTimeString("fr-FR")}` : "Chargement…"}</span>
        <button className="btn" onClick={() => { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ } setToken(""); }}>
          Changer de jeton
        </button>
      </header>

      <div className="filters" role="toolbar" aria-label="Filtres">
        <div className="segmented" role="group" aria-label="Période">
          {RANGES.map((r) => (
            <button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Actualisation auto (10 s)</label>
        <button className="btn" onClick={load} disabled={loading}>Actualiser</button>
        <button className="btn" onClick={exportCsv}>Exporter CSV (brut)</button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {data && <Dashboard data={data} now={now} loading={loading} hoverT={hoverT} setHoverT={setHoverT}
        unackOnly={unackOnly} setUnackOnly={setUnackOnly} onAck={acknowledge} />}
    </div>
  );
}

function TokenGate({ error, onSubmit }: { error: string | null; onSubmit: (t: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); };
  return (
    <form className="card gate" onSubmit={submit}>
      <h2>SENTINEL-X — Supervision</h2>
      <p className="sub">Jeton opérateur <code>API_TOKEN</code> (fichier <code>.env</code> du serveur). Conservé pour cet onglet uniquement.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <label htmlFor="token">Jeton</label>
      <input id="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <button className="btn" type="submit">Se connecter</button>
    </form>
  );
}

function NodeStatus({ device, now }: { device: Device | null; now: number }) {
  if (!device) return <StatusBadge status="neutral">Aucun module</StatusBadge>;
  const online = device.last_seen != null && now - Date.parse(device.last_seen) < ONLINE_WITHIN_MS;
  return (
    <StatusBadge status={online ? "good" : "critical"}>
      {device.node_id} · {online ? "En ligne" : `Hors ligne (dernier message ${ago(device.last_seen, now)})`}
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
}

function Dashboard({ data, now, loading, hoverT, setHoverT, unackOnly, setUnackOnly, onAck }: DashboardProps) {
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
        <StatTile label="Température" value={num(latest?.temperature_celsius)} unit="°C"
          detail={`min ${num(s.temperature_min)} · moy ${num(s.temperature_avg)} · max ${num(s.temperature_max)}`} />
        <StatTile label="Humidité" value={num(latest?.humidity_percent, 0)} unit="%"
          detail={`min ${num(s.humidity_min, 0)} · moy ${num(s.humidity_avg, 0)} · max ${num(s.humidity_max, 0)}`} />
        <StatTile label="Gaz (ADC brut 0–4095)" value={num(latest?.gas_raw_ppm, 0)}
          detail={`moy ${num(s.gas_avg, 0)} · pic ${num(s.gas_max, 0)}`} />
        <StatTile label="Présence" value={latest?.presence_detected == null ? "—" : latest.presence_detected ? "Détectée" : "Aucune"}
          detail={`${num(s.presence_ratio == null ? null : s.presence_ratio * 100, 0)} % du temps sur la période`} />
        <StatTile label="Alertes non acquittées" value={String(unack.length)}
          detail={`${alerts.length} alerte(s) sur la période`} />
        <StatTile label="Signal Wi-Fi" value={num(device?.last_wifi_rssi_dbm, 0)} unit="dBm"
          detail={`${s.samples} mesures · mémoire libre ${num(device?.last_free_heap_bytes == null ? null : device.last_free_heap_bytes / 1024, 0)} Ko`} />
      </div>

      <Card title="État des actionneurs" sub={latest ? `Dernière télémétrie : ${dateTime(latest.received_at)} (${ago(latest.received_at, now)})` : "Aucune télémétrie reçue"}>
        <div className="actuators">
          {ACTUATORS.map((a) => {
            const v = latest?.[a.key] as boolean | null | undefined;
            return (
              <div className="item" key={a.key}>
                <span className="name">{a.label}</span>
                <span className="badge">{v == null ? "Non transmis" : v ? `● ${a.on}` : `○ ${a.off}`}</span>
              </div>
            );
          })}
        </div>
      </Card>

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

      <details>
        <summary>Afficher les données agrégées ({agg.buckets.length} intervalles)</summary>
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Début</th><th>Mesures</th><th>Temp. moy (°C)</th><th>Hum. moy (%)</th><th>Gaz moy</th><th>Gaz pic</th><th>Présence (%)</th></tr></thead>
            <tbody>
              {[...agg.buckets].reverse().map((b) => (
                <tr key={b.bucket}>
                  <td>{dateTime(b.bucket)}</td><td className="num">{b.samples}</td>
                  <td className="num">{num(b.temperature_avg)}</td><td className="num">{num(b.humidity_avg, 0)}</td>
                  <td className="num">{num(b.gas_avg, 0)}</td><td className="num">{num(b.gas_max, 0)}</td>
                  <td className="num">{num(b.presence_ratio == null ? null : b.presence_ratio * 100, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

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
      <Card title="Alertes" sub={
        <label className="check"><input type="checkbox" checked={unackOnly} onChange={(e) => setUnackOnly(e.target.checked)} />
          Non acquittées uniquement</label>}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Heure</th><th>Gravité</th><th>Type</th><th>Capteur</th><th>Valeur</th><th>Détails</th><th>Canal</th><th></th></tr></thead>
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
                    : <button className="btn" onClick={() => onAck(a.id)}>Acquitter</button>}</td>
                </tr>
              ))}
              {!shownAlerts.length && <tr><td colSpan={8} className="muted">Aucune alerte</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      </div>

      <div style={{ marginTop: 12 }}>
        <Card title="Commandes envoyées à l'ESP32" sub="Ordres superviseur et réponses d'accès RFID (sentinel/commands, sentinel/access/response)">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Heure</th><th>Action</th><th>Message</th></tr></thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id}>
                    <td>{dateTime(c.created_at)}</td>
                    <td>{c.action ?? "—"}</td>
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
