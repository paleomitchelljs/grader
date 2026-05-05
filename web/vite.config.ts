import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

const gitSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
})();
const buildTime = new Date().toISOString();

export default defineConfig({
  base: '/grader/',
  define: {
    __GRADER_VERSION__: JSON.stringify(`${gitSha} ${buildTime}`),
  },
  build: {
    outDir: '../docs',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          opencv: ['@techstark/opencv-js'],
          pdfjs: ['pdfjs-dist'],
          pdflib: ['pdf-lib'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@techstark/opencv-js'],
  },
});
