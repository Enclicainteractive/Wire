export const GatewayEvents = {
  READY: 'bot:ready',
  MESSAGE_CREATE: 'message:new',
  MESSAGE_UPDATE: 'message:updated',
  MESSAGE_DELETE: 'message:deleted',
  MEMBER_JOIN: 'member:joined',
  MEMBER_LEAVE: 'member:left',
  REACTION_ADD: 'reaction:updated',
  CHANNEL_CREATE: 'channel:created',
  CHANNEL_UPDATE: 'channel:updated',
  CHANNEL_DELETE: 'channel:deleted',
  SERVER_UPDATE: 'server:updated',
  TYPING_START: 'user:typing',
  VOICE_JOIN: 'voice:user-joined',
  VOICE_LEAVE: 'voice:user-left'
}

export const Intents = {
  GUILD_MESSAGES: 'GUILD_MESSAGES',
  DIRECT_MESSAGES: 'DIRECT_MESSAGES',
  GUILD_MEMBERS: 'GUILD_MEMBERS',
  GUILD_VOICE: 'GUILD_VOICE',
  GUILD_REACTIONS: 'GUILD_REACTIONS',
  GUILD_CHANNELS: 'GUILD_CHANNELS',
  MESSAGE_CONTENT: 'MESSAGE_CONTENT',
  ALL: [
    'GUILD_MESSAGES', 'DIRECT_MESSAGES', 'GUILD_MEMBERS',
    'GUILD_VOICE', 'GUILD_REACTIONS', 'GUILD_CHANNELS', 'MESSAGE_CONTENT'
  ]
}

export const Permissions = {
  MESSAGES_READ: 'messages:read',
  MESSAGES_SEND: 'messages:send',
  MESSAGES_DELETE: 'messages:delete',
  CHANNELS_READ: 'channels:read',
  CHANNELS_MANAGE: 'channels:manage',
  MEMBERS_READ: 'members:read',
  MEMBERS_MANAGE: 'members:manage',
  REACTIONS_ADD: 'reactions:add',
  VOICE_CONNECT: 'voice:connect',
  WEBHOOKS_MANAGE: 'webhooks:manage',
  SERVER_MANAGE: 'server:manage',
  ADMIN: '*'
}

export const BotStatus = {
  ONLINE: 'online',
  IDLE: 'idle',
  DND: 'dnd',
  OFFLINE: 'offline'
}
