import {
  LEGACY_TRACKED_PROJECT_VIEW_COMMAND,
  PROJECTS_COMMAND,
  TRACKER_COMMAND,
  trackerCommandRegistry
} from './discord/commandRegistry.js';
import { verifyDiscordSignature } from './discord/verifySignature.js';
import { normalizeGitHubWebhook } from './github/normalizeWebhook.js';
import {
  createProjectDraftItem,
  deleteProjectItem,
  fetchGitHubProjectEditorData,
  updateProjectDraftItem,
  updateProjectItemFields
} from './github/projectMutations.js';
import { fetchGitHubProjectView } from './github/projectView.js';
import { verifyGitHubSignature } from './github/verifySignature.js';
import { createAuditLog } from './sync/auditLog.js';
import { createMappingStore } from './sync/mappingStore.js';
import { createSettingsStore } from './sync/settingsStore.js';

const textDecoder = new TextDecoder();

const DISCORD_EPHEMERAL_FLAG = 64;
const DISCORD_COMPONENT_TYPE_BUTTON = 2;
const DISCORD_COMPONENT_TYPE_STRING_SELECT = 3;
const DISCORD_COMPONENT_TYPE_TEXT_INPUT = 4;
const DISCORD_MESSAGE_UPDATE_TYPE = 7;
const DISCORD_MODAL_RESPONSE_TYPE = 9;
const DISCORD_TEXT_STYLE_SHORT = 1;
const DISCORD_TEXT_STYLE_PARAGRAPH = 2;
const TRACKER_REFRESH_COMPONENT_ID = 'tpv.refresh.v1';
const TRACKER_STATUS_COMPONENT_ID = 'tpv.status.v1';
const TRACKER_MANAGE_COMPONENT_ID = 'tpv.manage.v1';
const TRACKER_MANAGER_REFRESH_COMPONENT_ID = 'tpv.manager.refresh.v1';
const TRACKER_MANAGER_ITEM_COMPONENT_ID = 'tpv.manager.item.v1';
const TRACKER_MANAGER_STATUS_COMPONENT_ID = 'tpv.manager.status.v1';
const TRACKER_MANAGER_PRIORITY_COMPONENT_ID = 'tpv.manager.priority.v1';
const TRACKER_MANAGER_CREATE_COMPONENT_ID = 'tpv.manager.create.v1';
const TRACKER_MANAGER_EDIT_COMPONENT_ID = 'tpv.manager.edit.v1';
const TRACKER_MANAGER_DELETE_COMPONENT_ID = 'tpv.manager.delete.v1';
const TRACKER_MANAGER_DELETE_CONFIRM_COMPONENT_ID = 'tpv.manager.delete.confirm.v1';
const TRACKER_MANAGER_DELETE_CANCEL_COMPONENT_ID = 'tpv.manager.delete.cancel.v1';
const TRACKER_MANAGER_CREATE_MODAL_ID = 'tpv.manager.modal.create.v1';
const TRACKER_MANAGER_EDIT_MODAL_ID = 'tpv.manager.modal.edit.v1';
const TRACKER_CLEAR_PRIORITY_VALUE = '__clear__';
const TRUSTED_DISCORD_PERMISSION_BITS = [8n, 16n, 32n, 8192n, 1099511627776n];
const STATUS_EMBED_COLORS = Object.freeze({
  all: 0x2563eb,
  todo: 0xf59e0b,
  in_progress: 0xea580c,
  done: 0x16a34a
});
const LANE_EMBED_COLORS = Object.freeze({
  todo: 0xf59e0b,
  in_progress: 0xea580c,
  done: 0x16a34a
});
const SETTINGS_EMBED_COLOR = 0x0f766e;
const PUBLIC_JSON_ROUTES = new Set(['/health', '/discord/commands', '/github/project', '/mappings', '/audit']);

