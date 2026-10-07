// Applique le thème choisi : attribut data-ui-theme sur <html> (les styles du thème y sont rattachés),
// fond décoratif éventuel derrière l'interface, effets d'activation. Ne touche à aucun composant.
import { useEffect, useState } from "react";
import { DEFAULT_THEME, hasTheme, loadTheme, type ThemeModule } from "./registry";

const STORAGE_KEY = "sentinel.uiTheme";

export function readStoredTheme(): string {
  try {
    const id = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME.id;
    return hasTheme(id) ? id : DEFAULT_THEME.id;     // thème supprimé depuis : retour au thème d'origine
  } catch { return DEFAULT_THEME.id; }
}

export function storeTheme(id: string) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* stockage indisponible */ }
}

export default function ThemeHost({ id }: { id: string }) {
  const [mod, setMod] = useState<ThemeModule | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    setMod(null);
    if (id === DEFAULT_THEME.id || !hasTheme(id)) { delete root.dataset.uiTheme; return; }
    root.dataset.uiTheme = id;
    let alive = true;
    let cleanup: (() => void) | void;
    loadTheme(id)?.then((m) => {
      if (!alive) return;
      setMod(m);
      cleanup = m.activate?.();
    });
    return () => { alive = false; cleanup?.(); };
  }, [id]);

  const Background = mod?.Background;
  return Background ? <div className="theme-bg" aria-hidden><Background /></div> : null;
}
