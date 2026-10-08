import type { ReactNode } from "react";

export type Status = "good" | "warning" | "serious" | "critical" | "neutral";

const ICONS: Record<Status, string> = { good: "✓", warning: "▲", serious: "▲", critical: "✕", neutral: "•" };

/** Statut : couleur réservée + icône + libellé (jamais la couleur seule). */
export function StatusBadge({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="icon" aria-hidden>{ICONS[status]}</span>
      {children}
    </span>
  );
}

// Icônes 16x16 (traits), héritent de la couleur du texte.
const PATHS: Record<string, string> = {
  temp: "M8 2v7.2a3 3 0 1 0 0 0M8 2a1.5 1.5 0 0 1 3 0v7.2a3.4 3.4 0 1 1-3 0",
  drop: "M8 1.5S3.5 6.5 3.5 9.6a4.5 4.5 0 0 0 9 0C12.5 6.5 8 1.5 8 1.5z",
  gas: "M8 1.5c1 2.5 4 3.8 4 7a4 4 0 0 1-8 0c0-1.4.7-2.4 1.5-3.2.2 1 .8 1.7 1.5 1.7C7.5 5.5 7 3.5 8 1.5z",
  face: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM5.5 6.5v1M10.5 6.5v1M5.5 10a3.5 3.5 0 0 0 5 0",
  user: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14a5.5 5.5 0 0 1 11 0",
  bell: "M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14a1.5 1.5 0 0 0 3 0",
  wifi: "M1.5 6a9 9 0 0 1 13 0M3.8 8.6a5.8 5.8 0 0 1 8.4 0M6.1 11.2a2.6 2.6 0 0 1 3.8 0M8 13.4v.1",
  shield: "M8 1.5l5.5 2v4c0 3.2-2.3 5.6-5.5 7-3.2-1.4-5.5-3.8-5.5-7v-4z",
  cam: "M2 5h8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM11 7.2l4-1.7v5l-4-1.7",
  bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z",
  log: "M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3",
  cube: "M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM2.5 4.5L8 7.5l5.5-3M8 7.5v7",
  pulse: "M1.5 8h3l1.5-4 3 8 1.5-4h4",
  gauge: "M2.5 11a5.5 5.5 0 1 1 11 0M8 11l3-3.5",
  chart: "M2 13.5h12M3.5 11l3-4 2.5 2 4-5.5",
  expand: "M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9",
  shrink: "M9 2.5V7h4.5M7 13.5V9H2.5M9 7l4.5-4.5M7 9l-4.5 4.5",
  search: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5",
  logout: "M6.5 2.5h-3v11h3M10.5 5l3 3-3 3M13.5 8H6",
  download: "M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11",
  theme: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 1.5v13M8 4.5h4.6M8 8h6.5M8 11.5h4.6",
  lock: "M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5",
  unlock: "M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 4.9-.7",
  "bell-off": "M4 11V7a4 4 0 0 1 6.6-3M12 7.5V11l1 1.5H6.5M6.5 14a1.5 1.5 0 0 0 3 0M2 2l12 12",
  volume: "M2.5 6h2.5l3.5-3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9",
  mute: "M2.5 6h2.5l3.5-3v10L5 10H2.5zM11 6l3.5 4M14.5 6L11 10",
  check: "M3 8.5l3 3 7-7",
  card: "M2 4h12v8.5H2zM4.5 7.5h3M4.5 10h5",
  users: "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5a4.5 4.5 0 0 1 9 0M10.5 2.7a2.5 2.5 0 0 1 0 4.6M12 9.3a4.5 4.5 0 0 1 2.5 4.2",
  play: "M5 3l8 5-8 5z",
  pause: "M5.5 3v10M10.5 3v10",
  edit: "M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3",
  key: "M5.5 10.5a3 3 0 1 1 2.1-.9L13.5 3.7M11 6.2l1.6 1.6M12.5 4.7l1.2 1.2",
  close: "M3.5 3.5l9 9M12.5 3.5l-9 9",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  "user-off": "M7 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 13.5a5 5 0 0 1 7.5-4.3M11 10.5l3 3M14 10.5l-3 3",
  "user-on": "M7 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 13.5a5 5 0 0 1 7.5-4.3M10.5 12l1.5 1.5 3-3",
  "shield-off": "M8 1.5l5.5 2v4c0 3.2-2.3 5.6-5.5 7-3.2-1.4-5.5-3.8-5.5-7v-4zM5.5 6l5 5M10.5 6l-5 5",
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

export function Card({ title, sub, icon, actions, children, className = "" }:
  { title: string; sub?: ReactNode; icon?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h2>{icon && <Icon name={icon} />}{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
      {sub && <p className="sub">{sub}</p>}
      {children}
    </section>
  );
}

export function StatTile({ label, value, unit, detail, icon, tone = "neutral" }:
  { label: string; value: string; unit?: string; detail?: ReactNode; icon?: string; tone?: Status }) {
  return (
    <div className={`tile tone-${tone}`}>
      <div className="tile-top">
        <span className="label">{icon && <Icon name={icon} size={14} />}{label}</span>
        {tone !== "neutral" && <span className="pulse" aria-hidden />}
      </div>
      <div className="value">{value}{unit && value !== "—" && <small>{unit}</small>}</div>
      {detail && <div className="range">{detail}</div>}
    </div>
  );
}

/** Barres horizontales, une seule série (couleur slot 1), valeurs en texte. */
export function BarList({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="barlist" role="table" aria-label="Répartition">
      {rows.map((r) => (
        <div key={r.label} role="row" style={{ display: "contents" }}>
          <span className="lbl" role="rowheader">{r.label}</span>
          <span className="track" role="cell"><span className="bar" style={{ display: "block", width: r.value ? `max(4px, ${(r.value / max) * 100}%)` : 0 }} title={`${r.label} : ${r.value}`} /></span>
          <span className="val" role="cell">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