export function createTrackerHandler({
  environment,
  mappingStore = createMappingStore(),
  auditLog = createAuditLog(),
  settingsStore = createSettingsStore(),
  clock = () => new Date().toISOString()
}) {
  return async function handleTrackerRequest({ method = 'GET', url = 'http://localhost/', headers = {}, bodyBuffer = new Uint8Array() }) {
    try {
      const requestUrl = new URL(url, 'http://localhost');

      if (method === 'OPTIONS' && PUBLIC_JSON_ROUTES.has(requestUrl.pathname)) {
        return createJsonResult(204, null, createPublicCorsHeaders());
      }

      if (method === 'GET' && requestUrl.pathname === '/health') {
        const [mappingCount, auditEntryCount] = await Promise.all([
          mappingStore.size(),
          auditLog.size()
        ]);

        return createPublicJsonResult(200, {
          status: 'ok',
          service: 'veloracss-tracker',
          now: clock(),
          commands: trackerCommandRegistry.map((command) => command.name),
          config: {
            githubWebhookSecret: Boolean(environment.github.webhookSecret),
            githubToken: Boolean(environment.github.token),
            githubOrg: environment.github.org,
            githubProjectNumber: environment.github.projectNumber,
            githubProjectReadReady: Boolean(environment.github.token && Number.isInteger(environment.github.projectNumber)),
            discordPublicKey: Boolean(environment.discord.publicKey),
            discordApplicationId: Boolean(environment.discord.applicationId),
            discordBotToken: Boolean(environment.discord.botToken),
            discordGuildId: Boolean(environment.discord.guildId),
            discordOperatorRoleIds: environment.discord.operatorRoleIds.length,
            storageMode: environment.storage.mode,
            storagePath: environment.storage.path
          },
          state: {
            mappingCount,
            auditEntryCount
          }
        });
      }

      if (method === 'GET' && requestUrl.pathname === '/discord/commands') {
        return createPublicJsonResult(200, {
          commands: trackerCommandRegistry
        });
      }

      if (method === 'GET' && requestUrl.pathname === '/github/project') {
        const status = requestUrl.searchParams.get('status') ?? 'all';
        const limit = readOptionalInteger(requestUrl.searchParams.get('limit'));
        const projectView = await fetchGitHubProjectView({
          token: environment.github.token,
          org: environment.github.org,
          projectNumber: environment.github.projectNumber,
          status,
          limit: limit ?? undefined
        });

        return createPublicJsonResult(200, projectView);
      }

      if (method === 'POST' && requestUrl.pathname === '/discord/interactions') {
        if (!environment.discord.publicKey) {
          return createJsonResult(503, {
            error: 'discord_not_configured',
            message: 'DISCORD_PUBLIC_KEY is required before Discord interactions can be verified.'
          });
        }

        const signatureCheck = await verifyDiscordSignature({
          publicKey: environment.discord.publicKey,
          signatureHeader: getHeaderValue(headers, 'x-signature-ed25519'),
          timestampHeader: getHeaderValue(headers, 'x-signature-timestamp'),
          payloadBuffer: bodyBuffer
        });

        if (!signatureCheck.ok) {
          return createJsonResult(401, {
            error: 'invalid_signature',
            reason: signatureCheck.reason
          });
        }

        const payload = parseJson(bodyBuffer);
        const interactionResponse = await buildDiscordInteractionResponse({
          payload,
          environment,
          settingsStore,
          auditLog,
          clock
        });

        return createJsonResult(200, interactionResponse);
      }

      if (method === 'GET' && requestUrl.pathname === '/mappings') {
        return createPublicJsonResult(200, {
          items: await mappingStore.list()
        });
      }

      if (method === 'GET' && requestUrl.pathname === '/audit') {
        return createPublicJsonResult(200, {
          entries: await auditLog.list(50)
        });
      }

      if (method === 'POST' && requestUrl.pathname === '/github/webhook') {
        const signatureCheck = await verifyGitHubSignature({
          secret: environment.github.webhookSecret,
          payloadBuffer: bodyBuffer,
          signatureHeader: getHeaderValue(headers, 'x-hub-signature-256')
        });

        if (!signatureCheck.ok) {
          return createJsonResult(401, {
            error: 'invalid_signature',
            reason: signatureCheck.reason
          });
        }

        const payload = parseJson(bodyBuffer);
        const eventName = getHeaderValue(headers, 'x-github-event') ?? 'unknown';
        const deliveryId = getHeaderValue(headers, 'x-github-delivery') ?? 'missing-delivery-id';
        const normalizedEvent = normalizeGitHubWebhook({
          eventName,
          deliveryId,
          payload,
          receivedAt: clock()
        });

        const mappingRecord = await mappingStore.upsertFromGitHub(normalizedEvent);

        await auditLog.record({
          kind: 'github_webhook',
          deliveryId,
          eventName,
          action: normalizedEvent.action,
          receivedAt: normalizedEvent.receivedAt,
          projectItemId: normalizedEvent.github.projectItemId,
          snapshotHash: normalizedEvent.snapshotHash,
          signatureVerified: signatureCheck.verified
        });

        return createJsonResult(eventName === 'ping' ? 200 : 202, {
          accepted: true,
          event: eventName,
          action: normalizedEvent.action,
          signatureVerified: signatureCheck.verified,
          mappingKey: mappingRecord?.githubProjectItemId ?? null,
          snapshotHash: normalizedEvent.snapshotHash
        });
      }

      return createJsonResult(404, {
        error: 'not_found'
      });
    } catch (error) {
      return createJsonResult(error.statusCode ?? 500, {
        error: 'server_error',
        message: error.message
      });
    }
  };
}

function createJsonResult(statusCode, payload, headers = {}) {
  return {
    statusCode,
    payload,
    headers
  };
}

function createPublicJsonResult(statusCode, payload) {
  return createJsonResult(statusCode, payload, createPublicCorsHeaders());
}

function createPublicCorsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

async function buildDiscordInteractionResponse({ payload, environment, settingsStore, auditLog, clock }) {
  await auditLog.record({
    kind: 'discord_interaction',
    interactionId: payload.id ?? null,
    interactionType: payload.type ?? null,
    commandName: payload.data?.name ?? null,
    guildId: payload.guild_id ?? null,
    channelId: payload.channel_id ?? null,
    receivedAt: clock()
  });

  if (payload.type === 1) {
    return {
      type: 1
    };
  }

  if (payload.type === 2) {
    return buildDiscordCommandInteractionResponse(payload, environment, settingsStore);
  }

  if (payload.type === 3) {
    return buildDiscordComponentInteractionResponse(payload, environment, settingsStore);
  }

  if (payload.type === 5) {
    return buildDiscordModalInteractionResponse(payload, environment, settingsStore);
  }

  return {
    type: 4,
    data: {
      content: 'The tracker scaffold received the interaction, but this type is not implemented yet.',
      flags: DISCORD_EPHEMERAL_FLAG
    }
  };
}

async function buildDiscordCommandInteractionResponse(payload, environment, settingsStore) {
  if (environment.discord.guildId && payload.guild_id !== environment.discord.guildId) {
    return createEphemeralDiscordResponse('This tracker is restricted to the configured Discord guild.');
  }

  if (![TRACKER_COMMAND, PROJECTS_COMMAND, LEGACY_TRACKED_PROJECT_VIEW_COMMAND].includes(payload.data?.name)) {
    return createEphemeralDiscordResponse(`Tracker command not implemented: ${payload.data?.name ?? 'unknown'}.`);
  }

  try {
    const route = readTrackerCommandRoute(payload.data);

    if (route.kind === 'legacy-board' || route.subcommandName === 'board') {
      const status = readInteractionOptionValue(route.options, 'status') ?? 'all';
      const projectKey = readInteractionOptionValue(route.options, 'project') ?? null;
      const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey });
      const projectView = await fetchGitHubProjectView({
        token: environment.github.token,
        org: projectContext.org,
        projectNumber: projectContext.projectNumber,
        status
      });

      return {
        type: 4,
        data: buildProjectDashboardMessage(projectView, status, projectContext)
      };
    }

    if (route.groupName === 'settings' && (route.subcommandName === 'show' || route.subcommandName === 'list')) {
      const settingsView = await settingsStore.getGuildSettings({
        guildId: payload.guild_id ?? null,
        fallbackProject: createDefaultTrackerProject(environment)
      });

      return {
        type: 4,
        data: {
          flags: DISCORD_EPHEMERAL_FLAG,
          embeds: [buildProjectSettingsEmbed(settingsView)]
        }
      };
    }

    if (route.groupName === 'settings' && route.subcommandName === 'set') {
      ensureWriterAccess(payload, environment);

      const savedProject = await settingsStore.saveGuildProject({
        guildId: payload.guild_id ?? null,
        projectKey: readInteractionOptionValue(route.options, 'key'),
        org: readInteractionOptionValue(route.options, 'org'),
        projectNumber: readInteractionOptionValue(route.options, 'project_number'),
        label: readInteractionOptionValue(route.options, 'label'),
        makeActive: Boolean(readInteractionOptionValue(route.options, 'make_active'))
      });
      const settingsView = await settingsStore.getGuildSettings({
        guildId: payload.guild_id ?? null,
        fallbackProject: createDefaultTrackerProject(environment)
      });

      return {
        type: 4,
        data: {
          flags: DISCORD_EPHEMERAL_FLAG,
          embeds: [buildProjectSettingsEmbed(settingsView, `Saved ${savedProject.label}.`)]
        }
      };
    }

    if (route.groupName === 'settings' && route.subcommandName === 'use') {
      ensureWriterAccess(payload, environment);

      const activeProject = await settingsStore.setActiveGuildProject({
        guildId: payload.guild_id ?? null,
        projectKey: readInteractionOptionValue(route.options, 'key'),
        fallbackProject: createDefaultTrackerProject(environment)
      });
      const settingsView = await settingsStore.getGuildSettings({
        guildId: payload.guild_id ?? null,
        fallbackProject: createDefaultTrackerProject(environment)
      });

      return {
        type: 4,
        data: {
          flags: DISCORD_EPHEMERAL_FLAG,
          embeds: [buildProjectSettingsEmbed(settingsView, `Active project switched to ${activeProject.label}.`)]
        }
      };
    }

    return createEphemeralDiscordResponse(`Tracker command not implemented: ${payload.data?.name ?? 'unknown'}.`);
  } catch (error) {
    return createEphemeralDiscordResponse(`Tracker command failed: ${error.message}`);
  }
}

