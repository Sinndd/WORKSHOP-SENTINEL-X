import { motion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { download, fetchSnapshot, getJson, postJson, Unauthorized } from "./api";
import type { PaletteCommand } from "./components/CommandPalette";
import type { HoloMode } from "./components/Hologram";
import { LineChart, type Point } from "./components/LineChart";
import { QuickEnroll } from "./Badges";
import { Card, Icon, StatTile, StatusBadge, type Status } from "./components/ui";
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
const LIVE_MS = 1_000;          // état du module + dernière mesure (2 requêtes légères)
const FULL_REFRESH_MS = 10_000; // courbes agrégées, journal, flux (plus coûteux pour le Pi)
const ONLINE_WITHIN_MS = 15_000;
const GAS_HIGH = 614;          // seuil local du firmware (A0 >= 150 sur 1023)
const TEMP_HIGH = 40;
// Une alerte colore l'hologramme pendant 30 s après sa réception, puis il revient à l'état réel des capteurs.
// Les alertes non acquittées restent signalées dans le journal.
const RECENT_ALERT_MS = 30_000;

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
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError(`Chargement impossible : ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [token, range, onExpired]);

  // Rafraîchissement rapide : seulement le module et la dernière mesure (indicateurs, hologramme, état en ligne).
  const liveBusy = useRef(false);
  const loadLive = useCallback(async () => {
    if (liveBusy.current) return;              // pas de requêtes empilées si le réseau ralentit
    liveBusy.current = true;
    try {
      const [devices, latest] = await Promise.all([
        getJson<Device[]>("/api/v1/devices", token),
        getJson<Telemetry>(`/api/v1/telemetry/latest?node_id=${NODE}`, token).catch((e) => { if (e instanceof Unauthorized) throw e; return null; }),
      ]);
      setData((prev) => prev && { ...prev, latest, device: devices.find((d) => d.node_id === NODE) ?? devices[0] ?? null });
      setError(null);
      setNow(Date.now());
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError(`Chargement impossible : ${(e as Error).message}`);
    } finally {
      liveBusy.current = false;
    }
  }, [token, onExpired]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const live = setInterval(loadLive, LIVE_MS);
    const full = setInterval(load, FULL_REFRESH_MS);
    return () => { clearInterval(live); clearInterval(full); };
  }, [auto, load, loadLive]);

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
            Temps réel (1 s)
          </label>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={exportCsv}>Exporter CSV</button>
        </div>

        {data && (
          <Dashboard
            data={data} online={online} now={now} loading={loading} hoverT={hoverT} setHoverT={setHoverT}
            unackOnly={unackOnly} setUnackOnly={setUnackOnly} tab={tab} setTab={setTab} canOperate={canOperate} token={token} onExpired={onExpired}
            onAck={acknowledge} onAirlock={triggerAirlock} onAlarm={triggerAlarm} onEmergencyStop={triggerEmergencyStop}
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

const CAMERA_POLL_MS = 2_000;
const CAMERA_MAX_AGE_MS = 15_000;   // au-delà, la dernière image est considérée comme figée : caméra hors ligne

/** Incrustation caméra (coin de l'hologramme) : « Live » si le script IA envoie des images récentes, sinon « Offline ».
 *  L'image est chargée en blob car le jeton ne peut pas passer par un simple <img src>. */
function CameraInset({ token, expanded, onToggle }: { token: string; expanded: boolean; onToggle: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = () => fetchSnapshot("/api/v1/vision/snapshot", token, CAMERA_MAX_AGE_MS)
      .then((r) => {
        if (cancelled) { if (r.url) URL.revokeObjectURL(r.url); return; }
        setLive(r.live);
        setSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return r.url; });
      })
      .catch(() => { if (!cancelled) { setLive(false); setSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }); } });
    poll();
    const id = setInterval(poll, CAMERA_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [token]);
  return (
    // Animation de mise en page (Motion) : la fenêtre grandit depuis son coin. À l'agrandissement elle part
    // avec un léger retard pour que Wall-E prenne de l'avance ; à la réduction elle se rétracte d'abord.
    <motion.div layout transition={{ layout: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: expanded ? 0.12 : 0 } }}
         className={`cam-pip ${live ? "is-live" : "is-offline"}${expanded ? " expanded" : ""}`}
         aria-label={`Caméra IA : ${live ? "en direct" : "hors ligne"}`} onDoubleClick={onToggle}>
      {live && src ? <motion.img layout src={src} alt="Image en direct de la caméra IA" /> : <motion.span layout="position" className="cam-icon"><Icon name="cam" size={expanded ? 34 : 22} /></motion.span>}
      <motion.span layout="position" className={`cam-badge ${live ? "live" : "offline"}`}><i aria-hidden />{live ? "Live" : "Offline"}</motion.span>
      <motion.button layout="position" type="button" className="cam-toggle" onClick={onToggle} aria-pressed={expanded}
              title={expanded ? "Réduire la caméra" : "Agrandir la caméra"} aria-label={expanded ? "Réduire la caméra" : "Agrandir la caméra"}>
        <Icon name={expanded ? "shrink" : "expand"} size={14} />
      </motion.button>
    </motion.div>
  );
}

function NodeStatus({ device, now }: { device: Device | null; now: number }) {
  if (!device) return <span className="node-pill off"><i aria-hidden />Aucun module</span>;
  const online = device.last_seen != null && now - Date.parse(device.last_seen) < ONLINE_WITHIN_MS;
  const details = [`Dernier signal ${ago(device.last_seen, now)}`,
    device.last_wifi_rssi_dbm != null ? `Wi-Fi ${device.last_wifi_rssi_dbm} dBm` : null,
    device.last_free_heap_bytes != null ? `RAM libre ${Math.round(device.last_free_heap_bytes / 1024)} Ko` : null].filter(Boolean).join(" · ");
  return (
    <span className={`node-pill ${online ? "on" : "off"}`} title={details}>
      <i aria-hidden />{device.node_id} · {online ? "En ligne" : `Hors ligne depuis ${ago(device.last_seen, now).replace("il y a ", "")}`}
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
  canOperate: boolean;
  token: string;
  onExpired: () => void;
}

function Dashboard({
  data, online, now, loading, hoverT, setHoverT, unackOnly, setUnackOnly, tab, setTab, onAck,
  onAirlock, onAlarm, onEmergencyStop, canOperate, token, onExpired,
}: DashboardProps) {
  const { agg, latest, alerts, access, commands } = data;
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
  const chartProps = { start, end, bucketMs, hoverT, onHover: setHoverT, height: 170 };
  const hasRange = s.samples > 0;
  const [camExpanded, setCamExpanded] = useState(false);
  const feed = useMemo(() => feedItems(data).slice(0, 40), [data]);

  const gasHigh = (latest?.gas_raw_ppm ?? 0) >= GAS_HIGH;
  const tempHigh = (latest?.temperature_celsius ?? 0) >= TEMP_HIGH;
  const presence = Boolean(online && latest?.presence_detected);
  // État actuel du module : mesures en direct + alertes très récentes (pas l'historique non acquitté).
  const recentAlert = (sev: Severity) => alerts.some((a) => a.severity === sev && !a.acknowledged
    && now - Date.parse(a.received_at) < RECENT_ALERT_MS);
  const mode: HoloMode = !online ? "offline"
    : gasHigh || tempHigh || recentAlert("CRITICAL") ? "critical"
    : presence || recentAlert("WARNING") ? "warning" : "nominal";

  const tabs: { id: JournalTab; label: string; count: number }[] = [
    { id: "alerts", label: "Alertes", count: unack.length },
    { id: "access", label: "Accès RFID", count: access.length },
    { id: "commands", label: "Commandes", count: commands.length },
  ];

  return (
    <div className={loading ? "loading" : undefined}>
      {/* Haut : courbes de part et d'autre de l'hologramme (caméra incrustée en haut à droite) */}
      <div className="control-room">
        <div className="stack charts-col">
          <Card title="Température" icon="temp" actions={<span>°C</span>}>
            <LineChart title="Température" unit="°C" points={series.temp} {...chartProps} />
          </Card>
          <Card title="Humidité" icon="drop" actions={<span>%</span>}>
            <LineChart title="Humidité" unit="%" digits={0} domain={[0, 100]} points={series.hum} {...chartProps} />
          </Card>
        </div>

        <div className="holo-col">
          <Card title="Hologramme · Wall-E MK2" icon="cube" className={`mode-${mode}`}
                actions={<StatusBadge status={mode === "nominal" ? "good" : mode === "warning" ? "warning" : mode === "critical" ? "critical" : "neutral"}>
                  {MODE_LABEL[mode]}</StatusBadge>}>
            <div className={`holo flush${camExpanded ? " cam-expanded" : ""}`}>
              {/* La scène 3D se resserre à gauche quand la caméra est agrandie : Wall-E se recentre dans l'espace restant. */}
              <div className="holo-stage">
                <Suspense fallback={<div className="holo-fallback">Chargement du moteur 3D…</div>}>
                  <Hologram mode={mode} presence={presence} shifted={camExpanded} />
                </Suspense>
                <span className="holo-hint">Glisser pour pivoter · molette pour zoomer</span>
              </div>
              <CameraInset token={token} expanded={camExpanded} onToggle={() => setCamExpanded((v) => !v)} />
            </div>
          </Card>
        </div>

        <div className="stack charts-col">
          <Card title="Gaz (pic)" icon="gas" actions={<span>valeur brute</span>}>
            <LineChart title="Gaz (pic)" unit="" digits={0} points={series.gas} {...chartProps} />
          </Card>
          <Card title="Présence" icon="user" actions={<span>% du temps</span>}>
            <LineChart title="Présence" unit="%" digits={0} domain={[0, 100]} points={series.presence} {...chartProps} />
          </Card>
        </div>
      </div>

      {/* Bas : relevés, commandes, flux d'événements */}
      <div className="bottom-row">
        <Card title="Relevés" icon="gauge">
          <div className="readouts">
            <StatTile icon="temp" label="Température" value={num(latest?.temperature_celsius)} unit="°C" tone={tempHigh ? "critical" : "neutral"}
              detail={hasRange ? `${num(s.temperature_min)} – ${num(s.temperature_max)} °C` : undefined} />
            <StatTile icon="drop" label="Humidité" value={num(latest?.humidity_percent, 0)} unit="%"
              detail={hasRange ? `${num(s.humidity_min, 0)} – ${num(s.humidity_max, 0)} %` : undefined} />
            <StatTile icon="gas" label="Gaz" value={num(latest?.gas_raw_ppm, 0)} tone={gasHigh ? "critical" : "neutral"}
              detail={hasRange ? `pic ${num(s.gas_max, 0)}` : undefined} />
            <StatTile icon="user" label="Présence" value={latest?.presence_detected == null ? "—" : latest.presence_detected ? "Oui" : "Non"}
              tone={presence ? "warning" : "neutral"}
              detail={hasRange ? `${num((s.presence_ratio ?? 0) * 100, 0)} % du temps` : undefined} />
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
        </Card>

        {canOperate && <QuickEnroll token={token} onExpired={onExpired} />}

        <Card title="Flux d'événements" icon="pulse">
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
