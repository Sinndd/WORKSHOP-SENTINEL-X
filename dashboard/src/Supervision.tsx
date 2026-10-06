import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { download, fetchBlobUrl, getJson, postJson, Unauthorized } from "./api";
import type { PaletteCommand } from "./components/CommandPalette";
import type { HoloMode } from "./components/Hologram";
import { LineChart, type Point } from "./components/LineChart";
import { Card, StatTile, StatusBadge, type Status } from "./components/ui";
import { ago, dateTime, num } from "./format";
import type { AccessEvent, Aggregate, Alert, CommandLog, Device, Severity, Telemetry } from "./types";

// Chargé à la demande : Three.js n'alourdit pas les autres écrans.
const Hologram = lazy(() => import("./components/Hologram"));

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
const GAS_HIGH = 614;          // seuil local du firmware (A0 >= 150 sur 1023)
const TEMP_HIGH = 40;

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
  { key: "airlock_open", label: "Sas", on: "ouvert", off: "fermé" },
  { key: "gas_valve_open", label: "Vanne gaz", on: "ouverte", off: "fermée" },
  { key: "barrier_open", label: "Barrière", on: "ouverte", off: "fermée" },
  { key: "ventilation_active", label: "Ventilation", on: "active", off: "arrêt" },
  { key: "alarm_active", label: "Alarme", on: "active", off: "veille" },
];
const MODE_LABEL: Record<HoloMode, string> = { nominal: "Nominal", warning: "Vigilance", critical: "Alerte", offline: "Hors ligne" };

interface Data {
  device: Device | null;
  latest: Telemetry | null;
  agg: Aggregate;
  alerts: Alert[];
  access: AccessEvent[];
  commands: CommandLog[];
}
type JournalTab = "alerts" | "access" | "commands";

interface FeedItem { key: string; ts: string; src: string; msg: string; level: "critical" | "warning" | "info"; }

interface SupervisionProps {
  token: string;
  canOperate: boolean;
  onExpired: () => void;
  onCommands: (commands: PaletteCommand[]) => void;
}

export default function Supervision({ token, canOperate, onExpired, onCommands }: SupervisionProps) {
  const [range, setRange] = useState<RangeId>("1h");
  const [auto, setAuto] = useState(true);
  const [unackOnly, setUnackOnly] = useState(false);
  const [tab, setTab] = useState<JournalTab>("alerts");
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
  const triggerAirlock = (state: boolean) => run("Erreur sas",
    () => postJson("/api/v1/actuators/airlock", token, { state, duration_ms: 3000 }),
    `Commande sas ${state ? "OUVERTURE" : "FERMETURE"} transmise`);
  const triggerAlarm = (state: boolean) => run("Erreur alarme",
    () => postJson("/api/v1/actuators/alarm", token, { state, color: "RED", sound: "SIREN_ALERT" }),
    `Alarme ${state ? "ACTIVÉE" : "DÉSACTIVÉE"}`);
  const triggerEmergencyStop = () => run("Erreur arrêt d'urgence",
    () => postJson("/api/v1/actuators/emergency_stop", token), "ARRÊT D'URGENCE GÉNÉRAL ACTIVÉ", 5000);

  const exportCsv = useCallback(async () => {
    const rangeMs = RANGES.find((r) => r.id === range)!.ms;
    const since = new Date(Date.now() - rangeMs).toISOString();
    try {
      await download(`/api/v1/telemetry.csv?node_id=${NODE}&since=${encodeURIComponent(since)}`, token,
        `sentinel_${NODE}_${range}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`);
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError(`Export impossible : ${(e as Error).message}`);
    }
  }, [range, token, onExpired]);

  // Commandes exposées dans la palette Ctrl-K (pas d'action physique : sas, alarme et arrêt restent sur les boutons).
  useEffect(() => {
    onCommands([
      ...RANGES.map((r) => ({ id: `range-${r.id}`, group: "Période", label: `Afficher : ${r.label}`, run: () => setRange(r.id) })),
      { id: "refresh", group: "Données", label: "Actualiser maintenant", run: load },
      { id: "live", group: "Données", label: auto ? "Suspendre le flux temps réel" : "Reprendre le flux temps réel", run: () => setAuto((a) => !a) },
      { id: "csv", group: "Données", label: "Exporter la télémétrie (CSV)", run: exportCsv },
      { id: "j-alerts", group: "Journal", label: "Ouvrir : alertes", run: () => setTab("alerts") },
      { id: "j-access", group: "Journal", label: "Ouvrir : accès RFID", run: () => setTab("access") },
      { id: "j-cmds", group: "Journal", label: "Ouvrir : commandes envoyées", run: () => setTab("commands") },
    ]);
  }, [onCommands, load, exportCsv, auto]);
  useEffect(() => () => onCommands([]), [onCommands]);

  const online = data?.device?.last_seen != null && now - Date.parse(data.device.last_seen) < ONLINE_WITHIN_MS;

  return (
    <>
      <Ticker data={data} online={online} />
      <main className="page">
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
            Temps réel (5 s)
          </label>
          <button className="btn btn-sm" onClick={load} disabled={loading}>Actualiser</button>
          <button className="btn btn-sm" onClick={exportCsv}>Export CSV</button>
          <span className="meta muted">{data ? `Mis à jour à ${new Date(now).toLocaleTimeString("fr-FR")}` : "Chargement…"}</span>
        </div>

        {data && (
          <Dashboard
            data={data} online={online} now={now} loading={loading} hoverT={hoverT} setHoverT={setHoverT}
            unackOnly={unackOnly} setUnackOnly={setUnackOnly} tab={tab} setTab={setTab} canOperate={canOperate} token={token}
            onAck={acknowledge} onAirlock={triggerAirlock} onAlarm={triggerAlarm} onEmergencyStop={triggerEmergencyStop}
            camRefreshKey={camRefreshKey}
          />
        )}
      </main>
    </>
  );
}