async function buildDiscordComponentInteractionResponse(payload, environment, settingsStore) {
  if (environment.discord.guildId && payload.guild_id !== environment.discord.guildId) {
    return createEphemeralDiscordResponse('This tracker is restricted to the configured Discord guild.');
  }

  const componentType = payload.data?.component_type;
  const customId = payload.data?.custom_id ?? '';

  try {
    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_REFRESH_COMPONENT_ID)) {
      const dashboardState = readDashboardStateFromCustomId(customId, TRACKER_REFRESH_COMPONENT_ID);
      const projectContext = await resolveTrackerProjectContext({
        payload,
        environment,
        settingsStore,
        projectKey: dashboardState.projectKey
      });
      const projectView = await fetchGitHubProjectView({
        token: environment.github.token,
        org: projectContext.org,
        projectNumber: projectContext.projectNumber,
        status: dashboardState.status
      });

      return {
        type: DISCORD_MESSAGE_UPDATE_TYPE,
        data: buildProjectDashboardMessage(projectView, dashboardState.status, projectContext)
      };
    }

    if (componentType === DISCORD_COMPONENT_TYPE_STRING_SELECT && customId.startsWith(TRACKER_STATUS_COMPONENT_ID)) {
      const dashboardState = readDashboardStateFromCustomId(customId, TRACKER_STATUS_COMPONENT_ID);
      const status = normalizeDashboardStatusKey(payload.data?.values?.[0] ?? 'all');
      const projectContext = await resolveTrackerProjectContext({
        payload,
        environment,
        settingsStore,
        projectKey: dashboardState.projectKey
      });
      const projectView = await fetchGitHubProjectView({
        token: environment.github.token,
        org: projectContext.org,
        projectNumber: projectContext.projectNumber,
        status
      });

      return {
        type: DISCORD_MESSAGE_UPDATE_TYPE,
        data: buildProjectDashboardMessage(projectView, status, projectContext)
      };
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGE_COMPONENT_ID)) {
      if (!hasTrackerOperatorAccess(payload, environment)) {
        return createEphemeralDiscordResponse('Everyone can view the dashboard, but only admins or configured operator roles can change GitHub from Discord.');
      }

      const dashboardState = readDashboardStateFromCustomId(customId, TRACKER_MANAGE_COMPONENT_ID);
      return await openManagerPanel({ payload, environment, settingsStore, status: dashboardState.status, projectKey: dashboardState.projectKey });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGER_REFRESH_COMPONENT_ID)) {
      return await refreshManagerPanel({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_STRING_SELECT && customId.startsWith(TRACKER_MANAGER_ITEM_COMPONENT_ID)) {
      return await selectManagerItem({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_STRING_SELECT && customId.startsWith(TRACKER_MANAGER_STATUS_COMPONENT_ID)) {
      return await updateManagerStatus({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_STRING_SELECT && customId.startsWith(TRACKER_MANAGER_PRIORITY_COMPONENT_ID)) {
      return await updateManagerPriority({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGER_CREATE_COMPONENT_ID)) {
      return openCreateManagerModal({ payload });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGER_EDIT_COMPONENT_ID)) {
      return await openEditManagerModal({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGER_DELETE_COMPONENT_ID)) {
      return await askManagerDelete({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGER_DELETE_CONFIRM_COMPONENT_ID)) {
      return await confirmManagerDelete({ payload, environment, settingsStore });
    }

    if (componentType === DISCORD_COMPONENT_TYPE_BUTTON && customId.startsWith(TRACKER_MANAGER_DELETE_CANCEL_COMPONENT_ID)) {
      return await cancelManagerDelete({ payload, environment, settingsStore });
    }

    return createEphemeralDiscordResponse(`Tracker dashboard control not implemented: ${customId || 'unknown'}.`);
  } catch (error) {
    return createEphemeralDiscordResponse(`Tracker could not refresh GitHub Project ${environment.github.projectNumber ?? 'unknown'}: ${error.message}`);
  }
}

async function buildDiscordModalInteractionResponse(payload, environment, settingsStore) {
  if (environment.discord.guildId && payload.guild_id !== environment.discord.guildId) {
    return createEphemeralDiscordResponse('This tracker is restricted to the configured Discord guild.');
  }

  if (!hasTrackerOperatorAccess(payload, environment)) {
    return createEphemeralDiscordResponse('Everyone can view the dashboard, but only admins or configured operator roles can change GitHub from Discord.');
  }

  const customId = payload.data?.custom_id ?? '';

  try {
    if (customId.startsWith(TRACKER_MANAGER_CREATE_MODAL_ID)) {
      return await submitCreateManagerModal({ payload, environment, settingsStore });
    }

    if (customId.startsWith(TRACKER_MANAGER_EDIT_MODAL_ID)) {
      return await submitEditManagerModal({ payload, environment, settingsStore });
    }

    return createEphemeralDiscordResponse(`Tracker modal not implemented: ${customId || 'unknown'}.`);
  } catch (error) {
    return createEphemeralDiscordResponse(`Tracker could not apply the requested GitHub change: ${error.message}`);
  }
}

function buildProjectDashboardMessage(projectView, selectedStatus, projectContext) {
  const normalizedStatus = normalizeDashboardStatusKey(selectedStatus);

  return {
    allowed_mentions: {
      parse: []
    },
    embeds: buildDashboardEmbeds(projectView, normalizedStatus, projectContext),
    components: buildDashboardComponents(projectView, normalizedStatus, projectContext)
  };
}

function buildDashboardEmbeds(projectView, selectedStatus, projectContext) {
  const embeds = [buildDashboardOverviewEmbed(projectView, selectedStatus, projectContext)];

  if (selectedStatus === 'all') {
    embeds.push(buildDashboardBoardEmbed(projectView));
  } else {
    embeds.push(buildFilteredResultsEmbed(projectView, selectedStatus));
  }

  return embeds;
}

function buildDashboardOverviewEmbed(projectView, selectedStatus, projectContext) {
  return {
    type: 'rich',
    title: projectView.title,
    url: projectView.url,
    description: `Live planning dashboard for ${escapeMarkdown(projectContext.label)}.`,
    color: STATUS_EMBED_COLORS[selectedStatus] ?? STATUS_EMBED_COLORS.all,
    fields: [
      {
        name: 'Project',
        value: `\`${projectContext.key}\` · ${escapeMarkdown(projectContext.org)} #${projectContext.projectNumber}`,
        inline: false
      },
      {
        name: 'View',
        value: formatStatusFilterLabel(selectedStatus),
        inline: true
      },
      {
        name: 'Visible items',
        value: `${projectView.items.length}/${projectView.matchingCount}`,
        inline: true
      },
      {
        name: 'Total items',
        value: String(projectView.totalCount),
        inline: true
      },
      {
        name: 'Status counts',
        value: `In progress ${projectView.statusCounts['In progress']}\nTodo ${projectView.statusCounts.Todo}\nDone ${projectView.statusCounts.Done}${projectView.statusCounts.Other > 0 ? `\nOther ${projectView.statusCounts.Other}` : ''}`,
        inline: false
      }
    ],
    footer: {
      text: 'Dashboard v1 · Refresh to pull the latest GitHub state'
    }
  };
}

function buildDashboardBoardEmbed(projectView) {
  return {
    type: 'rich',
    title: 'Board snapshot',
    color: STATUS_EMBED_COLORS.all,
    fields: buildDashboardBoardFields(projectView.lanes),
    footer: {
      text: 'Board view · top cards per lane'
    }
  };
}

function buildDashboardBoardFields(lanes) {
  return lanes.map((lane) => ({
    name: `${formatLaneGlyph(lane.key)} ${lane.label} · ${lane.count}`,
    value: buildLaneColumnValue(lane),
    inline: true
  }));
}

function buildFilteredResultsEmbed(projectView, selectedStatus) {
  return {
    type: 'rich',
    title: `${formatStatusFilterLabel(selectedStatus)} focus`,
    color: STATUS_EMBED_COLORS[selectedStatus] ?? STATUS_EMBED_COLORS.all,
    description: buildFilteredDescription(projectView, selectedStatus)
  };
}

function buildLaneDescription(lane) {
  if (lane.items.length === 0) {
    return 'No items in this lane.';
  }

  const lines = lane.items.map((item) => formatProjectItemLine(item));

  if (lane.count > lane.items.length) {
    lines.push(`…and ${lane.count - lane.items.length} more.`);
  }

  return lines.join('\n').slice(0, 4000);
}

function buildLaneColumnValue(lane) {
  if (lane.items.length === 0) {
    return '*No items in this lane.*';
  }

  const blocks = lane.items.map((item, index) => formatBoardCard(item, index + 1));

  if (lane.count > lane.items.length) {
    blocks.push(`*+${lane.count - lane.items.length} more*`);
  }

  return truncateText(blocks.join('\n\n'), 1024);
}

function buildFilteredDescription(projectView, selectedStatus) {
  if (projectView.items.length === 0) {
    return `No ${formatStatusFilterLabel(selectedStatus).toLowerCase()} items matched that filter.`;
  }

  const lines = projectView.items.map((item) => formatProjectItemLine(item));

  if (projectView.matchingCount > projectView.items.length) {
    lines.push(`…and ${projectView.matchingCount - projectView.items.length} more.`);
  }

  return lines.join('\n').slice(0, 4000);
}

function buildDashboardComponents(projectView, selectedStatus, projectContext) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: 'Refresh',
          custom_id: buildDashboardCustomId(TRACKER_REFRESH_COMPONENT_ID, selectedStatus, projectContext.key)
        },
        {
          type: 2,
          style: 5,
          label: 'Open GitHub Board',
          url: projectView.url
        },
        {
          type: 2,
          style: 2,
          label: 'Manage',
          custom_id: buildDashboardCustomId(TRACKER_MANAGE_COMPONENT_ID, selectedStatus, projectContext.key)
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: buildDashboardCustomId(TRACKER_STATUS_COMPONENT_ID, selectedStatus, projectContext.key),
          placeholder: 'Switch dashboard view',
          min_values: 1,
          max_values: 1,
          options: buildStatusOptions(selectedStatus)
        }
      ]
    }
  ];
}

function buildStatusOptions(selectedStatus) {
  return [
    createStatusOption('All lanes', 'all', selectedStatus),
    createStatusOption('In progress', 'in_progress', selectedStatus),
    createStatusOption('Todo', 'todo', selectedStatus),
    createStatusOption('Done', 'done', selectedStatus)
  ];
}

function createStatusOption(label, value, selectedStatus) {
  return {
    label,
    value,
    default: value === selectedStatus
  };
}

function formatProjectItemLine(item) {
  const metadata = [];

  if (item.priority) {
    metadata.push(item.priority);
  }

  if (item.driver) {
    metadata.push(item.driver);
  }

  if (item.targetDate) {
    metadata.push(`due ${item.targetDate}`);
  } else if (item.iteration) {
    metadata.push(item.iteration);
  }

  const prefix = metadata.length > 0 ? `${metadata.join(' · ')} · ` : '';
  const title = item.url ? `[${escapeMarkdown(item.title)}](${item.url})` : escapeMarkdown(item.title);
  return `• ${prefix}${truncateText(title, 180)}`;
}

function formatBoardCard(item, index) {
  const title = item.url ? `[${escapeMarkdown(item.title)}](${item.url})` : escapeMarkdown(item.title);
  const metadata = [];

  if (item.priority) {
    metadata.push(item.priority);
  }

  if (item.driver) {
    metadata.push(item.driver);
  }

  if (item.targetDate) {
    metadata.push(item.targetDate);
  } else if (item.iteration) {
    metadata.push(item.iteration);
  }

  const metadataLine = metadata.length > 0 ? `\`${truncateText(metadata.join(' · '), 90)}\`` : '`No metadata`';
  return `**${index}. ${truncateText(title, 110)}**\n${metadataLine}`;
}

function formatLaneGlyph(laneKey) {
  switch (laneKey) {
    case 'todo':
      return '○';
    case 'in_progress':
      return '◐';
    case 'done':
      return '●';
    default:
      return '•';
  }
}

function formatStatusFilterLabel(status) {
  switch (normalizeDashboardStatusKey(status)) {
    case 'todo':
      return 'Todo';
    case 'in_progress':
      return 'In progress';
    case 'done':
      return 'Done';
    default:
      return 'All lanes';
  }
}

function normalizeDashboardStatusKey(value) {
  switch (value) {
    case 'todo':
    case 'Todo':
      return 'todo';
    case 'in_progress':
    case 'In progress':
    case 'in progress':
      return 'in_progress';
    case 'done':
    case 'Done':
      return 'done';
    default:
      return 'all';
  }
}

function buildDashboardCustomId(prefix, status, projectKey = null) {
  const parts = [prefix, `s=${encodeURIComponent(normalizeDashboardStatusKey(status))}`];

  if (projectKey) {
    parts.push(`p=${encodeURIComponent(projectKey)}`);
  }

  return parts.join('|');
}

function readDashboardStateFromCustomId(customId, prefix) {
  const params = readStateParamsFromCustomId(customId, prefix);

  return {
    status: normalizeDashboardStatusKey(params.s ?? 'all'),
    projectKey: params.p ?? null
  };
}

function hasTrackerOperatorAccess(payload, environment) {
  const roleIds = environment.discord.operatorRoleIds;
  const memberRoleIds = Array.isArray(payload.member?.roles) ? payload.member.roles : [];

  if (roleIds.length > 0 && memberRoleIds.some((roleId) => roleIds.includes(roleId))) {
    return true;
  }

  const rawPermissions = payload.member?.permissions;

  if (typeof rawPermissions !== 'string' || rawPermissions.length === 0) {
    return roleIds.length === 0;
  }

  try {
    const permissionBits = BigInt(rawPermissions);
    return TRUSTED_DISCORD_PERMISSION_BITS.some((requiredBit) => (permissionBits & requiredBit) === requiredBit);
  } catch {
    return false;
  }
}

function escapeMarkdown(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function createEphemeralDiscordResponse(content) {
  return {
    type: 4,
    data: {
      content,
      flags: DISCORD_EPHEMERAL_FLAG
    }
  };
}

async function openManagerPanel({ payload, environment, settingsStore, status, projectKey = null }) {
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status
  });
  const selectedItem = resolveSelectedItem(editorData.items, null);
  const managerState = {
    userId: readInteractionUserId(payload),
    status: normalizeDashboardStatusKey(status),
    projectKey: projectContext.key,
    selectedItemId: selectedItem?.id ?? null
  };

  return {
    type: 4,
    data: createEphemeralDiscordData(buildManagerMessage({
      editorData,
      managerState,
      confirmDelete: false,
      notice: 'Writer panel opened. Status and priority changes write directly to GitHub Projects.'
    }))
  };
}

