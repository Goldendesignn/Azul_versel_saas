import { createClient } from "npm:@supabase/supabase-js@2";

type FiscalDocument = {
  id: string;
  organization_id: string;
  document_type: string;
  series_code: string;
  document_number: string;
  issued_at: string;
  operation_date: string;
  customer_snapshot: Record<string, unknown>;
  totals_snapshot: Record<string, unknown>;
  tax_summary: Record<string, unknown>;
  lines_snapshot: Array<Record<string, unknown>>;
  signature_value: string | null;
  signature_key_version: number | null;
};

const encoder = new TextEncoder();

function origins() {
  return (Deno.env.get("AZUL_ALLOWED_ORIGINS") || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
}

function cors(request: Request) {
  const origin = request.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
  if (origins().includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function reply(request: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(request), "Content-Type": "application/json" }
  });
}

function xml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function tag(name: string, value: unknown) {
  return `<${name}>${xml(value)}</${name}>`;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  return number(value).toFixed(2);
}

function base64Bytes(value: string) {
  const binary = atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function injectedKey(name: "SUPABASE_PUBLISHABLE_KEYS" | "SUPABASE_SECRET_KEYS", legacy: string) {
  const modern = Deno.env.get(name);
  return modern ? JSON.parse(modern).default as string : (Deno.env.get(legacy) || "");
}

function luandaTime(value: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Africa/Luanda", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value)).replace(" ", "T");
}

function signable(document: FiscalDocument) {
  return ["invoice", "invoice_receipt", "credit_note", "debit_note", "proforma"].includes(document.document_type);
}

function documentType(type: string) {
  return ({ invoice: "FT", invoice_receipt: "FR", credit_note: "NC", debit_note: "ND" } as Record<string, string>)[type] || "PP";
}

async function signingKey() {
  const secret = Deno.env.get("AZUL_SAFT_RSA_PRIVATE_KEY_PKCS8_BASE64") || "";
  if (!secret) throw new Error("SAFT_SIGNING_NOT_CONFIGURED");
  return crypto.subtle.importKey("pkcs8", base64Bytes(secret), {
    name: "RSASSA-PKCS1-v1_5", hash: "SHA-1"
  }, false, ["sign"]);
}

async function signPending(admin: ReturnType<typeof createClient>, organizationId: string, endDate: string) {
  const key = await signingKey();
  const keyVersion = Number(Deno.env.get("AZUL_SAFT_KEY_VERSION") || "1");
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new Error("SAFT_KEY_VERSION_INVALID");
  const { data, error } = await admin.from("fiscal_documents")
    .select("id,organization_id,document_type,series_code,document_number,issued_at,operation_date,customer_snapshot,totals_snapshot,tax_summary,lines_snapshot,signature_value,signature_key_version")
    .eq("organization_id", organizationId).lte("operation_date", endDate).order("issued_at", { ascending: true });
  if (error) throw error;

  const previous = new Map<string, string>();
  for (const row of (data || []) as FiscalDocument[]) {
    if (!signable(row)) continue;
    const keyName = `${row.document_type}:${row.series_code}`;
    const predecessor = previous.get(keyName) || "";
    if (row.signature_value) {
      previous.set(keyName, row.signature_value);
      continue;
    }
    const grossTotal = money(row.tax_summary?.grand_total ?? row.totals_snapshot?.total);
    const payload = `${String(row.operation_date).slice(0, 10)};${luandaTime(row.issued_at)};${row.document_number};${grossTotal};${predecessor}`;
    const signature = toBase64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(payload)));
    const { error: signError } = await admin.rpc("record_saft_document_signature", {
      p_document_id: row.id, p_signature_value: signature, p_key_version: keyVersion, p_signed_payload: payload
    });
    if (signError) throw signError;
    previous.set(keyName, signature);
  }
}

