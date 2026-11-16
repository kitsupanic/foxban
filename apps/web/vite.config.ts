import crypto from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiPort = Number(process.env.API_PORT ?? 8787);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error("API_PORT must be a valid TCP port");
const apiOrigin = `http://localhost:${apiPort}`;

const buildId = process.env.FOXBAN_BUILD_ID?.trim() || crypto.randomUUID();

function foxbanBuildIdPlugin(id: string): Plugin {
  const versionPayload = JSON.stringify({ buildId: id });
  return {
    name: "foxban-build-id",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "foxban-version.json",
        source: versionPayload,
      });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && (req.url === "/foxban-version.json" || req.url.startsWith("/foxban-version.json?"))) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(versionPayload);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  define: {
    __FOXBAN_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [foxbanBuildIdPlugin(buildId), react(), tailwindcss()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      "/boards": { target: apiOrigin, ws: true, changeOrigin: true },
      "/presence": { target: apiOrigin, ws: true, changeOrigin: true },
      "/auth": { target: apiOrigin, changeOrigin: true },
      "/me": { target: apiOrigin, changeOrigin: true },
      "^/mcp(?:/|$)": { target: apiOrigin, changeOrigin: true },
      "/users": { target: apiOrigin, changeOrigin: true },
      "/invites": { target: apiOrigin, changeOrigin: true },
      "/github-app": { target: apiOrigin, changeOrigin: true },
      "/workspaces": { target: apiOrigin, changeOrigin: true },
      "/access-changes": { target: apiOrigin, changeOrigin: true },
    },
  },
});