function feedItems(data: Data): FeedItem[] {
  const items: FeedItem[] = [
    ...data.alerts.map((a) => ({
      key: `a${a.id}`, ts: a.ts, src: `alerte · ${a.source_sensor ?? a.channel}`,
      msg: `${EVENT_LABELS[a.event_type] ?? a.event_type}${a.details ? ` — ${a.details}` : ""}${a.acknowledged ? " [acq]" : ""}`,
      level: (a.severity === "CRITICAL" ? "critical" : a.severity === "WARNING" ? "warning" : "info") as FeedItem["level"],
    })),
    ...data.access.map((a) => ({
      key: `r${a.id}`, ts: a.ts, src: `rfid · ${a.door_id ?? "porte"}`,
      msg: `${a.card_uid} ${a.access_granted ? `accès accordé : ${a.user_name ?? "?"}` : "ACCÈS REFUSÉ"}`,
      level: (a.access_granted ? "info" : "warning") as FeedItem["level"],
    })),
    ...data.commands.map((c) => ({
      key: `c${c.id}`, ts: c.created_at, src: `cmd · ${c.topic}`, msg: c.action ?? JSON.stringify(c.payload),
      level: "info" as const,
    })),
  ];
  return items.sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts));
}

/** Bandeau défilant des derniers événements (pause au survol ; figé si « réduire les animations »). */
function Ticker({ data, online }: { data: Data | null; online: boolean }) {
  const items = data ? feedItems(data).slice(0, 14) : [];
  const hot = data?.alerts.some((a) => !a.acknowledged && a.severity === "CRITICAL") ?? false;
  const latest = data?.latest;
  const status = [
    `Nœud ${NODE} ${online ? "en ligne" : "hors ligne"}`,
    latest ? `Température ${num(latest.temperature_celsius)} °C · Humidité ${num(latest.humidity_percent, 0)} % · Gaz ${num(latest.gas_raw_ppm, 0)}` : "Aucune télémétrie",
  ];
  return (
    <div className="ticker" role="marquee" aria-label="Derniers événements">
      <span className={`tag${hot ? " hot" : ""}`}>{hot ? "● ALERTE" : "● EN DIRECT"}</span>
      <div className="viewport">
        <div className="track" style={{ ["--ticker-duration" as string]: `${Math.max(30, (items.length + 2) * 7)}s` }}>
          {status.map((s) => <span className="item" key={s}><b>{s}</b></span>)}
          {items.map((i) => (
            <span className="item" key={i.key}>
              [{new Date(i.ts).toLocaleTimeString("fr-FR")}] <b>{i.src.charAt(0).toUpperCase() + i.src.slice(1)}</b> {i.msg}
            </span>
          ))}
          {!items.length && <span className="item">Aucun événement sur la période</span>}
        </div>
      </div>
    </div>
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
  return src ? <img src={src} alt="Retour direct de la webcam IA" className="camera-stream-img" /> : null;
}

function NodeStatus({ device, now }: { device: Device | null; now: number }) {
  if (!device) return <span className="node-pill off"><i aria-hidden />Aucun module</span>;
  const online = device.last_seen != null && now - Date.parse(device.last_seen) < ONLINE_WITHIN_MS;
  return (
    <span className={`node-pill ${online ? "on" : "off"}`} title={online ? "Données reçues" : `Dernier signal ${ago(device.last_seen, now)}`}>
      <i aria-hidden />{device.node_id} · {online ? "En ligne" : `Hors ligne (dernier signal ${ago(device.last_seen, now)})`}
    </span>
  );
}

/** Arrêt d'urgence en deux temps (armer puis confirmer sous 5 s), sans boîte de dialogue du navigateur. */
function EmergencyButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(id);
  }, [armed]);
  if (!armed) return <button className="btn-emergency" disabled={disabled} onClick={() => setArmed(true)}>ARRÊT D'URGENCE</button>;
  return (
    <div className="confirm-row" role="group" aria-label="Confirmer l'arrêt d'urgence">
      <button className="btn-emergency" onClick={() => { setArmed(false); onConfirm(); }} autoFocus>CONFIRMER L'ARRÊT</button>
      <button className="btn btn-sm" onClick={() => setArmed(false)}>Annuler</button>
    </div>
  );
}

