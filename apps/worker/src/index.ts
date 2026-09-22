import { startWorker, type WorkerHandle } from './worker.js';

const worker: WorkerHandle = startWorker();

async function shutdown(): Promise<void> {
  await worker.close();
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

process.stdout.write(`worker started [${worker.dependencies.join(', ')}]\n`);
