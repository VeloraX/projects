const DEFAULT_KEY_PREFIX = 'tracker:';

export function createInMemoryJsonPersistence() {
  const state = new Map();
  let queue = Promise.resolve();

  return {
    kind: 'memory',

    async read(key, defaultValue) {
      return cloneJsonValue(state.has(key) ? state.get(key) : defaultValue);
    },

    async update(key, defaultValue, updater) {
      queue = queue.catch(() => undefined).then(async () => {
        const currentValue = cloneJsonValue(state.has(key) ? state.get(key) : defaultValue);
        const nextValue = cloneJsonValue(await updater(currentValue));
        state.set(key, nextValue);
        return cloneJsonValue(nextValue);
      });

      return queue;
    }
  };
}

export function createKvJsonPersistence({ namespace, keyPrefix = DEFAULT_KEY_PREFIX }) {
  if (!isKvNamespace(namespace)) {
    throw new Error('A Cloudflare KV namespace binding is required for KV-backed tracker persistence.');
  }

  let queue = Promise.resolve();

  return {
    kind: 'kv',

    async read(key, defaultValue) {
      const storedValue = await namespace.get(`${keyPrefix}${key}`, 'json');
      return cloneJsonValue(storedValue ?? defaultValue);
    },

    async update(key, defaultValue, updater) {
      queue = queue.catch(() => undefined).then(async () => {
        const storageKey = `${keyPrefix}${key}`;
        const currentValue = cloneJsonValue((await namespace.get(storageKey, 'json')) ?? defaultValue);
        const nextValue = cloneJsonValue(await updater(currentValue));
        await namespace.put(storageKey, JSON.stringify(nextValue));
        return cloneJsonValue(nextValue);
      });

      return queue;
    }
  };
}

export function isKvNamespace(value) {
  return Boolean(value && typeof value.get === 'function' && typeof value.put === 'function');
}

export function cloneJsonValue(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}