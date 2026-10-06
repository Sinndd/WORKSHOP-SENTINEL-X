import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Servi par l'API FastAPI sur /dashboard/ (build copié dans l'image de l'API).
// En développement : `API_URL=http://<ip-du-pi>:8000 npm run dev` -> les appels /api sont relayés.
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  server: {
    proxy: { "/api": { target: process.env.API_URL ?? "http://127.0.0.1:8000", changeOrigin: true } },
  },
  // Le bloc de l'hologramme (Three.js complet, ~260 Ko gzip) est chargé à la demande, jamais au démarrage.
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1100 },
});
