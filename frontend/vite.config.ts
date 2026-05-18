import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  envDir: '../', 
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // --- START: ADD THIS PROXY CONFIGURATION ---
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:6328', // Your Flask backend address
        changeOrigin: true,
        secure: false,
      },
    },
    // --- END: ADD THIS PROXY CONFIGURATION ---
  },
  
  // This prevents the lightningcss error you were seeing!
  optimizeDeps: {
    exclude: ['lightningcss'],
  },
});
