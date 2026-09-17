import { loadConfig } from './config.js';
import { createBridge } from './server.js';
import path from 'node:path';
import { State } from './state.js';
import { createManagement } from './management.js';

try {
  const config = loadConfig();
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  const state = await State.open(config, dataDir);
  const pruneTimer = setInterval(() => state.prune(), 60000);
  pruneTimer.unref();
  const server = createBridge(config, { state, management: createManagement(state) });
  server.on('error', error => {
    console.error(`Cannot start bridge: ${error.code || 'server_error'}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      event: 'listening', host: config.host, port: server.address().port,
      control_model: config.controlModel, max_concurrent: config.maxConcurrent,
      auth: 'client-key-passthrough',
      admin: '/admin/', management_token_file: process.env.MANAGEMENT_KEY ? null : path.join(dataDir, 'admin-token.txt'),
    }));
  });
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(pruneTimer);
    server.abortPending();
    server.close(async () => { await state.updated; });
    setTimeout(() => server.closeAllConnections(), 2500).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exitCode = 1;
}
