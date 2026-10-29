import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: corsHeaders
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const authHeader = req.headers.get("authorization") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Server configuration missing" }, 500);
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user || authData.user.email !== "amir.rivazak66@gmail.com") {
    return json({ error: "Admin only" }, 403);
  }

  let payload: { id?: string; action?: string };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!payload.id || !["publish", "reject"].includes(payload.action || "")) {
    return json({ error: "id and action=publish|reject required" }, 400);
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: item, error: itemError } = await db.from("news_items")
    .select("id,title,summary,original_summary,rewritten_text,category,source_url,source_name,image_url,original_image_url,graphic_image_url,pub_date,published,review_status,telegram_message_id")
    .eq("id", payload.id).maybeSingle();
  if (itemError) return json({ error: "Could not load story" }, 500);
  if (!item) return json({ error: "Story not found" }, 404);

  if (payload.action === "reject") {
    const { error } = await db.from("news_items")
      .update({ published: false, review_status: "rejected", updated_at: new Date().toISOString() })
      .eq("id", item.id);
    if (error) return json({ error: "Could not reject story" }, 500);
    return json({ ok: true, action: "rejected" });
  }

  if (item.published || item.telegram_message_id) return json({ error: "Story may already have been published; refusing duplicate send" }, 409);
  if (item.review_status === "rejected") return json({ error: "Rejected story cannot be published without re-review" }, 409);

  // Require the branded graphic before sending anything to Telegram.
  const approvedGraphicUrl = String(item.graphic_image_url || "").trim();
  if (!/^https?:\/\//i.test(approvedGraphicUrl)) {
    return json({ error: "تصویر گرافیکی خبر هنوز آماده نشده است؛ پس از آماده‌شدن تصویر دوباره تلاش کنید." }, 409);
  }

  if (!String(item.original_image_url || "").startsWith("http")) return json({ error: "تصویر اصلی در قالب نهایی تأیید نشده است." }, 409);

  const botToken = Deno.env.get("BOT_TOKEN");
  if (!botToken) return json({ error: "Bot token is not configured" }, 500);
  const { data: settings } = await db.from("bot_settings").select("channel_username,review_required,auto_publish").eq("id", "main").maybeSingle();
  const channel = String(settings?.channel_username || "@radinnews").trim();
  if (!channel.startsWith("@")) return json({ error: "Destination channel must be a public @username" }, 400);

  let title = String(item.title || "").trim();
  let summary = String(item.summary || "").trim();
  const category = String(item.category || "").trim();

  // Optional rewrite: when no paid text API is configured, publish the original RSS text after human approval.
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  let rewriteApplied = false;
  if (openAiKey && (title || summary)) {
    try {
      const rewriteResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openAiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini", temperature: 0.4, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "تو دبیر تحریریه خبر رادین به زبان فارسی هستی. عنوان و خلاصه را موجز و حرفه‌ای بازنویسی کن؛ فقط اطلاعات موجود را حفظ کن و هیچ جزئیات، نقل‌قول یا قطعیت تازه‌ای نساز. لحن خنثی و دقیق باشد. فقط JSON معتبر با کلیدهای title و summary برگردان." },
            { role: "user", content: JSON.stringify({ title, summary, category }) }
          ]
        })
      });
      if (rewriteResponse.ok) {
        const rewriteData = await rewriteResponse.json();
        const content = rewriteData?.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          const rewritten = JSON.parse(content);
          const nextTitle = String(rewritten.title || "").trim();
          const nextSummary = String(rewritten.summary || "").trim();
          if (nextTitle) { title = nextTitle; if (nextSummary) summary = nextSummary; rewriteApplied = true; }
        }
      } else {
        console.error("Editorial rewrite failed; keeping original RSS text", rewriteResponse.status);
      }
    } catch (error) {
      console.error("Editorial rewrite failed; keeping original RSS text", String(error));
    }
  }
  const combinedForEmoji = (title + " " + summary + " " + category).toLowerCase();
  const emojiRules: Array<[RegExp, string]> = [
    [/زلزله|زمین.?لرزه|earthquake/, "🌍"],
    [/جنگ|حمله|موشک|پهپاد|انفجار|ارتش|نظامی|اسرائیل|غزه|اوکراین/, "🚨"],
    [/انتخابات|رئیس.?جمهور|رییس.?جمهور|پارلمان|مجلس|دولت|وزیر|سیاسی/, "🏛️"],
    [/اقتصاد|تورم|ارز|دلار|طلا|بورس|بازار|بانک|قیمت|تجارت/, "💹"],
    [/فوت|درگذشت|جان.?باخت|کشته|مرگ/, "🕯️"],
    [/هواشناسی|باران|برف|طوفان|سیل|آب.?وهوا|دما/, "🌦️"],
    [/فناوری|هوش مصنوعی|اینترنت|سایبری|موبایل|نرم.?افزار/, "💻"],
    [/فوتبال|ورزش|تیم ملی|لیگ|قهرمانی|مسابقه/, "⚽"],
    [/سلامت|پزشکی|بیمارستان|واکسن|دارو|ویروس/, "🩺"],
    [/مدرسه|دانشگاه|آموزش|دانشجو|کنکور/, "🎓"],
    [/تصادف|آتش.?سوزی|حادثه|نجات/, "🚑"],
    [/جهان|بین.?الملل|سازمان ملل|دیپلمات/, "🌐"]
  ];
  const relatedEmoji = emojiRules.find(([pattern]) => pattern.test(combinedForEmoji))?.[1] || "📰";
  const displayTitle = /^[\p{Extended_Pictographic}]/u.test(title) ? title : relatedEmoji + " " + title;
  const rawSource = String(item.source_name || "").trim();
  const sourceLower = rawSource.toLowerCase();
  const sourceAliases: Record<string, string> = {
    "mehrnews.com": "مهر",
    "www.mehrnews.com": "مهر",
    "irna.ir": "ایرنا",
    "www.irna.ir": "ایرنا",
    "isna.ir": "ایسنا",
    "www.isna.ir": "ایسنا",
    "asriran.com": "عصر ایران",
    "www.asriran.com": "عصر ایران",
    "yjc.ir": "باشگاه خبرنگاران جوان",
    "www.yjc.ir": "باشگاه خبرنگاران جوان",
    "tabnak.ir": "تابناک",
    "www.tabnak.ir": "تابناک",
    "khabaronline.ir": "خبرآنلاین",
    "www.khabaronline.ir": "خبرآنلاین",
    "tasnimnews.com": "تسنیم",
    "www.tasnimnews.com": "تسنیم"
  };
  const sourceName = sourceAliases[sourceLower] || rawSource.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "") || "خبر";
  const escapeHtml = (value: string) => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\x27/g,"&#39;");
  const fullStory = String(item.rewritten_text || item.original_summary || summary || "").trim();
  const dateLabel = (() => {
    if (!item.pub_date) return "";
    try {
      const p = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-arabext", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran" }).formatToParts(new Date(item.pub_date));
      const get = (k: string) => p.find(x => x.type === k)?.value || "";
      const n = (s: string) => Number(s.replace(/[۰-۹]/g, ch => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch)));
      const day = n(get("day")), year = n(get("year"));
      const ord = ["","اول","دوم","سوم","چهارم","پنجم","ششم","هفتم","هشتم","نهم","دهم","یازدهم","دوازدهم","سیزدهم","چهاردهم","پانزدهم","شانزدهم","هفدهم","هجدهم","نوزدهم","بیستم","بیست و یکم","بیست و دوم","بیست و سوم","بیست و چهارم","بیست و پنجم","بیست و ششم","بیست و هفتم","بیست و هشتم","بیست و نهم","سی‌ام","سی و یکم"];
      const card = (v: number): string => { const u=["","یک","دو","سه","چهار","پنج","شش","هفت","هشت","نه"],te=["ده","یازده","دوازده","سیزده","چهارده","پانزده","شانزده","هفده","هجده","نوزده"],t=["","","بیست","سی","چهل","پنجاه","شصت","هفتاد","هشتاد","نود"],hu=["","صد","دویست","سیصد","چهارصد","پانصد","ششصد","هفتصد","هشتصد","نهصد"]; if(!v)return "صفر";const a:string[]=[];if(v>=100){a.push(hu[Math.floor(v/100)]);v%=100}if(v>=10&&v<20)a.push(te[v-10]);else{if(v>=20){a.push(t[Math.floor(v/10)]);v%=10}if(v)a.push(u[v])}return a.join(" و "); };
      return (ord[day] || get("day")) + " " + get("month") + " " + (year >= 1400 && year < 1500 ? card(year - 1000) : card(year));
    } catch { return ""; }
  })();
  // One Telegram post only: photo caption uses the available 1024-character limit.
  const titleCaption = displayTitle;
  const captionMessage = [
    "<b>" + escapeHtml(titleCaption) + "</b>",
    category ? "🏷️ <b>" + escapeHtml(category) + "</b>" : "",
    fullStory ? "📝 " + escapeHtml(fullStory) : "",
    dateLabel ? "🗓️ " + escapeHtml(dateLabel) : "",
    "🔎 منبع: " + escapeHtml(sourceName),
    "🌐 khabarradin.ir",

  ].filter(Boolean).join("\n\n");
  // Telegram photo captions are limited to 1024 characters. Never silently truncate or send a second post.
  if (captionMessage.length > 1024) {
    return json({ error: "کپشن کامل از محدودیت ۱۰۲۴ نویسه تلگرام بیشتر است؛ متن خبر باید در مرحله تحریریه کوتاه‌تر و تأیید شود تا همه محتوا در همان یک پست تصویری قرار گیرد.", caption_length: captionMessage.length, caption_limit: 1024 }, 413);
  }
  const imageUrl = approvedGraphicUrl;
  const hasImage = /^https?:\/\//i.test(imageUrl);
  let generatedPhoto: Blob | null = null;
  let generatedImageB64: string | null = null;
  // Create a topic-matched editorial visual on manual approval. If image generation is unavailable,
  // retain the original RSS image so a billing/configuration issue does not block the news post.
  if (openAiKey) {
    try {
      const imagePrompt = [
        "Create a polished editorial news illustration for a Persian-language news channel.",
        "Topic/headline: " + title,
        "Summary/context: " + summary,
        "Category: " + category,
        "Visual style: professional contemporary newsroom graphic, realistic editorial illustration, strong composition, high contrast, clean background, blue and white palette with restrained gold accents.",
        "Do not include any text, letters, numbers, logos, watermarks, flags with invented symbols, or fake news labels.",
        "Depict the reported subject accurately and neutrally; do not invent identifiable people or imply unverified events."
      ].join("\n");
      let imageResponse: Response;
      if (hasImage) {
        const sourceResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(12000) });
        if (!sourceResponse.ok) throw new Error("Source image download failed: " + sourceResponse.status);
        const sourceType = sourceResponse.headers.get("content-type") || "image/jpeg";
        if (!sourceType.startsWith("image/")) throw new Error("Source URL did not return an image");
        const sourceBlob = await sourceResponse.blob();
        if (sourceBlob.size > 15 * 1024 * 1024) throw new Error("Source image too large");
        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("prompt", imagePrompt + "\nTransform the supplied source photo into an editorial news visual. Preserve the real subject and key facts; do not alter documentary evidence or the identity of real people. Add tasteful graphic treatment without text.");
        form.append("size", "1024x1024");
        form.append("image", sourceBlob, "source-image");
        imageResponse = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST", headers: { "Authorization": `Bearer ${openAiKey}` }, body: form
        });
      } else {
        imageResponse = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { "Authorization": `Bearer ${openAiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-image-1", prompt: imagePrompt, size: "1024x1024", n: 1 })
        });
      }
      if (imageResponse.ok) {
        const imageData = await imageResponse.json();
        generatedImageB64 = imageData?.data?.[0]?.b64_json || null;
        if (generatedImageB64) {
          const binary = atob(generatedImageB64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          generatedPhoto = new Blob([bytes], { type: "image/png" });
        } else {
          console.error("Image generation returned no image data");
        }
      } else {
        let imageError = "";
        try { const body = await imageResponse.json(); imageError = String(body?.error?.message || ""); } catch {}
        console.error("Editorial image generation failed", imageResponse.status, imageError);
      }
    } catch (imageError) {
      console.error("Editorial image generation failed; using source image", String(imageError));
    }
  }
  const sendAsPhoto = Boolean(generatedPhoto) || hasImage;
  let tg: Response;
  if (sendAsPhoto && generatedPhoto) {
    const form = new FormData();
    form.append("chat_id", channel);
    form.append("photo", generatedPhoto, "radin-editorial.png");
    form.append("caption", captionMessage);
    form.append("parse_mode", "HTML");
    tg = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: "POST", body: form });
  } else {
    tg = await fetch(`https://api.telegram.org/bot${botToken}/${sendAsPhoto ? "sendPhoto" : "sendMessage"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sendAsPhoto
        ? { chat_id: channel, photo: imageUrl, caption: captionMessage, parse_mode: "HTML" }
        : { chat_id: channel, text: captionMessage.replace(/<[^>]+>/g, ""), disable_web_page_preview: true })
    });
  }
  let tgResult: any = {};
  try { tgResult = await tg.json(); } catch {}
  if (!tg.ok || !tgResult.ok || !tgResult.result?.message_id) {
    console.error("Telegram publish failed", tg.status, tgResult?.description || "unknown");
    return json({ error: "Telegram send failed", detail: tgResult?.description || "Check image URL, bot admin permissions and destination channel" }, 502);
  }

  const { error: updateError } = await db.from("news_items").update({
    published: true,
    review_status: "approved",
    telegram_message_id: tgResult.result.message_id,
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", item.id).eq("published", false);
  if (updateError) {
    console.error("Story sent but DB update failed", item.id, updateError.message);
    return json({ ok: true, warning: "Sent to Telegram but database update failed; check before retrying", message_id: tgResult.result.message_id }, 200);
  }
  return json({ ok: true, channel, message_id: tgResult.result.message_id, caption_mode: "single_graphic_post_fullest_possible_caption" });
});