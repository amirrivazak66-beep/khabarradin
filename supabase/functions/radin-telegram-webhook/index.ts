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
      [{ text: "💳 گزارش مصرف AI", callback_data: "botusage:month" }],\n      [{ text: "🚨 خطاهای اخیر", callback_data: "boterrors:refresh" }, { text: "📜 گزارش فعالیت", callback_data: "botactivity:refresh" }],
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
      if (index > 0) actions.push({ text: "⬆️", callback_data: "botqueue:up:" + item.id });
      if (index < list.length - 1) actions.push({ text: "⬇️", callback_data: "botqueue:down:" + item.id });
      actions.push({ text: "لغو", callback_data: "botqueue:cancel:" + item.id });
      keyboard.push(actions);
    });
    if (!list.length) lines.push("صف زمان‌بندی‌شده خالی است.");
    lines.push("", "جابجایی فقط برای پست‌هایی انجام می‌شود که حداقل دو دقیقه تا زمان انتشار فاصله دارند.");
    keyboard.push([{ text: "🔄 تازه‌سازی", callback_data: "botqueue:refresh" }, { text: "↩️ تنظیمات ربات", callback_data: "botsettings:refresh" }]);
    const params: any = { chat_id: chatId, text: lines.join("\n").slice(0, 3900), reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true };
    if (messageId) {
      await telegram("editMessageText", { ...params, message_id: messageId });
    } else {
      await telegram("sendMessage", params);
    }
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
        .select("id,title,summary,rewritten_title,rewritten_text,source_name,source_type,pub_date,graphic_image_url,telegram_chat_id,published")
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
        headers: { "content-type": "application/json", "apikey": serviceKey, "authorization": "Bearer " + serviceKey },
        body: JSON.stringify({ item_id: itemId }),
        signal: AbortSignal.timeout(140000),
      });
      let result: any = {}; try { result = await response.json(); } catch {}
      const success = response.ok && result.results?.some((row: any) => row.id === itemId && row.ok);
      const { data: ready } = await db.from("news_items")
        .select("title,summary,rewritten_title,rewritten_text,graphic_image_url,telegram_preview_message_id,graphic_quality_status,graphic_quality_notes")
        .eq("id", itemId).maybeSingle();
      if (!success || !ready?.graphic_image_url) {
        await telegram("sendMessage", { chat_id: chat, text: "بازتولید شروع شد، اما هنوز کامل نشده است؛ خبر در صف خودکار می‌ماند." });
        return json({ ok: true });
      }
      const note = ready.graphic_quality_status === "review" ? "\n\n⚠️ بررسی کیفیت: " + String(ready.graphic_quality_notes || "پوستر نیاز به بازبینی دارد.").slice(0, 180) : "";
      const caption = ("پیش‌نمایش خبر — هنوز منتشر نشده\n" + String(ready.rewritten_title || ready.title || "") + (ready.rewritten_text ? "\n\n" + ready.rewritten_text : ready.summary ? "\n\n" + ready.summary : "") + note).slice(0, 1024);
      const keyboard: any[] = [
        [{ text: "✏️ ویرایش تیتر", callback_data: "edit:headline:" + itemId }, { text: "📝 ویرایش کپشن", callback_data: "edit:caption:" + itemId }],
        [{ text: "✅ انتشار در کانال", callback_data: "publish:" + itemId }, { text: "🗑 رد خبر", callback_data: "reject:" + itemId }],
      ];
      if (ready.graphic_quality_status === "review") keyboard.unshift([{ text: "🔄 بازتولید پوستر", callback_data: "regenerate:" + itemId }]);
      const edited = await telegram("editMessageMedia", { chat_id: chat, message_id: messageId, media: { type: "photo", media: ready.graphic_image_url, caption }, reply_markup: { inline_keyboard: keyboard } });
      if (!edited.response.ok || !edited.result.ok) {
        const sent = await telegram("sendPhoto", { chat_id: chat, photo: ready.graphic_image_url, caption, reply_markup: { inline_keyboard: keyboard } });
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
        await showBotSettings(chat, messageId);
        return json({ ok: true });
      }
      await answerCallback(String(callback.id), "گزینهٔ تنظیمات شناخته نشد.");
      return json({ ok: true });
    }
    const editMatch = data.match(/^edit:(headline|caption):([0-9a-f-]{36})$/i);
    if (editMatch) {
      const editType = editMatch[1];
      const itemId = editMatch[2];
      const chatId = callback.message?.chat?.id;
      const { data: item } = await db.from("news_items").select("id,telegram_chat_id,published,review_status").eq("id", itemId).maybeSingle();
      if (!item || item.published || item.review_status === "rejected" ||
          (item.telegram_chat_id && String(item.telegram_chat_id) !== String(chatId))) {
        await answerCallback(String(callback.id), "این خبر دیگر قابل ویرایش نیست.");
        return json({ ok: true });
      }
      const prompt = editType === "headline"
        ? "تیتر جایگزین را در پاسخ به همین پیام بفرستید (حداکثر ۵۲ نویسه). پوستر با تیتر تازه دوباره ساخته می‌شود."
        : "متن کپشن خبر را در پاسخ به همین پیام بفرستید. متن جدید هنگام انتشار جایگزین متن فعلی می‌شود.";
      const sentPrompt = await telegram("sendMessage", {
        chat_id: chatId, text: prompt,
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: editType === "headline" ? "تیتر جدید..." : "کپشن جدید..." },
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
      await answerCallback(String(callback.id), "منتظر متن ویرایش‌شده هستم.");
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

  if (message.reply_to_message?.message_id && messageText && isAdmin) {
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
      const keyboard = (id: string, qualityStatus?: string) => {
        const rows: any[] = [
          [{ text: "✏️ ویرایش تیتر", callback_data: "edit:headline:" + id }, { text: "📝 ویرایش کپشن", callback_data: "edit:caption:" + id }],
          [{ text: "✅ انتشار در کانال", callback_data: "publish:" + id }, { text: "🗑 رد خبر", callback_data: "reject:" + id }],
        ];
        if (qualityStatus === "review") rows.unshift([{ text: "🔄 بازتولید پوستر", callback_data: "regenerate:" + id }]);
        return { inline_keyboard: rows };
      };
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
        headers: { "content-type": "application/json", "apikey": serviceKey, "authorization": "Bearer " + serviceKey },
        body: JSON.stringify({ item_id: editing.id }),
        signal: AbortSignal.timeout(140000),
      });
      let workerResult: any = {}; try { workerResult = await workerResponse.json(); } catch {}
      const success = workerResponse.ok && workerResult.results?.some((row: any) => row.id === editing.id && row.ok);
      const { data: ready } = await db.from("news_items")
        .select("title,summary,rewritten_title,rewritten_text,source_name,source_type,pub_date,graphic_image_url,telegram_preview_message_id,graphic_quality_status,graphic_quality_score,graphic_quality_notes")
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
          media: { type: "photo", media: ready.graphic_image_url, caption: previewCaption },
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
      await telegram("sendMessage", { chat_id: chatId, text: "این بخش فقط برای مدیر ربات در دسترس است." });
    } else {
      await showBotSettings(chatId);
    }
    return json({ ok: true });
  }
  if (command === "/start") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "به ربات خبر رادین خوش آمدید.\n\nبرای ثبت دستی، لینک خبر را بفرستید یا خبر را همراه عکس فوروارد کنید؛ فوروارد عکس یا ویدیو بدون لینک هم پذیرفته می‌شود. پس از آماده‌شدن پوستر، انتشار را خودتان تأیید می‌کنید.\n\nاز دکمهٔ ثابت پایین صفحه برای بازکردن تنظیمات ربات استفاده کنید.",
      reply_markup: {
        keyboard: [[{ text: "⚙️ تنظیمات ربات" }], [{ text: "ℹ️ راهنما" }]],
        resize_keyboard: true,
        is_persistent: true,
      },
      disable_web_page_preview: true,
    });
    return json({ ok: true });
  }
  if (command === "/help" || messageText === "ℹ️ راهنما") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "راهنمای ثبت دستی خبر:\n۱) لینک خبر را بفرستید، یا خبر را همراه عکس یا ویدیو فوروارد کنید؛ برای رسانهٔ فورواردشده، لینک الزامی نیست.\n۲) عنوان خبر باید در کپشن/متن باشد.\n۳) ربات پیش‌نمایش گرافیکی می‌سازد.\n۴) با دکمه «انتشار در کانال» خبر را دستی تأیید کنید.\n\nمدیر: از دکمهٔ «⚙️ تنظیمات ربات» برای تنظیم صف و زمان‌بندی استفاده کنید.\nلینک منبع در کپشن کانال درج نمی‌شود.",
      reply_markup: {
        keyboard: [[{ text: "⚙️ تنظیمات ربات" }], [{ text: "ℹ️ راهنما" }]],
        resize_keyboard: true,
        is_persistent: true,
      },
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
  if (!imageUrl && !textOnlyForward) {
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
      telegram_chat_id: forwardedFromTelegram ? Number(chatId) : null,
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
      title, summary: summary || null, image_url: imageUrl || null, telegram_chat_id: forwardedFromTelegram ? Number(chatId) : null, video_file_id: videoFileId || null, source_name: sourceName,
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
    signal: AbortSignal.timeout(140000),
  });
  let workerResult: any = {};
  try { workerResult = await worker.json(); } catch {}
  if (!worker.ok || !workerResult.ok || !workerResult.results?.some((row: any) => row.id === itemId && row.ok)) {
    console.error("Graphic generation failed", worker.status, JSON.stringify(workerResult).slice(0, 500));
    const failedItem = (workerResult.results || []).find((row: any) => row.id === itemId);
    const headlineUnavailable = /AI headline unavailable/i.test(String(failedItem?.error || ""));
    await telegram("sendMessage", { chat_id: chatId, text: "خبر ثبت شد و در صف آماده‌سازی باقی ماند. ربات به‌صورت خودکار دوباره تلاش می‌کند و پس از آماده‌شدن پوستر همین‌جا می‌فرستد؛ نیازی به ارسال دوباره نیست." });
    return json({ ok: true });
  }

  const { data: ready } = await db.from("news_items")
    .select("title,summary,rewritten_title,rewritten_text,category,source_name,source_type,source_url,pub_date,created_at,graphic_image_url,graphic_quality_status,graphic_quality_score,graphic_quality_notes")
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
  const qualityWarning = ready.graphic_quality_status === "review" ? "\n\n⚠️ بررسی کیفیت: " + String(ready.graphic_quality_notes || "پوستر نیاز به بازبینی دارد.").slice(0, 180) : "";
  const verificationNotes: string[] = [];
  if (/^https?:\/\//i.test(String(ready.source_url || ""))) {
    try { verificationNotes.push("🔎 منبع قابل پیگیری: " + new URL(String(ready.source_url)).hostname); } catch {}
  } else if (ready.source_type === "telegram") {
    const sender = String(ready.source_name || "").trim();
    verificationNotes.push(sender.startsWith("@")
      ? "📡 منبع فوروارد: " + sender + "؛ راستی‌آزمایی مستقل انجام نشده"
      : sender ? "⚠️ منبع فوروارد: " + sender + "؛ شناسهٔ عمومی برای بررسی در دسترس نیست"
      : "⚠️ منبع اصلی مشخص نیست؛ پیش از انتشار بررسی کنید");
  }
  const shortStoryWarning = String(ready.rewritten_text || ready.summary || "").trim().length < 120
    ? "⚠️ متن توضیحی کوتاه است؛ جزئیات خبر را بررسی کنید"
    : "";
  const receivedAt = ready.created_at
    ? new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(new Date(ready.created_at))
    : "";
  const previewText = [
    "پیش‌نمایش خبر — هنوز منتشر نشده",
    ready.rewritten_title || ready.title,
    (ready.rewritten_text || ready.summary) ? "\n" + (ready.rewritten_text || ready.summary) : "",
    ...verificationNotes,
    shortStoryWarning,
    "\nتاریخ خبر: " + new Date(ready.pub_date || publishedAt).toLocaleDateString("fa-IR"),
    receivedAt ? "دریافت ربات: " + receivedAt : "",
  ].filter(Boolean).join("\n") + qualityWarning;
  const safePreviewText = previewText.slice(0, 1024);
  const preview = await telegram("sendPhoto", {
    chat_id: chatId,
    photo: ready.graphic_image_url,
    caption: safePreviewText,
    reply_markup: { inline_keyboard: (() => { const rows: any[] = [
      [{ text: "✏️ ویرایش تیتر", callback_data: "edit:headline:" + itemId }, { text: "📝 ویرایش کپشن", callback_data: "edit:caption:" + itemId }],
      [{ text: "✅ انتشار در کانال", callback_data: "publish:" + itemId }, { text: "🗑 رد خبر", callback_data: "reject:" + itemId }],
    ]; if (ready.graphic_quality_status === "review") rows.unshift([{ text: "🔄 بازتولید پوستر", callback_data: "regenerate:" + itemId }]); return rows; })() },
  });
  if (!preview.response.ok || !preview.result.ok) {
    console.error("Telegram preview failed", preview.response.status, preview.result?.description || "unknown");
    await telegram("sendMessage", { chat_id: chatId, text: "پوستر آماده شد، اما ارسال پیش‌نمایش در گفتگو ناموفق بود. از پنل مدیریت خبر را بررسی کنید." });
  } else {
    console.log("Manual story preview delivered", itemId, preview.result.result?.message_id || "unknown");
    const previewMessageId=preview.result.result?.message_id||null;
    await db.from("news_items").update({telegram_preview_message_id:previewMessageId}).eq("id",itemId);
    await db.from("bot_activity").insert({event_type:"preview_sent",item_id:itemId,actor:"telegram",details:{preview_message_id:previewMessageId,title}});
  }
  if (designNote) {
    await telegram("sendMessage", { chat_id: chatId, text: designNote, disable_web_page_preview: true });
  }
  return json({ ok: true });
});
