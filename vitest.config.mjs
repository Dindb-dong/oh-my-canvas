import { defineConfig } from 'vitest/config';
import {alias} from './vite.config.mjs';
export default defineConfig({resolve:{alias},test: { environment: 'node', include: ['editor/__tests__/**/*.test.ts'] } });
