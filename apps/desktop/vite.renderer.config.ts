import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const browserApiOrigin = process.env.JARVIS_BROWSER_API_ORIGIN ?? "http://127.0.0.1:8765";

export default defineConfig({
  root: `${appRoot}/src`,
  resolve: { alias: { "@": `${appRoot}/src` } },
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: browserApiOrigin, changeOrigin: true },
      "/ws": {
        target: browserApiOrigin,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
