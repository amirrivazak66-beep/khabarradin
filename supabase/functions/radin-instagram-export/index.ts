import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { Resvg, initWasm } from "npm:@resvg/resvg-wasm@2.6.2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

let wasmReady: Promise<void> | null = null;
async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const response = await fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm", {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("SVG renderer initialization failed");
      await initWasm(await response.arrayBuffer());
    })();
  }
  await wasmReady;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function cleanCaptionPart(value: unknown) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+|(?:t\.me|telegram\.me)\/[^\s<>]+/gi, " ")
    .replace(/@[a-z0-9_]{3,}/gi, " ")
    .replace(/(?:^|\n)\s*(?:منبع(?:\s+خبر)?|source|لینک(?:\s+خبر)?|آدرس)\s*[:：-].*$/gim, " ")
    .split(/\s+/)
    .filter((token) => token && !/^[\p{Extended_Pictographic}\p{M}\u200d\ufe0f]+$/u.test(token))
    .join(" ")
    .replace(/\s+([،؛,.!?؟])/g, "$1")
    .replace(/([،؛,.!?؟]){2,}/g, "$1")
    .trim();
}

function buildCaption(title: string, body: string) {
  if (!body) return title.slice(0, 2200);
  const maxBody = Math.max(0, 2200 - title.length - 2);
  if (body.length <= maxBody) return title + "\n\n" + body;
  const shortened = body.slice(0, maxBody);
  const lastSpace = shortened.lastIndexOf(" ");
  const cutAt = lastSpace > maxBody * 0.65 ? lastSpace : shortened.length;
  return title + "\n\n" + shortened.slice(0, cutAt).trimEnd() + "…";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const expectedSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") || "";
  const suppliedSecret = req.headers.get("x-radin-telegram-secret") || "";
  if (!expectedSecret || suppliedSecret.length !== expectedSecret.length || suppliedSecret !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json({ error: "Server is not configured" }, 500);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const itemId = String(body?.id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    return json({ error: "شناسه خبر معتبر نیست." }, 400);
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: item, error: itemError } = await db
    .from("news_items")
    .select("id,title,rewritten_title,summary,original_summary,rewritten_text,graphic_image_url,updated_at")
    .eq("id", itemId)
    .maybeSingle();

  if (itemError || !item) return json({ error: "خبر پیدا نشد." }, 404);
  if (!item.graphic_image_url) return json({ error: "پوستر خبر هنوز آماده نیست." }, 409);

  const cleanTitle = cleanCaptionPart(item.rewritten_title || item.title);
  if (!cleanTitle) return json({ error: "تیتر خبر خالی است؛ برای خروجی اینستاگرام تیتر لازم است." }, 409);

  let graphicUrl: URL;
  try {
    graphicUrl = new URL(String(item.graphic_image_url));
  } catch {
    return json({ error: "نشانی پوستر معتبر نیست." }, 422);
  }
  const projectHost = new URL(supabaseUrl).host;
  if (graphicUrl.host !== projectHost || !graphicUrl.pathname.includes("/storage/v1/object/public/radin-graphics/")) {
    return json({ error: "فایل پوستر در فضای ذخیره‌سازی عمومی رادین پیدا نشد." }, 422);
  }

  try {
    const imageResponse = await fetch(graphicUrl, { signal: AbortSignal.timeout(20000) });
    if (!imageResponse.ok) throw new Error("Could not load the approved poster");
    const imageType = (imageResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(imageType)) {
      throw new Error("Approved poster must be PNG, JPEG, or WebP");
    }
    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
    if (imageBytes.byteLength < 50000 || imageBytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("Approved poster size is outside the supported range");
    }

    await ensureWasm();
    const imageData = "data:" + imageType + ";base64," + toBase64(imageBytes);
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">',
      '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#062b79"/><stop offset=".55" stop-color="#041c51"/><stop offset="1" stop-color="#03163e"/></linearGradient><linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#fff0a0"/><stop offset=".5" stop-color="#f5bd35"/><stop offset="1" stop-color="#d99a16"/></linearGradient></defs>',
      '<rect width="1080" height="1920" fill="url(#bg)"/>',
      '<g opacity=".18" fill="#1686ff">' +
        Array.from({ length: 44 }, (_, i) =>
          '<circle cx="' + (36 + (i % 11) * 100) + '" cy="' + (44 + Math.floor(i / 11) * 58) + '" r="5"/>'
        ).join("") +
        '</g>',
      '<path d="M40 298 H1040" stroke="url(#gold)" stroke-width="5"/>',
      '<image href="' + imageData + '" x="40" y="320" width="1000" height="1250" preserveAspectRatio="xMidYMid meet"/>',
      '<path d="M40 1592 H1040" stroke="url(#gold)" stroke-width="5"/>',
      '<g opacity=".18" fill="#1686ff">' +
        Array.from({ length: 44 }, (_, i) =>
          '<circle cx="' + (36 + (i % 11) * 100) + '" cy="' + (1650 + Math.floor(i / 11) * 58) + '" r="5"/>'
        ).join("") +
        '</g>',
      '</svg>',
    ].join("");

    const storyPng = new Resvg(svg, {
      fitTo: { mode: "width", value: 1080 },
      font: { loadSystemFonts: false },
    }).render().asPng();

    if (storyPng.length < 100000) throw new Error("Story rendering produced an incomplete image");

    const storagePath = "instagram/story/" + item.id + "-1080x1920.png";
    const { error: uploadError } = await db.storage
      .from("radin-graphics")
      .upload(storagePath, storyPng, { contentType: "image/png", upsert: true });
    if (uploadError) throw new Error("Could not save the Story image");

    const { data: storyPublic } = db.storage.from("radin-graphics").getPublicUrl(storagePath);
    const bodyText = cleanCaptionPart(item.rewritten_text || item.summary || item.original_summary);
    const caption = buildCaption(cleanTitle, bodyText);

    return json({
      ok: true,
      id: item.id,
      feed_image_url: item.graphic_image_url,
      story_image_url: storyPublic.publicUrl,
      caption,
      feed: { width: 1080, height: 1350, ratio: "4:5" },
      story: { width: 1080, height: 1920, ratio: "9:16" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("Instagram asset export failed", { itemId, error: message });
    return json({ error: "ساخت بسته اینستاگرام ناموفق بود: " + message.slice(0, 240) }, 500);
  }
});