interface DashboardProps {
  data: Data;
  online: boolean;
  now: number;
  loading: boolean;
  hoverT: number | null;
  setHoverT: (t: number | null) => void;
  unackOnly: boolean;
  setUnackOnly: (v: boolean) => void;
  tab: JournalTab;
  setTab: (t: JournalTab) => void;
  onAck: (id: number) => void;
  onAirlock: (state: boolean) => void;
  onAlarm: (state: boolean) => void;
  onEmergencyStop: () => void;
  camRefreshKey: number;
  canOperate: boolean;
  token: string;
}

function Dashboard({
  data, online, now, loading, hoverT, setHoverT, unackOnly, setUnackOnly, tab, setTab, onAck,
  onAirlock, onAlarm, onEmergencyStop, camRefreshKey, canOperate, token,
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
  const feed = useMemo(() => feedItems(data).slice(0, 40), [data]);

  const gasHigh = (latest?.gas_raw_ppm ?? 0) >= GAS_HIGH;
  const tempHigh = (latest?.temperature_celsius ?? 0) >= TEMP_HIGH;
  const presence = Boolean(online && latest?.presence_detected);
  const rssi = device?.last_wifi_rssi_dbm ?? null;
  const mode: HoloMode = !online ? "offline"
    : unack.some((a) => a.severity === "CRITICAL") || gasHigh || tempHigh ? "critical"
    : presence || unack.some((a) => a.severity === "WARNING") ? "warning" : "nominal";

  const tabs: { id: JournalTab; label: string; count: number }[] = [
    { id: "alerts", label: "Alertes", count: unack.length },
    { id: "access", label: "Accès RFID", count: access.length },
    { id: "commands", label: "Commandes", count: commands.length },
  ];

  return (
    <div className={loading ? "loading" : undefined}>
      <div className="control-room">
        {/* Colonne gauche : relevés et commandes */}
        <div className="stack">
          <Card title="Relevés" icon="gauge" actions={<span>min / moy / max sur la période</span>}>
            <div className="readouts">
              <StatTile icon="temp" label="Température" value={num(latest?.temperature_celsius)} unit="°C" tone={tempHigh ? "critical" : "neutral"}
                detail={`${num(s.temperature_min)} / ${num(s.temperature_avg)} / ${num(s.temperature_max)}`} />
              <StatTile icon="drop" label="Humidité" value={num(latest?.humidity_percent, 0)} unit="%"
                detail={`${num(s.humidity_min, 0)} / ${num(s.humidity_avg, 0)} / ${num(s.humidity_max, 0)}`} />
              <StatTile icon="gas" label="Gaz MQ-2" value={num(latest?.gas_raw_ppm, 0)} tone={gasHigh ? "critical" : "neutral"}
                detail={`moy ${num(s.gas_avg, 0)} · pic ${num(s.gas_max, 0)}`} />
              <StatTile icon="user" label="Présence" value={latest?.presence_detected == null ? "—" : latest.presence_detected ? "Oui" : "Non"}
                tone={presence ? "warning" : "neutral"}
                detail={`${num(s.presence_ratio == null ? null : s.presence_ratio * 100, 0)} % du temps`} />
              <StatTile icon="bell" label="Alertes" value={String(unack.length)} tone={unack.length ? "critical" : "good"}
                detail={`${alerts.length} sur la période`} />
              <StatTile icon="wifi" label="Wi-Fi" value={num(rssi, 0)} unit="dBm" tone={rssi != null && rssi < -80 ? "serious" : "neutral"}
                detail={`RAM ${num(device?.last_free_heap_bytes == null ? null : device.last_free_heap_bytes / 1024, 0)} Ko`} />
            </div>
          </Card>

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
                  <span className={`state ${latest?.alarm_active ? "alert" : ""}`}>{latest?.alarm_active ? "Active" : "En veille"}</span></div>
                <div className="ctl-btns">
                  <button className="btn btn-sm btn-danger" onClick={() => onAlarm(true)}>Déclencher</button>
                  <button className="btn btn-sm" onClick={() => onAlarm(false)}>Couper</button>
                </div>
              </div>
              <EmergencyButton onConfirm={onEmergencyStop} disabled={!canOperate} />
            </fieldset>
            <div className="chips">
              {ACTUATORS.map((a) => {
                const v = latest?.[a.key] as boolean | null | undefined;
                return <span className={`chip ${v ? "on" : ""}`} key={a.key} title={a.label}>{a.label} : {v == null ? "—" : v ? a.on : a.off}</span>;
              })}
            </div>
          </Card>
        </div>

        {/* Centre : hologramme */}
        <div className="holo-col">
          <Card title="Hologramme · Wall-E MK2" icon="cube" className={`mode-${mode}`}
                actions={<StatusBadge status={mode === "nominal" ? "good" : mode === "warning" ? "warning" : mode === "critical" ? "critical" : "neutral"}>
                  {MODE_LABEL[mode]}</StatusBadge>}>
            <div className="holo flush">
              <Suspense fallback={<div className="holo-fallback">Chargement du moteur 3D…</div>}>
                <Hologram mode={mode} presence={presence} />
              </Suspense>
              <div className="hud tl" aria-hidden>
                <div>Nœud <b>{NODE}</b></div>
                <div>Liaison <b>{online ? "établie" : "perdue"}</b></div>
                <div>Dernier signal <b>{ago(device?.last_seen ?? null, now)}</b></div>
              </div>
              <div className="hud tr" aria-hidden>
                <span className={`holo-status ${mode === "nominal" ? "" : mode}`}>{MODE_LABEL[mode]}</span>
                <div>Présence <b>{presence ? "détectée" : "aucune"}</b></div>
              </div>
              <div className="hud bl" aria-hidden>
                <div>Température <b>{num(latest?.temperature_celsius)} °C</b></div>
                <div>Humidité <b>{num(latest?.humidity_percent, 0)} %</b></div>
                <div>Gaz <b>{num(latest?.gas_raw_ppm, 0)}</b></div>
              </div>
              <div className="hud br" aria-hidden>
                <div>Alertes actives <b>{unack.length}</b></div>
                <div>Accès accordés <b>{granted}/{access.length}</b></div>
              </div>
              <span className="holo-hint">Glisser pour pivoter · molette pour zoomer</span>
            </div>
          </Card>
        </div>

        {/* Colonne droite : flux d'événements et caméra */}
        <div className="stack">
          <Card title="Flux d'événements" icon="pulse" actions={<span className="live"><i aria-hidden />EN DIRECT</span>}>
            <ul className="feed" aria-label="Derniers événements">
              {feed.map((f) => (
                <li key={f.key} className={`lvl-${f.level}`}>
                  <time dateTime={f.ts}>{new Date(f.ts).toLocaleTimeString("fr-FR")}</time>
                  <div><div className="src">{f.src}</div><div className="msg">{f.level === "critical" ? "✕ " : f.level === "warning" ? "▲ " : ""}{f.msg}</div></div>
                </li>
              ))}
              {!feed.length && <li className="empty">Aucun événement sur la période</li>}
            </ul>
          </Card>
          <Card title="Caméra IA" icon="cam" actions={<span className="live"><i aria-hidden />DIRECT</span>}>
            <div className="camera-feed-box">
              <CameraFeed token={token} refreshKey={camRefreshKey} />
              <span className="cam-node">Serveur local · YOLO</span>
            </div>
          </Card>
        </div>
      </div>

      <div className="charts-row">
        <Card title="Température" icon="temp" actions={<span>°C · pas {bucketLabel}</span>}>
          <LineChart title="Température" unit="°C" points={series.temp} {...chartProps} />
        </Card>
        <Card title="Humidité" icon="drop" actions={<span>% · pas {bucketLabel}</span>}>
          <LineChart title="Humidité" unit="%" digits={0} domain={[0, 100]} points={series.hum} {...chartProps} />
        </Card>
        <Card title="Gaz (pic)" icon="gas" actions={<span>ADC 0–4095 · pas {bucketLabel}</span>}>
          <LineChart title="Gaz (pic)" unit="" digits={0} points={series.gas} {...chartProps} />
        </Card>
        <Card title="Présence" icon="user" actions={<span>% du temps · pas {bucketLabel}</span>}>
          <LineChart title="Présence" unit="%" digits={0} domain={[0, 100]} points={series.presence} {...chartProps} />
        </Card>
      </div>

      <Card title="Journal" icon="log" actions={
        <div className="segmented" role="tablist" aria-label="Journal">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}<span className={`count${t.id === "alerts" && t.count ? " hot" : ""}`}>{t.count}</span>
            </button>
          ))}
        </div>
      }>
        {tab === "alerts" && (
          <div>
            <div className="log-tools">
              <div className="pills">
                {byType.map((b) => <span className="pill" key={b.label}>{b.label}<b>{b.value}</b></span>)}
              </div>
              <label className="check"><input type="checkbox" checked={unackOnly} onChange={(e) => setUnackOnly(e.target.checked)} />
                Non acquittées uniquement</label>
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
                      <td>{a.source_sensor ?? "—"}</td>
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
          </div>
        )}
        {tab === "access" && (
          <div>
            <p className="sub" style={{ marginTop: 0 }}>{access.length} passage(s) : {granted} accordé(s), {access.length - granted} refusé(s)</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Heure</th><th>Badge</th><th>Agent</th><th>Porte</th><th>Décision</th></tr></thead>
                <tbody>
                  {access.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{dateTime(a.ts)}</td>
                      <td>{a.card_uid}</td>
                      <td>{a.user_name ?? <span className="muted">inconnu</span>}{a.clearance_level && <span className="muted"> · {a.clearance_level}</span>}</td>
                      <td>{a.door_id ?? "—"}</td>
                      <td><StatusBadge status={a.access_granted ? "good" : "critical"}>{a.access_granted ? "Accordé" : "Refusé"}</StatusBadge></td>
                    </tr>
                  ))}
                  {!access.length && <tr><td colSpan={5} className="muted">Aucun passage sur la période</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === "commands" && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Heure</th><th>Action</th><th>Message MQTT</th></tr></thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap">{dateTime(c.created_at)}</td>
                    <td>{c.action ?? "—"}</td>
                    <td>{JSON.stringify(c.payload)}</td>
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
