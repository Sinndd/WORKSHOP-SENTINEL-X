import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { num, tick } from "../format";

export interface Point {
  t: number;          // début de l'intervalle (ms epoch)
  v: number | null;
}

interface Props {
  title: string;
  unit: string;
  points: Point[];
  start: number;      // bornes de la période (ms) : identiques pour tous les graphiques
  end: number;
  bucketMs: number;
  digits?: number;
  domain?: [number, number];        // échelle fixe (ex. 0-100 %)
  hoverT: number | null;            // curseur partagé entre les graphiques
  onHover: (t: number | null) => void;
}

const HEIGHT = 150;
const M = { top: 8, right: 10, bottom: 22, left: 38 };

/** Graduations « rondes » (1, 2, 5 x 10^n). */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  // De la graduation sous le minimum jusqu'à la première graduation >= maximum (toutes les valeurs dans l'axe).
  let v = Math.floor(min / step) * step;
  const ticks = [Number(v.toFixed(10))];
  while (v < max - step * 1e-9) { v += step; ticks.push(Number(v.toFixed(10))); }
  return ticks;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function LineChart({ title, unit, points, start, end, bucketMs, digits = 1, domain, hoverT, onHover }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const values = points.map((p) => p.v).filter((v): v is number => v != null);
  const span = Math.max(1, end - start);
  const ticksY = domain
    ? niceTicks(domain[0], domain[1])
    : values.length ? niceTicks(Math.min(...values), Math.max(...values)) : [0, 1];
  const yMin = ticksY[0], yMax = ticksY[ticksY.length - 1];
  const w = width - M.left - M.right, h = HEIGHT - M.top - M.bottom;
  const x = (t: number) => M.left + ((t + bucketMs / 2 - start) / span) * w;   // milieu de l'intervalle
  const y = (v: number) => M.top + h - ((v - yMin) / (yMax - yMin || 1)) * h;

  // Segments : la ligne s'interrompt quand des intervalles manquent (ESP hors ligne).
  // Un segment d'un seul point (mesure isolée) n'a pas de longueur : il est dessiné comme un point.
  const runs: Point[][] = [];
  let run: Point[] = [];
  let prevT: number | null = null;
  for (const p of points) {
    const gap = prevT != null && p.t - prevT > bucketMs * 1.5;
    if (p.v == null || gap) { if (run.length) runs.push(run); run = []; }
    if (p.v != null) run.push(p);
    prevT = p.t;
  }
  if (run.length) runs.push(run);
  const segments = runs.filter((r) => r.length > 1)
    .map((r) => r.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join(""));
  const isolated = runs.filter((r) => r.length === 1).map((r) => r[0]);

  const ticksX = Array.from({ length: Math.max(2, Math.min(6, Math.floor(w / 110))) + 1 },
    (_, i) => start + (span * i) / Math.max(2, Math.min(6, Math.floor(w / 110))));
  const hovered = hoverT == null ? null : points.find((p) => p.t === hoverT) ?? null;

  const nearest = (clientX: number, rect: DOMRect) => {
    if (!points.length) return null;
    const t = start + ((clientX - rect.left - M.left) / w) * span - bucketMs / 2;
    return points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)).t;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) =>
    onHover(nearest(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    if (!points.length || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const i = hoverT == null ? points.length - 1 : points.findIndex((p) => p.t === hoverT);
    const next = points[Math.min(points.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)))];
    onHover(next.t);
  };

  const last = values.length ? values[values.length - 1] : null;
  return (
    <div className="chart" ref={ref}>
      <svg height={HEIGHT} role="img"
        aria-label={`${title} : ${points.length} intervalles, dernière valeur ${num(last, digits)} ${unit}`}>
        {ticksY.map((v) => (
          <g key={v}>
            <line className={v === yMin ? "baseline" : "gridline"} x1={M.left} x2={M.left + w} y1={y(v)} y2={y(v)} />
            <text className="tick" x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end">{num(v, Math.abs(yMax - yMin) < 5 ? 1 : 0)}</text>
          </g>
        ))}
        {ticksX.map((t, i) => (
          <text key={t} className="tick" x={M.left + ((t - start) / span) * w} y={HEIGHT - 6}
            textAnchor={i === 0 ? "start" : i === ticksX.length - 1 ? "end" : "middle"}>{tick(t, span)}</text>
        ))}
        {segments.map((d, i) => <path key={i} className="line" d={d} />)}
        {isolated.map((p) => <circle key={p.t} className="marker" cx={x(p.t)} cy={y(p.v!)} r={4} />)}
        {runs.length === 0 && (
          <text className="empty" x={M.left + w / 2} y={M.top + h / 2} textAnchor="middle">Aucune donnée sur la période</text>
        )}
        {hovered && (
          <g>
            <line className="crosshair" x1={x(hovered.t)} x2={x(hovered.t)} y1={M.top} y2={M.top + h} />
            {hovered.v != null && <circle className="marker" cx={x(hovered.t)} cy={y(hovered.v)} r={4} />}
          </g>
        )}
        <rect className="hit" x={M.left} y={M.top} width={w} height={h} tabIndex={0}
          aria-label={`${title} : flèches gauche/droite pour parcourir les valeurs`}
          onPointerMove={onMove} onPointerLeave={() => onHover(null)} onFocus={() => onHover(hoverT ?? points.at(-1)?.t ?? null)}
          onBlur={() => onHover(null)} onKeyDown={onKey} />
      </svg>
      {hovered && (
        <div className="tooltip" style={{
          left: Math.min(Math.max(x(hovered.t) + 12, 0), width - 150),
        }}>
          <strong><span className="key" />{num(hovered.v, digits)} {unit}</strong>
          <span>{title}</span><br />
          <span className="when">{new Date(hovered.t).toLocaleString("fr-FR")}</span>
        </div>
      )}
    </div>
  );
}
