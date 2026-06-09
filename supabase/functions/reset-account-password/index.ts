import { createClient } from "npm:@supabase/supabase-js@2";

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

function normalizeText(value: unknown) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeLicense(value: unknown) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "SERVER_CONFIGURATION_ERROR" }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const email = normalizeText(body.email);
  const licenseKey = normalizeLicense(body.license_key);
  const storeName = normalizeText(body.store_name);
  const password = String(body.new_password || "");

  if (!email || !email.includes("@") || !licenseKey || !storeName) {
    return jsonResponse({ error: "INVALID_INFORMATION" }, 400);
  }

  if (password.length < 8) {
    return jsonResponse({ error: "PASSWORD_TOO_SHORT" }, 400);
  }

  const forwardedFor = req.headers.get("x-forwarded-for") || "";
  const clientIp = forwardedFor.split(",")[0].trim() || "unknown";
  const fingerprint = await sha256(`${email}|${clientIp}`);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { count: recentAttempts, error: attemptsError } = await supabase
    .from("password_reset_attempts")
    .select("id", { count: "exact", head: true })
    .eq("fingerprint", fingerprint)
    .gte("created_at", cutoff);

  if (attemptsError) {
    console.error("Password recovery attempts lookup failed", attemptsError);
    return jsonResponse({ error: "SERVER_ERROR" }, 500);
  }

  if (Number(recentAttempts || 0) >= 5) {
    return jsonResponse({ error: "TOO_MANY_ATTEMPTS" }, 429);
  }

  async function registerAttempt(success: boolean) {
    const { error } = await supabase
      .from("password_reset_attempts")
      .insert({ fingerprint, success });

    if (error) console.error("Password recovery attempt insert failed", error);
  }

  try {
    const { data: license, error: licenseError } = await supabase
      .from("licenses")
      .select("organization_id,status,expires_at")
      .ilike("license_key", licenseKey)
      .maybeSingle();

    if (
      licenseError ||
      !license ||
      !license.organization_id ||
      ["inactive", "suspended", "blocked"].includes(normalizeText(license.status)) ||
      (license.expires_at && new Date(license.expires_at).getTime() < Date.now())
    ) {
      await registerAttempt(false);
      return jsonResponse({ error: "INVALID_INFORMATION" }, 400);
    }

    const organizationId = String(license.organization_id);
    const { data: organization, error: organizationError } = await supabase
      .from("organizations")
      .select("id,name,status")
      .eq("id", organizationId)
      .maybeSingle();

    if (
      organizationError ||
      !organization ||
      normalizeText(organization.name) !== storeName ||
      ["inactive", "suspended", "blocked"].includes(normalizeText(organization.status))
    ) {
      await registerAttempt(false);
      return jsonResponse({ error: "INVALID_INFORMATION" }, 400);
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("auth_user_id,email,status")
      .eq("organization_id", organizationId)
      .ilike("email", email)
      .limit(1)
      .maybeSingle();

    if (profileError || !profile || !profile.auth_user_id) {
      await registerAttempt(false);
      return jsonResponse({ error: "INVALID_INFORMATION" }, 400);
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(
      String(profile.auth_user_id),
      { password }
    );

    if (updateError) {
      console.error("Password recovery update failed", updateError);
      await registerAttempt(false);
      return jsonResponse({ error: "PASSWORD_UPDATE_FAILED" }, 500);
    }

    await registerAttempt(true);
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error("Password recovery failed", error);
    await registerAttempt(false);
    return jsonResponse({ error: "SERVER_ERROR" }, 500);
  }
});
