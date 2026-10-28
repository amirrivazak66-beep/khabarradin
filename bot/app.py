"""Approval-first Telegram bot starter for Khabar Radin."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("khabarradin.bot")

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
DESTINATION_CHANNEL = os.getenv("DESTINATION_CHANNEL", "").strip()
ADMIN_USER_IDS = {int(x.strip()) for x in os.getenv("ADMIN_USER_IDS", "").split(",") if x.strip().isdigit()}

CATEGORIES = ["ایران", "جهان", "سیاست", "اقتصاد", "حوادث", "فناوری و هوش مصنوعی", "خبرهای جالب", "ورزش"]


def is_admin(update: Update) -> bool:
    user = update.effective_user
    return bool(user and user.id in ADMIN_USER_IDS)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    await update.message.reply_text(
        "📰 دستیار تحریریه خبر رادین\n\n"
        "نسخه اولیه آماده است. در این مرحله می‌توانیم دسته‌ها را ببینیم و مطالب را برای بررسی تحریریه ثبت کنیم.\n"
        "دستورها:\n/categories — دسته‌های خبری\n/status — وضعیت تنظیمات\n/help — راهنما"
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text(
            "/start — شروع\n/categories — نمایش دسته‌ها\n/status — بررسی تنظیمات\n"
            "نسخه فعلی هنوز منبع‌خوانی خودکار یا انتشار خودکار را فعال نکرده است."
        )

async def categories(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text("دسته‌های اولیه خبر رادین:\n" + "\n".join(f"• {c}" for c in CATEGORIES))

async def status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    if not is_admin(update):
        await update.message.reply_text("این دستور فقط برای مدیران مجاز است.")
        return
    token_ok = bool(BOT_TOKEN and BOT_TOKEN != "replace_with_rotated_bot_token")
    channel_ok = bool(DESTINATION_CHANNEL)
    admins_ok = bool(ADMIN_USER_IDS)
    await update.message.reply_text(
        "وضعیت تنظیمات ربات:\n"
        f"• توکن تنظیم شده: {'بله' if token_ok else 'خیر'}\n"
        f"• کانال مقصد تنظیم شده: {'بله' if channel_ok else 'خیر'}\n"
        f"• مدیر مجاز تعریف شده: {'بله' if admins_ok else 'خیر'}\n\n"
        "منبع‌خوانی و بازنویسی هوش مصنوعی هنوز پیکربندی نشده‌اند."
    )

async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.exception("Unhandled bot error", exc_info=context.error)


def main() -> None:
    if not BOT_TOKEN or BOT_TOKEN == "replace_with_rotated_bot_token":
        raise SystemExit("Set BOT_TOKEN in the private .env file before starting the bot.")
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("categories", categories))
    app.add_handler(CommandHandler("status", status))
    app.add_error_handler(error_handler)
    log.info("Starting Khabar Radin bot (approval-first starter).")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
