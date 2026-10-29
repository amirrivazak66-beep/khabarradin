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

  const callback = update.callback_query;
  if (callback) {
    const userId = String(callback.from?.id ?? "");
    const data = String(callback.data ?? "");
    if (!adminIds.includes(userId)) {
      await answerCallback(String(callback.id), "این عملیات فقط برای مدیر ربات در دسترس است.");
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
      text: "به ربات خبر رادین خوش آمدید.\n\nبرای ثبت دستی، لینک خبر را بفرستید یا خبر را همراه عکس فوروارد کنید؛ فوروارد عکس بدون لینک هم پذیرفته می‌شود. پس از آماده‌شدن پوستر، انتشار را خودتان تأیید می‌کنید.\n/help — راهنما",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (command === "/help") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "راهنمای ثبت دستی خبر:\n۱) لینک خبر را بفرستید، یا خبر را همراه عکس فوروارد کنید؛ برای فوروارد عکس، لینک الزامی نیست.\n۲) عنوان خبر باید در کپشن/متن باشد.\n۳) ربات پیش‌نمایش گرافیکی می‌سازد.\n۴) با دکمه «انتشار در کانال» خبر را دستی تأیید کنید.\n\nانتشار خودکار فعال نیست. لینک منبع در کپشن کانال درج نمی‌شود.",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (command === "/categories") {
    await telegram("sendMessage", { chat_id: chatId, text: "دسته‌بندی‌های اولیه:\n🇮🇷 ایران\n🌍 جهان\n🏛 سیاست\n💹 اقتصاد\n🚨 حوادث\n💻 فناوری و هوش مصنوعی\n⚽ ورزش\n✨ خبرهای جالب" });
    return json({ ok: true });
  }
  if (command === "/status" && isAdmin) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "✅ وب‌هوک پاسخ‌گو است.\n🔐 احراز هویت وب‌هوک فعال است.\n📰 ثبت دستی، ساخت پوستر و تأیید انتشار در دسترس مدیران است.\n🤖 انتشار خودکار خاموش است.",
    });
    return json({ ok: true });
  }

  if (!isAdmin) return json({ ok: true });
  if (!messageText && !message.photo?.length) {
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
  const manualTelegramPhoto = !sourceUrl && Boolean(message.photo?.length);
  if (!sourceUrl && !manualTelegramPhoto) {
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
    await telegram("sendMessage", { chat_id: chatId, text: "عکس دریافت شد، اما عنوان خبر در کپشن نیست. لطفاً همان عکس را با عنوان خبر در کپشن دوباره فوروارد کنید." });
    return json({ ok: true });
  }
  let imageUrl = metaImage;

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
  if (!imageUrl) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "برای اعمال قالب گرافیکی، عکس خبر لازم است. لینک صفحه‌ای بفرستید که تصویر شاخص عمومی داشته باشد، یا همان خبر را همراه عکس فوروارد کنید.",
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
      title, summary: summary || null, image_url: imageUrl, source_name: sourceName,
      original_title: title, original_summary: summary || null, source_type: forwardedFromTelegram ? "telegram" : (sourceUrl ? "website" : "telegram"),
      pub_date: publishedAt, review_status: "pending", graphic_image_url: null, original_image_url: null, updated_at: new Date().toISOString(),
    }).eq("id", itemId).eq("published", false);
    if (error) {
      await telegram("sendMessage", { chat_id: chatId, text: "به‌روزرسانی خبر انجام نشد. لطفاً بررسی کنید." });
      return json({ ok: true });
    }
  }

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
    await telegram("sendMessage", { chat_id: chatId, text: "خبر ثبت شد، اما ساخت پوستر کامل نشد. در استودیو گرافیک آن را بررسی کنید؛ انتشار انجام نشده است." });
    return json({ ok: true });
  }

  const { data: ready } = await db.from("news_items")
    .select("title,summary,category,source_name,source_type,pub_date,graphic_image_url")
    .eq("id", itemId).maybeSingle();
  if (!ready?.graphic_image_url) {
    await telegram("sendMessage", { chat_id: chatId, text: "پوستر هنوز آماده نیست؛ خبر منتشر نشده است." });
    return json({ ok: true });
  }
  const workerItemResult = workerResult.results.find((row: any) => row.id === itemId);
  const aiStatus = String(workerItemResult?.ai_status || "not_applicable");
  const designNote = aiStatus === "redesigned"
    ? "🎨 تصویر با هوش مصنوعی بازطراحی شد."
    : aiStatus === "no_credits"
    ? "⚠️ اعتبار API تصویر تمام است؛ پوستر با قالب رادین آماده شد."
    : aiStatus === "missing_key"
    ? "⚠️ کلید API تصویر تنظیم نشده؛ پوستر با قالب رادین آماده شد."
    : aiStatus === "timeout"
    ? "⚠️ هوش مصنوعی به‌موقع پاسخ نداد؛ پوستر با قالب رادین آماده شد."
    : aiStatus === "api_error"
    ? "⚠️ بازطراحی هوشمند ناموفق بود؛ پوستر با قالب رادین آماده شد."
    : "🎨 پوستر گرافیکی رادین آماده شد.";
  const previewText = [
    "پیش‌نمایش خبر — هنوز منتشر نشده",
    designNote,
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
  }
  return json({ ok: true });
});
