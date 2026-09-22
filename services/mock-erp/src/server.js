import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 8081;

const HEALTH_BODY = JSON.stringify({ status: 'ok', service: 'mock-erp' });
const NOT_FOUND_BODY = JSON.stringify({ status: 'not_found' });

/**
 * Liveness endpoint for the local/CI Compose topology. The simulator exposes no
 * ERP API: every route other than `GET /health` answers 404.
 */
export function createMockErpServer() {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(HEALTH_BODY);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(NOT_FOUND_BODY);
  });
}

const executedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedAsMain) {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const server = createMockErpServer();

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`mock-erp listening on ${port}\n`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}