async function refreshManagerPanel({ payload, environment, settingsStore, notice = null }) {
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_REFRESH_COMPONENT_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = resolveSelectedItem(editorData.items, managerState.selectedItemId);

  return {
    type: DISCORD_MESSAGE_UPDATE_TYPE,
    data: buildManagerMessage({
      editorData,
      managerState: {
        ...managerState,
        selectedItemId: selectedItem?.id ?? null
      },
      confirmDelete: false,
      notice
    })
  };
}

async function selectManagerItem({ payload, environment, settingsStore }) {
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_ITEM_COMPONENT_ID
  });
  const nextSelectedItemId = payload.data?.values?.[0] ?? null;
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = resolveSelectedItem(editorData.items, nextSelectedItemId);

  return {
    type: DISCORD_MESSAGE_UPDATE_TYPE,
    data: buildManagerMessage({
      editorData,
      managerState: {
        ...managerState,
        selectedItemId: selectedItem?.id ?? null
      },
      confirmDelete: false,
      notice: null
    })
  };
}

async function updateManagerStatus({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_STATUS_COMPONENT_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = requireSelectedItem(editorData.items, managerState.selectedItemId);
  const nextStatus = payload.data?.values?.[0] ?? null;

  await updateProjectItemFields({
    token: environment.github.token,
    projectId: editorData.projectId,
    itemId: selectedItem.id,
    fields: editorData.fields,
    updates: {
      status: nextStatus
    }
  });

  return refreshManagerPanel({
    payload: {
      ...payload,
      data: {
        ...payload.data,
        custom_id: buildManagerCustomId(TRACKER_MANAGER_REFRESH_COMPONENT_ID, managerState)
      }
    },
    environment,
    settingsStore,
    notice: `Updated ${selectedItem.title} to ${nextStatus}.`
  });
}

async function updateManagerPriority({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_PRIORITY_COMPONENT_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = requireSelectedItem(editorData.items, managerState.selectedItemId);
  const rawPriority = payload.data?.values?.[0] ?? TRACKER_CLEAR_PRIORITY_VALUE;
  const nextPriority = rawPriority === TRACKER_CLEAR_PRIORITY_VALUE ? '' : rawPriority;

  await updateProjectItemFields({
    token: environment.github.token,
    projectId: editorData.projectId,
    itemId: selectedItem.id,
    fields: editorData.fields,
    updates: {
      priority: nextPriority
    }
  });

  return refreshManagerPanel({
    payload: {
      ...payload,
      data: {
        ...payload.data,
        custom_id: buildManagerCustomId(TRACKER_MANAGER_REFRESH_COMPONENT_ID, managerState)
      }
    },
    environment,
    settingsStore,
    notice: nextPriority ? `Updated ${selectedItem.title} to priority ${nextPriority}.` : `Cleared priority for ${selectedItem.title}.`
  });
}

function openCreateManagerModal({ payload }) {
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_CREATE_COMPONENT_ID
  });

  return {
    type: DISCORD_MODAL_RESPONSE_TYPE,
    data: {
      custom_id: buildManagerCustomId(TRACKER_MANAGER_CREATE_MODAL_ID, managerState),
      title: 'Create GitHub draft item',
      components: buildCreateManagerModalComponents()
    }
  };
}

