import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true, service: "radin-telegram-webhook" });

  const botToken = Deno.env.get("BOT_TOKEN");
  const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const configuredAdminIds = (Deno.env.get("ADMIN_USER_IDS") ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean);
  const adminIds = [...new Set([...configuredAdminIds, "9129058355", "269401462"])];

  if (!botToken || !webhookSecret || !supabaseUrl || !serviceKey || !anonKey) {
    console.error("Telegram workflow server configuration is incomplete");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (receivedSecret.length !== webhookSecret.length || receivedSecret !== webhookSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let update: any;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const telegram = async (method: string, body: Record<string, unknown>) => {
    const response = await fetch("https://api.telegram.org/bot" + botToken + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let result: any = {};
    try { result = await response.json(); } catch {}
    return { response, result };
  };
  const answerCallback = async (id: string, text?: string) => {
    await telegram("answerCallbackQuery", { callback_query_id: id, text: text || "", show_alert: Boolean(text) });
  };
  const getBotQueueCounts = async () => {
    const base = () => db.from("news_items").select("id", { count: "exact", head: true })
      .eq("published", false).in("source_type", ["telegram", "website"]).neq("review_status", "rejected");
    const [allResult, scheduledResult] = await Promise.all([
      base(),
      base().not("scheduled_at", "is", null),
    ]);
    return {
      total: allResult.count || 0,
      scheduled: scheduledResult.count || 0,
      waiting: Math.max(0, (allResult.count || 0) - (scheduledResult.count || 0)),
      error: allResult.error || scheduledResult.error,
    };
  };

  const showBotSettings = async (chatId: number | string, messageId?: number) => {
    const [{ data: settings, error }, counts] = await Promise.all([
      db.from("bot_settings").select("channel_username,auto_publish,schedule_interval_minutes,queue_limit")
        .eq("id", "main").maybeSingle(),
      getBotQueueCounts(),
    ]);
    if (error || !settings || counts.error) {
      await telegram("sendMessage", { chat_id: chatId, text: "خواندن تنظیمات ربات یا صف ناموفق بود. کمی بعد دوباره تلاش کنید." });
      return;
    }
    const auto = settings.auto_publish === true;
    const panelText = [
      "⚙️ تنظیمات ربات خبر رادین",
      "",
      "📣 کانال مقصد: " + String(settings.channel_username || "@radinnews"),
      "📬 پست‌های در صف: " + counts.total + " | زمان‌بندی‌شده: " + counts.scheduled + " | بدون زمان: " + counts.waiting,
      "🕒 فاصلهٔ ارسال: هر " + settings.schedule_interval_minutes + " دقیقه",
      "📦 سقف چیدن صف در هر نوبت: " + settings.queue_limit + " پست",
      "🤖 ارسال خودکار: " + (auto ? "روشن" : "خاموش"),
      "✅ خبرهای زمان‌دار فقط با فعال‌بودن ارسال خودکار منتشر می‌شوند.",
      "برای تغییر کانال از دستور /channel @username استفاده کنید.",
    ].join("\n");
    const reply_markup = { inline_keyboard: [
      [{ text: auto ? "⏸ خاموش‌کردن ارسال خودکار" : "▶️ روشن‌کردن ارسال خودکار", callback_data: "botsettings:auto" }],
      [{ text: "🕒 تنظیم فاصلهٔ زمان‌بندی", callback_data: "botsettings:schedule" }],
      [{ text: "📦 تنظیم تعداد صف", callback_data: "botsettings:queue" }],
      [{ text: "📨 چیدن صف خبرهای آماده", callback_data: "botsettings:fill_queue" }],
      [{ text: "📣 راهنمای تغییر کانال", callback_data: "botsettings:channel" }],
      [{ text: "🔄 تازه‌سازی", callback_data: "botsettings:refresh" }],
    ] };
    if (messageId) {
      await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: panelText, reply_markup, disable_web_page_preview: true });
    } else {
      await telegram("sendMessage", { chat_id: chatId, text: panelText, reply_markup, disable_web_page_preview: true });
    }
  };

  const showScheduleSettings = async (chatId: number | string, messageId: number, userId: string) => {
    const { data: settings, error } = await db.from("bot_settings")
      .select("schedule_interval_minutes").eq("id", "main").maybeSingle();
    if (error || !settings) {
      await telegram("sendMessage", { chat_id: chatId, text: "خواندن زمان‌بندی ناموفق بود." });
      return;
    }
    const current = Number(settings.schedule_interval_minutes || 60);
    const panelText = [
      "🕒 تنظیم زمان‌بندی ارسال",
      "",
      "فاصلهٔ فعلی بین دو پست: " + current + " دقیقه",
      "با «چیدن صف خبرهای آماده»، خبرها از فاصلهٔ انتخاب‌شده به بعد با همین فاصله پشت‌سرهم زمان‌بندی می‌شوند.",
      "زمان‌ها بر اساس منطقهٔ زمانی تهران هستند.",
    ].join("\n");
    const intervals = [15, 30, 60, 120];
    const keyboard = intervals.map(minutes => [{
      text: (minutes === current ? "✅ " : "") + minutes + " دقیقه",
      callback_data: "botsettings:interval:" + minutes,
    }]);
    keyboard.push([{ text: "↩️ بازگشت به تنظیمات ربات", callback_data: "botsettings:refresh" }]);
    await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: panelText, reply_markup: { inline_keyboard: keyboard } });
  };

  const showQueueSettings = async (chatId: number | string, messageId: number) => {
    const { data: settings, error } = await db.from("bot_settings")
      .select("queue_limit").eq("id", "main").maybeSingle();
    if (error || !settings) {
      await telegram("sendMessage", { chat_id: chatId, text: "خواندن تعداد صف ناموفق بود." });
      return;
    }
    const current = Number(settings.queue_limit || 10);
    const panelText = [
      "📦 تنظیم تعداد پست‌های صف",
      "",
      "در هر بار «چیدن صف خبرهای آماده»، حداکثر " + current + " خبر آماده زمان‌بندی می‌شود.",
      "تعداد خبرهای فعلی در صف و زمان‌دار در صفحهٔ اصلی /settings دیده می‌شود.",
    ].join("\n");
    const limits = [5, 10, 20, 30];
    const keyboard = limits.map(limit => [{
      text: (limit === current ? "✅ " : "") + limit + " پست",
      callback_data: "botsettings:queue_limit:" + limit,
    }]);
    keyboard.push([{ text: "📨 چیدن صف خبرهای آماده", callback_data: "botsettings:fill_queue" }]);
    keyboard.push([{ text: "↩️ بازگشت به تنظیمات ربات", callback_data: "botsettings:refresh" }]);
    await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: panelText, reply_markup: { inline_keyboard: keyboard } });
  };

  const fillBotQueue = async (userId: string) => {
    const { data: settings, error: settingsError } = await db.from("bot_settings")
      .select("auto_publish,schedule_interval_minutes,queue_limit").eq("id", "main").maybeSingle();
    if (settingsError || !settings) return { ok: false, message: "تنظیمات صف خوانده نشد." };
    if (settings.auto_publish !== true) return { ok: false, message: "ابتدا ارسال خودکار را روشن کنید؛ صف تا قبل از آن ارسال نمی‌شود." };

    const { data: candidates, error } = await db.from("news_items")
      .select("id,title,rewritten_title,source_type,graphic_image_url,original_image_url")
      .eq("published", false).eq("review_status", "pending").is("scheduled_at", null)
      .in("source_type", ["telegram", "website"])
      .not("graphic_image_url", "is", null).not("original_image_url", "is", null)
      .order("pub_date", { ascending: true }).limit(200);
    if (error) return { ok: false, message: "دریافت خبرهای آماده ناموفق بود." };
    const ready = (candidates || []).filter((item: any) =>
      /^https?:\/\//i.test(String(item.graphic_image_url || "")) &&
      /^https?:\/\//i.test(String(item.original_image_url || "")) &&
      (item.source_type !== "telegram" || Boolean(String(item.rewritten_title || "").trim()))
    ).slice(0, Number(settings.queue_limit || 10));
    if (!ready.length) return { ok: true, count: 0, message: "خبر آماده‌ای برای چیدن صف پیدا نشد." };

    const { data: latest } = await db.from("news_items").select("scheduled_at")
      .eq("published", false).not("scheduled_at", "is", null)
      .order("scheduled_at", { ascending: false }).limit(1).maybeSingle();
    const intervalMs = Number(settings.schedule_interval_minutes || 60) * 60 * 1000;
    const latestTime = latest?.scheduled_at ? Date.parse(latest.scheduled_at) : 0;
    let cursor = Math.max(Date.now(), Number.isFinite(latestTime) ? latestTime : 0);
    const planned: string[] = [];
    for (const item of ready) {
      cursor += intervalMs;
      const scheduledAt = new Date(cursor).toISOString();
      const { data: changed, error: updateError } = await db.from("news_items")
        .update({ scheduled_at: scheduledAt, review_status: "approved", updated_at: new Date().toISOString() })
        .eq("id", item.id).eq("published", false).eq("review_status", "pending").is("scheduled_at", null)
        .select("id").maybeSingle();
      if (updateError || !changed) continue;
      await db.from("bot_activity").insert({
        event_type: "scheduled", item_id: item.id, actor: "telegram:" + userId,
        details: { title: item.rewritten_title || item.title, scheduled_at: scheduledAt, source: "bot_queue" },
      });
      planned.push(new Intl.DateTimeFormat("fa-IR", {
        dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran",
      }).format(new Date(scheduledAt)));
    }
    return {
      ok: true, count: planned.length,
      message: planned.length
        ? "✅ تعداد " + planned.length + " پست وارد صف زمان‌بندی شد.\nزمان ارسال‌ها به‌ترتیب:\n" + planned.join("\n")
        : "خبر آماده‌ای برای چیدن صف پیدا نشد.",
    };
  };

  const callback = update.callback_query;
  if (callback) {
    const userId = String(callback.from?.id ?? "");
    const data = String(callback.data ?? "");
    if (!adminIds.includes(userId)) {
      await answerCallback(String(callback.id), "این عملیات فقط برای مدیر ربات در دسترس است.");
      return json({ ok: true });
    }
    if (data.startsWith("botsettings:")) {
      const chat = callback.message?.chat?.id;
      const messageId = callback.message?.message_id;
      if (data === "botsettings:refresh") {
        await answerCallback(String(callback.id));
        await showBotSettings(chat, messageId);
        return json({ ok: true });
      }
      if (data === "botsettings:schedule") {
        await answerCallback(String(callback.id));
        await showScheduleSettings(chat, messageId, userId);
        return json({ ok: true });
      }
      if (data === "botsettings:queue") {
        await answerCallback(String(callback.id));
        await showQueueSettings(chat, messageId);
        return json({ ok: true });
      }
      const intervalMatch = data.match(/^botsettings:interval:(15|30|60|120)$/);
      if (intervalMatch) {
        const minutes = Number(intervalMatch[1]);
        const { error } = await db.from("bot_settings").update({
          schedule_interval_minutes: minutes, updated_at: new Date().toISOString(), updated_by: "telegram:" + userId,
        }).eq("id", "main");
        if (error) {
          await answerCallback(String(callback.id), "ذخیره فاصلهٔ زمان‌بندی ناموفق بود.");
          return json({ ok: true });
        }
        await db.from("bot_activity").insert({
          event_type: "settings_changed", actor: "telegram:" + userId,
          details: { setting: "schedule_interval_minutes", value: minutes },
        });
        await answerCallback(String(callback.id), "فاصلهٔ ارسال به " + minutes + " دقیقه تغییر کرد.");
        await showScheduleSettings(chat, messageId, userId);
        return json({ ok: true });
      }
      const limitMatch = data.match(/^botsettings:queue_limit:(5|10|20|30)$/);
      if (limitMatch) {
        const limit = Number(limitMatch[1]);
        const { error } = await db.from("bot_settings").update({
          queue_limit: limit, updated_at: new Date().toISOString(), updated_by: "telegram:" + userId,
        }).eq("id", "main");
        if (error) {
          await answerCallback(String(callback.id), "ذخیره تعداد صف ناموفق بود.");
          return json({ ok: true });
        }
        await db.from("bot_activity").insert({
          event_type: "settings_changed", actor: "telegram:" + userId,
          details: { setting: "queue_limit", value: limit },
        });
        await answerCallback(String(callback.id), "تعداد پست در هر نوبت به " + limit + " تغییر کرد.");
        await showQueueSettings(chat, messageId);
        return json({ ok: true });
      }
      if (data === "botsettings:fill_queue") {
        await answerCallback(String(callback.id), "در حال چیدن صف...");
        const result = await fillBotQueue(userId);
        await telegram("sendMessage", { chat_id: chat, text: result.message });
        await showBotSettings(chat, messageId);
        return json({ ok: true });
      }
      if (data === "botsettings:channel") {
        await answerCallback(String(callback.id));
        await telegram("sendMessage", { chat_id: chat, text: "برای تغییر کانال مقصد، نام کاربری کانال را با این دستور بفرستید:\n/channel @radinnews\n\nربات باید در کانال مقصد دسترسی ارسال داشته باشد." });
        return json({ ok: true });
      }
      if (data === "botsettings:auto") {
        const { data: current, error: readError } = await db.from("bot_settings").select("auto_publish").eq("id", "main").maybeSingle();
        if (readError || !current) {
          await answerCallback(String(callback.id), "تنظیمات خوانده نشد.");
          return json({ ok: true });
        }
        const next = current.auto_publish !== true;
        const { error } = await db.from("bot_settings").update({
          auto_publish: next, updated_at: new Date().toISOString(), updated_by: "telegram:" + userId,
        }).eq("id", "main");
        if (error) {
          await answerCallback(String(callback.id), "ذخیره تنظیمات ناموفق بود.");
          return json({ ok: true });
        }
        await db.from("bot_activity").insert({
          event_type: "settings_changed", actor: "telegram:" + userId,
          details: { setting: "auto_publish", value: next },
        });
        await answerCallback(String(callback.id), next ? "انتشار زمان‌بندی‌شده روشن شد." : "انتشار زمان‌بندی‌شده خاموش شد.");
        await showBotSettings(chat, messageId);
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), "گزینهٔ تنظیمات شناخته نشد.");
      return json({ ok: true });
    }
    const match = data.match(/^(publish|reject):([0-9a-f-]{36})$/i);
    if (!match) {
      await answerCallback(String(callback.id), "درخواست نامعتبر است.");
      return json({ ok: true });
    }
    const action = match[1];
    const itemId = match[2];
    if (action === "reject") {
      const { data: changed, error } = await db.from("news_items")
        .update({ review_status: "rejected", published: false, updated_at: new Date().toISOString() })
        .eq("id", itemId).eq("published", false).select("id").maybeSingle();
      if (error || !changed) {
        await answerCallback(String(callback.id), "خبر پیدا نشد یا قبلاً منتشر شده است.");
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), "خبر رد شد.");
      await db.from("bot_activity").insert({event_type:"rejected",item_id:itemId,actor:"telegram",details:{title:"رد خبر از طریق تلگرام"}});
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message?.chat?.id, message_id: callback.message?.message_id, reply_markup: { inline_keyboard: [] },
      });
      await telegram("sendMessage", { chat_id: callback.message?.chat?.id, text: "🗑 خبر رد شد و در کانال منتشر نمی‌شود." });
      return json({ ok: true });
    }

    const publishResponse = await fetch(supabaseUrl + "/functions/v1/radin-publish-news", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": anonKey,
        "x-radin-telegram-secret": webhookSecret,
      },
      body: JSON.stringify({ id: itemId, action: "publish" }),
    });
    let publishResult: any = {};
    try { publishResult = await publishResponse.json(); } catch {}
    if (!publishResponse.ok || !publishResult.ok) {
      const reason = String(publishResult.error || "انتشار انجام نشد");
      await answerCallback(String(callback.id), reason.slice(0, 180));
      return json({ ok: true });
    }
    await answerCallback(String(callback.id), "در کانال منتشر شد.");
    await telegram("editMessageReplyMarkup", {
      chat_id: callback.message?.chat?.id, message_id: callback.message?.message_id, reply_markup: { inline_keyboard: [] },
    });
    await telegram("sendMessage", {
      chat_id: callback.message?.chat?.id,
      text: "✅ خبر با تصویر گرافیکی در کانال منتشر شد.\nشناسه پیام: " + String(publishResult.message_id || "نامشخص"),
    });
    return json({ ok: true });
  }

  const message = update.message ?? update.edited_message;
  if (!message?.chat?.id) return json({ ok: true });
  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? "");
  const isAdmin = adminIds.includes(userId);
  const messageText = String(message.text ?? message.caption ?? "").trim();
  const videoMedia = message.video || null;
  const command = messageText.split(/\s+/, 1)[0].split("@", 1)[0];

  if ((command === "/testpublish") && isAdmin) {
    const testText = "🧪 پیام آزمایشی ربات خبر رادین\n\nاین پیام برای بررسی اتصال ربات به کانال منتشر شده است.\n\nپس از تأیید اتصال، این پیام را می‌توانید حذف کنید.";
    const sent = await telegram("sendMessage", { chat_id: "@radinnews", text: testText, disable_web_page_preview: true });
    const reply = sent.response.ok && sent.result.ok
      ? "✅ پیام آزمایشی با موفقیت در @radinnews منتشر شد. شناسه پیام: " + String(sent.result.result?.message_id ?? "نامشخص")
      : "❌ ارسال آزمایشی ناموفق بود. مجوز ارسال ربات در کانال را بررسی کنید.";
    await telegram("sendMessage", { chat_id: chatId, text: reply, disable_web_page_preview: true });
    return json({ ok: true });
  }
  if (command === "/start") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "به ربات خبر رادین خوش آمدید.\n\nبرای ثبت دستی، لینک خبر را بفرستید یا خبر را همراه عکس فوروارد کنید؛ فوروارد عکس یا ویدیو بدون لینک هم پذیرفته می‌شود. پس از آماده‌شدن پوستر، انتشار را خودتان تأیید می‌کنید.\n/settings — تنظیمات مدیر\n/help — راهنما",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (command === "/help") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "راهنمای ثبت دستی خبر:\n۱) لینک خبر را بفرستید، یا خبر را همراه عکس یا ویدیو فوروارد کنید؛ برای رسانهٔ فورواردشده، لینک الزامی نیست.\n۲) عنوان خبر باید در کپشن/متن باشد.\n۳) ربات پیش‌نمایش گرافیکی می‌سازد.\n۴) با دکمه «انتشار در کانال» خبر را دستی تأیید کنید.\n\nمدیر: /settings تنظیمات ربات، /channel @username تغییر کانال مقصد.\nلینک منبع در کپشن کانال درج نمی‌شود.",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (command === "/categories") {
    await telegram("sendMessage", { chat_id: chatId, text: "دسته‌بندی‌های اولیه:\n🇮🇷 ایران\n🌍 جهان\n🏛 سیاست\n💹 اقتصاد\n🚨 حوادث\n💻 فناوری و هوش مصنوعی\n⚽ ورزش\n✨ خبرهای جالب" });
    return json({ ok: true });
  }
  if (command === "/settings") {
    if (!isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "این دستور فقط برای مدیر ربات در دسترس است." });
      return json({ ok: true });
    }
    await showBotSettings(chatId);
    return json({ ok: true });
  }
  if (command === "/channel") {
    if (!isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "این دستور فقط برای مدیر ربات در دسترس است." });
      return json({ ok: true });
    }
    const rawChannel = messageText.split(/\s+/, 2)[1] || "";
    const channel = rawChannel.startsWith("@") ? rawChannel : "@" + rawChannel;
    if (!/^@[A-Za-z0-9_]{5,}$/.test(channel)) {
      await telegram("sendMessage", { chat_id: chatId, text: "نام کاربری کانال معتبر نیست. نمونه: /channel @radinnews" });
      return json({ ok: true });
    }
    const { error } = await db.from("bot_settings").update({
      channel_username: channel, updated_at: new Date().toISOString(), updated_by: "telegram:" + userId,
    }).eq("id", "main");
    if (error) {
      await telegram("sendMessage", { chat_id: chatId, text: "ذخیره کانال مقصد ناموفق بود. لطفاً دوباره تلاش کنید." });
      return json({ ok: true });
    }
    await db.from("bot_activity").insert({
      event_type: "settings_changed", actor: "telegram:" + userId,
      details: { setting: "channel_username", value: channel },
    });
    await telegram("sendMessage", { chat_id: chatId, text: "✅ کانال مقصد به " + channel + " تغییر کرد. برای دیدن وضعیت /settings را بفرستید." });
    return json({ ok: true });
  }
  if (command === "/status" && isAdmin) {
    const { data: settings } = await db.from("bot_settings")
      .select("auto_publish,schedule_interval_minutes,queue_limit").eq("id", "main").maybeSingle();
    const counts = await getBotQueueCounts();
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        "✅ وب‌هوک پاسخ‌گو است.",
        "🔐 احراز هویت مدیر فعال است.",
        "🤖 ارسال خودکار: " + (settings?.auto_publish ? "روشن" : "خاموش"),
        "🕒 فاصلهٔ زمان‌بندی: هر " + String(settings?.schedule_interval_minutes || 60) + " دقیقه",
        "📦 سقف چیدن صف: " + String(settings?.queue_limit || 10) + " پست در هر نوبت",
        "📬 پست‌های در صف: " + counts.total + " | زمان‌بندی‌شده: " + counts.scheduled,
      ].join("\n"),
    });
    return json({ ok: true });
  }

  if (!isAdmin) return json({ ok: true });
  if (!messageText && !message.photo?.length && !videoMedia) {
    await telegram("sendMessage", { chat_id: chatId, text: "لینک خبر یا خبر فورواردشده را همراه لینک بفرستید. برای راهنما /help را بزنید." });
    return json({ ok: true });
  }

  const textLink = (message.entities || message.caption_entities || []).find((entity: any) => entity.type === "text_link")?.url;
  const foundUrl = textLink || messageText.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[)\],.!؟،]+$/g, "");
  let sourceUrl: URL | null = null;
  if (foundUrl) {
    try {
      sourceUrl = new URL(String(foundUrl));
      if (!["http:", "https:"].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password ||
          sourceUrl.hostname === "localhost" || sourceUrl.hostname.endsWith(".local") ||
          sourceUrl.hostname.endsWith(".internal") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(sourceUrl.hostname) ||
          (sourceUrl.port && sourceUrl.port !== "80" && sourceUrl.port !== "443")) throw new Error("unsafe URL");
      sourceUrl.hash = "";
    } catch {
      sourceUrl = null;
    }
  }
  const manualTelegramMedia = !sourceUrl && Boolean(message.photo?.length || videoMedia);
  if (!sourceUrl && !manualTelegramMedia) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لینک پیدا نشد. لینک خبر را بفرستید، یا خبر را همراه عکس فوروارد کنید؛ فوروارد عکس بدون لینک هم پذیرفته می‌شود.",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  const forwardOrigin = message.forward_origin;
  const forwardChat = forwardOrigin?.chat || forwardOrigin?.sender_chat || message.forward_from_chat;
  const forwardMessageId = forwardOrigin?.message_id || message.forward_from_message_id;
  const forwardedFromTelegram = Boolean(forwardOrigin || message.forward_from_chat || message.forward_from || message.forward_sender_name);
  const canonicalUrl = sourceUrl
    ? sourceUrl.toString()
    : "telegram:forwarded/" + String(forwardChat?.id || chatId) + "/" + String(forwardMessageId || message.message_id || update.update_id);
  const acknowledgement = await telegram("sendMessage", {
    chat_id: chatId,
    text: "📥 خبر دریافت شد؛ در حال آماده‌سازی تصویر گرافیکی...",
    disable_web_page_preview: true,
  });
  if (!acknowledgement.response.ok || !acknowledgement.result.ok) {
    console.error("Telegram receipt acknowledgement failed", acknowledgement.response.status, acknowledgement.result?.description || "unknown");
  }
  const { data: existing } = await db.from("news_items")
    .select("id,published,review_status,graphic_image_url").eq("source_url", canonicalUrl).maybeSingle();
  if (existing?.published) {
    await telegram("sendMessage", { chat_id: chatId, text: "این لینک قبلاً در کانال منتشر شده است." });
    return json({ ok: true });
  }

  let html = "";
  let metaTitle = "";
  let metaDescription = "";
  let metaImage = "";
  let metaDate = "";
  if (sourceUrl) {
    try {
      const page = await fetch(canonicalUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { "user-agent": "Mozilla/5.0 (compatible; RadinNewsBot/1.0)", "accept": "text/html,application/xhtml+xml" },
      });
      const contentType = page.headers.get("content-type") || "";
      if (page.ok && contentType.includes("text/html")) html = (await page.text()).slice(0, 1500000);
    } catch (error) {
      console.warn("Source page fetch failed", String(error));
    }
  }
  const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const meta = (key: string) => {
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const field = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
      if (field === key.toLowerCase()) return decode(tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] || "");
    }
    return "";
  };
  metaTitle = meta("og:title") || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  metaDescription = meta("og:description") || meta("description") || meta("twitter:description");
  metaImage = meta("og:image") || meta("twitter:image") || meta("twitter:image:src");
  metaDate = meta("article:published_time") || meta("datePublished");
  try { if (metaImage && sourceUrl) metaImage = new URL(metaImage, canonicalUrl).toString(); } catch { metaImage = ""; }

  let manualText = messageText.replace(/^\/submit(?:@\w+)?\s*/i, "").replace(String(foundUrl || ""), "").trim();
  if (forwardedFromTelegram) {
    manualText = manualText
      .replace(/https?:\/\/[^\s<>]+|(?:www\.)?t\.me\/[^\s<>]+|telegram\.me\/[^\s<>]+/gi, "")
      .split(/\r?\n/)
      .filter((line: string) => !/^\s*(?:[🔗🌐📢📰]\s*)?(?:منبع(?:\s+خبر)?|لینک(?:\s+منبع)?|source|channel)\s*[:：-]/i.test(line))
      .filter(Boolean)
      .join("\n");
  }
  const manualLines = manualText.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean);
  const forwardSource = String(forwardChat?.username ? "@" + forwardChat.username : forwardChat?.title || message.forward_from?.first_name || message.forward_sender_name || "منبع تلگرامی");
  const stripSourceTagAndAdjacentEmoji = (value: string, handle: string) => {
    const username = handle.replace(/^@/, "");
    if (!/^[a-z0-9_]+$/i.test(username)) return value;
    const emoji = "(?:\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u{1F3FB}-\\u{1F3FF})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u{1F3FB}-\\u{1F3FF})?)*|\\p{Regional_Indicator}{2})";
    const tagPattern = new RegExp("(?:" + emoji + "[ \\t]*)*@" + username + "(?:[ \\t]*" + emoji + ")*", "giu");
    return value.replace(tagPattern, "");
  };
  const forwardedChannelHandle = String(forwardChat?.username || "");
  const stripForwardTrace = (value: string) => {
    let cleaned = value.replace(/https?:\/\/[^\s<>]+|(?:www\.)?t\.me\/[^\s<>]+|telegram\.me\/[^\s<>]+/gi, "");
    if (forwardedFromTelegram && forwardedChannelHandle) {
      cleaned = stripSourceTagAndAdjacentEmoji(cleaned, forwardedChannelHandle);
    }
    return cleaned
      .split(/\r?\n/)
      .filter((line: string) => !/^\s*(?:[🔗🌐📢📰]\s*)?(?:منبع(?:\s+خبر)?|لینک(?:\s+منبع)?|source|channel)\s*[:：-]/i.test(line))
      .filter(Boolean)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  const titleCandidate = manualLines[0] || metaTitle || "";
  const summaryCandidate = manualLines.slice(1).join("\n") || metaDescription || "";
  const title = (forwardedFromTelegram ? stripForwardTrace(titleCandidate) : titleCandidate).slice(0, 500);
  const summary = (forwardedFromTelegram ? stripForwardTrace(summaryCandidate) : summaryCandidate).slice(0, 5000);
  const sourceName = forwardedFromTelegram ? forwardSource : (sourceUrl?.hostname.replace(/^www\./i, "") || forwardSource);
  if (!title) {
    await telegram("sendMessage", { chat_id: chatId, text: "رسانه دریافت شد، اما عنوان خبر در کپشن نیست. لطفاً همان عکس یا ویدیو را با عنوان خبر در کپشن دوباره فوروارد کنید." });
    return json({ ok: true });
  }
  let imageUrl = metaImage;
  const videoFileId = String(videoMedia?.file_id || "").trim();

  if (!imageUrl && message.photo?.length) {
    try {
      const photo = message.photo[message.photo.length - 1];
      const fileInfo = await telegram("getFile", { file_id: photo.file_id });
      const filePath = String(fileInfo.result?.result?.file_path || "");
      if (!fileInfo.response.ok || !filePath || filePath.includes("..")) throw new Error("Telegram photo unavailable");
      const imageResponse = await fetch("https://api.telegram.org/file/bot" + botToken + "/" + filePath, { signal: AbortSignal.timeout(15000) });
      if (!imageResponse.ok) throw new Error("Could not download Telegram photo");
      const bytes = new Uint8Array(await imageResponse.arrayBuffer());
      if (bytes.length < 100 || bytes.length > 10 * 1024 * 1024) throw new Error("Photo size must be under 10 MB");
      const storagePath = "news-submissions/" + crypto.randomUUID() + ".jpg";
      const { error } = await db.storage.from("radin-graphics").upload(storagePath, bytes, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      imageUrl = db.storage.from("radin-graphics").getPublicUrl(storagePath).data.publicUrl;
    } catch (error) {
      console.error("Telegram photo handling failed", String(error));
    }
  }
  if (videoMedia?.file_id) {
    const coverCandidates = [...(videoMedia.cover || []), videoMedia.thumbnail, videoMedia.thumb].filter((x: any) => x?.file_id);
    coverCandidates.sort((a: any, b: any) => Number(a.width || 0) * Number(a.height || 0) - Number(b.width || 0) * Number(b.height || 0));
    const videoCover = coverCandidates[coverCandidates.length - 1];
    if (videoCover?.file_id) {
      try {
        const fileInfo = await telegram("getFile", { file_id: videoCover.file_id });
        const filePath = String(fileInfo.result?.result?.file_path || "");
        if (!fileInfo.response.ok || !filePath || filePath.includes("..")) throw new Error("Telegram video cover unavailable");
        const coverResponse = await fetch("https://api.telegram.org/file/bot" + botToken + "/" + filePath, { signal: AbortSignal.timeout(15000) });
        if (!coverResponse.ok) throw new Error("Could not download Telegram video cover");
        const bytes = new Uint8Array(await coverResponse.arrayBuffer());
        if (bytes.length < 100 || bytes.length > 10 * 1024 * 1024) throw new Error("Video cover size must be under 10 MB");
        const headerType = (coverResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
        const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
        const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
        const contentType = isJpeg ? "image/jpeg" : isPng ? "image/png" : isWebp ? "image/webp" : isGif ? "image/gif" : headerType;
        if (!contentType.startsWith("image/")) throw new Error("Telegram video cover is not a supported image (content type: " + (headerType || "unknown") + ")");
        const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : contentType.includes("gif") ? "gif" : "jpg";
        const storagePath = "news-submissions/" + crypto.randomUUID() + "." + extension;
        const { error } = await db.storage.from("radin-graphics").upload(storagePath, bytes, { contentType, upsert: false });
        if (error) throw error;
        imageUrl = db.storage.from("radin-graphics").getPublicUrl(storagePath).data.publicUrl;
      } catch (error) {
        console.error("Telegram video cover handling failed", String(error));
      }
    }
  }
  if (!imageUrl) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "برای ساخت پوستر، عکس یا کاور ویدیو لازم است. اگر ویدیو کاور ندارد، آن را همراه یک تصویر خبر یا با کاور دوباره فوروارد کنید.",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }

  const publishedAt = forwardedFromTelegram
    ? new Date(Number(message.date || Date.now() / 1000) * 1000).toISOString()
    : Number.isFinite(Date.parse(metaDate)) ? new Date(metaDate).toISOString()
    : new Date(Number(message.date || Date.now() / 1000) * 1000).toISOString();
  let itemId = existing?.id;
  if (!itemId) {
    const { data: inserted, error } = await db.from("news_items").insert({
      category: "عمومی",
      title,
      summary: summary || null,
      original_title: title,
      original_summary: summary || null,
      image_url: imageUrl,
      video_file_id: videoFileId || null,
      source_url: canonicalUrl,
      source_name: sourceName,
      source_type: forwardedFromTelegram ? "telegram" : (sourceUrl ? "website" : "telegram"),
      pub_date: publishedAt,
      published: false,
      review_status: "pending",
    }).select("id").single();
    if (error) {
      console.error("Manual news insert failed", error.message);
      await telegram("sendMessage", { chat_id: chatId, text: "ثبت خبر انجام نشد. لطفاً دوباره تلاش کنید." });
      return json({ ok: true });
    }
    itemId = inserted.id;
  } else {
    const { error } = await db.from("news_items").update({
      title, summary: summary || null, image_url: imageUrl, video_file_id: videoFileId || null, source_name: sourceName,
      original_title: title, original_summary: summary || null, source_type: forwardedFromTelegram ? "telegram" : (sourceUrl ? "website" : "telegram"),
      pub_date: publishedAt, review_status: "pending", graphic_image_url: null, original_image_url: null, updated_at: new Date().toISOString(),
    }).eq("id", itemId).eq("published", false);
    if (error) {
      await telegram("sendMessage", { chat_id: chatId, text: "به‌روزرسانی خبر انجام نشد. لطفاً بررسی کنید." });
      return json({ ok: true });
    }
  }

  await db.from("bot_activity").insert({event_type:"received",item_id:itemId,actor:"telegram",details:{title,source:sourceName}});
  const worker = await fetch(supabaseUrl + "/functions/v1/radin-graphic-worker", {
    method: "POST",
    headers: { "content-type": "application/json", "apikey": serviceKey, "authorization": "Bearer " + serviceKey },
    body: JSON.stringify({ item_id: itemId }),
    signal: AbortSignal.timeout(60000),
  });
  let workerResult: any = {};
  try { workerResult = await worker.json(); } catch {}
  if (!worker.ok || !workerResult.ok || !workerResult.results?.some((row: any) => row.id === itemId && row.ok)) {
    console.error("Graphic generation failed", worker.status, JSON.stringify(workerResult).slice(0, 500));
    const failedItem = (workerResult.results || []).find((row: any) => row.id === itemId);
    const headlineUnavailable = /AI headline unavailable/i.test(String(failedItem?.error || ""));
    const headlineMessage = failedItem?.ai_status === "service_busy"
      ? "مدل رایگان Gemini موقتاً شلوغ است؛ کلید ثبت شده و خبر بدون تیتر منتشر نمی‌شود. چند دقیقه بعد همین خبر را دوباره بفرست."
      : failedItem?.ai_status === "rate_limited"
      ? "سهمیهٔ درخواست رایگان Gemini فعلاً به سقف رسیده است؛ خبر بدون تیتر منتشر نمی‌شود. بعداً دوباره تلاش کن."
      : "ساخت تیتر Gemini ناموفق بود؛ خبر بدون تیتر منتشر نمی‌شود.";
    await telegram("sendMessage", { chat_id: chatId, text: headlineUnavailable
      ? headlineMessage
      : "خبر ثبت شد، اما ساخت پوستر کامل نشد. در استودیو گرافیک آن را بررسی کنید؛ انتشار انجام نشده است." });
    return json({ ok: true });
  }

  const { data: ready } = await db.from("news_items")
    .select("title,summary,category,source_name,source_type,pub_date,graphic_image_url")
    .eq("id", itemId).maybeSingle();
  if (!ready?.graphic_image_url) {
    await telegram("sendMessage", { chat_id: chatId, text: "پوستر هنوز آماده نیست؛ خبر منتشر نشده است." });
    return json({ ok: true });
  }
  await db.from("bot_activity").insert({event_type:"graphic_ready",item_id:itemId,actor:"telegram",details:{title}});
  const workerItemResult = workerResult.results.find((row: any) => row.id === itemId);
  const aiStatus = String(workerItemResult?.ai_status || "not_applicable");
  const designNote = aiStatus === "no_credits"
    ? "⚠️ بازطراحی AI انجام نشد چون اعتبار API کافی نیست؛ پوستر با قالب رادین آماده شد."
    : aiStatus === "missing_key"
    ? "⚠️ کلید API تصویر تنظیم نشده؛ پوستر با قالب رادین آماده شد."
    : aiStatus === "timeout"
    ? "⚠️ بازطراحی AI به‌موقع پاسخ نداد؛ پوستر با قالب رادین آماده شد."
    : aiStatus === "api_error"
    ? "⚠️ بازطراحی AI ناموفق بود؛ پوستر با قالب رادین آماده شد."
    : "";
  const previewText = [
    "پیش‌نمایش خبر — هنوز منتشر نشده",
    ready.title,
    ready.summary ? "\n" + ready.summary : "",
    ...(ready.source_type === "telegram" ? [] : ["\nمنبع: " + (ready.source_name || sourceName)]),
    "\nتاریخ: " + new Date(ready.pub_date || publishedAt).toLocaleDateString("fa-IR"),
  ].join("\n").slice(0, 950);
  const preview = await telegram("sendPhoto", {
    chat_id: chatId,
    photo: ready.graphic_image_url,
    caption: previewText,
    reply_markup: { inline_keyboard: [[
      { text: "✅ انتشار در کانال", callback_data: "publish:" + itemId },
      { text: "🗑 رد خبر", callback_data: "reject:" + itemId },
    ]] },
  });
  if (!preview.response.ok || !preview.result.ok) {
    console.error("Telegram preview failed", preview.response.status, preview.result?.description || "unknown");
    await telegram("sendMessage", { chat_id: chatId, text: "پوستر آماده شد، اما ارسال پیش‌نمایش در گفتگو ناموفق بود. از پنل مدیریت خبر را بررسی کنید." });
  } else {
    console.log("Manual story preview delivered", itemId, preview.result.result?.message_id || "unknown");
    await db.from("bot_activity").insert({event_type:"preview_sent",item_id:itemId,actor:"telegram",details:{preview_message_id:preview.result.result?.message_id||null,title}});
  }
  if (designNote) {
    await telegram("sendMessage", { chat_id: chatId, text: designNote, disable_web_page_preview: true });
  }
  return json({ ok: true });
});
