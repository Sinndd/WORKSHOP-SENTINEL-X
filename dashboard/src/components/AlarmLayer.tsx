// Signalisation d'alerte du tableau de bord : halo d'écran, bandeau, son d'alarme, titre d'onglet, vibration.
// Piloté par le même état que l'hologramme (mesures en direct + alertes reçues depuis moins de 30 s) :
// tout s'arrête de lui-même quand la situation redevient normale.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";

export type AlarmLevel = "critical" | "warning" | null;

const MUTE_KEY = "sentinel.alarmMuted";
const BASE_TITLE = typeof document !== "undefined" ? document.title : "SENTINEL-X";

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

/** Son d'alarme (public/sounds/alarme.mp3) joué en boucle pendant l'alerte critique, arrêté et rembobiné ensuite.
 *  Le navigateur n'autorise le son qu'après une interaction sur la page : sinon `blocked` passe à true et le
 *  bandeau propose de l'activer. */
const ALARM_URL = `${import.meta.env.BASE_URL}sounds/alarme.mp3`;
const ALARM_VOLUME = 0.7;

function useSiren(active: boolean, muted: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [blocked, setBlocked] = useState(false);

  const element = () => {
    if (!audio.current) {
      const a = new Audio(ALARM_URL);
      a.loop = true;
      a.preload = "auto";
      a.volume = ALARM_VOLUME;
      audio.current = a;
    }
    return audio.current;
  };
  const play = () => {
    element().play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  };

  useEffect(() => {
    if (!active || muted) return;
    play();
    navigator.vibrate?.([300, 150, 300]);
    return () => {
      const a = audio.current;
      if (a) { a.pause(); a.currentTime = 0; }
    };
  }, [active, muted]);

  useEffect(() => () => { audio.current?.pause(); audio.current = null; }, []);

  /** Appelé depuis un clic : débloque le son du navigateur et lance l'alarme. */
  const unlock = () => play();
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
          {siren.blocked && <button className="icon-btn" onClick={siren.unlock} aria-label="Activer le son" title="Activer le son">
            <Icon name="volume" size={16} /></button>}
          {critical && (
            <button className="icon-btn" onClick={toggleMute} aria-pressed={muted}
                    aria-label={muted ? "Réactiver la sirène" : "Couper la sirène"} title={muted ? "Réactiver la sirène" : "Couper la sirène"}>
              <Icon name={muted ? "mute" : "volume"} size={16} />
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
