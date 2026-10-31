import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-radin-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supplied = req.headers.get("x-radin-cron-secret") || "";
  if (!url || !serviceKey || !supplied) return json({ error: "Server configuration missing" }, 500);

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authorized, error: authError } = await db.rpc("verify_radin_cron_secret", { candidate: supplied });
  if (authError || authorized !== true) return json({ error: "Unauthorized" }, 401);

  const { data: settings, error: settingsError } = await db.from("bot_settings")
    .select("auto_publish,channel_username").eq("id", "main").maybeSingle();
  if (settingsError) return json({ error: "Could not load bot settings" }, 500);
  if (settings?.auto_publish !== true) return json({ ok: true, skipped: "scheduled publishing is disabled", results: [] });

  const now = new Date().toISOString();
  const { data: due, error: dueError } = await db.from("news_items")
    .select("id,title,rewritten_title,source_type,scheduled_at,graphic_image_url,original_image_url,review_status")
    .eq("published", false).eq("review_status", "approved").is("telegram_message_id", null)
    .not("scheduled_at", "is", null).lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true }).limit(5);
  if (dueError) return json({ error: "Could not load scheduled stories" }, 500);

  const results: Array<Record<string, unknown>> = [];
  for (const item of due || []) {
    const readyGraphic = /^https?:\/\//i.test(String(item.graphic_image_url || ""));
    const readyOriginal = /^https?:\/\//i.test(String(item.original_image_url || ""));
    const readyHeadline = item.source_type !== "telegram" || Boolean(String(item.rewritten_title || "").trim());
    if (!readyGraphic || !readyOriginal || !readyHeadline) {
      results.push({ id: item.id, ok: false, skipped: "graphic or headline is not ready" });
      continue;
    }
    const { data: claimed, error: claimError } = await db.from("news_items")
      .update({ review_status: "publishing", updated_at: new Date().toISOString() })
      .eq("id", item.id).eq("published", false).eq("review_status", "approved")
      .is("telegram_message_id", null).lte("scheduled_at", now).select("id").maybeSingle();
    if (claimError || !claimed) {
      results.push({ id: item.id, ok: true, skipped: "already claimed" });
      continue;
    }
    try {
      const response = await fetch(url + "/functions/v1/radin-publish-news", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + serviceKey,
          "apikey": serviceKey,
          "Content-Type": "application/json",
          "x-radin-cron-secret": supplied,
        },
        body: JSON.stringify({ id: item.id, action: "publish", scheduled: true }),
        signal: AbortSignal.timeout(60000),
      });
      let payload: any = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok || payload.ok !== true) {
        const reason = String(payload.error || payload.detail || "scheduled publish failed").slice(0, 300);
        await db.from("news_items").update({ review_status: "approved", updated_at: new Date().toISOString() })
          .eq("id", item.id).eq("published", false).eq("review_status", "publishing");
        await db.from("bot_activity").insert({
          event_type: "schedule_publish_failed", item_id: item.id, actor: "scheduler",
          details: { title: item.rewritten_title || item.title, error: reason },
        });
        results.push({ id: item.id, ok: false, error: reason });
      } else {
        results.push({ id: item.id, ok: true, message_id: payload.message_id || null, warning: payload.warning || null });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
      await db.from("news_items").update({ review_status: "approved", updated_at: new Date().toISOString() })
        .eq("id", item.id).eq("published", false).eq("review_status", "publishing");
      await db.from("bot_activity").insert({
        event_type: "schedule_publish_failed", item_id: item.id, actor: "scheduler",
        details: { title: item.rewritten_title || item.title, error: reason },
      });
      results.push({ id: item.id, ok: false, error: reason });
    }
  }
  return json({ ok: results.every((x) => x.ok), processed: results.length, results });
});
