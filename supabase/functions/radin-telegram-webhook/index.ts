import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true, service: "radin-telegram-webhook" });

  const botToken = Deno.env.get("BOT_TOKEN");
  const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const adminIds = (Deno.env.get("ADMIN_USER_IDS") ?? "9129058355")
    .split(",").map((x) => x.trim()).filter(Boolean);

  if (!botToken || !webhookSecret) {
    console.error("Missing BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET secret");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (receivedSecret.length !== webhookSecret.length ||
      !crypto.subtle || receivedSecret !== webhookSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let update: any;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const message = update.message ?? update.edited_message;
  if (!message?.text || !message.chat?.id) return json({ ok: true });

  const text = String(message.text).trim();
  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? "");
  const isAdmin = adminIds.includes(userId);
  let reply = "";

  if (text === "/start" || text.startsWith("/start@")) {
    reply = "به ربات خبر رادین خوش آمدید.\n\nبرای راهنما /help را بزنید.\nاین ربات فعلاً در مرحله راه‌اندازی امن است و هنوز خبرها را خودکار منتشر نمی‌کند.";
  } else if (text === "/help" || text.startsWith("/help@")) {
    reply = "دستورها:\n/start — شروع\n/help — راهنما\n/categories — دسته‌بندی‌ها\n/status — وضعیت راه‌اندازی (فقط مدیر)\n\nانتشار خودکار تا تکمیل تنظیمات و آزمون‌ها فعال نیست.";
  } else if (text === "/categories" || text.startsWith("/categories@")) {
    reply = "دسته‌بندی‌های خبر رادین:\n🇮🇷 ایران\n🌍 جهان\n🏛 سیاست\n💹 اقتصاد\n🚨 حوادث\n💻 فناوری و هوش مصنوعی\n⚽ ورزش\n✨ خبرهای جالب";
  } else if (text === "/status" || text.startsWith("/status@")) {
    if (!isAdmin) {
      reply = "این دستور فقط برای مدیر ربات در دسترس است.";
    } else {
      reply = "✅ وب‌هوک پاسخ‌گو است.\n🔐 احراز هویت درخواست فعال است.\n📰 دریافت و انتشار خودکار خبر هنوز فعال نشده است.\n📌 مقصد کانال و مجوز ارسال باید جداگانه آزمایش شوند.";
    }
  } else {
    return json({ ok: true });
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: reply, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    console.error("Telegram sendMessage failed", response.status);
    return json({ ok: false, error: "telegram_api_error" }, 502);
  }
  return json({ ok: true });
});