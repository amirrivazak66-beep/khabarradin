import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(block: string, name: string): string {
  const re = new RegExp("<(?:[\\w.-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + name + "\\s*>", "i");
  return decodeXml(block.match(re)?.[1] || "");
}
function parseItems(xml: string, limit: number) {
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)\s*>/gi)].slice(0, limit);
  return blocks.map((m) => {
    const b = m[0];
    const title = tag(b, "title");
    let link = tag(b, "link");
    if (!link) link = b.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || "";
    const description = tag(b, "encoded") || tag(b, "description") || tag(b, "summary") || tag(b, "content");
    const dateText = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "date");
    const rawImage = b.match(/<enclosure\b[^>]*url=["']([^"']+)["']/i)?.[1]
      || b.match(/<media:content\b[^>]*url=["']([^"']+)["']/i)?.[1]
      || b.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || "";
    let safeLink = "";
    let safeImage = "";
    try { const u = new URL(link); if (u.protocol === "https:" || u.protocol === "http:") safeLink = u.toString(); } catch {}
    try { const u = new URL(rawImage); if (u.protocol === "https:" || u.protocol === "http:") safeImage = u.toString(); } catch {}
    const parsedDate = dateText ? new Date(dateText) : new Date();
    return { title: title.slice(0, 500), link: safeLink, summary: description.slice(0, 4000), image: safeImage || null, pubDate: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString() };
  }).filter((x) => x.title && x.link);
}
function hostOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, "").slice(0, 200); } catch { return "منبع خبری"; } }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST required" }), { status: 405, headers: cors });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return new Response(JSON.stringify({ error: "Server configuration missing" }), { status: 500, headers: cors });

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: feeds, error: feedsError } = await db.from("rss_feeds")
    .select("id,category,url,item_count,include_media,update_interval_minutes")
    .eq("enabled", true).order("created_at").limit(100);
  if (feedsError) return new Response(JSON.stringify({ error: "Could not load feeds", detail: feedsError.message }), { status: 500, headers: cors });

  const reports: Array<Record<string, unknown>> = [];
  let totalFetched = 0, totalUpserted = 0;
  for (const feed of feeds || []) {
    try {
      const url = new URL(feed.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported feed protocol");
      const response = await fetch(url.toString(), { headers: { "User-Agent": "KhabarRadinBot/1.0 (+https://khabarradin.ir)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error("Feed HTTP " + response.status);
      const xml = await response.text();
      if (xml.length > 4_000_000) throw new Error("Feed response too large");
      const parsed = parseItems(xml, Math.min(50, Math.max(1, Number(feed.item_count) || 10)));
      const rows = parsed.map((item) => ({
        feed_id: feed.id, category: feed.category || "عمومی", title: item.title,
        summary: item.summary, image_url: feed.include_media === false ? null : item.image,
        source_url: item.link, source_name: hostOf(feed.url), pub_date: item.pubDate,
        published: false, review_status: "pending",
      }));
      if (rows.length) {
        const { error } = await db.from("news_items").upsert(rows, { onConflict: "source_url", ignoreDuplicates: true });
        if (error) throw error;
      }
      await db.from("rss_feeds").update({ last_fetched_at: new Date().toISOString(), last_error: null }).eq("id", feed.id);
      totalFetched += parsed.length; totalUpserted += rows.length;
      reports.push({ feed: hostOf(feed.url), fetched: parsed.length, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 500) : "Unknown feed error";
      await db.from("rss_feeds").update({ last_fetched_at: new Date().toISOString(), last_error: message }).eq("id", feed.id);
      reports.push({ feed: hostOf(feed.url), fetched: 0, ok: false, error: message });
    }
  }
  return new Response(JSON.stringify({ ok: reports.every((r) => r.ok), feeds: reports.length, totalFetched, totalUpserted, reports, note: "Imported stories enter pending review; none are auto-published." }), { status: 200, headers: cors });
});
