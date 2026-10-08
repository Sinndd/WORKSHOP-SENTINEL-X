import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson, Unauthorized } from "./api";
import { Card } from "./components/ui";

type Target = "ARM_LEFT" | "ARM_RIGHT" | "HEAD" | "TRAP_REAR";
type Pose = { ARM_LEFT: number; ARM_RIGHT: number; HEAD: number };

const AXES: { target: keyof Pose; label: string; min: number; max: number; rest: number }[] = [
  { target: "ARM_LEFT", label: "Bras gauche", min: 0, max: 180, rest: 90 },
  { target: "ARM_RIGHT", label: "Bras droit", min: 0, max: 180, rest: 90 },
  { target: "HEAD", label: "Tête", min: -90, max: 90, rest: 0 },
];

const PRESETS: { label: string; pose: Pose }[] = [
  { label: "Repos", pose: { ARM_LEFT: 90, ARM_RIGHT: 90, HEAD: 0 } },
  { label: "Bras levés", pose: { ARM_LEFT: 150, ARM_RIGHT: 150, HEAD: 0 } },
  { label: "Salut", pose: { ARM_LEFT: 90, ARM_RIGHT: 150, HEAD: 30 } },
  { label: "Regard à gauche", pose: { ARM_LEFT: 90, ARM_RIGHT: 90, HEAD: -60 } },
];

// Commandes à distance des bras, de la tête et de la trappe arrière (POST /api/v1/actuators/move).
// Les curseurs envoient l'ordre au relâchement (et au plus toutes les 250 ms pendant le glissement).
export function RobotControl({ token, onExpired, canOperate }: { token: string; onExpired: () => void; canOperate: boolean }) {
  const [pose, setPose] = useState<Pose>({ ARM_LEFT: 90, ARM_RIGHT: 90, HEAD: 0 });
  const [error, setError] = useState<string | null>(null);
  const lastSent = useRef<Record<string, number>>({});
  const touched = useRef<Record<string, number>>({});
  const [real, setReal] = useState<Partial<Record<keyof Pose, number>> | null>(null);   // positions rapportées par l'ESP32
  const [stale, setStale] = useState(true);

  // Se recale sur les positions réelles toutes les 2 s, sauf pour un axe que l'utilisateur vient de commander.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const st = await getJson<{ arm_left_deg: number | null; arm_right_deg: number | null; head_deg: number | null; age_s: number | null }>(
          "/api/v1/actuators/state", token);
        if (!alive) return;
        const r = { ARM_LEFT: st.arm_left_deg, ARM_RIGHT: st.arm_right_deg, HEAD: st.head_deg };
        setStale(st.age_s == null || st.age_s > 15);
        const now = Date.now();
        setReal(Object.fromEntries(Object.entries(r).filter(([, v]) => v != null)) as Partial<Record<keyof Pose, number>>);
        setPose((p) => {
          const next = { ...p };
          (Object.keys(r) as (keyof Pose)[]).forEach((k) => {
            if (r[k] != null && now - (touched.current[k] ?? 0) > 4000) next[k] = r[k] as number;
          });
          return next;
        });
      } catch (e) {
        if (e instanceof Unauthorized) onExpired();
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [token, onExpired]);

  const move = useCallback(async (target: Target, command: string, angle?: number) => {
    try {
      await postJson("/api/v1/actuators/move", token, { target, command, ...(angle === undefined ? {} : { angle }) });
      setError(null);
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError((e as Error).message);
    }
  }, [token, onExpired]);

  const setAngle = (target: keyof Pose, angle: number, force = false) => {
    setPose((p) => ({ ...p, [target]: angle }));
    const now = Date.now();
    touched.current[target] = now;   // l'utilisateur tient la main : pas de recalage pendant 4 s
    if (force || now - (lastSent.current[target] ?? 0) > 250) {
      lastSent.current[target] = now;
      void move(target, "SET_ANGLE", angle);
    }
  };
  const applyPose = (p: Pose) => {
    setPose(p);
    AXES.forEach((a) => { touched.current[a.target] = Date.now(); });
    AXES.forEach((a) => void move(a.target, "SET_ANGLE", p[a.target]));
  };

  return (
    <Card title="Bras, tête et trappe arrière" icon="bolt" sub={!canOperate ? "Compte en lecture seule : commandes désactivées." : stale ? "Positions réelles indisponibles (aucune télémétrie récente)." : "Les curseurs se recalent sur les positions réelles du robot."}>
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      <fieldset className="ctl" disabled={!canOperate}>
        {AXES.map((a) => (
          <div className="ctl-row" key={a.target}>
            <div className="ctl-info"><strong>{a.label}</strong><span className="state">{pose[a.target]}°{real?.[a.target] != null && !stale ? ` (réel ${real[a.target]}°)` : ""}</span></div>
            <input type="range" aria-label={a.label} min={a.min} max={a.max} step={1} value={pose[a.target]}
                   style={{ flex: "1 1 160px", minWidth: 120 }}
                   onChange={(e) => setAngle(a.target, Number(e.target.value))}
                   onPointerUp={(e) => setAngle(a.target, Number((e.target as HTMLInputElement).value), true)}
                   onKeyUp={(e) => setAngle(a.target, Number((e.target as HTMLInputElement).value), true)} />
            <div className="ctl-btns">
              <button className="btn btn-sm" onClick={() => { touched.current[a.target] = Date.now(); setPose((p) => ({ ...p, [a.target]: a.rest })); void move(a.target, "CENTER"); }}>Centrer</button>
            </div>
          </div>
        ))}
        <div className="ctl-row">
          <div className="ctl-info"><strong>Trappe arrière</strong></div>
          <div className="ctl-btns">
            <button className="btn btn-sm" onClick={() => void move("TRAP_REAR", "OPEN")}>Ouvrir</button>
            <button className="btn btn-sm" onClick={() => void move("TRAP_REAR", "CLOSE")}>Fermer</button>
          </div>
        </div>
        <div className="ctl-row">
          <div className="ctl-info"><strong>Postures</strong></div>
          <div className="ctl-btns" style={{ flexWrap: "wrap" }}>
            {PRESETS.map((p) => <button className="btn btn-sm" key={p.label} onClick={() => applyPose(p.pose)}>{p.label}</button>)}
          </div>
        </div>
      </fieldset>
    </Card>
  );
}
