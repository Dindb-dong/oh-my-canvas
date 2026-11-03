import { defineConfig } from 'vite';
import {fileURLToPath} from 'node:url';
// lucide 0.563 ships its ESM entry one level below the declared module field.
export const alias={lucide:fileURLToPath(new URL('./node_modules/lucide/dist/esm/lucide/src/lucide.js',import.meta.url))};
export default defineConfig({ base: './', resolve:{alias}, build: { target: 'es2022' }, server: { host: '127.0.0.1', port: 5179, strictPort: true } });
