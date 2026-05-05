import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

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
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "favicon.svg", "robots.txt"],
      workbox: {
        navigateFallbackDenylist: [
          /^\/api\//,
        ],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              (url.pathname.startsWith('/api/mail/emails') || url.pathname.startsWith('/api/mail/attachments')),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'local-api-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60,
              },
            },
          },
          {
            urlPattern: /^https:\/\/api\./,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60,
              },
            },
          },
        ],
        // Inject custom service worker code
        importScripts: ['/sw-custom.js'],
      },
      manifest: {
        name: "UniHub",
        short_name: "UniHub",
        description: "Your unified productivity suite for Contacts, Calendar, and Mail",
        start_url: "/",
        display: "standalone",
        background_color: "#f5f7fa",
        theme_color: "#1a2332",
        orientation: "portrait-primary",
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
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
