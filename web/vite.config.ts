import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const backend = process.env.ICPC_BACKEND_URL || "http://localhost:3001";

// In development the page is served by Vite and talks to the backend through
// this proxy, so the browser sees one origin exactly as it does in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: backend, ws: true },
      "/rooms": backend,
      "/health": backend,
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
