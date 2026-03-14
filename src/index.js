import { readEnvironment } from './config/env.js';
import { createTrackerServer } from './server.js';

const environment = readEnvironment(process.env);
const server = createTrackerServer({ environment });

server.listen(environment.port, () => {
  console.log(`[tracker] listening on http://localhost:${environment.port}`);
});

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.close(() => {
      console.log('[tracker] shutdown complete');
      process.exit(0);
    });
  });
}
