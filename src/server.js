import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createTrackerHandler } from './app.js';
import { createAuditLog } from './sync/auditLog.js';
import { createJsonFilePersistence } from './sync/filePersistence.js';
import { createMappingStore } from './sync/mappingStore.js';
import { createSettingsStore } from './sync/settingsStore.js';

const MAX_BODY_SIZE_BYTES = 1024 * 1024;
const DEFAULT_STORAGE_PATH = fileURLToPath(new URL('../.data/tracker-state.json', import.meta.url));

export function createTrackerServer({
  environment,
  mappingStore,
  auditLog,
  settingsStore,
  clock = () => new Date().toISOString()
}) {
  const trackerStores = createServerTrackerStores({ environment, mappingStore, auditLog, settingsStore });
  const handler = createTrackerHandler({
    environment,
    mappingStore: trackerStores.mappingStore,
    auditLog: trackerStores.auditLog,
    settingsStore: trackerStores.settingsStore,
    clock
  });

  return http.createServer(async (request, response) => {
    try {
      const host = readNodeHeaderValue(request.headers.host) ?? 'localhost';
      const bodyBuffer = await readRequestBody(request);
      const result = await handler({
        method: request.method ?? 'GET',
        url: new URL(request.url ?? '/', `http://${host}`).toString(),
        headers: request.headers,
        bodyBuffer
      });

      sendJson(response, result.statusCode, result.payload, result.headers);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, {
        error: 'server_error',
        message: error.message
      });
    }
  });
}

function createServerTrackerStores({ environment, mappingStore, auditLog, settingsStore }) {
  if (mappingStore && auditLog && settingsStore) {
    return {
      mappingStore,
      auditLog,
      settingsStore
    };
  }

  if (environment.storage.mode === 'memory') {
    return {
      mappingStore: mappingStore ?? createMappingStore(),
      auditLog: auditLog ?? createAuditLog(),
      settingsStore: settingsStore ?? createSettingsStore()
    };
  }

  if (environment.storage.mode === 'kv') {
    throw new Error('TRACKER_STORAGE_MODE=kv is only supported by the Cloudflare Worker runtime.');
  }

  const persistence = createJsonFilePersistence({
    filePath: environment.storage.path ?? DEFAULT_STORAGE_PATH
  });

  return {
    mappingStore: mappingStore ?? createMappingStore({ persistence }),
    auditLog: auditLog ?? createAuditLog({ persistence }),
    settingsStore: settingsStore ?? createSettingsStore({ persistence })
  };
}

function readNodeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return typeof value === 'string' ? value : null;
}

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_BODY_SIZE_BYTES) {
      const error = new Error('Request body exceeded the 1 MB scaffold limit.');
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);

  response.writeHead(statusCode, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });

  response.end(body);
}
