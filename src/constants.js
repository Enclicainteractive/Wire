export const GatewayEvents = {
  // Connection
  READY:            'bot:ready',
  BOT_ERROR:        'bot:error',

  // Messages
  MESSAGE_CREATE:   'message:new',
  MESSAGE_UPDATE:   'message:updated',
  MESSAGE_DELETE:   'message:deleted',
  MESSAGE_EDITED:   'message:edited',
  MESSAGE_PINNED:   'message:pinned',
  MESSAGE_UNPINNED: 'message:unpinned',

  // Reactions
  REACTION_UPDATE:  'reaction:updated',

  // Members
  MEMBER_JOIN:      'member:joined',
  MEMBER_LEAVE:     'member:left',
  MEMBER_OFFLINE:   'member:offline',

  // Channels
  CHANNEL_CREATE:   'channel:created',
  CHANNEL_UPDATE:   'channel:updated',
  CHANNEL_DELETE:   'channel:deleted',

  // Servers
  SERVER_UPDATE:    'server:updated',

  // Typing
  TYPING_START:     'user:typing',

  // Voice
  VOICE_JOIN:       'voice:user-joined',
  VOICE_LEAVE:      'voice:user-left',
  VOICE_USER_UPDATE:'voice:user-updated',

  // User presence
  USER_STATUS:      'user:status',
}

export const Intents = {
  GUILD_MESSAGES:  'GUILD_MESSAGES',
  DIRECT_MESSAGES: 'DIRECT_MESSAGES',
  GUILD_MEMBERS:   'GUILD_MEMBERS',
  GUILD_VOICE:     'GUILD_VOICE',
  GUILD_REACTIONS: 'GUILD_REACTIONS',
  GUILD_CHANNELS:  'GUILD_CHANNELS',
  MESSAGE_CONTENT: 'MESSAGE_CONTENT',
  ALL: [
    'GUILD_MESSAGES', 'DIRECT_MESSAGES', 'GUILD_MEMBERS',
    'GUILD_VOICE', 'GUILD_REACTIONS', 'GUILD_CHANNELS', 'MESSAGE_CONTENT'
  ]
}

export const Permissions = {
  MESSAGES_READ:    'messages:read',
  MESSAGES_SEND:    'messages:send',
  MESSAGES_DELETE:  'messages:delete',
  CHANNELS_READ:    'channels:read',
  CHANNELS_MANAGE:  'channels:manage',
  MEMBERS_READ:     'members:read',
  MEMBERS_MANAGE:   'members:manage',
  REACTIONS_ADD:    'reactions:add',
  VOICE_CONNECT:    'voice:connect',
  WEBHOOKS_MANAGE:  'webhooks:manage',
  SERVER_MANAGE:    'server:manage',
  ADMIN:            '*'
}

export const BotStatus = {
  ONLINE:  'online',
  IDLE:    'idle',
  DND:     'dnd',
  OFFLINE: 'offline'
}
