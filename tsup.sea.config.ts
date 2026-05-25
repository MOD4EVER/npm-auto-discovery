import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

const banner = '// SPDX-License-Identifier: AGPL-3.0-only\n// Copyright (C) 2026 MOD4EVER <git@mod4ever.de>';

// SEA build: all npm dependencies must be bundled into the single CJS output.
// Node.js built-ins (node:fs, node:http, etc.) remain external — esbuild handles them correctly.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  target: 'node24',
  sourcemap: false,
  clean: true,
  noExternal: [/./],
  banner: { js: banner },
  define: {
    __SERVICE_VERSION__: JSON.stringify(pkg.version),
  },
});
