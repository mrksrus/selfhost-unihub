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
          { src: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
        categories: ["productivity", "utilities"],
        shortcuts: [
          {
            name: "Contacts",
            short_name: "Contacts",
            description: "View your contacts",
            url: "/contacts",
            icons: [{ src: "/icons/icon-512x512.svg", sizes: "any" }]
          },
          {
            name: "Calendar",
            short_name: "Calendar",
            description: "View your calendar",
            url: "/calendar",
            icons: [{ src: "/icons/icon-512x512.svg", sizes: "any" }]
          },
          {
            name: "Mail",
            short_name: "Mail",
            description: "View your mail",
            url: "/mail",
            icons: [{ src: "/icons/icon-512x512.svg", sizes: "any" }]
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
