import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parseNetworkConfig } from "@qns/sdk";

function networkConfig(): Plugin {
  const path = resolve(
    import.meta.dirname,
    "..",
    process.env.QNS_CONFIG ?? "config/testnet-v3.example.json",
  );
  const read = () => {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return JSON.stringify(parseNetworkConfig(value), null, 2) + "\n";
  };
  return {
    name: "qns-network-config",
    buildStart() {
      this.addWatchFile(path);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "qns-config.json", source: read() });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/qns-config.json") {
          next();
          return;
        }
        try {
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(read());
        } catch {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "QNS configuration is unavailable" }));
        }
      });
    },
  };
}

export default defineConfig({ plugins: [react(), tailwindcss(), networkConfig()] });
