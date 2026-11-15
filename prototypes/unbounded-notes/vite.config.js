import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const project = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root,
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
    fs: {
      strict: true,
      allow: [root, path.join(project, 'client'), path.join(project, 'node_modules')],
      deny: ['**/.git/**', '**/.dsh/**', '**/workspace/**', '**/.env*', '**/.npmrc', '**/*.{crt,pem}'],
    },
    cors: false,
  },
  preview: { host: '127.0.0.1', port: 4178, strictPort: true },
  build: {
    outDir: path.join(project, 'dist/notes-preview'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1100,
  },
});
