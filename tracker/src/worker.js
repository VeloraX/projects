import { createTrackerHandler } from './app.js';
import { readEnvironment } from './config/env.js';
import { createAuditLog } from './sync/auditLog.js';
import { createMappingStore } from './sync/mappingStore.js';
import { createKvJsonPersistence, isKvNamespace } from './sync/persistence.js';
import { createSettingsStore } from './sync/settingsStore.js';

const MAX_BODY_SIZE_BYTES = 1024 * 1024;
const inMemoryAuditLog = createAuditLog();
const inMemoryMappingStore = createMappingStore();
const inMemorySettingsStore = createSettingsStore();

export default {
  async fetch(request, env) {
    const bodyBuffer = await readRequestBody(request);
    const environment = readEnvironment(env);
    const trackerStores = createWorkerTrackerStores({ environment, env });
    const handler = createTrackerHandler({
      environment,
      mappingStore: trackerStores.mappingStore,
      auditLog: trackerStores.auditLog,
      settingsStore: trackerStores.settingsStore,
      clock: () => new Date().toISOString()
    });
    const result = await handler({
      method: request.method,
      url: request.url,
      headers: request.headers,
      bodyBuffer
    });

    return new Response(JSON.stringify(result.payload, null, 2), {
      status: result.statusCode,
      headers: {
        ...(result.headers ?? {}),
        'content-type': 'application/json; charset=utf-8'
      }
    });
  }
};

function createWorkerTrackerStores({ environment, env }) {
  const storageMode = environment.storage.mode;

  if (storageMode === 'memory') {
    return {
      mappingStore: inMemoryMappingStore,
      auditLog: inMemoryAuditLog,
      settingsStore: inMemorySettingsStore
    };
  }

  const kvNamespace = env.TRACKER_STATE_KV;

  if (isKvNamespace(kvNamespace)) {
    const persistence = createKvJsonPersistence({ namespace: kvNamespace });
    return {
      mappingStore: createMappingStore({ persistence }),
      auditLog: createAuditLog({ persistence }),
      settingsStore: createSettingsStore({ persistence })
    };
  }

  if (storageMode === 'kv') {
    throw new Error('TRACKER_STORAGE_MODE=kv requires a TRACKER_STATE_KV binding in the Worker environment.');
  }

  return {
    mappingStore: inMemoryMappingStore,
    auditLog: inMemoryAuditLog,
    settingsStore: inMemorySettingsStore
  };
}

async function readRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Uint8Array();
  }

  const buffer = new Uint8Array(await request.arrayBuffer());

  if (buffer.byteLength > MAX_BODY_SIZE_BYTES) {
    const error = new Error('Request body exceeded the 1 MB scaffold limit.');
    error.statusCode = 413;
    throw error;
  }

  return buffer;
}