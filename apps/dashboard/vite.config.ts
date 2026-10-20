import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: { port: 5173 },
  build: {
    rolldownOptions: {
      output: {
        // The vendor split, so the three big third-party bundles are cached
        // separately from the app code. Before this, every dashboard change
        // invalidated one 1.1 MB bundle that also carried React, framer-motion
        // and the icon set; now only the small app chunk changes.
        //
        // The groups are by *package*, not by file, so a dependency that pulls
        // in another one stays whole. The order matters: the first group that
        // matches wins, so the specific packages come before the general one.
        advancedChunks: {
          groups: [
            { name: "icons", test: /node_modules[\\/]lucide-react[\\/]/ },
            { name: "motion", test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/ },
            { name: "ui", test: /node_modules[\\/]@heroui[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor", test: /node_modules[\\/]/ }
          ]
        }
      }
    }
  }
});
