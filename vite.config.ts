import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import fs from "node:fs";

const alias = { "@": path.resolve(__dirname, "./src") };
const RECORDING_UPLOADS_WORKER = "recording-uploads-sw.js";

// The service worker loads this with importScripts, so it must be one classic
// script. It shares the upload code with the page (src/lib/recording-*.ts).
function recordingUploadsWorker(): Plugin {
  return {
    name: "unihub-recording-uploads-worker",
    apply: "build",
    async generateBundle() {
      const result = await build({
        configFile: false,
        logLevel: "warn",
        resolve: { alias },
        build: {
          write: false,
          minify: true,
          lib: {
            entry: path.resolve(__dirname, "src/sw/recording-uploads.ts"),
            formats: ["iife"],
            name: "UniHubRecordingUploads",
            fileName: () => RECORDING_UPLOADS_WORKER,
          },
        },
      });
      const outputs = (Array.isArray(result) ? result : [result]) as Array<{ output: Array<{ type: string; code?: string }> }>;
      const chunk = outputs[0]?.output.find(item => item.type === "chunk");
      if (!chunk?.code) throw new Error("Recording upload worker did not build");
      this.emitFile({ type: "asset", fileName: RECORDING_UPLOADS_WORKER, source: chunk.code });
    },
  };
}

// Keep classic worker URLs stable while authoring their source in TypeScript.
function classicWorkers(): Plugin {
  const files = ["sw-custom.js", "audio-recorder-worklet.js"];
  return {
    name: "unihub-classic-workers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0]?.slice(1);
        if (!name || !files.includes(name)) return next();
        fs.readFile(path.resolve(__dirname, ".worker-dist", name), (error, source) => {
          if (error) return next(error);
          res.setHeader("Content-Type", "application/javascript");
          res.end(source);
        });
      });
    },
    generateBundle() {
      for (const fileName of files) this.emitFile({
        type: "asset", fileName,
        source: fs.readFileSync(path.resolve(__dirname, ".worker-dist", fileName)),
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    recordingUploadsWorker(),
    classicWorkers(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.ico", "favicon.svg", "robots.txt"],
      workbox: {
        navigateFallbackDenylist: [
          /^\/api\//,
        ],
        // /api/events (Server-Sent Events) and file downloads (backups,
        // recordings, attachments) are left out on purpose: no service-worker
        // route answers them, so the browser streams them straight from the
        // network and a worker stop cannot cut the stream. Browsers can also
        // resume such downloads. The pattern is copied into the worker, so it
        // must not use outside names.
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith('/api/') && url.pathname !== '/api/events'
            && !/^\/api\/(backup\/jobs\/[^/]+\/download|recordings\/[^/]+\/file|mail\/attachments\/[^/]+)$/.test(url.pathname),
          handler: 'NetworkOnly',
        }],
        // Inject custom service worker code. Recording uploads come first so
        // their sync handler is registered before the catch-all in sw-custom.js.
        importScripts: [`/${RECORDING_UPLOADS_WORKER}`, '/sw-custom.js'],
      },
      manifest: {
        name: "UniHub",
        short_name: "UniHub",
        description: "Your unified productivity suite for Contacts, Calendar, and Mail",
        start_url: "/",
        display: "standalone",
        background_color: "#000000",
        theme_color: "#000000",
        orientation: "any",
        icons: [
          { src: "/icons/icon-512x512.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icons/icon-72x72.png", sizes: "72x72", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-96x96.png", sizes: "96x96", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-128x128.png", sizes: "128x128", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-144x144.png", sizes: "144x144", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-152x152.png", sizes: "152x152", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-180x180.png", sizes: "180x180", type: "image/png", purpose: "any" },
          { src: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-384x384.png", sizes: "384x384", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
        categories: ["productivity", "utilities"],
        shortcuts: [
          {
            name: "Contacts",
            short_name: "Contacts",
            description: "View your contacts",
            url: "/contacts",
            icons: [{ src: "/icons/icon-96x96.png", sizes: "96x96", type: "image/png" }]
          },
          {
            name: "Calendar",
            short_name: "Calendar",
            description: "View your calendar",
            url: "/calendar",
            icons: [{ src: "/icons/icon-96x96.png", sizes: "96x96", type: "image/png" }]
          },
          {
            name: "Mail",
            short_name: "Mail",
            description: "View your mail",
            url: "/mail",
            icons: [{ src: "/icons/icon-96x96.png", sizes: "96x96", type: "image/png" }]
          }
        ]
      }
    }),
  ],
  resolve: {
    alias,
  },
}));
