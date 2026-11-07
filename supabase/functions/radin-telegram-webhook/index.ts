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
    if (!response.ok || result?.ok === false) {
      console.error("Telegram API call failed", method, response.status, String(result?.description || "unknown").slice(0, 220));
    }
    return { response, result };
  };
  const mainMenuReplyMarkup = (isAdmin: boolean, trialActive = false) => {
    const canSubmit = isAdmin || trialActive;
    const keyboard: any[][] = [
      [canSubmit
        ? { text: "📨 ثبت خبر", style: "primary" }
        : { text: "🔐 ثبت‌نام و شروع آزمایشی", style: "primary" }],
    ];
    if (isAdmin) {
      keyboard.push(
        [{ text: "🗓️ صف انتشار", style: "success" }, { text: "📚 تاریخچه خبرها", style: "success" }],
        [{ text: "🤖 مصرف AI", style: "primary" }, { text: "⚙️ تنظیمات ربات", style: "success" }],
      );
    }
    keyboard.push(
      [{ text: "👤 حساب کاربری", style: "primary" }, { text: "ℹ️ راهنما و قوانین", style: "success" }],
      [{ text: "💬 پشتیبانی", style: "danger" }],
    );
    return { keyboard, resize_keyboard: true, is_persistent: true };
  };
  const answerCallback = async (id: string, text?: string) => {
    await telegram("answerCallbackQuery", { callback_query_id: id, text: text || "", show_alert: Boolean(text) });
  };
  const getTrialAccount = async (userId: string) => {
    if (!/^\d+$/.test(userId)) return null;
    const { data, error } = await db.from("telegram_trial_accounts")
      .select("telegram_user_id,chat_id,first_name,last_name,username,registration_source,consent_at,phone_verified_at,trial_started_at,trial_expires_at")
      .eq("telegram_user_id", userId).maybeSingle();
    if (error) {
      console.error("Telegram trial account lookup failed", error.message);
      return null;
    }
    return data;
  };
  const trialIsActive = (account: any, chatId?: number | string) =>
    Boolean(account?.phone_verified_at && account?.trial_expires_at &&
      Date.parse(String(account.trial_expires_at)) > Date.now() &&
      (chatId === undefined || String(account.chat_id) === String(chatId)));
  const trialExpiryLabel = (expiresAt: string) => new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "full", timeStyle: "short", timeZone: "Asia/Tehran",
  }).format(new Date(expiresAt));

  const getActiveAccessGrant = async (userId: string) => {
    if (!/^\d+$/.test(userId)) return null;
    const { data, error } = await db.from("telegram_access_grants")
      .select("id,chat_id,expires_at")
      .eq("telegram_user_id", userId).eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      console.error("Telegram timed access lookup failed", error.message);
      return null;
    }
    return data;
  };
  const accessGrantIsActive = (grant: any, chatId?: number | string) =>
    Boolean(grant?.expires_at && Date.parse(String(grant.expires_at)) > Date.now() &&
      (chatId === undefined || String(grant.chat_id) === String(chatId)));
  const sendWebAccountPanel = async (chatId: number | string) => {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "پنل امن حساب به شناسهٔ همین حساب تلگرام متصل است. برای مشاهدهٔ فعالیت‌ها یا درخواست دسترسی یک‌ساعته، دکمهٔ زیر را بزنید.",
      reply_markup: { inline_keyboard: [[{
        text: "👤 باز کردن پنل حساب",
        web_app: { url: "https://amirrivazak66-beep.github.io/newsroom/account.html" },
      }]] },
      disable_web_page_preview: true,
    });
  };
  const sendTrialConsent = async (chatId: number | string, source: "site" | "telegram") => {
    const consentText = "برای فعال‌سازی یک روز استفادهٔ آزمایشی، نام نمایشی تلگرام و شماره‌ای را که با دکمهٔ تلگرام به اشتراک می‌گذارید ثبت می‌کنیم. شمارهٔ خام ذخیره نمی‌شود؛ فقط اثر انگشت رمزنگاری‌شدهٔ آن برای جلوگیری از فعال‌سازی تکراری نگه داشته می‌شود. دورهٔ ۲۴ساعته پس از تأیید شماره آغاز می‌شود. با ادامه، با این ثبت اطلاعات موافقت می‌کنید.";
    const sent = await telegram("sendMessage", {
      chat_id: chatId,
      text: consentText,
      reply_markup: { inline_keyboard: [[{ text: "✅ موافقم و ادامه می‌دهم", callback_data: "register:consent:" + source }]] },
      disable_web_page_preview: true,
    });
    if (sent.response.ok && sent.result?.ok) {
      console.log("Telegram trial consent prompt delivered", { source, fallback: false });
      return;
    }
    const fallbackConsent = source === "site" ? "✅ موافقم و ادامه می‌دهم (سایت)" : "✅ موافقم و ادامه می‌دهم";
    const fallback = await telegram("sendMessage", {
      chat_id: chatId,
      text: consentText + "\n\nاگر دکمهٔ تأیید بالای صفحه کار نکرد، دکمهٔ پایین را بزنید.",
      reply_markup: { keyboard: [[{ text: fallbackConsent }]], resize_keyboard: true, one_time_keyboard: true },
      disable_web_page_preview: true,
    });
    console.log("Telegram trial consent fallback result", { source, ok: fallback.response.ok && fallback.result?.ok === true });
  };
  const sendTrialContactRequest = async (chatId: number | string) => {
    const sent = await telegram("sendMessage", {
      chat_id: chatId,
      text: "برای احراز هویت و فعال‌کردن دورهٔ یک‌روزه، دکمهٔ زیر را بزنید تا شمارهٔ خودتان را از طریق تلگرام تأیید کنید.",
      reply_markup: {
        keyboard: [[{ text: "📱 تأیید شماره و فعال‌سازی آزمایشی", request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: "شماره را با دکمهٔ تلگرام تأیید کنید",
      },
    });
    console.log("Telegram contact request result", { ok: sent.response.ok && sent.result?.ok === true });
  };
  const phoneFingerprint = async (phone: string) => {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(serviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(phone));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const previewKeyboard = (itemId: string, qualityStatus?: string, canPublish = true) => {
    const rows: any[] = [
      [{ text: "✏️ ویرایش تیتر", callback_data: "edit:headline:" + itemId }, { text: "📝 ویرایش کپشن", callback_data: "edit:caption:" + itemId }],
      [{ text: "🎨 ویرایش تصویر", callback_data: "edit:graphic:" + itemId }],
    ];
    if (canPublish) rows.push([{ text: "✅ انتشار در کانال", callback_data: "publish:" + itemId }, { text: "🗑 رد خبر", callback_data: "reject:" + itemId }]);
    rows.push([{ text: "📥 بسته اینستاگرام", callback_data: "insta:export:" + itemId }]);
    if (qualityStatus === "review") rows.unshift([{ text: "🔄 بازتولید پوستر", callback_data: "regenerate:" + itemId }]);
    return { inline_keyboard: rows };
  };
  const processStoryPreview = async (itemId: string, chatId: number | string) => {
    const { data: queued, error } = await db.rpc("enqueue_radin_preview", { p_item_id: itemId, p_chat_id: chatId });
    if (error || queued !== true) {
      await telegram("sendMessage", { chat_id: chatId, text: "ثبت در صف آماده‌سازی ناموفق بود؛ خبر ذخیره شده است.",
        reply_markup: { inline_keyboard: [[{ text: "🔄 تلاش دوباره", callback_data: "designposter:" + itemId }]] } });
      return;
    }
    EdgeRuntime.waitUntil(fetch(supabaseUrl + "/functions/v1/radin-preview-queue", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + serviceKey,
        "x-radin-telegram-secret": webhookSecret }, body: "{}", signal: AbortSignal.timeout(15000),
    }).then(response => { if (!response.ok) console.error("Preview wake-up failed", response.status); })
      .catch(() => console.error("Preview wake-up failed; cron will retry")));
  };
  const getBotQueueCounts = async () => {
    const base = () => db.from("news_items").select("id", { count: "exact", head: true })
      .eq("published", false).in("source_type", ["telegram", "website"]).neq("review_status", "rejected");
    const [allResult, scheduledResult, nextResult] = await Promise.all([
      base(),
      base().not("scheduled_at", "is", null),
      db.from("news_items").select("scheduled_at").eq("published", false).not("scheduled_at", "is", null)
        .order("scheduled_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    return {
      total: allResult.count || 0,
      scheduled: scheduledResult.count || 0,
      waiting: Math.max(0, (allResult.count || 0) - (scheduledResult.count || 0)),
      nextAt: nextResult.data?.scheduled_at || null,
      error: allResult.error || scheduledResult.error || nextResult.error,
    };
  };

  const showAiUsage = async (chatId: number | string, messageId: number) => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { data: events, error } = await db.from("ai_usage_events")
      .select("provider,model,task,status,estimated_cost_usd,cost_known,created_at")
      .gte("created_at", monthStart).order("created_at", { ascending: false }).limit(1000);
    if (error) {
      await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: "خواندن گزارش مصرف AI ناموفق بود." });
      return;
    }
    const rows = events || [];
    const total = rows.filter((row: any) => row.cost_known).reduce((sum: number, row: any) => sum + Number(row.estimated_cost_usd || 0), 0);
    const unknown = rows.filter((row: any) => !row.cost_known).length;
    const openAiCalls = rows.filter((row: any) => row.provider === "openai").length;
    const geminiCalls = rows.filter((row: any) => row.provider === "gemini").length;
    const groups = new Map<string, { calls: number; cost: number }>();
    for (const row of rows) {
      const key = String(row.provider) + " / " + String(row.task);
      const current = groups.get(key) || { calls: 0, cost: 0 };
      current.calls++;
      if (row.cost_known) current.cost += Number(row.estimated_cost_usd || 0);
      groups.set(key, current);
    }
    const breakdown = [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)
      .map(([key, value]) => "• " + key + ": " + value.calls + " درخواست — $" + value.cost.toFixed(6));
    const text = [
      "💳 مصرف AI از ابتدای ماه جاری (UTC)",
      "",
      "برآورد هزینهٔ OpenAI: $" + total.toFixed(6),
      "درخواست‌ها: OpenAI " + openAiCalls + " | Gemini " + geminiCalls + " (رایگان)",
      unknown ? "هزینهٔ نامشخص: " + unknown + " درخواست" : "",
      "",
      ...breakdown,
      "",
      "این رقم از usage واقعی هر درخواست و نرخ ذخیره‌شدهٔ همان زمان محاسبه شده؛ ممکن است به‌علت گردکردن با صورتحساب اختلاف جزئی داشته باشد.",
    ].filter(Boolean).join("\n").slice(0, 3900);
    await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [
      [{ text: "🔄 تازه‌سازی", callback_data: "botusage:month" }, { text: "↩️ تنظیمات ربات", callback_data: "botsettings:refresh" }],
    ] }, disable_web_page_preview: true });
  };

  const botEventLabels: Record<string,string> = {
    received:"خبر دریافت شد", graphic_ready:"پوستر آماده شد", preview_sent:"پیش‌نمایش ارسال شد",
    scheduled:"زمان‌بندی شد", schedule_reordered:"ترتیب صف تغییر کرد", schedule_cancelled:"از صف خارج شد",
    caption_edited:"کپشن ویرایش شد", headline_edited:"تیتر ویرایش شد", published:"منتشر شد",
    rejected:"رد شد", settings_changed:"تنظیمات تغییر کرد", duplicate_detected:"خبر تکراری شناسایی شد",
    graphic_failed:"خطای ساخت پوستر", publish_failed:"خطای انتشار", manual_retry:"تلاش مجدد",
    graphic_regenerated:"پوستر بازتولید شد",
  };
  const showBotActivity = async (chatId: number|string, messageId: number) => {
    const {data: events,error}=await db.from("bot_activity").select("event_type,item_id,actor,details,created_at")
      .order("created_at",{ascending:false}).limit(12);
    if(error){await telegram("editMessageText",{chat_id:chatId,message_id:messageId,text:"خواندن گزارش فعالیت ناموفق بود."});return;}
    const ids=[...new Set((events||[]).map((e:any)=>e.item_id).filter(Boolean))];
    const {data: items}=ids.length?await db.from("news_items").select("id,title,rewritten_title").in("id",ids):{data:[]};
    const titles=new Map((items||[]).map((x:any)=>[x.id,x.rewritten_title||x.title||"خبر"]));
    const rows=(events||[]).map((e:any)=>{
      const date=new Intl.DateTimeFormat("fa-IR",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Tehran"}).format(new Date(e.created_at));
      const title=titles.get(e.item_id)||e.details?.title||"";
      const reason=e.details?.reason||e.details?.headline||"";
      return "• "+(botEventLabels[e.event_type]||e.event_type)+(title?" — "+String(title).slice(0,100):"")+(reason?"\n  "+String(reason).slice(0,130):"")+"\n  "+date;
    });
    const text=["📜 فعالیت‌های اخیر ربات","",...(rows.length?rows:["هنوز فعالیتی ثبت نشده است."])].join("\n").slice(0,3900);
    await telegram("editMessageText",{chat_id:chatId,message_id:messageId,text,reply_markup:{inline_keyboard:[
      [{text:"🔄 تازه‌سازی",callback_data:"botactivity:refresh"},{text:"↩️ تنظیمات ربات",callback_data:"botsettings:refresh"}],
    ]},disable_web_page_preview:true});
  };
  const showBotErrors = async (chatId: number|string, messageId: number) => {
    const {data: events,error}=await db.from("bot_activity").select("event_type,item_id,details,created_at")
      .in("event_type",["graphic_failed","publish_failed"]).order("created_at",{ascending:false}).limit(8);
    if(error){await telegram("editMessageText",{chat_id:chatId,message_id:messageId,text:"خواندن خطاهای اخیر ناموفق بود."});return;}
    const ids=[...new Set((events||[]).map((e:any)=>e.item_id).filter(Boolean))];
    const {data: items}=ids.length?await db.from("news_items").select("id,title,rewritten_title,published,review_status,graphic_image_url").in("id",ids):{data:[]};
    const itemMap=new Map((items||[]).map((x:any)=>[x.id,x]));
    const keyboard:any[][]=[];
    const lines=["🚨 خطاهای اخیر ربات",""];
    for(const e of events||[]){
      const item=itemMap.get(e.item_id);
      const date=new Intl.DateTimeFormat("fa-IR",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Tehran"}).format(new Date(e.created_at));
      lines.push("• "+(e.event_type==="graphic_failed"?"ساخت پوستر":"انتشار")+" — "+String(item?.rewritten_title||item?.title||"خبر حذف‌شده").slice(0,90));
      lines.push("  "+String(e.details?.reason||"علت ثبت نشده").slice(0,180)+"\n  "+date);
      if(item&&!item.published&&item.review_status!=="rejected"){
        const action=e.event_type==="graphic_failed"?"graphic":"publish";
        keyboard.push([{text:action==="graphic"?"🔄 تلاش مجدد ساخت پوستر":"🔄 تلاش مجدد انتشار",callback_data:"boterrors:retry:"+item.id+":"+action}]);
      }
    }
    if(!events?.length)lines.push("خطای ثبت‌شده‌ای وجود ندارد.");
    keyboard.push([{text:"🔄 تازه‌سازی",callback_data:"boterrors:refresh"},{text:"↩️ تنظیمات ربات",callback_data:"botsettings:refresh"}]);
    await telegram("editMessageText",{chat_id:chatId,message_id:messageId,text:lines.join("\n").slice(0,3900),reply_markup:{inline_keyboard:keyboard},disable_web_page_preview:true});
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
    const nextTime = counts.nextAt ? new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(new Date(counts.nextAt)) : "ندارد";
    const panelText = [
      "⚙️ تنظیمات ربات خبر رادین",
      "",
      "📣 کانال مقصد: " + String(settings.channel_username || "@radinnews"),
      "📬 پست‌های در صف: " + counts.total + " | زمان‌بندی‌شده: " + counts.scheduled + " | بدون زمان: " + counts.waiting,
      "⏭ زمان ارسال بعدی: " + nextTime,
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
      [{ text: "📋 مشاهده و مدیریت صف زمان‌بندی", callback_data: "botqueue:refresh" }],
      [{ text: "💳 گزارش مصرف AI", callback_data: "botusage:month" }],
      [{ text: "🚨 خطاهای اخیر", callback_data: "boterrors:refresh" }, { text: "📜 گزارش فعالیت", callback_data: "botactivity:refresh" }],
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

  const showScheduledQueue = async (chatId: number | string, messageId?: number) => {
    const { data: items, error } = await db.from("news_items")
      .select("id,title,rewritten_title,scheduled_at,review_status")
      .eq("published", false).not("scheduled_at", "is", null)
      .order("scheduled_at", { ascending: true }).limit(8);
    if (error) {
      await telegram("sendMessage", { chat_id: chatId, text: "خواندن صف زمان‌بندی ناموفق بود." });
      return;
    }
    const list = items || [];
    const lines = ["📋 صف ارسال زمان‌بندی‌شده", ""];
    const keyboard: any[] = [];
    list.forEach((item: any, index: number) => {
      const title = String(item.rewritten_title || item.title || "خبر بدون عنوان").replace(/\s+/g, " ").slice(0, 95);
      const when = new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(new Date(item.scheduled_at));
      lines.push((index + 1) + ") " + when + " — " + title);
      const actions: any[] = [];
      actions.push({ text: "لغو", callback_data: "botqueue:cancel:" + item.id });
      keyboard.push(actions);
    });
    if (!list.length) lines.push("صف زمان‌بندی‌شده خالی است.");
    const { data: waiting } = await db.from("radin_preview_jobs")
      .select("item_id,state,news_items(title)").in("state", ["queued", "processing", "failed"])
      .order("requested_at", { ascending: false }).limit(8);
    if (waiting?.length) {
      lines.push("", "⏳ صف آماده‌سازی — جدیدترین خبر اول:");
      for (const job of waiting) {
        const status = job.state === "processing" ? "در حال ساخت" : job.state === "failed" ? "نیاز به تلاش مجدد" : "در انتظار ساخت";
        lines.push(status + " — " + String(job.news_items?.title || "خبر دریافتی").slice(0, 70));
        if (job.state === "failed") keyboard.push([{ text: "🔄 تلاش دوباره", callback_data: "designposter:" + job.item_id }]);
      }
    }
    const { data: readyWaiting } = await db.from("news_items")
      .select("title").eq("published", false).eq("review_status", "pending").is("scheduled_at", null)
      .in("source_type", ["telegram", "website"]).in("telegram_chat_id", adminIds)
      .not("graphic_image_url", "is", null).not("telegram_preview_message_id", "is", null)
      .order("created_at", { ascending: false }).limit(5);
    if (readyWaiting?.length) {
      lines.push("", "✅ آماده و منتظر روشن‌شدن صف یا ظرفیت:");
      for (const item of readyWaiting) lines.push(String(item.title || "خبر دریافتی").slice(0, 70));
    }
    lines.push("", "ترتیب خودکار بر اساس جدیدترین دریافت است؛ خبرهای نزدیک زمان انتشار جابه‌جا نمی‌شوند.");
    keyboard.push([{ text: "🔄 تازه‌سازی", callback_data: "botqueue:refresh" }, { text: "↩️ تنظیمات ربات", callback_data: "botsettings:refresh" }]);
    const params: any = { chat_id: chatId, text: lines.join("\n").slice(0, 3900), reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true };
    if (messageId) {
      await telegram("editMessageText", { ...params, message_id: messageId });
    } else {
      await telegram("sendMessage", params);
    }
  };

  const fillBotQueue = async (_userId: string) => {
    const { data: count, error } = await db.rpc("fill_radin_publish_queue", { p_admin_chat_ids: adminIds });
    return error ? { ok: false, message: "چیدن صف ناموفق بود؛ خبرها ذخیره هستند." }
      : { ok: true, count: count || 0, message: count ? "✅ " + count + " خبر آماده وارد صف شد؛ ترتیب خبرهای جدید از آخرین دریافت است."
        : "خبر آمادهٔ تازه‌ای وارد صف نشد؛ خبرهای در حال آماده‌سازی پس از تکمیل وارد صف می‌شوند." };
  };

  const callback = update.callback_query;
  if (callback) {
    const userId = String(callback.from?.id ?? "");
    const data = String(callback.data ?? "");
    const consentMatch = data.match(/^register:consent:(site|telegram)$/);
    if (consentMatch) {
      const chat = callback.message?.chat;
      const chatId = chat?.id;
      if (adminIds.includes(userId)) {
        await answerCallback(String(callback.id), "حساب مدیر نیازی به ثبت‌نام آزمایشی ندارد.");
        return json({ ok: true });
      }
      if (!chatId || chat?.type !== "private" || String(chatId) !== userId) {
        await answerCallback(String(callback.id), "ثبت‌نام فقط در گفت‌وگوی خصوصی با ربات انجام می‌شود.");
        return json({ ok: true });
      }
      const existingAccount = await getTrialAccount(userId);
      if (existingAccount?.phone_verified_at) {
        await answerCallback(String(callback.id), "برای این حساب قبلاً دورهٔ آزمایشی فعال شده است.");
        const status = trialIsActive(existingAccount, chatId)
          ? "⏱ دورهٔ آزمایشی شما فعال است و تا " + trialExpiryLabel(String(existingAccount.trial_expires_at)) + " ادامه دارد."
          : "⏳ دورهٔ آزمایشی این حساب قبلاً استفاده شده و امکان فعال‌سازی دوباره ندارد.";
        await telegram("sendMessage", { chat_id: chatId, text: status });
        return json({ ok: true });
      }
      const registration = {
        telegram_user_id: Number(userId), chat_id: Number(chatId),
        first_name: String(callback.from?.first_name || "").slice(0, 128) || null,
        last_name: String(callback.from?.last_name || "").slice(0, 128) || null,
        username: String(callback.from?.username || "").slice(0, 64) || null,
        registration_source: consentMatch[1],
        consent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const saveResult = existingAccount
        ? await db.from("telegram_trial_accounts").update(registration)
            .eq("telegram_user_id", Number(userId)).is("phone_verified_at", null)
        : await db.from("telegram_trial_accounts").insert(registration);
      if (saveResult.error) {
        console.error("Telegram trial consent could not be stored", saveResult.error.message);
        await answerCallback(String(callback.id), "ثبت موافقت انجام نشد؛ چند لحظه بعد دوباره تلاش کنید.");
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), "موافقت ثبت شد.");
      await sendTrialContactRequest(chatId);
      return json({ ok: true });
    }
    const isAdminCallback = adminIds.includes(userId);
    const callbackAccount = isAdminCallback ? null : await getTrialAccount(userId);
    const callbackTrialActive = trialIsActive(callbackAccount, callback.message?.chat?.id);
    if (!isAdminCallback) {
      const chat = callback.message?.chat;
      const itemMatch = data.match(/^(?:processnews:([0-9a-f-]{36}):(ar|en|none)|designposter:([0-9a-f-]{36})|insta:export:([0-9a-f-]{36})|regenerate:([0-9a-f-]{36})|edit:(?:headline|caption|graphic):([0-9a-f-]{36}))$/i);
      const itemId = itemMatch?.slice(1).find(Boolean);
      if (!callbackTrialActive || chat?.type !== "private" || String(chat?.id || "") !== userId || !itemId) {
        await answerCallback(String(callback.id), "این عملیات فقط برای کاربر ثبت‌نام‌شده و در دورهٔ آزمایشی فعال است.");
        return json({ ok: true });
      }
      const { data: ownedItem, error: ownershipError } = await db.from("news_items")
        .select("id").eq("id", itemId).eq("telegram_chat_id", Number(chat.id)).maybeSingle();
      if (ownershipError || !ownedItem) {
        await answerCallback(String(callback.id), "این خبر به حساب شما تعلق ندارد.");
        return json({ ok: true });
      }
    }
    const processChoice=data.match(/^processnews:([0-9a-f-]{36}):(ar|en|none)$/i);
    if(processChoice){
      const [,itemId,language]=processChoice;
      const chatId=callback.message?.chat?.id;
      await answerCallback(String(callback.id),"زبان ثبت شد؛ ابتدا متن آماده می‌شود.");
      await telegram("editMessageReplyMarkup",{chat_id:chatId,message_id:callback.message?.message_id,reply_markup:{inline_keyboard:[]}});
      const {error:optionError}=await db.from("news_items").update({telegram_translation_language:language==="none"?null:language,telegram_generate_graphic:true,telegram_preview_message_id:null}).eq("id",itemId).eq("published",false);
      if(optionError){await telegram("sendMessage",{chat_id:chatId,text:"ذخیره زبان ناموفق بود؛ خبر را دوباره فوروارد کنید."});return json({ok:true});}
      await processStoryPreview(itemId,chatId);
      return json({ok:true});
    }
    const designChoice=data.match(/^designposter:([0-9a-f-]{36})$/i);
    if(designChoice){
      const itemId=designChoice[1],chatId=callback.message?.chat?.id,messageId=callback.message?.message_id;
      const {data:item,error}=await db.from("news_items").select("id,published,review_status,telegram_chat_id").eq("id",itemId).maybeSingle();
      if(error||!item||item.published||item.review_status==="rejected"){await answerCallback(String(callback.id),"این خبر دیگر قابل طراحی نیست.");return json({ok:true});}
      await answerCallback(String(callback.id),"درخواست طراحی ثبت شد.");
      await telegram("editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}});
      await db.from("news_items").update({telegram_generate_graphic:true,telegram_preview_message_id:null,graphic_image_url:null,graphic_quality_status:null,graphic_quality_score:null,graphic_quality_notes:null,updated_at:new Date().toISOString()}).eq("id",itemId).eq("published",false);
      await processStoryPreview(itemId,chatId);
      return json({ok:true});
    }
    if (data.startsWith("insta:export:")) {
      const itemMatch = data.match(/^insta:export:([0-9a-f-]{36})$/i);
      const chatId = callback.message?.chat?.id;
      if (!itemMatch || !chatId) {
        await answerCallback(String(callback.id), "درخواست بسته اینستاگرام معتبر نیست.");
        return json({ ok: true });
      }

      const itemId = itemMatch[1];
      await answerCallback(String(callback.id), "در حال آماده‌سازی فایل‌های اینستاگرام...");
      try {
        const exportResponse = await fetch(supabaseUrl + "/functions/v1/radin-instagram-export", {
          method: "POST",
          headers: { "content-type": "application/json", "x-radin-telegram-secret": webhookSecret },
          body: JSON.stringify({ id: itemId }),
          signal: AbortSignal.timeout(90000),
        });
        const exported: any = await exportResponse.json().catch(() => ({}));
        if (!exportResponse.ok || !exported.ok) {
          throw new Error(String(exported.error || "ساخت فایل‌ها ناموفق بود."));
        }
        if (!String(exported.caption || "").trim()) throw new Error("کپشن آماده پیدا نشد.");

        const storageHost = new URL(supabaseUrl).host;
        const sendAssetDocument = async (assetUrlValue: unknown, baseName: string, label: string) => {
          let assetUrl: URL;
          try { assetUrl = new URL(String(assetUrlValue || "")); }
          catch { throw new Error("نشانی یکی از فایل‌های خروجی معتبر نیست."); }
          if (assetUrl.host !== storageHost || !assetUrl.pathname.includes("/storage/v1/object/public/radin-graphics/")) {
            throw new Error("فایل خروجی در فضای ذخیره‌سازی رادین پیدا نشد.");
          }
          const fileResponse = await fetch(assetUrl, { signal: AbortSignal.timeout(45000) });
          if (!fileResponse.ok) throw new Error("دریافت فایل خروجی ناموفق بود.");
          const imageType = (fileResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
          if (!["image/png", "image/jpeg", "image/webp"].includes(imageType)) {
            throw new Error("فرمت فایل خروجی پشتیبانی نمی‌شود.");
          }
          const bytes = new Uint8Array(await fileResponse.arrayBuffer());
          if (!bytes.length || bytes.length > 49 * 1024 * 1024) throw new Error("حجم فایل خروجی از حد ارسال تلگرام بیشتر است.");
          const extension = imageType === "image/jpeg" ? "jpg" : imageType === "image/webp" ? "webp" : "png";
          const form = new FormData();
          form.set("chat_id", String(chatId));
          form.set("document", new Blob([bytes], { type: imageType }), baseName + "." + extension);
          form.set("caption", label);
          const sent = await fetch("https://api.telegram.org/bot" + botToken + "/sendDocument", {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(60000),
          });
          const telegramResult: any = await sent.json().catch(() => ({}));
          if (!sent.ok || !telegramResult.ok) {
            throw new Error(String(telegramResult.description || "ارسال فایل به تلگرام ناموفق بود."));
          }
        };

        await sendAssetDocument(exported.feed_image_url, "radin-instagram-feed-1080x1350", "پست فید اینستاگرام • 1080×1350 • نسبت 4:5");
        await sendAssetDocument(exported.story_image_url, "radin-instagram-story-1080x1920", "استوری اینستاگرام • 1080×1920 • نسبت 9:16");
        const captionSent = await telegram("sendMessage", {
          chat_id: chatId,
          text: "کپشن آماده اینستاگرام؛ برای کپی:\n\n" + String(exported.caption).slice(0, 3000),
          disable_web_page_preview: true,
        });
        if (!captionSent.response.ok || !captionSent.result.ok) {
          throw new Error("ارسال کپشن به تلگرام ناموفق بود.");
        }
        await db.from("bot_activity").insert({
          event_type: "instagram_assets_prepared",
          item_id: itemId,
          actor: "telegram:" + userId,
          details: { feed: "1080x1350", story: "1080x1920" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "خطای نامشخص";
        console.error("Manual Instagram export failed", { itemId, error: message });
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "❌ آماده‌سازی یا ارسال بسته اینستاگرام ناموفق بود: " + message.slice(0, 300),
          disable_web_page_preview: true,
        });
      }
      return json({ ok: true });
    }
    if (data.startsWith("boterrors:")) {
      const chat=callback.message?.chat?.id, messageId=callback.message?.message_id;
      if(data==="boterrors:refresh"){await answerCallback(String(callback.id));await showBotErrors(chat,messageId);return json({ok:true});}
      const match=data.match(/^boterrors:retry:([0-9a-f-]{36}):(graphic|publish)$/i);
      if(!match){await answerCallback(String(callback.id),"درخواست تلاش مجدد نامعتبر است.");return json({ok:true});}
      const [,itemId,action]=match;
      const {data:item}=await db.from("news_items").select("id,title,rewritten_title,published,review_status,graphic_image_url,telegram_chat_id").eq("id",itemId).maybeSingle();
      if(!item||item.published||item.review_status==="rejected"){await answerCallback(String(callback.id),"این خبر قابل تلاش مجدد نیست.");return json({ok:true});}
      if(action==="graphic"){
        const {error}=await db.from("news_items").update({graphic_image_url:null,graphic_quality_status:null,graphic_quality_score:null,graphic_quality_notes:null,review_status:"pending",updated_at:new Date().toISOString()}).eq("id",itemId).eq("published",false);
        if(error){await answerCallback(String(callback.id),"بازگرداندن خبر به صف ساخت ناموفق بود.");return json({ok:true});}
        await db.from("bot_activity").insert({event_type:"manual_retry",item_id:itemId,actor:"telegram:"+userId,details:{task:"graphic",title:item.rewritten_title||item.title}});
        await answerCallback(String(callback.id),"خبر برای ساخت دوباره در صف قرار گرفت.");
        await telegram("sendMessage",{chat_id:chat,text:"✅ خبر به صف ساخت پوستر برگشت. پردازش خودکار آن را برمی‌دارد و پیش‌نمایش را می‌فرستد."});
      }else{
        await answerCallback(String(callback.id),"در حال تلاش مجدد انتشار...");
        const response=await fetch(supabaseUrl+"/functions/v1/radin-publish-news",{method:"POST",headers:{"content-type":"application/json","apikey":anonKey,"x-radin-telegram-secret":webhookSecret},body:JSON.stringify({id:itemId,action:"publish"})});
        const result:any=await response.json().catch(()=>({}));
        if(!response.ok||!result.ok){await db.from("bot_activity").insert({event_type:"publish_failed",item_id:itemId,actor:"telegram:"+userId,details:{reason:String(result.error||"انتشار مجدد ناموفق بود").slice(0,500),retry:true}});await telegram("sendMessage",{chat_id:chat,text:"❌ انتشار مجدد انجام نشد: "+String(result.error||"خطای نامشخص").slice(0,250)});}
        else {await db.from("bot_activity").insert({event_type:"manual_retry",item_id:itemId,actor:"telegram:"+userId,details:{task:"publish",title:item.rewritten_title||item.title}});await telegram("sendMessage",{chat_id:chat,text:"✅ خبر با موفقیت منتشر شد."});}
      }
      await showBotErrors(chat,messageId);
      return json({ok:true});
    }
    if (data.startsWith("botactivity:")) {
      await answerCallback(String(callback.id));
      await showBotActivity(callback.message?.chat?.id,callback.message?.message_id);
      return json({ok:true});
    }
    if (data.startsWith("botusage:")) {
      await answerCallback(String(callback.id));
      await showAiUsage(callback.message?.chat?.id, callback.message?.message_id);
      return json({ ok: true });
    }
    if (data.startsWith("botqueue:")) {
      const chat = callback.message?.chat?.id;
      const messageId = callback.message?.message_id;
      const parts = data.split(":");
      const action = parts[1];
      if (action === "refresh") {
        await answerCallback(String(callback.id));
        await showScheduledQueue(chat, messageId);
        return json({ ok: true });
      }
      const itemId = parts[2] || "";
      const { data: queue, error } = await db.from("news_items")
        .select("id,title,rewritten_title,scheduled_at")
        .eq("published", false).not("scheduled_at", "is", null)
        .order("scheduled_at", { ascending: true }).limit(200);
      if (error) {
        await answerCallback(String(callback.id), "خواندن صف ناموفق بود.");
        return json({ ok: true });
      }
      const index = (queue || []).findIndex((item: any) => item.id === itemId);
      if (index < 0) {
        await answerCallback(String(callback.id), "این خبر دیگر در صف نیست.");
        await showScheduledQueue(chat, messageId);
        return json({ ok: true });
      }
      if (action === "cancel") {
        const { data: changed, error: cancelError } = await db.from("news_items")
          .update({ scheduled_at: null, review_status: "pending", updated_at: new Date().toISOString() })
          .eq("id", itemId).eq("published", false).not("scheduled_at", "is", null).select("id").maybeSingle();
        if (cancelError || !changed) {
          await answerCallback(String(callback.id), "لغو پست انجام نشد.");
          return json({ ok: true });
        }
        await db.from("bot_activity").insert({ event_type: "schedule_cancelled", item_id: itemId, actor: "telegram:" + userId, details: { title: queue[index].rewritten_title || queue[index].title } });
        await answerCallback(String(callback.id), "پست از صف زمان‌بندی خارج شد.");
        await showScheduledQueue(chat, messageId);
        return json({ ok: true });
      }
      const direction = action === "up" ? -1 : action === "down" ? 1 : 0;
      const neighborIndex = index + direction;
      if (!direction || neighborIndex < 0 || neighborIndex >= queue.length) {
        await answerCallback(String(callback.id), "این جابه‌جایی ممکن نیست.");
        return json({ ok: true });
      }
      const current = queue[index], neighbor = queue[neighborIndex];
      const safeAfter = Date.now() + 2 * 60 * 1000;
      if (Date.parse(current.scheduled_at) <= safeAfter || Date.parse(neighbor.scheduled_at) <= safeAfter) {
        await answerCallback(String(callback.id), "این پست نزدیک زمان انتشار است و دیگر جابه‌جا نمی‌شود.");
        return json({ ok: true });
      }
      const currentTime = current.scheduled_at, neighborTime = neighbor.scheduled_at;
      const { error: moveError } = await db.from("news_items").update({ scheduled_at: neighborTime, updated_at: new Date().toISOString() }).eq("id", current.id).eq("published", false);
      if (moveError) {
        await answerCallback(String(callback.id), "جابجایی انجام نشد.");
        return json({ ok: true });
      }
      const { error: swapError } = await db.from("news_items").update({ scheduled_at: currentTime, updated_at: new Date().toISOString() }).eq("id", neighbor.id).eq("published", false);
      if (swapError) {
        await db.from("news_items").update({ scheduled_at: currentTime, updated_at: new Date().toISOString() }).eq("id", current.id).eq("published", false);
        await answerCallback(String(callback.id), "جابجایی کامل نشد؛ صف به حالت قبل برگشت.");
        return json({ ok: true });
      }
      await db.from("bot_activity").insert({ event_type: "schedule_reordered", item_id: itemId, actor: "telegram:" + userId, details: { direction: action, swapped_with: neighbor.id } });
      await answerCallback(String(callback.id), action === "up" ? "پست یک جایگاه بالاتر رفت." : "پست یک جایگاه پایین‌تر رفت.");
      await showScheduledQueue(chat, messageId);
      return json({ ok: true });
    }
    const regenerateMatch = data.match(/^regenerate:([0-9a-f-]{36})$/i);
    if (regenerateMatch) {
      const itemId = regenerateMatch[1];
      const chat = callback.message?.chat?.id;
      const messageId = callback.message?.message_id;
      const { data: item } = await db.from("news_items")
        .select("id,title,summary,rewritten_title,rewritten_text,source_name,source_type,pub_date,graphic_image_url,graphic_quality_status,video_file_id,telegram_chat_id,published")
        .eq("id", itemId).maybeSingle();
      if (!item || item.published || item.graphic_quality_status !== "review" || (item.telegram_chat_id && String(item.telegram_chat_id) !== String(chat))) {
        await answerCallback(String(callback.id), "این پوستر قابل بازتولید نیست.");
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), "بازتولید پوستر شروع شد.");
      await telegram("editMessageReplyMarkup", { chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      const { error: resetError } = await db.from("news_items").update({
        graphic_image_url: null, graphic_quality_status: null, graphic_quality_score: null, graphic_quality_notes: null,
        telegram_chat_id: Number(chat), updated_at: new Date().toISOString(),
      }).eq("id", itemId).eq("published", false);
      if (resetError) {
        await telegram("sendMessage", { chat_id: chat, text: "شروع بازتولید پوستر ناموفق بود." });
        return json({ ok: true });
      }
      const response = await fetch(supabaseUrl + "/functions/v1/radin-graphic-worker", {
        method: "POST",
        headers: { "content-type": "application/json", "apikey": serviceKey, "authorization": "Bearer " + serviceKey, "x-radin-telegram-secret": webhookSecret },
        body: JSON.stringify({ item_id: itemId }),
        signal: AbortSignal.timeout(140000),
      });
      let result: any = {}; try { result = await response.json(); } catch {}
      const success = response.ok && result.results?.some((row: any) => row.id === itemId && row.ok);
      const { data: ready } = await db.from("news_items")
        .select("title,summary,rewritten_title,rewritten_text,graphic_image_url,video_file_id,telegram_preview_message_id,graphic_quality_status,graphic_quality_notes")
        .eq("id", itemId).maybeSingle();
      if (!success || !ready?.graphic_image_url) {
        await telegram("sendMessage", { chat_id: chat, text: "بازتولید شروع شد، اما هنوز کامل نشده است؛ خبر در صف خودکار می‌ماند." });
        return json({ ok: true });
      }
      const note = ready.graphic_quality_status === "review" ? "\n\n⚠️ بررسی کیفیت: " + String(ready.graphic_quality_notes || "پوستر نیاز به بازبینی دارد.").slice(0, 180) : "";
      const caption = ("پیش‌نمایش خبر — هنوز منتشر نشده\n" + String(ready.rewritten_title || ready.title || "") + (ready.rewritten_text ? "\n\n" + ready.rewritten_text : ready.summary ? "\n\n" + ready.summary : "") + note).slice(0, 1024);
      const keyboard = previewKeyboard(itemId, ready.graphic_quality_status, isAdminCallback);
      const edited = await telegram("editMessageMedia", { chat_id: chat, message_id: messageId, media: ready.video_file_id ? { type: "video", media: ready.video_file_id, cover: ready.graphic_image_url, caption } : { type: "photo", media: ready.graphic_image_url, caption }, reply_markup: keyboard });
      if (!edited.response.ok || !edited.result.ok) {
        const sent = await telegram(ready.video_file_id ? "sendVideo" : "sendPhoto", ready.video_file_id ? { chat_id: chat, video: ready.video_file_id, cover: ready.graphic_image_url, caption, reply_markup: keyboard } : { chat_id: chat, photo: ready.graphic_image_url, caption, reply_markup: keyboard });
        if (sent.response.ok && sent.result.ok) await db.from("news_items").update({ telegram_preview_message_id: sent.result.result?.message_id || null }).eq("id", itemId);
      }
      await db.from("bot_activity").insert({ event_type: "graphic_regenerated", item_id: itemId, actor: "telegram:" + userId, details: { quality_status: ready.graphic_quality_status, score: result.results?.find((row: any) => row.id === itemId)?.graphic_quality_score ?? null } });
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
        if (next) {
          const result = await fillBotQueue(userId);
          await telegram("sendMessage", { chat_id: chat, text: result.message });
          await showScheduledQueue(chat);
        }
        await showBotSettings(chat, messageId);
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), "گزینهٔ تنظیمات شناخته نشد.");
      return json({ ok: true });
    }
    const editMatch = data.match(/^edit:(headline|caption|graphic):([0-9a-f-]{36})$/i);
    if (editMatch) {
      const editType = editMatch[1];
      const itemId = editMatch[2];
      const chatId = callback.message?.chat?.id;
      const { data: item } = await db.from("news_items").select("id,telegram_chat_id,published,review_status,graphic_image_url").eq("id", itemId).maybeSingle();
      if (!item || item.published || item.review_status === "rejected" ||
          (item.telegram_chat_id && String(item.telegram_chat_id) !== String(chatId))) {
        await answerCallback(String(callback.id), "این خبر دیگر قابل ویرایش نیست.");
        return json({ ok: true });
      }
      if (editType === "graphic" && !item.graphic_image_url) {
        await answerCallback(String(callback.id), "پوستر آماده‌ای برای ویرایش پیدا نشد.");
        return json({ ok: true });
      }
      const prompt = editType === "headline"
        ? "تیتر جایگزین را در پاسخ به همین پیام بفرستید (حداکثر ۵۲ نویسه). پوستر با تیتر تازه دوباره ساخته می‌شود."
        : editType === "caption"
        ? "متن کپشن خبر را در پاسخ به همین پیام بفرستید. متن جدید هنگام انتشار جایگزین متن فعلی می‌شود."
        : "تغییرات تصویری موردنظر را دقیق و کوتاه بنویسید؛ مثلاً سوژه را بزرگ‌تر کن، نور را گرم‌تر کن یا پس‌زمینه را عوض کن. تیتر و کپشن خبر حفظ می‌شوند و نسخهٔ تازه برای بازبینی می‌آید.";
      const sentPrompt = await telegram("sendMessage", {
        chat_id: chatId, text: prompt,
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: editType === "headline" ? "تیتر جدید..." : editType === "caption" ? "کپشن جدید..." : "تغییر تصویری..." },
      });
      if (!sentPrompt.response.ok || !sentPrompt.result.ok) {
        await answerCallback(String(callback.id), "ارسال درخواست ویرایش ناموفق بود.");
        return json({ ok: true });
      }
      const promptId = sentPrompt.result.result?.message_id;
      const { error: sessionError } = await db.from("news_items").update({
        telegram_chat_id: Number(chatId), telegram_edit_type: editType,
        telegram_edit_user_id: Number(userId), telegram_edit_prompt_message_id: promptId,
        telegram_edit_requested_at: new Date().toISOString(),
      }).eq("id", itemId);
      if (sessionError) {
        await answerCallback(String(callback.id), "ثبت درخواست ویرایش ناموفق بود.");
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), editType === "graphic" ? "منتظر توضیح تغییر تصویر هستم." : "منتظر متن ویرایش‌شده هستم.");
      return json({ ok: true });
    }
    const restoreMatch=data.match(/^restorepub:([0-9a-f-]{36})$/i);
    if(restoreMatch){
      const itemId=restoreMatch[1],chatId=callback.message?.chat?.id,messageId=callback.message?.message_id;
      const {data:item,error:readError}=await db.from("news_items").select("id,title,rewritten_title,published,review_status,telegram_chat_id").eq("id",itemId).maybeSingle();
      if(readError||!item||!item.published){await answerCallback(String(callback.id),"این خبر منتشرشده پیدا نشد.");return json({ok:true});}
      const {data:changed,error}=await db.from("news_items").update({published:false,review_status:"pending",telegram_message_id:null,scheduled_at:null,updated_at:new Date().toISOString()}).eq("id",itemId).eq("published",true).select("id").maybeSingle();
      if(error||!changed){await answerCallback(String(callback.id),"بازگردانی خبر ناموفق بود.");return json({ok:true});}
      await db.from("bot_activity").insert({event_type:"publication_reopened",item_id:itemId,actor:"telegram:"+userId,details:{reason:"درخواست بازبینی/انتشار مجدد"}});
      await answerCallback(String(callback.id),"خبر برای ویرایش یا انتشار مجدد فعال شد.");
      await telegram("editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[
        [{text:"✏️ ویرایش تیتر",callback_data:"edit:headline:"+itemId},{text:"📝 ویرایش کپشن",callback_data:"edit:caption:"+itemId}],
         [{text:"🎨 ویرایش تصویر",callback_data:"edit:graphic:"+itemId}],
        [{text:"📥 بسته اینستاگرام",callback_data:"insta:export:"+itemId}],
        [{text:"✅ انتشار مجدد در کانال",callback_data:"publish:"+itemId},{text:"🗑 رد خبر",callback_data:"reject:"+itemId}]
      ]}});
      await telegram("sendMessage",{chat_id:chatId,text:"🔓 خبر دوباره برای ویرایش و انتشار فعال شد. پس از ویرایش، «انتشار مجدد در کانال» را بزنید."});
      return json({ok:true});
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
      chat_id: callback.message?.chat?.id, message_id: callback.message?.message_id,
      reply_markup: { inline_keyboard: [
        [{text:"📥 بسته اینستاگرام",callback_data:"insta:export:"+itemId}],
        [{text:"🔁 بازگردانی برای ویرایش یا انتشار مجدد",callback_data:"restorepub:"+itemId}]
      ] }
    });
    await telegram("sendMessage", {
      chat_id: callback.message?.chat?.id,
      text: "✅ خبر در کانال منتشر شد.\nشناسه پیام: " + String(publishResult.message_id || "نامشخص") + "\n\nاگر پست کانال حذف شد یا نیاز به اصلاح داشت، «بازگردانی» را بزنید.",
    });
    return json({ ok: true });
  }

  const message = update.message ?? update.edited_message;
  if (!message?.chat?.id) return json({ ok: true });
  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? "");
  const isAdmin = adminIds.includes(userId);
  const trialAccount = isAdmin ? null : await getTrialAccount(userId);
  const accessGrant = isAdmin ? null : await getActiveAccessGrant(userId);
  const trialActive = isAdmin || trialIsActive(trialAccount, chatId) || accessGrantIsActive(accessGrant, chatId);
  const messageText = String(message.text ?? message.caption ?? "").trim();
  const videoMedia = message.video || null;
  const command = messageText.split(/\s+/, 1)[0].split("@", 1)[0];

  const replyConsentSource = messageText === "✅ موافقم و ادامه می‌دهم (سایت)" ? "site"
    : messageText === "✅ موافقم و ادامه می‌دهم" ? "telegram" : null;
  if (replyConsentSource) {
    if (isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "حساب مدیر از قبل دسترسی کامل دارد.", reply_markup: { remove_keyboard: true } });
      return json({ ok: true });
    }
    if (message.chat.type !== "private" || String(chatId) !== userId) {
      await telegram("sendMessage", { chat_id: chatId, text: "ثبت‌نام فقط در گفت‌وگوی خصوصی با ربات انجام می‌شود." });
      return json({ ok: true });
    }
    if (trialAccount?.phone_verified_at) {
      await telegram("sendMessage", { chat_id: chatId, text: "این حساب قبلاً دورهٔ آزمایشی خود را فعال کرده و دورهٔ دوم دریافت نمی‌کند." });
      return json({ ok: true });
    }
    const registration = {
      telegram_user_id: Number(userId), chat_id: Number(chatId),
      first_name: String(message.from?.first_name || "").slice(0, 128) || null,
      last_name: String(message.from?.last_name || "").slice(0, 128) || null,
      username: String(message.from?.username || "").slice(0, 64) || null,
      registration_source: replyConsentSource,
      consent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const consentSave = trialAccount
      ? await db.from("telegram_trial_accounts").update(registration).eq("telegram_user_id", Number(userId)).is("phone_verified_at", null)
      : await db.from("telegram_trial_accounts").insert(registration);
    if (consentSave.error) {
      console.error("Telegram reply-keyboard consent could not be stored", consentSave.error.message);
      await telegram("sendMessage", { chat_id: chatId, text: "ثبت موافقت انجام نشد؛ دوباره /start را بزنید." });
      return json({ ok: true });
    }
    await sendTrialContactRequest(chatId);
    return json({ ok: true });
  }

  if (message.contact) {
    if (isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "حساب مدیر از قبل دسترسی کامل دارد.", reply_markup: { remove_keyboard: true } });
      return json({ ok: true });
    }
    if (message.chat.type !== "private" || String(chatId) !== userId) {
      await telegram("sendMessage", { chat_id: chatId, text: "تأیید شماره فقط در گفت‌وگوی خصوصی با ربات انجام می‌شود." });
      return json({ ok: true });
    }
    if (String(message.contact.user_id ?? "") !== userId) {
      await telegram("sendMessage", { chat_id: chatId, text: "لطفاً فقط شمارهٔ متعلق به همین حساب تلگرام را با دکمهٔ تأیید شماره ارسال کنید." });
      return json({ ok: true });
    }
    if (!trialAccount?.consent_at) {
      await sendTrialConsent(chatId, "telegram");
      return json({ ok: true });
    }
    if (trialAccount.phone_verified_at) {
      const status = trialIsActive(trialAccount, chatId)
        ? "✅ حساب شما قبلاً تأیید شده است؛ دوره تا " + trialExpiryLabel(String(trialAccount.trial_expires_at)) + " فعال است."
        : "⏳ این حساب قبلاً دورهٔ آزمایشی خود را استفاده کرده است و دورهٔ دوم فعال نمی‌شود.";
      await telegram("sendMessage", { chat_id: chatId, text: status, reply_markup: { remove_keyboard: true } });
      return json({ ok: true });
    }
    let normalizedPhone = String(message.contact.phone_number || "").replace(/[^0-9]/g, "");
    if (normalizedPhone.startsWith("00")) normalizedPhone = normalizedPhone.slice(2);
    if (normalizedPhone.length < 8 || normalizedPhone.length > 15) {
      await telegram("sendMessage", { chat_id: chatId, text: "شمارهٔ دریافت‌شده معتبر نیست. دوباره با دکمهٔ تلگرام تأیید کنید." });
      return json({ ok: true });
    }
    const fingerprint = await phoneFingerprint(normalizedPhone);
    const { data: phoneOwner, error: phoneLookupError } = await db.from("telegram_trial_accounts")
      .select("telegram_user_id").eq("phone_fingerprint", fingerprint).maybeSingle();
    if (phoneLookupError) {
      console.error("Telegram phone uniqueness lookup failed", phoneLookupError.message);
      await telegram("sendMessage", { chat_id: chatId, text: "بررسی شماره انجام نشد؛ چند لحظه بعد دوباره تلاش کنید." });
      return json({ ok: true });
    }
    if (phoneOwner && String(phoneOwner.telegram_user_id) !== userId) {
      await telegram("sendMessage", { chat_id: chatId, text: "این شماره قبلاً برای فعال‌سازی یک دورهٔ آزمایشی استفاده شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید." });
      return json({ ok: true });
    }
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
    const { data: activated, error: activationError } = await db.from("telegram_trial_accounts").update({
      chat_id: Number(chatId),
      first_name: String(message.from?.first_name || "").slice(0, 128) || null,
      last_name: String(message.from?.last_name || "").slice(0, 128) || null,
      username: String(message.from?.username || "").slice(0, 64) || null,
      phone_fingerprint: fingerprint,
      phone_verified_at: startedAt.toISOString(),
      trial_started_at: startedAt.toISOString(),
      trial_expires_at: expiresAt.toISOString(),
      updated_at: startedAt.toISOString(),
    }).eq("telegram_user_id", Number(userId)).is("phone_verified_at", null).select("telegram_user_id").maybeSingle();
    if (activationError || !activated) {
      console.error("Telegram trial activation failed", activationError?.message || "registration is not pending");
      await telegram("sendMessage", { chat_id: chatId, text: "فعال‌سازی دوره انجام نشد. اگر قبلاً ثبت‌نام کرده‌اید، از بخش حساب کاربری وضعیت را ببینید؛ در غیر این صورت دوباره /start را بزنید." });
      return json({ ok: true });
    }
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "✅ ثبت‌نام و احراز هویت انجام شد. دورهٔ آزمایشی ۲۴ساعتهٔ شما تا " + trialExpiryLabel(expiresAt.toISOString()) + " فعال است. حالا می‌توانید لینک یا محتوای خبری را برای ساخت پیش‌نمایش بفرستید. انتشار نهایی در کانال عمومی فقط با تأیید مدیر انجام می‌شود.",
      reply_markup: { ...mainMenuReplyMarkup(false, true), input_field_placeholder: "لینک یا خبر را بفرستید" },
      disable_web_page_preview: true,
    });
    await sendWebAccountPanel(chatId);
    return json({ ok: true });
  }

  if (message.reply_to_message?.message_id && messageText && (isAdmin || trialActive)) {
    const { data: editing } = await db.from("news_items")
      .select("id,title,summary,rewritten_title,rewritten_text,graphic_image_url,telegram_preview_message_id,telegram_edit_type,telegram_edit_requested_at,pub_date,source_name,source_type,graphic_quality_status")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_edit_user_id", Number(userId))
      .eq("telegram_edit_prompt_message_id", Number(message.reply_to_message.message_id))
      .not("telegram_edit_type", "is", null).maybeSingle();
    if (editing) {
      const expiresAt = Date.parse(String(editing.telegram_edit_requested_at || ""));
      if (!Number.isFinite(expiresAt) || Date.now() - expiresAt > 30 * 60 * 1000) {
        await db.from("news_items").update({ telegram_edit_type: null, telegram_edit_user_id: null, telegram_edit_prompt_message_id: null, telegram_edit_requested_at: null }).eq("id", editing.id);
        await telegram("sendMessage", { chat_id: chatId, text: "مهلت ویرایش تمام شده است؛ از دکمه‌های پیش‌نمایش دوباره اقدام کنید." });
        return json({ ok: true });
      }
      const cleanValue = messageText.replace(/https?:\/\/[^\s<>]+/gi, "").trim();
      if (editing.telegram_edit_type === "caption" && cleanValue.length > 900) {
        await telegram("sendMessage", { chat_id: chatId, text: "کپشن باید حداکثر ۹۰۰ نویسه باشد تا همراه تاریخ و شناسه کانال در تلگرام جا شود. کوتاه‌ترش کنید و دوباره پاسخ دهید." });
        return json({ ok: true });
      }
      if (editing.telegram_edit_type === "headline" && (cleanValue.length < 8 || cleanValue.length > 52 || cleanValue.includes("\n"))) {
        await telegram("sendMessage", { chat_id: chatId, text: "تیتر باید بین ۸ تا ۵۲ نویسه و در یک خط باشد. پاسخ را دوباره به پیام درخواست ویرایش بفرستید." });
        return json({ ok: true });
      }
      const clearSession = { telegram_edit_type: null, telegram_edit_user_id: null, telegram_edit_prompt_message_id: null, telegram_edit_requested_at: null, updated_at: new Date().toISOString() };
      const keyboard = (id: string, qualityStatus?: string) => previewKeyboard(id, qualityStatus, isAdmin);
      if (editing.telegram_edit_type === "graphic") {
        if (cleanValue.length < 4 || cleanValue.length > 600) {
          await telegram("sendMessage", { chat_id: chatId, text: "توضیح ویرایش تصویر باید بین ۴ تا ۶۰۰ نویسه باشد. کوتاه‌تر و روشن‌تر بنویسید و دوباره به پیام درخواست پاسخ دهید." });
          return json({ ok: true });
        }
        const { data: priorEdits } = await db.from("bot_activity").select("details")
          .eq("event_type", "graphic_regenerated").eq("item_id", editing.id)
          .order("created_at", { ascending: false }).limit(8);
        const promptHistory = (priorEdits || [])
          .map((event: any) => String(event.details?.graphic_edit_prompt || "").trim())
          .filter((value: string) => value.length >= 4)
          .slice(0, 2).reverse();
        const fullGraphicPrompt = [...promptHistory, cleanValue]
          .map((value, index) => index === promptHistory.length ? "آخرین درخواست ویرایش (اولویت بالاتر): " + value : "درخواست قبلی: " + value)
          .join("\n").slice(0, 2200);
        const { error: sessionError } = await db.from("news_items").update({
          ...clearSession, review_status: "pending",
        }).eq("id", editing.id).eq("published", false);
        if (sessionError) {
          await telegram("sendMessage", { chat_id: chatId, text: "ثبت درخواست ویرایش تصویر ناموفق بود؛ دوباره تلاش کنید." });
          return json({ ok: true });
        }
        if (editing.telegram_preview_message_id) {
          await telegram("editMessageReplyMarkup", { chat_id: chatId, message_id: editing.telegram_preview_message_id, reply_markup: { inline_keyboard: [] } });
        }
        await telegram("sendMessage", { chat_id: chatId, text: "🎨 درخواست دریافت شد؛ تصویر را با حفظ تیتر و کپشن بازطراحی می‌کنم..." });
        let workerResponse: Response | null = null;
        let workerResult: any = {};
        try {
          workerResponse = await fetch(supabaseUrl + "/functions/v1/radin-graphic-worker", {
            method: "POST",
            headers: { "content-type": "application/json", "apikey": serviceKey, "authorization": "Bearer " + serviceKey, "x-radin-telegram-secret": webhookSecret },
            body: JSON.stringify({ item_id: editing.id, graphic_edit_prompt: fullGraphicPrompt, preserve_headline: true }),
            signal: AbortSignal.timeout(150000),
          });
          try { workerResult = await workerResponse.json(); } catch {}
        } catch (error) {
          console.error("Graphic edit worker request failed", error instanceof Error ? error.message : "unknown");
        }
        const success = !!workerResponse?.ok && workerResult.results?.some((row: any) => row.id === editing.id && row.ok);
        const { data: ready } = await db.from("news_items")
          .select("title,summary,rewritten_title,rewritten_text,graphic_image_url,video_file_id,telegram_preview_message_id,graphic_quality_status")
          .eq("id", editing.id).maybeSingle();
        if (!success || !ready?.graphic_image_url) {
          if (editing.telegram_preview_message_id) {
            await telegram("editMessageReplyMarkup", { chat_id: chatId, message_id: editing.telegram_preview_message_id, reply_markup: keyboard(editing.id, editing.graphic_quality_status) });
          }
          await telegram("sendMessage", { chat_id: chatId, text: "بازطراحی تصویر انجام نشد؛ پوستر قبلی حفظ شده است. دوباره درخواست بدهید یا با همان پیش‌نمایش ادامه دهید." });
          return json({ ok: true });
        }
        const rawPreviewBody=String(ready.telegram_caption_edited&&ready.rewritten_text?ready.rewritten_text:ready.summary||"").replace(/https?:\/\/[^\s<>]+|(?:www\.)?t\.me\/[^\s<>]+|telegram\.me\/[^\s<>]+/gi,"").replace(/(?:^|\s)@[a-z0-9_]+/gi," ");
        const cleanedPreviewBody=rawPreviewBody.split(/\r?\n/).filter((line:string)=>/[\p{L}\p{N}]/u.test(line)).join("\n").trim();
        const previewBody=cleanedPreviewBody||String(ready.title||"");
        const previewCaption=("پیش‌نمایش خبر — هنوز منتشر نشده\n"+String(ready.rewritten_title||ready.title||"خبر رادین")+(previewBody?"\n\n"+previewBody:"")).slice(0,1024);
        let previewMessageId = ready.telegram_preview_message_id || editing.telegram_preview_message_id;
        let previewUpdated = false;
        if (previewMessageId) {
          const editedPhoto = await telegram("editMessageMedia", {
            chat_id: chatId, message_id: previewMessageId,
            media: { type: "photo", media: ready.graphic_image_url, caption: previewCaption },
            reply_markup: keyboard(editing.id, ready.graphic_quality_status),
          });
          previewUpdated = editedPhoto.response.ok && editedPhoto.result.ok;
        }
        if (!previewUpdated) {
          const sent = await telegram("sendPhoto", {
            chat_id: chatId, photo: ready.graphic_image_url, caption: previewCaption,
            reply_markup: keyboard(editing.id, ready.graphic_quality_status),
          });
          if (sent.response.ok && sent.result.ok) previewMessageId = sent.result.result?.message_id || previewMessageId;
          else console.error("Updated graphic preview could not be sent", sent.result?.description || "unknown");
        }
        if (previewMessageId) await db.from("news_items").update({ telegram_preview_message_id: previewMessageId }).eq("id", editing.id);
        await db.from("bot_activity").insert({
          event_type: "graphic_regenerated", item_id: editing.id, actor: "telegram:" + userId,
          details: { graphic_edit_prompt: fullGraphicPrompt, title: ready.rewritten_title || ready.title || "" },
        });
        await telegram("sendMessage", { chat_id: chatId, text: previewUpdated || previewMessageId
          ? "✅ نسخهٔ تازهٔ پوستر آماده است؛ پیش‌نمایش را ببینید و در صورت تأیید «انتشار در کانال» را بزنید."
          : "✅ تصویر بازطراحی شد و ذخیره شد؛ اما پیش‌نمایش تلگرام به‌روزرسانی نشد. از صف خبر برای بررسی استفاده کنید." });
        return json({ ok: true });
      }
      if (editing.telegram_edit_type === "caption") {
        const { error } = await db.from("news_items").update({ ...clearSession, rewritten_text: cleanValue, telegram_caption_edited: true }).eq("id", editing.id).eq("published", false);
        if (error) {
          await telegram("sendMessage", { chat_id: chatId, text: "ذخیرهٔ کپشن انجام نشد؛ دوباره تلاش کنید." });
          return json({ ok: true });
        }
        const previewCaption = ("پیش‌نمایش خبر — هنوز منتشر نشده\n" + String(editing.rewritten_title || editing.title || "") + "\n\n" + cleanValue).slice(0, 1024);
        if (editing.telegram_preview_message_id) {
          await telegram("editMessageCaption", { chat_id: chatId, message_id: editing.telegram_preview_message_id, caption: previewCaption, reply_markup: keyboard(editing.id, editing.graphic_quality_status) });
        }
        await db.from("bot_activity").insert({ event_type: "caption_edited", item_id: editing.id, actor: "telegram:" + userId, details: { length: cleanValue.length } });
        await telegram("sendMessage", { chat_id: chatId, text: "✅ کپشن ذخیره شد و در پیش‌نمایش به‌روزرسانی شد." });
        return json({ ok: true });
      }
      const { error } = await db.from("news_items").update({
        ...clearSession, rewritten_title: cleanValue, telegram_headline_edited: true,
        graphic_image_url: null, review_status: "pending",
      }).eq("id", editing.id).eq("published", false);
      if (error) {
        await telegram("sendMessage", { chat_id: chatId, text: "ذخیرهٔ تیتر انجام نشد؛ دوباره تلاش کنید." });
        return json({ ok: true });
      }
      if (editing.telegram_preview_message_id) {
        await telegram("editMessageReplyMarkup", { chat_id: chatId, message_id: editing.telegram_preview_message_id, reply_markup: { inline_keyboard: [] } });
      }
      await telegram("sendMessage", { chat_id: chatId, text: "✏️ تیتر ذخیره شد؛ پوستر را با تیتر جدید بازطراحی می‌کنم..." });
      const workerResponse = await fetch(supabaseUrl + "/functions/v1/radin-graphic-worker", {
        method: "POST",
        headers: { "content-type": "application/json", "apikey": serviceKey, "authorization": "Bearer " + serviceKey, "x-radin-telegram-secret": webhookSecret },
        body: JSON.stringify({ item_id: editing.id }),
        signal: AbortSignal.timeout(140000),
      });
      let workerResult: any = {}; try { workerResult = await workerResponse.json(); } catch {}
      const success = workerResponse.ok && workerResult.results?.some((row: any) => row.id === editing.id && row.ok);
      const { data: ready } = await db.from("news_items")
        .select("title,summary,rewritten_title,rewritten_text,source_name,source_type,pub_date,graphic_image_url,video_file_id,telegram_preview_message_id,graphic_quality_status,graphic_quality_score,graphic_quality_notes")
        .eq("id", editing.id).maybeSingle();
      if (!success || !ready?.graphic_image_url) {
        await telegram("sendMessage", { chat_id: chatId, text: "تیتر ذخیره شد؛ ساخت پوستر در صف خودکار باقی ماند و پس از آماده‌شدن ارسال می‌شود." });
        return json({ ok: true });
      }
      const previewCaption = ("پیش‌نمایش خبر — هنوز منتشر نشده\n" + String(ready.rewritten_title || cleanValue) + (ready.rewritten_text ? "\n\n" + ready.rewritten_text : ready.summary ? "\n\n" + ready.summary : "")).slice(0, 1024);
      let updatedPreview = false;
      if (ready.telegram_preview_message_id) {
        const editedPhoto = await telegram("editMessageMedia", {
          chat_id: chatId, message_id: ready.telegram_preview_message_id,
          media: ready.video_file_id ? { type: "video", media: ready.video_file_id, cover: ready.graphic_image_url, caption: previewCaption } : { type: "photo", media: ready.graphic_image_url, caption: previewCaption },
          reply_markup: keyboard(editing.id, ready.graphic_quality_status),
        });
        updatedPreview = editedPhoto.response.ok && editedPhoto.result.ok;
      }
      if (!updatedPreview) {
        const sentPreview = await telegram("sendPhoto", { chat_id: chatId, photo: ready.graphic_image_url, caption: previewCaption, reply_markup: keyboard(editing.id, ready.graphic_quality_status) });
        if (sentPreview.response.ok && sentPreview.result.ok) {
          await db.from("news_items").update({ telegram_preview_message_id: sentPreview.result.result?.message_id || null }).eq("id", editing.id);
        }
      }
      await db.from("bot_activity").insert({ event_type: "headline_edited", item_id: editing.id, actor: "telegram:" + userId, details: { headline: cleanValue } });
      await telegram("sendMessage", { chat_id: chatId, text: "✅ تیتر و پوستر به‌روزرسانی شد؛ از همین پیش‌نمایش می‌توانید انتشار را تأیید کنید." });
      return json({ ok: true });
    }
  }

  if ((command === "/testpublish") && isAdmin) {
    const testText = "🧪 پیام آزمایشی ربات خبر رادین\n\nاین پیام برای بررسی اتصال ربات به کانال منتشر شده است.\n\nپس از تأیید اتصال، این پیام را می‌توانید حذف کنید.";
    const sent = await telegram("sendMessage", { chat_id: "@radinnews", text: testText, disable_web_page_preview: true });
    const reply = sent.response.ok && sent.result.ok
      ? "✅ پیام آزمایشی با موفقیت در @radinnews منتشر شد. شناسه پیام: " + String(sent.result.result?.message_id ?? "نامشخص")
      : "❌ ارسال آزمایشی ناموفق بود. مجوز ارسال ربات در کانال را بررسی کنید.";
    await telegram("sendMessage", { chat_id: chatId, text: reply, disable_web_page_preview: true });
    return json({ ok: true });
  }
  if (messageText === "⚙️ تنظیمات ربات" || messageText === "تنظیمات ربات") {
    if (!isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "این بخش فقط برای مدیر ربات در دسترس است.", reply_markup: mainMenuReplyMarkup(isAdmin, trialActive) });
    } else {
      await showBotSettings(chatId);
    }
    return json({ ok: true });
  }
  if (messageText === "🔐 ثبت‌نام و شروع آزمایشی") {
    if (trialAccount?.phone_verified_at) {
      const status = trialIsActive(trialAccount, chatId)
        ? "✅ دورهٔ آزمایشی شما فعال است و تا " + trialExpiryLabel(String(trialAccount.trial_expires_at)) + " ادامه دارد."
        : "⏳ دورهٔ آزمایشی این حساب قبلاً استفاده شده است و دوباره فعال نمی‌شود.";
      await telegram("sendMessage", { chat_id: chatId, text: status, reply_markup: mainMenuReplyMarkup(isAdmin, trialActive) });
    } else if (trialAccount?.consent_at) {
      await sendTrialContactRequest(chatId);
    } else {
      await sendTrialConsent(chatId, "site");
    }
    return json({ ok: true });
  }
  if (messageText === "📨 ثبت خبر") {
    if (!isAdmin && !trialActive) {
      await telegram("sendMessage", { chat_id: chatId, text: "برای ثبت خبر ابتدا احراز هویت کنید و دورهٔ آزمایشی را فعال کنید.", reply_markup: mainMenuReplyMarkup(isAdmin, trialActive) });
      return json({ ok: true });
    }
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "خبر را همین‌جا بفرستید: لینک خبر، متن خبر، یا خبر فورواردشده همراه عکس یا ویدیو. برای عکس و ویدیوی فورواردی لینک لازم نیست.",
      reply_markup: mainMenuReplyMarkup(isAdmin, trialActive),
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (messageText === "🗓️ صف انتشار") {
    if (!isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "نمایش صف فقط برای مدیر ربات در دسترس است.", reply_markup: mainMenuReplyMarkup(isAdmin, trialActive) });
    } else {
      await showScheduledQueue(chatId);
    }
    return json({ ok: true });
  }
  if (messageText === "📚 تاریخچه خبرها" || messageText === "🤖 مصرف AI") {
    if (!isAdmin) {
      await telegram("sendMessage", { chat_id: chatId, text: "این گزارش فقط برای مدیر ربات در دسترس است.", reply_markup: mainMenuReplyMarkup(isAdmin, trialActive) });
      return json({ ok: true });
    }
    const panel = await telegram("sendMessage", { chat_id: chatId, text: "در حال آماده‌سازی گزارش…" });
    const panelId = Number(panel.result?.result?.message_id || 0);
    if (panel.response.ok && panel.result.ok && panelId) {
      if (messageText === "📚 تاریخچه خبرها") await showBotActivity(chatId, panelId);
      else await showAiUsage(chatId, panelId);
    }
    return json({ ok: true });
  }
  if (command === "/panel" || messageText === "👤 حساب کاربری") {
    if (message.chat.type !== "private" || String(chatId) !== userId) {
      await telegram("sendMessage", { chat_id: chatId, text: "پنل حساب را فقط در گفت‌وگوی خصوصی با ربات باز کنید." });
      return json({ ok: true });
    }
    const hasTrial = trialIsActive(trialAccount, chatId);
    const hasTimedAccess = accessGrantIsActive(accessGrant, chatId);
    const accountStatus = isAdmin ? "مدیر ربات"
      : hasTrial ? "دورهٔ آزمایشی فعال تا " + trialExpiryLabel(String(trialAccount?.trial_expires_at))
      : hasTimedAccess ? "دسترسی یک‌ساعته فعال تا " + trialExpiryLabel(String(accessGrant?.expires_at))
      : trialAccount?.phone_verified_at ? "دورهٔ آزمایشی پایان یافته"
      : trialAccount?.consent_at ? "در انتظار تأیید شماره"
      : "ثبت‌نام نشده";
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "👤 حساب رادین نیوز\nشناسه تلگرام: " + String(userId || chatId) + "\nدسترسی: " + accountStatus + ((hasTrial || hasTimedAccess || isAdmin) ? "\n\nخبرها و فعالیت‌های این حساب در پنل شخصی دیده می‌شود." : "\n\nبرای شروع، ثبت‌نام و تأیید شماره را در ربات کامل کنید."),
      reply_markup: mainMenuReplyMarkup(isAdmin, trialActive),
      disable_web_page_preview: true,
    });
    await sendWebAccountPanel(chatId);
    return json({ ok: true });
  }
  if (messageText === "💬 پشتیبانی") {
    const supportTargets = adminIds.filter((id) => id !== userId).slice(0, 5);
    const supportKeyboard = supportTargets.map((id, index) => [{
      text: "💬 تماس با مدیر " + (index + 1),
      url: "tg://user?id=" + id,
      style: "primary",
    }]);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: supportTargets.length
        ? "برای پشتیبانی، روی نام یکی از مدیران بزنید و پیام خود را در گفت‌وگوی خصوصی برای او بفرستید."
        : "شما تنها مدیر ثبت‌شده هستید. برای پشتیبانی فنی از همین گفت‌وگو با شناسهٔ حساب خود استفاده کنید.",
      reply_markup: supportKeyboard.length ? { inline_keyboard: supportKeyboard } : undefined,
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (command === "/start") {
    const botIdentity = await telegram("getMe", {});
    console.log("Telegram /start bot identity", {
      username: botIdentity.result?.result?.username || null,
      get_me_ok: botIdentity.response.ok && botIdentity.result?.ok === true,
    });
    const menuButton = await telegram("setChatMenuButton", { menu_button: { type: "commands" } });
    if (!menuButton.response.ok || !menuButton.result?.ok) console.error("Could not set persistent Telegram menu button", menuButton.result?.description || "");
    const defaultCommands = [
      { command: "start", description: "♻️ شروع مجدد" },
      { command: "help", description: "ℹ️ راهنما و قوانین" },
      { command: "categories", description: "🗂 دسته‌بندی خبرها" },
      { command: "panel", description: "👤 پنل حساب کاربری" },
    ];
    const commands = await telegram("setMyCommands", { commands: defaultCommands });
    if (!commands.response.ok || !commands.result?.ok) console.error("Could not set Telegram commands", commands.result?.description || "");
    if (isAdmin && message.chat.type === "private") {
      const adminCommands = [
        ...defaultCommands,
        { command: "settings", description: "⚙️ تنظیمات ربات" },
        { command: "status", description: "📊 وضعیت ربات" },
      ];
      const scoped = await telegram("setMyCommands", {
        scope: { type: "chat", chat_id: chatId },
        commands: adminCommands,
      });
      if (!scoped.response.ok || !scoped.result?.ok) console.error("Could not set admin Telegram commands", scoped.result?.description || "");
    }
    const startPayload = messageText.split(/\s+/, 2)[1] || "";
    if (!isAdmin) {
      if (message.chat.type !== "private" || String(chatId) !== userId) {
        await telegram("sendMessage", { chat_id: chatId, text: "برای ثبت‌نام، از دکمهٔ ورود سایت ربات را در گفت‌وگوی خصوصی باز کنید." });
        return json({ ok: true });
      }
      const registrationSource = startPayload.toLowerCase() === "site" ? "site" : "telegram";
      console.log("Telegram /start flow", {
        chat_type: message.chat?.type || null,
        is_admin: isAdmin,
        trial_account_found: Boolean(trialAccount),
        consent_recorded: Boolean(trialAccount?.consent_at),
        phone_verified: Boolean(trialAccount?.phone_verified_at),
        registration_source: registrationSource,
      });
      if (trialActive) {
        const hasTrial = trialIsActive(trialAccount, chatId);
        const activeUntil = hasTrial ? trialAccount?.trial_expires_at : accessGrant?.expires_at;
        const accessType = hasTrial ? "دورهٔ آزمایشی ۲۴ساعته" : "دسترسی یک‌ساعته";
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "✅ حساب شما احراز هویت شده است. " + accessType + " تا " + trialExpiryLabel(String(activeUntil)) + " فعال است؛ لینک یا محتوای خبر را بفرستید تا پیش‌نمایش ساخته شود.",
          reply_markup: mainMenuReplyMarkup(false, true), disable_web_page_preview: true,
        });
        if (startPayload.toLowerCase() === "panel") await sendWebAccountPanel(chatId);
      } else if (trialAccount?.phone_verified_at) {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "⏳ دورهٔ آزمایشی ۲۴ساعتهٔ این حساب پایان یافته و دوباره فعال نمی‌شود. از «حساب کاربری» در ربات پنل را باز کنید و برای دسترسی یک‌ساعته درخواست بفرستید.",
          reply_markup: mainMenuReplyMarkup(false, false), disable_web_page_preview: true,
        });
        if (startPayload.toLowerCase() === "panel") await sendWebAccountPanel(chatId);
      } else if (trialAccount?.consent_at) {
        await sendTrialContactRequest(chatId);
      } else {
        await sendTrialConsent(chatId, registrationSource);
      }
      return json({ ok: true });
    }
    const welcome = await telegram("sendMessage", {
      chat_id: chatId,
      text: "به ربات خبر رادین خوش آمدید.\n\nبرای ثبت خبر، لینک را بفرستید یا متن، عکس و ویدیو را از منابع مختلف فوروارد کنید؛ برای عکس و ویدیوی فورواردی لینک لازم نیست. پس از آماده‌شدن گرافیک، پیش‌نمایش را ببینید و انتشار را تأیید کنید.\n\nدکمهٔ ثابت Menu فرمان‌ها را باز می‌کند؛ دکمه‌های رنگی پایین صفحه دسترسی سریع به بخش‌های ربات هستند.",
      reply_markup: mainMenuReplyMarkup(isAdmin, trialActive),
      disable_web_page_preview: true,
    });
    console.log("Telegram /start welcome result", { ok: welcome.response.ok && welcome.result?.ok === true });
    if (startPayload.toLowerCase() === "panel" && message.chat.type === "private") await sendWebAccountPanel(chatId);
    return json({ ok: true });
  }
  if (command === "/help" || messageText === "ℹ️ راهنما و قوانین" || messageText === "ℹ️ راهنما") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "راهنمای ثبت دستی خبر:\n۱) لینک خبر را بفرستید، یا خبر را همراه عکس یا ویدیو فوروارد کنید؛ برای رسانهٔ فورواردشده لینک الزامی نیست.\n۲) عنوان خبر باید در کپشن یا متن باشد.\n۳) ربات پیش‌نمایش گرافیکی می‌سازد؛ برای ویدیو، خود ویدیو همراه کاور منتشر می‌شود.\n۴) کپشن خبر زیر ویدیو می‌آید و لینک و تگ منبع از متن انتشار پاک می‌شود.\n۵) با دکمهٔ انتشار در پیش‌نمایش، خبر را تأیید کنید.\n\nمدیر: «⚙️ تنظیمات ربات» صف و زمان‌بندی را باز می‌کند.\nبرای شروع دوباره، دکمهٔ Menu را باز کنید و «♻️ شروع مجدد» را بزنید.",
      reply_markup: mainMenuReplyMarkup(isAdmin, trialActive),
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

  if (!isAdmin && !trialActive) {
    if (message.chat.type !== "private") {
      await telegram("sendMessage", { chat_id: chatId, text: "ثبت‌نام و استفادهٔ آزمایشی در گفت‌وگوی خصوصی با ربات انجام می‌شود." });
    } else if (trialAccount?.phone_verified_at) {
      await telegram("sendMessage", { chat_id: chatId, text: "⏳ دورهٔ آزمایشی ۲۴ساعتهٔ این حساب پایان یافته است و تکرار نمی‌شود. برای ادامه با پشتیبانی تماس بگیرید.", reply_markup: mainMenuReplyMarkup(false, false) });
    } else if (trialAccount?.consent_at) {
      await sendTrialContactRequest(chatId);
    } else {
      await sendTrialConsent(chatId, "site");
    }
    return json({ ok: true });
  }
  if (!isAdmin && message.chat.type !== "private") {
    await telegram("sendMessage", { chat_id: chatId, text: "ثبت و پردازش خبر برای کاربران آزمایشی فقط در گفت‌وگوی خصوصی با ربات فعال است." });
    return json({ ok: true });
  }
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
  const forwardOrigin = message.forward_origin;
  const forwardChat = forwardOrigin?.chat || forwardOrigin?.sender_chat || message.forward_from_chat;
  const forwardMessageId = forwardOrigin?.message_id || message.forward_from_message_id;
  const forwardedFromTelegram = Boolean(forwardOrigin || message.forward_from_chat || message.forward_from || message.forward_sender_name);
  const manualTelegramMedia = !sourceUrl && Boolean(message.photo?.length || videoMedia);
  const textOnlyForward = !sourceUrl && !manualTelegramMedia && forwardedFromTelegram && messageText.length > 0;
  if (!sourceUrl && !manualTelegramMedia && !textOnlyForward) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لینک پیدا نشد. لینک خبر را بفرستید، یا خبر را همراه عکس فوروارد کنید؛ فوروارد عکس بدون لینک هم پذیرفته می‌شود.",
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  const canonicalUrl = sourceUrl
    ? sourceUrl.toString()
    : "telegram:forwarded/" + String(forwardChat?.id || chatId) + "/" + String(forwardMessageId || message.message_id || update.update_id);
  const acknowledgement = await telegram("sendMessage", {
    chat_id: chatId,
    text: "📥 خبر دریافت شد؛ در حال تحلیل و آنالیز محتوایی، ترجمه و آماده‌سازی خروجی...",
    disable_web_page_preview: true,
  });
  if (!acknowledgement.response.ok || !acknowledgement.result.ok) {
    console.error("Telegram receipt acknowledgement failed", acknowledgement.response.status, acknowledgement.result?.description || "unknown");
  }
  const { data: existing } = await db.from("news_items")
    .select("id,published,review_status,graphic_image_url,telegram_chat_id").eq("source_url", canonicalUrl).maybeSingle();
  if (existing?.published) {
    await telegram("sendMessage", { chat_id: chatId, text: "این لینک قبلاً در کانال منتشر شده است." });
    return json({ ok: true });
  }
  if (!isAdmin && existing && String(existing.telegram_chat_id || "") !== String(chatId)) {
    await telegram("sendMessage", { chat_id: chatId, text: "این خبر قبلاً برای بررسی ثبت شده است و امکان ویرایش پیش‌نمایش متعلق به حساب دیگری وجود ندارد." });
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
  let titleCandidate = manualLines[0] || metaTitle || "";
  let summaryCandidate = manualLines.slice(1).join("\n") || metaDescription || "";
  if (textOnlyForward && titleCandidate.length > 160) {
    const sentence = titleCandidate.match(/^.{35,150}?[.!؟](?:\s|$)/u)?.[0]?.trim();
    titleCandidate = sentence || titleCandidate.slice(0, 120).trim();
    summaryCandidate = [manualText, summaryCandidate].filter(Boolean).join("\n").slice(0, 5000);
  }
  const title = (forwardedFromTelegram ? stripForwardTrace(titleCandidate) : titleCandidate).slice(0, 500);
  const summary = (forwardedFromTelegram ? stripForwardTrace(summaryCandidate) : summaryCandidate).slice(0, 5000);
  const sourceName = forwardedFromTelegram ? forwardSource : (sourceUrl?.hostname.replace(/^www\./i, "") || forwardSource);

  const duplicateTokens = (value: string) => {
    const stop = new Set(["و","در","به","از","که","با","برای","این","آن","یک","را","بر","تا","اما","نیز","شد","شود","کرد","کرده","می","خواهد","است","بود","هست","های","ها"]);
    return new Set(value.normalize("NFKC").toLowerCase()
      .replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[ۀة]/g, "ه")
      .replace(/https?:\/\/\S+|@\w+/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/)
      .filter((token) => token.length > 1 && !stop.has(token)));
  };
  const tokenSimilarity = (left: Set<string>, right: Set<string>) => {
    if (!left.size || !right.size) return 0;
    let common = 0;
    for (const token of left) if (right.has(token)) common++;
    return common / (left.size + right.size - common);
  };
  const duplicateSince = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: recentStories, error: duplicateLookupError } = await db.from("news_items")
    .select("id,title,summary,original_summary,rewritten_title,source_url,published,scheduled_at,created_at")
    .gte("created_at", duplicateSince).order("created_at", { ascending: false }).limit(300);
  if (duplicateLookupError) {
    console.error("Duplicate lookup failed", duplicateLookupError.message);
  } else {
    const incomingTitleTokens = duplicateTokens(title);
    const incomingBodyTokens = duplicateTokens((title + " " + summary).slice(0, 1400));
    if (incomingTitleTokens.size >= 4) {
      const duplicate = (recentStories || []).filter((candidate: any) =>
        candidate.id !== existing?.id && candidate.source_url !== canonicalUrl
      ).map((candidate: any) => {
        const candidateTitleTokens = duplicateTokens(String(candidate.rewritten_title || candidate.title || ""));
        const candidateBodyTokens = duplicateTokens((String(candidate.title || "") + " " + String(candidate.original_summary || candidate.summary || "")).slice(0, 1400));
        const titleScore = tokenSimilarity(incomingTitleTokens, candidateTitleTokens);
        const bodyScore = tokenSimilarity(incomingBodyTokens, candidateBodyTokens);
        return { candidate, titleScore, bodyScore, score: Math.max(titleScore, bodyScore) };
      }).find((match: any) =>
        (match.titleScore >= 0.90 && match.bodyScore >= 0.58) ||
        (match.titleScore >= 0.96) ||
        (match.titleScore >= 0.82 && match.bodyScore >= 0.82)
      );
      if (duplicate) {
        const matched: any = duplicate.candidate;
        const state = matched.published ? "قبلاً منتشر شده" : matched.scheduled_at ? "در صف زمان‌بندی است" : "در صف بررسی است";
        await db.from("bot_activity").insert({
          event_type: "duplicate_detected", item_id: matched.id, actor: "telegram:" + userId,
          details: { incoming_title: title.slice(0, 240), matched_title: matched.rewritten_title || matched.title, similarity: Number(duplicate.score.toFixed(3)), window_hours: 48 },
        });
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "⚠️ خبر مشابهی در ۴۸ ساعت اخیر پیدا شد و برای جلوگیری از تکرار ثبت نشد.\n\nخبر موجود: " + String(matched.rewritten_title || matched.title || "").slice(0, 250) + "\nوضعیت: " + state + "\n\nاگر این خبر به‌روزرسانی مهمی دارد، آن را با تیتر یا متن کامل‌تر دوباره بفرستید.",
          disable_web_page_preview: true,
        });
        return json({ ok: true, duplicate: true, matched_item_id: matched.id });
      }
    }
  }
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
  if (!imageUrl && !textOnlyForward && !videoMedia?.file_id) {
    await telegram("sendMessage", { chat_id: chatId, text: "برای این خبر تصویر پیدا نشد. لطفاً عکس را همراه خبر فوروارد کنید.", disable_web_page_preview: true });
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
      image_url: imageUrl || null,
      telegram_chat_id: Number(chatId),
      telegram_preview_message_id: null,
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
      title, summary: summary || null, image_url: imageUrl || null, telegram_chat_id: Number(chatId), video_file_id: videoFileId || null, source_name: sourceName,
      original_title: title, original_summary: summary || null, source_type: forwardedFromTelegram ? "telegram" : (sourceUrl ? "website" : "telegram"),
      pub_date: publishedAt, review_status: "pending", graphic_image_url: null, original_image_url: null, updated_at: new Date().toISOString(),
    }).eq("id", itemId).eq("published", false);
    if (error) {
      await telegram("sendMessage", { chat_id: chatId, text: "به‌روزرسانی خبر انجام نشد. لطفاً بررسی کنید." });
      return json({ ok: true });
    }
  }

  await db.from("bot_activity").insert({event_type:"received",item_id:itemId,actor:"telegram",details:{title,source:sourceName}});
  const languageSample=[manualText,title,summary].filter(Boolean).join(" ").normalize("NFKC");
  const normalizedLanguageSample=languageSample.toLowerCase().replace(/ي/g,"ی").replace(/ك/g,"ک").replace(/[ۀة]/g,"ه");
  const languageTokens=normalizedLanguageSample.match(/[\p{L}]+/gu)||[];
  const persianMarkers=new Set(["از","در","به","که","برای","این","آن","یک","است","هست","بود","شد","شده","می","نمی","خواهد","کرد","کرده","گفت","اعلام","ایران","تهران","کشور","امروز","گزارش","وزارت","دارد","داده","فوری","زلزله","انفجار","خبرنگار","می‌شود","نمی‌شود"]);
  const arabicMarkers=new Set(["فی","من","على","إلى","هذا","هذه","الذی","التی","أن","إن","قال","قالت","أعلن","أعلنت","أكد","الرئیس","الوزیر","الجیش","الإیرانی","الأمریکی","الخبر","الآن","بعد","قبل","بیان","وأضاف"]);
  const persianScore=languageTokens.filter((word)=>persianMarkers.has(word)).length+(languageSample.match(/[پچژگک\u06cc]/g)||[]).length*2;
  const arabicScore=languageTokens.filter((word)=>arabicMarkers.has(word)).length;
  const latinCount=(languageSample.match(/[A-Za-z]/g)||[]).length;
  const arabicScriptCount=(languageSample.match(/[\u0600-\u06FF]/g)||[]).length;
  const isPersianCaption=persianScore>arabicScore&&latinCount<=arabicScriptCount;
  if(isPersianCaption){
    const {error:languageUpdateError}=await db.from("news_items").update({telegram_translation_language:null,telegram_generate_graphic:true,telegram_preview_message_id:null,updated_at:new Date().toISOString()}).eq("id",itemId).eq("published",false);
    if(languageUpdateError){
      await telegram("sendMessage",{chat_id:chatId,text:"کپشن فارسی تشخیص داده شد، اما ثبت زبان ناموفق بود. لطفاً خبر را دوباره فوروارد کنید."});
      return json({ok:true});
    }
    await db.from("bot_activity").insert({event_type:"language_detected",item_id:itemId,actor:"telegram",details:{language:"fa",translation_skipped:true}});
    await telegram("sendMessage",{chat_id:chatId,text:"کپشن فارسی تشخیص داده شد؛ بدون ترجمه در حال آماده‌سازی پیش‌نمایش گرافیکی است."});
    await processStoryPreview(itemId,chatId);
    return json({ok:true});
  }
  const optionKeyboard={inline_keyboard:[
    [{text:"🇸🇦 ترجمه عربی به فارسی",callback_data:"processnews:"+itemId+":ar"}],
    [{text:"🇬🇧 ترجمه انگلیسی به فارسی",callback_data:"processnews:"+itemId+":en"}],
    [{text:"بدون ترجمه، متن اصلی",callback_data:"processnews:"+itemId+":none"}]
  ]};
  await db.from("bot_activity").insert({event_type:"language_detected",item_id:itemId,actor:"telegram",details:{language:"non_fa",translation_choices_shown:true}});
  await telegram("sendMessage",{chat_id:chatId,text:"کپشن غیر فارسی تشخیص داده شد. زبان متن را برای ترجمه و آماده‌سازی پیش‌نمایش انتخاب کنید:",reply_markup:optionKeyboard});
  return json({ok:true});
});
