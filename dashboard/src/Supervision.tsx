import { useCallback, useEffect, useMemo, useState } from "react";
import { download, fetchBlobUrl, getJson, postJson, Unauthorized } from "./api";
import { Card, StatTile, StatusBadge, type Status } from "./components/ui";
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

interface SupervisionProps { token: string; canOperate: boolean; onExpired: () => void; }

export default function Supervision({ token, canOperate, onExpired }: SupervisionProps) {
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
    const rangeMs = RANGES.find((r) => r.id === range)!.ms;
    const since = new Date(Date.now() - rangeMs).toISOString();
    const q = encodeURIComponent(since);
    setLoading(true);
    try {
      const [devices, latest, agg, alerts, access, commands] = await Promise.all([
        getJson<Device[]>("/api/v1/devices", token),
        getJson<Telemetry>(`/api/v1/telemetry/latest?node_id=${NODE}`, token).catch((e) => { if (e instanceof Unauthorized) throw e; return null; }),
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
      if (e instanceof Unauthorized) onExpired();
      else setError(`Chargement impossible : ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [token, range, onExpired]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, load]);

  const run = async (label: string, call: () => Promise<unknown>, ok: string, ms = 4000) => {
    try {
      await call();
      setActionSuccess(ok);
      setTimeout(() => setActionSuccess(null), ms);
      await load();
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError(`${label} : ${(e as Error).message}`);
    }
  };
  const acknowledge = (id: number) => run("Acquittement impossible", () => postJson(`/api/v1/alerts/${id}/ack`, token), "Alerte acquittée");
  const triggerAirlock = (state: boolean) => run("Erreur Sas",
    () => postJson("/api/v1/actuators/airlock", token, { state, duration_ms: 3000 }),
    `Commande Sas ${state ? "OUVERTURE" : "FERMETURE"} transmise`);
  const triggerAlarm = (state: boolean) => run("Erreur Alarme",
    () => postJson("/api/v1/actuators/alarm", token, { state, color: "RED", sound: "SIREN_ALERT" }),
    `Alarme ${state ? "ACTIVÉE" : "DÉSACTIVÉE"}`);
  const triggerEmergencyStop = () => run("Erreur Arrêt Urgence",
    () => postJson("/api/v1/actuators/emergency_stop", token), "🚨 ARRÊT D'URGENCE GÉNÉRAL ACTIVÉ", 5000);

  const exportCsv = async () => {
    const rangeMs = RANGES.find((r) => r.id === range)!.ms;
    const since = new Date(Date.now() - rangeMs).toISOString();
    try {
      await download(`/api/v1/telemetry.csv?node_id=${NODE}&since=${encodeURIComponent(since)}`, token,
        `sentinel_${NODE}_${range}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`);
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError(`Export impossible : ${(e as Error).message}`);
    }
  };

  return (
    <>
      {actionSuccess && <div className="alert-banner success-banner" role="status">{actionSuccess}</div>}
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}

      <div className="filters" role="toolbar" aria-label="Filtres">
        <NodeStatus device={data?.device ?? null} now={now} />
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
        <span className="meta muted">{data ? `MàJ ${new Date(now).toLocaleTimeString("fr-FR")}` : "Chargement…"}</span>
      </div>

      {data && (
        <Dashboard
          data={data} now={now} loading={loading} hoverT={hoverT} setHoverT={setHoverT}
          unackOnly={unackOnly} setUnackOnly={setUnackOnly} canOperate={canOperate} token={token}
          onAck={acknowledge} onAirlock={triggerAirlock} onAlarm={triggerAlarm} onEmergencyStop={triggerEmergencyStop}
          camRefreshKey={camRefreshKey}
        />
      )}
    </>
  );
}

/** Image protégée : le jeton ne peut pas passer par un simple <img src>, on la charge en blob. */
function CameraFeed({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchBlobUrl("/api/v1/vision/snapshot", token).then((url) => {
      if (cancelled) { URL.revokeObjectURL(url); return; }
      setSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    }).catch(() => setSrc(null));
    return () => { cancelled = true; };
  }, [token, refreshKey]);
  return src ? <img src={src} alt="Retour direct Webcam IA" className="camera-stream-img" /> : null;
}

function NodeStatus({ device, now }: { device: Device | null; now: number }) {
  if (!device) return <span className="node-pill off"><i aria-hidden />Aucun module</span>;
  const online = device.last_seen != null && now - Date.parse(device.last_seen) < ONLINE_WITHIN_MS;
  return (
    <span className={`node-pill ${online ? "on" : "off"}`} title={online ? "Données reçues" : `Dernier signal ${ago(device.last_seen, now)}`}>
      <i aria-hidden />{device.node_id} · {online ? "en ligne" : `hors ligne (${ago(device.last_seen, now)})`}
    </span>
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
  canOperate: boolean;
  token: string;
}

function Dashboard({
  data, now: _now, loading, hoverT, setHoverT, unackOnly, setUnackOnly, onAck,
  onAirlock, onAlarm, onEmergencyStop, camRefreshKey, canOperate, token
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

  const [tab, setTab] = useState<"alerts" | "access" | "commands">("alerts");
  const gasHigh = (latest?.gas_raw_ppm ?? 0) >= 614;            // seuil local du firmware (A0 >= 150 sur 1023)
  const tempHigh = (latest?.temperature_celsius ?? 0) >= 40;
  const rssi = device?.last_wifi_rssi_dbm ?? null;

  const tabs: { id: typeof tab; label: string; count: number }[] = [
    { id: "alerts", label: "Alertes", count: unack.length },
    { id: "access", label: "Accès RFID", count: access.length },
    { id: "commands", label: "Commandes", count: commands.length },
  ];

  return (
    <div className={`dash${loading ? " loading" : ""}`}>
      <div className="tiles">
        <StatTile icon="temp" label="Température" value={num(latest?.temperature_celsius)} unit="°C" tone={tempHigh ? "critical" : "neutral"}
          detail={`${num(s.temperature_min)} / ${num(s.temperature_avg)} / ${num(s.temperature_max)}`} />
        <StatTile icon="drop" label="Humidité" value={num(latest?.humidity_percent, 0)} unit="%"
          detail={`${num(s.humidity_min, 0)} / ${num(s.humidity_avg, 0)} / ${num(s.humidity_max, 0)}`} />
        <StatTile icon="gas" label="Gaz MQ-2" value={num(latest?.gas_raw_ppm, 0)} tone={gasHigh ? "critical" : "neutral"}
          detail={`moy ${num(s.gas_avg, 0)} · pic ${num(s.gas_max, 0)}`} />
        <StatTile icon="user" label="Présence PIR" value={latest?.presence_detected == null ? "—" : latest.presence_detected ? "Détectée" : "Aucune"}
          tone={latest?.presence_detected ? "warning" : "neutral"}
          detail={`${num(s.presence_ratio == null ? null : s.presence_ratio * 100, 0)} % du temps`} />
        <StatTile icon="bell" label="Alertes à traiter" value={String(unack.length)} tone={unack.length ? "critical" : "good"}
          detail={`${alerts.length} sur la période`} />
        <StatTile icon="wifi" label="Wi-Fi ESP8266" value={num(rssi, 0)} unit="dBm" tone={rssi != null && rssi < -80 ? "serious" : "neutral"}
          detail={`RAM libre ${num(device?.last_free_heap_bytes == null ? null : device.last_free_heap_bytes / 1024, 0)} Ko`} />
      </div>

      <div className="main-grid">
        <div className="col-side">
          <Card title="Commandes" icon="bolt" sub={canOperate ? undefined : "Compte en lecture seule : commandes désactivées."}>
            <fieldset className="ctl" disabled={!canOperate}>
              <div className="ctl-row">
                <div className="ctl-info"><strong>Sas principal</strong>
                  <span className={`state ${latest?.airlock_open ? "on" : ""}`}>{latest?.airlock_open ? "Ouvert" : "Fermé"}</span></div>
                <div className="ctl-btns">
                  <button className="btn btn-sm" onClick={() => onAirlock(true)}>Ouvrir</button>
                  <button className="btn btn-sm" onClick={() => onAirlock(false)}>Fermer</button>
                </div>
              </div>
              <div className="ctl-row">
                <div className="ctl-info"><strong>Alarme</strong>
                  <span className={`state ${latest?.alarm_active ? "alert" : ""}`}>{latest?.alarm_active ? "Active" : "Veille"}</span></div>
                <div className="ctl-btns">
                  <button className="btn btn-sm btn-danger" onClick={() => onAlarm(true)}>Déclencher</button>
                  <button className="btn btn-sm" onClick={() => onAlarm(false)}>Couper</button>
                </div>
              </div>
              <button className="btn-emergency" onClick={() => { if (window.confirm("Déclencher l'ARRÊT D'URGENCE général ?")) onEmergencyStop(); }}>
                ARRÊT D'URGENCE
              </button>
            </fieldset>
            <div className="chips">
              {ACTUATORS.map((a) => {
                const v = latest?.[a.key] as boolean | null | undefined;
                return (
                  <span className={`chip ${v ? "on" : ""}`} key={a.key} title={a.label}>
                    <i aria-hidden />{a.label} · {v == null ? "—" : v ? a.on : a.off}
                  </span>
                );
              })}
            </div>
          </Card>

          <Card title="Caméra IA" icon="cam" actions={<span className="live"><i aria-hidden />DIRECT</span>}>
            <div className="camera-feed-box">
              <CameraFeed token={token} refreshKey={camRefreshKey} />
              <span className="cam-node">Serveur local · YOLO</span>
            </div>
          </Card>
        </div>

        <div className="col-charts">
          <Card title="Température" icon="temp" actions={<span className="muted">°C · intervalle {bucketLabel}</span>}>
            <LineChart title="Température" unit="°C" points={series.temp} {...chartProps} />
          </Card>
          <Card title="Humidité" icon="drop" actions={<span className="muted">% · intervalle {bucketLabel}</span>}>
            <LineChart title="Humidité" unit="%" digits={0} domain={[0, 100]} points={series.hum} {...chartProps} />
          </Card>
          <Card title="Gaz (pic)" icon="gas" actions={<span className="muted">ADC 0–4095 · {bucketLabel}</span>}>
            <LineChart title="Gaz (pic)" unit="" digits={0} points={series.gas} {...chartProps} />
          </Card>
          <Card title="Présence" icon="user" actions={<span className="muted">% du temps · {bucketLabel}</span>}>
            <LineChart title="Présence" unit="%" digits={0} domain={[0, 100]} points={series.presence} {...chartProps} />
          </Card>
        </div>
      </div>

      <Card title="Journal" icon="log" className="log-card" actions={
        <div className="segmented" role="tablist" aria-label="Journal">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}<span className={`count${t.id === "alerts" && t.count ? " hot" : ""}`}>{t.count}</span>
            </button>
          ))}
        </div>
      }>
        {tab === "alerts" && (
          <>
            <div className="log-tools">
              <div className="pills">
                {byType.map((b) => <span className="pill" key={b.label}>{b.label}<b>{b.value}</b></span>)}
              </div>
              <label className="check"><input type="checkbox" checked={unackOnly} onChange={(e) => setUnackOnly(e.target.checked)} />
                Non acquittées</label>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Heure</th><th>Gravité</th><th>Type</th><th>Capteur</th><th className="num">Valeur</th><th>Détails</th><th>Canal</th><th /></tr></thead>
                <tbody>
                  {shownAlerts.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{dateTime(a.ts)}</td>
                      <td><StatusBadge status={SEVERITY[a.severity].status}>{SEVERITY[a.severity].label}</StatusBadge></td>
                      <td>{EVENT_LABELS[a.event_type] ?? a.event_type}</td>
                      <td className="mono">{a.source_sensor ?? "—"}</td>
                      <td className="num">{num(a.value, 1)}</td>
                      <td>{a.details ?? "—"}</td>
                      <td className="muted">{a.channel}</td>
                      <td>{a.acknowledged ? <span className="muted">Acquittée</span>
                        : <button className="btn btn-sm" disabled={!canOperate} onClick={() => onAck(a.id)}>Acquitter</button>}</td>
                    </tr>
                  ))}
                  {!shownAlerts.length && <tr><td colSpan={8} className="muted">Aucune alerte</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "access" && (
          <>
            <p className="sub">{access.length} passage(s) : {granted} accordé(s), {access.length - granted} refusé(s)</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Heure</th><th>Badge</th><th>Agent</th><th>Porte</th><th>Décision</th></tr></thead>
                <tbody>
                  {access.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{dateTime(a.ts)}</td>
                      <td className="mono">{a.card_uid}</td>
                      <td>{a.user_name ?? <span className="muted">inconnu</span>}{a.clearance_level && <span className="muted"> · {a.clearance_level}</span>}</td>
                      <td className="mono">{a.door_id ?? "—"}</td>
                      <td><StatusBadge status={a.access_granted ? "good" : "critical"}>{a.access_granted ? "Accordé" : "Refusé"}</StatusBadge></td>
                    </tr>
                  ))}
                  {!access.length && <tr><td colSpan={5} className="muted">Aucun passage sur la période</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "commands" && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Heure</th><th>Action</th><th>Message MQTT</th></tr></thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap">{dateTime(c.created_at)}</td>
                    <td><strong>{c.action ?? "—"}</strong></td>
                    <td className="mono">{JSON.stringify(c.payload)}</td>
                  </tr>
                ))}
                {!commands.length && <tr><td colSpan={3} className="muted">Aucune commande sur la période</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
