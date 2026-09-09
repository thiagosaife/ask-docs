import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue({ customElement: true })],
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  server: { open: '/demo/index.html', port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2020',
    minify: 'terser',
    terserOptions: { compress: { passes: 3, pure_getters: true, unsafe: true }, mangle: true, format: { comments: false } },
    sourcemap: false,
    lib: {
      entry: 'src/index.ts',
      name: 'AskDocs',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'ask-docs.js' : 'ask-docs.iife.js'),
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
