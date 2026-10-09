// Registre des thèmes visuels. Chaque thème est un dossier autonome de src/themes/ :
//   meta.ts     -> { id, label, description }        (chargé tout de suite, pour le sélecteur)
//   index.tsx   -> { Background?, activate?, hologram? }        (chargé à la demande, avec son theme.css)
// Supprimer un dossier suffit à retirer le thème : il est découvert automatiquement, rien d'autre à modifier.
import type { ComponentType } from "react";

export interface ThemeMeta { id: string; label: string; description: string; }
export interface ThemeModule {
  /** Fond décoratif rendu derrière toute l'interface (non interactif). */
  Background?: ComponentType;
  /** Effets globaux à l'activation ; renvoie la fonction de nettoyage. */
  activate?: () => (() => void) | void;
  /** « light » : l'hologramme est dessiné pour un fond clair (mélange normal au lieu de lumière additive). */
  hologram?: "light";
}

export const DEFAULT_THEME: ThemeMeta = { id: "default", label: "Standard", description: "Épuré, clair ou sombre selon le système" };

const metas = import.meta.glob<{ default: ThemeMeta }>("./*/meta.ts", { eager: true });
const loaders = import.meta.glob<{ default: ThemeModule }>("./*/index.tsx");

export const THEMES: ThemeMeta[] = [DEFAULT_THEME, ...Object.values(metas).map((m) => m.default)];

export function hasTheme(id: string): boolean {
  return id === DEFAULT_THEME.id || `./${id}/index.tsx` in loaders;
}

export function loadTheme(id: string): Promise<ThemeModule> | null {
  const load = loaders[`./${id}/index.tsx`];
  return load ? load().then((m) => m.default) : null;
}
