# Khabar Radin News Bot

Telegram news assistant for Khabar Radin. This first version provides a secure Telegram bot control panel, source registration, category management, editorial approval workflow, and publishing helpers. Source-channel ingestion and AI rewriting are configured in later steps.

## Safety
- Never commit `.env`, Telegram bot tokens, API keys, or Telethon session files.
- Rotate any token that was exposed in chat.
- Add the bot as an administrator in the destination channel with permission to post messages.
- Only monitor sources you are authorized to access; preserve source links and verify sensitive claims.

## Local setup
1. Python 3.11+
2. `python -m venv .venv`
3. Activate the environment and run `pip install -r bot/requirements.txt`
4. Copy `bot/.env.example` to `.env` at the project root and fill values locally.
5. Run `python -m bot.app` from the repository root.

This starter is approval-first: it does not automatically republish source posts until source access and editorial settings are explicitly configured.
