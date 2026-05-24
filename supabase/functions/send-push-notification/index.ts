import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const functionSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "";
  const authorization = req.headers.get("Authorization") || "";

  if (functionSecret && authorization !== `Bearer ${functionSecret}`) {
    return jsonResponse({ error: "UNAUTHORIZED" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@azul.local";

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return jsonResponse({ error: "MISSING_ENV" }, 500);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const body = await req.json().catch(() => ({}));
  const notificationId = body.notification_id || body.id || body.record?.id;

  if (!notificationId) {
    return jsonResponse({ error: "MISSING_NOTIFICATION_ID" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  let notification = body.record || null;

  if (!notification || !notification.organization_id) {
    const { data, error: notificationError } = await supabase
      .from("notifications")
      .select("*")
      .eq("id", notificationId)
      .single();

    if (notificationError || !data) {
      return jsonResponse({ error: "NOTIFICATION_NOT_FOUND", detail: notificationError?.message || "" }, 404);
    }

    notification = data;
  }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("id,user_id,user_role,endpoint,p256dh,auth")
    .eq("organization_id", notification.organization_id)
    .eq("active", true);

  if (subscriptionError) {
    return jsonResponse({ error: "SUBSCRIPTIONS_ERROR", detail: subscriptionError.message }, 500);
  }

  const targetRoles = Array.isArray(notification.target_roles) ? notification.target_roles : [];
  const actorUserId = notification.actor_user_id ? String(notification.actor_user_id) : "";
  const notificationIdText = String(notification.id || notificationId);
  const payload = JSON.stringify({
    title: notification.title || "Azul Gestao",
    body: notification.message || "Nova notificacao",
    icon: "/Assets/icon-192.png",
    badge: "/Assets/icon-192.png",
    tag: `azul-${notificationIdText}`,
    data: {
      url: "/core.html",
      notificationId: notificationIdText,
      sourceType: notification.source_type || ""
    }
  });

  let sent = 0;
  let disabled = 0;
  let failed = 0;

  for (const row of subscriptions || []) {
    const role = String(row.user_role || "").toLowerCase();
    const userId = row.user_id ? String(row.user_id) : "";

    if (targetRoles.length && !targetRoles.includes(role)) continue;
    if (actorUserId && userId && actorUserId === userId) continue;
    if (!row.endpoint || !row.p256dh || !row.auth) continue;

    const pushSubscription = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    };

    try {
      await webpush.sendNotification(pushSubscription, payload, {
        TTL: 300,
        urgency: "high",
        topic: `azul-${notificationIdText}`.slice(0, 32)
      });
      sent += 1;
    } catch (error) {
      const pushError = error as { statusCode?: number; status?: number };
      const statusCode = Number(pushError.statusCode || pushError.status || 0);

      if (statusCode === 404 || statusCode === 410) {
        disabled += 1;
        await supabase
          .from("push_subscriptions")
          .update({ active: false })
          .eq("id", row.id);
      } else {
        failed += 1;
        console.error("Push send failed", error);
      }
    }
  }

  return jsonResponse({ ok: true, sent, disabled, failed });
});
