import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

/** Palette de commandes (Ctrl-K / ⌘K), façon WorldMonitor : filtrage au clavier, ↑ ↓ Entrée, Échap. */
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const shown = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => terms.every((t) => `${c.group} ${c.label}`.toLowerCase().includes(t)));
  }, [commands, query]);
  useEffect(() => { setIndex(0); }, [query]);

  const exec = (c: PaletteCommand | undefined) => { if (!c) return; onClose(); c.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); exec(shown[index]); }
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Palette de commandes" onKeyDown={onKey}>
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="> tapez une commande…"
               role="combobox" aria-expanded="true" aria-controls="palette-list"
               aria-activedescendant={shown[index] ? `cmd-${shown[index].id}` : undefined} />
        <ul id="palette-list" role="listbox">
          {shown.map((c, i) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === index}
                onMouseEnter={() => setIndex(i)} onClick={() => exec(c)}>
              <span>{c.label}</span><span className="grp">{c.group}</span>
            </li>
          ))}
          {!shown.length && <li className="muted">Aucune commande</li>}
        </ul>
        <div className="foot">↑ ↓ naviguer · Entrée exécuter · Échap fermer</div>
      </div>
    </div>
  );
}
