import { defineConfig } from 'vite';

export default defineConfig({
  base: '/grader/',
  build: {
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
