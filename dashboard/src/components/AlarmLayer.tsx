// Signalisation d'alerte du tableau de bord : halo d'écran, bandeau, sirène, titre d'onglet, vibration.
// Piloté par le même état que l'hologramme (mesures en direct + alertes reçues depuis moins de 30 s) :
// tout s'arrête de lui-même quand la situation redevient normale.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";

export type AlarmLevel = "critical" | "warning" | null;

const MUTE_KEY = "sentinel.alarmMuted";
const SIREN_EVERY_MS = 2_500;
const BASE_TITLE = typeof document !== "undefined" ? document.title : "SENTINEL-X";

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

/** Sirène courte à deux tons (Web Audio, aucun fichier son). Le navigateur n'autorise le son qu'après
 *  une interaction sur la page : sinon `blocked` passe à true et le bandeau propose de l'activer. */
function useSiren(active: boolean, muted: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  const [blocked, setBlocked] = useState(false);

  const beep = () => {
    const ac = (ctx.current ??= new AudioContext());
    if (ac.state === "suspended") { ac.resume().catch(() => {}); }
    setBlocked(ac.state !== "running");
    if (ac.state !== "running") return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(660, t + 0.22);
    osc.frequency.setValueAtTime(880, t + 0.44);
    osc.frequency.setValueAtTime(660, t + 0.66);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    gain.gain.setValueAtTime(0.08, t + 0.84);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.92);
  };

  useEffect(() => {
    if (!active || muted) return;
    beep();
    navigator.vibrate?.([300, 150, 300]);
    const id = setInterval(beep, SIREN_EVERY_MS);
    return () => clearInterval(id);
  }, [active, muted]);

  useEffect(() => () => { ctx.current?.close().catch(() => {}); }, []);

  /** Appelé depuis un clic : débloque le son du navigateur et rejoue la sirène. */
  const unlock = () => { setBlocked(false); beep(); };
  return { blocked: blocked && active && !muted, unlock };
}

export interface AlarmReason { key: string; label: string; detail?: string; }

interface Props {
  level: AlarmLevel;
  reasons: AlarmReason[];
  ackIds: number[];               // alertes non acquittées que le bouton « Acquitter » traite
  canOperate: boolean;
  onAck: (ids: number[]) => void;
  preview?: boolean;              // état simulé (boutons d'aperçu) : signalé comme tel
}

export function AlarmLayer({ level, reasons, ackIds, canOperate, onAck, preview = false }: Props) {
  const [muted, setMuted] = useState(readMuted);
  const siren = useSiren(level === "critical", muted);

  // Titre de l'onglet : l'alerte se voit même quand le tableau de bord n'est pas l'onglet actif.
  useEffect(() => {
    if (level !== "critical") return;
    document.title = `⚠ ${preview ? "APERÇU" : "ALERTE"} · ${BASE_TITLE}`;
    return () => { document.title = BASE_TITLE; };
  }, [level, preview]);

  const toggleMute = () => {
    setMuted((m) => {
      try { localStorage.setItem(MUTE_KEY, m ? "0" : "1"); } catch { /* stockage indisponible */ }
      return !m;
    });
  };

  if (!level) return null;
  const critical = level === "critical";
  return (
    <>
      <div className={`alarm-overlay ${level}`} aria-hidden />
      <div className={`alarm-banner ${level}`} role="alert" aria-live="assertive">
        <span className="alarm-siren" aria-hidden><Icon name={critical ? "bell" : "user"} size={20} /></span>
        <div className="alarm-text">
          <strong>{critical ? "Alerte critique" : "Vigilance"}</strong>{preview && <span className="alarm-preview">Aperçu</span>}
          <ul>
            {reasons.map((r) => (
              <li key={r.key}>{r.label}{r.detail && <span className="alarm-detail"> · {r.detail}</span>}</li>
            ))}
          </ul>
        </div>
        <div className="alarm-actions">
          {siren.blocked && <button className="btn btn-sm" onClick={siren.unlock}>Activer le son</button>}
          {critical && (
            <button className="btn btn-sm btn-ghost" onClick={toggleMute} aria-pressed={muted}
                    title={muted ? "Réactiver la sirène" : "Couper la sirène"}>
              {muted ? "Son coupé" : "Couper le son"}
            </button>
          )}
          {ackIds.length > 0 && (
            <button className="btn btn-sm alarm-ack" disabled={!canOperate} onClick={() => onAck(ackIds)}>
              Acquitter{ackIds.length > 1 ? ` (${ackIds.length})` : ""}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