function billingXml(profile: Record<string, unknown>, documents: FiscalDocument[], from: string, to: string) {
  const customers = new Map<string, Record<string, unknown>>();
  documents.forEach((row) => customers.set(String(row.customer_snapshot?.nif || "999999990"), row.customer_snapshot || {}));
  const header = [
    tag("AuditFileVersion", "AO-TECHNICAL-DRAFT"), tag("CompanyID", profile.nif),
    tag("TaxRegistrationNumber", profile.nif), tag("CompanyName", profile.legal_name),
    tag("StartDate", from), tag("EndDate", to), tag("CurrencyCode", "AOA"),
    tag("DateCreated", new Date().toISOString().slice(0, 10)), tag("ProductCompanyTaxID", "Azul Gestao"),
    tag("ProductVersion", Deno.env.get("AZUL_SAFT_PRODUCT_VERSION") || "azul-saas"),
    tag("SoftwareCertificateNumber", Deno.env.get("AZUL_SAFT_SOFTWARE_VALIDATION_NUMBER") || "PENDING_AGT_VALIDATION")
  ].join("");
  const customerRows = Array.from(customers.entries()).map(([id, customer]) =>
    `<Customer>${tag("CustomerID", id)}${tag("AccountID", "Desconhecido")}${tag("CustomerTaxID", id)}${tag("CompanyName", customer.name || "Consumidor final")}</Customer>`
  ).join("");
  const invoices = documents.filter((row) => ["invoice", "invoice_receipt", "credit_note", "debit_note"].includes(row.document_type)).map((row) => {
    const tax = row.tax_summary || {};
    const lines = (row.lines_snapshot || []).map((line, index) =>
      `<Line>${tag("LineNumber", index + 1)}${tag("ProductCode", line.product_id || line.description || "SERVICO")}${tag("ProductDescription", line.description || "")}${tag("Quantity", number(line.quantity))}${tag("UnitOfMeasure", line.unit || "un")}${tag("UnitPrice", money(line.unit_price))}${tag("CreditAmount", money(line.total))}</Line>`
    ).join("");
    return `<Invoice>${tag("InvoiceNo", row.document_number)}${tag("InvoiceStatus", "N")}${tag("InvoiceDate", String(row.operation_date).slice(0, 10))}${tag("InvoiceType", documentType(row.document_type))}${tag("CustomerID", row.customer_snapshot?.nif || "999999990")}${tag("SystemEntryDate", luandaTime(row.issued_at))}${tag("Hash", row.signature_value || "")}${tag("HashControl", row.signature_key_version || "")}${lines}<DocumentTotals>${tag("TaxPayable", money(tax.vat_amount))}${tag("NetTotal", money(tax.taxable_amount ?? row.totals_snapshot?.total))}${tag("GrossTotal", money(tax.grand_total ?? row.totals_snapshot?.total))}</DocumentTotals></Invoice>`;
  }).join("");
  const work = documents.filter((row) => row.document_type === "proforma").map((row) =>
    `<WorkDocument>${tag("DocumentNumber", row.document_number)}${tag("WorkDate", String(row.operation_date).slice(0, 10))}${tag("WorkType", "PP")}${tag("SystemEntryDate", luandaTime(row.issued_at))}${tag("Hash", row.signature_value || "")}${tag("HashControl", row.signature_key_version || "")}<DocumentTotals>${tag("GrossTotal", money(row.totals_snapshot?.total))}</DocumentTotals></WorkDocument>`
  ).join("");
  const payments = documents.filter((row) => row.document_type === "receipt").map((row) =>
    `<Payment>${tag("PaymentRefNo", row.document_number)}${tag("TransactionDate", String(row.operation_date).slice(0, 10))}${tag("SystemEntryDate", luandaTime(row.issued_at))}<DocumentTotals>${tag("GrossTotal", money(row.totals_snapshot?.total))}</DocumentTotals></Payment>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><AuditFile><Header>${header}</Header><MasterFiles>${customerRows}</MasterFiles><SourceDocuments><SalesInvoices>${invoices}</SalesInvoices><WorkingDocuments>${work}</WorkingDocuments><Payments>${payments}</Payments></SourceDocuments></AuditFile>`;
}

function inventoryXml(profile: Record<string, unknown>, products: Array<Record<string, unknown>>, year: string) {
  const stock = products.map((product) => {
    const quantity = number(product.stock_warehouse) + number(product.stock_shop);
    return `<Stock>${tag("ProductType", product.saft_product_type || "M")}${tag("ProductCode", product.code)}${tag("ProductDescription", product.name)}${tag("Quantity", quantity)}${tag("UnitOfMeasure", product.unit)}${tag("Value", money(quantity * number(product.purchase_price)))}</Stock>`;
  }).join("");
  const header = [tag("CompanyID", profile.nif), tag("TaxRegistrationNumber", profile.nif), tag("CompanyName", profile.legal_name), tag("DateCreated", new Date().toISOString().slice(0, 10)), tag("SoftwareValidationNumber", Deno.env.get("AZUL_SAFT_SOFTWARE_VALIDATION_NUMBER") || "PENDING_AGT_VALIDATION"), tag("ProductID", "Azul Gestao"), tag("ProductVersion", Deno.env.get("AZUL_SAFT_PRODUCT_VERSION") || "azul-saas"), tag("AAAA", year), tag("CostingMethod", "CMP")].join("");
  return `<?xml version="1.0" encoding="UTF-8"?><StockFile><StockHeader>${header}</StockHeader><StockList>${stock}</StockList></StockFile>`;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(request) });
  if (request.method !== "POST") return reply(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  if (!origins().includes(request.headers.get("origin") || "")) return reply(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = injectedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const secretKey = injectedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("authorization") || "";
  if (!url || !publishableKey || !secretKey || !authorization.startsWith("Bearer ")) return reply(request, { error: "SERVER_CONFIGURATION_ERROR" }, 500);

  const user = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } } });
  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await user.auth.getUser();
  if (userError || !userData.user) return reply(request, { error: "UNAUTHENTICATED" }, 401);

  const body = await request.json().catch(() => ({}));
  const organizationId = String(body.organization_id || "");
  const exportType = String(body.export_type || "billing");
  const from = String(body.period_from || "").slice(0, 10);
  const to = String(body.period_to || "").slice(0, 10);
  if (!organizationId || !from || !to || from > to || !["billing", "inventory"].includes(exportType)) return reply(request, { error: "INVALID_REQUEST" }, 400);

  const { data: allowed, error: permissionError } = await user.rpc("can_manage_fiscal_documents", { p_organization_id: organizationId });
  if (permissionError || !allowed) return reply(request, { error: "FORBIDDEN" }, 403);
  const { data: profile, error: profileError } = await admin.from("fiscal_profiles").select("legal_name,nif").eq("organization_id", organizationId).maybeSingle();
  if (profileError || !profile?.legal_name || !profile?.nif) return reply(request, { error: "ISSUER_PROFILE_INCOMPLETE" }, 422);

  try {
    let output = "";
    let count = 0;
    if (exportType === "billing") {
      const { data: preflight, error: preflightError } = await user.rpc("saft_billing_preflight", { p_organization_id: organizationId, p_from: from, p_to: to });
      if (preflightError) throw preflightError;
      if (!preflight?.ready_for_xsd_validation) return reply(request, { error: "PREFLIGHT_FAILED", details: preflight?.errors || [] }, 422);
      await signPending(admin, organizationId, to);
      const { data: documents, error: documentsError } = await admin.from("fiscal_documents").select("id,organization_id,document_type,series_code,document_number,issued_at,operation_date,customer_snapshot,totals_snapshot,tax_summary,lines_snapshot,signature_value,signature_key_version").eq("organization_id", organizationId).gte("operation_date", from).lte("operation_date", to).order("issued_at", { ascending: true });
      if (documentsError) throw documentsError;
      count = (documents || []).length;
      output = billingXml(profile, (documents || []) as FiscalDocument[], from, to);
    } else {
      const { data: products, error: productsError } = await admin.from("products").select("name,code,unit,purchase_price,stock_warehouse,stock_shop,saft_product_type").eq("organization_id", organizationId).order("name");
      if (productsError) throw productsError;
      const invalid = (products || []).filter((product) => !String(product.code || "").trim() || !String(product.unit || "").trim());
      if (invalid.length) return reply(request, { error: "INVENTORY_MASTER_DATA_INCOMPLETE", count: invalid.length }, 422);
      count = (products || []).length;
      output = inventoryXml(profile, products || [], from.slice(0, 4));
    }
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(output));
    const checksum = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const { data: auditRow, error: auditError } = await admin.from("saft_exports").insert({ organization_id: organizationId, export_type: exportType, period_from: from, period_to: to, status: "downloaded", schema_version: "AGT-XSD-pending", document_count: count, validation_errors: [], checksum, generated_at: new Date().toISOString(), generated_by: userData.user.id, generated_format: "xml-technical-draft" }).select("id").single();
    if (auditError) throw auditError;
    const filename = `SAFT-AO-${exportType}-${from}-${to}.xml`;
    return new Response(output, { headers: { ...cors(request), "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename=\"${filename}\"`, "X-Saft-Export-Id": String(auditRow.id), "Access-Control-Expose-Headers": "Content-Disposition, X-Saft-Export-Id" } });
  } catch (error) {
    console.error("SAF-T export failed", error);
    const detail = error instanceof Error ? error.message : "EXPORT_FAILED";
    return reply(request, { error: detail === "SAFT_SIGNING_NOT_CONFIGURED" ? detail : "EXPORT_FAILED" }, 500);
  }
});
