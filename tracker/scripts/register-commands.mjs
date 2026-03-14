import { readEnvironment } from '../src/config/env.js';
import { trackerCommandRegistry } from '../src/discord/commandRegistry.js';

const environment = readEnvironment(process.env);

if (!environment.discord.applicationId) {
  throw new Error('DISCORD_APPLICATION_ID is required before commands can be registered.');
}

if (!environment.discord.botToken) {
  throw new Error('DISCORD_BOT_TOKEN is required before commands can be registered.');
}

const endpoint = environment.discord.guildId
  ? `https://discord.com/api/v10/applications/${environment.discord.applicationId}/guilds/${environment.discord.guildId}/commands`
  : `https://discord.com/api/v10/applications/${environment.discord.applicationId}/commands`;

const response = await fetch(endpoint, {
  method: 'PUT',
  headers: {
    authorization: `Bot ${environment.discord.botToken}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(trackerCommandRegistry)
});

const payload = await response.json();

if (!response.ok) {
  throw new Error(payload.message ?? `Discord command registration failed with ${response.status}.`);
}

console.log(`Registered ${payload.length} tracker command(s) at ${environment.discord.guildId ? 'guild' : 'global'} scope.`);
for (const command of payload) {
  console.log(`- ${command.name}`);
}