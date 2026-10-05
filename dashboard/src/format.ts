const nf = (digits: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function num(v: number | null | undefined, digits = 1): string {
  return v == null || Number.isNaN(v) ? "—" : nf(digits).format(v);
}

export function dateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Libellé d'axe : heure seule sur une journée, date + heure au-delà. */
export function tick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 36 * 3600_000) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit" }) + "h";
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "jamais";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
