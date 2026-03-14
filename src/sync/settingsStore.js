import { createInMemoryJsonPersistence } from './persistence.js';

const SETTINGS_PERSISTENCE_KEY = 'project-settings';
const DEFAULT_SETTINGS_STATE = {
  guildsById: {}
};

export function createSettingsStore({ persistence = createInMemoryJsonPersistence() } = {}) {
  return {
    async getGuildSettings({ guildId, fallbackProject }) {
      const state = await persistence.read(SETTINGS_PERSISTENCE_KEY, DEFAULT_SETTINGS_STATE);
      return buildResolvedGuildSettings({
        guildState: guildId ? state.guildsById[guildId] ?? null : null,
        fallbackProject
      });
    },

    async resolveProject({ guildId, projectKey, fallbackProject }) {
      const settings = await this.getGuildSettings({ guildId, fallbackProject });

      if (!projectKey) {
        return settings.activeProject;
      }

      const normalizedProjectKey = normalizeProjectKey(projectKey);
      const selectedProject = settings.projects.find((project) => project.key === normalizedProjectKey) ?? null;

      if (!selectedProject) {
        const error = new Error(`Tracker project "${projectKey}" is not configured for this Discord guild.`);
        error.statusCode = 404;
        throw error;
      }

      return selectedProject;
    },

    async saveGuildProject({ guildId, projectKey, label, org, projectNumber, makeActive = false }) {
      if (!guildId) {
        const error = new Error('Tracker project settings can only be changed from a Discord guild.');
        error.statusCode = 400;
        throw error;
      }

      const normalizedProjectKey = normalizeProjectKey(projectKey);
      const normalizedOrg = normalizeRequiredString(org, 'A GitHub organization login is required.');
      const normalizedProjectNumber = normalizeProjectNumber(projectNumber);
      const normalizedLabel = normalizeOptionalString(label) ?? `${normalizedOrg} #${normalizedProjectNumber}`;
      let savedProject = null;

      await persistence.update(SETTINGS_PERSISTENCE_KEY, DEFAULT_SETTINGS_STATE, (state) => {
        const guildState = state.guildsById[guildId] ?? createEmptyGuildState();

        savedProject = {
          key: normalizedProjectKey,
          label: normalizedLabel,
          org: normalizedOrg,
          projectNumber: normalizedProjectNumber
        };

        guildState.projectsByKey[normalizedProjectKey] = savedProject;

        if (makeActive || !guildState.activeProjectKey) {
          guildState.activeProjectKey = normalizedProjectKey;
        }

        state.guildsById[guildId] = guildState;
        return state;
      });

      return savedProject;
    },

    async setActiveGuildProject({ guildId, projectKey, fallbackProject }) {
      if (!guildId) {
        const error = new Error('Tracker project settings can only be changed from a Discord guild.');
        error.statusCode = 400;
        throw error;
      }

      const normalizedProjectKey = normalizeProjectKey(projectKey);
      const settings = await this.getGuildSettings({ guildId, fallbackProject });

      if (!settings.projects.some((project) => project.key === normalizedProjectKey)) {
        const error = new Error(`Tracker project "${projectKey}" is not configured for this Discord guild.`);
        error.statusCode = 404;
        throw error;
      }

      await persistence.update(SETTINGS_PERSISTENCE_KEY, DEFAULT_SETTINGS_STATE, (state) => {
        const guildState = state.guildsById[guildId] ?? createEmptyGuildState();
        guildState.activeProjectKey = normalizedProjectKey;
        state.guildsById[guildId] = guildState;
        return state;
      });

      return settings.projects.find((project) => project.key === normalizedProjectKey) ?? null;
    }
  };
}

function buildResolvedGuildSettings({ guildState, fallbackProject }) {
  const storedProjects = Object.values(guildState?.projectsByKey ?? {});
  const projects = storedProjects.length > 0 ? storedProjects.sort(compareProjects) : [fallbackProject];
  const activeProjectKey = guildState?.activeProjectKey ?? fallbackProject.key;
  const activeProject = projects.find((project) => project.key === activeProjectKey) ?? projects[0] ?? fallbackProject;

  return {
    activeProjectKey: activeProject?.key ?? fallbackProject.key,
    activeProject,
    projects
  };
}

function createEmptyGuildState() {
  return {
    activeProjectKey: null,
    projectsByKey: {}
  };
}

function compareProjects(left, right) {
  return left.label.localeCompare(right.label);
}

function normalizeProjectKey(value) {
  const normalized = normalizeRequiredString(value, 'A short tracker project key is required.')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    const error = new Error('Tracker project keys must include at least one letter or number.');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeProjectNumber(value) {
  const normalized = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(normalized) || normalized < 1) {
    const error = new Error('A valid GitHub Project number is required.');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeRequiredString(value, message) {
  const normalized = normalizeOptionalString(value);

  if (!normalized) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}