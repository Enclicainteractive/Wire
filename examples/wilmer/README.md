# Wilmer

An example VoltChat bot built with [@voltchat/wire](https://github.com/voltchat/wire).

## Setup

1. Create a bot in VoltChat (Settings > Bots > Create Bot)
2. Copy the bot token
3. Install dependencies:

```bash
npm install
```

4. Run the bot:

```bash
WILMER_TOKEN=vbot_1b76ffb8bd8147375cad63a75eb35ffd1cf03c7a2e8ac541591b283f9005aa4a VOLT_SERVER=https://volt.voltagechat.app npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `!ping` | Check bot latency and uptime |
| `!hello [name]` | Get a friendly greeting |
| `!help` | List all commands |
| `!roll [NdS]` | Roll dice (e.g. `!roll 2d20`) |
| `!8ball <question>` | Ask the magic 8-ball |
| `!coinflip` | Flip a coin |
| `!serverinfo` | Show bot info |
| `!echo <text>` | Repeat your message |
