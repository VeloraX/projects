import fs from 'node:fs/promises';
import path from 'node:path';

import { cloneJsonValue } from './persistence.js';

export function createJsonFilePersistence({ filePath }) {
  if (!filePath) {
    throw new Error('A file path is required for file-backed tracker persistence.');
  }

  let loaded = false;
  let state = {};
  let queue = Promise.resolve();

  return {
    kind: 'file',
    filePath,

    async read(key, defaultValue) {
      const currentState = await loadState();
      return cloneJsonValue(Object.hasOwn(currentState, key) ? currentState[key] : defaultValue);
    },

    async update(key, defaultValue, updater) {
      queue = queue.catch(() => undefined).then(async () => {
        const currentState = cloneJsonValue(await loadState());
        const currentValue = cloneJsonValue(Object.hasOwn(currentState, key) ? currentState[key] : defaultValue);
        const nextValue = cloneJsonValue(await updater(currentValue));
        currentState[key] = nextValue;
        await writeState(currentState);
        return cloneJsonValue(nextValue);
      });

      return queue;
    }
  };

  async function loadState() {
    if (loaded) {
      return state;
    }

    try {
      const fileContents = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(fileContents);
      state = isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      state = {};
    }

    loaded = true;
    return state;
  }

  async function writeState(nextState) {
    state = nextState;
    loaded = true;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}