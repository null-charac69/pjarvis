import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const browserApiOrigin = process.env.JARVIS_BROWSER_API_ORIGIN ?? "http://127.0.0.1:8765";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: `${appRoot}/electron/main.ts` },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: `${appRoot}/electron/preload.ts` },
    },
  },
  renderer: {
    root: `${appRoot}/src`,
    resolve: {
      alias: { "@": `${appRoot}/src` },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: `${appRoot}/src/index.html` },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: browserApiOrigin,
          changeOrigin: true,
        },
        "/ws": {
          target: browserApiOrigin,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  },
});