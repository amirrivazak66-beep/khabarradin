import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const APP_ORIGIN = "https://amirrivazak66-beep.github.io";
const MAX_INIT_AGE_SECONDS = 60 * 60;
const SESSION_TTL_SECONDS = 30 * 60;
const TELEGRAM_PRODUCTION_ED25519_KEY = "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d";
const encoder = new TextEncoder();

const json = (body: unknown, status = 200, origin = APP_ORIGIN) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "apikey, authorization, content-type, x-client-info",
      "access-control-allow-methods": "POST, OPTIONS",
      "vary": "Origin",
    },
  });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const fromBase64url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const jwtClaims = (token: string) => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    return null;
  }
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
};

const hmac = async (keyBytes: Uint8Array, message: string) => {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
};

const hexBytes = (value: string) =>
  Uint8Array.from(value.match(/.{2}/g) || [], (pair) => Number.parseInt(pair, 16));

const getTelegramBotId = async (botToken: string) => {
  try {
    const response = await fetch("https://api.telegram.org/bot" + botToken + "/getMe", {
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    const botId = String(result?.result?.id ?? "");
    return response.ok && result?.ok === true && /^\d{1,16}$/.test(botId) ? botId : null;
  } catch {
    return null;
  }
};

const verifyTelegramThirdPartySignature = async (values: Map<string, string>, botId: string) => {
  const signature = values.get("signature") || "";
  if (!signature || !/^[A-Za-z0-9_-]+={0,2}$/.test(signature)) return false;
  try {
    const dataCheckString = botId + ":WebAppData\n" + [...values.entries()]
      .filter(([key]) => key !== "hash" && key !== "signature")
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => key + "=" + value)
      .join("\n");
    const publicKey = await crypto.subtle.importKey(
      "raw", hexBytes(TELEGRAM_PRODUCTION_ED25519_KEY), { name: "Ed25519" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" }, publicKey, fromBase64url(signature), encoder.encode(dataCheckString),
    );
  } catch (error) {
    console.error("Telegram Ed25519 verification failed", String((error as Error)?.name || "unknown"));
    return false;
  }
};

const verifyTelegramInitData = async (raw: string, botToken: string) => {
  if (!raw || raw.length > 12000) return null;
  const params = new URLSearchParams(raw);
  const values = new Map<string, string>();
  for (const [key, value] of params.entries()) {
    if (values.has(key)) return null;
    values.set(key, value);
  }
  const receivedHash = values.get("hash") || "";
  const authDate = Number(values.get("auth_date"));
  const userRaw = values.get("user") || "";
  const now = Math.floor(Date.now() / 1000);
  if (!/^[0-9a-f]{64}$/i.test(receivedHash) ||
      !Number.isInteger(authDate) ||
      authDate > now + 60 ||
      now - authDate > MAX_INIT_AGE_SECONDS ||
      !userRaw) return null;

  const sortDataCheckString = (excludeSignature: boolean) => [...values.entries()]
    .filter(([key]) => key !== "hash" && (!excludeSignature || key !== "signature"))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const dataCheckStrings = [sortDataCheckString(false)];
  if (values.has("signature")) dataCheckStrings.push(sortDataCheckString(true));
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  let validHash = false;
  for (const dataCheckString of dataCheckStrings) {
    const expectedHash = hex(await hmac(secret, dataCheckString));
    if (constantTimeEqual(receivedHash.toLowerCase(), expectedHash)) {
      validHash = true;
      break;
    }
  }
  let verifiedBy: "hmac" | "ed25519" = "hmac";
  if (!validHash) {
    if (!values.has("signature")) return null;
    const botId = await getTelegramBotId(botToken);
    if (!botId || !await verifyTelegramThirdPartySignature(values, botId)) return null;
    verifiedBy = "ed25519";
  }

  try {
    const user = JSON.parse(userRaw);
    const userId = String(user?.id ?? "");
    if (!/^[1-9]\d{0,19}$/.test(userId)) return null;
    return {
      userId,
      firstName: String(user?.first_name || "").slice(0, 128),
      lastName: String(user?.last_name || "").slice(0, 128),
      username: String(user?.username || "").slice(0, 64),
      authDate,
      verifiedBy,
    };
  } catch {
    return null;
  }
};

const encodeJson = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

const createSession = async (userId: string, serviceKey: string) => {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({ aud: "radin-account-portal", sub: userId, iat: now, exp: now + SESSION_TTL_SECONDS });
  const unsigned = header + "." + payload;
  const signature = base64url(await hmac(encoder.encode(serviceKey), unsigned));
  return unsigned + "." + signature;
};

const verifySession = async (token: string, serviceKey: string) => {
  if (!token || token.length > 4000) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const unsigned = parts[0] + "." + parts[1];
  const expected = base64url(await hmac(encoder.encode(serviceKey), unsigned));
  if (!constantTimeEqual(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (payload?.aud !== "radin-account-portal" ||
        !/^[1-9]\d{0,19}$/.test(String(payload?.sub || "")) ||
        !Number.isInteger(payload?.iat) ||
        !Number.isInteger(payload?.exp) ||
        payload.iat > now + 30 ||
        payload.exp <= now ||
        payload.exp - payload.iat > SESSION_TTL_SECONDS) return null;
    return { userId: String(payload.sub), expiresAt: payload.exp };
  } catch {
    return null;
  }
};

const adminIds = () => {
  const configured = (Deno.env.get("ADMIN_USER_IDS") || "")
    .split(",").map((value) => value.trim()).filter((value) => /^[1-9]\d{0,19}$/.test(value));
  return new Set([...configured, "9129058355", "269401462"]);
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin !== APP_ORIGIN) return new Response("Forbidden", { status: 403 });
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: {
      "access-control-allow-origin": APP_ORIGIN,
      "access-control-allow-headers": "apikey, authorization, content-type, x-client-info",
      "access-control-allow-methods": "POST, OPTIONS",
      "vary": "Origin",
    },
  });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const botToken = Deno.env.get("BOT_TOKEN");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!botToken || !projectUrl || !serviceKey) return json({ ok: false, error: "server_not_configured" }, 500);

  let body: any;
  try {
    const rawBody = await req.text();
    if (rawBody.length > 64_000) return json({ ok: false, error: "request_too_large" }, 413);
    body = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const db = createClient(projectUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const writeSecurityEvent = async (
    eventType: string,
    actorId: string | null,
    subjectId: string | null,
    details: Record<string, unknown> = {},
  ) => {
    const { error } = await db.from("telegram_security_events").insert({
      event_type: eventType,
      actor_user_id: actorId,
      subject_user_id: subjectId,
      details,
    });
    if (error) console.error("Portal security event write failed", eventType, error.message);
  };

  const action = String(body?.action || "");
  const getBearerToken = () => {
    const authorization = req.headers.get("authorization") || "";
    return authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  };
  const authorizeWebAdmin = async (token: string) => {
    if (!token || token.length > 4000) return { ok: false as const, status: 401, error: "session_invalid" };
    const { data, error } = await db.auth.getUser(token);
    const user = data?.user;
    if (error || !user) return { ok: false as const, status: 401, error: "session_invalid" };
    const email = String(user.email || "").trim().toLowerCase();
    if (!email || !user.email_confirmed_at) {
      return { ok: false as const, status: 403, error: "admin_email_unverified" };
    }
    const { data: allowlisted, error: allowlistError } = await db.from("web_admin_emails")
      .select("email").eq("email", email).eq("active", true).maybeSingle();
    if (allowlistError) {
      console.error("Web admin allowlist lookup failed", allowlistError.message);
      return { ok: false as const, status: 500, error: "admin_auth_unavailable" };
    }
    if (!allowlisted) return { ok: false as const, status: 403, error: "admin_not_allowed" };
    const claims = jwtClaims(token) || {};
    const aal = String(claims.aal || "aal1");
    const methods = Array.isArray(claims.amr) ? claims.amr : [];
    const emailOtp = aal === "aal1" && methods.some((entry: unknown) =>
      !!entry && typeof entry === "object" && (entry as Record<string, unknown>).method === "otp"
    );
    return { ok: true as const, email, userId: String(user.id), aal, adminAuthAllowed: aal === "aal2" || emailOtp };
  };

  if (action === "web_admin_check") {
    const webAdmin = await authorizeWebAdmin(getBearerToken());
    if (!webAdmin.ok) return json({ ok: false, error: webAdmin.error }, webAdmin.status);
    return json({ ok: true, admin: true, email: webAdmin.email, mfaRequired: !webAdmin.adminAuthAllowed });
  }

  let userId = "";
  let sessionToken = "";
  let webAdminEmail = "";
  let isWebAdmin = false;
  if (action === "bootstrap") {
    const rawInitData = String(body?.initData || "");
    const identity = await verifyTelegramInitData(rawInitData, botToken);
    if (!identity) {
      const params = new URLSearchParams(rawInitData);
      const authDate = Number(params.get("auth_date"));
      const now = Math.floor(Date.now() / 1000);
      const reason = !rawInitData ? "missing_init_data"
        : !params.get("hash") ? "missing_hash"
        : !params.get("user") ? "missing_user"
        : !Number.isInteger(authDate) ? "invalid_auth_date"
        : authDate > now + 60 ? "future_auth_date"
        : now - authDate > MAX_INIT_AGE_SECONDS ? "stale_auth_date"
        : "signature_or_data_mismatch";
      console.warn("Telegram Mini App authentication rejected", {
        reason,
        signaturePresent: params.has("signature"),
        initDataLength: rawInitData.length,
        ageSeconds: Number.isInteger(authDate) ? now - authDate : null,
      });
      return json({ ok: false, error: "telegram_auth_invalid" }, 401);
    }
    userId = identity.userId;
    const isAdmin = adminIds().has(userId);
    if (!isAdmin) {
      const { data: account, error } = await db.from("telegram_trial_accounts")
        .select("telegram_user_id,chat_id,consent_at")
        .eq("telegram_user_id", userId).maybeSingle();
      if (error) {
        console.error("Portal account lookup failed", error.message);
        return json({ ok: false, error: "account_lookup_failed" }, 500);
      }
      if (!account || !account.consent_at || String(account.chat_id) !== userId) {
        return json({ ok: true, registrationRequired: true });
      }
    }
    sessionToken = await createSession(userId, serviceKey);
    await writeSecurityEvent("session_started", userId, userId, {
      via: "telegram_mini_app",
      authentication_method: identity.verifiedBy,
    });
  } else {
    const token = getBearerToken();
    const verified = !action.startsWith("web_admin_") ? await verifySession(token, serviceKey) : null;
    if (verified) {
      userId = verified.userId;
    } else {
      if (!action.startsWith("web_admin_")) return json({ ok: false, error: "session_invalid" }, 401);
      const webAdmin = await authorizeWebAdmin(token);
      if (!webAdmin.ok) return json({ ok: false, error: webAdmin.error }, webAdmin.status);
      if (!webAdmin.adminAuthAllowed) return json({ ok: false, error: "admin_mfa_required" }, 403);
      webAdminEmail = webAdmin.email;
      isWebAdmin = true;
      // A non-Telegram identity must not be used as a Telegram bigint actor.
      userId = "0";
    }
  }

  const isAdmin = isWebAdmin || adminIds().has(userId);
  const accountQuery = await db.from("telegram_trial_accounts")
    .select("telegram_user_id,chat_id,first_name,last_name,username,consent_at,phone_verified_at,trial_started_at,trial_expires_at")
    .eq("telegram_user_id", userId).maybeSingle();
  if (accountQuery.error) {
    console.error("Portal account detail lookup failed", accountQuery.error.message);
    return json({ ok: false, error: "account_lookup_failed" }, 500);
  }
  const account = accountQuery.data;
  if (!isAdmin && account && String(account.chat_id) !== userId) {
    return json({ ok: false, error: "account_identity_mismatch" }, 403);
  }

  const getAccess = async () => {
    if (!account?.phone_verified_at) return { kind: "unverified", active: false, expiresAt: null };
    if (account.trial_expires_at && Date.parse(account.trial_expires_at) > Date.now()) {
      return { kind: "trial", active: true, expiresAt: account.trial_expires_at };
    }
    const { data, error } = await db.from("telegram_access_grants")
      .select("id,chat_id,expires_at,created_at")
      .eq("telegram_user_id", userId).eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      console.error("Portal access lookup failed", error.message);
      throw new Error("Access lookup failed");
    }
    if (data && String(data.chat_id) === userId) {
      return { kind: "one_hour", active: true, expiresAt: data.expires_at };
    }
    return account.trial_expires_at
      ? { kind: "expired", active: false, expiresAt: account.trial_expires_at }
      : { kind: "inactive", active: false, expiresAt: null };
  };

  const loadAdminPanel = async () => {
    const [usersResult, requestsResult, grantsResult, eventsResult] = await Promise.all([
      db.from("telegram_trial_accounts")
        .select("telegram_user_id,chat_id,first_name,last_name,username,consent_at,phone_verified_at,trial_expires_at,updated_at")
        .order("updated_at", { ascending: false }).limit(100),
      db.from("telegram_access_requests")
        .select("id,telegram_user_id,chat_id,requested_minutes,status,created_at,decided_at,decided_by,decided_by_web_email,decision_reason")
        .order("created_at", { ascending: false }).limit(100),
      db.from("telegram_access_grants")
        .select("id,telegram_user_id,chat_id,request_id,status,starts_at,expires_at,created_at,created_by,created_by_web_email,revoked_at,revoked_by,revoked_by_web_email,revoke_reason")
        .order("created_at", { ascending: false }).limit(100),
      db.from("telegram_security_events")
        .select("id,actor_user_id,subject_user_id,event_type,details,created_at")
        .order("created_at", { ascending: false }).limit(100),
    ]);
    const failed = [usersResult, requestsResult, grantsResult, eventsResult].find((result) => result.error);
    if (failed?.error) {
      console.error("Portal admin data lookup failed", failed.error.message);
      throw new Error("Admin data lookup failed");
    }
    return {
      users: usersResult.data || [],
      requests: requestsResult.data || [],
      grants: grantsResult.data || [],
      securityEvents: eventsResult.data || [],
    };
  };

  const loadDashboard = async () => {
    if (isAdmin) {
      const adminPanel = await loadAdminPanel();
      return {
        ok: true,
        admin: true,
        account: account ? {
          telegramUserId: userId,
          firstName: account.first_name,
          lastName: account.last_name,
          username: account.username,
        } : { telegramUserId: userId, firstName: "", lastName: "", username: "" },
        access: { kind: "admin", active: true, expiresAt: null },
        newsItems: [],
        activity: [],
        requests: [],
        adminPanel,
      };
    }
    if (!account || !account.consent_at) {
      return { ok: true, registrationRequired: true };
    }

    const access = await getAccess();
    let newsItems: any[] = [];
    let activity: any[] = [];
    let requests: any[] = [];
    if (account.phone_verified_at) {
      const itemsResult = await db.from("news_items")
        .select("id,title,rewritten_title,review_status,published,created_at,scheduled_at,graphic_image_url")
        .eq("telegram_chat_id", userId)
        .order("created_at", { ascending: false }).limit(20);
      if (itemsResult.error) {
        console.error("Portal user news lookup failed", itemsResult.error.message);
        throw new Error("User data lookup failed");
      }
      newsItems = itemsResult.data || [];
      const itemIds = newsItems.map((item: any) => item.id).filter(Boolean);
      if (itemIds.length) {
        const activityResult = await db.from("bot_activity")
          .select("item_id,event_type,actor,created_at")
          .in("item_id", itemIds)
          .order("created_at", { ascending: false }).limit(60);
        if (activityResult.error) {
          console.error("Portal user activity lookup failed", activityResult.error.message);
          throw new Error("User activity lookup failed");
        }
        activity = activityResult.data || [];
      }
      const requestResult = await db.from("telegram_access_requests")
        .select("id,requested_minutes,status,created_at,decided_at,decision_reason")
        .eq("telegram_user_id", userId)
        .order("created_at", { ascending: false }).limit(10);
      if (requestResult.error) {
        console.error("Portal user request lookup failed", requestResult.error.message);
        throw new Error("User request lookup failed");
      }
      requests = requestResult.data || [];
    }

    return {
      ok: true,
      admin: false,
      account: {
        telegramUserId: userId,
        firstName: account.first_name,
        lastName: account.last_name,
        username: account.username,
        phoneVerifiedAt: account.phone_verified_at,
        trialStartedAt: account.trial_started_at,
        trialExpiresAt: account.trial_expires_at,
      },
      access,
      newsItems,
      activity,
      requests,
    };
  };

  try {
    if (action === "web_admin_dashboard") {
      if (!isWebAdmin) return json({ ok: false, error: "admin_only" }, 403);
      await writeSecurityEvent("session_started", null, null, { via: "web_admin", email: webAdminEmail });
      return json({ ok: true, adminPanel: await loadAdminPanel() });
    }

    if (action === "web_admin_decide_request") {
      const requestId = String(body?.requestId || "");
      const decision = body?.decision;
      if (!isWebAdmin || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
          (decision !== "approve" && decision !== "reject")) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const { error } = await db.rpc("decide_telegram_access_request_web", {
        p_request_id: requestId,
        p_admin_email: webAdminEmail,
        p_approved: decision === "approve",
        p_reason: String(body?.reason || "").slice(0, 240) || null,
      });
      if (error) {
        console.error("Web admin decision failed", error.message);
        return json({ ok: false, error: "request_decision_failed" }, 409);
      }
      return json({ ok: true, adminPanel: await loadAdminPanel() });
    }

    if (action === "web_admin_revoke_grant") {
      const grantId = String(body?.grantId || "");
      if (!isWebAdmin || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const { error } = await db.rpc("revoke_telegram_access_grant_web", {
        p_grant_id: grantId,
        p_admin_email: webAdminEmail,
        p_reason: String(body?.reason || "لغو از پنل وب مدیر").slice(0, 240),
      });
      if (error) {
        console.error("Web admin access revoke failed", error.message);
        return json({ ok: false, error: "grant_revoke_failed" }, 409);
      }
      return json({ ok: true, adminPanel: await loadAdminPanel() });
    }

    if (action === "request_one_hour") {
      if (isAdmin) return json({ ok: false, error: "admin_access_is_unlimited" }, 400);
      if (!account?.phone_verified_at || String(account.chat_id) !== userId) {
        await writeSecurityEvent("admin_denied", userId, userId, { action: "request_one_hour", reason: "account_unverified" });
        return json({ ok: false, error: "phone_verification_required" }, 403);
      }
      const access = await getAccess();
      if (access.active) return json({ ok: false, error: "access_already_active" }, 409);
      const pending = await db.from("telegram_access_requests")
        .select("id").eq("telegram_user_id", userId).eq("status", "pending").maybeSingle();
      if (pending.error) throw new Error("Request lookup failed");
      let requestId = pending.data?.id;
      if (!requestId) {
        const created = await db.from("telegram_access_requests").insert({
          telegram_user_id: userId,
          chat_id: account.chat_id,
          requested_minutes: 60,
          status: "pending",
        }).select("id").maybeSingle();
        if (created.error || !created.data) {
          await writeSecurityEvent("access_request_created", userId, userId, { outcome: "duplicate_or_failed" });
          return json({ ok: false, error: "request_already_pending_or_failed" }, 409);
        }
        requestId = created.data.id;
        await writeSecurityEvent("access_request_created", userId, userId, { request_id: requestId, minutes: 60 });
      }
      const dashboard = await loadDashboard();
      return json({ ok: true, dashboard, requestId });
    }

    if (action === "decide_request") {
      if (!isAdmin) {
        await writeSecurityEvent("admin_denied", userId, null, { action: "decide_request" });
        return json({ ok: false, error: "admin_only" }, 403);
      }
      const requestId = String(body?.requestId || "");
      const approved = body?.decision === "approve";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
          (body?.decision !== "approve" && body?.decision !== "reject")) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const reason = String(body?.reason || "").slice(0, 240);
      const { error } = await db.rpc("decide_telegram_access_request", {
        p_request_id: requestId,
        p_admin_user_id: userId,
        p_approved: approved,
        p_reason: reason || null,
      });
      if (error) {
        console.error("Portal admin decision failed", error.message);
        return json({ ok: false, error: "request_decision_failed" }, 409);
      }
      return json({ ok: true, dashboard: await loadDashboard() });
    }

    if (action === "revoke_grant") {
      if (!isAdmin) {
        await writeSecurityEvent("admin_denied", userId, null, { action: "revoke_grant" });
        return json({ ok: false, error: "admin_only" }, 403);
      }
      const grantId = String(body?.grantId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const { error } = await db.rpc("revoke_telegram_access_grant", {
        p_grant_id: grantId,
        p_admin_user_id: userId,
        p_reason: String(body?.reason || "لغو توسط مدیر").slice(0, 240),
      });
      if (error) {
        console.error("Portal access revoke failed", error.message);
        return json({ ok: false, error: "grant_revoke_failed" }, 409);
      }
      return json({ ok: true, dashboard: await loadDashboard() });
    }

    if (action !== "bootstrap" && action !== "dashboard") {
      return json({ ok: false, error: "unknown_action" }, 400);
    }
    return json({
      ok: true,
      sessionToken: action === "bootstrap" ? sessionToken : undefined,
      dashboard: await loadDashboard(),
    });
  } catch (error) {
    console.error("Radin account portal request failed", String(error));
    return json({ ok: false, error: "portal_request_failed" }, 500);
  }
});