async function openEditManagerModal({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_EDIT_COMPONENT_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = requireSelectedItem(editorData.items, managerState.selectedItemId);

  if (!isDraftProjectItem(selectedItem)) {
    return createEphemeralDiscordResponse('Status and priority can be changed for any item, but detailed title and notes edits are draft-only in this slice.');
  }

  return {
    type: DISCORD_MODAL_RESPONSE_TYPE,
    data: {
      custom_id: buildManagerCustomId(TRACKER_MANAGER_EDIT_MODAL_ID, managerState),
      title: 'Edit draft item',
      components: buildEditManagerModalComponents(selectedItem)
    }
  };
}

async function askManagerDelete({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_DELETE_COMPONENT_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = requireSelectedItem(editorData.items, managerState.selectedItemId);

  if (!isDraftProjectItem(selectedItem)) {
    return createEphemeralDiscordResponse('Delete is restricted to draft items in this slice so linked issues and pull requests stay safe.');
  }

  return {
    type: DISCORD_MESSAGE_UPDATE_TYPE,
    data: buildManagerMessage({
      editorData,
      managerState: {
        ...managerState,
        selectedItemId: selectedItem.id
      },
      confirmDelete: true,
      notice: `Confirm deletion for ${selectedItem.title}. This removes the card from GitHub Projects.`
    })
  };
}

async function confirmManagerDelete({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_DELETE_CONFIRM_COMPONENT_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = requireSelectedItem(editorData.items, managerState.selectedItemId);

  if (!isDraftProjectItem(selectedItem)) {
    return createEphemeralDiscordResponse('Delete is restricted to draft items in this slice so linked issues and pull requests stay safe.');
  }

  await deleteProjectItem({
    token: environment.github.token,
    projectId: editorData.projectId,
    itemId: selectedItem.id
  });

  const refreshedEditorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const nextSelectedItem = resolveSelectedItem(refreshedEditorData.items, null);

  return {
    type: DISCORD_MESSAGE_UPDATE_TYPE,
    data: buildManagerMessage({
      editorData: refreshedEditorData,
      managerState: {
        ...managerState,
        selectedItemId: nextSelectedItem?.id ?? null
      },
      confirmDelete: false,
      notice: `Deleted ${selectedItem.title} from the GitHub Project board.`
    })
  };
}

async function cancelManagerDelete({ payload, environment, settingsStore }) {
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_DELETE_CANCEL_COMPONENT_ID
  });

  return refreshManagerPanel({
    payload: {
      ...payload,
      data: {
        ...payload.data,
        custom_id: buildManagerCustomId(TRACKER_MANAGER_REFRESH_COMPONENT_ID, managerState)
      }
    },
    environment,
    settingsStore,
    notice: 'Delete cancelled.'
  });
}

async function submitCreateManagerModal({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_CREATE_MODAL_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const formValues = readManagerModalValues(payload.data?.components ?? []);
  const createdStatus = managerState.status === 'all' ? undefined : formatStatusFilterLabel(managerState.status);
  await createProjectDraftItem({
    token: environment.github.token,
    projectId: editorData.projectId,
    fields: editorData.fields,
    input: {
      title: formValues.title,
      status: createdStatus,
      driver: formValues.driver,
      targetDate: formValues.targetDate,
      notes: formValues.notes
    }
  });

  return createEphemeralDiscordResponse(`Created ${formValues.title} in GitHub Projects. Refresh the manager panel to load the new card.`);
}

async function submitEditManagerModal({ payload, environment, settingsStore }) {
  ensureWriterAccess(payload, environment);
  const managerState = readRequiredManagerState({
    payload,
    customId: payload.data?.custom_id ?? '',
    prefix: TRACKER_MANAGER_EDIT_MODAL_ID
  });
  const projectContext = await resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey: managerState.projectKey });
  const editorData = await fetchGitHubProjectEditorData({
    token: environment.github.token,
    org: projectContext.org,
    projectNumber: projectContext.projectNumber,
    status: managerState.status
  });
  const selectedItem = requireSelectedItem(editorData.items, managerState.selectedItemId);

  if (!isDraftProjectItem(selectedItem)) {
    return createEphemeralDiscordResponse('Detailed edits are draft-only in this slice. Use status and priority for linked issues or pull requests.');
  }

  const formValues = readManagerModalValues(payload.data?.components ?? []);
  await updateProjectDraftItem({
    token: environment.github.token,
    draftIssueId: selectedItem.contentId,
    title: formValues.title,
    notes: formValues.notes
  });
  await updateProjectItemFields({
    token: environment.github.token,
    projectId: editorData.projectId,
    itemId: selectedItem.id,
    fields: editorData.fields,
    updates: {
      driver: formValues.driver,
      targetDate: formValues.targetDate,
      notes: formValues.notes
    }
  });

  return createEphemeralDiscordResponse(`Updated ${formValues.title || selectedItem.title}. Refresh the manager panel to load the latest GitHub state.`);
}

