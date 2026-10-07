import { copyFile } from 'node:fs/promises';

await copyFile(new URL('../src/schema.d.ts', import.meta.url), new URL('../dist/schema.d.ts', import.meta.url));
