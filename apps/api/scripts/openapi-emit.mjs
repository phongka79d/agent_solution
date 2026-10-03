import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../dist/server.js';
import { KnowledgeRepository } from '@agentos/database';
import { createOfflineApp } from './openapi-composition.mjs';

const app = createOfflineApp({ buildServer, KnowledgeRepository });
await app.ready();
const document = app.swagger();
const output = new URL('../../../packages/api-contract/openapi.json', import.meta.url);
await mkdir(dirname(fileURLToPath(output)), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
await app.close();
