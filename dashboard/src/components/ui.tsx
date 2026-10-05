import type { ReactNode } from "react";

export type Status = "good" | "warning" | "serious" | "critical" | "neutral";

const ICONS: Record<Status, string> = { good: "✓", warning: "▲", serious: "▲", critical: "✕", neutral: "•" };

/** Statut : couleur réservée + icône + libellé (jamais la couleur seule). */
export function StatusBadge({ status, children }: { status: Status; children: ReactNode }) {
  const color = status === "neutral" ? "var(--text-muted)" : `var(--${status})`;
  return (
    <span className="badge">
      <span className="dot" style={{ background: color }} aria-hidden />
      <span className="icon" aria-hidden>{ICONS[status]}</span>
      {children}
    </span>
  );
}

export function Card({ title, sub, children, className = "" }: { title: string; sub?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <h2>{title}</h2>
      {sub && <p className="sub">{sub}</p>}
      {children}
    </section>
  );
}

export function StatTile({ label, value, unit, detail }: { label: string; value: string; unit?: string; detail?: ReactNode }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
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
          <span className="track" role="cell"><span className="bar" style={{ display: "block", width: r.value ? `max(2px, ${(r.value / max) * 100}%)` : 0 }} title={`${r.label} : ${r.value}`} /></span>
          <span className="val" role="cell">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