function buildManagerMessage({ editorData, managerState, confirmDelete, notice }) {
  const selectedItem = resolveSelectedItem(editorData.items, managerState.selectedItemId);

  return {
    allowed_mentions: {
      parse: []
    },
    content: notice ?? undefined,
    embeds: buildManagerEmbeds(editorData, selectedItem, confirmDelete),
    components: buildManagerComponents(editorData, selectedItem, managerState, confirmDelete)
  };
}

function buildManagerEmbeds(editorData, selectedItem, confirmDelete) {
  return [
    {
      type: 'rich',
      title: 'Velora Tracker Manager',
      description: 'Private writer panel for GitHub Project mutations from Discord.',
      color: confirmDelete ? 0xdc2626 : 0x1d4ed8,
      fields: [
        {
          name: 'Filter',
          value: formatStatusFilterLabel(editorData.appliedStatusFilter),
          inline: true
        },
        {
          name: 'Visible items',
          value: String(editorData.items.length),
          inline: true
        },
        {
          name: 'Write scope',
          value: 'Status and priority for any card. Full edit and delete for drafts only.',
          inline: false
        }
      ]
    },
    buildSelectedItemEmbed(selectedItem, confirmDelete)
  ];
}

function buildSelectedItemEmbed(selectedItem, confirmDelete) {
  if (!selectedItem) {
    return {
      type: 'rich',
      title: 'No item selected',
      description: 'Create a new draft or pick an item from the selector to manage it.',
      color: 0x475569
    };
  }

  const notes = normalizeNotesPreview(selectedItem.notes ?? selectedItem.body);

  return {
    type: 'rich',
    title: selectedItem.title,
    description: confirmDelete
      ? 'Delete confirmation is armed for this draft item.'
      : 'Use the controls below to update this card from Discord.',
    color: confirmDelete ? 0xdc2626 : 0x0f172a,
    fields: [
      {
        name: 'Type',
        value: formatProjectItemType(selectedItem.type),
        inline: true
      },
      {
        name: 'Status',
        value: selectedItem.status ?? 'Unset',
        inline: true
      },
      {
        name: 'Priority',
        value: selectedItem.priority ?? 'Unset',
        inline: true
      },
      {
        name: 'Driver',
        value: selectedItem.driver ?? 'Unset',
        inline: true
      },
      {
        name: 'Target date',
        value: selectedItem.targetDate ?? 'Unset',
        inline: true
      },
      {
        name: 'Linked URL',
        value: selectedItem.url ?? 'Draft-only item',
        inline: false
      },
      {
        name: 'Notes',
        value: notes,
        inline: false
      }
    ]
  };
}

