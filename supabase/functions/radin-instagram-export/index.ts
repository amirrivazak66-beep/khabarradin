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

let fontBuffers: Uint8Array[] = [];
async function ensureFonts() {
  if (fontBuffers.length) return;
  const urls = [
    "https://unpkg.com/vazirmatn@33.0.3/fonts/ttf/Vazirmatn-Regular.ttf",
    "https://unpkg.com/vazirmatn@33.0.3/fonts/ttf/Vazirmatn-Bold.ttf",
  ];
  const loaded: Uint8Array[] = [];
  for (const url of urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Could not load Persian font");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 20000) throw new Error("Persian font file is invalid");
    loaded.push(bytes);
  }
  fontBuffers = loaded;
}

function escSvg(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function wrapHeadline(value: string, maxChars: number) {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function persianDate(value: unknown) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "آخرین اخبار ایران و جهان";
  try {
    return new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-arabext", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran",
    }).format(date);
  } catch {
    return date.toLocaleDateString("fa-IR");
  }
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
    .select("id,title,rewritten_title,summary,original_summary,rewritten_text,graphic_image_url,pub_date,updated_at")
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
    await ensureFonts();
    const imageData = "data:" + imageType + ";base64," + toBase64(imageBytes);
    let logoData = "";
    try {
      const logoResponse = await fetch("https://raw.githubusercontent.com/amirrivazak66-beep/khabarradin/main/%D8%AE%D8%A8%D8%B1-%D8%B1%D8%A7%D8%AF%DB%8C%D9%86.png", {
        signal: AbortSignal.timeout(8000),
      });
      if (logoResponse.ok) {
        const logoBytes = new Uint8Array(await logoResponse.arrayBuffer());
        if (logoBytes.length > 10000 && logoBytes.length < 2000000) {
          logoData = "data:image/png;base64," + toBase64(logoBytes);
        }
      }
    } catch {}

    let storyMaxChars = 24;
    let titleLines = wrapHeadline(cleanTitle, storyMaxChars);
    if (titleLines.length > 3) {
      storyMaxChars = 28;
      titleLines = wrapHeadline(cleanTitle, storyMaxChars);
    }
    if (titleLines.length > 4) {
      storyMaxChars = 32;
      titleLines = wrapHeadline(cleanTitle, storyMaxChars);
    }
    if (titleLines.length > 6) {
      storyMaxChars = 38;
      titleLines = wrapHeadline(cleanTitle, storyMaxChars);
    }
    const headlineFontSize = titleLines.length <= 2 ? 82
      : titleLines.length <= 4 ? 68
      : titleLines.length <= 6 ? 56 : 48;
    const lineHeight = headlineFontSize + 22;
    const headlineCenterY = 1330;
    const headlineSvg = titleLines.map((line, index) => {
      const y = Math.round(headlineCenterY - ((titleLines.length - 1) * lineHeight) / 2 + index * lineHeight);
      const bandY = y - headlineFontSize + 5;
      const bandHeight = headlineFontSize + 18;
      const fill = index === 0 ? "#f3c522" : "#a91e2b";
      const textColor = index === 0 ? "#111111" : "#ffffff";
      return '<path d="M38 ' + (bandY + 8) + ' L82 ' + (bandY - 2) + ' H1000 L1042 ' + (bandY + 9) +
        ' L1028 ' + (bandY + bandHeight) + ' H70 L24 ' + (bandY + bandHeight + 8) + ' Z" fill="' + fill + '"/>' +
        '<text x="540" y="' + y + '" text-anchor="middle" direction="rtl" font-family="Vazirmatn" font-size="' +
        headlineFontSize + '" font-weight="900" fill="' + textColor + '">' + escSvg(line) + "</text>";
    }).join("");

    const dateLabel = escSvg(persianDate(item.pub_date));
    const logoSvg = logoData
      ? '<image href="' + logoData + '" x="900" y="12" width="160" height="150" preserveAspectRatio="xMidYMid meet"/>'
      : '<text x="980" y="100" text-anchor="middle" direction="rtl" font-family="Vazirmatn" font-size="30" font-weight="800" fill="#ffffff">خبر رادین</text>';
    const dotPattern = Array.from({ length: 56 }, (_, i) =>
      '<circle cx="' + (14 + (i % 14) * 26) + '" cy="' + (1710 + Math.floor(i / 14) * 24) + '" r="4"/>'
    ).join("");
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">',
      '<defs><linearGradient id="top" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#3658b2"/><stop offset="1" stop-color="#244695"/></linearGradient><linearGradient id="lower" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#061438" stop-opacity=".82"/><stop offset=".28" stop-color="#061438"/><stop offset="1" stop-color="#03163e"/></linearGradient><linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#fff0a0"/><stop offset=".5" stop-color="#f5bd35"/><stop offset="1" stop-color="#d99a16"/></linearGradient></defs>',
      '<image href="' + imageData + '" x="0" y="0" width="1080" height="1920" preserveAspectRatio="xMidYMid slice"/>',
      '<rect width="1080" height="1920" fill="#03163e" opacity=".14"/>',
      '<rect width="1080" height="250" fill="url(#top)"/>',
      '<path d="M0 244 H1080" stroke="url(#gold)" stroke-width="6"/>',
      '<path d="M700 0 L610 250 H642 L735 0 Z" fill="url(#gold)"/>',
      '<text x="52" y="112" font-family="Arial,sans-serif" font-size="32" font-weight="700" fill="#ffffff">khabarradin.ir</text>',
      '<path d="M300 52 V132" stroke="#ffffff" stroke-opacity=".65" stroke-width="2"/>',
      '<text x="510" y="112" text-anchor="middle" direction="rtl" font-family="Vazirmatn" font-size="29" font-weight="700" fill="#ffffff">' + dateLabel + '</text>',
      logoSvg,
      '<rect x="0" y="970" width="1080" height="720" fill="url(#lower)"/>',
      headlineSvg,
      '<rect x="0" y="1680" width="1080" height="240" fill="#041c51"/>',
      '<path d="M0 1680 H1080" stroke="url(#gold)" stroke-width="7"/>',
      '<g opacity=".18" fill="#1686ff">' + dotPattern + '</g>',
      '<circle cx="82" cy="1790" r="48" fill="#19a8ed"/>',
      '<path d="M50 1790 L114 1764 L100 1815 L80 1801 L67 1811 L70 1795 Z" fill="#ffffff"/>',
      '<text x="150" y="1802" font-family="Arial,sans-serif" font-size="31" font-weight="700" fill="#ffffff">@radinnews</text>',
      '<path d="M355 1754 V1815" stroke="#31c4ff" stroke-width="3"/>',
      '<text x="1020" y="1802" text-anchor="end" direction="rtl" font-family="Vazirmatn" font-size="27" fill="#ffffff">آخرین اخبار ایران و جهان</text>',
      '<path d="M0 1897 Q540 1925 1080 1892" fill="none" stroke="url(#gold)" stroke-width="8"/>',
      '</svg>',
    ].join("");

    const storyPng = new Resvg(svg, {
      fitTo: { mode: "width", value: 1080 },
      font: { fontBuffers, defaultFontFamily: "Vazirmatn", sansSerifFamily: "Vazirmatn", loadSystemFonts: false },
      languages: ["fa", "en"],
      textRendering: 1,
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
