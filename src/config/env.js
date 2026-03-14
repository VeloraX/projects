const DEFAULT_PORT = 8787;

export function readEnvironment(source = process.env) {
  return {
    port: readPort(source.PORT),
    storage: {
      mode: readStorageMode(source.TRACKER_STORAGE_MODE),
      path: readOptionalString(source.TRACKER_STORAGE_PATH)
    },
    github: {
      webhookSecret: readOptionalString(source.GITHUB_WEBHOOK_SECRET),
      token: readOptionalString(source.GITHUB_TOKEN),
      org: readOptionalString(source.GITHUB_ORG) ?? 'VeloraX',
      projectNumber: readOptionalInteger(source.GITHUB_PROJECT_NUMBER)
    },
    discord: {
      publicKey: readOptionalString(source.DISCORD_PUBLIC_KEY),
      applicationId: readOptionalString(source.DISCORD_APPLICATION_ID),
      botToken: readOptionalString(source.DISCORD_BOT_TOKEN),
      guildId: readOptionalString(source.DISCORD_GUILD_ID),
      operatorRoleIds: readOptionalList(source.DISCORD_OPERATOR_ROLE_IDS)
    }
  };
}

function readPort(value) {
  const parsed = readOptionalInteger(value);

  if (parsed === null || parsed < 1 || parsed > 65535) {
    return DEFAULT_PORT;
  }

  return parsed;
}

function readOptionalInteger(value) {
  const normalized = readOptionalString(value);

  if (normalized === null) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readOptionalString(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function readStorageMode(value) {
  const normalized = readOptionalString(value)?.toLowerCase();

  switch (normalized) {
    case 'auto':
    case 'memory':
    case 'file':
    case 'kv':
      return normalized;
    default:
      return 'auto';
  }
}

function readOptionalList(value) {
  const normalized = readOptionalString(value);

  if (normalized === null) {
    return [];
  }

  return normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
