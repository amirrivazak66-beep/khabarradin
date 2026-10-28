# Deployment notes — Khabar Radin Bot

## Configuration
Set these environment variables in the hosting provider's secret/environment settings:
- `BOT_TOKEN`: the newly rotated Telegram bot token. Do not use the token exposed in a chat.
- `DESTINATION_CHANNEL`: `@radinnews` (verify that this is the exact public channel username).
- `ADMIN_USER_IDS`: `9129058355` (confirm this is your own numeric Telegram user ID).

The bot must be added as an administrator to the destination channel with permission to post messages.

## Run locally
From the repository root:

```bash
python -m venv .venv
# activate the environment
pip install -r bot/requirements.txt
# create a private .env file from bot/.env.example in the repository root
python -m bot.app
```

## Hosting choice
The bot currently uses Telegram long polling, so it needs a continuously running Python process. Many free web-hosting tiers sleep or do not include free background workers, so they are not reliable for always-on polling. Use a small paid worker/VPS if you need continuous uptime, or refactor to a webhook-based design before using a free web service. Do not enter secrets in GitHub files or commit history.

## Current status
This is a starter control bot only. It does not yet read other Telegram channels, rewrite posts with an AI model, persist drafts, or auto-publish sourced posts. Those are separate implementation stages. Start with manual review and test posting only after configuration is complete.
