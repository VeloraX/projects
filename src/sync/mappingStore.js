import { createInMemoryJsonPersistence } from './persistence.js';

const MAPPINGS_PERSISTENCE_KEY = 'mappings';
const DEFAULT_MAPPINGS_STATE = {
  itemsByProjectItemId: {}
};

export function createMappingStore({ persistence = createInMemoryJsonPersistence() } = {}) {

  return {
    async upsertFromGitHub(event) {
      if (!event.github.projectItemId) {
        return null;
      }

      let nextRecord = null;

      await persistence.update(MAPPINGS_PERSISTENCE_KEY, DEFAULT_MAPPINGS_STATE, (state) => {
        const existing = state.itemsByProjectItemId[event.github.projectItemId] ?? createEmptyMapping(event.github.projectItemId);
        nextRecord = {
          ...existing,
          githubProjectId: event.github.projectId ?? existing.githubProjectId,
          githubProjectItemId: event.github.projectItemId,
          githubContentId: event.github.contentId ?? existing.githubContentId,
          lastSnapshotHash: event.snapshotHash,
          lastSyncOrigin: 'github',
          lastSyncTimestamp: event.receivedAt,
          lastProcessedEventId: event.deliveryId
        };

        state.itemsByProjectItemId[event.github.projectItemId] = nextRecord;
        return state;
      });

      return nextRecord;
    },

    async upsertFromDiscord(update) {
      if (!update.githubProjectItemId) {
        return null;
      }

      let nextRecord = null;

      await persistence.update(MAPPINGS_PERSISTENCE_KEY, DEFAULT_MAPPINGS_STATE, (state) => {
        const existing = state.itemsByProjectItemId[update.githubProjectItemId] ?? createEmptyMapping(update.githubProjectItemId);
        nextRecord = {
          ...existing,
          ...update,
          githubProjectItemId: update.githubProjectItemId,
          lastSyncOrigin: 'discord'
        };

        state.itemsByProjectItemId[update.githubProjectItemId] = nextRecord;
        return state;
      });

      return nextRecord;
    },

    async list() {
      const state = await persistence.read(MAPPINGS_PERSISTENCE_KEY, DEFAULT_MAPPINGS_STATE);
      return Object.values(state.itemsByProjectItemId);
    },

    async size() {
      const state = await persistence.read(MAPPINGS_PERSISTENCE_KEY, DEFAULT_MAPPINGS_STATE);
      return Object.keys(state.itemsByProjectItemId).length;
    }
  };
}

function createEmptyMapping(githubProjectItemId) {
  return {
    githubProjectId: null,
    githubProjectItemId,
    githubContentId: null,
    discordGuildId: null,
    discordChannelId: null,
    discordMessageId: null,
    discordThreadId: null,
    lastSnapshotHash: null,
    lastSyncOrigin: null,
    lastSyncTimestamp: null,
    lastProcessedEventId: null,
    lastOutgoingMutationFingerprint: null
  };
}
