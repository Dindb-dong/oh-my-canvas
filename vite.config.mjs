import { defineConfig } from 'vite';
export const alias={};
export default defineConfig({ base: './', build: { target: 'es2022' }, server: { host: '127.0.0.1', port: 5179, strictPort: true } });
