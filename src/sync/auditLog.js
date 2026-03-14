import { createInMemoryJsonPersistence } from './persistence.js';

const DEFAULT_LIMIT = 250;
const AUDIT_PERSISTENCE_KEY = 'audit-log';
const DEFAULT_AUDIT_STATE = {
  entries: [],
  nextId: 1
};

export function createAuditLog(options = {}) {
  const normalizedOptions = typeof options === 'number' ? { limit: options } : options;
  const {
    limit = DEFAULT_LIMIT,
    persistence = createInMemoryJsonPersistence()
  } = normalizedOptions;

  return {
    async record(entry) {
      let storedEntry = null;

      await persistence.update(AUDIT_PERSISTENCE_KEY, DEFAULT_AUDIT_STATE, (state) => {
        storedEntry = {
          id: state.nextId,
          ...entry
        };

        state.nextId += 1;
        state.entries.push(storedEntry);

        if (state.entries.length > limit) {
          state.entries.splice(0, state.entries.length - limit);
        }

        return state;
      });

      return storedEntry;
    },

    async list(maxEntries = 50) {
      const state = await persistence.read(AUDIT_PERSISTENCE_KEY, DEFAULT_AUDIT_STATE);
      return state.entries.slice(-maxEntries).reverse();
    },

    async size() {
      const state = await persistence.read(AUDIT_PERSISTENCE_KEY, DEFAULT_AUDIT_STATE);
      return state.entries.length;
    }
  };
}
