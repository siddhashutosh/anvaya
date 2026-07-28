#!/usr/bin/env node
/* eslint-disable no-console */

/** Remove build output and the local database. Leaves node_modules alone. */

import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'packages/core/dist',
  'packages/sdk/dist',
  'packages/server/dist',
  'packages/ui/dist',
  'data',
];

for (const target of targets) {
  const path = resolve(root, target);
  rmSync(path, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
