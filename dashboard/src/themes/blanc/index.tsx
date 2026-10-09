// Thème « Blanc » — façon Apple, monochrome blanc / gris clair, toujours clair (ignore le mode sombre du système).
// Aucun fond décoratif : la sobriété fait le style. L'hologramme passe en rendu « clair » (cf. Hologram.tsx).
// Dossier autonome : le supprimer retire le thème (cf. ../registry.ts).
import type { ThemeModule } from "../registry";
import "./theme.css";

const theme: ThemeModule = { hologram: "light" };
export default theme;