function buildManagerComponents(editorData, selectedItem, managerState, confirmDelete) {
  const canEditDraft = Boolean(selectedItem && isDraftProjectItem(selectedItem));
  const hasStatusField = Boolean(editorData.fields.status);
  const hasPriorityField = Boolean(editorData.fields.priority);

  if (confirmDelete) {
    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: 'Confirm delete',
            custom_id: buildManagerCustomId(TRACKER_MANAGER_DELETE_CONFIRM_COMPONENT_ID, managerState)
          },
          {
            type: 2,
            style: 2,
            label: 'Cancel',
            custom_id: buildManagerCustomId(TRACKER_MANAGER_DELETE_CANCEL_COMPONENT_ID, managerState)
          }
        ]
      }
    ];
  }

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: 'Refresh',
          custom_id: buildManagerCustomId(TRACKER_MANAGER_REFRESH_COMPONENT_ID, managerState)
        },
        {
          type: 2,
          style: 3,
          label: 'New draft',
          custom_id: buildManagerCustomId(TRACKER_MANAGER_CREATE_COMPONENT_ID, managerState)
        },
        {
          type: 2,
          style: 2,
          label: 'Edit draft',
          custom_id: buildManagerCustomId(TRACKER_MANAGER_EDIT_COMPONENT_ID, managerState),
          disabled: !canEditDraft
        },
        {
          type: 2,
          style: 4,
          label: 'Delete draft',
          custom_id: buildManagerCustomId(TRACKER_MANAGER_DELETE_COMPONENT_ID, managerState),
          disabled: !canEditDraft
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: buildManagerCustomId(TRACKER_MANAGER_ITEM_COMPONENT_ID, managerState),
          placeholder: editorData.items.length > 0 ? 'Select an item to manage' : 'No items in this filter',
          min_values: 1,
          max_values: 1,
          options: buildManagerItemOptions(editorData.items, selectedItem?.id ?? null),
          disabled: editorData.items.length === 0
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: buildManagerCustomId(TRACKER_MANAGER_STATUS_COMPONENT_ID, managerState),
          placeholder: 'Change status',
          min_values: 1,
          max_values: 1,
          options: buildManagerFieldOptions(editorData.fields.status, selectedItem?.status ?? null, false),
          disabled: !selectedItem || !hasStatusField
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: buildManagerCustomId(TRACKER_MANAGER_PRIORITY_COMPONENT_ID, managerState),
          placeholder: 'Change priority',
          min_values: 1,
          max_values: 1,
          options: buildManagerFieldOptions(editorData.fields.priority, selectedItem?.priority ?? null, true),
          disabled: !selectedItem || !hasPriorityField
        }
      ]
    }
  ];
}

function buildManagerItemOptions(items, selectedItemId) {
  if (items.length === 0) {
    return [
      {
        label: 'No items available',
        value: 'none',
        default: true
      }
    ];
  }

  return items.map((item) => ({
    label: truncateText(item.title, 95),
    value: item.id,
    description: truncateText(`${item.status ?? 'Unset'} · ${item.priority ?? 'Unset'} · ${item.driver ?? 'No driver'}`, 100),
    default: item.id === selectedItemId
  }));
}

function buildManagerFieldOptions(field, selectedValue, includeClearOption) {
  if (!field?.options || field.options.length === 0) {
    return [
      {
        label: 'No options configured',
        value: 'none',
        default: true
      }
    ];
  }

  const options = [];

  if (includeClearOption) {
    options.push({
      label: 'Clear priority',
      value: TRACKER_CLEAR_PRIORITY_VALUE,
      default: !selectedValue
    });
  }

  for (const option of field.options) {
    options.push({
      label: option.name,
      value: option.name,
      default: option.name === selectedValue
    });
  }

  if (!options.some((option) => option.default) && options.length > 0) {
    options[0].default = true;
  }

  return options;
}

function buildCreateManagerModalComponents() {
  return [
    createTextInputRow('title', 'Title', DISCORD_TEXT_STYLE_SHORT, true),
    createTextInputRow('driver', 'Driver', DISCORD_TEXT_STYLE_SHORT, false),
    createTextInputRow('targetDate', 'Target date (YYYY-MM-DD)', DISCORD_TEXT_STYLE_SHORT, false),
    createTextInputRow('notes', 'Notes', DISCORD_TEXT_STYLE_PARAGRAPH, false)
  ];
}

function buildEditManagerModalComponents(selectedItem) {
  return [
    createTextInputRow('title', 'Title', DISCORD_TEXT_STYLE_SHORT, true, selectedItem.title),
    createTextInputRow('driver', 'Driver', DISCORD_TEXT_STYLE_SHORT, false, selectedItem.driver ?? ''),
    createTextInputRow('targetDate', 'Target date (YYYY-MM-DD)', DISCORD_TEXT_STYLE_SHORT, false, selectedItem.targetDate ?? ''),
    createTextInputRow('notes', 'Notes', DISCORD_TEXT_STYLE_PARAGRAPH, false, selectedItem.notes ?? selectedItem.body ?? '')
  ];
}

function createTextInputRow(customId, label, style, required, value = undefined) {
  return {
    type: 1,
    components: [
      {
        type: DISCORD_COMPONENT_TYPE_TEXT_INPUT,
        custom_id: customId,
        label,
        style,
        required,
        value
      }
    ]
  };
}

function readRequiredManagerState({ payload, customId, prefix }) {
  const managerState = readManagerStateFromCustomId(customId, prefix);
  const currentUserId = readInteractionUserId(payload);

  if (!managerState.userId || managerState.userId !== currentUserId) {
    const error = new Error('This writer panel belongs to a different Discord user.');
    error.statusCode = 403;
    throw error;
  }

  return managerState;
}

function readManagerStateFromCustomId(customId, prefix) {
  const params = readStateParamsFromCustomId(customId, prefix);

  return {
    userId: params.u ?? null,
    status: normalizeDashboardStatusKey(params.s ?? 'all'),
    projectKey: params.p ?? null,
    selectedItemId: params.i ?? null
  };
}

