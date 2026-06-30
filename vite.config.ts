import { defineConfig } from "vite";

// GitHub Pages serves project sites under /<repo>/, so production asset URLs
// need that prefix. Dev stays at / for a clean local URL.
// Honor a PORT assigned by the environment (e.g. the preview launcher); fall
// back to Vite's default otherwise.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/votv-save-editor/" : "/",
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
}));
