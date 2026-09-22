import { pathToFileURL } from 'node:url';

import { startServer } from './server.js';

const executedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedAsMain) {
  await startServer();
}