function buildManagerCustomId(prefix, managerState) {
  const parts = [
    prefix,
    `u=${encodeURIComponent(managerState.userId ?? '')}`,
    `s=${encodeURIComponent(managerState.status ?? 'all')}`
  ];

  if (managerState.projectKey) {
    parts.push(`p=${encodeURIComponent(managerState.projectKey)}`);
  }

  if (managerState.selectedItemId) {
    parts.push(`i=${encodeURIComponent(managerState.selectedItemId)}`);
  }

  return parts.join('|');
}

function ensureWriterAccess(payload, environment) {
  if (!hasTrackerOperatorAccess(payload, environment)) {
    const error = new Error('Everyone can view the dashboard, but only admins or configured operator roles can change GitHub from Discord.');
    error.statusCode = 403;
    throw error;
  }
}

function readInteractionUserId(payload) {
  return payload.member?.user?.id ?? payload.user?.id ?? null;
}

function readStateParamsFromCustomId(customId, prefix) {
  if (!customId.startsWith(prefix)) {
    const error = new Error('Tracker state was missing from the Discord interaction.');
    error.statusCode = 400;
    throw error;
  }

  const parts = customId.slice(prefix.length).split('|').filter(Boolean);
  const params = {};

  for (const part of parts) {
    const [key, value] = part.split('=');

    if (key && value) {
      params[key] = decodeURIComponent(value);
    }
  }

  return params;
}

function readTrackerCommandRoute(data) {
  if (data?.name === LEGACY_TRACKED_PROJECT_VIEW_COMMAND) {
    return {
      kind: 'legacy-board',
      commandName: data.name,
      groupName: null,
      subcommandName: 'board',
      options: data.options ?? []
    };
  }

  const firstOption = Array.isArray(data?.options) ? data.options[0] ?? null : null;

  if (!firstOption) {
    return {
      kind: 'command',
      commandName: data?.name ?? null,
      groupName: null,
      subcommandName: null,
      options: []
    };
  }

  if (firstOption.type === 2) {
    const nestedOption = firstOption.options?.[0] ?? null;

    return {
      kind: 'command',
      commandName: data?.name ?? null,
      groupName: firstOption.name,
      subcommandName: nestedOption?.name ?? null,
      options: nestedOption?.options ?? []
    };
  }

  return {
    kind: 'command',
    commandName: data?.name ?? null,
    groupName: null,
    subcommandName: firstOption.name,
    options: firstOption.options ?? []
  };
}

function createDefaultTrackerProject(environment) {
  return {
    key: 'default',
    label: `${environment.github.org ?? 'GitHub'} #${environment.github.projectNumber ?? 'unset'}`,
    org: environment.github.org,
    projectNumber: environment.github.projectNumber
  };
}

async function resolveTrackerProjectContext({ payload, environment, settingsStore, projectKey = null }) {
  return settingsStore.resolveProject({
    guildId: payload.guild_id ?? null,
    projectKey,
    fallbackProject: createDefaultTrackerProject(environment)
  });
}

function buildProjectSettingsEmbed(settingsView, notice = null) {
  return {
    type: 'rich',
    title: 'Tracker project settings',
    color: SETTINGS_EMBED_COLOR,
    description: notice ?? 'Manage saved GitHub Projects for this Discord guild and switch the active board without redeploying the tracker.',
    fields: [
      {
        name: 'Active project',
        value: formatProjectSettingsLine(settingsView.activeProject, true),
        inline: false
      },
      {
        name: 'Saved projects',
        value: settingsView.projects.map((project) => formatProjectSettingsLine(project, project.key === settingsView.activeProjectKey)).join('\n'),
        inline: false
      },
      {
        name: 'How to change it',
        value: '`/tracker settings set key:<name> org:<org> project_number:<number> [label] [make_active:true]`\n`/tracker settings use key:<name>`',
        inline: false
      }
    ]
  };
}

function formatProjectSettingsLine(project, isActive) {
  const marker = isActive ? '• active' : '• saved';
  return `\`${project.key}\` ${escapeMarkdown(project.label)}\n${marker} · ${escapeMarkdown(project.org)} #${project.projectNumber}`;
}

function resolveSelectedItem(items, selectedItemId) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return items.find((item) => item.id === selectedItemId) ?? items[0];
}

function requireSelectedItem(items, selectedItemId) {
  const selectedItem = resolveSelectedItem(items, selectedItemId);

  if (!selectedItem) {
    const error = new Error('Pick a project item in the manager panel before using that action.');
    error.statusCode = 400;
    throw error;
  }

  return selectedItem;
}

function isDraftProjectItem(item) {
  return item?.type === 'DraftIssue';
}

function formatProjectItemType(type) {
  switch (type) {
    case 'DraftIssue':
      return 'Draft item';
    case 'Issue':
      return 'Linked issue';
    case 'PullRequest':
      return 'Linked pull request';
    default:
      return type ?? 'Project item';
  }
}

function normalizeNotesPreview(value) {
  const normalized = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'No notes set.';
  return truncateText(normalized, 1000);
}

function readManagerModalValues(rows) {
  return {
    title: readTextInputValue(rows, 'title') ?? '',
    driver: readTextInputValue(rows, 'driver') ?? '',
    targetDate: readTextInputValue(rows, 'targetDate') ?? '',
    notes: readTextInputValue(rows, 'notes') ?? ''
  };
}

function readTextInputValue(rows, customId) {
  if (!Array.isArray(rows)) {
    return null;
  }

  for (const row of rows) {
    const component = row?.components?.find((candidate) => candidate.custom_id === customId);

    if (component) {
      return typeof component.value === 'string' ? component.value : null;
    }
  }

  return null;
}

function createEphemeralDiscordData(data) {
  return {
    flags: DISCORD_EPHEMERAL_FLAG,
    ...data
  };
}

function readInteractionOptionValue(options, name) {
  if (!Array.isArray(options)) {
    return null;
  }

  const option = options.find((candidate) => candidate.name === name);
  return option?.value ?? null;
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string' || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function readOptionalInteger(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(payloadBuffer) {
  const serialized = textDecoder.decode(toUint8Array(payloadBuffer));

  if (!serialized.trim()) {
    return {};
  }

  try {
    return JSON.parse(serialized);
  } catch {
    const error = new Error('Request body was not valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function getHeaderValue(headers, name) {
  if (typeof headers?.get === 'function') {
    return headers.get(name);
  }

  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return typeof value === 'string' ? value : null;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new Uint8Array(value);
}