import { randomBytes } from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export function createInteractionSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, clock = () => Date.now() } = {}) {
  const sessions = new Map();

  return {
    create(session) {
      pruneExpiredSessions(sessions, clock);

      const token = randomBytes(8).toString('hex');
      sessions.set(token, {
        ...session,
        expiresAt: clock() + ttlMs
      });
      return token;
    },

    read(token) {
      if (typeof token !== 'string' || token.length === 0) {
        return null;
      }

      const entry = sessions.get(token) ?? null;

      if (!entry) {
        return null;
      }

      if (entry.expiresAt <= clock()) {
        sessions.delete(token);
        return null;
      }

      return entry;
    },

    update(token, updates) {
      const current = this.read(token);

      if (!current) {
        return null;
      }

      const next = {
        ...current,
        ...updates,
        expiresAt: clock() + ttlMs
      };

      sessions.set(token, next);
      return next;
    },

    delete(token) {
      sessions.delete(token);
    }
  };
}

function pruneExpiredSessions(sessions, clock) {
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= clock()) {
      sessions.delete(token);
    }
  }
}