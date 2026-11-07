import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") || "";
  if (!url || !key || !secret) return json({ error: "Server configuration missing" }, 500);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let authorized = bearer === key && req.headers.get("x-radin-telegram-secret") === secret;
  const cron = req.headers.get("x-radin-cron-secret") || "";
  if (!authorized && cron) {
    const result = await db.rpc("verify_radin_cron_secret", { candidate: cron });
    authorized = !result.error && result.data === true;
  }
  if (!authorized) return json({ error: "Unauthorized" }, 401);
  const adminIds = [...new Set([...(Deno.env.get("ADMIN_USER_IDS") || "").split(",").map(x => x.trim()).filter(x => /^\d+$/.test(x)), "9129058355", "269401462"])];
  const { error: fillError } = await db.rpc("fill_radin_publish_queue", { p_admin_chat_ids: adminIds });
  if (fillError) console.error("Publish queue refill failed", fillError.code || "database_error");
  const { data: jobs, error } = await db.rpc("claim_radin_preview");
  if (error) return json({ error: "Processing queue unavailable" }, 503);
  const job = jobs?.[0];
  if (!job) return json({ ok: true, idle: true });
  EdgeRuntime.waitUntil((async () => {
    let failure: string | null = null;
    try {
      const { data: item, error: readError } = await db.from("news_items")
        .select("published,review_status,telegram_preview_message_id,graphic_image_url,telegram_generate_graphic")
        .eq("id", job.item_id).maybeSingle();
      if (readError) throw new Error("Could not read queued story");
      if (item && !item.published && item.review_status !== "rejected" &&
          !(item.telegram_preview_message_id && (item.graphic_image_url || item.telegram_generate_graphic === false))) {
        const response = await fetch(url + "/functions/v1/radin-graphic-worker", {
          method: "POST", headers: { "content-type": "application/json", apikey: key,
            authorization: "Bearer " + key, "x-radin-telegram-secret": secret },
          body: JSON.stringify({ item_id: job.item_id, trigger: "scheduled" }), signal: AbortSignal.timeout(140000),
        });
        const result = await response.json().catch(() => ({}));
        const row = result.results?.find((x: any) => x.id === job.item_id);
        if (!response.ok || !row?.ok) throw new Error(String(row?.error || result.error || "Preview preparation failed").slice(0, 300));
      }
    } catch (error) { failure = error instanceof Error ? error.message.slice(0, 300) : "Preview preparation failed"; }
    const { data: finished, error: finishError } = await db.rpc("finish_radin_preview", {
      p_item_id: job.item_id, p_lease: job.lease_token, p_error: failure,
    });
    if (finishError || !finished) {
      console.error("Preview completion not committed; lease will retry"); return;
    }
    if (!failure) {
      const result = await db.rpc("fill_radin_publish_queue", { p_admin_chat_ids: adminIds });
      if (result.error) console.error("Publish queue refill failed", result.error.code || "database_error");
    } else {
      await db.from("bot_activity").insert({ event_type: "graphic_failed", item_id: job.item_id,
        actor: "preview_queue", details: { reason: failure, attempt: job.attempts } });
      if (job.attempts >= 3) {
        const token = Deno.env.get("BOT_TOKEN") || "";
        if (token) await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ chat_id: job.chat_id, text: "آماده‌سازی این خبر پس از سه تلاش کامل نشد. خبر ذخیره شده و منتشر نشده است.",
            reply_markup: { inline_keyboard: [[{ text: "🔄 تلاش دوباره", callback_data: "designposter:" + job.item_id }]] } }),
        }).catch(() => console.error("Preview failure notice was not delivered"));
      }
    }
    // Each response ends quickly; a fresh invocation handles the next story.
    // The database lease prevents overlapping renders, including cron retries.
    await fetch(url + "/functions/v1/radin-preview-queue", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key,
        "x-radin-telegram-secret": secret }, body: "{}", signal: AbortSignal.timeout(15000),
    }).catch(() => console.error("Next preview wake-up failed; cron will retry"));
  })().catch(() => console.error("Preview task interrupted; lease will retry")));
  return json({ ok: true, accepted: true, item_id: job.item_id }, 202);
});
