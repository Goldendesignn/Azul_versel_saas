var spreadsheetBindingReady = false;
var BOUND_SPREADSHEET_ID = '';
// ===== STATE =====
var cart = [];
var revCart = [];
var revPaymentLines = [{ method: 'Cash', montant: 0 }];
var revOpenConsignations = [];
var selectedPay = 'Cash';
var lastReceiptData = null;
var selectedType = 'interno';
var selectedPay = 'Cash';

var products = [];
var productsLoading = false;

function getAzulOrganizationId() {
  var id = localStorage.getItem("azul_organization_id");

  if (!id) {
    window.location.href = "index.html";
    return "";
  }

  return id;
}
function clearAzulSession() {
  localStorage.removeItem("azul_organization_id");
  localStorage.removeItem("azul_organization_name");
  localStorage.removeItem("azul_user_name");
  localStorage.removeItem("azul_user_role");
  localStorage.removeItem("azul_user_status");
  localStorage.removeItem("azul_license_key");
  localStorage.removeItem("azul_plan");
}

var azulAuditCache = null;

function getAzulCurrentUserName() {
  return localStorage.getItem("azul_user_name") || "Utilizador";
}

function getActionAuthorName(row) {
  row = row || {};
  return String(row.user_name || row.created_by_name || row.actor_name || "").trim();
}

function getActionAuthorLabel(row) {
  return getActionAuthorName(row) || "Autor antigo";
}

function renderActionAuthor(row) {
  return '<span class="action-author">Criado por ' + escapeDepenseHtml(getActionAuthorLabel(row)) + '</span>';
}

async function getAzulAuditFields() {
  if (azulAuditCache) return azulAuditCache;

  var audit = {
    created_by: null,
    user_name: getAzulCurrentUserName()
  };

  try {
    var userResult = await supabaseClient.auth.getUser();

    if (userResult && userResult.data && userResult.data.user) {
      var user = userResult.data.user;
      var meta = user.user_metadata || {};

      audit.created_by = user.id || null;
      audit.user_name = localStorage.getItem("azul_user_name") ||
        meta.name ||
        meta.nome ||
        user.email ||
        audit.user_name;
    }
  } catch (e) {
    console.warn("Audit utilisateur indisponible:", e);
  }

  azulAuditCache = audit;
  return audit;
}

function addAzulAuditFields(row, audit) {
  row = Object.assign({}, row || {});
  audit = audit || {};

  row.created_by = audit.created_by || null;
  row.user_name = audit.user_name || getAzulCurrentUserName();

  return row;
}

function removeAzulAuditFields(row) {
  row = Object.assign({}, row || {});
  delete row.created_by;
  delete row.user_name;
  return row;
}

function isAzulAuditSchemaError(error) {
  var msg = String(error && error.message ? error.message : error || "").toLowerCase();

  return (msg.indexOf("created_by") >= 0 || msg.indexOf("user_name") >= 0) &&
    (msg.indexOf("schema cache") >= 0 || msg.indexOf("column") >= 0 || msg.indexOf("could not find") >= 0);
}

async function insertSingleWithAzulAudit(tableName, row) {
  var audit = await getAzulAuditFields();
  var result = await supabaseClient
    .from(tableName)
    .insert(addAzulAuditFields(row, audit))
    .select()
    .single();

  if (result.error && isAzulAuditSchemaError(result.error)) {
    console.warn("Colonnes audit absentes pour " + tableName + ". Insertion sans audit temporairement.");
    result = await supabaseClient
      .from(tableName)
      .insert(removeAzulAuditFields(row))
      .select()
      .single();
  }

  if (!result.error && result.data) {
    await logAzulAction(AZUL_TABLE_ACTIONS[tableName] || (tableName + ":insert"), tableName, "success", {
      source_table: tableName,
      source_id: result.data.id || null
    });
  }

  return result;
}

async function insertRowsWithAzulAudit(tableName, rows, selectColumns) {
  rows = rows || [];
  var audit = await getAzulAuditFields();
  var auditedRows = rows.map(function(row) {
    return addAzulAuditFields(row, audit);
  });

  var query = supabaseClient.from(tableName).insert(auditedRows);
  if (selectColumns) query = query.select(selectColumns);

  var result = await query;

  if (result.error && isAzulAuditSchemaError(result.error)) {
    console.warn("Colonnes audit absentes pour " + tableName + ". Insertion sans audit temporairement.");
    var retryQuery = supabaseClient.from(tableName).insert(rows.map(removeAzulAuditFields));
    if (selectColumns) retryQuery = retryQuery.select(selectColumns);
    result = await retryQuery;
  }

  if (!result.error) {
    await logAzulAction(AZUL_TABLE_ACTIONS[tableName] || (tableName + ":bulk_insert"), tableName, "success", {
      source_table: tableName,
      rows: rows.length
    });
  }

  return result;
}

async function updateAzulAuditFields(tableName, id, audit) {
  if (!id) return;

  try {
    audit = audit || await getAzulAuditFields();

    var result = await supabaseClient
      .from(tableName)
      .update(addAzulAuditFields({}, audit))
      .eq("id", id);

    if (result.error && !isAzulAuditSchemaError(result.error)) {
      throw result.error;
    }
  } catch (e) {
    console.warn("Audit non mis a jour pour " + tableName + ":", e);
  }
}

var AZUL_TABLE_ACTIONS = {
  sales: "sale:create",
  purchases: "purchase:create",
  expenses: "expense:create",
  client_payments: "client_payment:create",
  supplier_payments: "supplier_payment:create",
  corrections_log: "correction:create",
  treasury_entries: "cash:create",
  hr_employees: "hr:create",
  hr_attendance: "hr:create",
  hr_payments: "hr:create"
};

async function logAzulAction(action, moduleName, status, details) {
  try {
    var organizationId = localStorage.getItem("azul_organization_id");
    if (!organizationId || !action) return;

    var userResult = await supabaseClient.auth.getUser();
    var user = userResult && userResult.data ? userResult.data.user : null;
    var meta = user && user.user_metadata ? user.user_metadata : {};

    await supabaseClient.from("action_audit_log").insert({
      organization_id: organizationId,
      actor_user_id: user && user.id ? user.id : null,
      actor_name: localStorage.getItem("azul_user_name") || meta.name || meta.nome || "",
      actor_email: user && user.email ? user.email : "",
      actor_role: getAzulCurrentRole(),
      device_id: localStorage.getItem("azul_device_id") || "",
      action: action,
      module: moduleName || "",
      status: status || "success",
      source_table: details && details.source_table ? details.source_table : null,
      source_id: details && details.source_id ? details.source_id : null,
      details: details || {}
    });
  } catch (e) {
    console.warn("Journal d'audit indisponible:", e);
  }
}

var AZUL_PERMISSION_CATALOG = {
  "*": { label: "Acesso total", group: "Sistema" },
  "page:dashboard": { label: "Dashboard", group: "Paginas" },
  "page:venda": { label: "Nova venda", group: "Paginas" },
  "page:achat": { label: "Nova compra", group: "Paginas" },
  "page:transfert": { label: "Stock", group: "Paginas" },
  "page:clientes": { label: "Clientes", group: "Paginas" },
  "page:depenses": { label: "Despesas", group: "Paginas" },
  "page:forn": { label: "Fornecedores", group: "Paginas" },
  "page:tresorerie": { label: "Tesouraria", group: "Paginas" },
  "page:comptabilite": { label: "Contabilidade", group: "Paginas" },
  "page:corrections": { label: "Correcoes", group: "Paginas" },
  "page:revendeurs": { label: "Revendedores", group: "Paginas" },
  "page:rh": { label: "Recursos Humanos", group: "Paginas" },
  "page:settings": { label: "Definicoes", group: "Paginas" },
  "sale:create": { label: "Registar vendas", group: "Vendas" },
  "sale:view": { label: "Ver vendas", group: "Vendas" },
  "purchase:create": { label: "Registar compras", group: "Compras" },
  "purchase:view": { label: "Ver compras", group: "Compras" },
  "expense:create": { label: "Registar despesas", group: "Despesas" },
  "expense:view": { label: "Ver despesas", group: "Despesas" },
  "stock:transfer": { label: "Transferir stock", group: "Stock" },
  "client:view": { label: "Ver clientes", group: "Clientes" },
  "supplier:view": { label: "Ver fornecedores", group: "Fornecedores" },
  "client_payment:create": { label: "Receber clientes", group: "Pagamentos" },
  "supplier_payment:create": { label: "Pagar fornecedores", group: "Pagamentos" },
  "cash:view": { label: "Ver tesouraria", group: "Financeiro" },
  "accounting:view": { label: "Ver contabilidade", group: "Financeiro" },
  "correction:create": { label: "Fazer correcoes", group: "Correcoes" },
  "import:create": { label: "Importar dados", group: "Importacao" },
  "hr:create": { label: "Gerir RH", group: "Recursos Humanos" },
  "hr:view": { label: "Ver RH", group: "Recursos Humanos" },
  "settings:team": { label: "Gerir equipe", group: "Definicoes" },
  "settings:roles": { label: "Gerir roles", group: "Definicoes" }
};

var AZUL_ROLE_PERMISSIONS = {
  owner: {
    name: "Proprietario",
    permissions: ["*"]
  },
  manager: {
    name: "Gerente",
    permissions: ["*"]
  },
  cashier: {
    name: "Caixa",
    permissions: ["page:dashboard", "page:venda", "page:clientes", "page:tresorerie", "sale:create", "sale:view", "client:view", "client_payment:create"]
  },
  stock: {
    name: "Stock",
    permissions: ["page:dashboard", "page:achat", "page:transfert", "page:forn", "purchase:create", "purchase:view", "stock:transfer", "supplier:view", "supplier_payment:create", "import:create"]
  },
  accountant: {
    name: "Contabilista",
    permissions: ["page:dashboard", "page:depenses", "page:tresorerie", "page:comptabilite", "page:corrections", "page:rh", "expense:create", "expense:view", "client_payment:create", "supplier_payment:create", "correction:create", "cash:view", "accounting:view", "hr:create", "hr:view"]
  },
  readonly: {
    name: "Leitura",
    permissions: ["page:dashboard", "page:transfert", "page:clientes", "page:tresorerie", "page:comptabilite", "page:rh", "sale:view", "purchase:view", "expense:view", "cash:view", "accounting:view", "hr:view"]
  },
  member: {
    name: "Utilizador",
    permissions: ["page:dashboard"]
  }
};

var azulRoleCatalogCache = null;

function getAzulCurrentRole() {
  return String(localStorage.getItem("azul_user_role") || "member").toLowerCase();
}

function getAzulStaticRoleDefinition(role) {
  role = String(role || "member").toLowerCase();
  var fallback = AZUL_ROLE_PERMISSIONS[role] || AZUL_ROLE_PERMISSIONS.member;

  return {
    code: role,
    name: fallback.name || role,
    isSystem: true,
    permissions: fallback.permissions || []
  };
}

function getAzulRoleDefinition(role) {
  role = String(role || "member").toLowerCase();

  if (azulRoleCatalogCache && azulRoleCatalogCache[role]) {
    return azulRoleCatalogCache[role];
  }

  return getAzulStaticRoleDefinition(role);
}

async function loadAzulRoleCatalog(force) {
  var organizationId = localStorage.getItem("azul_organization_id");

  if (!force && azulRoleCatalogCache) return azulRoleCatalogCache;

  var catalog = {};
  Object.keys(AZUL_ROLE_PERMISSIONS).forEach(function(role) {
    catalog[role] = getAzulStaticRoleDefinition(role);
  });

  if (!organizationId || !supabaseClient || !supabaseClient.rpc) {
    azulRoleCatalogCache = catalog;
    return catalog;
  }

  try {
    var result = await supabaseClient.rpc("get_role_catalog", {
      p_organization_id: organizationId
    });

    if (result.error) throw result.error;

    (result.data || []).forEach(function(role) {
      var code = String(role.code || "").toLowerCase();
      if (!code) return;

      catalog[code] = {
        code: code,
        name: role.name || getTeamRoleLabel(code),
        description: role.description || "",
        isSystem: !!role.is_system,
        permissions: Array.isArray(role.permissions) ? role.permissions : []
      };
    });
  } catch (e) {
    console.warn("Catalogue de roles indisponible, fallback local utilise:", e);
  }

  azulRoleCatalogCache = catalog;
  return catalog;
}

function azulRoleAllows(kind, key) {
  var role = getAzulCurrentRole();
  var roleDefinition = getAzulRoleDefinition(role);
  var list = roleDefinition.permissions || [];
  var permission = kind === "pages" ? "page:" + key : key;

  return list.indexOf("*") >= 0 || list.indexOf(permission) >= 0;
}

function canAccessAzulPage(page) {
  return azulRoleAllows("pages", page);
}

function canRunAzulAction(action) {
  return azulRoleAllows("actions", action);
}

function requireAzulAction(action, label) {
  if (canRunAzulAction(action)) return true;

  toast("Sem permissao para " + (label || "esta accao") + ".", "error");
  logAzulAction(action, "permission", "denied", {
    label: label || "",
    role: getAzulCurrentRole()
  });
  return false;
}

function extractGoToPage(onclickValue) {
  var match = String(onclickValue || "").match(/goTo\(['"]([^'"]+)['"]/);
  return match ? match[1] : "";
}

function applyAzulRolePermissions() {
  Array.prototype.forEach.call(document.querySelectorAll(".tab[onclick]"), function(tab) {
    var page = extractGoToPage(tab.getAttribute("onclick"));
    if (!page) return;
    tab.style.display = canAccessAzulPage(page) ? "" : "none";
  });
}

function getOrCreateDeviceId() {
  var key = "azul_device_id";
  var deviceId = localStorage.getItem(key);

  if (!deviceId) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      deviceId = crypto.randomUUID();
    } else {
      deviceId = "device-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }

    localStorage.setItem(key, deviceId);
  }

  return deviceId;
}

function getDeviceName() {
  var ua = navigator.userAgent || "";

  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone/iPad";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac/i.test(ua)) return "Mac";
  return "Navigateur";
}

function getDeviceAccessMessage(message, activeDevices, deviceLimit) {
  if (message === "DEVICE_LIMIT_REACHED") {
    return "Limite d'appareils atteinte: " + activeDevices + "/" + deviceLimit + ". Contacte l'administrateur.";
  }

  if (message === "LICENCA_INATIVA") {
    return "Licence desactivee. Contacte l'administrateur.";
  }

  if (message === "LICENCA_EXPIRADA") {
    return "Licence expiree. Renouvelle ton abonnement.";
  }

  return "Acces refuse.";
}

function showDeviceLimitScreen(activeDevices, deviceLimit) {
  var existing = document.getElementById("approval-lock-screen");
  if (existing) existing.remove();

  window.azulAccessBlocked = true;
  document.body.classList.add("approval-locked");

  var plan = approvalSafeText(localStorage.getItem("azul_plan") || "starter");
  var active = approvalSafeText(activeDevices || 0);
  var limit = approvalSafeText(deviceLimit || 0);

  var screen = document.createElement("div");
  screen.id = "approval-lock-screen";
  screen.className = "approval-lock-screen";
  screen.innerHTML = `
    <div class="approval-lock-card" role="dialog" aria-modal="true" aria-labelledby="approval-lock-title">
      <div class="approval-lock-head">
        <div class="approval-lock-mark">!</div>
      </div>
      <div class="approval-lock-body">
        <p class="approval-lock-eyebrow">Limite do plano</p>
        <h1 id="approval-lock-title">Limite de utilizadores atingido</h1>
        <p class="approval-lock-text">
          Este plano ja atingiu o numero maximo de aparelhos autorizados.
        </p>
        <div class="approval-lock-user">
          <strong>${active} / ${limit} aparelhos</strong>
          <span>Plano actual: ${plan}</span>
        </div>
        <p class="approval-lock-hint">
          Para adicionar este aparelho, pede ao administrador para aumentar o limite ou mudar para um plano superior.
        </p>
        <button type="button" onclick="logoutPendingApproval()">Voltar ao login</button>
      </div>
    </div>
  `;

  document.body.appendChild(screen);
}

function isAzulNetworkError(error) {
  var msg = String(error && error.message ? error.message : error || "").toLowerCase();

  return navigator.onLine === false ||
    msg.indexOf("failed to fetch") >= 0 ||
    msg.indexOf("network") >= 0 ||
    msg.indexOf("fetch") >= 0 ||
    msg.indexOf("load failed") >= 0 ||
    msg.indexOf("timeout") >= 0;
}

function allowOfflineLicenseAccess(reason) {
  var organizationId = localStorage.getItem("azul_organization_id");

  if (!organizationId) {
    return false;
  }

  localStorage.setItem("azul_offline_mode", "1");
  console.warn("Mode offline: verification licence ignoree temporairement.", reason || "");

  if (typeof toast === "function") {
    toast("Mode offline: l'ERP reste ouvert. La licence sera verifiee au retour d'internet.", "success");
  }

  return true;
}

async function verifyDeviceAccess(organizationId) {
  try {
    var result = await supabaseClient.rpc("register_device_access", {
      p_organization_id: organizationId,
      p_device_id: getOrCreateDeviceId(),
      p_device_name: getDeviceName()
    });

    if (result.error) {
      if (isAzulNetworkError(result.error)) {
        return allowOfflineLicenseAccess(result.error);
      }

      alert("Erreur controle appareil: " + result.error.message);
      return false;
    }

    var row = Array.isArray(result.data) ? result.data[0] : result.data;

    if (!row || !row.allowed) {
      if (row && row.message === "DEVICE_LIMIT_REACHED") {
        showDeviceLimitScreen(row.active_devices || 0, row.device_limit || 0);
        return false;
      }

      alert(getDeviceAccessMessage(
        row ? row.message : "",
        row ? row.active_devices : 0,
        row ? row.device_limit : 0
      ));

      return false;
    }

    return true;

  } catch (e) {
    if (isAzulNetworkError(e)) {
      return allowOfflineLicenseAccess(e);
    }

    alert("Erreur controle appareil: " + (e.message || e));
    return false;
  }
}

function getCoreLicenseErrorMessage(error) {
  var msg = String(error && error.message ? error.message : error || "");

  if (msg.indexOf("LICENCA_INATIVA") >= 0) {
    return "Licence desactivee. Contacte l'administrateur.";
  }

  if (msg.indexOf("LICENCA_EXPIRADA") >= 0) {
    return "Licence expiree. Renouvelle ton abonnement.";
  }

  if (msg.indexOf("ORGANIZATION_NOT_FOUND") >= 0) {
    return "Licence introuvable.";
  }

  return "Licence invalide.";
}

async function verifyCurrentLicense() {
  var organizationId = localStorage.getItem("azul_organization_id");

  if (!organizationId) {
    window.location.replace("index.html");
    return false;
  }

  try {
    var result = await supabaseClient.rpc("check_license_status", {
      p_organization_id: organizationId
    });

    if (result.error) {
      if (isAzulNetworkError(result.error)) {
        return allowOfflineLicenseAccess(result.error);
      }

      alert(getCoreLicenseErrorMessage(result.error));
      clearAzulSession();
      window.location.replace("index.html");
      return false;
    }

    var organization = result.data;

    if (!organization || !organization.id) {
      alert("Licence invalide.");
      clearAzulSession();
      window.location.replace("index.html");
      return false;
    }

    var profileForDevice = null;
    try {
      profileForDevice = await getCurrentCoreProfile();
    } catch (profileError) {
      profileForDevice = null;
    }

    if (profileForDevice && String(profileForDevice.status || "active").toLowerCase() !== "pending") {
      var deviceOk = await verifyDeviceAccess(organization.id);

      if (!deviceOk) {
        if (!window.azulAccessBlocked) {
          clearAzulSession();
          window.location.replace("index.html");
        }
        return false;
      }
    }

    localStorage.removeItem("azul_offline_mode");
    localStorage.setItem("azul_license_last_check_at", new Date().toISOString());
    localStorage.setItem("azul_organization_name", organization.name || "");
    localStorage.setItem("azul_plan", organization.plan || "starter");

    return true;

  } catch (e) {
    if (isAzulNetworkError(e)) {
      return allowOfflineLicenseAccess(e);
    }

    alert(getCoreLicenseErrorMessage(e));
    clearAzulSession();
    window.location.replace("index.html");
    return false;
  }
}
function mapSupabaseProduct(row) {
  row = row || {};

  var variations = Array.isArray(row.variations)
    ? row.variations
    : parseVariationList(row.variation || "");

  return {
    id: row.id,
    name: row.name || "",
    price: Number(row.sale_price) || 0,
    purchasePrice: Number(row.purchase_price) || 0,
    stock: Number(row.stock_warehouse) || 0,
    stockage: Number(row.stock_warehouse) || 0,
    stockBoutique: Number(row.stock_shop) || 0,
    minStock: Number(row.min_stock) || 0,
    category: row.category || "",
    supplier: row.supplier || "",
    mainSupplier: row.supplier || "",
    photo: row.photo || "",
    code: row.code || "",
    variation: row.variation || variations.join(" | "),
    variations: variations,
    entries: Number(row.stock_warehouse) + Number(row.stock_shop),
    exits: 0
  };
}


async function getProductsFromSupabase() {
  var organizationId = getAzulOrganizationId();
  if (!organizationId) return [];

  var result = await supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (result.error) {
    throw result.error;
  }

  return (result.data || []).map(mapSupabaseProduct);
}
async function transferProductToShop(productName, quantity) {
  var organizationId = getAzulOrganizationId();
  productName = String(productName || "").trim();
  quantity = Number(quantity) || 0;

  if (!productName) throw new Error("Produto obrigatorio.");
  if (quantity <= 0) throw new Error("Quantidade invalida.");

  var productResult = await supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("name", productName)
    .maybeSingle();

  if (productResult.error) throw productResult.error;
  if (!productResult.data) throw new Error("Produto nao encontrado.");

  var product = productResult.data;
  var warehouse = Number(product.stock_warehouse) || 0;
  var shop = Number(product.stock_shop) || 0;

  if (warehouse < quantity) {
    throw new Error("Stock armazem insuficiente. Disponivel: " + warehouse);
  }

  var updateResult = await supabaseClient
    .from("products")
    .update({
      stock_warehouse: warehouse - quantity,
      stock_shop: shop + quantity
    })
    .eq("id", product.id);

  if (updateResult.error) throw updateResult.error;

  return true;
}

async function transferAllProductsToShop() {
  var organizationId = getAzulOrganizationId();

  var productsResult = await supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("stock_warehouse", 0);

  if (productsResult.error) throw productsResult.error;

  var rows = productsResult.data || [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var warehouse = Number(row.stock_warehouse) || 0;
    var shop = Number(row.stock_shop) || 0;

    if (warehouse <= 0) continue;

    var updateResult = await supabaseClient
      .from("products")
      .update({
        stock_warehouse: 0,
        stock_shop: shop + warehouse
      })
      .eq("id", row.id);

    if (updateResult.error) throw updateResult.error;
  }

  return rows.length;
}

async function getStockArmazemFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("stock_warehouse", 0)
    .order("name", { ascending: true });

  if (result.error) throw result.error;

  return (result.data || []).map(function(row) {
    return {
      name: row.name,
      qty: Number(row.stock_warehouse) || 0
    };
  });
}
function generateReceiptNo() {
  var now = new Date();
  var y = String(now.getFullYear()).slice(-2);
  var m = String(now.getMonth() + 1).padStart(2, "0");
  var d = String(now.getDate()).padStart(2, "0");
  var t = String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  return "AZ-" + y + m + d + "-" + t;
}

function getPaymentSummary(lines) {
  lines = lines || [];
  return lines
    .filter(function(line) {
      return line && Number(line.montant) > 0;
    })
    .map(function(line) {
      return line.method + ": " + line.montant;
    })
    .join(" + ");
}

function groupCartQuantityByProduct(items) {
  var grouped = {};

  (items || []).forEach(function(item) {
    var key = getCartProductKey(item);
    if (!key) return;

    grouped[key] = (grouped[key] || 0) + (Number(item.qty) || 0);
  });

  return grouped;
}
function getCartProductKey(item) {
  if (item && item.productId) return String(item.productId);
  return String(item && (item.baseName || item.name) || "").trim();
}

function findProductForCartItem(item) {
  if (!item) return null;

  if (item.productId) {
    var byId = (products || []).find(function(product) {
      return String(product.id) === String(item.productId);
    });

    if (byId) return byId;
  }

  return (products || []).find(function(product) {
    return product.name === item.name || product.name === item.baseName;
  }) || null;
}
async function saveSaleToSupabase(data) {
  var organizationId = getAzulOrganizationId();

  var items = data.items || [];
  var receiptNo = generateReceiptNo();
  var total = items.reduce(function(sum, item) {
    return sum + (Number(item.price) || 0) * (Number(item.qty) || 0);
  }, 0);

var profit = items.reduce(function(sum, item) {
  var product = findProductForCartItem(item) || {};
  var price = Number(item.price) || 0;
  var purchasePrice = Number(item.purchasePrice || product.purchasePrice) || 0;
  var qty = Number(item.qty) || 0;
  return sum + (price - purchasePrice) * qty;
}, 0);

  if (!items.length) {
    throw new Error("Carrinho vazio.");
  }

 var qtyByProduct = groupCartQuantityByProduct(items);

Object.keys(qtyByProduct).forEach(function(productKey) {
  var product = (products || []).find(function(p) {
    return String(p.id) === String(productKey) || p.name === productKey;
  });

  if (!product) {
    throw new Error("Produto nao encontrado: " + productKey);
  }

  var qty = qtyByProduct[productKey];
  var currentShop = Number(product.stockBoutique) || 0;

  if (data.saleType !== "Externo" && currentShop < qty) {
    throw new Error("Stock insuficiente para " + product.name + ". Disponivel: " + currentShop);
  }
});

  var saleResult = await insertSingleWithAzulAudit("sales", {
      organization_id: organizationId,
      receipt_no: receiptNo,
      client_name: data.clientName || "Anonimo",
      sale_date: data.saleDate || new Date().toISOString().split("T")[0],
      sale_type: data.saleType || "interno",
      total: total,
      profit: profit,
      payment_summary: getPaymentSummary(data.paymentLines || []),
      payment_lines: data.paymentLines || []
    });

  if (saleResult.error) throw saleResult.error;

  var sale = saleResult.data;
  var saleItems = [];

  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var productRow = findProductForCartItem(item);

    if (!productRow) {
      throw new Error("Produto nao encontrado: " + item.name);
    }

    var qtySold = Number(item.qty) || 0;
    var purchasePrice = Number(productRow.purchasePrice) || 0;
    var unitPrice = Number(item.price) || 0;

    saleItems.push({
      sale_id: sale.id,
      product_id: productRow.id,
      product_name: item.name,
      quantity: qtySold,
      unit_price: unitPrice,
      total: unitPrice * qtySold,
      purchase_price: purchasePrice,
      profit: (unitPrice - purchasePrice) * qtySold,
      variation: (item.selectedVariations || []).join(" | "),
      variations: item.selectedVariations || []
    });

   // Le stock est diminue plus bas une seule fois par produit,
  // apres avoir additionne toutes les lignes du panier.
  }

  var itemsResult = await supabaseClient
    .from("sale_items")
    .insert(saleItems);

  if (itemsResult.error) throw itemsResult.error;

  if (data.saleType !== "Externo") {
  var groupedStock = groupCartQuantityByProduct(items);

  for (var stockKey in groupedStock) {
  var stockProduct = (products || []).find(function(p) {
    return String(p.id) === String(stockKey) || p.name === stockKey;
  });

  if (!stockProduct) continue;

    var newShopStock = Math.max(
      0,
      (Number(stockProduct.stockBoutique) || 0) - (Number(groupedStock[stockKey]) || 0)
    );

    var stockResult = await supabaseClient
      .from("products")
      .update({
        stock_shop: newShopStock
      })
      .eq("id", stockProduct.id);

    if (stockResult.error) throw stockResult.error;
    }
  }
  
  await createClientDebtIfNeeded(sale, data, total);
  var cashIn = getCashInAmountFromPaymentLines(data.paymentLines || [], total);
  var creditAmount = getCreditAmountFromPaymentLines(data.paymentLines || [], total);
  var costOfGoods = saleItems.reduce(function(sum, item) {
    return sum + (Number(item.purchase_price) || 0) * (Number(item.quantity) || 0);
  }, 0);
  
  var saleLines = [];
var isExternalSale = data.saleType === "Externo";

if (cashIn > 0) {
  saleLines.push({ account: "11", debit: cashIn, credit: 0 });
}

if (creditAmount > 0) {
  saleLines.push({ account: "12", debit: creditAmount, credit: 0 });
}

saleLines.push({ account: "71", debit: 0, credit: total });

if (costOfGoods > 0) {
  saleLines.push({ account: "61", debit: costOfGoods, credit: 0 });

  if (isExternalSale) {
    // Vente externe: on paie directement le fournisseur.
    saleLines.push({ account: "11", debit: 0, credit: costOfGoods });
  } else {
    // Vente interne: la marchandise sort du stock.
    saleLines.push({ account: "13", debit: 0, credit: costOfGoods });
  }
}

await createAccountingEntry(
  "sale",
  sale.id,
  sale.sale_date,
  "Venda " + sale.receipt_no,
  saleLines
);
  return {
    sale: sale,
    receiptNo: receiptNo,
    total: total
  };
}
async function getClientDebtFromSupabase(clientName) {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("client_debts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("client_name", clientName)
    .gt("remaining_amount", 0);

  if (result.error) throw result.error;

  return (result.data || []).reduce(function(sum, row) {
    return sum + (Number(row.remaining_amount) || 0);
  }, 0);
}

async function getClientFicheFromSupabase(clientName) {
  var organizationId = getAzulOrganizationId();

  var salesResult = await supabaseClient
    .from("sales")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("client_name", clientName)
    .order("sale_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (salesResult.error) throw salesResult.error;

  var sales = salesResult.data || [];
  var saleIds = sales.map(function(sale) { return sale.id; });

  var items = [];

  if (saleIds.length) {
    var itemsResult = await supabaseClient
      .from("sale_items")
      .select("*")
      .in("sale_id", saleIds);

    if (itemsResult.error) throw itemsResult.error;

    items = itemsResult.data || [];
  }

  var totalAchat = sales.reduce(function(sum, sale) {
    return sum + (Number(sale.total) || 0);
  }, 0);

  var totalDette = await getClientDebtFromSupabase(clientName);

  var saleById = {};
  sales.forEach(function(sale) {
    saleById[sale.id] = sale;
  });

  var historique = items.map(function(item) {
    var sale = saleById[item.sale_id] || {};
    return {
      date: sale.sale_date || "",
      prod: item.product_name || "",
      qty: Number(item.quantity) || 0,
      cash: 0,
      cartao: 0,
      express: 0,
      credito: 0,
      total: Number(item.total) || 0
    };
  });

  return {
    name: clientName,
    totalAchat: totalAchat,
    totalDette: totalDette,
    transactions: sales.length,
    historique: historique
  };
}

async function registerClientPaymentInSupabase(data) {
  var organizationId = getAzulOrganizationId();
  var clientName = String(data.client || "").trim();
  var amount = Number(data.montant) || 0;

  if (!clientName) throw new Error("Cliente obrigatorio.");
  if (amount <= 0) throw new Error("Montante invalido.");

  var paymentResult = await insertSingleWithAzulAudit("client_payments", {
      organization_id: organizationId,
      client_name: clientName,
      amount: amount,
      note: data.note || "",
      payment_date: data.date || new Date().toISOString().split("T")[0]
    });

  if (paymentResult.error) throw paymentResult.error;
  var payment = paymentResult.data;

  await createAccountingEntry(
    "client_payment",
    payment.id,
    payment.payment_date,
    "Pagamento cliente " + payment.client_name,
    [
      { account: "11", debit: Number(payment.amount) || 0, credit: 0 },
      { account: "12", debit: 0, credit: Number(payment.amount) || 0 }
    ]
  );

  var debtsResult = await supabaseClient
    .from("client_debts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("client_name", clientName)
    .gt("remaining_amount", 0)
    .order("created_at", { ascending: true });

  if (debtsResult.error) throw debtsResult.error;

  var remainingPayment = amount;
  var debts = debtsResult.data || [];

  for (var i = 0; i < debts.length && remainingPayment > 0; i++) {
    var debt = debts[i];
    var currentRemaining = Number(debt.remaining_amount) || 0;
    var currentPaid = Number(debt.paid_amount) || 0;
    var applied = Math.min(currentRemaining, remainingPayment);
    var newRemaining = currentRemaining - applied;

    var updateResult = await supabaseClient
      .from("client_debts")
      .update({
        paid_amount: currentPaid + applied,
        remaining_amount: newRemaining,
        status: newRemaining > 0 ? "open" : "paid"
      })
      .eq("id", debt.id);

    if (updateResult.error) throw updateResult.error;

    remainingPayment -= applied;
  }

  return true;
}

async function getSalesHistoryFromSupabase(params) {
  var organizationId = getAzulOrganizationId();

  params = params || {};
  var from = params.from || "";
  var to = params.to || "";
  var search = String(params.search || "").trim().toLowerCase();

  var salesQuery = supabaseClient
    .from("sales")
    .select("*")
    .eq("organization_id", organizationId)
    .order("sale_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (from) {
    salesQuery = salesQuery.gte("sale_date", from);
  }

  if (to) {
    salesQuery = salesQuery.lte("sale_date", to);
  }

  var salesResult = await salesQuery;

  if (salesResult.error) {
    throw salesResult.error;
  }

  var sales = salesResult.data || [];

  if (!sales.length) {
    return [];
  }

  var saleIds = sales.map(function(sale) {
    return sale.id;
  });

  var saleItems = await fetchSaleItemsBySaleIds(saleIds);

  var saleById = {};
  sales.forEach(function(sale) {
    saleById[sale.id] = sale;
  });

  var rows = saleItems.map(function(item) {
    var sale = saleById[item.sale_id] || {};

    return {
      date: sale.sale_date || "",
      prod: item.product_name || "",
      client: sale.client_name || "Anonimo",
      qty: Number(item.quantity) || 0,
      punit: Number(item.unit_price) || 0,
      total: Number(item.total) || 0,
      pay: sale.payment_summary || "",
      recibo: sale.receipt_no || "-",
      user_name: sale.user_name || ""
    };
  });

  if (search) {
    rows = rows.filter(function(row) {
      return (
        String(row.prod || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.client || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.recibo || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.user_name || "").toLowerCase().indexOf(search) >= 0
      );
    });
  }

  return rows;
}

function normalizePaymentMethod(method) {
  method = String(method || "").toLowerCase();

  if (method.indexOf("cash") >= 0) return "Cash";
  if (method.indexOf("express") >= 0) return "Express";
  if (method.indexOf("cart") >= 0 || method.indexOf("tpa") >= 0) return "Cartao";
  if (method.indexOf("credit") >= 0 || method.indexOf("credito") >= 0) return "Credito";

  return "Cash";
}
function getCreditAmountFromPaymentLines(lines, total) {
  lines = lines || [];
  var credit = 0;

  lines.forEach(function(line) {
    var method = String(line.method || "").toLowerCase();
    if (method.indexOf("credit") >= 0 || method.indexOf("credito") >= 0) {
      credit += Number(line.montant) || 0;
    }
  });

  return Math.min(Number(total) || 0, credit);
}

async function createClientDebtIfNeeded(sale, data, total) {
  var organizationId = getAzulOrganizationId();
  var creditAmount = getCreditAmountFromPaymentLines(data.paymentLines || [], total);

  if (creditAmount <= 0) return;

  var clientName = String(data.clientName || "").trim();

  if (!clientName || clientName.toLowerCase() === "anonimo") {
    throw new Error("Venda a credito precisa de nome do cliente.");
  }

  var result = await supabaseClient
    .from("client_debts")
    .insert({
      organization_id: organizationId,
      sale_id: sale.id,
      client_name: clientName,
      total_amount: creditAmount,
      paid_amount: 0,
      remaining_amount: creditAmount,
      status: "open"
    });

  if (result.error) throw result.error;
}
async function getDashboardDataFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();

  filters = filters || {};
  var from = filters.from || "";
  var to = filters.to || "";
  var prodFilter = String(filters.prod || "").trim().toLowerCase();
  var fornFilter = String(filters.forn || "").trim().toLowerCase();

  var salesQuery = supabaseClient
    .from("sales")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) salesQuery = salesQuery.gte("sale_date", from);
  if (to) salesQuery = salesQuery.lte("sale_date", to);

  var salesResult = await salesQuery;
  if (salesResult.error) throw salesResult.error;

  var sales = salesResult.data || [];
  var saleIds = sales.map(function(sale) { return sale.id; });

  var items = [];

  if (saleIds.length) {
       items = await fetchSaleItemsBySaleIds(saleIds);
  }

  var productsResult = await supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId);

  if (productsResult.error) throw productsResult.error;

  var productRows = productsResult.data || [];
  var productByName = {};

  productRows.forEach(function(product) {
    productByName[String(product.name || "").toLowerCase()] = product;
  });

  if (prodFilter) {
    items = items.filter(function(item) {
      return String(item.product_name || "").toLowerCase().indexOf(prodFilter) >= 0;
    });
  }

  if (fornFilter) {
    items = items.filter(function(item) {
      var product = productByName[String(item.product_name || "").toLowerCase()] || {};
      return String(product.supplier || "").toLowerCase().indexOf(fornFilter) >= 0;
    });
  }

  var allowedSaleIds = {};
  items.forEach(function(item) {
    allowedSaleIds[item.sale_id] = true;
  });

  if (prodFilter || fornFilter) {
    sales = sales.filter(function(sale) {
      return allowedSaleIds[sale.id];
    });
  }

  var totalVendas = sales.reduce(function(sum, sale) {
    return sum + (Number(sale.total) || 0);
  }, 0);

  var totalLucro = items.reduce(function(sum, item) {
    return sum + (Number(item.profit) || 0);
  }, 0);

  var topMap = {};
  items.forEach(function(item) {
    var name = item.product_name || "Produto";
    if (!topMap[name]) {
      topMap[name] = { name: name, qty: 0, total: 0 };
    }

    topMap[name].qty += Number(item.quantity) || 0;
    topMap[name].total += Number(item.total) || 0;
  });

  var topProdutos = Object.keys(topMap)
    .map(function(name) { return topMap[name]; })
    .sort(function(a, b) { return b.total - a.total; })
    .slice(0, 5);

  var pagamentos = {
    Cash: 0,
    Express: 0,
    Cartao: 0,
    Credito: 0
  };

  sales.forEach(function(sale) {
    var lines = sale.payment_lines || [];

    if (Array.isArray(lines) && lines.length) {
      lines.forEach(function(line) {
        var method = normalizePaymentMethod(line.method);
        pagamentos[method] = (pagamentos[method] || 0) + (Number(line.montant) || 0);
      });
    } else {
      pagamentos.Cash += Number(sale.total) || 0;
    }
  });

  var stockAlertas = productRows
    .map(function(product) {
      var stock = Number(product.stock_shop) || 0;
      var min = Number(product.min_stock) || 3;

      if (stock > min) return null;

      return {
        name: product.name || "Produto",
        stock: stock,
        level: stock <= 0 ? "critical" : "warning"
      };
    })
    .filter(function(item) { return !!item; })
    .slice(0, 8);
  var expenseQuery = supabaseClient
  .from("expenses")
  .select("*")
  .eq("organization_id", organizationId)
  .order("expense_date", { ascending: false })
  .order("created_at", { ascending: false });

if (from) expenseQuery = expenseQuery.gte("expense_date", from);
if (to) expenseQuery = expenseQuery.lte("expense_date", to);

var expenseResult = await expenseQuery;
if (expenseResult.error) throw expenseResult.error;

var expenseRows = expenseResult.data || [];

var totalDepenses = expenseRows.reduce(function(sum, row) {
  return sum + (Number(row.amount) || 0);
}, 0);

var latestDepenses = expenseRows.slice(0, 5).map(function(row) {
  return {
    date: row.expense_date || "",
    desc: row.description || row.category || "",
    valor: Number(row.amount) || 0
  };
});
  var quickTreasury = await getDashboardQuickTreasuryFromSupabase();
  var debts = await getDashboardDebtsFromSupabase();
  var purchases = await getDashboardPurchasesFromSupabase();
  var smartStock = getDashboardSmartStock(productRows, items);
  var salesPerformance = getDashboardSalesPerformance(sales, items);
  var accountingSummary = getDashboardAccountingSummary(
    sales,
    items,
    expenseRows,
    productRows,
    debts,
    quickTreasury
  );
  var importantAlerts = buildDashboardImportantAlerts({
    debts: debts,
    smartStock: smartStock,
    purchases: purchases,
    quickTreasury: quickTreasury,
    accountingSummary: accountingSummary,
    salesPerformance: salesPerformance
  });

return {
  vendasHoje: totalVendas,
  vendasHojeCount: sales.length,
  lucroMes: totalLucro,
  alertas: stockAlertas.length,
  topProdutos: topProdutos,
  pagamentos: pagamentos,
  stockAlertas: stockAlertas,

  totalDepenses: totalDepenses,
  depensesCount: expenseRows.length,
  depenses: latestDepenses,
  quickTreasury: quickTreasury,
  debts: debts,
  purchases: purchases,
  smartStock: smartStock,
  salesPerformance: salesPerformance,
  accountingSummary: accountingSummary,
  importantAlerts: importantAlerts
};
}


// ===== INIT =====

function switchRevendeurTab(tab, btn) {
  ['create','manage','history'].forEach(function(name) {
    var panel = document.getElementById('rev-panel-' + name);
    var tabBtn = document.getElementById('rev-tab-' + name);
    if (panel) panel.style.display = name === tab ? 'block' : 'none';
    if (tabBtn) tabBtn.classList.toggle('active', name === tab);
  });

  if (tab === 'manage') {
    loadRevendeurNames();
    loadRevendeurConsignations();
    renderRevPayLines();
  }
  if (tab === 'history') {
    loadRevendeurNames();
    loadRevHistory();
  }
}
async function upsertProductFromPurchase(item, supplier) {
  var organizationId = getAzulOrganizationId();

  var productName = String(item.prod || item.name || "").trim();
  var quantity = Number(item.qty || item.quantity) || 0;
  var purchasePrice = Number(item.pa || item.purchasePrice || item.purchase_price || item.price) || 0;
  var salePrice = Number(item.pv || item.salePrice || item.sale_price || item.targetMargin) || 0;
  var category = String(item.category || item.categorie || "").trim();
  var code = String(item.code || "").trim();
  var photo = String(item.photo || "").trim();
  var variations = parseVariationList(item.variations || item.variation || "");
  var variation = variations.join(" | ");

  if (!productName || quantity <= 0) {
    throw new Error("Produto ou quantidade invalida.");
  }

  var existingQuery = supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId);

  if (code) {
    existingQuery = existingQuery.eq("code", code);
  } else {
    existingQuery = existingQuery
      .eq("name", productName)
      .eq("variation", variation)
      .eq("purchase_price", purchasePrice)
      .eq("sale_price", salePrice);
  }

  var existingResult = await existingQuery
    .order("created_at", { ascending: false })
    .limit(1);

  if (existingResult.error) {
    throw existingResult.error;
  }

  var existingProduct = existingResult.data && existingResult.data.length
    ? existingResult.data[0]
    : null;

  if (existingProduct) {
    var currentWarehouse = Number(existingProduct.stock_warehouse) || 0;

    var updateResult = await supabaseClient
      .from("products")
      .update({
        supplier: supplier || existingProduct.supplier || "",
        category: category || existingProduct.category || "",
        code: code || existingProduct.code || "",
        photo: photo || existingProduct.photo || "",
        variation: variation || existingProduct.variation || "",
        variations: variations.length ? variations : existingProduct.variations || [],
        purchase_price: purchasePrice || Number(existingProduct.purchase_price) || 0,
        sale_price: salePrice || Number(existingProduct.sale_price) || 0,
        stock_warehouse: currentWarehouse + quantity
      })
      .eq("id", existingProduct.id)
      .select()
      .limit(1);

    if (updateResult.error) throw updateResult.error;

    return updateResult.data && updateResult.data.length
      ? updateResult.data[0]
      : existingProduct;
  }

  var insertResult = await supabaseClient
    .from("products")
    .insert({
      organization_id: organizationId,
      name: productName,
      category: category,
      supplier: supplier || "",
      code: code,
      photo: photo,
      variation: variation,
      variations: variations,
      purchase_price: purchasePrice,
      sale_price: salePrice,
      stock_warehouse: quantity,
      stock_shop: 0,
      min_stock: 0
    })
    .select()
    .limit(1);

  if (insertResult.error) throw insertResult.error;

  if (!insertResult.data || !insertResult.data.length) {
    throw new Error("Produto inserido, mas nao retornado pelo Supabase. Verifica a policy SELECT da tabela products.");
  }

  return insertResult.data[0];
}


async function savePurchaseToSupabase(data) {
  var organizationId = getAzulOrganizationId();
  var audit = await getAzulAuditFields();

  var supplier = String(data.forn || data.supplier || "").trim();
  await upsertSupplierToSupabase({ name: supplier });
  var items = data.items || data.products || [];
  var isCredit = !!data.credit;
  var totalPaidFromLines = (data.payments || []).reduce(function(sum, line) {
    return sum + (Number(line.montant) || 0);
  }, 0);

  if (!supplier) {
    throw new Error("Fornecedor obrigatorio.");
  }

  if (!items.length) {
    throw new Error("Adiciona pelo menos um produto.");
  }

  var total = items.reduce(function (sum, item) {
    var qty = Number(item.qty || item.quantity) || 0;
    var price = Number(item.pa || item.purchasePrice || item.purchase_price) || 0;
    return sum + qty * price;
  }, 0);
  
  var paidAmount = isCredit
  ? Math.min(total, Number(data.paidAmount || totalPaidFromLines || 0) || 0)
  : total;

  var remainingAmount = isCredit
    ? Math.max(0, total - paidAmount)
    : 0;

  var purchaseItems = [];

  for (var i = 0; i < items.length; i++) {
    var savedProduct = await upsertProductFromPurchase(items[i], supplier);

  purchaseItems.push({
    product_id: savedProduct.id,
    product_name: savedProduct.name,
    category: savedProduct.category || "",
    code: savedProduct.code || "",
    photo: savedProduct.photo || "",
    variation: savedProduct.variation || "",
    variations: savedProduct.variations || [],
    purchase_price: Number(savedProduct.purchase_price) || 0,
    sale_price: Number(savedProduct.sale_price) || 0,
    quantity: Number(items[i].qty || items[i].quantity) || 0,
    supplier: supplier
  });

  }

  var purchaseResult = await supabaseClient.rpc("create_purchase_for_org", {
    p_organization_id: organizationId,
    p_supplier: supplier,
    p_total: total,
    p_paid_amount: paidAmount,
    p_remaining_amount: remainingAmount,
    p_is_credit: remainingAmount > 0,
    p_created_at: data.purchaseDate ? data.purchaseDate + "T12:00:00" : null,
    p_items: purchaseItems
  });

  if (purchaseResult.error) {
    throw purchaseResult.error;
  }

  var purchase = purchaseResult.data;
  await updateAzulAuditFields("purchases", purchase.id, audit);
  
  var purchaseLinesAccounting = [
    { account: "13", debit: total, credit: 0 }
  ];
  
  if (paidAmount > 0) {
    purchaseLinesAccounting.push({ account: "11", debit: 0, credit: paidAmount });
  }
  
  if (remainingAmount > 0) {
    purchaseLinesAccounting.push({ account: "21", debit: 0, credit: remainingAmount });
  }
  
  await createAccountingEntry(
    "purchase",
    purchase.id,
    String(purchase.created_at || "").slice(0, 10),
    "Compra fornecedor " + supplier,
    purchaseLinesAccounting
  );

  return purchase;
}

function safeRun(label, fn) {
  try {
    if (typeof fn === 'function') fn();
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) console.error(label, e);
    if (typeof toast === 'function') toast(label + ': ' + (e && e.message ? e.message : e), 'error');
  }
}

function ensureSpreadsheetBinding(done) {
  if (spreadsheetBindingReady) {
    if (done) done();
    return;
  }

  if (!(typeof google !== 'undefined' && google.script && google.script.run)) {
    spreadsheetBindingReady = true;
    if (done) done();
    return;
  }

  // In the Sheets modal dialog, abrirPOS() already bound the spreadsheet on the backend.
  // Avoid an extra round-trip before loading the first data.
  if (google.script.host) {
    spreadsheetBindingReady = true;
    if (done) done();
    return;
  }

  google.script.run
    .withSuccessHandler(function(ssId) {
      BOUND_SPREADSHEET_ID = ssId || '';
      spreadsheetBindingReady = true;
      if (!BOUND_SPREADSHEET_ID) {
        toast('Aucune liaison Google Sheet trouvee pour le POS.', 'error');
      }
      if (done) done();
    })
    .withFailureHandler(function(e) {
      spreadsheetBindingReady = true;
      toast('Erreur lecture liaison Google Sheet: ' + (e && e.message ? e.message : e), 'error');
      if (done) done();
    })
    .getSpreadsheetBinding();
}
document.addEventListener('DOMContentLoaded', async function() {
  var licenseOk = await verifyCurrentLicense();
  if (!licenseOk) return;
  var userOk = await verifyCurrentUserAccess();
  if (!userOk) return;
  await loadAzulRoleCatalog();
  var now = new Date();
  document.getElementById('dateTxt').textContent =
    now.toLocaleDateString('pt-PT', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  setupVendaSearchFilter();

  var today = now.toISOString().split('T')[0];
  document.getElementById('t-date').value = today;
  document.getElementById('p-date').value = today;
  document.getElementById('vendaDate').value = today;
  document.getElementById('dep-date').value = today;
  document.getElementById('tre-date').value = today;
  document.getElementById('rev-date').value = today;
  document.getElementById('rev-action-date').value = today;
  if (document.getElementById('rh-emp-start')) document.getElementById('rh-emp-start').value = today;
  if (document.getElementById('rh-att-date')) document.getElementById('rh-att-date').value = today;
  if (document.getElementById('rh-pay-date')) document.getElementById('rh-pay-date').value = today;

  var first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  document.getElementById('h-from').value = first;
  document.getElementById('h-to').value = today;
  document.getElementById('tre-from').value = first;
  document.getElementById('tre-to').value = today;
  if (document.getElementById('acct-from')) document.getElementById('acct-from').value = first;
  if (document.getElementById('acct-to')) document.getElementById('acct-to').value = today;
  if (document.getElementById('rev-history-from')) document.getElementById('rev-history-from').value = first;
  if (document.getElementById('rev-history-to')) document.getElementById('rev-history-to').value = today;

  loadSettings();
  await renderSettingsUserCard();
  renderSettingsTeamCard();
  applyAzulRolePermissions();
  initPaymentLines();
  initAchatLines();
  cleanupLegacyCartFooter();

  ensureSpreadsheetBinding(function() {
    safeRun('Dashboard', loadDashboard);
    safeRun('Produits', loadProducts);
    safeRun('Consignations', loadOpenConsignations);
    safeRun('Paiements revendeurs', renderRevPayLines);
    safeRun('Historique revendeurs', loadRevHistory);
    safeRun('Categories depenses', renderDepenseCategories);
  });
});

function cleanupLegacyCartFooter() {
  var foot = document.querySelector('.cart-foot');
  if (!foot) return;
  Array.prototype.forEach.call(foot.children, function(child) {
    if (child.id === 'confirmBtn') return;
    if (child.classList && child.classList.contains('total-row')) return;
    child.style.display = 'none';
  });
  var btn = document.getElementById('confirmBtn');
  if (btn) {
    btn.style.display = 'block';
    btn.style.visibility = 'visible';
    btn.style.position = 'relative';
    btn.style.zIndex = '2';
    //btn.textContent = 'Paiement';
  }
}

// ===== NAVIGATION =====
function openMobileMenu() {
  if (typeof closeMobileCart === "function") closeMobileCart();

  var achatSummary = document.getElementById("mobileAchatSummary");
  var achatAddBtn = document.getElementById("mobileAchatAddBtn");

  if (achatSummary) achatSummary.style.display = "none";
  if (achatAddBtn) achatAddBtn.style.display = "none";

  document.body.classList.add("mobile-nav-open");
}

function closeMobileMenu() {
  document.body.classList.remove("mobile-nav-open");

  if (typeof renderMobileAchatSummary === "function") {
    renderMobileAchatSummary();
  }

  if (typeof renderMobileCartBar === "function") {
    renderMobileCartBar();
  }
}

function goTo(page, btn) {
  closeMobileMenu();

  if (!canAccessAzulPage(page)) {
    toast("Sem permissao para abrir esta pagina.", "error");
    return;
  }

  var target = document.getElementById('page-' + page);

  if (!target) {
    toast('Page introuvable: ' + page, 'error');
    return;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.page'), function(p) { p.classList.remove('active'); });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(b) { b.classList.remove('active'); });
  target.classList.add('active');
  if (btn && btn.classList) btn.classList.add('active');
  try {
    if (typeof syncPageTitles === 'function') syncPageTitles();
    if (page === 'venda') loadProducts();
    if (page === 'settings') {
      renderSettingsUserCard().then(applyAzulRolePermissions);
      renderSettingsTeamCard();
      if (products.length) renderProductProfileOptions();
      else loadProducts();
    }
    if (page === 'dashboard') loadDashboard();
    if (page === 'depenses') initDepensesPage();
    if (page === 'rh') initRhPage();
    if (page === 'historique') loadHist();
    if (page === 'forn') {
      loadProducts();
      renderSupplierDatalists();
      switchFornTab('fiche', document.getElementById('forn-tab-fiche'));
    }
    if (page === 'clientes') renderClientDatalist();
    if (page === 'tresorerie') loadTresorerie();
    if (page === 'comptabilite') loadComptabilite();
    if (page === 'corrections') loadCorrections();
    if (page === 'transfert') loadProducts(true);
    if (page === 'revendeurs') {
      renderRevProducts(products);
      renderRevCart();
      renderRevPayLines();
      loadOpenConsignations();
      switchRevendeurTab('create', document.getElementById('rev-tab-create'));
    }
    if (page === 'achat') {
      switchAchatTab('novo', document.getElementById('achat-tab-novo'));
      if (typeof renderMobileAchatSummary === 'function') renderMobileAchatSummary();
    }
    if (page === "forn" || page === "achat") {
      renderSupplierDatalists();
    }
  } catch (e) {
    toast('Erreur onglet: ' + (e && e.message ? e.message : e), 'error');
  }
  injectLockSettingsCard();
}
window.goTo = goTo;

function ensureMobileList(afterTableBodyId, listId) {
  var existing = document.getElementById(listId);
  if (existing) return existing;

  var body = document.getElementById(afterTableBodyId);
  if (!body) return null;

  var table = body.closest("table");
  if (!table) return null;

  var list = document.createElement("div");
  list.id = listId;
  list.className = "mobile-card-list";

  table.parentNode.insertBefore(list, table.nextSibling);
  return list;
}

function renderMobileSalesHistory(rows) {
  var list = ensureMobileList("histBody", "mobileHistList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma venda encontrada</div>';
    return;
  }

  list.innerHTML = rows.map(function(v) {
    return '<div class="mobile-sale-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">Sale #' + escapeDepenseHtml(v.recibo || '-') + '</div>' +
          '<div class="mobile-card-title">' + escapeDepenseHtml(v.prod || '') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDepenseHtml(v.client || 'Anonimo') + ' • Qtd ' + (v.qty || 0) + '</div>' +
          '<div class="mobile-card-sub">' + escapeDepenseHtml(v.date || '') + '</div>' +
          '<div class="mobile-card-sub">' + renderActionAuthor(v) + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="mobile-card-amount">' + fmt(v.total || 0) + '</div>' +
          '<div class="mobile-card-pill">' + escapeDepenseHtml(v.pay || 'Pago') + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderMobileInventory(rows) {
  var list = ensureMobileList("Inventaires", "mobileInventoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Aucun produit trouvé</div>';
    return;
  }

  list.innerHTML = rows.map(function(product) {
    var stockBoutique = Number(product.stockBoutique) || 0;
    var stockage = Number(product.stockage) || 0;
    var purchasePrice = Number(product.purchasePrice) || 0;
    var total = stockBoutique + stockage;
    var valeur = total * purchasePrice;

    return '<div class="mobile-stock-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDepenseHtml(product.mainSupplier || 'Stock') + '</div>' +
          '<div class="mobile-card-title">' + escapeDepenseHtml(product.name || '') + '</div>' +
          '<div class="mobile-card-sub">Prix achat: ' + fmt(purchasePrice) + '</div>' +
        '</div>' +
        '<div class="mobile-card-amount">' + fmt(valeur) + '</div>' +
      '</div>' +
      '<div class="mobile-stock-grid">' +
        '<div class="mobile-stock-box"><div class="mobile-stock-label">Boutique</div><div class="mobile-stock-value">' + stockBoutique + '</div></div>' +
        '<div class="mobile-stock-box"><div class="mobile-stock-label">Magasin</div><div class="mobile-stock-value">' + stockage + '</div></div>' +
        '<div class="mobile-stock-box"><div class="mobile-stock-label">Total</div><div class="mobile-stock-value">' + total + '</div></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ===== GOOGLE SHEETS BRIDGE =====
var pendingActionButton = null;
var activeActionLoaders = 0;
var toastTimer = null;

document.addEventListener('click', function(e) {
  var btn = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!btn) return;
  var pending = { btn: btn, time: Date.now() };
  pendingActionButton = pending;
  setTimeout(function() {
    if (pendingActionButton === pending) pendingActionButton = null;
  }, 900);
}, true);

function getActionLoadingText(btn, fn) {
  var label = ((btn && (btn.textContent || btn.innerText)) || '').trim().toLowerCase();
  if (label.indexOf('filtr') >= 0 || label.indexOf('aplicar') >= 0 || label.indexOf('appliquer') >= 0) return 'Aplicação do filtro...';
  if (label.indexOf('pesquisar') >= 0 || label.indexOf('rechercher') >= 0 || label.indexOf('search') >= 0) return 'Pesquisa em curso...';
  if (label.indexOf('registar') >= 0 || label.indexOf('enregistrer') >= 0 || label.indexOf('guardar') >= 0 || label.indexOf('save') >= 0) return 'A registar...';
  if (label.indexOf('confirm') >= 0 || label.indexOf('paiement') >= 0 || label.indexOf('pagamento') >= 0) return 'Confirmação em curso...';
  if (label.indexOf('actualizar') >= 0 || label.indexOf('recharger') >= 0 || label.indexOf('refresh') >= 0) return 'A atualizar...';
  if (fn === 'getDashboardData') return 'Aplicação do filtro...';
  return '';
}

function getGlobalActionLoader() {
  var loader = document.getElementById('globalActionLoader');
  if (loader) return loader;
  loader = document.createElement('div');
  loader.id = 'globalActionLoader';
  loader.className = 'global-action-loader';
  loader.innerHTML = '<div class="global-action-loader-title"><span class="button-spinner"></span><span id="globalActionLoaderText">A processar...</span></div><div class="global-action-loader-bar"><span></span></div>';
  document.body.appendChild(loader);
  return loader;
}

function showActionToast(label) {
  var t = document.getElementById('toast');
  if (!t) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  t.innerHTML = '<span class="toast-spinner"></span><span>' + escapeDepenseHtml(label || '') + '</span>';
  t.className = 'toast info loading show';
}

function hideActionToast() {
  var t = document.getElementById('toast');
  if (t && t.classList.contains('loading')) {
    t.classList.remove('show', 'loading');
  }
}

function beginActionLoading(fn) {
  var pending = pendingActionButton;
  pendingActionButton = null;
  if (!pending || Date.now() - pending.time > 1500) return null;

  var btn = pending.btn;
  var label = getActionLoadingText(btn, fn);
  var ctx = { toastOnly: true };

  activeActionLoaders++;
  showActionToast(label);
  return ctx;
}

function shouldUseBackgroundLoading(fn) {
  return ['getProducts', 'getDashboardData', 'getConsignationsOpen', 'getHistoriqueConsignations'].indexOf(fn) >= 0;
}

function beginBackgroundLoading(fn) {
  if (!shouldUseBackgroundLoading(fn)) return null;
  activeActionLoaders++;
  showActionToast(getActionLoadingText(null, fn));
  return { backgroundOnly: true };
}

function finishActionLoading(ctx) {
  if (!ctx) return;
  if (ctx.changedButton && ctx.btn) {
    ctx.btn.innerHTML = ctx.originalHTML;
    ctx.btn.disabled = ctx.wasDisabled;
    ctx.btn.classList.remove('action-loading');
  }
  activeActionLoaders = Math.max(0, activeActionLoaders - 1);
  if (activeActionLoaders === 0) {
    var loader = document.getElementById('globalActionLoader');
    if (loader) loader.classList.remove('show');
    hideActionToast();
  }
}

function scheduleMojibakeCleanup() {
  return;
}

function gsCall(fn, params, cb) {
  var loadingCtx = beginActionLoading(fn) || beginBackgroundLoading(fn);
  function finalize() {
    try {
      scheduleMojibakeCleanup();
    } finally {
      finishActionLoading(loadingCtx);
    }
  }

  try {
    if (typeof google !== 'undefined' && google.script && google.script.run) {
      var runner = google.script.run
        .withSuccessHandler(function(result) {
          try {
            if (cb) cb(result);
          } finally {
            finalize();
          }
        })
        .withFailureHandler(function(e) {
          try {
            if (typeof console !== 'undefined' && console.error) console.error('gsCall failed: ' + fn, e);
            toast('Erro: ' + (e && e.message ? e.message : e), 'error');
          } finally {
            finalize();
          }
        });

      if (typeof params === 'undefined') runner[fn]();
      else runner[fn](params);
      return;
    }

    setTimeout(function() {
      try {
        if (cb) cb(mockData(fn));
      } finally {
        finalize();
      }
    }, 300);
  } catch (e) {
    try {
      if (typeof console !== 'undefined' && console.error) console.error('gsCall setup failed: ' + fn, e);
      toast('Erro: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      finalize();
    }
  }
}

function mockData(fn) {
  if (fn === 'getProducts') return [
    {name:'Blazer Classico', price:27000, stock:15, stockBoutique:8},
    {name:'Chapeau Abah', price:4000, stock:37, stockBoutique:20},
    {name:'Ceinture Brillant', price:8500, stock:13, stockBoutique:5},
    {name:'Chapeau Chinois', price:4000, stock:8, stockBoutique:3},
    {name:'Avento', price:9000, stock:1, stockBoutique:1},
    {name:'Bavaria Man Intense', price:9000, stock:4, stockBoutique:2},
    {name:'Chapeau Lacoste', price:4000, stock:4, stockBoutique:2},
    {name:'Brown Orchid', price:9000, stock:2, stockBoutique:1}
  ];
  if (fn === 'getDashboardData') return {
    vendasHoje:54000, vendasHojeCount:3,
    vendasMes:387000, vendasMesCount:24,
    lucroMes:98000, alertas:3,
    topProdutos:[
      {name:'Blazer Classico', qty:15, total:405000},
      {name:'Chapeau Abah', qty:37, total:148000},
      {name:'Ceinture Brillant', qty:13, total:110500}
    ],
    pagamentos:{Cash:210000, Express:120000, Cartao:57000},
    stockAlertas:[
      {name:'Avento', stock:1, level:'critical'},
      {name:'Brown Orchid', stock:2, level:'warning'}
    ]
  };
  if (fn === 'getStockArmazem') return [
    {name:'Blazer Classico', qty:7},
    {name:'Chapeau Abah', qty:17},
    {name:'Ceinture Brillant', qty:8}
  ];
  if (fn === 'transferirTudo') return true;
  if (fn === 'getVentes') return [
    {date:'28/03/2026', prod:'Blazer Classico', client:'Joao Silva', qty:1, punit:27000, total:27000, pay:'Cash: 27000', recibo:'DUK-2603-0001'},
    {date:'28/03/2026', prod:'Chapeau Abah', client:'Maria Santos', qty:2, punit:4000, total:8000, pay:'Cash: 3000 + Express: 5000', recibo:'DUK-2603-0002'}
  ];
  if (fn === 'getTresorerie') return {
    balance: 128000,
    totalIn: 210000,
    totalOut: 82000,
    count: 4,
    entries: [
      {date:'03/04/2026', type:'Venda', desc:'Venda DUK-2604-0001 - Blazer', income:27000, expense:0, balance:128000},
      {date:'03/04/2026', type:'Depense', desc:'Transport - Taxi', income:0, expense:5000, balance:101000},
      {date:'02/04/2026', type:'Achat', desc:'Achat fornecedor Abah - costume', income:0, expense:45000, balance:106000},
      {date:'01/04/2026', type:'Entrada Manual', desc:'Capital initial', income:151000, expense:0, balance:151000}
    ]
  };
  if (fn === 'getConsignationsOpen') return [
    {id:'CON-260403-001', date:'03/04/2026', revendeur:'Moussa', total:18000, qty:3, items:['Blazer x1','Jeans x2']},
    {id:'CON-260402-003', date:'02/04/2026', revendeur:'Aicha', total:9000, qty:2, items:['Chapeau x2']}
  ];
  if (fn === 'getRevendeurDetail') return {
    nom:'Moussa',
    totalPossession:18000,
    openCount:1,
    ouvertes:[{id:'CON-260403-001', date:'03/04/2026', status:'En cours', total:18000, qty:3, items:[{prod:'Blazer',qty:1,total:10000},{prod:'Jeans',qty:2,total:8000}]}],
    historique:[
      {id:'CON-260403-001', date:'03/04/2026', status:'En cours', total:18000, qty:3, items:[{prod:'Blazer',qty:1,total:10000},{prod:'Jeans',qty:2,total:8000}]},
      {id:'CON-260330-002', date:'30/03/2026', status:'Payee', total:12000, qty:2, recibo:'CONS-260330-002', payment:'Cash: 12000', items:[{prod:'Taoette',qty:2,total:12000}]}
    ]
  };
  if (fn === 'getHistoriqueConsignations') return [
    {id:'CON-260403-001', actionDate:'03/04/2026', revendeur:'Moussa', status:'En cours', itemsSummary:'Blazer x1, Jeans x2', total:18000, payment:'', recibo:''},
    {id:'CON-260330-002', actionDate:'30/03/2026', revendeur:'Moussa', status:'Pay??e', itemsSummary:'Taoette x2', total:12000, payment:'Cash: 12000', recibo:'CONS-260330-002'},
    {id:'CON-260329-001', actionDate:'29/03/2026', revendeur:'Aicha', status:'Retourn??e', itemsSummary:'Chapeau x2', total:9000, payment:'', recibo:''}
  ];
  if (fn === 'getDepenseDashboard') return {
    total: 31500,
    count: 5,
    average: 6300,
    max: 12000,
    maxCategory: 'Loyer',
    todayTotal: 5000,
    byCategory: [
      { category: 'Loyer', total: 12000 },
      { category: 'Transport', total: 9500 },
      { category: 'Electricite', total: 6000 },
      { category: 'Autre', total: 4000 }
    ],
    byDay: [
      { date: '13/04/2026', total: 4000 },
      { date: '14/04/2026', total: 2500 },
      { date: '15/04/2026', total: 8000 },
      { date: '16/04/2026', total: 12000 },
      { date: '17/04/2026', total: 5000 }
    ]
  };
  if (fn === 'getHistoriqueDepenses') return [
    { date: '17/04/2026', category: 'Transport', description: 'Taxi fournisseur', amount: 5000 },
    { date: '16/04/2026', category: 'Loyer', description: 'Part du local', amount: 12000 },
    { date: '15/04/2026', category: 'Electricite', description: 'Recharge compteur', amount: 6000 },
    { date: '14/04/2026', category: 'Autre', description: 'Eau', amount: 4000 }
  ];
  if (fn === 'confirmerPaiementConsignations') return { success:true, recibo:'CONS-TEST-001' };
  if (fn === 'retornarConsignacoes') return { success:true, count:2 };
  return true;
}

// ===== DASHBOARD =====
function onPeriodChange() {
  var p = document.getElementById('df-period').value;
  var show = p === 'custom';
  document.getElementById('df-custom').style.display = show ? 'flex' : 'none';
  document.getElementById('df-custom2').style.display = show ? 'flex' : 'none';
  if (show) {
    var now = new Date();
    var fromInput = document.getElementById('df-from');
    var toInput = document.getElementById('df-to');
    if (fromInput && !fromInput.value) fromInput.value = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
    if (toInput && !toInput.value) toInput.value = localDateKey(now);
  }
  if (!show) document.getElementById('dashApplyBtn').focus();
}

function localDateKey(date) {
  var d = date instanceof Date ? date : new Date();
  var y = d.getFullYear();
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + day;
}

function getDashInputValue(id) {
  var el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function parseDashInputDate(value) {
  var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function getDashFilters() {
  var period = document.getElementById('df-period') ? document.getElementById('df-period').value : 'mes';
  var now = new Date();
  var from, to;
  to = new Date(now); to.setHours(23,59,59,999);

  if (period === 'hoje') {
    from = new Date(now); from.setHours(0,0,0,0);
  } else if (period === 'semana') {
    from = new Date(now);
    var weekday = now.getDay();
    from.setDate(now.getDate() - (weekday === 0 ? 6 : weekday - 1));
    from.setHours(0,0,0,0);
  } else if (period === 'mes') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    var fv = getDashInputValue('df-from') || localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
    var tv = getDashInputValue('df-to') || localDateKey(now);
    var fromDate = parseDashInputDate(fv);
    var toDate = parseDashInputDate(tv);
    if (fromDate && toDate && fromDate > toDate) {
      var tmp = fv;
      fv = tv;
      tv = tmp;
    }
    return {
      from: fv,
      to: tv,
      prod: getDashInputValue('df-prod'),
      forn: getDashInputValue('df-forn')
    };
  }
  return {
    from: localDateKey(from),
    to: localDateKey(to),
    prod: getDashInputValue('df-prod'),
    forn: getDashInputValue('df-forn')
  };
}

function setDashboardFilterLoading(isLoading) {
  var btn = document.getElementById('dashApplyBtn');
  if (!btn) return;
  if (isLoading) {
    if (!btn.getAttribute('data-original-text')) btn.setAttribute('data-original-text', btn.textContent || 'Aplicar');
    btn.disabled = true;
    btn.style.opacity = '0.65';
    btn.textContent = 'Aplicando...';
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.textContent = btn.getAttribute('data-original-text') || 'Aplicar';
  }
}
function summarizeTreasuryEntries(entries, from, to) {
  entries = entries || [];

  var filtered = entries.filter(function(row) {
    var date = String(row.date || "");
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });

  var totalIn = filtered.reduce(function(sum, row) {
    return sum + (Number(row.income) || 0);
  }, 0);

  var totalOut = filtered.reduce(function(sum, row) {
    return sum + (Number(row.expense) || 0);
  }, 0);

  return {
    totalIn: totalIn,
    totalOut: totalOut,
    net: totalIn - totalOut,
    count: filtered.length,
    entries: filtered
  };
}

async function getDashboardQuickTreasuryFromSupabase() {
  var now = new Date();
  var today = localDateKey(now);
  var monthStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));

  var allTreasury = await getTreasuryFromSupabase({
  from: monthStart,
  to: today,
  limit: 5
    });
  var entries = allTreasury.entries || [];

  var todaySummary = summarizeTreasuryEntries(entries, today, today);
  var monthSummary = summarizeTreasuryEntries(entries, monthStart, today);

  return {
    balance: Number(allTreasury.balance) || 0,
    todayIn: todaySummary.totalIn,
    todayOut: todaySummary.totalOut,
    monthIn: monthSummary.totalIn,
    monthOut: monthSummary.totalOut,
    monthNet: monthSummary.net,
    latest: entries.slice(0, 5)
  };
}

function setQuickTreasuryText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = fmt(value || 0);
}

function getDashboardLang() {
  return ((config && config.language) || 'pt');
}

function getMainDashboardText(key) {
  var lang = getDashboardLang();
  var dict = {
    pt: {
      period: 'Periodo', from: 'De', to: 'Ate', product: 'Produto', supplier: 'Fornecedor',
      today: 'Hoje', week: 'Esta semana', month: 'Este mes', custom: 'Personalizado',
      all: 'Todos', apply: 'Aplicar', print: 'Imprimir', refresh: 'Atualizar', seeAll: 'Ver tudo',
      sales: 'Vendas', profit: 'Lucro', expenses: 'Despesas', stockAlerts: 'Alertas Stock',
      revenueCost: 'Receita - Custo', missingProducts: 'produtos em falta',
      treasury: 'Tesouraria', quickTreasury: 'Tesouraria rapida', availableBalance: 'Saldo disponivel',
      monthlyBalance: 'Saldo do mes', todayIn: 'Entradas hoje', todayOut: 'Saidas hoje',
      monthIn: 'Entradas do mes', monthOut: 'Saidas do mes', monthResult: 'Resultado do mes',
      cash: 'Cash', express: 'Express', card: 'Cartao', registos: 'registos',
      loadingMovements: 'A carregar movimentos...', noMovement: 'Nenhum movimento encontrado',
      debts: 'Dividas', debtSituation: 'Situacao das dividas',
      debtIntro: 'Clientes a receber e fornecedores a pagar.', clients: 'Clientes',
      suppliers: 'Fornecedores', clientsReceivable: 'Clientes a receber', suppliersPayable: 'Fornecedores a pagar',
      netBalance: 'Saldo liquido', receivablePayable: 'A receber - a pagar',
      openFiles: 'Dossiers abertos', dossierUnit: 'dossiers', clientSupplier: 'clientes + fornecedores',
      debtorClients: 'Clientes devedores', noClientDebt: 'Nenhuma divida de cliente',
      noSupplierDebt: 'Nenhuma divida de fornecedor', debtUnit: 'divida(s)', purchaseUnit: 'compra(s)',
      purchases: 'Compras', purchaseOverview: 'Visao de compras',
      purchaseIntro: 'Acompanhamento de compras, fornecedores e creditos.',
      newPurchase: 'Nova compra', todayPurchases: 'Compras hoje', monthPurchases: 'Compras do mes',
      creditPurchases: 'Compras a credito', supplierDebt: 'Divida fornecedores',
      remainingToPay: 'Resta pagar', mainSupplier: 'Fornecedor principal', latestPurchases: 'Ultimas compras',
      noPurchase: 'Nenhuma compra encontrada', remaining: 'Resta',
      stock: 'Stock', smartStock: 'Stock inteligente',
      stockIntro: 'Valor, rupturas, alertas e produtos parados.', viewStock: 'Ver stock',
      totalStockValue: 'Valor total do stock', shopWarehouse: 'Boutique + armazem',
      outProducts: 'Produtos esgotados', totalStockZero: 'stock total a 0',
      lowStock: 'Stock baixo', belowMinimum: 'abaixo do minimo',
      dormantProducts: 'Produtos parados', notSoldPeriod: 'sem vendas no periodo',
      priorityAlerts: 'Alertas prioritarios', stockOk: 'Stock OK',
      shop: 'Boutique', warehouse: 'Armazem', stockValue: 'Valor stock',
      noDormantProduct: 'Nenhum produto parado',
      commercialPerformance: 'Performance comercial',
      commercialIntro: 'Ticket medio, margem, clientes e ritmo de vendas.',
      newSale: 'Nova venda', averageTicket: 'Ticket medio',
      salesTransactions: 'total vendas / transacoes', salesCount: 'Numero de vendas',
      transactions: 'transacoes', soldItems: 'Artigos vendidos', totalQuantity: 'quantidade total',
      averageMargin: 'Margem media', profitSales: 'lucro / vendas',
      bestClient: 'Melhor cliente', bestSeller: 'Melhor vendedor',
      dominantOrigin: 'Origem dominante', biggestCart: 'Maior carrinho',
      topClients: 'Top clientes', salesOrigin: 'Origem das vendas',
      noClientFound: 'Nenhum cliente encontrado', noOriginFound: 'Nenhuma origem encontrada',
      saleUnit: 'venda(s)',
      fiscalAccounting: 'Fiscal / Contabil', accountingSummary: 'Resumo fiscal/contabil',
      accountingIntro: 'Visao simplificada do resultado, stock, valores a receber e dividas.',
      accounting: 'Contabilidade', revenue: 'Volume de negocios', periodSales: 'Vendas do periodo',
      cogs: 'Custo das mercadorias', purchaseCostSold: 'Preco de compra vendido',
      grossMargin: 'Margem bruta', periodCharges: 'Despesas do periodo',
      estimatedNetResult: 'Resultado liquido estimado', netMargin: 'Margem liquida',
      valuedStock: 'Stock valorizado', treasuryAsset: 'Tesouraria', simplifiedAssets: 'Ativo simplificado',
      simplifiedLiabilities: 'Passivo simplificado', netPosition: 'Situacao liquida',
      alerts: 'Alertas', importantAlerts: 'Alertas importantes',
      importantIntro: 'O que precisa da tua atencao antes de continuar a vender.',
      critical: 'Criticos', handleFast: 'a tratar rapido', watch: 'A acompanhar',
      mediumRisk: 'risco medio', totalAlerts: 'Total alertas', inPeriod: 'no periodo',
      negativeTreasury: 'Tesouraria do mes negativa', treasuryResult: 'Resultado tesouraria',
      negativeNetResult: 'Resultado liquido negativo', estimatedResult: 'Resultado estimado',
      lowMargin: 'Margem baixa', avgMargin: 'Margem media', creditPurchaseRemain: 'Resta pagar nas compras',
      currentStock: 'Stock atual', loadingAlerts: 'A carregar alertas...',
      noImportantAlert: 'Nenhuma alerta importante. Situacao limpa.',
      topProducts: 'Top Produtos', paymentMethods: 'Meios de Pagamento',
      lowStockAlerts: 'Alertas de Stock Baixo', latestExpenses: 'Ultimas Despesas',
      noData: 'Sem dados', noExpenses: 'Sem despesas', unit: 'un'
    },
    fr: {
      period: 'Periode', from: 'De', to: 'A', product: 'Produit', supplier: 'Fournisseur',
      today: 'Aujourd hui', week: 'Cette semaine', month: 'Ce mois', custom: 'Personnalise',
      all: 'Tous', apply: 'Appliquer', print: 'Imprimer', refresh: 'Actualiser', seeAll: 'Tout voir',
      sales: 'Ventes', profit: 'Benefice', expenses: 'Depenses', stockAlerts: 'Alertes Stock',
      revenueCost: 'Recette - Cout', missingProducts: 'produits en manque',
      treasury: 'Tresorerie', quickTreasury: 'Tresorerie rapide', availableBalance: 'Solde disponible',
      monthlyBalance: 'Solde du mois', todayIn: "Entrees aujourd'hui", todayOut: "Sorties aujourd'hui",
      monthIn: 'Entrees du mois', monthOut: 'Sorties du mois', monthResult: 'Resultat du mois',
      cash: 'Cash', express: 'Express', card: 'Carte', registos: 'registres',
      loadingMovements: 'Chargement des mouvements...', noMovement: 'Aucun mouvement trouve',
      debts: 'Dettes', debtSituation: 'Situation des dettes',
      debtIntro: 'Clients a recevoir et fournisseurs a payer.', clients: 'Clients',
      suppliers: 'Fournisseurs', clientsReceivable: 'Clients a recevoir', suppliersPayable: 'Fournisseurs a payer',
      netBalance: 'Solde net', receivablePayable: 'A recevoir - a payer',
      openFiles: 'Dossiers ouverts', dossierUnit: 'dossiers', clientSupplier: 'clients + fournisseurs',
      debtorClients: 'Clients debiteurs', noClientDebt: 'Aucune dette client',
      noSupplierDebt: 'Aucune dette fournisseur', debtUnit: 'dette(s)', purchaseUnit: 'achat(s)',
      purchases: 'Achats', purchaseOverview: 'Vue achats',
      purchaseIntro: 'Suivi des achats, fournisseurs et credits.',
      newPurchase: 'Nouvel achat', todayPurchases: "Achats aujourd'hui", monthPurchases: 'Achats du mois',
      creditPurchases: 'Achats a credit', supplierDebt: 'Dette fournisseurs',
      remainingToPay: 'Reste a payer', mainSupplier: 'Fournisseur principal', latestPurchases: 'Derniers achats',
      noPurchase: 'Aucun achat trouve', remaining: 'Reste',
      stock: 'Stock', smartStock: 'Stock intelligent',
      stockIntro: 'Valeur, ruptures, alertes et produits dormants.', viewStock: 'Voir stock',
      totalStockValue: 'Valeur totale stock', shopWarehouse: 'Boutique + depot',
      outProducts: 'Produits finis', totalStockZero: 'stock total a 0',
      lowStock: 'Stock faible', belowMinimum: 'sous le minimum',
      dormantProducts: 'Produits dormants', notSoldPeriod: 'pas vendus sur la periode',
      priorityAlerts: 'Alertes prioritaires', stockOk: 'Stock OK',
      shop: 'Boutique', warehouse: 'Depot', stockValue: 'Valeur stock',
      noDormantProduct: 'Aucun produit dormant',
      commercialPerformance: 'Performance commerciale',
      commercialIntro: 'Ticket moyen, marge, clients et rythme des ventes.',
      newSale: 'Nouvelle vente', averageTicket: 'Ticket moyen',
      salesTransactions: 'total ventes / transactions', salesCount: 'Nombre de ventes',
      transactions: 'transactions', soldItems: 'Articles vendus', totalQuantity: 'quantite totale',
      averageMargin: 'Marge moyenne', profitSales: 'profit / ventes',
      bestClient: 'Meilleur client', bestSeller: 'Meilleur vendeur',
      dominantOrigin: 'Origine dominante', biggestCart: 'Plus gros panier',
      topClients: 'Top clients', salesOrigin: 'Origine des ventes',
      noClientFound: 'Aucun client trouve', noOriginFound: 'Aucune origine trouvee',
      saleUnit: 'vente(s)',
      fiscalAccounting: 'Fiscal / Comptable', accountingSummary: 'Resume fiscal/comptable',
      accountingIntro: 'Vue simplifiee du resultat, stock, creances et dettes.',
      accounting: 'Comptabilite', revenue: "Chiffre d'affaires", periodSales: 'Ventes de la periode',
      cogs: 'Cout marchandises', purchaseCostSold: "Prix d'achat vendus",
      grossMargin: 'Marge brute', periodCharges: 'Charges de la periode',
      estimatedNetResult: 'Resultat net estime', netMargin: 'Marge nette',
      valuedStock: 'Stock valorise', treasuryAsset: 'Tresorerie', simplifiedAssets: 'Actif simplifie',
      simplifiedLiabilities: 'Passif simplifie', netPosition: 'Situation nette',
      alerts: 'Alertes', importantAlerts: 'Alertes importantes',
      importantIntro: 'Ce qui demande ton attention avant de continuer a vendre.',
      critical: 'Critiques', handleFast: 'a traiter vite', watch: 'A surveiller',
      mediumRisk: 'risque moyen', totalAlerts: 'Total alertes', inPeriod: 'sur la periode',
      negativeTreasury: 'Tresorerie du mois negative', treasuryResult: 'Resultat tresorerie',
      negativeNetResult: 'Resultat net negatif', estimatedResult: 'Resultat estime',
      lowMargin: 'Marge faible', avgMargin: 'Marge moyenne', creditPurchaseRemain: 'Reste a payer sur achats',
      currentStock: 'Stock actuel', loadingAlerts: 'Chargement des alertes...',
      noImportantAlert: 'Aucune alerte importante. Situation propre.',
      topProducts: 'Top Produits', paymentMethods: 'Moyens de paiement',
      lowStockAlerts: 'Alertes de stock faible', latestExpenses: 'Dernieres depenses',
      noData: 'Aucune donnee', noExpenses: 'Aucune depense', unit: 'un'
    },
    en: {
      period: 'Period', from: 'From', to: 'To', product: 'Product', supplier: 'Supplier',
      today: 'Today', week: 'This week', month: 'This month', custom: 'Custom',
      all: 'All', apply: 'Apply', print: 'Print', refresh: 'Refresh', seeAll: 'View all',
      sales: 'Sales', profit: 'Profit', expenses: 'Expenses', stockAlerts: 'Stock Alerts',
      revenueCost: 'Revenue - Cost', missingProducts: 'missing products',
      treasury: 'Treasury', quickTreasury: 'Quick Treasury', availableBalance: 'Available Balance',
      monthlyBalance: 'Monthly balance', todayIn: "Today's inflows", todayOut: "Today's outflows",
      monthIn: 'Monthly inflows', monthOut: 'Monthly outflows', monthResult: 'Monthly result',
      cash: 'Cash', express: 'Express', card: 'Card', registos: 'records',
      loadingMovements: 'Loading movements...', noMovement: 'No movement found',
      debts: 'Debts', debtSituation: 'Debt Situation',
      debtIntro: 'Client receivables and supplier payables.', clients: 'Clients',
      suppliers: 'Suppliers', clientsReceivable: 'Client receivables', suppliersPayable: 'Supplier payables',
      netBalance: 'Net balance', receivablePayable: 'Receivable - payable',
      openFiles: 'Open files', dossierUnit: 'files', clientSupplier: 'clients + suppliers',
      debtorClients: 'Debtor clients', noClientDebt: 'No client debt',
      noSupplierDebt: 'No supplier debt', debtUnit: 'debt(s)', purchaseUnit: 'purchase(s)',
      purchases: 'Purchases', purchaseOverview: 'Purchase Overview',
      purchaseIntro: 'Purchases, suppliers and credit tracking.',
      newPurchase: 'New purchase', todayPurchases: "Today's purchases", monthPurchases: 'Monthly purchases',
      creditPurchases: 'Credit purchases', supplierDebt: 'Supplier debt',
      remainingToPay: 'Remaining to pay', mainSupplier: 'Main supplier', latestPurchases: 'Latest purchases',
      noPurchase: 'No purchase found', remaining: 'Remaining',
      stock: 'Stock', smartStock: 'Smart Stock',
      stockIntro: 'Value, shortages, alerts and dormant products.', viewStock: 'View stock',
      totalStockValue: 'Total stock value', shopWarehouse: 'Shop + warehouse',
      outProducts: 'Out of stock', totalStockZero: 'total stock at 0',
      lowStock: 'Low stock', belowMinimum: 'below minimum',
      dormantProducts: 'Dormant products', notSoldPeriod: 'not sold in the period',
      priorityAlerts: 'Priority Alerts', stockOk: 'Stock OK',
      shop: 'Shop', warehouse: 'Warehouse', stockValue: 'Stock value',
      noDormantProduct: 'No dormant product',
      commercialPerformance: 'Sales Performance',
      commercialIntro: 'Average ticket, margin, clients and sales pace.',
      newSale: 'New sale', averageTicket: 'Average ticket',
      salesTransactions: 'total sales / transactions', salesCount: 'Sales count',
      transactions: 'transactions', soldItems: 'Items sold', totalQuantity: 'total quantity',
      averageMargin: 'Average margin', profitSales: 'profit / sales',
      bestClient: 'Best client', bestSeller: 'Best seller',
      dominantOrigin: 'Dominant origin', biggestCart: 'Biggest cart',
      topClients: 'Top clients', salesOrigin: 'Sales origin',
      noClientFound: 'No client found', noOriginFound: 'No origin found',
      saleUnit: 'sale(s)',
      fiscalAccounting: 'Tax / Accounting', accountingSummary: 'Tax/accounting summary',
      accountingIntro: 'Simplified view of result, stock, receivables and debts.',
      accounting: 'Accounting', revenue: 'Revenue', periodSales: 'Period sales',
      cogs: 'Cost of goods', purchaseCostSold: 'Purchase cost sold',
      grossMargin: 'Gross margin', periodCharges: 'Period expenses',
      estimatedNetResult: 'Estimated net result', netMargin: 'Net margin',
      valuedStock: 'Valued stock', treasuryAsset: 'Treasury', simplifiedAssets: 'Simplified assets',
      simplifiedLiabilities: 'Simplified liabilities', netPosition: 'Net position',
      alerts: 'Alerts', importantAlerts: 'Important Alerts',
      importantIntro: 'What needs attention before selling more.',
      critical: 'Critical', handleFast: 'handle quickly', watch: 'To watch',
      mediumRisk: 'medium risk', totalAlerts: 'Total alerts', inPeriod: 'in the period',
      negativeTreasury: 'Negative monthly treasury', treasuryResult: 'Treasury result',
      negativeNetResult: 'Negative net result', estimatedResult: 'Estimated result',
      lowMargin: 'Low margin', avgMargin: 'Average margin', creditPurchaseRemain: 'Remaining on purchases',
      currentStock: 'Current stock', loadingAlerts: 'Loading alerts...',
      noImportantAlert: 'No important alert. Situation is clean.',
      topProducts: 'Top Products', paymentMethods: 'Payment Methods',
      lowStockAlerts: 'Low Stock Alerts', latestExpenses: 'Latest Expenses',
      noData: 'No data', noExpenses: 'No expenses', unit: 'units'
    }
  };
  return (dict[lang] && dict[lang][key]) || (dict.pt && dict.pt[key]) || key;
}

function setMainDashboardText(selector, key) {
  var el = document.querySelector(selector);
  if (el) el.textContent = getMainDashboardText(key);
}

function setMainDashboardTexts(selector, keys) {
  var nodes = document.querySelectorAll(selector);
  keys.forEach(function(key, index) {
    if (nodes[index]) nodes[index].textContent = getMainDashboardText(key);
  });
}

function formatDashboardCount(value, key) {
  return (Number(value) || 0) + ' ' + getMainDashboardText(key);
}

function translateMainDashboard() {
  var page = document.getElementById('page-dashboard');
  if (!page) return;

  setMainDashboardTexts('#page-dashboard .dash-filters .form-label', ['period', 'from', 'to', 'product', 'supplier']);
  var period = document.getElementById('df-period');
  if (period) ['today', 'week', 'month', 'custom'].forEach(function(key, index) {
    if (period.options[index]) period.options[index].text = getMainDashboardText(key);
  });
  var dfProd = document.getElementById('df-prod');
  if (dfProd) dfProd.placeholder = getMainDashboardText('all');
  var dfForn = document.getElementById('df-forn');
  if (dfForn) dfForn.placeholder = getMainDashboardText('all');
  var applyBtn = document.getElementById('dashApplyBtn');
  if (applyBtn) applyBtn.textContent = getMainDashboardText('apply');
  var printBtn = document.getElementById('dashPrintBtn');
  if (printBtn) printBtn.textContent = getMainDashboardText('print');

  setMainDashboardTexts('#page-dashboard > .kpi-grid .kpi-label', ['sales', 'profit', 'expenses', 'stockAlerts']);
  setMainDashboardText('#page-dashboard > .kpi-grid .kpi:nth-child(2) .kpi-sub', 'revenueCost');
  setMainDashboardText('#page-dashboard > .kpi-grid .kpi:nth-child(4) .kpi-sub', 'missingProducts');
  setMainDashboardText('#page-dashboard .quick-treasury-head .eyebrow', 'treasury');
  setMainDashboardText('#page-dashboard .quick-treasury-head h2', 'quickTreasury');
  setMainDashboardText('#page-dashboard .quick-treasury-head button', 'refresh');
  setMainDashboardText('#page-dashboard .quick-treasury-main > span', 'availableBalance');
  setMainDashboardText('#qt-balance-sub', 'monthlyBalance');
  setMainDashboardTexts('#page-dashboard .quick-treasury-mini > span', ['todayIn', 'todayOut', 'monthIn', 'monthOut', 'monthResult']);
  setMainDashboardTexts('#page-dashboard .quick-payment-strip span', ['cash', 'express', 'card']);

  setMainDashboardText('#page-dashboard .debt-dashboard-head .eyebrow', 'debts');
  setMainDashboardText('#page-dashboard .debt-dashboard-head h2', 'debtSituation');
  setMainDashboardText('#page-dashboard .debt-dashboard-head p', 'debtIntro');
  setMainDashboardTexts('#page-dashboard .debt-actions button', ['clients', 'suppliers']);
  setMainDashboardTexts('#page-dashboard .debt-kpi > span', ['clientsReceivable', 'suppliersPayable', 'netBalance', 'openFiles']);
  setMainDashboardTexts('#page-dashboard .debt-kpi > small:not([id])', ['receivablePayable', 'clientSupplier']);
  setMainDashboardTexts('#page-dashboard .debt-list-card .card-title', ['debtorClients', 'suppliersPayable']);

  setMainDashboardText('#page-dashboard .purchase-dashboard-head .eyebrow', 'purchases');
  setMainDashboardText('#page-dashboard .purchase-dashboard-head h2', 'purchaseOverview');
  setMainDashboardText('#page-dashboard .purchase-dashboard-head p', 'purchaseIntro');
  setMainDashboardTexts('#page-dashboard .purchase-actions button', ['newPurchase', 'suppliers']);
  setMainDashboardTexts('#page-dashboard .purchase-kpi > span', ['todayPurchases', 'monthPurchases', 'creditPurchases', 'supplierDebt']);
  setMainDashboardText('#page-dashboard .purchase-kpi.red:last-child small', 'remainingToPay');
  setMainDashboardText('#page-dashboard .purchase-main-supplier > span', 'mainSupplier');
  setMainDashboardText('#page-dashboard .purchase-latest-card .card-title', 'latestPurchases');

  setMainDashboardText('#page-dashboard .smart-stock-head .eyebrow', 'stock');
  setMainDashboardText('#page-dashboard .smart-stock-head h2', 'smartStock');
  setMainDashboardText('#page-dashboard .smart-stock-head p', 'stockIntro');
  setMainDashboardText('#page-dashboard .smart-stock-head button', 'viewStock');
  setMainDashboardTexts('#page-dashboard .smart-stock-kpi > span', ['totalStockValue', 'outProducts', 'lowStock', 'dormantProducts']);
  setMainDashboardTexts('#page-dashboard .smart-stock-kpi > small', ['shopWarehouse', 'totalStockZero', 'belowMinimum', 'notSoldPeriod']);
  setMainDashboardTexts('#page-dashboard .smart-stock-list-card .card-title', ['priorityAlerts', 'dormantProducts']);

  setMainDashboardText('#page-dashboard .sales-performance-head .eyebrow', 'sales');
  setMainDashboardText('#page-dashboard .sales-performance-head h2', 'commercialPerformance');
  setMainDashboardText('#page-dashboard .sales-performance-head p', 'commercialIntro');
  setMainDashboardText('#page-dashboard .sales-performance-head button', 'newSale');
  setMainDashboardTexts('#page-dashboard .sales-performance-kpi > span', ['averageTicket', 'salesCount', 'soldItems', 'averageMargin']);
  setMainDashboardTexts('#page-dashboard .sales-performance-kpi > small', ['salesTransactions', 'transactions', 'totalQuantity', 'profitSales']);
  setMainDashboardTexts('#page-dashboard .sales-performance-highlight > span', ['bestClient', 'bestSeller', 'dominantOrigin', 'biggestCart']);
  setMainDashboardTexts('#page-dashboard .sales-performance-list-card .card-title', ['topClients', 'salesOrigin']);

  setMainDashboardText('#page-dashboard .accounting-summary-head .eyebrow', 'fiscalAccounting');
  setMainDashboardText('#page-dashboard .accounting-summary-head h2', 'accountingSummary');
  setMainDashboardText('#page-dashboard .accounting-summary-head p', 'accountingIntro');
  setMainDashboardText('#page-dashboard .accounting-summary-head button', 'accounting');
  setMainDashboardTexts('#page-dashboard .accounting-summary-kpi > span', ['revenue', 'cogs', 'grossMargin', 'expenses']);
  setMainDashboardTexts('#page-dashboard .accounting-summary-kpi > small:not([id])', ['periodSales', 'purchaseCostSold', 'periodCharges']);
  setMainDashboardText('#page-dashboard .accounting-result-box > span', 'estimatedNetResult');
  setMainDashboardTexts('#page-dashboard .accounting-mini-row > span', ['valuedStock', 'clientsReceivable', 'suppliersPayable', 'treasuryAsset']);
  setMainDashboardTexts('#page-dashboard .accounting-balance-grid span', ['simplifiedAssets', 'simplifiedLiabilities', 'netPosition']);

  setMainDashboardText('#page-dashboard .important-alerts-head .eyebrow', 'alerts');
  setMainDashboardText('#page-dashboard .important-alerts-head h2', 'importantAlerts');
  setMainDashboardText('#page-dashboard .important-alerts-head p', 'importantIntro');
  setMainDashboardText('#page-dashboard .important-alerts-head button', 'refresh');
  setMainDashboardTexts('#page-dashboard .important-alerts-kpi > span', ['critical', 'watch', 'totalAlerts']);
  setMainDashboardTexts('#page-dashboard .important-alerts-kpi > small', ['handleFast', 'mediumRisk', 'inPeriod']);

  setMainDashboardTexts('#page-dashboard .row2 .card-title', ['topProducts', 'paymentMethods', 'lowStockAlerts', 'latestExpenses']);
  document.querySelectorAll('#page-dashboard .dashboard-see-all').forEach(function(btn) {
    btn.textContent = getMainDashboardText('seeAll');
  });
}

function renderDashboardQuickTreasury(data, pagamentos) {
  data = data || {};
  pagamentos = pagamentos || {};

  setQuickTreasuryText("qt-balance", data.balance || 0);
  setQuickTreasuryText("qt-today-in", data.todayIn || 0);
  setQuickTreasuryText("qt-today-out", data.todayOut || 0);
  setQuickTreasuryText("qt-month-in", data.monthIn || 0);
  setQuickTreasuryText("qt-month-out", data.monthOut || 0);
  setQuickTreasuryText("qt-month-net", data.monthNet || 0);

  setQuickTreasuryText("qt-cash", pagamentos.Cash || 0);
  setQuickTreasuryText("qt-express", pagamentos.Express || 0);
  setQuickTreasuryText("qt-card", pagamentos.Cartao || 0);

  var netEl = document.getElementById("qt-month-net");
  if (netEl) {
    netEl.style.color = (Number(data.monthNet) || 0) < 0 ? "var(--red)" : "var(--green)";
  }

  var list = document.getElementById("qt-latest");
  if (!list) return;

  var latest = data.latest || [];

  if (!latest.length) {
    list.innerHTML = '<div class="empty">' + getMainDashboardText('noMovement') + '</div>';
    return;
  }

  list.innerHTML = latest.map(function(row) {
    var income = Number(row.income) || 0;
    var expense = Number(row.expense) || 0;
    var isIn = income > 0;

    return '<div class="quick-treasury-row">' +
      '<div>' +
        '<strong>' + escapeDepenseHtml(row.type || getMainDashboardText('treasury')) + '</strong>' +
        '<small>' + escapeDepenseHtml(row.date || "") + ' - ' + escapeDepenseHtml(row.desc || "") + '</small>' +
      '</div>' +
      '<span class="' + (isIn ? "green" : "red") + '">' +
        (isIn ? "+" : "-") + fmt(isIn ? income : expense) +
      '</span>' +
    '</div>';
  }).join("");
}

async function getDashboardDebtsFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var clientResult = await supabaseClient
    .from("client_debts")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("remaining_amount", 0)
    .order("created_at", { ascending: false });

  if (clientResult.error) throw clientResult.error;

  var supplierResult = await supabaseClient
    .from("purchases")
    .select("id,supplier,total,paid_amount,remaining_amount,created_at")
    .eq("organization_id", organizationId)
    .gt("remaining_amount", 0)
    .order("created_at", { ascending: false });

  if (supplierResult.error) throw supplierResult.error;

  var clientMap = {};
  var supplierMap = {};

  (clientResult.data || []).forEach(function(row) {
    var name = String(row.client_name || "Cliente").trim();

    if (!clientMap[name]) {
      clientMap[name] = {
        name: name,
        total: 0,
        count: 0
      };
    }

    clientMap[name].total += Number(row.remaining_amount) || 0;
    clientMap[name].count += 1;
  });

  (supplierResult.data || []).forEach(function(row) {
    var name = String(row.supplier || "Fornecedor").trim();

    if (!supplierMap[name]) {
      supplierMap[name] = {
        name: name,
        total: 0,
        count: 0
      };
    }

    supplierMap[name].total += Number(row.remaining_amount) || 0;
    supplierMap[name].count += 1;
  });

  var clients = Object.keys(clientMap).map(function(key) {
    return clientMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var suppliers = Object.keys(supplierMap).map(function(key) {
    return supplierMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var clientTotal = clients.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  var supplierTotal = suppliers.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  return {
    clientTotal: clientTotal,
    supplierTotal: supplierTotal,
    net: clientTotal - supplierTotal,
    clientCount: clients.length,
    supplierCount: suppliers.length,
    openCount: clients.length + suppliers.length,
    clients: clients.slice(0, 6),
    suppliers: suppliers.slice(0, 6)
  };
}

function renderDashboardDebts(data) {
  data = data || {};

  var clientTotal = document.getElementById("debt-client-total");
  var supplierTotal = document.getElementById("debt-supplier-total");
  var net = document.getElementById("debt-net");
  var clientCount = document.getElementById("debt-client-count");
  var supplierCount = document.getElementById("debt-supplier-count");
  var openCount = document.getElementById("debt-open-count");

  if (clientTotal) clientTotal.textContent = fmt(data.clientTotal || 0);
  if (supplierTotal) supplierTotal.textContent = fmt(data.supplierTotal || 0);
  if (net) {
    net.textContent = fmt(data.net || 0);
    net.style.color = (Number(data.net) || 0) < 0 ? "var(--red)" : "var(--green)";
  }

  if (clientCount) clientCount.textContent = formatDashboardCount(data.clientCount || 0, 'clients');
  if (supplierCount) supplierCount.textContent = formatDashboardCount(data.supplierCount || 0, 'suppliers');
  if (openCount) openCount.textContent = data.openCount || 0;

  var clientList = document.getElementById("debt-client-list");
  var supplierList = document.getElementById("debt-supplier-list");

  if (clientList) {
    if (!data.clients || !data.clients.length) {
      clientList.innerHTML = '<div class="empty">' + getMainDashboardText('noClientDebt') + '</div>';
    } else {
      clientList.innerHTML = data.clients.map(function(row) {
        return '<div class="debt-row">' +
          '<div>' +
            '<strong>' + escapeDepenseHtml(row.name) + '</strong>' +
            '<small>' + formatDashboardCount(row.count || 0, 'debtUnit') + '</small>' +
          '</div>' +
          '<span class="green">' + fmt(row.total || 0) + '</span>' +
        '</div>';
      }).join("");
    }
  }

  if (supplierList) {
    if (!data.suppliers || !data.suppliers.length) {
      supplierList.innerHTML = '<div class="empty">' + getMainDashboardText('noSupplierDebt') + '</div>';
    } else {
      supplierList.innerHTML = data.suppliers.map(function(row) {
        return '<div class="debt-row">' +
          '<div>' +
            '<strong>' + escapeDepenseHtml(row.name) + '</strong>' +
            '<small>' + formatDashboardCount(row.count || 0, 'purchaseUnit') + '</small>' +
          '</div>' +
          '<span class="red">' + fmt(row.total || 0) + '</span>' +
        '</div>';
      }).join("");
    }
  }
}

async function getDashboardPurchasesFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var now = new Date();
  var today = localDateKey(now);
  var monthStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));

  var result = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (result.error) throw result.error;

  var rows = result.data || [];

  var todayRows = rows.filter(function(row) {
    return String(row.created_at || "").slice(0, 10) === today;
  });

  var monthRows = rows.filter(function(row) {
    var date = String(row.created_at || "").slice(0, 10);
    return date >= monthStart && date <= today;
  });

  var creditRows = rows.filter(function(row) {
    return (Number(row.remaining_amount) || 0) > 0;
  });

  var todayTotal = todayRows.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  var monthTotal = monthRows.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  var creditTotal = creditRows.reduce(function(sum, row) {
    return sum + (Number(row.remaining_amount) || 0);
  }, 0);

  var supplierMap = {};

  monthRows.forEach(function(row) {
    var supplier = String(row.supplier || "Fornecedor").trim();

    if (!supplierMap[supplier]) {
      supplierMap[supplier] = {
        name: supplier,
        total: 0,
        count: 0
      };
    }

    supplierMap[supplier].total += Number(row.total) || 0;
    supplierMap[supplier].count += 1;
  });

  var suppliers = Object.keys(supplierMap).map(function(key) {
    return supplierMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var mainSupplier = suppliers[0] || {
    name: "-",
    total: 0,
    count: 0
  };

  var latest = rows.slice(0, 6).map(function(row) {
    return {
      date: String(row.created_at || "").slice(0, 10),
      supplier: row.supplier || "Fornecedor",
      total: Number(row.total) || 0,
      paid: Number(row.paid_amount) || 0,
      debt: Number(row.remaining_amount) || 0
    };
  });

  return {
    todayTotal: todayTotal,
    todayCount: todayRows.length,
    monthTotal: monthTotal,
    monthCount: monthRows.length,
    creditTotal: creditTotal,
    creditCount: creditRows.length,
    debtTotal: creditTotal,
    mainSupplier: mainSupplier,
    latest: latest
  };
}

function renderDashboardPurchases(data) {
  data = data || {};

  var set = function(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  set("dash-purchase-today", fmt(data.todayTotal || 0));
  set("dash-purchase-today-count", formatDashboardCount(data.todayCount || 0, 'purchases'));

  set("dash-purchase-month", fmt(data.monthTotal || 0));
  set("dash-purchase-month-count", formatDashboardCount(data.monthCount || 0, 'purchases'));

  set("dash-purchase-credit", fmt(data.creditTotal || 0));
  set("dash-purchase-credit-count", formatDashboardCount(data.creditCount || 0, 'dossierUnit'));

  set("dash-purchase-debt", fmt(data.debtTotal || 0));

  set("dash-main-supplier", (data.mainSupplier && data.mainSupplier.name) || "-");
  set("dash-main-supplier-total", fmt((data.mainSupplier && data.mainSupplier.total) || 0));

  var latest = document.getElementById("dash-latest-purchases");
  if (!latest) return;

  if (!data.latest || !data.latest.length) {
    latest.innerHTML = '<div class="empty">' + getMainDashboardText('noPurchase') + '</div>';
    return;
  }

  latest.innerHTML = data.latest.map(function(row) {
    return '<div class="purchase-row">' +
      '<div>' +
        '<strong>' + escapeDepenseHtml(row.supplier || "Fornecedor") + '</strong>' +
        '<small>' + escapeDepenseHtml(row.date || "") + '</small>' +
      '</div>' +
      '<div class="purchase-row-money">' +
        '<strong>' + fmt(row.total || 0) + '</strong>' +
        '<small>' + getMainDashboardText('remaining') + ': ' + fmt(row.debt || 0) + '</small>' +
      '</div>' +
    '</div>';
  }).join("");
}

function getDashboardSmartStock(productRows, saleItems) {
  productRows = productRows || [];
  saleItems = saleItems || [];

  var soldMap = {};

  saleItems.forEach(function(item) {
    var nameKey = String(item.product_name || "").trim().toLowerCase();
    var idKey = String(item.product_id || "").trim();

    if (nameKey) soldMap["name:" + nameKey] = true;
    if (idKey) soldMap["id:" + idKey] = true;
  });

  var totalValue = 0;
  var out = [];
  var low = [];
  var dormant = [];

  productRows.forEach(function(product) {
    var shop = Number(product.stock_shop) || 0;
    var warehouse = Number(product.stock_warehouse) || 0;
    var totalStock = shop + warehouse;
    var minStock = Number(product.min_stock) || 3;
    var purchasePrice = Number(product.purchase_price) || 0;

    totalValue += totalStock * purchasePrice;

    var row = {
      id: product.id || "",
      name: product.name || "Produto",
      stock: totalStock,
      shop: shop,
      warehouse: warehouse,
      minStock: minStock,
      value: totalStock * purchasePrice
    };

    if (totalStock <= 0) {
      out.push(row);
    } else if (totalStock <= minStock) {
      low.push(row);
    }

    var nameKey = String(product.name || "").trim().toLowerCase();
    var idKey = String(product.id || "").trim();

    if (totalStock > 0 && !soldMap["name:" + nameKey] && !soldMap["id:" + idKey]) {
      dormant.push(row);
    }
  });

  out.sort(function(a, b) { return a.stock - b.stock; });
  low.sort(function(a, b) { return a.stock - b.stock; });
  dormant.sort(function(a, b) { return b.value - a.value; });

  return {
    totalValue: totalValue,
    outCount: out.length,
    lowCount: low.length,
    dormantCount: dormant.length,
    alerts: out.concat(low).slice(0, 6),
    dormants: dormant.slice(0, 6)
  };
}

function renderDashboardSmartStock(data) {
  data = data || {};

  var set = function(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  set("smart-stock-value", fmt(data.totalValue || 0));
  set("smart-stock-out", data.outCount || 0);
  set("smart-stock-low", data.lowCount || 0);
  set("smart-stock-dormant", data.dormantCount || 0);

  var alerts = document.getElementById("smart-stock-alerts");
  var dormants = document.getElementById("smart-stock-dormants");

  if (alerts) {
    if (!data.alerts || !data.alerts.length) {
      alerts.innerHTML = '<div class="empty">' + getMainDashboardText('stockOk') + '</div>';
    } else {
      alerts.innerHTML = data.alerts.map(function(row) {
        var critical = Number(row.stock) <= 0;

        return '<div class="smart-stock-row">' +
          '<div>' +
            '<strong>' + escapeDepenseHtml(row.name) + '</strong>' +
            '<small>' + getMainDashboardText('shop') + ': ' + row.shop + ' | ' + getMainDashboardText('warehouse') + ': ' + row.warehouse + '</small>' +
          '</div>' +
          '<span class="' + (critical ? "red" : "orange") + '">' + row.stock + ' ' + getMainDashboardText('unit') + '</span>' +
        '</div>';
      }).join("");
    }
  }

  if (dormants) {
    if (!data.dormants || !data.dormants.length) {
      dormants.innerHTML = '<div class="empty">' + getMainDashboardText('noDormantProduct') + '</div>';
    } else {
      dormants.innerHTML = data.dormants.map(function(row) {
        return '<div class="smart-stock-row">' +
          '<div>' +
            '<strong>' + escapeDepenseHtml(row.name) + '</strong>' +
            '<small>' + getMainDashboardText('stockValue') + ': ' + fmt(row.value || 0) + '</small>' +
          '</div>' +
          '<span>' + row.stock + ' ' + getMainDashboardText('unit') + '</span>' +
        '</div>';
      }).join("");
    }
  }
}

function getDashboardSalesPerformance(sales, saleItems) {
  sales = sales || [];
  saleItems = saleItems || [];

  var totalSales = sales.reduce(function(sum, sale) {
    return sum + (Number(sale.total) || 0);
  }, 0);

  var totalProfit = saleItems.reduce(function(sum, item) {
    return sum + (Number(item.profit) || 0);
  }, 0);

  var itemsSold = saleItems.reduce(function(sum, item) {
    return sum + (Number(item.quantity) || 0);
  }, 0);

  var averageTicket = sales.length ? totalSales / sales.length : 0;
  var marginPercent = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0;

  var clientMap = {};
  var sellerMap = {};
  var originMap = {};

  var biggestSale = {
    total: 0,
    client: "-"
  };

  sales.forEach(function(sale) {
    var total = Number(sale.total) || 0;
    var client = String(sale.client_name || "Anonimo").trim() || "Anonimo";
    var seller = String(sale.seller || sale.vendor || sale.created_by || "Não informado").trim() || "Não informado";
    seller = String(sale.user_name || seller || "Nao informado").trim() || "Nao informado";
    var origin = String(sale.sale_type || sale.origin || "Interno").trim() || "Interno";

    if (!clientMap[client]) {
      clientMap[client] = { name: client, total: 0, count: 0 };
    }

    clientMap[client].total += total;
    clientMap[client].count += 1;

    if (!sellerMap[seller]) {
      sellerMap[seller] = { name: seller, total: 0, count: 0 };
    }

    sellerMap[seller].total += total;
    sellerMap[seller].count += 1;

    if (!originMap[origin]) {
      originMap[origin] = { name: origin, total: 0, count: 0 };
    }

    originMap[origin].total += total;
    originMap[origin].count += 1;

    if (total > biggestSale.total) {
      biggestSale = {
        total: total,
        client: client
      };
    }
  });

  var clients = Object.keys(clientMap).map(function(key) {
    return clientMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var sellers = Object.keys(sellerMap).map(function(key) {
    return sellerMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var origins = Object.keys(originMap).map(function(key) {
    return originMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  return {
    totalSales: totalSales,
    totalProfit: totalProfit,
    averageTicket: averageTicket,
    salesCount: sales.length,
    itemsSold: itemsSold,
    marginPercent: marginPercent,
    bestClient: clients[0] || { name: "-", total: 0, count: 0 },
    bestSeller: sellers[0] || { name: "-", total: 0, count: 0 },
    bestOrigin: origins[0] || { name: "-", total: 0, count: 0 },
    biggestSale: biggestSale,
    topClients: clients.slice(0, 6),
    origins: origins
  };
}

function renderDashboardSalesPerformance(data) {
  data = data || {};

  var set = function(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  set("sales-perf-average-ticket", fmt(data.averageTicket || 0));
  set("sales-perf-sales-count", data.salesCount || 0);
  set("sales-perf-items-sold", new Intl.NumberFormat(getLocale()).format(data.itemsSold || 0));
  set("sales-perf-margin", ((Number(data.marginPercent) || 0).toFixed(1)).replace(".", ",") + "%");

  set("sales-perf-best-client", (data.bestClient && data.bestClient.name) || "-");
  set("sales-perf-best-client-total", fmt((data.bestClient && data.bestClient.total) || 0));

  set("sales-perf-best-seller", (data.bestSeller && data.bestSeller.name) || "-");
  set("sales-perf-best-seller-total", fmt((data.bestSeller && data.bestSeller.total) || 0));

  set("sales-perf-origin", (data.bestOrigin && data.bestOrigin.name) || "-");
  set("sales-perf-origin-total", fmt((data.bestOrigin && data.bestOrigin.total) || 0));

  set("sales-perf-biggest-sale", fmt((data.biggestSale && data.biggestSale.total) || 0));
  set("sales-perf-biggest-sale-client", (data.biggestSale && data.biggestSale.client) || "-");

  var topClients = document.getElementById("sales-perf-top-clients");
  var origins = document.getElementById("sales-perf-origin-list");

  if (topClients) {
    if (!data.topClients || !data.topClients.length) {
      topClients.innerHTML = '<div class="empty">' + getMainDashboardText('noClientFound') + '</div>';
    } else {
      topClients.innerHTML = data.topClients.map(function(row, index) {
        return '<div class="sales-performance-row">' +
          '<div>' +
            '<strong>' + (index + 1) + '. ' + escapeDepenseHtml(row.name) + '</strong>' +
            '<small>' + formatDashboardCount(row.count || 0, 'saleUnit') + '</small>' +
          '</div>' +
          '<span>' + fmt(row.total || 0) + '</span>' +
        '</div>';
      }).join("");
    }
  }

  if (origins) {
    if (!data.origins || !data.origins.length) {
      origins.innerHTML = '<div class="empty">' + getMainDashboardText('noOriginFound') + '</div>';
    } else {
      origins.innerHTML = data.origins.map(function(row) {
        return '<div class="sales-performance-row">' +
          '<div>' +
            '<strong>' + escapeDepenseHtml(row.name) + '</strong>' +
            '<small>' + formatDashboardCount(row.count || 0, 'saleUnit') + '</small>' +
          '</div>' +
          '<span>' + fmt(row.total || 0) + '</span>' +
        '</div>';
      }).join("");
    }
  }
}

function getDashboardAccountingSummary(sales, saleItems, expenseRows, productRows, debts, quickTreasury) {
  sales = sales || [];
  saleItems = saleItems || [];
  expenseRows = expenseRows || [];
  productRows = productRows || [];
  debts = debts || {};
  quickTreasury = quickTreasury || {};

  var revenue = sales.reduce(function(sum, sale) {
    return sum + (Number(sale.total) || 0);
  }, 0);

  var grossProfit = saleItems.reduce(function(sum, item) {
    return sum + (Number(item.profit) || 0);
  }, 0);

  var cogs = saleItems.reduce(function(sum, item) {
    var qty = Number(item.quantity) || 0;
    var purchasePrice = Number(item.purchase_price) || 0;

    if (purchasePrice > 0) {
      return sum + (qty * purchasePrice);
    }

    return sum + ((Number(item.total) || 0) - (Number(item.profit) || 0));
  }, 0);

  var expenses = expenseRows.reduce(function(sum, row) {
    return sum + (Number(row.amount) || 0);
  }, 0);

  var netResult = grossProfit - expenses;

  var stockValue = productRows.reduce(function(sum, product) {
    var stock = (Number(product.stock_shop) || 0) + (Number(product.stock_warehouse) || 0);
    var purchasePrice = Number(product.purchase_price) || 0;
    return sum + (stock * purchasePrice);
  }, 0);

  var receivables = Number(debts.clientTotal) || 0;
  var payables = Number(debts.supplierTotal) || 0;
  var cash = Number(quickTreasury.balance) || 0;

  var assets = cash + stockValue + receivables;
  var liabilities = payables;
  var equity = assets - liabilities;

  return {
    revenue: revenue,
    cogs: cogs,
    grossProfit: grossProfit,
    expenses: expenses,
    netResult: netResult,
    grossRate: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
    netRate: revenue > 0 ? (netResult / revenue) * 100 : 0,
    stockValue: stockValue,
    receivables: receivables,
    payables: payables,
    cash: cash,
    assets: assets,
    liabilities: liabilities,
    equity: equity
  };
}

function renderDashboardAccountingSummary(data) {
  data = data || {};

  var set = function(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  var percent = function(value) {
    return ((Number(value) || 0).toFixed(1)).replace(".", ",") + "%";
  };

  set("acct-sum-revenue", fmt(data.revenue || 0));
  set("acct-sum-cogs", fmt(data.cogs || 0));
  set("acct-sum-gross", fmt(data.grossProfit || 0));
  set("acct-sum-gross-rate", getMainDashboardText('grossMargin') + ": " + percent(data.grossRate || 0));
  set("acct-sum-expenses", fmt(data.expenses || 0));

  set("acct-sum-net", fmt(data.netResult || 0));
  set("acct-sum-net-rate", getMainDashboardText('netMargin') + ": " + percent(data.netRate || 0));

  set("acct-sum-stock", fmt(data.stockValue || 0));
  set("acct-sum-receivables", fmt(data.receivables || 0));
  set("acct-sum-payables", fmt(data.payables || 0));
  set("acct-sum-cash", fmt(data.cash || 0));

  set("acct-sum-assets", fmt(data.assets || 0));
  set("acct-sum-liabilities", fmt(data.liabilities || 0));
  set("acct-sum-equity", fmt(data.equity || 0));

  var netEl = document.getElementById("acct-sum-net");
  if (netEl) netEl.style.color = (Number(data.netResult) || 0) < 0 ? "var(--red)" : "var(--green)";

  var equityEl = document.getElementById("acct-sum-equity");
  if (equityEl) equityEl.style.color = (Number(data.equity) || 0) < 0 ? "var(--red)" : "var(--green)";
}

function buildDashboardImportantAlerts(data) {
  data = data || {};

  var alerts = [];
  var debts = data.debts || {};
  var smartStock = data.smartStock || {};
  var purchases = data.purchases || {};
  var quickTreasury = data.quickTreasury || {};
  var accounting = data.accountingSummary || {};
  var salesPerf = data.salesPerformance || {};

  if ((smartStock.outCount || 0) > 0) {
    alerts.push({
      level: "critical",
      title: getMainDashboardText('outProducts'),
      desc: (smartStock.outCount || 0) + " " + getMainDashboardText('totalStockZero') + ".",
      action: getMainDashboardText('viewStock'),
      page: "transfert"
    });
  }

  if ((smartStock.lowCount || 0) > 0) {
    alerts.push({
      level: "warning",
      title: getMainDashboardText('lowStock'),
      desc: (smartStock.lowCount || 0) + " " + getMainDashboardText('belowMinimum') + ".",
      action: getMainDashboardText('viewStock'),
      page: "transfert"
    });
  }

  if ((debts.clientTotal || 0) > 0) {
    alerts.push({
      level: (debts.clientTotal || 0) >= 100000 ? "critical" : "warning",
      title: getMainDashboardText('clientsReceivable'),
      desc: getMainDashboardText('clientsReceivable') + ": " + fmt(debts.clientTotal || 0) + ".",
      action: getMainDashboardText('clients'),
      page: "clientes"
    });
  }

  if ((debts.supplierTotal || 0) > 0) {
    alerts.push({
      level: (debts.supplierTotal || 0) >= 100000 ? "critical" : "warning",
      title: getMainDashboardText('suppliersPayable'),
      desc: getMainDashboardText('remainingToPay') + ": " + fmt(debts.supplierTotal || 0) + ".",
      action: getMainDashboardText('suppliers'),
      page: "forn"
    });
  }

  if ((quickTreasury.monthNet || 0) < 0) {
    alerts.push({
      level: "critical",
      title: getMainDashboardText('negativeTreasury'),
      desc: getMainDashboardText('treasuryResult') + ": " + fmt(quickTreasury.monthNet || 0) + ".",
      action: getMainDashboardText('treasury'),
      page: "tresorerie"
    });
  }

  if ((accounting.netResult || 0) < 0) {
    alerts.push({
      level: "critical",
      title: getMainDashboardText('negativeNetResult'),
      desc: getMainDashboardText('estimatedResult') + ": " + fmt(accounting.netResult || 0) + ".",
      action: getMainDashboardText('accounting'),
      page: "comptabilite"
    });
  }

  if ((salesPerf.marginPercent || 0) > 0 && (salesPerf.marginPercent || 0) < 15) {
    alerts.push({
      level: "warning",
      title: getMainDashboardText('lowMargin'),
      desc: getMainDashboardText('avgMargin') + ": " + ((salesPerf.marginPercent || 0).toFixed(1)).replace(".", ",") + "%.",
      action: getMainDashboardText('sales'),
      page: "venda"
    });
  }

  if ((purchases.creditTotal || 0) > 0) {
    alerts.push({
      level: "warning",
      title: getMainDashboardText('creditPurchases'),
      desc: getMainDashboardText('creditPurchaseRemain') + ": " + fmt(purchases.creditTotal || 0) + ".",
      action: getMainDashboardText('purchases'),
      page: "achat"
    });
  }

  if (smartStock.alerts && smartStock.alerts.length) {
    smartStock.alerts.slice(0, 3).forEach(function(row) {
      alerts.push({
        level: Number(row.stock) <= 0 ? "critical" : "warning",
        title: row.name || getMainDashboardText('product'),
        desc: getMainDashboardText('currentStock') + ": " + (row.stock || 0) + " " + getMainDashboardText('unit') + ".",
        action: getMainDashboardText('stock'),
        page: "transfert"
      });
    });
  }

  var critical = alerts.filter(function(alert) {
    return alert.level === "critical";
  }).length;

  var warning = alerts.filter(function(alert) {
    return alert.level === "warning";
  }).length;

  return {
    critical: critical,
    warning: warning,
    total: alerts.length,
    alerts: alerts.slice(0, 10)
  };
}

function renderDashboardImportantAlerts(data) {
  data = data || {};

  var set = function(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  set("important-alerts-critical", data.critical || 0);
  set("important-alerts-warning", data.warning || 0);
  set("important-alerts-total", data.total || 0);

  var list = document.getElementById("important-alerts-list");
  if (!list) return;

  if (!data.alerts || !data.alerts.length) {
    list.innerHTML = '<div class="empty">' + getMainDashboardText('noImportantAlert') + '</div>';
    return;
  }

  list.innerHTML = data.alerts.map(function(alert) {
    return '<div class="important-alert-row ' + escapeDepenseHtml(alert.level || "warning") + '">' +
      '<div class="important-alert-dot"></div>' +
      '<div class="important-alert-content">' +
        '<strong>' + escapeDepenseHtml(alert.title || "Alerte") + '</strong>' +
        '<small>' + escapeDepenseHtml(alert.desc || "") + '</small>' +
      '</div>' +
      '<button class="important-alert-action" aria-label="Voir plus" onclick="goTo(\'' + escapeDepenseHtml(alert.page || "dashboard") + '\', null)">' +
        '<span>›</span>' +
    '</button>' +
    '</div>';
  }).join("");
}

var lastDashboardData = null;
var lastDashboardFilters = null;
var dashboardRequestSeq = 0;
var dashboardLoadingTimer = null;
function renderDashboardData(d) {
  if (!d) return;
  lastDashboardData = d;
  document.getElementById('k-hoje').textContent = fmt(d.vendasHoje);
  document.getElementById('k-hoje-n').textContent = formatDashboardCount(d.vendasHojeCount || 0, 'transactions');
  document.getElementById('k-lucro').textContent = fmt(d.lucroMes);
  document.getElementById('k-alertas').textContent = d.alertas || 0;
  document.getElementById('k-depenses').textContent = fmt(d.totalDepenses);
  document.getElementById('k-depenses-n').textContent = formatDashboardCount(d.depensesCount || 0, 'registos');
  renderDashboardQuickTreasury(d.quickTreasury, d.pagamentos || {});
  renderDashboardDebts(d.debts);
  renderDashboardPurchases(d.purchases);
  renderDashboardSmartStock(d.smartStock);
  renderDashboardSalesPerformance(d.salesPerformance);
  renderDashboardAccountingSummary(d.accountingSummary);
  renderDashboardImportantAlerts(d.importantAlerts);

  var el = document.getElementById('top-list');
  el.innerHTML = '';
  if (!d.topProdutos || d.topProdutos.length === 0) {
    el.innerHTML = '<div class="empty">' + getMainDashboardText('noData') + '</div>';
  } else {
    d.topProdutos.forEach(function(p, i) {
      el.innerHTML += '<div class="top-item">' +
        '<div class="top-rank ' + (i===0?'first':'') + '">' + (i+1) + '</div>' +
        '<div class="top-name">' + escapeDepenseHtml(p.name || '') + '</div>' +
        '<div class="top-total">' + fmt(p.total) + '</div>' +
        '</div>';
    });
  }

  var pg = d.pagamentos || {};
  var tot = (pg.Cash||0) + (pg.Express||0) + (pg.Cartao||0) + (pg.Credito||0);
  document.getElementById('b-cash').style.width = tot > 0 ? ((pg.Cash||0)/tot*100) + '%' : '0%';
  document.getElementById('b-express').style.width = tot > 0 ? ((pg.Express||0)/tot*100) + '%' : '0%';
  document.getElementById('b-card').style.width = tot > 0 ? ((pg.Cartao||0)/tot*100) + '%' : '0%';
  document.getElementById('a-cash').textContent = fmt(pg.Cash||0);
  document.getElementById('a-express').textContent = fmt(pg.Express||0);
  document.getElementById('a-card').textContent = fmt(pg.Cartao||0);

  var al = document.getElementById('alert-list');
  if (!d.stockAlertas || d.stockAlertas.length === 0) {
    al.innerHTML = '<div class="empty">' + getMainDashboardText('stockOk') + '</div>';
  } else {
    al.innerHTML = '';
    d.stockAlertas.forEach(function(a) {
      al.innerHTML += '<div class="alert-row ' + a.level + '">' +
        '<span>' + escapeDepenseHtml(a.name || '') + '</span>' +
        '<span class="badge ' + a.level + '">' + a.stock + ' ' + getMainDashboardText('unit') + '</span>' +
        '</div>';
    });
  }

  var dl = document.getElementById('depenses-list');
  if (!d.depenses || d.depenses.length === 0) {
    dl.innerHTML = '<div class="empty">' + getMainDashboardText('noExpenses') + '</div>';
  } else {
    dl.innerHTML = '';
    d.depenses.forEach(function(dep) {
      dl.innerHTML += '<div class="top-item">' +
        '<div class="top-name">' + dep.desc + '</div>' +
        '<div style="font-size:10px;color:var(--muted);margin-right:8px;">' + dep.date + '</div>' +
        '<div class="top-total" style="color:var(--red)">-' + fmt(dep.valor) + '</div>' +
        '</div>';
    });
  }

  translateMainDashboard();
}

function escapeDashboardTicketText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDashboardPrintPeriod() {
  if (lastDashboardFilters && lastDashboardFilters.from && lastDashboardFilters.to) {
    return lastDashboardFilters.from + ' - ' + lastDashboardFilters.to;
  }
  var filters = getDashFilters();
  return filters.from + ' - ' + filters.to;
}

function printDashboardTicket() {
  if (!lastDashboardData) {
    toast(getText('loading') || 'Carregando...', 'info');
    loadDashboard();
    return;
  }

  var d = lastDashboardData || {};
  var pg = d.pagamentos || {};
  var cash = Number(pg.Cash || 0);
  var express = Number(pg.Express || 0);
  var cartao = Number(pg.Cartao || 0);
  var credito = Number(pg.Credito || 0);
  var totalPagamentos = cash + express + cartao + credito;
  var periodText = getDashboardPrintPeriod();
  var lang = (config && config.language) || 'pt';
  var title = lang === 'fr' ? 'Resume Dashboard' : (lang === 'en' ? 'Dashboard Summary' : 'Resumo Dashboard');
  var salesLabel = lang === 'fr' ? 'Ventes totales' : (lang === 'en' ? 'Total Sales' : 'Vendas totais');
  var salesCountLabel = lang === 'fr' ? 'Transactions' : (lang === 'en' ? 'Transactions' : 'Transacoes');
  var profitLabel = lang === 'fr' ? 'Benefice total' : (lang === 'en' ? 'Total Profit' : 'Lucro total');
  var expenseLabel = lang === 'fr' ? 'Depenses totales' : (lang === 'en' ? 'Total Expenses' : 'Despesas totais');
  var alertsLabel = lang === 'fr' ? 'Alertes stock' : (lang === 'en' ? 'Stock Alerts' : 'Alertas stock');
  var paymentLabel = lang === 'fr' ? 'Ventes par paiement' : (lang === 'en' ? 'Sales by Payment' : 'Vendas por pagamento');
  var topLabel = lang === 'fr' ? 'Top produits' : (lang === 'en' ? 'Top products' : 'Top produtos');
  var periodLabel = lang === 'fr' ? 'Periode' : (lang === 'en' ? 'Period' : 'Periodo');
  var printedLabel = lang === 'fr' ? 'Imprime le' : (lang === 'en' ? 'Printed on' : 'Impresso em');
  var noDataLabel = lang === 'fr' ? 'Aucune donnee' : (lang === 'en' ? 'No data' : 'Sem dados');
  var depCountLabel = lang === 'fr' ? 'Registres depenses' : (lang === 'en' ? 'Expense records' : 'Registos despesas');

  var logoImage = (config && config.receiptLogo) ? '<img src="' + escapeDashboardTicketText(config.receiptLogo) + '" style="display:block;max-width:100%;height:auto;margin:0 auto 8px auto;object-fit:contain;width:' + escapeDashboardTicketText((config.receiptLogoSize || '16') + 'mm') + ';">' : '';
  var shopName = escapeDashboardTicketText((config && config.name) || 'Azul Gestão');
  var shopSub = escapeDashboardTicketText((config && config.slogan) || '');
  var address = escapeDashboardTicketText((config && config.receiptAddress) || '');
  var phone = escapeDashboardTicketText((config && config.receiptPhone) || '');
  var topRows = '';
  if (d.topProdutos && d.topProdutos.length) {
    d.topProdutos.slice(0, 5).forEach(function(item, idx) {
      topRows += '<tr><td>' + (idx + 1) + '. ' + escapeDashboardTicketText(item.name || '') + '</td><td style="text-align:right;">' + escapeDashboardTicketText(fmt(item.total || 0)) + '</td></tr>';
    });
  } else {
    topRows = '<tr><td colspan="2" style="text-align:center;">' + noDataLabel + '</td></tr>';
  }

  var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>' +
    'body{font-family:Arial,sans-serif;color:#000;background:#fff;margin:0;padding:0;}' +
    '.ticket{width:80mm;padding:10px 8px;margin:0 auto;box-sizing:border-box;}' +
    '.logo-text{text-align:center;font-size:17px;font-weight:800;letter-spacing:.4px;margin-bottom:4px;color:#000;}' +
    '.sub{text-align:center;font-size:11px;font-weight:700;color:#000;margin-bottom:2px;}' +
    '.meta{text-align:center;font-size:10px;font-weight:700;color:#000;line-height:1.45;margin-bottom:8px;}' +
    '.title{text-align:center;font-size:14px;font-weight:800;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:6px 0;margin:8px 0;color:#000;}' +
    '.period-box{margin:8px 0 6px 0;border:1px solid #000;padding:6px 8px;text-align:center;color:#000;}' +
    '.period-label{font-size:9px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;margin-bottom:3px;}' +
    '.period-value{font-size:11px;font-weight:800;line-height:1.35;}' +
    '.line{display:flex;justify-content:space-between;gap:12px;font-size:11px;font-weight:700;color:#000;padding:2px 0;}' +
    '.section{margin-top:8px;border-top:1px dashed #000;padding-top:6px;}' +
    '.section h4{margin:0 0 6px 0;font-size:11px;font-weight:800;text-transform:uppercase;color:#000;}' +
    'table{width:100%;border-collapse:collapse;font-size:10px;color:#000;}' +
    'td,th{padding:3px 0;font-weight:700;color:#000;}' +
    'th{text-align:left;border-bottom:1px solid #000;}' +
    '.footer{margin-top:10px;text-align:center;font-size:10px;font-weight:700;color:#000;border-top:1px dashed #000;padding-top:6px;}' +
    '@media print{body{margin:0;} .ticket{width:80mm;padding:8px;}}' +
    '</style></head><body><div class="ticket">' +
    logoImage +
    '<div class="logo-text">' + shopName + '</div>' +
    (shopSub ? '<div class="sub">' + shopSub + '</div>' : '') +
    (address ? '<div class="meta">' + address + '</div>' : '') +
    (phone ? '<div class="meta">' + phone + '</div>' : '') +
    '<div class="title">' + title + '</div>' +
    '<div class="period-box"><div class="period-label">' + periodLabel + '</div><div class="period-value">' + escapeDashboardTicketText(periodText) + '</div></div>' +
    '<div class="line"><span>' + printedLabel + '</span><span>' + escapeDashboardTicketText(new Date().toLocaleString()) + '</span></div>' +
    '<div class="section">' +
      '<div class="line"><span>' + salesLabel + '</span><span>' + escapeDashboardTicketText(fmt(d.vendasHoje || 0)) + '</span></div>' +
      '<div class="line"><span>' + salesCountLabel + '</span><span>' + escapeDashboardTicketText(d.vendasHojeCount || 0) + '</span></div>' +
      '<div class="line"><span>' + profitLabel + '</span><span>' + escapeDashboardTicketText(fmt(d.lucroMes || 0)) + '</span></div>' +
      '<div class="line"><span>' + expenseLabel + '</span><span>' + escapeDashboardTicketText(fmt(d.totalDepenses || 0)) + '</span></div>' +
      '<div class="line"><span>' + depCountLabel + '</span><span>' + escapeDashboardTicketText(d.depensesCount || 0) + '</span></div>' +
      '<div class="line"><span>' + alertsLabel + '</span><span>' + escapeDashboardTicketText(d.alertas || 0) + '</span></div>' +
    '</div>' +
    '<div class="section"><h4>' + paymentLabel + '</h4>' +
      '<div class="line"><span>Cash</span><span>' + escapeDashboardTicketText(fmt(cash)) + '</span></div>' +
      '<div class="line"><span>Express</span><span>' + escapeDashboardTicketText(fmt(express)) + '</span></div>' +
      '<div class="line"><span>Cartao</span><span>' + escapeDashboardTicketText(fmt(cartao)) + '</span></div>' +
      '<div class="line"><span>Credito</span><span>' + escapeDashboardTicketText(fmt(credito)) + '</span></div>' +
      '<div class="line"><span>Total</span><span>' + escapeDashboardTicketText(fmt(totalPagamentos)) + '</span></div>' +
    '</div>' +
    '<div class="section"><h4>' + topLabel + '</h4><table><tbody>' + topRows + '</tbody></table></div>' +
    '<div class="footer">' + shopName + '</div>' +
    '</div></body></html>';

  var w = window.open('', '_blank', 'width=420,height=760');
  if (!w) {
    toast('Popup bloqueado', 'error');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(function() { w.print(); }, 350);
}

async function loadDashboard() {
  var filters;

  try {
    filters = getDashFilters();
    lastDashboardFilters = filters;
  } catch (e) {
    toast("Erro filtro: " + (e && e.message ? e.message : e), "error");
    return;
  }

  dashboardRequestSeq++;
  var requestId = dashboardRequestSeq;

  if (dashboardLoadingTimer) clearTimeout(dashboardLoadingTimer);

  setDashboardFilterLoading(true);

dashboardLoadingTimer = setTimeout(function() {
  if (requestId !== dashboardRequestSeq) return;
  setDashboardFilterLoading(false);
  toast("Dashboard encore en chargement...", "info");
}, 30000);

  try {
    var data = await getDashboardDataFromSupabase(filters);

    if (requestId !== dashboardRequestSeq) return;

    if (dashboardLoadingTimer) {
      clearTimeout(dashboardLoadingTimer);
      dashboardLoadingTimer = null;
    }

    renderDashboardData(data);
    applyLanguage();

  } catch (e) {
    console.error("Erro dashboard:", e);
    toast("Erro dashboard: " + (e.message || e), "error");

  } finally {
    if (requestId === dashboardRequestSeq) {
      setDashboardFilterLoading(false);
    }
  }
}

// ===== PRODUCTS =====
// ===== PRODUCTS =====
var productsLoading = false;

function setVendaProductsLoading(isLoading) {
  productsLoading = isLoading;
  var grid = document.getElementById('prodGrid');
  if (grid && isLoading) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">A carregar produtos...</div>';
  }
}

function buildProductSearchText(product) {
  product = product || {};
  return [
    product.name,
    product.photo,
    product.code,
    product.category,
    product.mainSupplier,
    product.supplier,
    product.variation,
    Array.isArray(product.variations) ? product.variations.join(' ') : product.variations
  ].map(function(value) {
    return String(value || '').toLowerCase();
  }).join(' ');
}

function normalizeProductList(list) {
  var seen = {};
  return (Array.isArray(list) ? list : []).map(function(product) {
    product = product || {};
    var name = String(product.name || '').trim();
    if (!name) return null;
    var key = name.toLowerCase();
    if (seen[key]) return null;
    seen[key] = true;
    var normalized = {
      id: product.id || "",
      name: name,
      price: parseFloat(product.price) || 0,
     stock: parseFloat(product.stock) || 0,
      stockage: parseFloat(product.stockage || product.stock) || 0,
      stockBoutique: parseFloat(product.stockBoutique) || 0,
      entries: parseFloat(product.entries) || 0,
      exits: parseFloat(product.exits) || 0,
      photo: String(product.photo || ''),
      category: String(product.category || ''),
      code: String(product.code || ''),
      variation: String(product.variation || ''),
      variations: parseVariationList(product.variations || product.variation || ''),
      purchasePrice: parseFloat(product.purchasePrice) || parseFloat(product.price) || 0,
      targetMargin: parseFloat(product.targetMargin) || 0,
      mainSupplier: String(product.mainSupplier || product.supplier || ''),
      supplier: String(product.supplier || product.mainSupplier || '')
    };

    normalized._searchText = buildProductSearchText(normalized);
    return normalized;
  }).filter(function(product) {
    return !!product;
  });
}

function productSearchText(product) {
  return product && product._searchText ? product._searchText : buildProductSearchText(product);
}

function setupVendaSearchFilter() {
  var input = document.getElementById('searchInput');
  if (!input) return;
  input.oninput = filterProds;
}
async function loadProducts(forceRefresh) {
  if (productsLoading) return;

  var vendaPage = document.getElementById("page-venda");
  var vendaActive = vendaPage && vendaPage.classList.contains("active");

  if (!forceRefresh && vendaActive && products && products.length) {
    filterProds();
    return;
  }

  var btn = document.getElementById("refreshBtn");

  try {
    productsLoading = true;

    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.45";
    }

    if (!products || !products.length) {
      setVendaProductsLoading(true);
    }

    var data = await getProductsFromSupabase();

    products = normalizeProductList(data);
    products = applyInventoryMovementSummary(products, await getInventoryMovementSummaryFromSupabase());

    setVendaProductsLoading(false);
    filterProds();
    renderRevProducts(products);
    renderAchatProductDatalist();
    renderFornPayDatalist();
    renderFornNameDatalist();
    rendertransfertDatalist();
    renderProductProfileOptions();
    renderClientDatalist();
    renderinventaire(products);

  } catch (e) {
    console.error("Erro Supabase produtos:", e);
    setVendaProductsLoading(false);
    toast("Erro ao carregar produtos: " + (e.message || e), "error");

  } finally {
    productsLoading = false;

    if (btn) {
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  }
}

//MOI-MEME
function renderAchatProductDatalist() {
  var list = document.getElementById('prodList');
  if (!list) return;

  // 1. récupérer les nom des fournisseurs
  var name = (products || [])
    .map(p => p.name)
    .filter(f => f && f.trim() !== '');

  // 2. enlever les doublons
  var uniques = [...new Set(name)];

  // 3. générer les options
  list.innerHTML = uniques.map(function(f) {
    return '<option value="' + escapeDepenseHtml(f) + '"></option>';
  }).join('');
}

//MOI-MEME
function renderFornNameDatalist() {
  renderSupplierDatalists();
}
//MOI-MEME
function renderFornPayDatalist() {
  renderSupplierDatalists();
}

function fillFornecedorDatalists(names) {
  var uniques = [];
  var seen = {};
  (names || []).forEach(function(name) {
    var value = String(name || '').trim();
    var key = value.toLowerCase();
    if (!value || seen[key]) return;
    seen[key] = true;
    uniques.push(value);
  });
  ['list-forn', 'list-pay-forn'].forEach(function(id) {
    var list = document.getElementById(id);
    if (!list) return;
    list.innerHTML = uniques.map(function(f) {
      return '<option value="' + escapeDepenseHtml(f) + '"></option>';
    }).join('');
  });
}

function refreshFornecedorDatalists() {
  var productSuppliers = (products || [])
    .map(function(p) { return p.supplier || p.mainSupplier; })
    .filter(function(f) { return f && String(f).trim() !== ''; });
  fillFornecedorDatalists(productSuppliers);
  gsCall('getFornecedorNames', {}, function(names) {
    fillFornecedorDatalists(productSuppliers.concat(Array.isArray(names) ? names : []));
  });
}

renderFornNameDatalist = refreshFornecedorDatalists;
renderFornPayDatalist = refreshFornecedorDatalists;

function renderClientDatalist() {
  var params = "";
  gsCall('getVentes', params, function(data) {
    data = data || [];
    
    var list = document.getElementById('list-client');
    if (!list) return;

    // 1. récupérer les fournisseurs
    var clients = [...new Set(
      data
        .map(a => (a.client || '').trim().toLowerCase())
        .filter(c => c !== '')
    )];

    // 3. générer les options
    list.innerHTML = clients.map(function(client) {
  return '<option value="' + client + '">' + client + '</option>';
  }).join('');
  });
}

function rendertransfertDatalist() {
  var list = document.getElementById('transProdList');
  if (!list) return;

  // 1. récupérer les fournisseurs
  var name = (products || [])
    .map(p => p.name)
    .filter(f => f && f.trim() !== '');

  // 2. enlever les doublons
  var uniques = [...new Set(name)];

  // 3. générer les options
  list.innerHTML = uniques.map(function(f) {
    return '<option value="' + escapeDepenseHtml(f) + '"></option>';
  }).join('');
}

function applyfornNamePreset(index, value) {
  fornLines[index].prod = value;
  var product = (products || []).find(function(p) { return p.name === value; });
  if (!product) return;
  fornLines[index].code = achatLines[index].code || product.code || '';
  achatLines[index].category = achatLines[index].category || product.category || '';
  achatLines[index].variation = achatLines[index].variation || product.variation || '';
  achatLines[index].variations = achatLines[index].variations && achatLines[index].variations.length ? achatLines[index].variations : parseVariationList(product.variation || product.variations || []);
  achatLines[index].photo = achatLines[index].photo || product.photo || '';
  achatLines[index].targetMargin = achatLines[index].targetMargin || product.targetMargin || '';
  achatLines[index].price = achatLines[index].price || product.purchasePrice || product.price || 0;
  var forn = document.getElementById('a-forn');
  if (forn && !forn.value && product.mainSupplier) forn.value = product.mainSupplier;
  renderAchatLines();
}

function applyAchatProductPreset(index, value) {
  achatLines[index].prod = value;
  var product = (products || []).find(function(p) { return p.name === value; });
  if (!product) return;
  achatLines[index].code = achatLines[index].code || product.code || '';
  achatLines[index].category = achatLines[index].category || product.category || '';
  achatLines[index].variation = achatLines[index].variation || product.variation || '';
  achatLines[index].variations = achatLines[index].variations && achatLines[index].variations.length ? achatLines[index].variations : parseVariationList(product.variation || product.variations || []);
  achatLines[index].photo = achatLines[index].photo || product.photo || '';
  achatLines[index].targetMargin = achatLines[index].targetMargin || product.targetMargin || '';
  achatLines[index].price = achatLines[index].price || product.purchasePrice || product.price || 0;
  var forn = document.getElementById('a-forn');
  if (forn && !forn.value && product.mainSupplier) forn.value = product.mainSupplier;
  renderAchatLines();
}

function parseVariationList(value) {
  if (Array.isArray(value)) {
    return value.map(function(entry) { return String(entry || '').trim(); }).filter(function(entry, index, list) {
      return entry && list.indexOf(entry) === index;
    });
  }
  return String(value || '')
    .split(/\s*[|,;]+\s*/)
    .map(function(entry) { return String(entry || '').trim(); })
    .filter(function(entry, index, list) {
      return entry && list.indexOf(entry) === index;
    });
}

function addAchatVariation(index) {
  var input = document.getElementById('al-var-new-' + index);
  if (!input || !achatLines[index]) return;
  var value = input.value.trim();
  if (!value) return;
  achatLines[index].variations = achatLines[index].variations || [];
  if (achatLines[index].variations.indexOf(value) === -1) {
    achatLines[index].variations.push(value);
  }
  achatLines[index].variation = achatLines[index].variations.join(' | ');
  input.value = '';
  renderAchatLines();
}

function removeAchatVariation(index, chipIndex) {
  if (!achatLines[index]) return;
  achatLines[index].variations = achatLines[index].variations || [];
  achatLines[index].variations.splice(chipIndex, 1);
  achatLines[index].variation = achatLines[index].variations.join(' | ');
  renderAchatLines();
}

function handleAchatPhotoFile(event, index) {
  var file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file || !achatLines[index]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    achatLines[index].photo = e && e.target ? (e.target.result || '') : '';
    renderAchatLines();
  };
  reader.readAsDataURL(file);
}

function toggleCartVariation(event, index, encoded) {
  if (event && event.stopPropagation) event.stopPropagation();
  var value = decodeURIComponent(encoded || '');
  var item = cart[index];
  if (!item) return;
  item.selectedVariations = item.selectedVariations || [];
  var pos = item.selectedVariations.indexOf(value);
  if (pos >= 0) item.selectedVariations.splice(pos, 1); else item.selectedVariations.push(value);
  renderCart();
}

function toggleRevVariation(index, encoded) {
  var value = decodeURIComponent(encoded || '');
  var item = revCart[index];
  if (!item) return;
  item.selectedVariations = item.selectedVariations || [];
  var pos = item.selectedVariations.indexOf(value);
  if (pos >= 0) item.selectedVariations.splice(pos, 1); else item.selectedVariations.push(value);
  renderRevCart();
}

function getItemDisplayName(item) {
  var selected = item && item.selectedVariations ? item.selectedVariations : [];
  return selected && selected.length ? (item.name + ' [' + selected.join(', ') + ']') : item.name;
}

function renderProductProfileOptions() {
  var select = document.getElementById('product-profile-select');
  if (!select) return;
  var current = select.value || '';
  var html = '<option value="">Choisir un produit...</option>';
  (products || []).forEach(function(p) {
    html += '<option value="' + escapeDepenseHtml(p.name) + '">' + escapeDepenseHtml(p.name) + (p.code ? ' [' + escapeDepenseHtml(p.code) + ']' : '') + '</option>';
  });
  select.innerHTML = html;
  if (current && (products || []).some(function(p) { return p.name === current; })) {
    select.value = current;
  } else if ((products || []).length) {
    select.value = products[0].name;
  }
  loadSelectedProductProfile();
}

function loadSelectedProductProfile() {
  var select = document.getElementById('product-profile-select');
  if (!select) return;
  var product = (products || []).find(function(p) { return p.name === select.value; });
  var category = document.getElementById('product-profile-category');
  var code = document.getElementById('product-profile-code');
  var photo = document.getElementById('product-profile-photo');
  var purchasePrice = document.getElementById('product-profile-purchase-price');
  var margin = document.getElementById('product-profile-margin');
  var supplier = document.getElementById('product-profile-supplier');
  if (!product) {
    if (category) category.value = '';
    if (code) code.value = '';
    if (photo) photo.value = '';
    if (purchasePrice) purchasePrice.value = '';
    if (margin) margin.value = '';
    if (supplier) supplier.value = '';
    updateProductPhotoPreview('');
    return;
  }
  if (category) category.value = product.category || '';
  if (code) code.value = product.code || '';
  if (photo) photo.value = product.photo || '';
  if (purchasePrice) purchasePrice.value = product.purchasePrice || '';
  if (margin) margin.value = product.targetMargin || '';
  if (supplier) supplier.value = product.mainSupplier || '';
  updateProductPhotoPreview(product.photo || '');
}

function updateProductPhotoPreview(value) {
  var preview = document.getElementById('product-profile-photo-preview');
  var empty = document.getElementById('product-profile-photo-empty');
  if (!preview || !empty) return;
  var src = (value || '').trim();
  if (!src) {
    preview.style.display = 'none';
    preview.removeAttribute('src');
    empty.style.display = 'block';
    return;
  }
  preview.src = src;
  preview.style.display = 'block';
  preview.onerror = function() {
    preview.style.display = 'none';
    empty.style.display = 'block';
  };
  preview.onload = function() {
    empty.style.display = 'none';
  };
}

function handleProductPhotoFile(event) {
  var file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var value = e && e.target ? e.target.result : '';
    var input = document.getElementById('product-profile-photo');
    if (input) input.value = value;
    updateProductPhotoPreview(value);
  };
  reader.readAsDataURL(file);
}

function saveProductProfileCard() {
  var select = document.getElementById('product-profile-select');
  if (!select || !select.value) {
    toast('Choisis un produit d\'abord.', 'error');
    return;
  }
  var btn = document.getElementById('product-profile-save-btn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.textContent = 'Enregistrement...';
  }
  gsCall('saveProductProfile', {
    name: select.value,
    category: (document.getElementById('product-profile-category') || {}).value || '',
    code: (document.getElementById('product-profile-code') || {}).value || '',
    variation: '',
    photo: (document.getElementById('product-profile-photo') || {}).value || '',
    purchasePrice: (document.getElementById('product-profile-purchase-price') || {}).value || '',
    targetMargin: (document.getElementById('product-profile-margin') || {}).value || '',
    mainSupplier: (document.getElementById('product-profile-supplier') || {}).value || ''
  }, function() {
    toast('Fiche produit enregistree.', 'success');
    loadProducts();
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = getText('save_product_profile') || 'Enregistrer la fiche produit';
    }
  });
}
//==============modification carde product=====================
function renderProds(list) {
  var g = document.getElementById('prodGrid');
  if (!g) return;
  if (productsLoading) {
    g.innerHTML = '<div class="empty" style="grid-column:1/-1">A carregar produtos...</div>';
    return;
  }
  list = (Array.isArray(list) ? list : []).filter(function(product) {
    return product && product.name;
  });
  if (!list.length) {
    g.innerHTML = '<div class="empty" style="grid-column:1/-1">Sem produtos</div>';
    return;
  }
  g.innerHTML = '';
  list.forEach(function(p) {
    var out = p.stockBoutique <= 0;
    var low = p.stockBoutique > 0 && p.stockBoutique <= 3;
    var meta = parseVariationList(p.variation || p.variations);
    var div = document.createElement('div');
    div.className = 'prod-card' + (out ? ' out' : '');
    div.innerHTML =
      '<img class="prod-img" src="' + (p.photo || '') + '" alt="Description">' +
      '<div class="prod-name"> ' + p.name + '</div>' +
      '<div class="prod-price" style="margin-left:8px;margin-top:4px;">' + fmt(p.salePrice || p.price || 0) + '</div>' +
      (meta && meta.some(function(item) { return item && item.trim() !== ''; })
      ? '<div class="prod-variation">' 
        + meta
            .filter(function(item) { return item && item.trim() !== ''; })
            .map(function(item) {
              return "<span style='border:0.5px solid var(--muted);border-radius:5px;padding:5px;margin-right:10px;'>" + item + "</span>";
            }).join('')
        + '</div>'
      : "<span style='font-size: 12px; color: var(--muted); margin-top: 3px; margin-left: 8px;'>sans variable</span>") +
      '<div class="prod-stock ' + (out ? 'out' : low ? 'low' : '') + '">' +
        (out ? ' Esgotado' : 'Stock : ' + p.stockBoutique + ' un') +
      '</div>';
  div.onclick = function() {
  addToCart(p.id, p.stockBoutique);
  };

    g.appendChild(div);
  });
}

function filterProds() {
  var input = document.getElementById('searchInput');
  var q = String((input && input.value) || '').trim().toLowerCase();
  var source = products || [];
  var list = q ? source.filter(function(p) {
    return productSearchText(p).indexOf(q) >= 0;
  }) : source;
  renderProds(list);
}
// ===== CART =====
function addToCart(productIdOrName, stock) {
  var product = (products || []).find(function(p) {
    return String(p.id) === String(productIdOrName);
  }) || (products || []).find(function(p) {
    return p.name === productIdOrName;
  }) || {};

  var salePrice = parseFloat(product.salePrice || product.price) || 0;

  cart.push({
    productId: product.id || "",
    name: product.name || String(productIdOrName || ""),
    baseName: product.name || String(productIdOrName || ""),
    supplier: product.supplier || product.mainSupplier || "",
    purchasePrice: parseFloat(product.purchasePrice) || 0,
    price: salePrice,
    regularPrice: salePrice,
    qty: 1,
    stock: stock,
    availableVariations: parseVariationList(product.variation || product.variations),
    selectedVariations: []
  });

  renderCart();

  setTimeout(function() {
    var inputs = document.querySelectorAll(".ci-price-input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}


function renderCart() {
  var el = document.getElementById('cartBody');
  if (cart.length === 0) {
    el.innerHTML = '<div class="empty">' + getText('cart_empty') + '</div>';
    document.getElementById('confirmBtn').disabled = true;
    document.getElementById('confirmBtn').textContent = getText('payment');
    document.getElementById('cartTotal').textContent = '0 Kz';
    cleanupLegacyCartFooter();
    updatePaymentStatus();
    renderMobileCartBar();
    return;
  }
  el.innerHTML = '';
  var total = 0;
  cart.forEach(function(item, i) {
    total += item.price * item.qty;
    var checks = (item.availableVariations || []).map(function(v) {
      var checked = (item.selectedVariations || []).indexOf(v) >= 0 ? 'checked' : '';
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface2);cursor:pointer;"><input type="checkbox" ' + checked + ' onclick="event.stopPropagation();" onchange="toggleCartVariation(event, ' + i + ',\'' + encodeURIComponent(v) + '\')">' + v + '</label>';
    }).join('');
    var div = document.createElement('div');
    div.className = 'cart-item';
    div.setAttribute('data-index', i);
    div.innerHTML =
      '<div style="width:100%;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<div class="ci-name" style="flex:1;padding-right:8px;">' + item.name + '</div>' +
          '<button class="ci-del" onclick="removeItem(' + i + ')">x</button>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">' +
            '<button class="qbtn" style="background:none;width:18px;height:18px;" onclick="chgQty(' + i + ',-1)">-</button>' +
            '<span class="qnum">' + item.qty + '</span>' +
            '<button class="qbtn" style="background:none;width:18px;height:18px;" onclick="chgQty(' + i + ',1)">+</button>' +
          '</div>' +
          '<input type="number" class="ci-price-input" placeholder="' + getText('sale_price_placeholder') + '" value="' + (item.price||'') + '" min="0" onchange="updatePrice(' + i + ', this.value)" oninput="updatePrice(' + i + ', this.value)">' +
          '<div class="ci-total" id="ci-total-' + i + '" style="white-space:nowrap;">' + (item.price > 0 ? fmt(item.price * item.qty) : '-') + '</div>' +
        '</div>' +
        (checks ? '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">' + checks + '</div>' : '') +
      '</div>';
    el.appendChild(div);
  });
  document.getElementById('cartTotal').textContent = fmt(total);
  document.getElementById('confirmBtn').disabled = false;
  document.getElementById('confirmBtn').textContent = getText('payment');
  cleanupLegacyCartFooter();
  updatePaymentStatus();
  renderMobileCartBar();
}

function chgQty(i, d) {
  var newQty = cart[i].qty + d;

  if (newQty <= 0) {
    cart.splice(i, 1);
    renderCart();
    return;
  }

  cart[i].qty = newQty;
  renderCart();
}


function removeItem(i) { cart.splice(i, 1); renderCart(); }

function clearCart() {
  cart = [];
  document.getElementById('clientInput').value = '';
  closePaymentModal();
  renderCart();
  updatePaymentStatus();
}

function updatePrice(i, val) {
  var price = parseFloat(val) || 0;
  cart[i].price = price;
  var totalEl = document.getElementById('ci-total-' + i);
  if (totalEl) totalEl.textContent = price > 0 ? fmt(price * cart[i].qty) : '-';
  var total = cart.reduce(function(s,item) { return s + (item.price||0) * item.qty; }, 0);
  document.getElementById('cartTotal').textContent = fmt(total);
  updatePaymentStatus();
}
function generateConsignmentNo() {
  var now = new Date();
  return "CON-" +
    String(now.getFullYear()).slice(-2) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "-" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
}

function getRevSelectionIds() {
  return Array.prototype.slice.call(document.querySelectorAll(".rev-open-check:checked"))
    .map(function(input) { return input.value; })
    .filter(Boolean);
}

function groupRevCartQuantityByProduct(items) {
  var grouped = {};

  (items || []).forEach(function(item) {
    var key = getCartProductKey(item);
    if (!key) return;

    grouped[key] = (grouped[key] || 0) + (Number(item.qty) || 0);
  });

  return grouped;
}

async function createConsignmentInSupabase(data) {
  var organizationId = getAzulOrganizationId();
  var items = data.items || [];
  var consignmentNo = generateConsignmentNo();

  if (!data.revendeur) throw new Error("Revendeur obrigatorio.");
  if (!items.length) throw new Error("Ajoute au moins un produit.");

  var total = items.reduce(function(sum, item) {
    return sum + (Number(item.qty) || 0) * (Number(item.price) || 0);
  }, 0);

  var qtyByProduct = groupRevCartQuantityByProduct(items);

Object.keys(qtyByProduct).forEach(function(productKey) {
  var product = (products || []).find(function(p) {
    return String(p.id) === String(productKey) || p.name === productKey;
  });

  if (!product) {
    throw new Error("Produto nao encontrado: " + productKey);
  }

  var qty = qtyByProduct[productKey];
  var stock = Number(product.stockBoutique) || 0;

  if (stock < qty) {
    throw new Error("Stock insuficiente para " + product.name + ". Disponivel: " + stock);
  }
});

  var consignmentResult = await supabaseClient
    .from("reseller_consignments")
    .insert({
      organization_id: organizationId,
      consignment_no: consignmentNo,
      reseller_name: data.revendeur,
      consignment_date: data.date || new Date().toISOString().split("T")[0],
      status: "open",
      total: total,
      paid_amount: 0
    })
    .select()
    .single();

  if (consignmentResult.error) throw consignmentResult.error;

  var consignment = consignmentResult.data;
  var itemRows = [];

  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var productRow = findProductForCartItem(item);

    if (!productRow) {
      throw new Error("Produto nao encontrado: " + item.name);
    }
    var qtyItem = Number(item.qty) || 0;

    itemRows.push({
      organization_id: organizationId,
      consignment_id: consignment.id,
      product_id: productRow.id,
      product_name: item.name,
      quantity: qtyItem,
      unit_price: Number(item.price) || 0,
      total: qtyItem * (Number(item.price) || 0),
      variation: (item.selectedVariations || []).join(" | "),
      variations: item.selectedVariations || []
    });

    // Le stock est diminue plus bas une seule fois par produit,
  // apres avoir additionne toutes les lignes de la consignation.
  }

  var itemsResult = await supabaseClient
    .from("reseller_consignment_items")
    .insert(itemRows);

  if (itemsResult.error) throw itemsResult.error;

  var groupedStock = groupRevCartQuantityByProduct(items);

for (var stockKey in groupedStock) {
  var stockProduct = (products || []).find(function(p) {
    return String(p.id) === String(stockKey) || p.name === stockKey;
  });

  if (!stockProduct) continue;

  var newShopStock = Math.max(
    0,
    (Number(stockProduct.stockBoutique) || 0) - (Number(groupedStock[stockKey]) || 0)
  );

  var stockResult = await supabaseClient
    .from("products")
    .update({
      stock_shop: newShopStock
    })
    .eq("id", stockProduct.id);

  if (stockResult.error) throw stockResult.error;
}

  return consignment;
}

async function getResellerNamesFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("reseller_consignments")
    .select("reseller_name")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (result.error) throw result.error;

  var seen = {};
  return (result.data || []).map(function(row) {
    return String(row.reseller_name || "").trim();
  }).filter(function(name) {
    var key = name.toLowerCase();
    if (!name || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

async function getConsignmentsByResellerFromSupabase(name) {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("reseller_name", name)
    .eq("status", "open")
    .order("consignment_date", { ascending: false });

  if (result.error) throw result.error;

  var consignments = result.data || [];
  if (!consignments.length) return [];

  var ids = consignments.map(function(c) { return c.id; });

  var itemsResult = await supabaseClient
    .from("reseller_consignment_items")
    .select("*")
    .in("consignment_id", ids);

  if (itemsResult.error) throw itemsResult.error;

  var itemsByConsignment = {};
  (itemsResult.data || []).forEach(function(item) {
    if (!itemsByConsignment[item.consignment_id]) itemsByConsignment[item.consignment_id] = [];
    itemsByConsignment[item.consignment_id].push(item);
  });

  return consignments.map(function(c) {
    var items = itemsByConsignment[c.id] || [];
    return {
      id: c.id,
      displayId: c.consignment_no,
      date: c.consignment_date,
      revendeur: c.reseller_name,
      status: c.status,
      total: Number(c.total) || 0,
      qty: items.reduce(function(sum, item) { return sum + (Number(item.quantity) || 0); }, 0),
      items: items.map(function(item) {
        return {
          prod: item.product_name,
          name: item.product_name,
          qty: Number(item.quantity) || 0,
          total: Number(item.total) || 0,
          product_id: item.product_id
        };
      })
    };
  });
}

async function paySelectedConsignmentsInSupabase(ids, paymentLines, actionDate) {
  var organizationId = getAzulOrganizationId();

  ids = ids || [];

  if (!ids.length) {
    throw new Error("Seleciona pelo menos uma consignacao.");
  }

  var activeLines = (paymentLines || []).filter(function(p) {
    return Number(p.montant) > 0;
  });

  var totalPaid = activeLines.reduce(function(sum, p) {
    return sum + (Number(p.montant) || 0);
  }, 0);

  if (totalPaid <= 0) {
    throw new Error("Montante de pagamento invalido.");
  }

  var paymentSummary = getRevPaymentSummary(activeLines);
  var recibo = "REV-" + Date.now();

  var consignmentsResult = await supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .in("id", ids)
    .order("consignment_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (consignmentsResult.error) throw consignmentsResult.error;

  var consignments = consignmentsResult.data || [];
  var remainingPayment = totalPaid;

  for (var i = 0; i < consignments.length && remainingPayment > 0; i++) {
    var consignment = consignments[i];

    var total = Number(consignment.total) || 0;
    var alreadyPaid = Number(consignment.paid_amount) || 0;
    var remainingDue = Math.max(0, total - alreadyPaid);

    if (remainingDue <= 0) continue;

    var applied = Math.min(remainingDue, remainingPayment);
    var newPaid = alreadyPaid + applied;
    var isFullyPaid = newPaid >= total - 0.01;

    var updateResult = await supabaseClient
      .from("reseller_consignments")
      .update({
        status: isFullyPaid ? "paid" : "open",
        paid_amount: newPaid,
        payment_summary: paymentSummary,
        receipt_no: recibo,
        closed_at: isFullyPaid ? new Date().toISOString() : null
      })
      .eq("organization_id", organizationId)
      .eq("id", consignment.id);

    if (updateResult.error) throw updateResult.error;

    var resellerItemsResult = await supabaseClient
  .from("reseller_consignment_items")
  .select("*")
  .eq("consignment_id", consignment.id);

if (resellerItemsResult.error) throw resellerItemsResult.error;

var consignmentItems = resellerItemsResult.data || [];

var productIds = consignmentItems
  .map(function(item) { return item.product_id; })
  .filter(Boolean);

var productCostMap = {};

if (productIds.length) {
  var productsResult = await supabaseClient
    .from("products")
    .select("id, purchase_price")
    .in("id", productIds);

  if (productsResult.error) throw productsResult.error;

  (productsResult.data || []).forEach(function(product) {
    productCostMap[product.id] = Number(product.purchase_price) || 0;
  });
}

var costOfGoods = consignmentItems.reduce(function(sum, item) {
  var qty = Number(item.quantity) || 0;
  var purchasePrice = productCostMap[item.product_id] || 0;
  return sum + (qty * purchasePrice);
}, 0);
    
   var accountingLines = [
  { account: "11", debit: applied, credit: 0 },
  { account: "71", debit: 0, credit: applied }
];

if (isFullyPaid && costOfGoods > 0) {
  accountingLines.push({ account: "61", debit: costOfGoods, credit: 0 });
  accountingLines.push({ account: "13", debit: 0, credit: costOfGoods });
}

await createAccountingEntry(
  "reseller_payment",
  generateLocalUuid(),
  actionDate || new Date().toISOString().split("T")[0],
  "Pagamento revendedor " + (consignment.reseller_name || ""),
  accountingLines
);

    remainingPayment -= applied;
  }

  if (remainingPayment > 0.01) {
    toast("Pagamento maior que a divida selecionada. Sobra: " + fmt(remainingPayment), "error");
  }

  return true;
}
function generateLocalUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function returnSelectedConsignmentsInSupabase(ids) {
  var organizationId = getAzulOrganizationId();

  for (var i = 0; i < ids.length; i++) {
    var itemsResult = await supabaseClient
      .from("reseller_consignment_items")
      .select("*")
      .eq("consignment_id", ids[i]);

    if (itemsResult.error) throw itemsResult.error;

    for (var j = 0; j < (itemsResult.data || []).length; j++) {
      var item = itemsResult.data[j];

      var productResult = await supabaseClient
        .from("products")
        .select("*")
        .eq("id", item.product_id)
        .single();

      if (productResult.error) throw productResult.error;

      var currentShop = Number(productResult.data.stock_shop) || 0;

      var stockResult = await supabaseClient
        .from("products")
        .update({ stock_shop: currentShop + (Number(item.quantity) || 0) })
        .eq("id", item.product_id);

      if (stockResult.error) throw stockResult.error;
    }

    var updateResult = await supabaseClient
      .from("reseller_consignments")
      .update({
        status: "returned",
        closed_at: new Date().toISOString()
      })
      .eq("organization_id", organizationId)
      .eq("id", ids[i]);

    if (updateResult.error) throw updateResult.error;
  }

  return true;
}

async function getResellerHistoryFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();

  filters = filters || {};

  var query = supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (filters.revendeur) query = query.eq("reseller_name", filters.revendeur);
  if (filters.from) query = query.gte("consignment_date", filters.from);
  if (filters.to) query = query.lte("consignment_date", filters.to);

  var result = await query;
  if (result.error) throw result.error;

  var rows = result.data || [];
  if (!rows.length) return [];

  var ids = rows.map(function(row) { return row.id; });

  var itemsResult = await supabaseClient
    .from("reseller_consignment_items")
    .select("*")
    .in("consignment_id", ids);

  if (itemsResult.error) throw itemsResult.error;

  var itemsById = {};
  (itemsResult.data || []).forEach(function(item) {
    if (!itemsById[item.consignment_id]) itemsById[item.consignment_id] = [];
    itemsById[item.consignment_id].push(item);
  });

  return rows.map(function(row) {
    var items = itemsById[row.id] || [];
    return {
      id: row.consignment_no,
      actionDate: row.consignment_date,
      revendeur: row.reseller_name,
      status: row.status,
      itemsSummary: items.map(function(item) {
        return item.product_name + " x" + item.quantity;
      }).join(", "),
      total: Number(row.total) || 0,
      payment: row.payment_summary || "",
      recibo: row.receipt_no || ""
    };
  });
}
function renderRevProducts(list) {
  var g = document.getElementById('revProdGrid');
  if (!g) return;
  if (!list || list.length === 0) {
    g.innerHTML = '<div class="empty" style="grid-column:1/-1">Sem produtos '+list+'</div>';
    return;
  }

  g.innerHTML = '';
  list.forEach(function(p) {
    var out = p.stockBoutique <= 0;
    var low = p.stockBoutique > 0 && p.stockBoutique <= 3;
    var meta = parseVariationList(p.variation || p.variations);
    var div = document.createElement('div');
    div.className = 'prod-card' + (out ? ' out' : '');
    div.innerHTML =
      '<img class="prod-img" src="' + p.photo + '" alt="Description">' +
      '<div class="prod-name"> ' + p.name + '</div>' +
      (meta && meta.some(item => item && item.trim() !== '')
      ? '<div class="prod-variation">' 
        + meta
            .filter(item => item && item.trim() !== '')
            .map(item =>
              "<span style='border:0.5px solid var(--muted);border-radius:5px;padding:5px;margin-right:10px;'>"
              + item +
              "</span>"
            ).join('')
        + '</div>'
      : "<span style='font-size: 12px; color: var(--muted); margin-top: 3px; margin-left: 8px;'>sans variable</span>") +
      '<div class="prod-stock ' + (out ? 'out' : low ? 'low' : '') + '">' +
        (out ? ' Esgotado' : 'Stock : ' + p.stockBoutique + ' un') +
      '</div>';
  if (!out) {
    div.onclick = function() {
      addToRevCart(p.id, p.stockBoutique);
    };
  }
    g.appendChild(div);
  });
}

function filterRevProducts() {
  var q = (document.getElementById('rev-search').value || '').toLowerCase();
  renderRevProducts(products.filter(function(p) {
    return [p.name, p.code, p.category, p.mainSupplier, p.variation].join(' ').toLowerCase().indexOf(q) >= 0;
  }));
}

function addToRevCart(productIdOrName, stock) {
  var product = (products || []).find(function(p) {
    return String(p.id) === String(productIdOrName);
  }) || (products || []).find(function(p) {
    return p.name === productIdOrName;
  }) || {};

  var qtyAlreadyReserved = revCart.reduce(function(sum, item) {
    return sum + (String(item.productId) === String(product.id) ? (parseFloat(item.qty) || 0) : 0);
  }, 0);

  if (qtyAlreadyReserved >= stock) {
    toast("Stock insuffisant pour consignation.", "error");
    return;
  }

  revCart.push({
    productId: product.id || "",
    name: product.name || String(productIdOrName || ""),
    baseName: product.name || String(productIdOrName || ""),
    supplier: product.supplier || product.mainSupplier || "",
    purchasePrice: parseFloat(product.purchasePrice) || 0,
    price: product.price || product.salePrice || 0,
    qty: 1,
    stock: stock,
    availableVariations: parseVariationList(product.variation || product.variations),
    selectedVariations: []
  });

  renderRevCart();

  setTimeout(function() {
    var input = document.getElementById("rev-price-" + (revCart.length - 1));
    if (input) input.focus();
  }, 50);
}

function renderRevCart() {
  var el = document.getElementById('revCartBody');
  if (!el) return;
  if (!revCart.length) {
    el.innerHTML = '<div class="empty">Adiciona produtos</div>';
    document.getElementById('revTotal').textContent = '0 Kz';
    return;
  }
  el.innerHTML = '';
  var total = 0;
  revCart.forEach(function(item, i) {
    total += (item.price || 0) * item.qty;
    var checks = (item.availableVariations || []).map(function(v) {
      var checked = (item.selectedVariations || []).indexOf(v) >= 0 ? 'checked' : '';
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface2);cursor:pointer;"><input type="checkbox" ' + checked + ' onchange="toggleRevVariation(' + i + ',\'' + encodeURIComponent(v) + '\')">' + v + '</label>';
    }).join('');
    var div = document.createElement('div');
    div.className = 'cart-item';
    div.style.marginBottom = '8px';
    div.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<div class="ci-name">' + item.name + '</div>' +
        '<button class="ci-del" onclick="removeRevItem(' + i + ')">x</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<div style="display:flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">' +
          '<button class="qbtn" style="background:none;width:18px;height:18px;" onclick="chgRevQty(' + i + ',-1)">-</button>' +
          '<span class="qnum">' + item.qty + '</span>' +
          '<button class="qbtn" style="background:none;width:18px;height:18px;" onclick="chgRevQty(' + i + ',1)">+</button>' +
        '</div>' +
        '<input type="number" class="ci-price-input" id="rev-price-' + i + '" placeholder="' + getText('rev_price_placeholder') + '" value="' + (item.price || '') + '" min="0" oninput="updateRevPrice(' + i + ', this.value)" onchange="updateRevPrice(' + i + ', this.value)">' +
        '<div class="ci-total" id="rev-line-total-' + i + '" style="white-space:nowrap;">' + ((item.price || 0) > 0 ? fmt(item.price * item.qty) : '-') + '</div>' +
      '</div>' +
      (checks ? '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">' + checks + '</div>' : '');
    el.appendChild(div);
  });
  document.getElementById('revTotal').textContent = fmt(total);
}

function chgRevQty(i, d) {
  if (!revCart[i]) return;

  var newQty = (parseFloat(revCart[i].qty) || 0) + d;

  if (newQty <= 0) {
    revCart.splice(i, 1);
    renderRevCart();
    return;
  }

  var productName = revCart[i].name;
  var qtyOtherLines = revCart.reduce(function(sum, item, index) {
    return sum + (index !== i && item.name === productName ? (parseFloat(item.qty) || 0) : 0);
  }, 0);

  if (qtyOtherLines + newQty > revCart[i].stock) {
    toast("Stock insuficiente para consignation. Disponivel: " + revCart[i].stock, "error");
    return;
  }

  revCart[i].qty = newQty;
  renderRevCart();
}

function updateRevPrice(i, value) {
  revCart[i].price = parseFloat(value) || 0;
  var lineTotal = document.getElementById('rev-line-total-' + i);
  if (lineTotal) {
    lineTotal.textContent = revCart[i].price > 0 ? fmt(revCart[i].price * revCart[i].qty) : '-';
  }
  document.getElementById('revTotal').textContent = fmt(revCart.reduce(function(sum, item) {
    return sum + ((item.price || 0) * item.qty);
  }, 0));
}

function removeRevItem(i) {
  revCart.splice(i, 1);
  renderRevCart();
}

function clearRevCart() {
  revCart = [];
  document.getElementById('rev-name').value = '';
  renderRevCart();
}

async function saveConsignation() {
  var revendeur = document.getElementById("rev-name").value.trim();

  if (!revendeur) {
    toast("Entra o nome do revendeur!", "error");
    return;
  }

  if (!revCart.length) {
    toast("Ajoute au moins un produit!", "error");
    return;
  }

  var invalid = revCart.find(function(item) {
    return !item.price || item.price <= 0;
  });

  if (invalid) {
    toast("Entra o prix pour " + invalid.name, "error");
    return;
  }

  var btn = document.getElementById("revSaveBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
  }

  try {
    var res = await createConsignmentInSupabase({
      date: document.getElementById("rev-date").value,
      revendeur: revendeur,
      items: revCart.map(function(item) {
        return {
          baseName: item.name,
          name: getItemDisplayName(item),
          qty: item.qty,
          price: item.price,
          selectedVariations: item.selectedVariations || []
        };
      })
    });

    toast("Consignation creee: " + (res.consignment_no || ""), "success");

    clearRevCart();

    await loadProducts(true);
    loadRevendeurNames();

    document.getElementById("rev-manage-name").value = revendeur;
    document.getElementById("rev-history-name").value = revendeur;

    loadRevendeurConsignations();
    loadRevHistory();

  } catch (e) {
    console.error("Erro consignation:", e);
    toast("Erro consignation: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = getText("create_consignment_button");
    }
  }
}

function renderRevPayLines() {
  var wrap = document.getElementById('rev-pay-lines');
  if (!wrap) return;
  var methods = ['Cash','Express','Cartao','Credito'];
  wrap.innerHTML = '';
  revPaymentLines.forEach(function(p, i) {
    var div = document.createElement('div');
    div.className = 'payment-line';
    var sel = '<select class="payment-select" onchange="revPaymentLines[' + i + '].method=this.value;">';
    methods.forEach(function(m) { sel += '<option value="' + m + '"' + (p.method === m ? ' selected' : '') + '>' + m + '</option>'; });
    sel += '</select>';
    div.innerHTML = sel +
      '<input type="number" class="payment-input" placeholder="Montant" value="' + (p.montant || '') + '" min="0" oninput="revPaymentLines[' + i + '].montant=parseFloat(this.value)||0;">' +
      (revPaymentLines.length > 1 ? '<button class="payment-remove" onclick="removeRevPayLine(' + i + ')">x</button>' : '<span></span>');
    wrap.appendChild(div);
  });
}

function addRevPayLine() {
  revPaymentLines.push({ method: 'Express', montant: 0 });
  renderRevPayLines();
}

function removeRevPayLine(i) {
  if (revPaymentLines.length <= 1) return;
  revPaymentLines.splice(i, 1);
  renderRevPayLines();
}

function loadOpenConsignations() {
  var select = document.getElementById('rev-open-select');
  if (!select) return;
  gsCall('getConsignationsOpen', {}, function(list) {
    list = Array.isArray(list) ? list : [];
    select.innerHTML = '';
    if (!list.length) {
      select.innerHTML = '<option value="">Aucune consignation ouverte</option>';
      return;
    }
    list.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.id + ' - ' + c.revendeur + ' - ' + fmt(c.total);
      select.appendChild(opt);
    });
  });
}

function getRevPaymentSummary(lines) {
  return lines.map(function(p) {
    return p.method + ': ' + (parseFloat(p.montant) || 0);
  }).join(' + ');
}

function confirmRevPayment() {
  var id = document.getElementById('rev-open-select').value;
  if (!id) { toast('Choisis une consignation.', 'error'); return; }
  var active = revPaymentLines.filter(function(p) { return (parseFloat(p.montant) || 0) > 0; });
  if (!active.length) { toast('Ajoute un paiement.', 'error'); return; }
  var now = new Date();
  var recibo = 'REV-' + now.getFullYear().toString().slice(-2) + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(Math.floor(Math.random()*9000)+1000);
  gsCall('confirmerPaiementConsignation', {
    id: id,
    date: document.getElementById('rev-action-date').value,
    pagamento: getRevPaymentSummary(active),
    paymentLines: active,
    recibo: recibo
  }, function() {
    toast('Consignation payee avec succes!', 'success');
    revPaymentLines = [{ method: 'Cash', montant: 0 }];
    renderRevPayLines();
    loadProducts();
    loadOpenConsignations();
    loadRevendeurDetail();
    loadDashboard();
  });
}

function returnRevConsignation() {
  var id = document.getElementById('rev-open-select').value;
  if (!id) { toast('Choisis une consignation.', 'error'); return; }
  gsCall('retornarConsignacao', {
    id: id,
    date: document.getElementById('rev-action-date').value
  }, function() {
    toast('Marchandise retournee.', 'success');
    loadProducts();
    loadOpenConsignations();
    loadRevendeurDetail();
  });
}

function loadRevendeurDetail() {
  var name = (document.getElementById('rev-detail-name').value || document.getElementById('rev-name').value || '').trim();
  var el = document.getElementById('rev-detail');
  if (!el) return;
  if (!name) { el.innerHTML = '<div class="empty">Entra o nome do revendeur</div>'; return; }
  el.innerHTML = '<div class="empty">A carregar...</div>';
  gsCall('getRevendeurDetail', name, function(data) {
    if (!data || !data.nom) { el.innerHTML = '<div class="empty">Revendeur introuvable</div>'; return; }
    var html = '<div class="card" style="margin-bottom:10px;padding:12px;background:var(--surface2);">' +
      '<div style="font-family:Playfair Display,serif;font-size:18px;margin-bottom:6px;">' + data.nom + '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:120px;"><div class="kpi-label">En possession</div><div style="font-weight:700;color:var(--blue);">' + fmt(data.totalPossession || 0) + '</div></div>' +
      '<div style="flex:1;min-width:120px;"><div class="kpi-label">Ouvertes</div><div style="font-weight:700;">' + (data.openCount || 0) + '</div></div>' +
      '</div></div>';
    html += '<div class="card-title">Consignations ouvertes</div>';
    if (!data.ouvertes || !data.ouvertes.length) html += '<div class="empty" style="margin-bottom:12px;">Aucune consignation ouverte</div>';
    else data.ouvertes.forEach(function(c) {
      html += '<div class="top-item"><div class="top-name">' + c.id + '  ' + c.date + '</div><div class="top-total">' + fmt(c.total) + '</div></div>';
    });
    html += '<div class="card-title" style="margin-top:12px;">Historique</div>';
    if (!data.historique || !data.historique.length) html += '<div class="empty">Sem historique</div>';
    else {
      html += '<table class="data-table"><thead><tr><th>ID</th><th>Data</th><th>Status</th><th>Total</th></tr></thead><tbody>';
      data.historique.forEach(function(c) {
        html += '<tr><td>' + c.id + '</td><td>' + c.date + '</td><td>' + c.status + '</td><td>' + fmt(c.total) + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    el.innerHTML = html;
  });
}
async function loadRevendeurNames() {
  var select = document.getElementById("rev-manage-name");
  var dataList = document.getElementById("revendeur-list");

  if (!select || !dataList) return;

  try {
    var list = await getResellerNamesFromSupabase();

    var current = select.value;

    select.innerHTML = '<option value="">Choisir un revendeur</option>';
    dataList.innerHTML = "";

    list.forEach(function(name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);

      var dl = document.createElement("option");
      dl.value = name;
      dataList.appendChild(dl);
    });

    if (current && list.indexOf(current) >= 0) {
      select.value = current;
    }

  } catch (e) {
    console.error("Erro revendeur names:", e);
  }
}
function saveConsignation() {
  var revendeur = document.getElementById('rev-name').value.trim();
  if (!revendeur) { toast('Entra o nome do revendeur!', 'error'); return; }
  if (!revCart.length) { toast('Ajoute au moins un produit!', 'error'); return; }
  var invalid = revCart.find(function(item) { return !item.price || item.price <= 0; });
  if (invalid) { toast('Entra o prix pour ' + invalid.name, 'error'); return; }

  var btn = document.getElementById('revSaveBtn');
  btn.disabled = true;
  btn.textContent = 'A registar...';

  gsCall('registarConsignacao', {
    date: document.getElementById('rev-date').value,
    revendeur: revendeur,
    items: revCart.map(function(item) {
      return { name: getItemDisplayName(item), qty: item.qty, price: item.price };
    })
  }, function(res) {
    toast('Consignation creee: ' + (res && res.id ? res.id : ''), 'success');
    clearRevCart();
    btn.disabled = false;
    btn.textContent = getText('create_consignment_button');
    loadProducts();
    loadRevendeurNames();
    document.getElementById('rev-manage-name').value = revendeur;
    document.getElementById('rev-history-name').value = revendeur;
    loadRevendeurConsignations();
    loadRevHistory();
  });
}

function loadOpenConsignations() {
  loadRevendeurNames();
}

async function loadRevendeurConsignations() {
  var name = (document.getElementById("rev-manage-name").value || "").trim();
  var box = document.getElementById("rev-open-list");

  if (!box) return;

  var payPanel = document.getElementById("rev-payment-panel");
  var returnPanel = document.getElementById("rev-return-panel");

  if (payPanel) payPanel.style.display = "none";
  if (returnPanel) returnPanel.style.display = "none";

  if (!name) {
    revOpenConsignations = [];
    box.innerHTML = '<div class="empty">' + getText("revendeurselcttext") + "</div>";
    updateRevActionPanel([]);
    applyLanguage();
    return;
  }

  box.innerHTML = '<div class="empty">' + getText("loading") + "</div>";

  try {
    var list = await getConsignmentsByResellerFromSupabase(name);

    revOpenConsignations = list;

    if (!list.length) {
      box.innerHTML = '<div class="empty">' + getText("no_open_consignment") + "</div>";
      updateRevActionPanel([]);
      return;
    }

    var html = "";

    list.forEach(function(c) {
      html += '<label style="display:block;padding:12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;background:var(--surface2);">' +
        '<div style="display:flex;gap:10px;align-items:flex-start;">' +
          '<input type="checkbox" class="rev-open-check" value="' + c.id + '" onchange="updateRevActionPanel()" style="margin-top:3px;accent-color:var(--blue);">' +
          '<div style="flex:1;">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">' +
              '<div style="font-weight:600;">' + escapeDepenseHtml(c.displayId || c.id) + "</div>" +
              '<div style="font-family:Playfair Display,serif;color:var(--blue);">' + fmt(c.total) + "</div>" +
            "</div>" +
            '<div style="font-size:12px;color:var(--muted);margin-top:3px;">' + escapeDepenseHtml(c.date || "") + "  " + c.qty + " un</div>" +
            '<div style="font-size:12px;margin-top:6px;line-height:1.5;">' +
              (c.items || []).map(function(it) { return escapeDepenseHtml((it.prod || it.name || "") + " x" + (it.qty || 0)); }).join(", ") +
            "</div>" +
          "</div>" +
        "</div>" +
      "</label>";
    });

    box.innerHTML = html;
    updateRevActionPanel();

  } catch (e) {
    console.error("Erro consignations revendeur:", e);
    box.innerHTML = '<div class="empty">Erro ao carregar consignations</div>';
    toast("Erro consignations: " + (e.message || e), "error");
  }
}
function getCheckedRevConsignationIds() {
  return Array.prototype.slice.call(document.querySelectorAll('.rev-open-check:checked')).map(function(el) {
    return el.value;
  });
}

function getRevSelectionData(cb) {
  var ids = getCheckedRevConsignationIds();
  if (!ids.length) { toast('Choisis au moins une consignation.', 'error'); return; }
  var name = (document.getElementById('rev-manage-name').value || '').trim();
  gsCall('getConsignationsByRevendeur', name, function(list) {
    list = (Array.isArray(list) ? list : []).filter(function(item) { return ids.indexOf(item.id) >= 0; });
    cb(list, ids);
  });
}

function getSelectedRevOpenList(source) {
  var ids = getCheckedRevConsignationIds();
  var list = Array.isArray(source) ? source : revOpenConsignations;
  return (list || []).filter(function(item) { return ids.indexOf(item.id) >= 0; });
}

function renderRevActionSummaries(list) {
  var paymentSummary = document.getElementById('rev-payment-summary');
  var returnSummary = document.getElementById('rev-return-summary');
  var totalEl = document.getElementById('rev-payment-total');
  var selected = getSelectedRevOpenList(list);
  var total = selected.reduce(function(sum, item) { return sum + (parseFloat(item.total) || 0); }, 0);

  var empty = '<div class="empty">'+getText('revconsselect')+'</div>';
  var paymentHtml = selected.length ? selected.map(function(item) {
    return '<div class="top-item"><div class="top-name">' + item.id + '  ' + item.date + '</div><div class="top-total">' + fmt(item.total) + '</div></div>';
  }).join('') : empty;
  var returnHtml = selected.length ? selected.map(function(item) {
    return '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--surface);">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">' +
        '<strong>' + item.id + '</strong><span style="color:var(--blue);font-family:Playfair Display,serif;">' + fmt(item.total) + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + item.date + '</div>' +
      '<div style="font-size:12px;margin-top:6px;line-height:1.5;">' + (item.items || []).map(function(it) { return (it && typeof it === 'object') ? ((it.prod || it.name || '') + ' x' + (it.qty || 0)) : it; }).join(', ') + '</div>' +
    '</div>';
  }).join('') : empty;

  if (paymentSummary) paymentSummary.innerHTML = paymentHtml;
  if (returnSummary) returnSummary.innerHTML = returnHtml;
  if (totalEl) totalEl.textContent = fmt(total);

  if (selected.length && revPaymentLines.length === 1) {
    revPaymentLines = [{ method: revPaymentLines[0].method || 'Cash', montant: total }];
    renderRevPayLines();
  }
}

function updateRevActionPanel(list) {
  var action = (document.getElementById('rev-action-type') || {}).value || 'payment';
  var payPanel = document.getElementById('rev-payment-panel');
  var returnPanel = document.getElementById('rev-return-panel');
  var confirmBtn = document.getElementById('revActionConfirmBtn');
  if (payPanel) payPanel.style.display = action === 'payment' ? 'block' : 'none';
  if (returnPanel) returnPanel.style.display = action === 'return' ? 'block' : 'none';
  if (confirmBtn) confirmBtn.textContent = action === 'return' ? getText('confirm_return_button') : getText('confirm_payment_button');
  renderRevActionSummaries(list);
}

async function confirmRevAction() {
  var action = (document.getElementById("rev-action-type") || {}).value || "payment";
  var ids = getRevSelectionIds();

  if (!ids.length) {
    toast("Selectionne une consignation.", "error");
    return;
  }

  try {
    if (action === "return") {
      await returnSelectedConsignmentsInSupabase(ids);
      toast("Marchandise retournee.", "success");
    } else {
      var active = revPaymentLines.filter(function(p) {
        return (parseFloat(p.montant) || 0) > 0;
      });

      if (!active.length) {
        toast("Ajoute un paiement.", "error");
        return;
      }

      await paySelectedConsignmentsInSupabase(
        ids,
        active,
        document.getElementById("rev-action-date").value
      );

      toast("Consignation payee avec succes!", "success");
      revPaymentLines = [{ method: "Cash", montant: 0 }];
      renderRevPayLines();
    }

    await loadProducts(true);
    loadRevendeurConsignations();
    loadRevHistory();
    loadDashboard();

  } catch (e) {
    console.error("Erro action revendeur:", e);
    toast("Erro revendeur: " + (e.message || e), "error");
  }
}

function prepareRevPayment() {
  getRevSelectionData(function(list) {
    var panel = document.getElementById('rev-payment-panel');
    var returnPanel = document.getElementById('rev-return-panel');
    var summary = document.getElementById('rev-payment-summary');
    var total = list.reduce(function(sum, item) { return sum + (parseFloat(item.total) || 0); }, 0);
    if (returnPanel) returnPanel.style.display = 'none';
    if (panel) panel.style.display = 'block';
    if (summary) {
      summary.innerHTML = list.map(function(item) {
        return '<div class="top-item"><div class="top-name">' + item.id + '  ' + item.date + '</div><div class="top-total">' + fmt(item.total) + '</div></div>';
      }).join('');
    }
    document.getElementById('rev-payment-total').textContent = fmt(total);
    revPaymentLines = [{ method: 'Cash', montant: total }];
    renderRevPayLines();
  });
}

function prepareRevReturn() {
  getRevSelectionData(function(list) {
    var panel = document.getElementById('rev-return-panel');
    var payPanel = document.getElementById('rev-payment-panel');
    var summary = document.getElementById('rev-return-summary');
    if (payPanel) payPanel.style.display = 'none';
    if (panel) panel.style.display = 'block';
    if (summary) {
      summary.innerHTML = list.map(function(item) {
        return '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--surface);">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">' +
            '<strong>' + item.id + '</strong><span style="color:var(--blue);font-family:Playfair Display,serif;">' + fmt(item.total) + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + item.date + '</div>' +
          '<div style="font-size:12px;margin-top:6px;line-height:1.5;">' + (item.items || []).map(function(it) { return (it && typeof it === 'object') ? ((it.prod || it.name || '') + ' x' + (it.qty || 0)) : it; }).join(', ') + '</div>' +
        '</div>';
      }).join('');
    }
  });
}

function confirmSelectedRevPayments() {
  getRevSelectionData(function(list, ids) {
    var active = revPaymentLines.filter(function(p) { return (parseFloat(p.montant) || 0) > 0; });
    if (!active.length) { toast('Ajoute un paiement.', 'error'); return; }
    var total = list.reduce(function(sum, item) { return sum + (parseFloat(item.total) || 0); }, 0);
    var paid = active.reduce(function(sum, p) { return sum + (parseFloat(p.montant) || 0); }, 0);
    if (Math.abs(paid - total) > 0.01) {
      toast('Le total des paiements doit etre egal au total selectionne.', 'error');
      return;
    }

    var btn = document.getElementById('revPayConfirmBtn') || document.getElementById('revActionConfirmBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'A registar...';
    }

    var now = new Date();
    var recibo = 'REV-' + now.getFullYear().toString().slice(-2) + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(Math.floor(Math.random()*9000)+1000);
    gsCall('confirmerPaiementConsignations', {
      ids: ids,
      date: document.getElementById('rev-action-date').value,
      pagamento: getRevPaymentSummary(active),
      paymentLines: active,
      recibo: recibo
    }, function() {
      toast('Paiement revendeur enregistre avec succes!', 'success');
      revPaymentLines = [{ method: 'Cash', montant: 0 }];
      renderRevPayLines();
      if (btn) {
        btn.disabled = false;
        btn.textContent = getText('confirm_payment_button');
      }
      updateRevActionPanel([]);
      loadProducts();
      loadRevendeurNames();
      loadRevendeurConsignations();
      loadRevHistory();
      loadDashboard();
    });
  });
}

function confirmRevPayment() {
  confirmSelectedRevPayments();
}

function confirmSelectedRevReturn() {
  getRevSelectionData(function(list, ids) {
    var btn = document.getElementById('revReturnConfirmBtn') || document.getElementById('revActionConfirmBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'A registar...';
    }
    gsCall('retornarConsignacoes', {
      ids: ids,
      date: document.getElementById('rev-action-date').value
    }, function() {
      toast('Retour enregistre avec succes!', 'success');
      if (btn) {
        btn.disabled = false;
        btn.textContent = getText('confirm_return_button');
      }
      updateRevActionPanel([]);
      loadProducts();
      loadRevendeurNames();
      loadRevendeurConsignations();
      loadRevHistory();
      loadDashboard();
    });
  });
}

function returnRevConsignation() {
  confirmSelectedRevReturn();
}

function renderMobileRevHistory(rows) {
  var list = ensureMobileList("revHistoryBody", "mobileRevHistoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Aucun historique revendeur</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    var status = row.status || "-";
    var statusText = String(status).toLowerCase();

    var pillClass = "open";
    if (statusText.indexOf("pay") >= 0 || statusText.indexOf("pago") >= 0) pillClass = "paid";
    if (statusText.indexOf("retour") >= 0 || statusText.indexOf("return") >= 0) pillClass = "returned";

    return '' +
      '<div class="mobile-rev-history-card">' +
        '<div class="mobile-card-top">' +
          '<div>' +
            '<div class="mobile-card-kicker">' + escapeDepenseHtml(row.id || "-") + '</div>' +
            '<div class="mobile-card-title">' + escapeDepenseHtml(row.revendeur || "Revendeur") + '</div>' +
            '<div class="mobile-card-sub">' + escapeDepenseHtml(row.actionDate || row.date || "") + '</div>' +
            '<div class="mobile-card-sub">' + escapeDepenseHtml(row.itemsSummary || "") + '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div class="mobile-card-amount">' + fmt(row.total || 0) + '</div>' +
            '<div class="mobile-rev-pill ' + pillClass + '">' + escapeDepenseHtml(status) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="mobile-rev-extra">' +
          '<span>Paiement: ' + escapeDepenseHtml(row.payment || "-") + '</span>' +
          '<span>Recu: ' + escapeDepenseHtml(row.recibo || "-") + '</span>' +
        '</div>' +
      '</div>';
  }).join("");
}

async function loadRevHistory() {
  var body = document.getElementById("revHistoryBody");
  if (!body) return;

  body.innerHTML = '<tr><td colspan="8" class="empty">A carregar...</td></tr>';
  renderMobileRevHistory([]);

  try {
    var list = await getResellerHistoryFromSupabase({
      revendeur: document.getElementById("rev-history-name").value.trim(),
      from: document.getElementById("rev-history-from").value,
      to: document.getElementById("rev-history-to").value
    });

    list = list || [];

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">Nenhum historique encontrado</td></tr>';
      renderMobileRevHistory([]);
      return;
    }

    renderMobileRevHistory(list);

    body.innerHTML = "";

    list.forEach(function(row) {
      body.innerHTML += "<tr>" +
        "<td>" + escapeDepenseHtml(row.id || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.actionDate || row.date || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.revendeur || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.status || "") + "</td>" +
        '<td style="font-size:11px;line-height:1.4;">' + escapeDepenseHtml(row.itemsSummary || "") + "</td>" +
        '<td style="color:var(--blue);font-weight:600;">' + fmt(row.total || 0) + "</td>" +
        "<td>" + escapeDepenseHtml(row.payment || "-") + "</td>" +
        "<td>" + escapeDepenseHtml(row.recibo || "-") + "</td>" +
      "</tr>";
    });

  } catch (e) {
    console.error("Erro historique revendeur:", e);
    body.innerHTML = '<tr><td colspan="8" class="empty">Erro ao carregar historique</td></tr>';
    renderMobileRevHistory([]);
    toast("Erro historique revendeur: " + (e.message || e), "error");
  }
}

async function loadRevHistory() {
  var body = document.getElementById("revHistoryBody");
  if (!body) return;

  body.innerHTML = '<tr><td colspan="8" class="empty">A carregar...</td></tr>';

  try {
    var list = await getResellerHistoryFromSupabase({
      revendeur: document.getElementById("rev-history-name").value.trim(),
      from: document.getElementById("rev-history-from").value,
      to: document.getElementById("rev-history-to").value
    });

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">Nenhum historique encontrado</td></tr>';
      return;
    }

    body.innerHTML = "";

    list.forEach(function(row) {
      body.innerHTML += "<tr>" +
        "<td>" + escapeDepenseHtml(row.id || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.actionDate || row.date || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.revendeur || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.status || "") + "</td>" +
        '<td style="font-size:11px;line-height:1.4;">' + escapeDepenseHtml(row.itemsSummary || "") + "</td>" +
        '<td style="color:var(--blue);font-weight:600;">' + fmt(row.total || 0) + "</td>" +
        "<td>" + escapeDepenseHtml(row.payment || "-") + "</td>" +
        "<td>" + escapeDepenseHtml(row.recibo || "-") + "</td>" +
      "</tr>";
    });

  } catch (e) {
    console.error("Erro historique revendeur:", e);
    body.innerHTML = '<tr><td colspan="8" class="empty">Erro ao carregar historique</td></tr>';
    toast("Erro historique revendeur: " + (e.message || e), "error");
  }
}
function loadRevendeurDetail() {
  loadRevHistory();
}

// ===== MIXED PAYMENT SYSTEM =====
var paymentLines = [{ method: 'Cash', montant: 0 }];

function getCartTotal() {
  return cart.reduce(function(sum, item) {
    return sum + (parseFloat(item.price) || 0) * (parseFloat(item.qty) || 0);
  }, 0);
}

function formatPaymentAmount(value) {
  var rounded = Math.round((parseFloat(value) || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function updatePaymentStatus() {
 var d = document.getElementById('vendaDate').value;
 var format = d
  ? new Date(d).toLocaleDateString('pt-PT')
  : '-';

  var total = getCartTotal();
  var paid = paymentLines.reduce(function(sum, p) { return sum + (parseFloat(p.montant) || 0); }, 0);
  var status = document.getElementById('paymentModalStatus');
  if (status) {
    status.textContent = 'Pago: ' + fmt(paid) + ' / Total: ' + fmt(total);
    status.style.color = Math.abs(paid - total) < 0.01 || total === 0 ? 'var(--green)' : (paid > total ? 'var(--red)' : 'var(--orange)');
  }
  var totalEl = document.getElementById('paymentModalTotal');
  if (totalEl) totalEl.textContent = fmt(total);
  var clientEl = document.getElementById('paymentModalClient');
  if (clientEl) clientEl.textContent = document.getElementById('clientInput').value.trim() || 'Anonimo';
  var dateEl = document.getElementById('paymentModalDate');
  if (dateEl) dateEl.textContent = format;
}

function normalizePaymentLines(total) {
  var lines = paymentLines.map(function(p) {
    return {
      method: p.method || 'Cash',
      montant: Math.round((parseFloat(p.montant) || 0) * 100) / 100
    };
  }).filter(function(p) {
    return p.montant > 0;
  });

  if (lines.length === 0) {
    lines = [{
      method: (paymentLines[0] && paymentLines[0].method) || 'Cash',
      montant: Math.round((parseFloat(total) || 0) * 100) / 100
    }];
  }

  var totalPaid = lines.reduce(function(sum, p) { return sum + p.montant; }, 0);
  if (Math.abs(totalPaid - total) > 0.01) {
    return null;
  }

  return lines;
}

function initPaymentLines() {
  paymentLines = [{ method: 'Cash', montant: 0 }];
  renderPaymentLines();
}

function addPaymentLine() {
  paymentLines.push({ method: 'Express', montant: 0 });
  renderPaymentLines();
}

function removePaymentLine(i) {
  if (paymentLines.length <= 1) { toast('Pelo menos um meio de pagamento!', 'error'); return; }
  paymentLines.splice(i, 1);
  renderPaymentLines();
}

function renderPaymentLines() {
  var wrap = document.getElementById('paymentModalLines');
  if (!wrap) return;
  var methods = ['Cash','Express','Cartao','Credito'];
  var labels  = {'Cash':' Cash','Express':' Express','Cartao':' Cartao','Credito':' Credito'};
  wrap.innerHTML = '';
  paymentLines.forEach(function(p, i) {
    var div = document.createElement('div');
    div.className = 'payment-line';
    var sel = '<select class="payment-select" onchange="paymentLines['+i+'].method=this.value;updatePaymentStatus();">';
    methods.forEach(function(m) { sel += '<option value="'+m+'"'+(p.method===m?' selected':'')+'>'+labels[m]+'</option>'; });
    sel += '</select>';
    var inp = '<input type="number" placeholder="Montant" value="'+(p.montant||'')+'" min="0" '+
      'class="payment-input" '+
      'oninput="paymentLines['+i+'].montant=parseFloat(this.value)||0;updatePaymentStatus();">';
    var del = paymentLines.length > 1 ? '<button onclick="removePaymentLine('+i+')" class="payment-remove">x</button>' : '<span></span>';
    div.innerHTML = sel + inp + del;
    wrap.appendChild(div);
  });
  updatePaymentStatus();
}

function getPaymentSummary(lines) {
  var active = lines && lines.length ? lines : paymentLines.filter(function(p) { return (p.montant||0) > 0; });
  if (active.length === 0) return paymentLines[0].method;
  return active.map(function(p) {
    return p.method + ': ' + formatPaymentAmount(p.montant);
  }).join(' + ');
}

function selPay(btn, method) {
  selectedPay = method; // kept for compatibility
}

var selectedType = 'interno';
function syncPaymentTypeButtons() {
  var stockBtn = document.getElementById('payment-type-stock');
  var commandeBtn = document.getElementById('payment-type-commande');
  if (stockBtn) stockBtn.classList.toggle('active', selectedType === 'interno');
  if (commandeBtn) commandeBtn.classList.toggle('active', selectedType === 'Externo');
}

function selPaymentType(type) {
  selectedType = type;
  syncPaymentTypeButtons();
}

function selType(btn, type) {
  selectedType = type;

  document.querySelectorAll(".pay-btn").forEach(function(button) {
    button.classList.remove("active");
    button.style.borderColor = "";
    button.style.color = "";
    button.style.background = "";
  });

  if (btn) {
    btn.classList.add("active");
    btn.style.borderColor = "var(--blue)";
    btn.style.color = "var(--blue)";
    btn.style.background = "rgba(201,168,76,0.1)";
  }

  renderProds(products);
  renderCart();
}

function selPaymentType(type) {
  selectedType = type;

  var stockBtn = document.getElementById("payment-type-stock");
  var commandeBtn = document.getElementById("payment-type-commande");

  if (stockBtn) stockBtn.classList.toggle("active", type === "interno");
  if (commandeBtn) commandeBtn.classList.toggle("active", type === "Externo");

  renderCart();
}


function openPaymentModal() {
  if (cart.length === 0) { toast('Carrinho vazio!', 'error'); return; }
  renderPaymentLines();
  updatePaymentStatus();
  syncPaymentTypeButtons();
  document.getElementById('paymentOverlay').classList.add('show');
}

function closePaymentModal() {
  document.getElementById('paymentOverlay').classList.remove('show');
}

// ===== CONFIRMAR VENDA =====
async function confirmarVenda() {
  if (!requireAzulAction("sale:create", "registar venda")) return;

  if (!cart.length) {
    toast("Carrinho vazio!", "error");
    return;
  }

 var totalVenda = getCartTotal();
var finalPaymentLines = normalizePaymentLines(totalVenda);

if (!finalPaymentLines) {
  toast("O total dos pagamentos deve ser igual ao total da venda.", "error");
  return;
}

var hasCredit = getCreditAmountFromPaymentLines(finalPaymentLines, totalVenda) > 0;
var clientName = document.getElementById("clientInput").value.trim();

if (hasCredit && !clientName) {
  toast("Venda a credito precisa de nome do cliente.", "error");
  return;
}

  var btn = document.getElementById("paymentConfirmBtn") || document.getElementById("confirmBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  var salePayload = {
    saleDate: document.getElementById("vendaDate").value,
    clientName: clientName || "Anonimo",
    saleType: selectedType,
    paymentLines: finalPaymentLines,
    items: cart
  };

  try {
    var result = await saveSaleToSupabase(salePayload);

    toast("Venda registada!", "success");

    lastReceiptData = {
      recibo: result.receiptNo,
      date: document.getElementById("vendaDate").value,
      client: document.getElementById("clientInput").value.trim() || "Anonimo",
      pay: getPaymentSummary(paymentLines),
      items: cart.map(function(item) {
        return {
          name: getItemDisplayName(item),
          qty: item.qty,
          price: item.price,
          total: item.price * item.qty
        };
      }),
      total: result.total
    };

    if (typeof showReceipt === "function") {
      showReceipt(lastReceiptData);
    }

    cart = [];
    renderCart();

    if (typeof closePaymentModal === "function") {
      closePaymentModal();
    }

    await loadProducts(true);

  } catch (e) {
    console.error("Erro venda:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("sale", salePayload);
      toast("Sem internet: venda guardada para sincronizar depois.", "success");
      cart = [];
      renderCart();
      if (typeof closePaymentModal === "function") closePaymentModal();
      return;
    }
    toast("Erro ao registar venda: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Confirmar Venda";
      btn.style.opacity = "1";
    }
  }
}
function getCartTotalMobile() {
  return (cart || []).reduce(function(sum, item) {
    return sum + (Number(item.price) || 0) * (Number(item.qty) || 0);
  }, 0);
}

function getCartCountMobile() {
  return (cart || []).reduce(function(sum, item) {
    return sum + (Number(item.qty) || 0);
  }, 0);
}

function ensureMobileCartUI() {
  if (!document.getElementById("mobileCartBar")) {
    var bar = document.createElement("div");
    bar.id = "mobileCartBar";
    bar.className = "mobile-cart-bar";
    bar.onclick = openMobileCart;
    document.body.appendChild(bar);
  }

  if (!document.getElementById("mobileCartPage")) {
    var page = document.createElement("div");
    page.id = "mobileCartPage";
    page.className = "mobile-cart-page";
    document.body.appendChild(page);
  }
}

function renderMobileCartBar() {
  ensureMobileCartUI();

  var bar = document.getElementById("mobileCartBar");
  var vendaPage = document.getElementById("page-venda");
  var isVenda = vendaPage && vendaPage.classList.contains("active");

  if (!bar) return;

  if (!isVenda || !cart || !cart.length) {
    bar.classList.remove("show");
    return;
  }

  bar.classList.add("show");
  bar.innerHTML =
    '<div class="mobile-cart-bar-title">Ver Carrinho</div>' +
    '<div class="mobile-cart-bar-meta">' +
      '<span>' + getCartCountMobile() + ' produtos</span>' +
      '<span>' + fmt(getCartTotalMobile()) + '</span>' +
    '</div>';
}

function openMobileCart() {
  ensureMobileCartUI();

  if (!paymentLines || !paymentLines.length) {
    paymentLines = [{ method: "Cash", montant: getCartTotalMobile() }];
  }

  document.body.classList.add("mobile-cart-open");
  renderMobileCartPage();
}

function closeMobileCart() {
  document.body.classList.remove("mobile-cart-open");
}

function setMobileSaleType(type) {
  selectedType = type;

  document.querySelectorAll(".mobile-payment-type button").forEach(function(btn) {
    btn.classList.remove("active");
  });

  var buttons = document.querySelectorAll(".mobile-payment-type button");

  if (type === "Externo") {
    if (buttons[1]) buttons[1].classList.add("active");
  } else {
    if (buttons[0]) buttons[0].classList.add("active");
  }
}

function updateMobilePaymentLine(index, field, value) {
  paymentLines[index] = paymentLines[index] || { method: "Cash", montant: 0 };

  if (field === "montant") {
    paymentLines[index][field] = Number(value) || 0;
  } else {
    paymentLines[index][field] = value;
  }

  renderMobileCartPage();
}

function addMobilePaymentLine() {
  paymentLines.push({ method: "Cash", montant: 0 });
  renderMobileCartPage();
}

function removeMobilePaymentLine(index) {
  paymentLines.splice(index, 1);

  if (!paymentLines.length) {
    paymentLines.push({ method: "Cash", montant: 0 });
  }

  renderMobileCartPage();
}

function renderMobileCartPage() {
  ensureMobileCartUI();

  var page = document.getElementById("mobileCartPage");
  if (!page) return;

  var total = getCartTotalMobile();

  var itemsHtml = !cart.length
    ? '<div class="empty">Carrinho vazio</div>'
    : cart.map(function(item, index) {
        var product = (products || []).find(function(p) { return p.name === item.name; }) || {};
        var img = product.photo || "";
        var imgHtml = img
          ? '<img class="mobile-cart-img" src="' + escapeDepenseHtml(img) + '" alt="">'
          : '<div class="mobile-cart-img mobile-cart-img-empty"></div>';
        
        return '<div class="mobile-cart-item">' +
          '<div class="mobile-cart-item-main">' +
            imgHtml +
            '<div>' +
              '<div class="mobile-cart-name">' + escapeDepenseHtml(getItemDisplayName(item)) + '</div>' +
              '<div class="mobile-cart-sub">Stock boutique: ' + (item.stock || 0) + ' un</div>' +
              '<div class="mobile-cart-price">' + fmt(item.price || 0) + '</div>' +
              '<div class="mobile-cart-sub">Total ' + fmt((item.price || 0) * (item.qty || 0)) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="mobile-cart-actions">' +
            '<button class="mobile-cart-delete" onclick="removeItem(' + index + '); renderMobileCartPage(); event.stopPropagation();">×</button>' +
            '<div class="mobile-cart-qty">' +
              '<button onclick="chgQty(' + index + ', -1); renderMobileCartPage(); event.stopPropagation();">−</button>' +
              '<span>' + item.qty + '</span>' +
              '<button onclick="chgQty(' + index + ', 1); renderMobileCartPage(); event.stopPropagation();">+</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join("");

  var paymentHtml = (paymentLines || []).map(function(line, index) {
    return '<div class="mobile-pay-line">' +
      '<select onchange="updateMobilePaymentLine(' + index + ', \'method\', this.value)">' +
        '<option value="Cash" ' + (line.method === "Cash" ? "selected" : "") + '>Cash</option>' +
        '<option value="Express" ' + (line.method === "Express" ? "selected" : "") + '>Express</option>' +
        '<option value="Cartao" ' + (line.method === "Cartao" ? "selected" : "") + '>Cartao</option>' +
        '<option value="Credito" ' + (line.method === "Credito" ? "selected" : "") + '>Credito</option>' +
      '</select>' +
      '<input type="number" value="' + (line.montant || 0) + '" oninput="updateMobilePaymentLine(' + index + ', \'montant\', this.value)">' +
      '<button onclick="removeMobilePaymentLine(' + index + ')">×</button>' +
    '</div>';
  }).join("");

  page.innerHTML =
    '<div class="mobile-cart-head">' +
      '<button class="mobile-cart-back" onclick="closeMobileCart()">‹</button>' +
      '<div class="mobile-cart-title">Carrinho</div>' +
      '<button class="mobile-cart-clear" onclick="clearCart(); renderMobileCartPage(); renderMobileCartBar();">Limpar</button>' +
    '</div>' +
    '<div class="mobile-cart-body">' +
      itemsHtml +
      '<div class="mobile-payment-card">' +
        '<div class="mobile-payment-type">' +
         '<button type="button" class="' + (selectedType !== "Externo" ? "active" : "") + '" onclick="event.preventDefault(); setMobileSaleType(\'interno\')">Interne</button>' +
'<button type="button" class="' + (selectedType === "Externo" ? "active" : "") + '" onclick="event.preventDefault(); setMobileSaleType(\'Externo\')">Externe</button>' +
        '</div>' +
        paymentHtml +
        '<button class="mobile-add-pay" onclick="addMobilePaymentLine()">+ Ajouter moyen de paiement</button>' +
      '</div>' +
      '<div class="mobile-total-card">' +
        '<div class="mobile-total-row"><span>Produtos (' + getCartCountMobile() + ')</span><b>' + fmt(total) + '</b></div>' +
        '<div class="mobile-total-row"><strong>Total</strong><strong style="color:#32bfb3">' + fmt(total) + '</strong></div>' +
      '</div>' +
      '<button class="mobile-checkout-btn" onclick="confirmarVenda(); setTimeout(function(){ renderMobileCartPage(); renderMobileCartBar(); if(!cart.length) closeMobileCart(); }, 700);">Finalizar Compra</button>' +
    '</div>';
}


// ===== RECEIPT =====
function showReceipt(d) {
  var cur = window._currency || 'Kz';

  var rlogo = document.getElementById('r-logo');
  if (rlogo) rlogo.textContent = (config && config.name) || 'Azul Gestão';

  var rslogan = document.getElementById('r-slogan');
  if (rslogan) rslogan.textContent = (config && config.slogan) || '';


  // Infos de base
  document.getElementById('r-num').textContent = d.recibo;
  document.getElementById('r-date').textContent = d.date;
  document.getElementById('r-client').textContent = d.client;
  document.getElementById('r-pay').textContent = d.pagamento;
  document.getElementById('r-total').textContent = fmt(d.total);

  // Produits
  var tb = document.getElementById('r-items');
  tb.innerHTML = '';
  var desconto = 0;
  d.items.forEach(function(item) {
    var regularPrice = parseFloat(item.regularPrice) || parseFloat(item.price) || 0;
    var price = parseFloat(item.price) || 0;
    var qty = parseFloat(item.qty) || 0;
    if (regularPrice > price) desconto += (regularPrice - price) * qty;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + item.name + '</td><td>' + item.qty + '</td><td>' +
      fmt(item.price) + '</td><td>' + fmt(item.price*item.qty) + '</td>';
    tb.appendChild(tr);
  });
  var discountLine = document.getElementById('r-discount-line');
  var discountValue = document.getElementById('r-discount');
  if (discountLine && discountValue) {
    discountLine.style.display = desconto > 0 ? 'flex' : 'none';
    discountValue.textContent = desconto > 0 ? ('-' + fmt(desconto)) : '';
  }

  // Appliquer config personnalisation
  var cfg = config || {};

  // Adresse et telephone
  var addrEl = document.getElementById('r-address-line');
  var phoneEl = document.getElementById('r-phone-line');
  if (addrEl) {
    addrEl.textContent = cfg.address || '';
    addrEl.style.display = cfg.address ? 'block' : 'none';
  }
  if (phoneEl) {
    phoneEl.textContent = cfg.phone || '';
    phoneEl.style.display = cfg.phone ? 'block' : 'none';
  }

  // Cases a cocher - afficher/cacher les lignes
  var showDate    = cfg.showDate    !== false;
  var showClient  = cfg.showClient  !== false;
  var showPayment = cfg.showPayment !== false;
  var showRecibo  = cfg.showRecibo  !== false;

  document.getElementById('r-date-line').style.display   = showDate    ? 'block' : 'none';
  document.getElementById('r-client-line').style.display = showClient  ? 'block' : 'none';
  document.getElementById('r-pay-line').style.display    = showPayment ? 'block' : 'none';
  document.getElementById('r-num-line').style.display    = showRecibo  ? 'block' : 'none';

  // Message de pied de page
  var thanksEl = document.getElementById('r-thanks');
  if (thanksEl) thanksEl.textContent = cfg.footer || ('Obrigado por escolher ' + (cfg.name || 'a nossa boutique') + '!');

  document.getElementById('receiptOverlay').classList.add('show');
}

function closeReceipt() {
  document.getElementById('receiptOverlay').classList.remove('show');
}

function printReceipt() {
  var content = document.getElementById('receiptBox').innerHTML;
  var textFont = (config && config.receiptFont) || 'DM Sans';
  var textSize = parseInt((config && config.receiptFontSize) || '10', 10);
  var logoSize = parseInt((config && config.receiptLogoSize) || '16', 10);
  var w = window.open('', '_blank', 'width=320,height=700');
  w.document.write('<!DOCTYPE html><html><head>' +
    '<meta charset="UTF-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans&display=swap" rel="stylesheet">' +
    '<style>' +
    // CSS optimise pour imprimante ticket thermique 58mm / 80mm
    // margin:0, padding minimal, police petite
    '@page { margin: 0; size: 80mm auto; }' +
    'body { font-family: "' + textFont + '", sans-serif; width: 76mm; margin: 0 auto; padding: 4mm 2mm; font-size: ' + textSize + 'pt; color: #000; }' +
    '.r-logo { text-align:center; font-family:"' + textFont + '", sans-serif; font-size:' + logoSize + 'pt; font-weight:700; letter-spacing:2px; margin-bottom:1mm; }' +
    '.r-slogan { text-align:center; font-size:' + Math.max(textSize - 1, 8) + 'pt; color:#000; font-style:normal; font-weight:600; margin-bottom:2mm; }' +
    '.r-meta { font-size:' + Math.max(textSize - 1, 8) + 'pt; color:#000; font-weight:600; margin-bottom:1mm; }' +
    'hr { border:none; border-top:1px dashed #999; margin:2mm 0; }' +
    '.r-table { width:100%; border-collapse:collapse; font-size:' + Math.max(textSize - 1, 8) + 'pt; color:#000; }' +
    '.r-table th { text-align:left; font-weight:700; color:#000; padding-bottom:1mm; border-bottom:1px solid #bdbdbd; font-size:' + Math.max(textSize - 1, 8) + 'pt; }' +
    '.r-table td { padding:1mm 0; border-bottom:1px dotted #d6d6d6; vertical-align:top; color:#000; font-weight:600; }' +
    '.r-table td:last-child { text-align:right; font-weight:700; }' +
    '.r-total { display:flex; justify-content:space-between; font-size:' + Math.max(textSize + 2, 11) + 'pt; font-weight:800; color:#000; margin-top:2mm; border-top:2px solid #000; padding-top:1mm; }' +
    '.r-thanks { text-align:center; font-size:' + Math.max(textSize - 1, 8) + 'pt; color:#000; font-style:normal; font-weight:600; margin-top:3mm; }' +
    '.r-actions { display:none; }' +
    '#r-address-line, #r-phone-line { font-size:' + Math.max(textSize - 1, 8) + 'pt; text-align:center; color:#000; font-weight:600; margin-bottom:1mm; }' +
    '</style></head><body>' + content + '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 600);
}

// ===== ACHAT =====
var achatLines    = [];
var paiementLines = [];
var achatHistorySearchTimer = null;

function switchAchatTab(tab, btn) {
  ["novo", "historico"].forEach(function(name) {
    var panel = document.getElementById("achat-panel-" + name);
    var tabBtn = document.getElementById("achat-tab-" + name);

    if (panel) panel.style.display = name === tab ? "block" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === tab);
  });

  if (tab === "novo" && typeof renderMobileAchatSummary === "function") {
    renderMobileAchatSummary();
  }

  if (tab === "historico") {
    loadAchatHistorique();
  }
}

function loadAchatHistoriqueDebounced() {
  clearTimeout(achatHistorySearchTimer);
  achatHistorySearchTimer = setTimeout(function() {
    loadAchatHistorique();
  }, 250);
}

async function getAchatHistoriqueFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var from = document.getElementById("achatHistFrom") ? document.getElementById("achatHistFrom").value : "";
  var to = document.getElementById("achatHistTo") ? document.getElementById("achatHistTo").value : "";
  var search = document.getElementById("achatHistSearch") ? document.getElementById("achatHistSearch").value.trim().toLowerCase() : "";

  var query = supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (from) query = query.gte("created_at", from + "T00:00:00");
  if (to) query = query.lte("created_at", to + "T23:59:59");

  var purchasesResult = await query;
  if (purchasesResult.error) throw purchasesResult.error;

  var purchases = purchasesResult.data || [];
  if (!purchases.length) return { rows: [], summary: { total: 0, paid: 0, debt: 0, qty: 0, count: 0 } };

  var purchaseById = {};
  purchases.forEach(function(purchase) {
    purchaseById[purchase.id] = purchase;
  });

  var items = await fetchPurchaseItemsByPurchaseIds(purchases.map(function(purchase) {
    return purchase.id;
  }));

  var rows = [];

  items.forEach(function(item) {
    var purchase = purchaseById[item.purchase_id] || {};
    var qty = Number(item.quantity) || 0;
    var unit = Number(item.purchase_price) || 0;
    var lineTotal = qty * unit;

    var row = {
      date: String(purchase.created_at || "").slice(0, 10),
      supplier: purchase.supplier || item.supplier || "",
      product: item.product_name || "",
      code: item.code || "",
      variation: item.variation || "",
      qty: qty,
      unit: unit,
      total: lineTotal,
      paid: Number(purchase.paid_amount) || 0,
      debt: Number(purchase.remaining_amount) || 0,
      purchaseTotal: Number(purchase.total) || 0,
      purchaseId: purchase.id || "",
      user_name: purchase.user_name || ""
    };

    rows.push(row);
  });

  if (search) {
    rows = rows.filter(function(row) {
      return (
        String(row.supplier || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.product || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.code || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.variation || "").toLowerCase().indexOf(search) >= 0 ||
        String(row.user_name || "").toLowerCase().indexOf(search) >= 0
      );
    });
  }

  var purchaseSeen = {};
  var summary = { total: 0, paid: 0, debt: 0, qty: 0, count: 0 };

  rows.forEach(function(row) {
    summary.qty += Number(row.qty) || 0;

    if (!purchaseSeen[row.purchaseId]) {
      purchaseSeen[row.purchaseId] = true;
      summary.total += Number(row.purchaseTotal) || 0;
      summary.paid += Number(row.paid) || 0;
      summary.debt += Number(row.debt) || 0;
      summary.count += 1;
    }
  });

  return { rows: rows, summary: summary };
}

async function loadAchatHistorique() {
  var body = document.getElementById("achatHistoryBody");
  var cards = document.getElementById("achatHistoryCards");

  if (body) body.innerHTML = '<tr><td colspan="10" class="empty">A carregar...</td></tr>';
  if (cards) cards.innerHTML = '<div class="empty">A carregar...</div>';

  try {
    var data = await getAchatHistoriqueFromSupabase();
    var rows = data.rows || [];
    var summary = data.summary || {};

    document.getElementById("achatHistTotal").textContent = fmt(summary.total || 0);
    document.getElementById("achatHistPaid").textContent = fmt(summary.paid || 0);
    document.getElementById("achatHistDebt").textContent = fmt(summary.debt || 0);
    document.getElementById("achatHistQty").textContent = new Intl.NumberFormat(getLocale()).format(summary.qty || 0);
    document.getElementById("achatHistCount").textContent = (summary.count || 0) + " achats";

    if (!rows.length) {
      if (body) body.innerHTML = '<tr><td colspan="10" class="empty">Aucun achat trouvé</td></tr>';
      if (cards) cards.innerHTML = '<div class="empty">Aucun achat trouvé</div>';
      return;
    }

    if (body) {
      body.innerHTML = rows.map(function(row) {
        return '<tr>' +
          '<td>' + escapeDepenseHtml(row.date) + '</td>' +
          '<td>' + escapeDepenseHtml(row.supplier) + '<div>' + renderActionAuthor(row) + '</div></td>' +
          '<td>' + escapeDepenseHtml(row.product) + '</td>' +
          '<td>' + escapeDepenseHtml(row.code || "-") + '</td>' +
          '<td>' + escapeDepenseHtml(row.variation || "-") + '</td>' +
          '<td>' + row.qty + '</td>' +
          '<td>' + fmt(row.unit) + '</td>' +
          '<td>' + fmt(row.total) + '</td>' +
          '<td>' + fmt(row.paid) + '</td>' +
          '<td>' + fmt(row.debt) + '</td>' +
        '</tr>';
      }).join("");
    }

    if (cards) {
      cards.innerHTML = rows.map(function(row) {
        return '<div class="achat-history-card">' +
          '<div class="achat-history-card-top">' +
            '<div>' +
              '<strong>' + escapeDepenseHtml(row.product) + '</strong>' +
              '<span>' + escapeDepenseHtml(row.supplier || "Fornecedor") + '</span>' +
              renderActionAuthor(row) +
            '</div>' +
            '<b>' + fmt(row.total) + '</b>' +
          '</div>' +
          '<div class="achat-history-card-meta">' +
            '<span>' + escapeDepenseHtml(row.date) + '</span>' +
            '<span>Qtd: ' + row.qty + '</span>' +
            '<span>P. Achat: ' + fmt(row.unit) + '</span>' +
          '</div>' +
          '<div class="achat-history-card-meta">' +
            '<span>Code: ' + escapeDepenseHtml(row.code || "-") + '</span>' +
            '<span>Var: ' + escapeDepenseHtml(row.variation || "-") + '</span>' +
          '</div>' +
        '</div>';
      }).join("");
    }

  } catch (e) {
    console.error("Erro historico achat:", e);
    if (body) body.innerHTML = '<tr><td colspan="10" class="empty">Erro ao carregar histórico</td></tr>';
    if (cards) cards.innerHTML = '<div class="empty">Erro ao carregar histórico</div>';
    toast("Erro histórico achat: " + (e.message || e), "error");
  }
}

function switchFornTab(tab, btn) {
  ["fiche", "cadastro", "pagamento", "dividas"].forEach(function(name) {
    var panel = document.getElementById("forn-panel-" + name);
    var tabBtn = document.getElementById("forn-tab-" + name);

    if (panel) panel.style.display = name === tab ? "block" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === tab);
  });

  if (tab === "fiche") {
    renderSupplierDatalists();
    renderSupplierDirectory();
  }

  if (tab === "pagamento") {
    var date = document.getElementById("p-date");
    if (date && !date.value) date.value = new Date().toISOString().split("T")[0];
    renderSupplierDatalists();
    updateResteApayerFourn();
  }

  if (tab === "dividas") {
    loadResumoDettes();
  }
}
//MOI-MEME
function switchVendaTab(tab, btn) {
  ['novo','historico'].forEach(function(t) {
    document.getElementById('vente-panel-'+t).style.display = 'none';
    document.getElementById('vente-tab-'+t).classList.remove('active');
  });
  document.getElementById('vente-panel-'+tab).style.display = 'block';
  btn.classList.add('active');
  if (tab === 'venda') loadProducts();
  if (tab === 'historico') {
    loadHist();
  };
}
//MOI-MEME
function switchClientTab(tab, btn) {
  ['fiche','pagamento'].forEach(function(t) {
    document.getElementById('client-panel-'+t).style.display = 'none';
    document.getElementById('client-tab-'+t).classList.remove('active');
  });
  document.getElementById('client-panel-'+tab).style.display = 'block';
  btn.classList.add('active');
  if (tab === 'fiche') loadProducts();
  if (tab === 'pagamento') {
    loadProducts();
  };
}

function initAchatLines() {
  achatLines = [{ date: new Date().toISOString().split('T')[0], prod: '', code: '', category: '', variation: '', variations: [], photo: '', targetMargin: '', qty: 0, price: 0 }];
  paiementLines = [];
  renderAchatLines();
}

function addAchatLine() {
  achatLines.push({ date: new Date().toISOString().split('T')[0], prod: '', code: '', category: '', variation: '', variations: [], photo: '', targetMargin: '', qty: 0, price: 0 });
  renderAchatLines();
  setTimeout(function() {
    var inputs = document.querySelectorAll('.al-prod');
    if (inputs.length) inputs[inputs.length-1].focus();
  }, 50);
}

function removeAchatLine(i) {
  if (achatLines.length <= 1) { toast('Tem que ter pelo menos uma linha!', 'error'); return; }
  achatLines.splice(i, 1);
  renderAchatLines();
}

function renderAchatLines() {
  var tbody = document.getElementById('achat-lines-body');
  if (!tbody) return;
  var cur = window._currency || 'Kz';
  tbody.innerHTML = '';

  achatLines.forEach(function(line, i) {
    line.variations = line.variations && line.variations.length ? line.variations : parseVariationList(line.variation);
    var total = (line.qty || 0) * (line.price || 0);
    var variationChips = !line.variations.length ? '' : '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + line.variations.map(function(label, chipIndex) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:var(--surface2);border:1px solid var(--border);font-size:11px;">' + label + '<button type="button" onclick="removeAchatVariation(' + i + ',' + chipIndex + ')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;line-height:1;">x</button></span>';
    }).join('') + '</div>';
    var imagePreview = line.photo
      ? '<img class="achat-photo-preview" src="' + line.photo + '" alt="Foto do produto">'
      : '<div class="achat-photo-placeholder">Clique para<br>selecionar imagem</div>';
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="achat-photo-cell">' +
        '<div class="achat-photo-stack">' +
        //Image
        '<label class="achat-photo-picker">' +
          imagePreview +
          '<input type="file" accept="image/*" style="display:none;" onchange="handleAchatPhotoFile(event,' + i + ')">' +
        '</label>' +
        '</div>' +
      '</td>' +
      '<td class="achat-date-product-cell">' +
        '<div class="achat-field-stack" style="min-width:260px;">' +
          //Date
          '<input type="date" class="form-input achat-cell-input" value="' + line.date + '" onchange="achatLines[' + i + '].date=this.value">' +
          //Nom du produit
          '<input type="text" class="form-input achat-cell-input prod al-prod" value="' + (line.prod || '') + '" placeholder="Produto..." list="prodList" oninput="achatLines[' + i + '].prod=this.value" onchange="applyAchatProductPreset(' + i + ', this.value)">' +
          '<div class="achat-mini-grid">' +
            //code du produit
            '<input type="text" class="form-input achat-cell-input" value="' + (line.code || '') + '" placeholder="Código" oninput="achatLines[' + i + '].code=this.value">' +
            //categorie
            '<input type="text" class="form-input achat-cell-input" value="' + (line.category || '') + '" placeholder="Categorie" oninput="achatLines[' + i + '].category=this.value">' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td>' +
        '<div class="achat-variation-stack">'+
          '<div class="achat-variation-box">'+
            //variation
            '<input type="text" class="form-input achat-cell-input" id="al-var-new-' + i + '" placeholder="Nova variação">' +
            //bouton ajouter variable
            '<button type="button" onclick="addAchatVariation(' + i + ')" class="achat-add-var-btn">+</button>' +
          '</div>' +
          //ancien variation en cas dun produit deja enregistrer
          variationChips +
          //selection image
          '<div class="achat-mini-grid">' +
            '<input type="text" class="form-input achat-cell-input" value="' + (line.code || '') + '" placeholder="Código" oninput="achatLines[' + i + '].code=this.value">' +
            '<input type="text" class="form-input achat-cell-input" value="' + (line.category || '') + '" placeholder="Categoria" oninput="achatLines[' + i + '].category=this.value">' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td>' +
        '<div class="achat-price-stack">' +
        //prix unitaire
        '<input type="number" class="form-input achat-cell-input price" value="' + (line.price || '') + '" placeholder="P. compra" min="0" step="0.01" oninput="achatLines[' + i + '].price=parseFloat(this.value)||0;renderAchatTotals();">' +
        '<div class="achat-price-row">'+
          //Quantite
          '<input type="number" class="form-input achat-cell-input qty" value="' + (line.qty || '') + '" placeholder="Qtd" min="1" oninput="achatLines[' + i + '].qty=parseFloat(this.value)||0;renderAchatTotals();">' +
          //prix de vente
          '<input type="number" class="form-input achat-cell-input" value="' + (line.targetMargin || '') + '" placeholder="Preço venda" min="0" step="0.01" oninput="achatLines[' + i + '].targetMargin=this.value">' +
        '</div>' +
        '</div>' +
      '</td>' +
      //Montant total
      '<td class="achat-total-cell">' +
        //Montant total
        '<h4>Total</h4>'+
        '<span id="al-total-' + i + '"></span>' +
      '</td>' +
      //Supprimer 
      '<td style="text-align:center;">' +
        '<button onclick="removeAchatLine(' + i + ')" class="achat-remove-btn">Supprimer</button>' +
      '</td>';

    tbody.appendChild(tr);
  });

  renderAchatTotals();
}
function ensureMobileAchatControls() {
  var page = document.getElementById("page-achat");
  if (!page) return;

  if (!document.getElementById("mobileAchatAddBtn")) {
    var addBtn = document.createElement("button");
    addBtn.id = "mobileAchatAddBtn";
    addBtn.className = "mobile-achat-add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+";
    addBtn.onclick = function() {
      addAchatLine();
      renderMobileAchatSummary();
    };
    page.appendChild(addBtn);
  }

  if (!document.getElementById("mobileAchatSummary")) {
    var summary = document.createElement("div");
    summary.id = "mobileAchatSummary";
    summary.className = "mobile-achat-summary";
    page.appendChild(summary);
  }
}

function getAchatSummaryTotal() {
  return (achatLines || []).reduce(function(sum, line) {
    return sum + (Number(line.qty) || 0) * (Number(line.price) || 0);
  }, 0);
}

function getAchatSummaryCount() {
  return (achatLines || []).reduce(function(sum, line) {
    return sum + (Number(line.qty) || 0);
  }, 0);
}

function renderMobileAchatSummary() {
  ensureMobileAchatControls();

  var summary = document.getElementById("mobileAchatSummary");
  var addBtn = document.getElementById("mobileAchatAddBtn");

  if (!summary || !addBtn) return;

  var achatPage = document.getElementById("page-achat");
  var panelNovo = document.getElementById("achat-panel-novo");

  var isVisible = window.innerWidth <= 820 &&
    achatPage &&
    achatPage.classList.contains("active") &&
    panelNovo &&
    panelNovo.style.display !== "none";

  if (!isVisible) {
    summary.style.display = "none";
    addBtn.style.display = "none";
    return;
  }

  summary.style.display = "grid";
  addBtn.style.display = "grid";

  summary.innerHTML =
    '<div>' +
      '<div class="mobile-achat-summary-title">' + getAchatSummaryCount() + ' itens no pedido</div>' +
      '<div class="mobile-achat-summary-total">' + fmt(getAchatSummaryTotal()) + '</div>' +
    '</div>' +
    '<button class="mobile-achat-summary-btn" onclick="saveAchat()">Registar</button>';
}
function renderAchatTotals() {
  var cur = window._currency || 'Kz';
  var total = achatLines.reduce(function(s,l) {
    return s + (Number(l.qty) || 0) * (Number(l.price) || 0);
  }, 0);

  var tg = document.getElementById('achat-total-global');
  if (tg) tg.textContent = new Intl.NumberFormat('pt-PT').format(total) + ' ' + cur;

  achatLines.forEach(function(l, i) {
    var t = (Number(l.qty) || 0) * (Number(l.price) || 0);
    var el = document.getElementById('al-total-' + i);
    if (el) el.textContent = t > 0 ? new Intl.NumberFormat('pt-PT').format(t) + ' ' + cur : '0 ' + cur;
  });

  var du = document.getElementById('a-total-du-display');
  if (du) du.textContent = new Intl.NumberFormat('pt-PT').format(total) + ' ' + cur;

  updateResteAPayer(total);

  if (typeof renderMobileAchatSummary === "function") {
    renderMobileAchatSummary();
  }
}

function toggleCredit() {
  var checked = document.getElementById('a-credit').checked;
  document.getElementById('a-credit-fields').style.display = checked ? 'block' : 'none';
  if (checked && paiementLines.length === 0) addPaiementLine();
  renderPaiementLines();
  renderMobileAchatSummary();
}

function addPaiementLine() {
  var totalDu = achatLines.reduce(function(s,l) { return s+(l.qty||0)*(l.price||0); }, 0);
  var totalPaye = paiementLines.reduce(function(s,p) { return s+(p.montant||0); }, 0);
  if (totalPaye >= totalDu && paiementLines.length > 0) {
    toast('Total ja pago integralmente!', 'error'); return;
  }
  paiementLines.push({ date: new Date().toISOString().split('T')[0], montant: 0 });
  renderPaiementLines();
}

function removePaiementLine(i) {
  paiementLines.splice(i, 1);
  renderPaiementLines();
}

function renderPaiementLines() {
  var tbody = document.getElementById('paiements-body');
  if (!tbody) return;
  var cur = window._currency || 'Kz';
  var totalDu = achatLines.reduce(function(s,l) { return s+(l.qty||0)*(l.price||0); }, 0);
  tbody.innerHTML = '';
  var cumul = 0;

  paiementLines.forEach(function(p, i) {
    cumul += (p.montant||0);
    var reste = totalDu - cumul;
    var over = cumul > totalDu;

    var tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    tr.innerHTML =
      '<td style="padding:5px 8px;">' +
        '<input type="date" class="form-input" value="'+p.date+'" style="font-size:12px;padding:5px 8px;" ' +
          'onchange="paiementLines['+i+'].date=this.value">' +
      '</td>' +
      '<td style="padding:5px 8px;text-align:right;">' +
        '<input type="number" class="form-input" value="'+(p.montant||'')+'" placeholder="0" min="0" ' +
          'style="font-size:12px;padding:5px 8px;width:110px;text-align:right;'+(over?'border-color:var(--red);':'')+'" ' +
          'onchange="paiementLines['+i+'].montant=parseFloat(this.value)||0;renderPaiementLines();">' +
      '</td>' +
      '<td style="padding:5px 8px;text-align:right;font-size:12px;font-weight:600;color:'+(reste>=0&&!over?'var(--green)':'var(--red)')+';">' +
        (over ? ' Depasse!' : new Intl.NumberFormat('pt-PT').format(Math.max(0,reste))+' '+cur) +
      '</td>' +
      '<td style="padding:5px 8px;text-align:center;">' +
        '<button onclick="removePaiementLine('+i+')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:15px;opacity:0.6;">x</button>' +
      '</td>';
    tbody.appendChild(tr);
  });

  updateResteAPayer(totalDu);
}

async function saveAchat() {
  if (!requireAzulAction("purchase:create", "registar achat")) return;

  var supplier = document.getElementById("a-forn").value.trim();

  if (!supplier) {
    toast("Entra o fornecedor!", "error");
    return;
  }

  var items = (achatLines || []).map(function (line) {
    return {
      prod: line.prod || "",
      code: line.code || "",
      category: line.category || "",
      variation: line.variation || "",
      variations: line.variations || parseVariationList(line.variation || ""),
      photo: line.photo || "",
      qty: Number(line.qty) || 0,
      pa: Number(line.price) || 0,
      pv: Number(line.targetMargin) || 0
    };
  }).filter(function (item) {
    return item.prod && item.qty > 0;
  });

  if (!items.length) {
    toast("Adiciona pelo menos um produto valido.", "error");
    return;
  }

  var btn = document.querySelector("#achat-panel-novo .form-submit");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  var purchasePayload = {
    forn: supplier,
    items: items,
    credit: document.getElementById("a-credit").checked,
    payments: paiementLines || []
  };

  try {
   await savePurchaseToSupabase(purchasePayload);

    toast("Achat registado!", "success");

    document.getElementById("a-forn").value = "";
    document.getElementById("a-credit").checked = false;

    initAchatLines();
    await loadProducts(true);
    if (document.getElementById("achat-panel-historico") && document.getElementById("achat-panel-historico").style.display !== "none") {
      loadAchatHistorique();
    }

  } catch (e) {
    console.error("Erro Supabase achat:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("purchase", purchasePayload);
      toast("Sem internet: achat garde pour synchroniser depois.", "success");
      document.getElementById("a-forn").value = "";
      document.getElementById("a-credit").checked = false;
      initAchatLines();
      return;
    }
    toast("Erro ao registar achat: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Achat";
      btn.style.opacity = "1";
    }
  }
}
async function getSupplierDebtFromSupabase(supplier) {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("supplier", supplier)
    .gt("remaining_amount", 0);

  if (result.error) throw result.error;

  return (result.data || []).reduce(function(sum, row) {
    return sum + (Number(row.remaining_amount) || 0);
  }, 0);
}

async function registerSupplierPaymentInSupabase(data) {
  var organizationId = getAzulOrganizationId();
  var supplier = String(data.forn || "").trim();
  var amount = Number(data.montant) || 0;

  if (!supplier) throw new Error("Fornecedor obrigatorio.");
  if (amount <= 0) throw new Error("Montante invalido.");

  var paymentResult = await insertSingleWithAzulAudit("supplier_payments", {
      organization_id: organizationId,
      supplier: supplier,
      amount: amount,
      note: data.note || "",
      payment_date: data.date || new Date().toISOString().split("T")[0]
    });

  if (paymentResult.error) throw paymentResult.error;

  var payment = paymentResult.data;

  await createAccountingEntry(
    "supplier_payment",
    payment.id,
    payment.payment_date,
    "Pagamento fornecedor " + payment.supplier,
    [
      { account: "21", debit: Number(payment.amount) || 0, credit: 0 },
      { account: "11", debit: 0, credit: Number(payment.amount) || 0 }
    ]
    );

  var purchasesResult = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("supplier", supplier)
    .gt("remaining_amount", 0)
    .order("created_at", { ascending: true });

  if (purchasesResult.error) throw purchasesResult.error;

  var remainingPayment = amount;
  var purchases = purchasesResult.data || [];

  for (var i = 0; i < purchases.length && remainingPayment > 0; i++) {
    var purchase = purchases[i];
    var currentRemaining = Number(purchase.remaining_amount) || 0;
    var currentPaid = Number(purchase.paid_amount) || 0;
    var applied = Math.min(currentRemaining, remainingPayment);

    var updateResult = await supabaseClient
      .from("purchases")
      .update({
        paid_amount: currentPaid + applied,
        remaining_amount: currentRemaining - applied,
        is_credit: currentRemaining - applied > 0
      })
      .eq("id", purchase.id);

    if (updateResult.error) throw updateResult.error;

    remainingPayment -= applied;
  }

  return true;
}

async function getResumoDettesFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId);

  if (result.error) throw result.error;

  var map = {};

  (result.data || []).forEach(function(row) {
    var supplier = row.supplier || "Fornecedor";
    if (!map[supplier]) {
      map[supplier] = {
        forn: supplier,
        totalCompras: 0,
        totalPago: 0,
        saldo: 0
      };
    }

    map[supplier].totalCompras += Number(row.total) || 0;
    map[supplier].totalPago += Number(row.paid_amount) || 0;
    map[supplier].saldo += Number(row.remaining_amount) || 0;
  });

  return Object.keys(map).map(function(key) {
    var row = map[key];
    row.statut = row.saldo > 0 ? "En cours" : "Tout paye";
    return row;
  }).sort(function(a, b) {
    return b.saldo - a.saldo;
  });
}


// ===== PAGAMENTO FORNECEDOR =====
async function savePagamentoForn() {
  if (!requireAzulAction("supplier_payment:create", "registar pagamento fornecedor")) return;

  var btn = document.getElementById("pg-forn-btn");

  var data = {
    date: document.getElementById("p-date").value,
    forn: document.getElementById("p-forn").value.trim(),
    montant: parseFloat(document.getElementById("p-montant").value) || 0,
    note: document.getElementById("p-note").value.trim()
  };

  if (!data.forn || data.montant <= 0) {
    toast("Preenche fornecedor e montante!", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  try {
    await registerSupplierPaymentInSupabase(data);

    toast("Pagamento registado!", "success");

    document.getElementById("p-forn").value = "";
    document.getElementById("p-montant").value = "";
    document.getElementById("p-note").value = "";
    document.getElementById("restePayFourn").textContent = "0 kz";

    renderFornPayDatalist();
    loadResumoDettes();

  } catch (e) {
    console.error("Erro pagamento fornecedor:", e);
    toast("Erro ao registar pagamento: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Pagamento";
      btn.style.opacity = "1";
    }
  }
}

// ===== RESUMO DETTES =====
async function loadResumoDettes() {
  var el = document.getElementById("resumo-dettes");
  if (!el) return;

  el.innerHTML = '<div class="empty">A carregar...</div>';

  try {
    var data = await getResumoDettesFromSupabase();

    if (!data || data.length === 0) {
      el.innerHTML = '<div class="empty">Sem dettes registadas</div>';
      return;
    }

    el.innerHTML = data.map(function(d) {
      var saldoColor = d.saldo > 0 ? "var(--red)" : "var(--green)";

      return '<div class="card" style="margin-bottom:10px;">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">' +
          '<div>' +
            '<div style="font-size:15px;font-weight:800;">' + escapeDepenseHtml(d.forn) + '</div>' +
            '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Compras: ' + fmt(d.totalCompras) + '</div>' +
            '<div style="font-size:12px;color:var(--muted);margin-top:2px;">Pago: ' + fmt(d.totalPago) + '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Saldo</div>' +
            '<div style="font-size:18px;font-weight:900;color:' + saldoColor + ';">' + fmt(d.saldo) + '</div>' +
            '<span class="tbadge ' + (d.saldo > 0 ? "credito" : "cash") + '">' + d.statut + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join("");

  } catch (e) {
    console.error("Erro resumo dettes:", e);
    el.innerHTML = '<div class="empty">Erro ao carregar dettes</div>';
    toast("Erro resumo dettes: " + (e.message || e), "error");
  }
}

// ===== TRANSFERENCIA =====
async function saveTransfer() {
  if (!requireAzulAction("stock:transfer", "transferir stock")) return;

  var data = {
    date: document.getElementById("t-date").value,
    prod: document.getElementById("t-prod").value.trim(),
    qty: parseInt(document.getElementById("t-qty").value, 10) || 0,
    obs: document.getElementById("t-obs").value.trim()
  };

  if (!data.prod || data.qty <= 0) {
    toast("Preenche produto e quantidade!", "error");
    return;
  }

  var btn = document.querySelector("#transferSingle .form-submit");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A transferir...";
    btn.style.opacity = "0.6";
  }

  try {
    await transferProductToShop(data.prod, data.qty);

    toast("Transferencia registada!", "success");

    document.getElementById("t-prod").value = "";
    document.getElementById("t-qty").value = "";
    document.getElementById("t-obs").value = "";

    await loadProducts(true);

  } catch (e) {
    console.error("Erro transferencia:", e);
    toast("Erro ao transferir: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Transferencia";
      btn.style.opacity = "1";
    }
  }
}


// ===== HISTORICO =====
async function loadHist() {
  var tb = document.getElementById("histBody");
  if (!tb) return;

  tb.innerHTML = '<tr><td colspan="8" class="empty">A carregar...</td></tr>';
  renderMobileSalesHistory([]);

  var params = {
    from: document.getElementById("h-from").value,
    to: document.getElementById("h-to").value,
    search: document.getElementById("h-search").value.toLowerCase()
  };

  try {
    var data = await getSalesHistoryFromSupabase(params);

    renderMobileSalesHistory(data);

    if (!data || data.length === 0) {
      tb.innerHTML = '<tr><td colspan="8" class="empty">Nenhuma venda encontrada</td></tr>';
      return;
    }

    tb.innerHTML = "";

    data.forEach(function(v) {
      var payText = String(v.pay || "").toLowerCase();
      var payClass = payText.indexOf("+") >= 0 || payText.indexOf(":") >= 0
        ? "mixte"
        : payText.replace("a", "a");

      var tr = document.createElement("tr");

      tr.innerHTML =
        "<td>" + escapeDepenseHtml(v.date || "") + "</td>" +
        "<td>" + escapeDepenseHtml(v.prod || "") + "</td>" +
        "<td>" + escapeDepenseHtml(v.client || "-") + "</td>" +
        "<td>" + v.qty + "</td>" +
        "<td>" + fmt(v.punit) + "</td>" +
        '<td style="color:var(--blue);font-weight:600">' + fmt(v.total) + "</td>" +
        '<td><span class="tbadge ' + payClass + '">' + escapeDepenseHtml(v.pay || "-") + "</span></td>" +
        '<td style="font-size:10px;color:var(--muted)">' +
          '<div>' + escapeDepenseHtml(v.recibo || "-") + '</div>' +
          renderActionAuthor(v) +
        "</td>";

      tb.appendChild(tr);
    });

  } catch (e) {
    console.error("Erro historico vendas:", e);
    tb.innerHTML = '<tr><td colspan="8" class="empty">Erro ao carregar historico</td></tr>';
    renderMobileSalesHistory([]);
    toast("Erro historico vendas: " + (e.message || e), "error");
  }
}



// ===== CONFIG SYSTEM =====
var config = {
  name: 'Azul',
  slogan: 'O sistema de gestão que o seu negocio merece',
  currency: 'Kz',
  language: 'pt',
  color: '#0b3d91',
  color2: '#071e4f',
  theme: 'light',
  armazem: false,
  setupDone: true,
  // Champs du recibo
  address: '',
  phone: '',
  receiptFont: 'DM Sans',
  receiptFontSize: '10',
  receiptLogo: '',
  receiptLogoSize: '16',
  footer: 'Obrigado pela sua preferencia!',
  showDate: true,
  showClient: true,
  showPayment: true,
  showRecibo: true,
  showAddress: true
};
var selectedSetupColor = '#0b3d91';
var selectedSetupColor2 = '#071e4f';
var selectedSetupTheme = 'light';

function loadSettings() {
  try {
    var saved = localStorage.getItem('pos_config');
    if (saved) {
      config = Object.assign({}, config, JSON.parse(saved) || {});
    }
  } catch(e) {}
  selectedSetupColor = config.color || selectedSetupColor || '#0b3d91';
  selectedSetupColor2 = config.color2 || selectedSetupColor2 || '#071e4f';
  selectedSetupTheme = config.theme || selectedSetupTheme || 'light';
  if (['pt','fr','en'].indexOf(config.language) === -1) config.language = 'pt';
  applyConfig();
  var overlay = document.getElementById('setupOverlay');
  if (overlay) overlay.style.display = 'none';
}
function showSetup() {
  document.getElementById('setupOverlay').style.display = 'flex';
}

function selectColor(el, c1, c2) {
  document.querySelectorAll('.color-opt').forEach(function(o) { o.classList.remove('active'); });
  document.querySelectorAll('.color-opt[data-color="' + c1 + '"]').forEach(function(o) { o.classList.add('active'); });
  selectedSetupColor = c1;
  selectedSetupColor2 = c2;
  config.color = c1;
  config.color2 = c2;
  applyConfig();
}

function selectStockMode(mode) {
  // Met en evidence l'option selectionnee
  var boutique = document.getElementById('stock-opt-boutique');
  var armazem  = document.getElementById('stock-opt-armazem');
  if (boutique) boutique.style.borderColor = mode === 'boutique' ? (selectedSetupColor || '#0b3d91') : '#e0e0e0';
  if (armazem)  armazem.style.borderColor  = mode === 'armazem'  ? (selectedSetupColor || '#0b3d91') : '#e0e0e0';
}

function selectTheme(theme, btn) {
  selectedSetupTheme = theme;
  config.theme = theme;
  document.querySelectorAll('[id^="theme-"],[id^="cfg-theme-"]').forEach(function(b) {
    b.classList.remove('active');
    b.style.borderColor = '';
    b.style.color = '';
    b.style.background = '';
  });
  document.querySelectorAll('#theme-' + theme + ',#cfg-theme-' + theme).forEach(function(b) {
    b.classList.add('active');
    b.style.borderColor = selectedSetupColor || 'var(--blue)';
    b.style.color = selectedSetupColor || 'var(--blue)';
    b.style.background = 'rgba(201,168,76,0.1)';
  });
  applyConfig();
}

function finishSetup() {
  var name = document.getElementById('setup-name').value.trim();
  if (!name) { alert('Por favor insere o nome da boutique!'); return; }
  config.name = name;
  config.slogan = document.getElementById('setup-slogan').value.trim() || 'O sistema de gestão que o seu negocio merece';
  config.currency = document.getElementById('setup-currency').value;
  config.stockMode = document.querySelector('input[name="stockMode"]:checked').value; // 'boutique' ou 'armazem'
  config.armazem = config.stockMode === 'armazem'; // true si armazem, false si boutique only
  config.color = selectedSetupColor;
  config.color2 = selectedSetupColor2;
  config.theme = selectedSetupTheme;
  config.setupDone = true;
  saveConfig();
  document.getElementById('setupOverlay').style.display = 'none';
  applyConfig();
  toast(' Configuracao guardada!', 'success');
}

function setCfgStockMode(mode) {
  config.stockMode = mode;
  config.armazem   = mode === 'armazem';
  var toggle = document.getElementById('toggleArmazem');
  if (toggle) toggle.checked = config.armazem;
  // Highlight selected option
  var b = document.getElementById('cfg-stock-boutique');
  var a = document.getElementById('cfg-stock-armazem');
  if (b) b.style.borderColor = mode === 'boutique' ? 'var(--blue)' : 'var(--border)';
  if (a) a.style.borderColor = mode === 'armazem'  ? 'var(--blue)' : 'var(--border)';
  // Sync radio
  var radios = document.querySelectorAll('input[name="cfgStockMode"]');
  radios.forEach(function(r) { r.checked = r.value === mode; });
  applyConfig();
}

function applyReceiptFont() {
  var fontSelect = document.getElementById('cfg-font');
  var sizeSelect = document.getElementById('cfg-font-size');
  var logoSelect = document.getElementById('cfg-logo-size');
  if (fontSelect) config.receiptFont = fontSelect.value || 'DM Sans';
  if (sizeSelect) config.receiptFontSize = sizeSelect.value || '10';
  if (logoSelect) config.receiptLogoSize = logoSelect.value || '16';
  applyConfig();
}

function updateReceiptLogoUrl(value) {
  config.receiptLogo = (value || '').trim();
  applyConfig();
}

function clearReceiptLogo() {
  config.receiptLogo = '';
  var urlInput = document.getElementById('cfg-logo-url');
  if (urlInput) urlInput.value = '';
  var fileInput = document.getElementById('cfg-logo-file');
  if (fileInput) fileInput.value = '';
  applyConfig();
}

function handleReceiptLogoFile(event) {
  var file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var result = e && e.target ? e.target.result : '';
    config.receiptLogo = result || '';
    var urlInput = document.getElementById('cfg-logo-url');
    if (urlInput) urlInput.value = config.receiptLogo;
    applyConfig();
  };
  reader.readAsDataURL(file);
}
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////Debut de la fonction de la traduction ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
function getCurrentLanguage() {
  return (config && config.language) || 'pt';
}

function getLocale() {
  var lang = (config && config.language) || 'pt';
  if (lang === 'fr') return 'fr-FR';
  if (lang === 'en') return 'en-US';
  return 'pt-PT';
}

function tr(key, vars) {
  var text = getText(key);
  Object.keys(vars || {}).forEach(function(k) {
    text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
  });
  return text;
}

function getText(key) {
  var lang = (config && config.language) || 'pt';
  var dict = {
    pt: {
      revconsselect : 'Selecione um consignação.',
      revendeurselcttext: 'Escolha um revendedor para ver os seus registos em curso',
      tab_dashboard: 'Dashboard',
      tab_venda: 'Nova Venda',
      tab_achat: 'Nova Compra',
      tab_transfert: 'Estoque',
      tab_clientes: 'Clientes',
      tab_depenses: 'Despesas',
      tab_rh: 'Recursos Humanos',
      tab_forn: 'Fornecedores',
      tab_settings: 'Definicoes',
      tab_tresorerie: 'Tesouraria',
      tab_comptabilite: 'Contabilidade',
      tab_corrections: 'Correcoes',
      tab_revendeurs: 'Revendedores',
      save_settings: 'Guardar configurações',
      reset_setup: 'Reiniciar configuração',
      clear_cart: 'Limpar',
      payment: 'Pagamento',
      search_product: 'Pesquisar produto...',
      client_placeholder: 'Nome do cliente (deixa vazio = Anonimo)',
      treasury_title: 'Tesouraria',
      rh_title: 'Recursos Humanos',
      resellers_title: 'Revendedores',
      clients_title: 'Ficha Clientes',
      expenses_title: 'Registar Despesa',
      suppliers_title: 'Registar Fornecedor',
      rev_create: 'Criar Consignação',
      rev_pay: 'Confirmar Pagamento',
      rev_return: 'Retornar Mercadoria',
      rev_open: 'Consignação aberta',
      rev_name: 'Nome do revendedor',
      rev_search: 'Pesquisar produto...',
      rev_price_placeholder: 'Preco consignacao...',
      sale_price_placeholder: 'Preco venda...',
      anonymous: 'Anonimo',
      receipt_thanks: 'Obrigado por escolher ',
      receipt_footer_default: 'Obrigado pela sua preferência!',
      settings_saved: 'Configurações guardadas!',
      loading: 'A carregar...',
      no_data: 'Sem dados',
      no_products: 'Sem produtos',
      loading_products: 'A carregar produtos...',
      cart_empty: 'Adiciona produtos ao carrinho',
      add_products: 'Adiciona produtos',
      add_payment_method: '+ Adicionar meio de pagamento',
      payment_status: 'Pago: {paid} / Total: {total}',
      confirm_sale: 'Confirmar Venda',
      register_sale: 'A registar venda...',
      stock_ok: 'Stock OK',
      no_expenses: 'Sem despesas',
      no_open_consignment: 'Nenhuma consignação aberta',
      reseller_required: 'Entra o nome do revendedor!',
      add_one_product: 'Ajoute ao menos um produto!',
      enter_price_for: 'Entra o preco para {name}',
      consignment_created: 'Consignação criada: {id}',
      consignment_paid: 'Consignação paga com sucesso!',
      goods_returned: 'Mercadoria retornada.',
      reseller_not_found: 'Revendedor nao encontrado',
      no_history: 'Sem historico',
      in_possession: 'Em posse',
      open_count: 'Abertas',
      empty_cart_error: 'Carrinho vazio!',
      enter_sale_price: 'Entra o preco de venda para: {name}',
      payment_total_mismatch: 'O total dos pagamentos deve ser igual ao total da venda.',
      sale_registered: 'Venda registada com sucesso!',
      at_least_one_payment: 'Pelo menos um meio de pagamento!',
      stock_insufficient_max: 'Stock insuficiente! Max: {stock} un. Muda para Encomenda para ultrapassar.',
      stock_insufficient_order: 'Stock insuficiente! Max disponivel: {stock} un. Muda para "Encomenda" para ultrapassar.',
      stock_insufficient_consignment: 'Stock insuficiente para consignação.',
      stock_insufficient_product: 'Stock insuficiente para este produto.',
      at_least_one_line: 'Tem que ter pelo menos uma linha!',
      purchase_fully_paid: 'Total ja pago integralmente!',
      fill_supplier_name: 'Entra o nome do fornecedor!',
      fill_all_product_fields: 'Preenche todos os campos de cada produto!',
      purchase_payment_too_high: 'O total dos pagamentos ultrapassa o total da encomenda!',
      purchase_registered: 'Compra registada com sucesso!',
      fill_supplier_and_amount: 'Preenche fornecedor e montante!',
      supplier_payment_registered: 'Pagamento registado!',
      no_supplier_debts: 'Sem dívidas registadas',
      fill_product_and_quantity: 'Preenche produto e quantidade!',
      transfer_registered: 'Transferência registada!',
      no_sales_found: 'Nenhuma venda encontrada',
      finish_setup_name_required: 'Por favor insere o nome da boutique!',
      setup_saved: 'Configuração guardada!',
      warehouse_empty: 'Armazem vazio - nada a transferir',
      products_to_transfer: '{count} produtos a transferir',
      no_warehouse_stock: 'Nenhum stock no armazem!',
      transferring: 'A transferir...',
      transferred: 'Transferido!',
      transfer_done_reload: 'Transferência concluída! Recarrega o stock para confirmar.',
      all_stock_transferred: 'Todo o stock transferido para a Boutique!',
      activating: 'A activar...',
      edit_mode_error: 'Erro ao activar modo edicao',
      edit_mode_button: 'Activar Modo Edicao (1 min)',
      edit_mode_active: 'Modo Edicao ACTIVO',
      edit_mode_active_toast: 'Modo edicao activo por 1 minuto!',
      edit_mode_lock_in: 'Bloqueia em {seconds}s...',
      sheets_locked_again: 'Folhas bloqueadas novamente.',
      fill_description_and_amount: 'Preenche descricao e montante!',
      expense_registered: 'Despesa registada!',
      valid_amount: 'Entra um montante valido!',
      treasury_registered: 'Movimento de tesouraria registado!',
      no_movements_found: 'Nenhum movimento encontrado',
      supplier_registered: 'Fornecedor registado!',
      enter_customer_name: 'Entra um nome de cliente!',
      client_not_found: 'Cliente nao encontrado',
      th_balance: 'Saldo',
      light_theme: 'Claro',
      dark_theme: 'Escuro',
      stock_shop_only: 'Stock apenas na boutique',
      stock_shop_only_desc: 'Compras entram directamente na boutique. Sem transferências.',
      stock_shop_warehouse: 'Stock Boutique + Armazém',
      stock_shop_warehouse_desc: 'Compras entram no armazém, depois transferes para a boutique.',
      receipt_customization: 'Personalização do recibo',
      receipt_logo_image: 'Imagem do logo do recibo',
      receipt_logo_remove: 'Remover imagem',
      receipt_logo_size: 'Tamanho do logo do recibo',
      receipt_show: 'Mostrar no recibo',
      direct_edit_mode: 'Modo de edição directa',
      direct_edit_desc:'Desbloqueia as folhas por 1 minuto para corrigir ou eliminar linhas. Bloqueia automaticamente depois',
      client_file_tab: 'Ficha cliente',
      client_payment_tab: 'Registar pagamento',
      search_client_placeholder: 'Nome do cliente...',
      search_button: 'Pesquisar',
      client_search_empty: 'Pesquisa um cliente para ver a sua ficha',
      client_payment_title: 'Registar Pagamento do Cliente',
      amount_paid: 'Montante pago',
      amount_remaining: 'Montante restante',
      credit_limit_warning: 'ultrapassou o limite do crédito',
      new_expense_tab: 'Nova Despesa',
      expense_dashboard_tab: 'Dashboard Despesas',
      expense_history_tab: 'Histórico Despesas',
      expense_category_new: 'Nova categoria...',
      add_button: 'Adicionar',
      register_expense_button: 'Registar Despesa',
      register_purchase_button: 'Registar Compra',
      save_product_profile: 'Guardar ficha do produto',
      registering: 'A registar...',
      create_consignment_button: 'Criar Consignação',
      confirm_payment_button: 'Confirmar pagamento',
      confirm_return_button: 'Confirmar retorno'
    },
    fr: {
      revconsselect : 'Selectionne une consignation.',
      revendeurselcttext: 'Choisis un revendeur pour afficher ses consignations en cours',
      tab_dashboard: 'Dashboard',
      tab_venda: 'Nouvelle Vente',
      tab_achat: 'Nouvel Achat',
      tab_transfert: 'Stock',
      tab_clientes: 'Clients',
      tab_depenses: 'Depenses',
      tab_rh: 'RH',
      tab_forn: 'Fournisseurs',
      tab_settings: 'Parametres',
      tab_tresorerie: 'Tresorerie',
      tab_comptabilite: 'Comptabilite',
      tab_corrections: 'Corrections',
      tab_revendeurs: 'Revendeurs',
      save_settings: 'Enregistrer les parametres',
      reset_setup: 'Relancer la configuration',
      clear_cart: 'Vider',
      payment: 'Paiement',
      search_product: 'Rechercher un produit...',
      client_placeholder: 'Nom du client (laisser vide = Anonyme)',
      treasury_title: 'Tresorerie',
      rh_title: 'RH',
      resellers_title: 'Revendeurs',
      clients_title: 'Fiche Client',
      expenses_title: 'Enregistrer Depense',
      suppliers_title: 'Enregistrer Fournisseur',
      rev_create: 'Creer Consignation',
      rev_pay: 'Confirmer Paiement',
      rev_return: 'Retour Marchandise',
      rev_open: 'Consignation ouverte',
      rev_name: 'Nom du revendeur',
      rev_search: 'Rechercher un produit...',
      rev_price_placeholder: 'Prix consignation...',
      sale_price_placeholder: 'Prix de vente...',
      anonymous: 'Anonyme',
      receipt_thanks: 'Merci d avoir choisi ',
      receipt_footer_default: 'Merci pour votre preference!',
      settings_saved: 'Parametres enregistres !',
      loading: 'Chargement...',
      no_data: 'Aucune donnee',
      no_products: 'Aucun produit',
      loading_products: 'Chargement des produits...',
      cart_empty: 'Ajoute des produits au panier',
      add_products: 'Ajoute des produits',
      add_payment_method: '+ Ajouter moyen de paiement',
      payment_status: 'Paye: {paid} / Total: {total}',
      confirm_sale: 'Confirmer Vente',
      register_sale: 'Enregistrement de la vente...',
      stock_ok: 'Stock OK',
      no_expenses: 'Aucune depense',
      no_open_consignment: 'Aucune consignation ouverte',
      reseller_required: 'Entre le nom du revendeur !',
      add_one_product: 'Ajoute au moins un produit !',
      enter_price_for: 'Entre le prix pour {name}',
      consignment_created: 'Consignation creee: {id}',
      consignment_paid: 'Consignation payee avec succes !',
      goods_returned: 'Marchandise retournee.',
      reseller_not_found: 'Revendeur introuvable',
      no_history: 'Aucun historique',
      in_possession: 'En possession',
      open_count: 'Ouvertes',
      empty_cart_error: 'Panier vide !',
      enter_sale_price: 'Entre le prix de vente pour : {name}',
      payment_total_mismatch: 'Le total des paiements doit etre egal au total de la vente.',
      sale_registered: 'Vente enregistree avec succes !',
      at_least_one_payment: 'Au moins un moyen de paiement !',
      stock_insufficient_max: 'Stock insuffisant ! Max : {stock} un. Passe en Commande pour depasser.',
      stock_insufficient_order: 'Stock insuffisant ! Max disponible : {stock} un. Passe en "Commande" pour depasser.',
      stock_insufficient_consignment: 'Stock insuffisant pour la consignation.',
      stock_insufficient_product: 'Stock insuffisant pour ce produit.',
      at_least_one_line: 'Il faut au moins une ligne !',
      purchase_fully_paid: 'Le total est deja paye !',
      fill_supplier_name: 'Entre le nom du fournisseur !',
      fill_all_product_fields: 'Remplis tous les champs de chaque produit !',
      purchase_payment_too_high: 'Le total des paiements depasse le total de la commande !',
      purchase_registered: 'Achat enregistre avec succes !',
      fill_supplier_and_amount: 'Remplis fournisseur et montant !',
      supplier_payment_registered: 'Paiement enregistre !',
      no_supplier_debts: 'Aucune dette enregistree',
      fill_product_and_quantity: 'Remplis produit et quantite !',
      transfer_registered: 'Transfert enregistre !',
      no_sales_found: 'Aucune vente trouvee',
      finish_setup_name_required: 'Merci d entrer le nom de la boutique !',
      setup_saved: 'Configuration enregistree !',
      warehouse_empty: 'Entrepot vide - rien a transferer',
      products_to_transfer: '{count} produits a transferer',
      no_warehouse_stock: 'Aucun stock dans l entrepot !',
      transferring: 'Transfert en cours...',
      transferred: 'Transfere !',
      transfer_done_reload: 'Transfert termine ! Recharge le stock pour confirmer.',
      all_stock_transferred: 'Tout le stock a ete transfere vers la Boutique !',
      activating: 'Activation...',
      edit_mode_error: 'Erreur lors de l activation du mode edition',
      edit_mode_button: 'Activer Mode Edition (1 min)',
      edit_mode_active: 'Mode Edition ACTIF',
      edit_mode_active_toast: 'Mode edition actif pendant 1 minute !',
      edit_mode_lock_in: 'Blocage dans {seconds}s...',
      sheets_locked_again: 'Les feuilles sont de nouveau bloquees.',
      fill_description_and_amount: 'Remplis description et montant !',
      expense_registered: 'Depense enregistree !',
      valid_amount: 'Entre un montant valide !',
      treasury_registered: 'Mouvement de tresorerie enregistre !',
      no_movements_found: 'Aucun mouvement trouve',
      supplier_registered: 'Fournisseur enregistre !',
      enter_customer_name: 'Entre un nom de client !',
      client_not_found: 'Client introuvable',
      th_balance: 'Solde',
      light_theme: 'Clair',
      dark_theme: 'Sombre',
      stock_shop_only: 'Stock boutique uniquement',
      stock_shop_only_desc: 'Les achats entrent directement en boutique. Pas de transferts.',
      stock_shop_warehouse: 'Stock Boutique + Entrepot',
      stock_shop_warehouse_desc: 'Les achats entrent en entrepot, puis tu transferes vers la boutique.',
      receipt_customization: 'Personnalisation du recu',
      receipt_logo_image: 'Image du logo du recu',
      receipt_logo_remove: 'Supprimer image',
      receipt_logo_size: 'Taille du logo du recu',
      receipt_show: 'Afficher sur le recu',
      direct_edit_mode: 'Mode edition directe',
      direct_edit_desc: 'Debloque les feuilles pendant 1 minute pour corriger ou supprimer des lignes. Blocage automatique ensuite.',
      client_file_tab: 'Fiche client',
      client_payment_tab: 'Enregistrer paiement',
      search_client_placeholder: 'Nom du client...',
      search_button: 'Rechercher',
      client_search_empty: 'Recherche un client pour voir sa fiche',
      client_payment_title: 'Enregistrer Paiement Client',
      amount_paid: 'Montant paye',
      amount_remaining: 'Montant restant',
      credit_limit_warning: 'vous avez depasse la limite du credit',
      new_expense_tab: 'Nouvelle Depense',
      expense_dashboard_tab: 'Dashboard Depenses',
      expense_history_tab: 'Historique Depenses',
      expense_category_new: 'Nouvelle categorie...',
      add_button: 'Ajouter',
      register_expense_button: 'Enregistrer Depense',
      register_purchase_button: 'Enregistrer Achat',
      save_product_profile: 'Enregistrer la fiche produit',
      registering: 'Enregistrement...',
      create_consignment_button: 'Creer Consignation',
      confirm_payment_button: 'Confirmer paiement',
      confirm_return_button: 'Confirmer retour'
    },
    en: {
      revconsselect : 'Select a consignment.',
      revendeurselcttext: 'Select a dealer to view their current consignments',
      tab_dashboard: 'Dashboard',
      tab_venda: 'New Sale',
      tab_achat: 'New Purchase',
      tab_transfert: 'Stock',
      tab_clientes: 'Customers',
      tab_depenses: 'Expenses',
      tab_rh: 'HR',
      tab_forn: 'Suppliers',
      tab_settings: 'Settings',
      tab_tresorerie: 'Treasury',
      tab_comptabilite: 'Comptabilite',
      tab_corrections: 'Corrections',
      tab_revendeurs: 'Resellers',
      save_settings: 'Save Settings',
      reset_setup: 'Restart setup',
      clear_cart: 'Clear',
      payment: 'Payment',
      search_product: 'Search product...',
      client_placeholder: 'Customer name (leave blank = Anonymous)',
      treasury_title: 'Treasury',
      rh_title: 'HR',
      resellers_title: 'Resellers',
      clients_title: 'Customer File',
      expenses_title: 'Register Expense',
      suppliers_title: 'Register Supplier',
      rev_create: 'Create Consignment',
      rev_pay: 'Confirm Payment',
      rev_return: 'Return Goods',
      rev_open: 'Open consignment',
      rev_name: 'Reseller name',
      rev_search: 'Search product...',
      rev_price_placeholder: 'Consignment price...',
      sale_price_placeholder: 'Sale price...',
      anonymous: 'Anonymous',
      receipt_thanks: 'Thanks for choosing ',
      receipt_footer_default: 'Thanks for your preference!',
      settings_saved: 'Settings saved!',
      loading: 'Loading...',
      no_data: 'No data',
      no_products: 'No products',
      loading_products: 'Loading products...',
      cart_empty: 'Add products to cart',
      add_products: 'Add products',
      add_payment_method: '+ Add payment method',
      payment_status: 'Paid: {paid} / Total: {total}',
      confirm_sale: 'Confirm Sale',
      register_sale: 'Registering sale...',
      stock_ok: 'Stock OK',
      no_expenses: 'No expenses',
      no_open_consignment: 'No open consignment',
      reseller_required: 'Enter the reseller name!',
      add_one_product: 'Add at least one product!',
      enter_price_for: 'Enter the price for {name}',
      consignment_created: 'Consignment created: {id}',
      consignment_paid: 'Consignment paid successfully!',
      goods_returned: 'Goods returned.',
      reseller_not_found: 'Reseller not found',
      no_history: 'No history',
      in_possession: 'In possession',
      open_count: 'Open',
      empty_cart_error: 'Cart is empty!',
      enter_sale_price: 'Enter the sale price for: {name}',
      payment_total_mismatch: 'The total payment must match the sale total.',
      sale_registered: 'Sale registered successfully!',
      at_least_one_payment: 'At least one payment method is required!',
      stock_insufficient_max: 'Insufficient stock! Max: {stock} units. Switch to Order to continue.',
      stock_insufficient_order: 'Insufficient stock! Max available: {stock} units. Switch to "Order" to continue.',
      stock_insufficient_consignment: 'Insufficient stock for consignment.',
      stock_insufficient_product: 'Insufficient stock for this product.',
      at_least_one_line: 'At least one line is required!',
      purchase_fully_paid: 'Purchase is already fully paid!',
      fill_supplier_name: 'Enter the supplier name!',
      fill_all_product_fields: 'Fill every field for each product!',
      purchase_payment_too_high: 'Payment total exceeds the purchase total!',
      purchase_registered: 'Purchase registered successfully!',
      fill_supplier_and_amount: 'Fill supplier and amount!',
      supplier_payment_registered: 'Payment registered!',
      no_supplier_debts: 'No debts recorded',
      fill_product_and_quantity: 'Fill product and quantity!',
      transfer_registered: 'Transfer registered!',
      no_sales_found: 'No sales found',
      finish_setup_name_required: 'Please enter the shop name!',
      setup_saved: 'Setup saved!',
      warehouse_empty: 'Warehouse empty - nothing to transfer',
      products_to_transfer: '{count} products to transfer',
      no_warehouse_stock: 'No stock in warehouse!',
      transferring: 'Transferring...',
      transferred: 'Transferred!',
      transfer_done_reload: 'Transfer completed! Refresh stock to confirm.',
      all_stock_transferred: 'All stock transferred to the shop!',
      activating: 'Activating...',
      edit_mode_error: 'Error enabling edit mode',
      edit_mode_button: 'Enable Edit Mode (1 min)',
      edit_mode_active: 'Edit Mode ACTIVE',
      edit_mode_active_toast: 'Edit mode enabled for 1 minute!',
      edit_mode_lock_in: 'Locks in {seconds}s...',
      sheets_locked_again: 'Sheets locked again.',
      fill_description_and_amount: 'Fill description and amount!',
      expense_registered: 'Expense registered!',
      valid_amount: 'Enter a valid amount!',
      treasury_registered: 'Treasury movement registered!',
      no_movements_found: 'No movements found',
      supplier_registered: 'Supplier registered!',
      enter_customer_name: 'Enter a customer name!',
      client_not_found: 'Customer not found',
      th_balance: 'Balance',
      light_theme: 'Light',
      dark_theme: 'Dark',
      stock_shop_only: 'Shop stock only',
      stock_shop_only_desc: 'Purchases go directly to the shop. No transfers.',
      stock_shop_warehouse: 'Shop + Warehouse stock',
      stock_shop_warehouse_desc: 'Purchases go to the warehouse, then you transfer them to the shop.',
      receipt_customization: 'Receipt Customization',
      receipt_logo_image: 'Receipt logo image',
      receipt_logo_remove: 'Remove image',
      receipt_logo_size: 'Receipt logo size',
      receipt_show: 'Show on receipt',
      direct_edit_mode: 'Direct edit mode',
      direct_edit_desc: 'Unlocks sheets for 1 minute to correct or delete rows. Locks automatically after.',
      client_file_tab: 'Customer file',
      client_payment_tab: 'Register payment',
      search_client_placeholder: 'Customer name...',
      search_button: 'Search',
      client_search_empty: 'Search a customer to view the file',
      client_payment_title: 'Register Customer Payment',
      amount_paid: 'Amount paid',
      amount_remaining: 'Remaining amount',
      credit_limit_warning: 'you exceeded the credit limit',
      new_expense_tab: 'New Expense',
      expense_dashboard_tab: 'Expense Dashboard',
      expense_history_tab: 'Expense History',
      expense_category_new: 'New category...',
      add_button: 'Add',
      register_expense_button: 'Register Expense',
      register_purchase_button: 'Register Purchase',
      save_product_profile: 'Save product profile',
      registering: 'Registering...',
      create_consignment_button: 'Create Consignment',
      confirm_payment_button: 'Confirm payment',
      confirm_return_button: 'Confirm return'
    }
  };
  var fallback = (dict[lang] && dict[lang][key]) || dict.pt[key] || key;
  if (window.AzulI18n && typeof window.AzulI18n.t === "function") {
    return window.AzulI18n.t(key, fallback, lang);
  }
  return fallback;
}

function setPageTitle(pageId, text) {
  var el = document.querySelector('#' + pageId + ' .section-title');
  if (el) el.textContent = text;
}

function syncPageTitles() {
  setPageTitle('page-clientes', getText('clients_title'));
  setPageTitle('page-depenses', getText('expenses_title'));
  setPageTitle('page-revendeurs', getText('resellers_title'));
  setPageTitle('page-rh', getText('rh_title'));
  setPageTitle('page-tresorerie', getText('treasury_title'));
  setPageTitle('page-forn', getText('suppliers_title'));
  setPageTitle('page-comptabilite', getText('tab_comptabilite'));
  setPageTitle('page-corrections', getText('tab_corrections'));
}
//appl
function applyLanguage() {
  window._applyingLanguage = true;
  var lang = (config && config.language) || 'pt';
  try {
    document.documentElement.lang = lang;
    var tabs = document.querySelectorAll('.nav .tab');
    var keys = ['tab_dashboard','tab_venda','tab_achat','tab_transfert','tab_clientes','tab_depenses','tab_rh','tab_forn','tab_tresorerie','tab_comptabilite','tab_corrections','tab_revendeurs','tab_settings'];
    tabs.forEach(function(tab, index) {
      if (keys[index]) tab.textContent = getText(keys[index]);
    });

    var ui = {
      pt: {
        dashLabels: ['Periodo','De','Ate','Produto','Fornecedor'],
        dashOptions: ['Hoje','Esta semana','Este mes','Personalizado'],
        kpiLabels: ['Vendas','Lucro','Despesas','Alertas Stock'],
        kpiSubProfit: 'Receita - Custo',
        kpiSubAlerts: 'produtos em falta',
        dashCards: ['Top Produtos','Meios de Pagamento','Alertas de Stock Baixo','Ultimas Despesas'],
        payLabels: ['Cash','Express','Cartao'],
        achatTabs: ['Nova Compra','Registar Pagamento','Resumo de Dívidas'],
        histHeaders: ['Data','Produto','Cliente','Qtd','P.Unit','Total','Pagamento','N Recibo'],
        settingsCards: ['Identidade da Boutique','Moeda','Língua','Tema','Modo de Stock','Personalização do Recibo','Segurança'],
        resellerCards: ['Nova Consignação','Artigos em consignação','Ações','Ficha Revendedor'],
        treasuryCards: ['Novo Movimento','Filtros','Historico dos Movimentos'],
        kpiLabelTreso: ['Saldo atual','Entradas','Saidas'],
        tresoformlabel: ['Data','Movimento','Tipo','Montante','Descrições','de','a','O tipo contém'],
        tresotabletext: ['Data','Tipo','Descrição','Entradas','Saídas','Saldo'],
        tresobuttontext: ['Atualizar','Registar Movimento','Aplicar filtros'],
        dashtext: ['Dashboard de Despesas','De','Até','Categoria','Total de Despesas','Média','Por despesa','Máximo','Categoria','Hoje','Despesas do dia','Por categoria','Evolução diária'],
        histdeptext: ['Histórico de Despesas','Data','Categoria','Descrição','Montante'],
        ongletrevtext: ['Nova','Pagamento / Retorno','Histórico do Revendedor'],
        paiementlabeltext: ['Data','Fornecedor','Montante pago','Montante restante: ','Nota (opcional)'],
        enredepensetext: ['Data','Tipo','Descrição','Montante'],
        titreconsigntiontext: 'Registar um registo',
        revFormLabels : ['Data','Nome do revendedor','Revendedor','Data da ação','Ação','Revendedor','De','A'],
        revTableHeaders : ['ID','Data','Revendedor','Estado','Artigos','Total','Pagamento','Recibo'],
        revModeBtnTexts : ['Nova Consignação','Pagamento / Retorno','Histórico do Revendedor'],
        revSectionTitleTexts :  ['Revendedores','Registar Uma Consignação','Pagamento E Retorno','Histórico do Revendedor'],
        inventairetabletext: ['Designação','Fornecedor','Entradas','Saídas','Stock da Loja','Stock do Depósito','Total','Preço de Compra','Valor'],
        kpiInventairetext : ['Stock Total','Valor Total do Stock','Stock em Armazém','Valor do Stock em Armazém','Stock da Loja','Valor do Stock da Loja'],
        inventairetitretext : ['inventários']
      },
      fr: {
        dashLabels: ['Periode','De','A','Produit','Fournisseur'],
        dashOptions: ['Aujourd hui','Cette semaine','Ce mois','Personnalise'],
        kpiLabels: ['Ventes','Benefice','Depenses','Alertes Stock'],
        kpiSubProfit: 'Recette - Cout',
        kpiSubAlerts: 'produits en manque',
        dashCards: ['Top Produits','Moyens de paiement','Alertes de stock faible','Dernieres depenses'],
        payLabels: ['Cash','Express','Carte'],
        achatTabs: ['Nouvel Achat','Enregistrer Paiement','Resume Dettes'],
        histHeaders: ['Date','Produit','Client','Qte','P.Unit','Total','Paiement','N Recu'],
        settingsCards: ['Identite de la Boutique','Monnaie','Langue','Theme','Mode de stock','Personnalisation du recu','Securite'],
        resellerCards: ['Nouvelle Consignation','Articles en consignation','Actions','Fiche Revendeur'],
        treasuryCards: ['Nouveau Mouvement','Filtres','Historique des mouvements'],
        kpiLabelTreso: ['Solde actuel','entrées','sorties'],
        tresoformlabel: ['Date','Mouvement','Type','Montant','Description','de','a','Type contient'],
        tresotabletext: ['Date','Type','Description','Entrees','Sorties','Solde'],
        tresobuttontext: ['Actualiser','Enregistrer Mouvement','Appliquer les filtres'],
        dashtext: ['Dashboard Dépenses','De','À','Catégorie','Total Dépenses','Moyenne','Par dépense','Maximum','Catégorie','Aujourd hui','Dépenses du jour','Par catégorie','À charger...','Évolution journalière','À charger...'],
        histdeptext: ['Historique des Dépenses','Date','Catégorie','Description','Montant'],
        ongletrevtext: ['Nouvelle','Paiement / Retour','Historique Revendeur'],
        paiementlabeltext: ['Date','Fournisseur','Montant Paye','Montant restant : ','Note (optionel)'],
        enredepensetext: ['Date','Type','Description','Montant'],
        titreconsigntiontext: 'Enregistrer Une Consignation',
        revFormLabels: ['Date','Nom du revendeur','Revendeur',"Date de l'action",'Action','Revendeur','De','A'],
        revTableHeaders : ['ID','Date','Revendeur','Statut','Articles','Total','Paiement','Recu'],
        revModeBtnTexts : ['Nouvelle Consignation','Paiement / Retour','Historique Revendeur'],
        revSectionTitleTexts : ['Revendeurs','Enregistrer Une Consignation','Paiement Et Retour','Historique Revendeur'],
        inventairetabletext : ['Designation','Fournisseur','Entrees','Sorties','Stock boutique','Stock Magasin','total','Prix dachat','Valeur'],
        kpiInventairetext : ['Stock Total','Valeur Totale du Stock','Stock en Magasin','Valeur du Stock Magasin','Stock en Boutique','Valeur du Stock Boutique'],
        inventairetitretext : ['Inventaires']
      },
      en: {
        dashLabels: ['Period','From','To','Product','Supplier'],
        dashOptions: ['Today','This week','This month','Custom'],
        kpiLabels: ['Sales','Profit','Expenses','Stock Alerts'],
        kpiSubProfit: 'Revenue - Cost',
        kpiSubAlerts: 'missing products',
        dashCards: ['Top Products','Payment Methods','Low Stock Alerts','Latest Expenses'],
        payLabels: ['Cash','Express','Card'],
        achatTabs: ['New Purchase','Register Payment','Debt Summary'],
        histHeaders: ['Date','Product','Customer','Qty','Unit Price','Total','Payment','Receipt No.'],
        settingsCards: ['Shop Identity','Currency','Language','Theme','Stock Mode','Receipt Customization','Security'],
        resellerCards: ['New Consignment','Consignment items','Actions','Reseller File'],
        treasuryCards: ['New Movement','Filters','Movement History'],
        kpiLabelTreso: ['Current balance','Entries','Outings'],
        tresoformlabel: ['Date','Transaction','Type','Amount','Description','of','a','Type contains'],
        tresotabletext: ['Date','Type','Description','Income','Expenses','Balance'],
        tresobuttontext: ['Refresh','Record Movement','Apply Filters'],
        dashtext: ['Expenses Dashboard','From','To','Category','Total Expenses','Average','Per expense','Maximum','Category','Today','Today s expenses','By category','Loading...','Daily evolution','Loading...'],
        histdeptext: ['Expense History','Date','Category','Description','Amount'],
        ongletrevtext: ['New','Payment / Return','Reseller History'],
        paymentlabeltext: ['Date','Supplier','Amount Paid','Amount Remaining: ','Note (optional)'],
        enredepensetext: ['Date', 'Type', 'Description', 'Amount'],
        titreconsigntiontext: 'Save a Log',
        revFormLabels: ['Date','Reseller name','Reseller','Action date','Action','Reseller','From','To'],
        revTableHeaders : ['ID','Date','Reseller','Status','Items','Total','Payment','Receipt'],
        revModeBtnTexts : ['New Consignment','Payment / Return','Reseller History'],
        revSectionTitleTexts : ['Resellers','Register A Consignment','Payment And Return','Reseller History'],
        inventairetabletext: ['Designação','Fornecedor','Entradas','Saídas','Stock da Loja','Stock do Depósito','Total','Preço de Compra','Valor'],
        kpiInventairetext : ['Total Stock','Total Stock Value','Warehouse Stock','Warehouse Stock Value','Store Stock','Store Stock Value'],
        inventairetitretext : ['inventories']
      }
    }[lang] || {
      dashLabels: ['Periodo','De','Ate','Produto','Fornecedor'],
      dashOptions: ['Hoje','Esta semana','Este mes','Personalizado'],
      kpiLabels: ['Vendas','Lucro','Despesas','Alertas Stock'],
      kpiSubProfit: 'Receita - Custo',
      kpiSubAlerts: 'produtos em falta',
      dashCards: ['Top Produtos','Meios de Pagamento','Alertas de Stock Baixo','Ultimas Despesas'],
      payLabels: ['Cash','Express','Cartao'],
      achatTabs: ['Nova Compra','Registar Pagamento','Resumo de Dívidas'],
      histHeaders: ['Data','Produto','Cliente','Qtd','P.Unit','Total','Pagamento','N Recibo'],
      settingsCards: ['Identidade da Boutique','Moeda','Língua','Tema','Modo de Stock','Personalização do Recibo','Segurança'],
      resellerCards: ['Nova Consignação','Artigos em consignação','Ações','Ficha Revendedor'],
      treasuryCards: ['Novo Movimento','Filtros','Historico dos Movimentos'],
      kpiLabelTreso: ['Saldo atual','Entradas','Saidas'],
      tresoformlabel: ['Data','Movimento','Tipo','Montante','Descrições'],
      tresotabletext: ['Data','Tipo','Descrição','Entradas','Saídas','Saldo'],
      tresobuttontext: ['Atualizar','Registar Movimento','Aplicar filtros','de','a','O tipo contém'],
      dashtext: ['Dashboard de Despesas','De','Até','Categoria','Total de Despesas','Média','Por despesa','Máximo','Categoria','Hoje','Despesas do dia','Por categoria','A carregar...','Evolução diária','A carregar...'],
      histdeptext: ['Histórico de Despesas','Data','Categoria','Descrição','Montante'],
      ongletrevtext: ['Nova','Pagamento / Retorno','Histórico do Revendedor'],
      paiementlabeltext: ['Data','Fornecedor','Montante pago','Montante restante: ','Nota (opcional)'],
      enredepensetext: ['Data','Tipo','Descrição','Montante'],
      titreconsigntiontext: 'Registar um registo',
      revFormLabels : ['Data','Nome do revendedor','Revendedor','Data da ação','Ação','Revendedor','De','A'],
      revTableHeaders : ['ID','Data','Revendedor','Estado','Artigos','Total','Pagamento','Recibo'],
      revModeBtnTexts : ['Nova Consignação','Pagamento / Retorno','Histórico do Revendedor'],
      revSectionTitleTexts :  ['Revendedores','Registar Uma Consignação','Pagamento E Retorno','Histórico do Revendedor'],
      inventairetabletext: ['Designation','Supplier','Entries','Outflows','Shop Stock','Store Stock','Total','Purchase Price','Value'],
      kpiInventairetext : ['Stock Total','Valor Total do Stock','Stock em Armazém','Valor do Stock em Armazém','Stock da Loja','Valor do Stock da Loja'],
      inventairetitretext : ['inventários']
    };

    var inventairetable = document.querySelectorAll('#stock th');
    inventairetable.forEach(function(el, i) { if (ui.inventairetabletext[i]) el.textContent = ui.inventairetabletext[i]; });
    var kpiInventaire = document.querySelectorAll('#stock #kpi-inventaire #kpi-label');
    kpiInventaire.forEach(function(el, i) { if (ui.kpiInventairetext[i]) el.textContent = ui.kpiInventairetext[i]; });
    var cardTitle = document.querySelectorAll('#stock .card-title');
    cardTitle.forEach(function(el, i) { if (ui.inventairetitretext[i]) el.textContent = ui.inventairetitretext[i]; });

    var revSectionTitle = document.querySelectorAll('#page-revendeurs .section-title');
    revSectionTitle.forEach(function(el, i) { if (ui.revSectionTitleTexts[i]) el.textContent = ui.revSectionTitleTexts[i]; });
    var histdepense = document.querySelectorAll('#dep-panel-history .depense');
    histdepense.forEach(function(el, i) { if (ui.histdeptext[i]) el.textContent = ui.histdeptext[i]; });

    var revModeBtnText = document.querySelectorAll('#page-revendeurs .mode-btn');
    revModeBtnText.forEach(function(el, i) { if (ui.revModeBtnTexts[i]) el.textContent = ui.revModeBtnTexts[i]; });
    var revModeBtnText = document.querySelectorAll('#page-revendeurs .mode-btn');
    revModeBtnText.forEach(function(el, i) { if (ui.revModeBtnTexts[i]) el.textContent = ui.revModeBtnTexts[i]; });
    var revFormLabel = document.querySelectorAll('#page-revendeurs .form-label');
    revFormLabel.forEach(function(el, i) { if (ui.revFormLabels[i]) el.textContent = ui.revFormLabels[i]; });
    var revTableHeader = document.querySelectorAll('#page-revendeurs th');
    revTableHeader.forEach(function(el, i) { if (ui.revTableHeaders[i]) el.textContent = ui.revTableHeaders[i]; });
    if (document.getElementById('rev-name')) document.getElementById('rev-name').placeholder = (lang === 'fr') ? 'Entre le nom du revendeur' : (lang === 'en' ? 'Enter the reseller name' : 'Insere o nome do revendedor');
    if (document.getElementById('rev-search')) document.getElementById('rev-search').placeholder = (lang === 'fr') ? 'Rechercher un produit...' : (lang === 'en' ? 'Search product...' : 'Pesquisar produto...');
    if (document.getElementById('rev-history-name')) document.getElementById('rev-history-name').placeholder = (lang === 'fr') ? 'Nom du revendeur' : (lang === 'en' ? 'Reseller name' : 'Nome do revendedor');
    var revActionType = document.getElementById('rev-action-type');
    if (revActionType) {
      if (revActionType.options[0]) {
        revActionType.options[0].text = lang === 'fr'
          ? 'Paiement'
          : (lang === 'en' ? 'Payment' : 'Pagamento');
      }

      if (revActionType.options[1]) {
        revActionType.options[1].text = lang === 'fr'
          ? 'Retour marchandise'
          : (lang === 'en' ? 'Return goods' : 'Retorno de mercadoria');
      }
    }

    var revAddPayBtn = document.querySelector('#rev-payment-panel button[onclick="addRevPayLine()"]');
    if (revAddPayBtn) {
      revAddPayBtn.textContent = lang === 'fr'
        ? '+ Ajouter moyen de paiement'
        : (lang === 'en' ? '+ Add payment method' : '+ Adicionar meio de pagamento');
    }

    var revTotalPayLabel = document.querySelector('#rev-payment-total');
    if (revTotalPayLabel && revTotalPayLabel.previousElementSibling) {
      revTotalPayLabel.previousElementSibling.textContent = lang === 'fr'
        ? 'Total a payer'
        : (lang === 'en' ? 'Total to pay' : 'Total a pagar');
    }
    var revManageName = document.getElementById('rev-manage-name');

    if (revManageName && revManageName.options[0]) {
      revManageName.options[0].text = lang === 'fr'
        ? 'Choisir un revendeur'
        : (lang === 'en' ? 'Choose a reseller' : 'Escolher um revendedor');
    }

    var histdepense = document.querySelectorAll('.section-title .revendeur button');
    histdepense.forEach(function(el, i) { if (ui.histdeptext[i]) el.textContent = ui.histdeptext[i]; });
    var enredepense = document.querySelectorAll('#dep-panel-new .form-label');
    enredepense.forEach(function(el, i) { if (ui.enredepensetext[i]) el.textContent = ui.enredepensetext[i]; });
    if (document.getElementById('dep-desc')) document.getElementById('dep-desc').placeholder = (lang === 'fr') ? 'Description de la depense...' : (lang === 'en' ? 'Description of the expense...' : 'Descrição da despesa...');

    var paiementlabel = document.querySelectorAll('#achat-panel-pagamento .form-label');
    paiementlabel.forEach(function(el, i) { if (ui.paiementlabeltext[i]) el.textContent = ui.paiementlabeltext[i]; });

    var dashFormLabels = document.querySelectorAll('#page-dashboard .form-label');
    dashFormLabels.forEach(function(el, i) { if (ui.dashLabels[i]) el.textContent = ui.dashLabels[i]; });
    //treso
    var tresobutton = document.querySelectorAll('#page-tresorerie button');
    tresobutton.forEach(function(el, i) { if (ui.tresobuttontext[i]) el.textContent = ui.tresobuttontext[i]; });
    var tresokpilabels = document.querySelectorAll('#page-tresorerie .kpi-label');
    tresokpilabels.forEach(function(el, i) { if (ui.kpiLabelTreso[i]) el.textContent = ui.kpiLabelTreso[i]; });
    var tresoformlabels = document.querySelectorAll('#page-tresorerie .form-label');
    tresoformlabels.forEach(function(el, i) { if (ui.tresoformlabel[i]) el.textContent = ui.tresoformlabel[i]; });
    var tresotable = document.querySelectorAll('#page-tresorerie .data-table th');
    tresotable.forEach(function(el, i) { if (ui.tresotabletext[i]) el.textContent = ui.tresotabletext[i]; });
    if (document.getElementById('tre-desc')) document.getElementById('tre-desc').placeholder = (lang === 'fr') ? 'Description du mouvement...' : (lang === 'en' ? 'Description of the movement...' : 'Descrição do movimento...');
    if (document.getElementById('tre-filter-type')) document.getElementById('tre-filter-type').placeholder = (lang === 'fr') ? 'Ex: Vente, Depense, Achat...' : (lang === 'en' ? 'Ex: Sales, Expenses, Purchases...' : 'Ex: Venda, Despesa, Compra...');

    var periodSelect = document.getElementById('df-period');
    if (periodSelect) ui.dashOptions.forEach(function(txt, i) { if (periodSelect.options[i]) periodSelect.options[i].text = txt; });

    if (document.getElementById('df-prod')) document.getElementById('df-prod').placeholder = (lang === 'fr') ? 'Tous' : (lang === 'en' ? 'All' : 'Todos');
    if (document.getElementById('df-forn')) document.getElementById('df-forn').placeholder = (lang === 'fr') ? 'Tous' : (lang === 'en' ? 'All' : 'Todos');

    var cfgLang = document.getElementById('cfg-language');
    if (cfgLang) {
      if (cfgLang.options[0]) cfgLang.options[0].text = 'Português';
      if (cfgLang.options[1]) cfgLang.options[1].text = 'Français';
      if (cfgLang.options[2]) cfgLang.options[2].text = 'English';
    }

    var dashBtn = document.getElementById('dashApplyBtn');
    if (dashBtn) dashBtn.textContent = lang === 'en' ? 'Apply' : (lang === 'fr' ? 'Appliquer' : 'Aplicar');
    var dashPrintBtn = document.getElementById('dashPrintBtn');
    if (dashPrintBtn) dashPrintBtn.textContent = lang === 'en' ? 'Print' : (lang === 'fr' ? 'Imprimer' : 'Imprimir');
    var kpiLabels = document.querySelectorAll('#page-dashboard .kpi-label');
    kpiLabels.forEach(function(el, i) { if (ui.kpiLabels[i]) el.textContent = ui.kpiLabels[i]; });
    var kpiSubs = document.querySelectorAll('#page-dashboard .kpi-sub');
    if (kpiSubs[1]) kpiSubs[1].textContent = ui.kpiSubProfit;
    if (kpiSubs[3]) kpiSubs[3].textContent = ui.kpiSubAlerts;
    var dashCards = document.querySelectorAll('#page-dashboard .card-title');
    dashCards.forEach(function(el, i) { if (ui.dashCards[i]) el.textContent = ui.dashCards[i]; });
    var payLabels = document.querySelectorAll('#pay-bars .pay-lbl');
    payLabels.forEach(function(el, i) { if (ui.payLabels[i]) el.textContent = ui.payLabels[i]; });
    translateMainDashboard();

    if (document.getElementById('searchInput')) document.getElementById('searchInput').placeholder = getText('search_product');
    if (document.getElementById('clientInput')) document.getElementById('clientInput').placeholder = getText('client_placeholder');
    if (document.getElementById('rev-search')) document.getElementById('rev-search').placeholder = getText('rev_search');
    if (document.getElementById('rev-name')) document.getElementById('rev-name').placeholder = getText('rev_name');
    document.querySelectorAll('[id^="rev-price-"]').forEach(function(input) { input.placeholder = getText('rev_price_placeholder'); });
    document.querySelectorAll('.ci-price-input').forEach(function(input) {
      if ((input.id || '').indexOf('rev-price-') !== 0) input.placeholder = getText('sale_price_placeholder');
    });

    var confirmBtn = document.getElementById('confirmBtn');
    if (confirmBtn) confirmBtn.textContent = lang === 'en' ? 'Payment' : (lang === 'fr' ? 'Paiement' : 'pagamento');
    var clearBtn = document.querySelector('.cart-clear');
    if (clearBtn) clearBtn.textContent = getText('clear_cart');
    var vendaLabel = document.querySelector('#page-venda .form-label');
    if (vendaLabel) vendaLabel.textContent = lang === 'en' ? 'Sale date' : (lang === 'fr' ? 'Date de vente' : 'Data da venda');
    var saleAddPay = document.querySelector('#page-venda button[onclick="addPaymentLine()"]');
    if (saleAddPay) saleAddPay.textContent = getText('add_payment_method');
    var saleProgress = document.getElementById('progressLabel');
    if (saleProgress) saleProgress.textContent = getText('register_sale');
    var paymentConfirmBtn = document.getElementById('paymentConfirmBtn');
    if (paymentConfirmBtn) paymentConfirmBtn.textContent = getText('confirm_sale');
    var paymentProgress = document.getElementById('paymentProgressLabel');
    if (paymentProgress) paymentProgress.textContent = getText('register_sale');
    var paymentModalTitle = document.querySelector('.payment-modal-title');
    if (paymentModalTitle) paymentModalTitle.textContent = getText('payment');
    var paymentModalAdd = document.querySelector('.payment-modal-add');
    if (paymentModalAdd) paymentModalAdd.textContent = getText('add_payment_method');

    ['achat-tab-novo','achat-tab-pagamento','achat-tab-resumo'].forEach(function(id, i) {
      var el = document.getElementById(id);
      if (el) el.textContent = ui.achatTabs[i];
    });

    var histHeaders = document.querySelectorAll('#page-historique th');
    histHeaders.forEach(function(el, i) { if (ui.histHeaders[i]) el.textContent = ui.histHeaders[i]; });
    var histEmpty = document.querySelector('#histBody .empty');
    if (histEmpty) histEmpty.textContent = lang === 'en' ? 'Click Filter to load' : (lang === 'fr' ? 'Clique sur Filtrer pour charger' : 'Clica em Filtrar para carregar');

    syncPageTitles();

    var settingsCards = document.querySelectorAll('#page-settings .card:not(.user-settings-card):not(.team-settings-card) > .card-title');
    settingsCards.forEach(function(el, i) { if (ui.settingsCards[i]) el.textContent = ui.settingsCards[i]; });
    var themeLight = document.getElementById('cfg-theme-light');
    if (themeLight) themeLight.textContent = getText('light_theme');
    var themeDark = document.getElementById('cfg-theme-dark');
    if (themeDark) themeDark.textContent = getText('dark_theme');
    var stockBoutique = document.querySelector('#cfg-stock-boutique div div:first-child');
    if (stockBoutique) stockBoutique.textContent = getText('stock_shop_only');
    var stockBoutiqueDesc = document.querySelector('#cfg-stock-boutique div div:nth-child(2)');
    if (stockBoutiqueDesc) stockBoutiqueDesc.textContent = getText('stock_shop_only_desc');
    var stockArmazem = document.querySelector('#cfg-stock-armazem div div:first-child');
    if (stockArmazem) stockArmazem.textContent = getText('stock_shop_warehouse');
    var stockArmazemDesc = document.querySelector('#cfg-stock-armazem div div:nth-child(2)');
    if (stockArmazemDesc) stockArmazemDesc.textContent = getText('stock_shop_warehouse_desc');
    var settingsLabels = document.querySelectorAll('#page-settings .form-label');
    var settingsLabelTexts = [
      lang === 'en' ? 'Name' : (lang === 'fr' ? 'Nom' : 'Nome'),
      'Slogan',
      lang === 'en' ? 'Address / Location' : (lang === 'fr' ? 'Adresse / Localisation' : 'Endereço / Localização'),
      lang === 'en' ? 'Phone' : (lang === 'fr' ? 'Téléphone' : 'Telefone'),
      lang === 'en' ? 'Receipt footer message' : (lang === 'fr' ? 'Message de pied du reçu' : 'Mensagem de rodapé do recibo'),
      lang === 'en' ? 'Text font' : (lang === 'fr' ? 'Police du texte' : 'Fonte do texto'),
      getText('receipt_logo_image'),
      getText('receipt_logo_size'),
      getText('receipt_show')
    ];
    settingsLabels.forEach(function(el, i) { if (settingsLabelTexts[i]) el.textContent = settingsLabelTexts[i]; });
    var clearLogoBtn = document.querySelector('#page-settings button[onclick="clearReceiptLogo()"]');
    if (clearLogoBtn) clearLogoBtn.textContent = getText('receipt_logo_remove');
    var editModeTitle = document.querySelector('#editModeBtn') && document.querySelector('#editModeBtn').parentNode.querySelector('div div div:first-child');
    if (editModeTitle) editModeTitle.textContent = getText('direct_edit_mode');
    var editModeDesc = document.querySelector('#editModeBtn') && document.querySelector('#editModeBtn').parentNode.querySelector('div div div:nth-child(2)');
    if (editModeDesc) editModeDesc.textContent = getText('direct_edit_desc');
    var saveSettingsBtn = document.querySelector('[onclick="saveAllSettings()"]');
    if (saveSettingsBtn) saveSettingsBtn.textContent = getText('save_settings');
    var productProfileBtn = document.getElementById('product-profile-save-btn');
    if (productProfileBtn && !productProfileBtn.disabled) productProfileBtn.textContent = getText('save_product_profile');
    var resetSetupBtn = document.querySelector('[onclick="showSetup()"]');
    if (resetSetupBtn) resetSetupBtn.textContent = getText('reset_setup');
    var editModeBtn = document.getElementById('editModeBtn');
    if (editModeBtn && !editModeBtn.disabled && editModeBtn.textContent.indexOf('ACT') === -1) editModeBtn.textContent = getText('edit_mode_button');

    var revSaveBtn = document.getElementById('revSaveBtn');
    if (revSaveBtn) revSaveBtn.textContent = getText('rev_create');
    var revCards = document.querySelectorAll('#page-revendeurs .card-title');
    revCards.forEach(function(el, i) { if (ui.resellerCards[i]) el.textContent = ui.resellerCards[i]; });
    var pageRev = document.getElementById('page-revendeurs');
    if (pageRev) {
      var labels = pageRev.querySelectorAll('.form-label');
      if (labels[1]) labels[1].textContent = getText('rev_name');
      if (labels[2]) labels[2].textContent = getText('rev_open');
      var actions = pageRev.querySelectorAll('.form-submit');
      if (actions[0]) actions[0].textContent = getText('rev_create');
      if (actions[1]) actions[1].textContent = getText('rev_pay');
      if (actions[2]) actions[2].textContent = getText('rev_return');
    }

    //traduction tresorie
    var treasuryCards = document.querySelectorAll('#page-tresorerie .card-title');
    treasuryCards.forEach(function(el, i) { if (ui.treasuryCards[i]) el.textContent = ui.treasuryCards[i]; });

    var clientTabFiche = document.getElementById('client-tab-pagamento');
    if (clientTabFiche) clientTabFiche.textContent = getText('client_file_tab');
    var clientTabPayment = document.getElementById('client-tab-fiche');
    if (clientTabPayment) clientTabPayment.textContent = getText('client_payment_tab');
    var clientSearch = document.getElementById('cli-search');
    if (clientSearch) clientSearch.placeholder = getText('search_client_placeholder');
    var clientSearchBtn = document.querySelector('#client-panel-fiche .filter-btn');
    if (clientSearchBtn) clientSearchBtn.textContent = getText('search_button');
    var clientInitialEmpty = document.querySelector('#cli-result .empty');
    if (clientInitialEmpty) clientInitialEmpty.textContent = getText('client_search_empty');
    setPageTitle('client-panel-pagamento', getText('client_payment_title'));
    var clientPayLabels = document.querySelectorAll('#client-panel-pagamento .form-label');
    if (clientPayLabels[2]) clientPayLabels[2].textContent = getText('amount_paid');

    var depNew = document.getElementById('dep-tab-new');
    if (depNew) depNew.textContent = getText('new_expense_tab');
    var depDash = document.getElementById('dep-tab-dashboard');
    if (depDash) depDash.textContent = getText('expense_dashboard_tab');
    var depHist = document.getElementById('dep-tab-history');
    if (depHist) depHist.textContent = getText('expense_history_tab');
    var depNewCat = document.getElementById('dep-new-category');
    if (depNewCat) depNewCat.placeholder = getText('expense_category_new');
    var depAddCat = document.querySelector('button[onclick="addDepenseCategory()"]');
    if (depAddCat) depAddCat.textContent = getText('add_button');
    var depBtn = document.getElementById('depBtn');
    if (depBtn && !depBtn.disabled) depBtn.textContent = getText('register_expense_button');

    var receiptLines = [
      { id: 'r-num-line', label: lang === 'en' ? 'Receipt No.' : (lang === 'fr' ? 'N Recu' : 'N Recibo') },
      { id: 'r-date-line', label: lang === 'en' ? 'Date' : 'Data' },
      { id: 'r-client-line', label: lang === 'en' ? 'Customer' : (lang === 'fr' ? 'Client' : 'Cliente') },
      { id: 'r-pay-line', label: lang === 'en' ? 'Payment' : (lang === 'fr' ? 'Paiement' : 'Pagamento') }
    ];
    receiptLines.forEach(function(item) {
      var el = document.getElementById(item.id);
      if (el && el.childNodes[0]) el.childNodes[0].textContent = item.label + ': ';
    });

    var cartEmpty = document.querySelector('#cartBody .empty');
    if (cartEmpty) cartEmpty.textContent = getText('cart_empty');
    var prodEmpty = document.querySelector('#prodGrid .empty');
    if (prodEmpty && !productsLoading) prodEmpty.textContent = getText('no_products');
    var topEmpty = document.querySelector('#top-list .empty');
    if (topEmpty) topEmpty.textContent = getText('no_data');
    var depEmpty = document.querySelector('#depenses-list .empty');
    if (depEmpty) depEmpty.textContent = getText('no_expenses');
    var revProdEmpty = document.querySelector('#revProdGrid .empty');
    if (revProdEmpty) revProdEmpty.textContent = getText('no_products');
    var revCartEmpty = document.querySelector('#revCartBody .empty');
    if (revCartEmpty) revCartEmpty.textContent = getText('add_products');
    var revDetailEmpty = document.querySelector('#rev-detail .empty');
    if (revDetailEmpty) revDetailEmpty.textContent = getText('loading');
    var resumoEmpty = document.querySelector('#resumo-dettes .empty');
    if (resumoEmpty && resumoEmpty.textContent.indexOf('dettes') >= 0) resumoEmpty.textContent = getText('no_supplier_debts');
    var tresoEmpty = document.querySelector('#tresoBody .empty');
    if (tresoEmpty) tresoEmpty.textContent = getText('loading');
    var clientEmpty = document.querySelector('#cli-result .empty');
    if (clientEmpty && clientEmpty.textContent.indexOf('cliente') >= 0) clientEmpty.textContent = getText('loading');
    var payStatus = document.getElementById('paymentModalStatus');
    if (payStatus) {
      var total = getCartTotal();
      var paid = paymentLines.reduce(function(sum, p) { return sum + (parseFloat(p.montant) || 0); }, 0);
      payStatus.textContent = tr('payment_status', { paid: fmt(paid), total: fmt(total) });
    }
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('applyLanguage failed', e);
    }
  } finally {
    window._applyingLanguage = false;
    if (window.AzulI18n && typeof window.AzulI18n.bindLanguageSelect === "function") {
      window.AzulI18n.bindLanguageSelect();
    }
    if (window.AzulI18n && typeof window.AzulI18n.scheduleStaticDictionary === "function") {
      window.AzulI18n.scheduleStaticDictionary(document, lang);
    }
  }
}
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////Fin de la fonction de la traduction /////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Language is applied only by explicit config/load calls to avoid UI loops.
function saveAllSettings() {
  config.name     = document.getElementById('cfg-name').value.trim() || config.name;
  config.slogan   = document.getElementById('cfg-slogan').value.trim() || config.slogan;
  config.currency = document.getElementById('cfg-currency').value;
  config.language = (document.getElementById('cfg-language') || {}).value || config.language || 'pt';
  // Champs du recibo
  config.address     = document.getElementById('cfg-address').value.trim();
  config.phone       = document.getElementById('cfg-phone').value.trim();
  config.footer      = document.getElementById('cfg-footer').value.trim() || 'Obrigado pela sua preferencia!';
  config.receiptFont = (document.getElementById('cfg-font') || {}).value || config.receiptFont || 'DM Sans';
  config.receiptFontSize = (document.getElementById('cfg-font-size') || {}).value || config.receiptFontSize || '10';
  config.receiptLogo = (document.getElementById('cfg-logo-url') || {}).value || config.receiptLogo || '';
  config.receiptLogoSize = (document.getElementById('cfg-logo-size') || {}).value || config.receiptLogoSize || '16';
  config.showDate    = document.getElementById('cfg-show-date').checked;
  config.showClient  = document.getElementById('cfg-show-client').checked;
  config.showPayment = document.getElementById('cfg-show-payment').checked;
  config.showRecibo  = document.getElementById('cfg-show-recibo').checked;
  config.showAddress = document.getElementById('cfg-show-address').checked;
  var modeRadio   = document.querySelector('input[name="cfgStockMode"]:checked');
  if (modeRadio) {
    config.stockMode = modeRadio.value;
    config.armazem   = modeRadio.value === 'armazem';
  }
  config.color  = selectedSetupColor || config.color || '#0b3d91';
  config.color2 = selectedSetupColor2 || config.color2 || '#071e4f';
  config.theme  = selectedSetupTheme || config.theme || 'light';
  saveConfig();
  applyConfig();
  toast(getText('settings_saved'), 'success');
}

function saveSettings() {
  config.armazem = document.getElementById('toggleArmazem').checked;
  saveConfig();
  applyConfig();
}

function saveConfig() {
  try { localStorage.setItem('pos_config', JSON.stringify(config)); } catch(e) {}
}

function normalizeHexColor(value, fallback) {
  var color = String(value || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    color = '#' + color.charAt(1) + color.charAt(1) + color.charAt(2) + color.charAt(2) + color.charAt(3) + color.charAt(3);
  }
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function hexToRgbColor(hex) {
  hex = normalizeHexColor(hex, '#0b3d91').replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function rgbToHexColor(rgb) {
  function part(n) {
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  }
  return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
}

function mixHexColor(hex, target, amount) {
  var a = hexToRgbColor(hex);
  var b = hexToRgbColor(target);
  return rgbToHexColor({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount
  });
}

function colorLuminance(hex) {
  var rgb = hexToRgbColor(hex);
  function channel(v) {
    v = v / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(c1, c2) {
  var l1 = colorLuminance(c1);
  var l2 = colorLuminance(c2);
  var lighter = Math.max(l1, l2);
  var darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableAccentColor(color, background) {
  color = normalizeHexColor(color, '#0b3d91');
  background = normalizeHexColor(background, '#ffffff');
  if (contrastRatio(color, background) >= 4.5) return color;
  var darkened = color;
  var lightened = color;
  for (var i = 1; i <= 12; i++) {
    darkened = mixHexColor(color, '#000000', i * 0.08);
    if (contrastRatio(darkened, background) >= 4.5) return darkened;
    lightened = mixHexColor(color, '#ffffff', i * 0.08);
    if (contrastRatio(lightened, background) >= 4.5) return lightened;
  }
  return contrastRatio(darkened, background) >= contrastRatio(lightened, background) ? darkened : lightened;
}

function textOnColor(color) {
  color = normalizeHexColor(color, '#0b3d91');
  return contrastRatio(color, '#ffffff') >= contrastRatio(color, '#1a1a1a') ? '#ffffff' : '#1a1a1a';
}

function applyConfig() {
  // Apply colors
  var root = document.documentElement;
  selectedSetupColor = config.color || selectedSetupColor || '#0b3d91';
  selectedSetupColor2 = config.color2 || selectedSetupColor2 || '#071e4f';
  selectedSetupTheme = config.theme || selectedSetupTheme || 'light';
  var themeBackground = selectedSetupTheme === 'dark' ? '#0d0d0d' : '#ffffff';
  var readableColor = readableAccentColor(selectedSetupColor, themeBackground);
  var readableColor2 = readableAccentColor(selectedSetupColor2, themeBackground);
  root.style.setProperty('--blue', readableColor);
  root.style.setProperty('--blue2', readableColor2);
  root.style.setProperty('--accent-text', textOnColor(readableColor));

  // Apply theme
  if (selectedSetupTheme === 'dark') {
    root.style.setProperty('--bg', '#0d0d0d');
    root.style.setProperty('--surface', '#161616');
    root.style.setProperty('--surface2', '#1f1f1f');
    root.style.setProperty('--border', '#2a2a2a');
    root.style.setProperty('--text', '#f0ece4');
    root.style.setProperty('--muted', '#7a7670');
  } else {
    root.style.setProperty('--bg', '#f5f5f0');
    root.style.setProperty('--surface', '#ffffff');
    root.style.setProperty('--surface2', '#f0ede6');
    root.style.setProperty('--border', '#e0dbd0');
    root.style.setProperty('--text', '#1a1a1a');
    root.style.setProperty('--muted', '#9a9590');
  }

  // Apply name
   var logoEl = document.querySelector('.logo');
  if (logoEl) {
    logoEl.textContent = 'Azul';
  }

  // Update receipt
  var rlogo = document.querySelector('.r-logo');
  var rlogoImg = document.getElementById('r-logo-img');
  if (rlogo) rlogo.textContent = config.name || 'Azul Gestao';
  if (rlogoImg) {
    var hasLogo = !!(config.receiptLogo || '').trim();
    rlogoImg.src = hasLogo ? config.receiptLogo : '';
    rlogoImg.style.display = hasLogo ? 'block' : 'none';
    rlogoImg.style.width = (parseInt(config.receiptLogoSize || '16', 10) * 4) + 'px';
  }
  if (rlogo) {
    rlogo.style.display = 'block';
  }
  var rslogan = document.querySelector('.r-slogan');
  if (rslogan) rslogan.textContent = config.slogan || '';
  var rthanks = document.querySelector('.r-thanks');
  if (rthanks) rthanks.textContent = getText('receipt_thanks') + (config.name || 'Azul Gestao') + '!';
  var receiptBox = document.getElementById('receiptBox');
  if (receiptBox) receiptBox.style.fontFamily = '"' + (config.receiptFont || 'DM Sans') + '", sans-serif';
  if (rlogo) {
    rlogo.style.fontFamily = '"' + (config.receiptFont || 'DM Sans') + '", sans-serif';
    rlogo.style.fontSize = (config.receiptLogoSize || '16') + 'pt';
  }
  if (rslogan) rslogan.style.fontSize = Math.max(parseInt(config.receiptFontSize || '10', 10) - 1, 8) + 'pt';
  document.querySelectorAll('.r-meta').forEach(function(el) {
    el.style.fontSize = Math.max(parseInt(config.receiptFontSize || '10', 10), 9) + 'pt';
  });
  document.querySelectorAll('.r-table').forEach(function(el) {
    el.style.fontSize = Math.max(parseInt(config.receiptFontSize || '10', 10), 9) + 'pt';
  });
  document.querySelectorAll('.r-thanks').forEach(function(el) {
    el.style.fontSize = Math.max(parseInt(config.receiptFontSize || '10', 10) - 1, 8) + 'pt';
  });
  document.querySelectorAll('.r-total').forEach(function(el) {
    el.style.fontSize = Math.max(parseInt(config.receiptFontSize || '10', 10) + 4, 13) + 'pt';
  });

  // Update currency in fmt function
  window._currency = config.currency || 'Kz';

  // Sync settings page fields
  var cfgName = document.getElementById('cfg-name');
  if (cfgName) cfgName.value = config.name || '';
  var cfgSlogan = document.getElementById('cfg-slogan');
  if (cfgSlogan) cfgSlogan.value = config.slogan || '';
  var cfgCurr = document.getElementById('cfg-currency');
  if (cfgCurr) cfgCurr.value = config.currency || 'Kz';
  var cfgLanguage = document.getElementById('cfg-language');
  if (cfgLanguage) cfgLanguage.value = config.language || 'pt';
  applyLanguage();
  // Sync champs recu
  var cfgAddr = document.getElementById('cfg-address');
  if (cfgAddr) cfgAddr.value = config.address || '';
  var cfgPhone = document.getElementById('cfg-phone');
  if (cfgPhone) cfgPhone.value = config.phone || '';
  var cfgFooter = document.getElementById('cfg-footer');
  if (cfgFooter) cfgFooter.value = config.footer || '';
  var cfgFont = document.getElementById('cfg-font');
  if (cfgFont) cfgFont.value = config.receiptFont || 'DM Sans';
  var cfgFontSize = document.getElementById('cfg-font-size');
  if (cfgFontSize) cfgFontSize.value = config.receiptFontSize || '10';
  var cfgLogoUrl = document.getElementById('cfg-logo-url');
  if (cfgLogoUrl) cfgLogoUrl.value = config.receiptLogo || '';
  var cfgLogoSize = document.getElementById('cfg-logo-size');
  if (cfgLogoSize) cfgLogoSize.value = config.receiptLogoSize || '16';
  // Sync cases a cocher
  var sd = document.getElementById('cfg-show-date');
  if (sd) sd.checked = config.showDate !== false;
  var sc = document.getElementById('cfg-show-client');
  if (sc) sc.checked = config.showClient !== false;
  var sp = document.getElementById('cfg-show-payment');
  if (sp) sp.checked = config.showPayment !== false;
  var sr = document.getElementById('cfg-show-recibo');
  if (sr) sr.checked = config.showRecibo !== false;
  // Sync champs recibo
  var cfgAddr = document.getElementById('cfg-address');
  if (cfgAddr) cfgAddr.value = config.address || '';
  var cfgPhone = document.getElementById('cfg-phone');
  if (cfgPhone) cfgPhone.value = config.phone || '';
  var cfgFooter = document.getElementById('cfg-footer');
  if (cfgFooter) cfgFooter.value = config.footer || '';
  var showFields = ['date','client','payment','recibo','address'];
  showFields.forEach(function(f) {
    var el = document.getElementById('cfg-show-' + f);
    var key = 'show' + f.charAt(0).toUpperCase() + f.slice(1);
    if (el) el.checked = config[key] !== false;
  });

  // Mark active color
  document.querySelectorAll('.color-opt').forEach(function(o) {
    o.classList.toggle('active', o.getAttribute('data-color') === selectedSetupColor);
  });

  // Mark active theme buttons
  document.querySelectorAll('[id^="theme-"],[id^="cfg-theme-"]').forEach(function(btn) {
    var isActive = btn.id === 'theme-' + selectedSetupTheme || btn.id === 'cfg-theme-' + selectedSetupTheme;
    btn.classList.toggle('active', isActive);
    btn.style.borderColor = isActive ? 'var(--blue)' : '';
    btn.style.color = isActive ? 'var(--blue)' : '';
    btn.style.background = isActive ? 'rgba(201,168,76,0.1)' : '';
  });

  // Sync stock mode radios
  var modeVal = config.stockMode || (config.armazem ? 'armazem' : 'boutique');
  var radios = document.querySelectorAll('input[name="cfgStockMode"]');
  radios.forEach(function(r) { r.checked = r.value === modeVal; });
  var b = document.getElementById('cfg-stock-boutique');
  var a = document.getElementById('cfg-stock-armazem');
  if (b) b.style.borderColor = modeVal === 'boutique' ? 'var(--blue)' : 'var(--border)';
  if (a) a.style.borderColor = modeVal === 'armazem'  ? 'var(--blue)' : 'var(--border)';
  // Armazem toggle (hidden, kept for compatibility)
  var toggle = document.getElementById('toggleArmazem');
  if (toggle) toggle.checked = config.armazem;

  // Afficher/cacher l'onglet Transferencia selon le mode de stock
  // En mode boutique uniquement -> pas besoin de transferts
  document.querySelectorAll('.tab').forEach(function(t) {
    if (t.textContent.indexOf('Transferencia') >= 0) {
      t.style.display = (config.armazem || config.stockMode === 'armazem') ? 'inline-block' : 'none';
    }
  });
}

// ===== TRANSFERENCIA MODO TOGGLE =====
function switchMode(mode, btn) {
  document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('transferSingle').style.display = mode === 'single' ? 'block' : 'none';
  document.getElementById('transferTudo').style.display = mode === 'tudo' ? 'block' : 'none';
   document.getElementById('stock').style.display = mode === 'stock' ? 'block' : 'none';

  if (mode === 'stock') {
    loadProducts(true);
  }
}

var stockArmazem = [];

async function carregarStockArmazem() {
  var el = document.getElementById("tudo-preview");
  var btn = document.getElementById("btnTudoBoutique");

  if (!el) return;

  el.innerHTML = '<div class="empty">A carregar stock...</div>';

  try {
    stockArmazem = await getStockArmazemFromSupabase();

    if (!stockArmazem.length) {
      el.innerHTML = '<div class="empty">Armazem vazio - nada a transferir</div>';
      if (btn) btn.disabled = true;
      return;
    }

    var html = '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">' +
      stockArmazem.length + ' produtos a transferir</div>';

    stockArmazem.forEach(function(p) {
      html += '<div class="tudo-item"><span class="ti-name">' +
        escapeDepenseHtml(p.name || "") +
        '</span><span class="ti-qty">' +
        p.qty +
        ' un</span></div>';
    });

    el.innerHTML = html;
    if (btn) btn.disabled = false;

  } catch (e) {
    console.error("Erro stock armazem:", e);
    el.innerHTML = '<div class="empty">Erro ao carregar stock</div>';
    toast("Erro stock armazem: " + (e.message || e), "error");
  }
}

async function transferirTudoBoutique() {
  var btn = document.getElementById("btnTudoBoutique");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A transferir...";
  }

  try {
    var count = await transferAllProductsToShop();

    stockArmazem = [];
    document.getElementById("tudo-preview").innerHTML =
      '<div class="empty">Transferencia concluida! Todo o stock foi enviado para Boutique.</div>';

    toast(count + " produtos transferidos para Boutique!", "success");

    await loadProducts(true);

  } catch (e) {
    console.error("Erro transferencia total:", e);
    toast("Erro ao transferir tudo: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Transferir Tudo";
    }
  }
}


// ===== EDIT MODE =====
var editModeInterval = null;
var editModeSeconds  = 0;

function activarEdicao() {
  var btn   = document.getElementById('editModeBtn');
  var timer = document.getElementById('editModeTimer');

  btn.disabled = true;
  btn.textContent = 'A activar...';
  btn.style.opacity = '0.6';

  gsCall('activarModoEdicaoPOS', {}, function(result) {
    if (!result || !result.success) {
      toast('Erro ao activar modo edicao', 'error');
      btn.disabled = false;
      btn.textContent = 'Activar Modo Edicao (1 min)';
      btn.style.opacity = '1';
      return;
    }

    // Mostrar temporizador a fazer contagem regressiva
    editModeSeconds = 60;
    timer.style.display = 'block';
    btn.textContent = 'Modo Edicao ACTIVO';
    btn.style.background = 'rgba(224,92,92,0.1)';
    btn.style.borderColor = 'var(--red)';
    btn.style.color = 'var(--red)';

    toast('Modo edicao activo por 1 minuto!', 'success');

    if (editModeInterval) clearInterval(editModeInterval);
    editModeInterval = setInterval(function() {
      editModeSeconds--;
      timer.textContent = 'Bloqueia em ' + editModeSeconds + 's...';

      if (editModeSeconds <= 0) {
        clearInterval(editModeInterval);
        timer.style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'Activar Modo Edicao (1 min)';
        btn.style.background = 'var(--surface2)';
        btn.style.borderColor = 'var(--border)';
        btn.style.color = 'var(--text)';
        btn.style.opacity = '1';
        toast('Feuilles bloqueadas novamente.', 'success');
      }
    }, 1000);
  });
}

// ===== DEPENSES =====
function getStoredDepenseCategories() {
  var defaults = ['Loyer', 'Electricite', 'Transport', 'Salaire', 'Autre'];
  try {
    var raw = localStorage.getItem('depenseCategories');
    if (!raw) return defaults.slice();
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return defaults.slice();
    var seen = {};
    return parsed.map(function(item) {
      return String(item || '').trim();
    }).filter(function(item) {
      if (!item) return false;
      var key = item.toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  } catch (e) {
    return defaults.slice();
  }
}

function saveStoredDepenseCategories(list) {
  try {
    localStorage.setItem('depenseCategories', JSON.stringify(list || []));
  } catch (e) {}
}

function renderDepenseCategories(selectedValue) {
  var select = document.getElementById('dep-tipo');
  var categories = getStoredDepenseCategories();
  function optionHtml(item) {
    return '<option value="' + item.replace(/"/g, '&quot;') + '">' + item + '</option>';
  }
  if (select) {
    var current = selectedValue || select.value || categories[0] || 'Autre';
    select.innerHTML = categories.map(optionHtml).join('');
    select.value = categories.indexOf(current) >= 0 ? current : (categories[0] || 'Autre');
  }
  var filterSelect = document.getElementById('dep-filter-category');
  if (filterSelect) {
    var filterValue = filterSelect.value || '';
    filterSelect.innerHTML = '<option value="">Toutes</option>' + categories.map(optionHtml).join('');
    filterSelect.value = categories.indexOf(filterValue) >= 0 ? filterValue : '';
  }
}

function addDepenseCategory() {
  var input = document.getElementById('dep-new-category');
  if (!input) return;
  var value = (input.value || '').trim();
  if (!value) {
    toast('Entre une categorie.', 'error');
    return;
  }
  var categories = getStoredDepenseCategories();
  var exists = categories.some(function(item) { return item.toLowerCase() === value.toLowerCase(); });
  if (!exists) {
    categories.push(value);
    saveStoredDepenseCategories(categories);
  }
  renderDepenseCategories(value);
  input.value = '';
  toast('Categorie ajoutee !', 'success');
}

function escapeDepenseHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDepenseFilters() {
  return {
    from: (document.getElementById('dep-filter-from') || {}).value || '',
    to: (document.getElementById('dep-filter-to') || {}).value || '',
    category: (document.getElementById('dep-filter-category') || {}).value || ''
  };
}

function setDepenseLoading(isLoading) {
  var btn = document.getElementById('depFilterBtn');
  if (!btn) return;
  if (isLoading) {
    if (!btn.getAttribute('data-original-text')) btn.setAttribute('data-original-text', btn.textContent);
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.textContent = 'A carregar...';
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.textContent = btn.getAttribute('data-original-text') || 'Appliquer';
  }
}

function renderDepenseCategoryChart(list) {
  var box = document.getElementById('dep-cat-chart');
  if (!box) return;
  list = list || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty">Sem dados</div>';
    return;
  }
  var max = list.reduce(function(m, item) { return Math.max(m, parseFloat(item.total) || 0); }, 0) || 1;
  box.innerHTML = list.map(function(item) {
    var total = parseFloat(item.total) || 0;
    var width = Math.max((total / max) * 100, 4);
    return '<div style="margin-bottom:10px;">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:4px;font-size:12px;">' +
        '<strong>' + escapeDepenseHtml(item.category || '-') + '</strong>' +
        '<span>' + fmt(total) + '</span>' +
      '</div>' +
      '<div style="height:10px;border-radius:999px;background:var(--surface);overflow:hidden;">' +
        '<div style="height:100%;width:' + width + '%;background:linear-gradient(90deg,var(--blue),#f3d98b);border-radius:999px;"></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderDepenseDayChart(list) {
  var box = document.getElementById('dep-day-chart');
  if (!box) return;
  list = list || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty">Sem dados</div>';
    return;
  }
  var max = list.reduce(function(m, item) { return Math.max(m, parseFloat(item.total) || 0); }, 0) || 1;
  box.innerHTML = '<div style="display:flex;align-items:flex-end;gap:10px;height:180px;">' + list.map(function(item) {
    var total = parseFloat(item.total) || 0;
    var height = Math.max((total / max) * 140, 8);
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%;">' +
      '<div style="font-size:10px;color:var(--muted);text-align:center;">' + fmt(total) + '</div>' +
      '<div style="width:100%;max-width:46px;height:' + height + 'px;border-radius:12px 12px 4px 4px;background:linear-gradient(180deg,#f2d77f,var(--blue));"></div>' +
      '<div style="font-size:10px;text-align:center;line-height:1.2;">' + escapeDepenseHtml(item.date || '') + '</div>' +
    '</div>';
  }).join('') + '</div>';
}
function getInventorySearchValue() {
  var input = document.getElementById("inventory-search");
  return input ? String(input.value || "").trim().toLowerCase() : "";
}

function filterInventoryProducts(list) {
  var search = getInventorySearchValue();

  if (!search) return list || [];

  return (list || []).filter(function(product) {
    var text = [
      product.name,
      product.mainSupplier,
      product.supplier,
      product.category,
      product.code,
      product.variation,
      (product.variations || []).join(" ")
    ].join(" ").toLowerCase();

    return text.indexOf(search) >= 0;
  });
}

function onInventorySearch() {
  renderinventaire(products || []);
}

function clearInventorySearch() {
  var input = document.getElementById("inventory-search");
  if (input) input.value = "";
  renderinventaire(products || []);
}
function renderinventaire(products) {
  var body = document.getElementById('Inventaires');
  var valeurtext = document.getElementById('valeurStocktotal');
  var valeurstocktext = document.getElementById('valeurmagasin');
  var valeurboutiquetext = document.getElementById('valeurboutique');
  var nbrestock = document.getElementById('nbreStock');
  var nbrestocktotal = document.getElementById('nbreStocktotal');
  var nbreboutique = document.getElementById('nbreboutique');

  if (!body) return;

products = filterInventoryProducts(products || []);
renderMobileInventory(products);

  var valeurtotal = 0;
  var valeurTotalBoutique = 0;
  var valeurTotalStock = 0;
  var totalboutique = 0;
  var totalstock = 0;
  var nbreProductTotal = 0;

  if (!products.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">Aucun produit trouve</td></tr>';
    return;
  }

  body.innerHTML = products.map(function(product) {
    var stockBoutique = Number(product.stockBoutique) || 0;
    var stockage = Number(product.stockage) || 0;
    var entries = Number(product.entries) || 0;
    var exits = Number(product.exits) || 0;
    var purchasePrice = Number(product.purchasePrice) || 0;

    var stocktotal = stockBoutique + stockage;
    var valeur = purchasePrice * stocktotal;
    var valeurstock = purchasePrice * stockage;
    var valeurboutique = purchasePrice * stockBoutique;

    valeurtotal += valeur;
    valeurTotalBoutique += valeurboutique;
    valeurTotalStock += valeurstock;

    nbreProductTotal += stocktotal;
    totalboutique += stockBoutique;
    totalstock += stockage;

    return '<tr>' +
      '<td>' + escapeDepenseHtml(product.name || '') + '</td>' +
      '<td>' + escapeDepenseHtml(product.mainSupplier || '') + '</td>' +
      '<td>' + entries + '</td>' +
      '<td>' + exits + '</td>' +
      '<td>' + stockBoutique + '</td>' +
      '<td>' + stockage + '</td>' +
      '<td>' + stocktotal + '</td>' +
      '<td>' + fmt(purchasePrice) + '</td>' +
      '<td style="font-weight:600;color:var(--red);">' + fmt(valeur) + '</td>' +
    '</tr>';
  }).join('');

  nbrestocktotal.innerHTML = nbreProductTotal;
  valeurtext.innerHTML = fmt(valeurtotal);
  valeurboutiquetext.innerHTML = fmt(valeurTotalBoutique);
  valeurstocktext.innerHTML = fmt(valeurTotalStock);
  nbrestock.innerHTML = totalstock;
  nbreboutique.innerHTML = totalboutique;
}
function renderMobileDepenseHistory(rows) {
  var list = ensureMobileList("depHistoryBody", "mobileDepenseHistoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Aucune depense trouvee</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    return '<div class="mobile-expense-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDepenseHtml(row.category || 'Depense') + '</div>' +
          '<div class="mobile-card-title">' + escapeDepenseHtml(row.description || 'Sans description') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDepenseHtml(row.date || '') + '</div>' +
          '<div class="mobile-card-sub">' + renderActionAuthor(row) + '</div>' +
        '</div>' +
        '<div class="mobile-expense-amount">-' + fmt(row.amount || 0) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}
function renderDepenseHistory(rows) {
  var body = document.getElementById('depHistoryBody');
  if (!body) return;

  rows = rows || [];
  renderMobileDepenseHistory(rows);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Aucune depense trouvee</td></tr>';
    return;
  }

  body.innerHTML = rows.map(function(row) {
    return '<tr>' +
      '<td>' + escapeDepenseHtml(row.date || '') + '</td>' +
      '<td>' + escapeDepenseHtml(row.category || '') + '</td>' +
      '<td>' + escapeDepenseHtml(row.description || '') + '<div>' + renderActionAuthor(row) + '</div></td>' +
      '<td style="font-weight:600;color:var(--red);">-' + fmt(row.amount || 0) + '</td>' +
    '</tr>';
  }).join('');
}

function renderDepenseDashboard(data) {
  data = data || {};
  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  setText('dep-kpi-total', fmt(data.total || 0));
  setText('dep-kpi-count', (data.count || 0) + ' registos');
  setText('dep-kpi-avg', fmt(data.average || 0));
  setText('dep-kpi-max', fmt(data.max || 0));
  setText('dep-kpi-max-cat', data.maxCategory || 'Categorie');
  setText('dep-kpi-today', fmt(data.todayTotal || 0));
  renderDepenseCategoryChart(data.byCategory || []);
  renderDepenseDayChart(data.byDay || []);
}
async function saveExpenseToSupabase(data) {
  var organizationId = getAzulOrganizationId();

  var result = await insertSingleWithAzulAudit("expenses", {
      organization_id: organizationId,
      expense_date: data.date || new Date().toISOString().split("T")[0],
      category: data.tipo || data.category || "Autre",
      description: data.desc || "",
      amount: Number(data.montant) || 0
    });

  if (result.error) throw result.error;

  return result.data;
}

async function getExpensesFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();

  filters = filters || {};

  var query = supabaseClient
    .from("expenses")
    .select("*")
    .eq("organization_id", organizationId)
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (filters.from) query = query.gte("expense_date", filters.from);
  if (filters.to) query = query.lte("expense_date", filters.to);
  if (filters.category) query = query.eq("category", filters.category);

  var result = await query;

  if (result.error) throw result.error;

  return result.data || [];
}

async function getDepenseDashboardFromSupabase(filters) {
  var rows = await getExpensesFromSupabase(filters);

  var total = rows.reduce(function(sum, row) {
    return sum + (Number(row.amount) || 0);
  }, 0);

  var count = rows.length;
  var average = count ? total / count : 0;
  var max = 0;
  var maxCategory = "Categorie";
  var today = new Date().toISOString().split("T")[0];
  var todayTotal = 0;

  var byCategoryMap = {};
  var byDayMap = {};

  rows.forEach(function(row) {
    var amount = Number(row.amount) || 0;
    var category = row.category || "Autre";
    var date = row.expense_date || "";

    if (amount > max) {
      max = amount;
      maxCategory = category;
    }

    if (date === today) {
      todayTotal += amount;
    }

    byCategoryMap[category] = (byCategoryMap[category] || 0) + amount;
    byDayMap[date] = (byDayMap[date] || 0) + amount;
  });

  var byCategory = Object.keys(byCategoryMap).map(function(category) {
    return {
      category: category,
      total: byCategoryMap[category]
    };
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var byDay = Object.keys(byDayMap).map(function(date) {
    return {
      date: date,
      total: byDayMap[date]
    };
  }).sort(function(a, b) {
    return a.date.localeCompare(b.date);
  });

  return {
    total: total,
    count: count,
    average: average,
    max: max,
    maxCategory: maxCategory,
    todayTotal: todayTotal,
    byCategory: byCategory,
    byDay: byDay
  };
}

function mapExpensesToHistoryRows(rows) {
  return (rows || []).map(function(row) {
    return {
      date: row.expense_date || "",
      category: row.category || "",
      description: row.description || "",
      amount: Number(row.amount) || 0,
      user_name: row.user_name || ""
    };
  });
}
async function loadDepenseInsights() {
  var filters = getDepenseFilters();

  setDepenseLoading(true);

  try {
    var dashboard = await getDepenseDashboardFromSupabase(filters);
    renderDepenseDashboard(dashboard || {});

    var rows = await getExpensesFromSupabase(filters);
    renderDepenseHistory(mapExpensesToHistoryRows(rows));

  } catch (e) {
    console.error("Erro depenses:", e);
    toast("Erro depenses: " + (e.message || e), "error");

  } finally {
    setDepenseLoading(false);
  }
}

function switchDepenseTab(tab, btn) {
  ['new','dashboard','history'].forEach(function(t) {
    var panel = document.getElementById('dep-panel-' + t);
    var tabBtn = document.getElementById('dep-tab-' + t);
    if (panel) panel.style.display = 'none';
    if (tabBtn) tabBtn.classList.remove('active');
  });
  var activePanel = document.getElementById('dep-panel-' + tab);
  if (activePanel) activePanel.style.display = 'block';
  if (btn) btn.classList.add('active');
}

function initDepensesPage() {
  renderDepenseCategories();
  var today = localDateKey(new Date());
  var from = document.getElementById('dep-filter-from');
  var to = document.getElementById('dep-filter-to');
  if (from && !from.value) from.value = today.slice(0, 8) + '01';
  if (to && !to.value) to.value = today;
  loadDepenseInsights();
  var defaultBtn = document.getElementById('dep-tab-new');
  if (defaultBtn) switchDepenseTab('new', defaultBtn);
}

async function saveDepense() {
  if (!requireAzulAction("expense:create", "registar despesa")) return;

  var data = {
    date: document.getElementById("dep-date").value,
    tipo: document.getElementById("dep-tipo").value,
    desc: document.getElementById("dep-desc").value.trim(),
    montant: parseFloat(document.getElementById("dep-montant").value) || 0
  };

  if (!data.desc || data.montant <= 0) {
    toast("Preenche descricao e montant!", "error");
    return;
  }

  var btn = document.getElementById("depBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  try {
    var expense = await saveExpenseToSupabase(data);

    await createAccountingEntry(
      "expense",
      expense.id,
      expense.expense_date,
      "Depense - " + expense.description,
      [
        { account: "62", debit: Number(expense.amount) || 0, credit: 0 },
        { account: "11", debit: 0, credit: Number(expense.amount) || 0 }
      ]
    );

    toast("Depense registada!", "success");

    document.getElementById("dep-desc").value = "";
    document.getElementById("dep-montant").value = "";

    loadDepenseInsights();
    loadDashboard();

  } catch (e) {
    console.error("Erro depense:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("expense", data);
      toast("Sem internet: depense gardee pour synchroniser depois.", "success");
      document.getElementById("dep-desc").value = "";
      document.getElementById("dep-montant").value = "";
      return;
    }
    toast("Erro depense: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Depense";
      btn.style.opacity = "1";
    }
  }
}

// ===== RH =====
var rhHistoryLoading = false;

function getRhPaymentTypeLabel(type) {
  var map = {
    salary: "Salario",
    advance: "Adiantamento",
    bonus: "Bonus",
    deduction: "Desconto"
  };

  return map[String(type || "").toLowerCase()] || type || "-";
}

function getRhAttendanceStatusLabel(status) {
  var map = {
    present: "Presente",
    absent: "Ausente",
    late: "Atrasado",
    off: "Folga"
  };

  return map[String(status || "").toLowerCase()] || status || "-";
}

function getRhEmployeeStatusLabel(status) {
  var map = {
    active: "Activo",
    inactive: "Inactivo",
    suspended: "Suspenso"
  };

  return map[String(status || "").toLowerCase()] || status || "-";
}

function switchRhTab(tab, btn) {
  ["employee", "attendance", "payment", "history"].forEach(function(name) {
    var panel = document.getElementById("rh-panel-" + name);
    var tabBtn = document.getElementById("rh-tab-" + name);

    if (panel) panel.style.display = name === tab ? "block" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === tab);
  });

  if (btn && btn.classList) btn.classList.add("active");

  if (tab === "history") loadRhHistory();
  else renderRhEmployeeDatalist();
}

async function getRhEmployeesFromSupabase() {
  var organizationId = getAzulOrganizationId();
  var result = await supabaseClient
    .from("hr_employees")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (result.error) throw result.error;
  return result.data || [];
}

async function findRhEmployeeByName(name) {
  name = String(name || "").trim();
  if (!name) return null;

  var organizationId = getAzulOrganizationId();
  var result = await supabaseClient
    .from("hr_employees")
    .select("*")
    .eq("organization_id", organizationId)
    .ilike("name", name)
    .limit(1)
    .maybeSingle();

  if (result.error) throw result.error;
  return result.data || null;
}

async function renderRhEmployeeDatalist() {
  var datalist = document.getElementById("rh-employee-list");
  if (!datalist) return;

  try {
    var employees = await getRhEmployeesFromSupabase();
    datalist.innerHTML = employees.map(function(emp) {
      return '<option value="' + escapeDepenseHtml(emp.name || "") + '"></option>';
    }).join("");
  } catch (e) {
    console.warn("Datalist RH indisponivel:", e);
  }
}

async function saveRhEmployee() {
  if (!requireAzulAction("hr:create", "gerir RH")) return;

  var name = (document.getElementById("rh-emp-name") || {}).value || "";
  name = name.trim();

  if (!name) {
    toast("Informe o nome do funcionario.", "error");
    return;
  }

  var btn = document.getElementById("rh-emp-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A guardar...";
  }

  try {
    var result = await insertSingleWithAzulAudit("hr_employees", {
      organization_id: getAzulOrganizationId(),
      name: name,
      phone: (document.getElementById("rh-emp-phone") || {}).value || "",
      role: (document.getElementById("rh-emp-role") || {}).value || "",
      base_salary: Number((document.getElementById("rh-emp-salary") || {}).value) || 0,
      status: (document.getElementById("rh-emp-status") || {}).value || "active",
      start_date: (document.getElementById("rh-emp-start") || {}).value || new Date().toISOString().split("T")[0],
      note: (document.getElementById("rh-emp-note") || {}).value || ""
    });

    if (result.error) throw result.error;

    ["rh-emp-name", "rh-emp-phone", "rh-emp-role", "rh-emp-salary", "rh-emp-note"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = "";
    });

    toast("Funcionario guardado.", "success");
    await loadRhDashboard();
  } catch (e) {
    toast("Erro RH: " + (e.message || e), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Guardar funcionario";
    }
  }
}

async function saveRhAttendance() {
  if (!requireAzulAction("hr:create", "registar presenca")) return;

  var name = String((document.getElementById("rh-att-employee") || {}).value || "").trim();
  if (!name) {
    toast("Escolha um funcionario.", "error");
    return;
  }

  var btn = document.getElementById("rh-att-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
  }

  try {
    var employee = await findRhEmployeeByName(name);
    var result = await insertSingleWithAzulAudit("hr_attendance", {
      organization_id: getAzulOrganizationId(),
      employee_id: employee ? employee.id : null,
      employee_name: name,
      attendance_date: (document.getElementById("rh-att-date") || {}).value || new Date().toISOString().split("T")[0],
      status: (document.getElementById("rh-att-status") || {}).value || "present",
      note: (document.getElementById("rh-att-note") || {}).value || ""
    });

    if (result.error) throw result.error;

    var note = document.getElementById("rh-att-note");
    if (note) note.value = "";
    toast("Presenca registada.", "success");
    await loadRhDashboard();
  } catch (e) {
    toast("Erro presenca: " + (e.message || e), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Registar presenca";
    }
  }
}

async function saveRhPayment() {
  if (!requireAzulAction("hr:create", "registar pagamento RH")) return;

  var name = String((document.getElementById("rh-pay-employee") || {}).value || "").trim();
  var amount = Number((document.getElementById("rh-pay-amount") || {}).value) || 0;

  if (!name || amount <= 0) {
    toast("Informe funcionario e montante valido.", "error");
    return;
  }

  var btn = document.getElementById("rh-pay-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
  }

  try {
    var employee = await findRhEmployeeByName(name);
    var paymentType = (document.getElementById("rh-pay-type") || {}).value || "salary";
    var paymentDate = (document.getElementById("rh-pay-date") || {}).value || new Date().toISOString().split("T")[0];
    var note = (document.getElementById("rh-pay-note") || {}).value || "";

    var result = await insertSingleWithAzulAudit("hr_payments", {
      organization_id: getAzulOrganizationId(),
      employee_id: employee ? employee.id : null,
      employee_name: name,
      payment_date: paymentDate,
      payment_type: paymentType,
      amount: amount,
      note: note
    });

    if (result.error) throw result.error;

    if (paymentType !== "deduction") {
      var expenseResult = await insertSingleWithAzulAudit("expenses", {
        organization_id: getAzulOrganizationId(),
        expense_date: paymentDate,
        category: paymentType === "advance" ? "Adiantamento salarial" : "Salaire",
        description: "RH - " + getRhPaymentTypeLabel(paymentType) + " - " + name + (note ? " - " + note : ""),
        amount: amount
      });

      if (expenseResult.error) throw expenseResult.error;

      try {
        var expense = expenseResult.data || {};
        await createAccountingEntry(
          "expense",
          expense.id,
          paymentDate,
          "RH - " + getRhPaymentTypeLabel(paymentType) + " - " + name,
          [
            { account: "62", debit: amount, credit: 0 },
            { account: "11", debit: 0, credit: amount }
          ]
        );
      } catch (accountingError) {
        console.warn("Lancamento contabilistico RH nao registado:", accountingError);
      }
    }

    var amountInput = document.getElementById("rh-pay-amount");
    var noteInput = document.getElementById("rh-pay-note");
    if (amountInput) amountInput.value = "";
    if (noteInput) noteInput.value = "";

    toast("Pagamento RH registado.", "success");
    await loadRhDashboard();
    loadDashboard();
  } catch (e) {
    toast("Erro pagamento RH: " + (e.message || e), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Registar pagamento RH";
    }
  }
}

async function getRhHistoryFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var employeesResult = await supabaseClient
    .from("hr_employees")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (employeesResult.error) throw employeesResult.error;

  var attendanceResult = await supabaseClient
    .from("hr_attendance")
    .select("*")
    .eq("organization_id", organizationId)
    .order("attendance_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(300);
  if (attendanceResult.error) throw attendanceResult.error;

  var paymentsResult = await supabaseClient
    .from("hr_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(300);
  if (paymentsResult.error) throw paymentsResult.error;

  return {
    employees: employeesResult.data || [],
    attendance: attendanceResult.data || [],
    payments: paymentsResult.data || []
  };
}

function mapRhHistoryRows(data) {
  data = data || {};
  var rows = [];

  (data.employees || []).forEach(function(emp) {
    rows.push({
      kind: "employees",
      type: "Funcionario",
      date: emp.start_date || String(emp.created_at || "").slice(0, 10),
      employee: emp.name || "",
      detail: (emp.role || "Sem funcao") + " - " + getRhEmployeeStatusLabel(emp.status),
      amount: Number(emp.base_salary) || 0,
      created_at: emp.created_at || "",
      user_name: emp.user_name || ""
    });
  });

  (data.attendance || []).forEach(function(row) {
    rows.push({
      kind: "attendance",
      type: "Presenca",
      date: row.attendance_date || "",
      employee: row.employee_name || "",
      detail: getRhAttendanceStatusLabel(row.status) + (row.note ? " - " + row.note : ""),
      amount: 0,
      created_at: row.created_at || "",
      user_name: row.user_name || ""
    });
  });

  (data.payments || []).forEach(function(row) {
    rows.push({
      kind: "payments",
      type: "Pagamento",
      date: row.payment_date || "",
      employee: row.employee_name || "",
      detail: getRhPaymentTypeLabel(row.payment_type) + (row.note ? " - " + row.note : ""),
      amount: Number(row.amount) || 0,
      created_at: row.created_at || "",
      user_name: row.user_name || ""
    });
  });

  rows.sort(function(a, b) {
    var ak = String(a.date || "") + " " + String(a.created_at || "");
    var bk = String(b.date || "") + " " + String(b.created_at || "");
    return bk.localeCompare(ak);
  });

  return rows;
}

function renderRhHistoryRows(rows) {
  var body = document.getElementById("rhHistoryBody");
  var cards = document.getElementById("rhHistoryCards");

  rows = rows || [];

  if (body) {
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">Nenhum registo RH encontrado.</td></tr>';
    } else {
      body.innerHTML = rows.map(function(row) {
        return '<tr>' +
          '<td>' + escapeDepenseHtml(row.type) + '</td>' +
          '<td>' + escapeDepenseHtml(row.date || '') + '</td>' +
          '<td>' + escapeDepenseHtml(row.employee || '') + '</td>' +
          '<td>' + escapeDepenseHtml(row.detail || '') + '</td>' +
          '<td style="font-weight:700;color:var(--blue);">' + (row.amount ? fmt(row.amount) : '-') + '</td>' +
          '<td>' + renderActionAuthor(row) + '</td>' +
        '</tr>';
      }).join("");
    }
  }

  if (cards) {
    if (!rows.length) {
      cards.innerHTML = '<div class="empty">Nenhum registo RH encontrado.</div>';
    } else {
      cards.innerHTML = rows.map(function(row) {
        return '<div class="mobile-rh-card">' +
          '<div class="mobile-card-top">' +
            '<div>' +
              '<div class="mobile-card-kicker">' + escapeDepenseHtml(row.type || 'RH') + '</div>' +
              '<div class="mobile-card-title">' + escapeDepenseHtml(row.employee || '') + '</div>' +
              '<div class="mobile-card-sub">' + escapeDepenseHtml(row.detail || '') + '</div>' +
              '<div class="mobile-card-sub">' + escapeDepenseHtml(row.date || '') + '</div>' +
              '<div class="mobile-card-sub">' + renderActionAuthor(row) + '</div>' +
            '</div>' +
            '<div class="mobile-card-amount">' + (row.amount ? fmt(row.amount) : '-') + '</div>' +
          '</div>' +
        '</div>';
      }).join("");
    }
  }
}

async function loadRhHistory() {
  if (rhHistoryLoading) return;
  rhHistoryLoading = true;

  try {
    var data = await getRhHistoryFromSupabase();
    var rows = mapRhHistoryRows(data);
    var type = (document.getElementById("rh-filter-type") || {}).value || "all";
    var search = String((document.getElementById("rh-filter-search") || {}).value || "").trim().toLowerCase();

    if (type !== "all") {
      rows = rows.filter(function(row) { return row.kind === type; });
    }

    if (search) {
      rows = rows.filter(function(row) {
        return [row.type, row.employee, row.detail, row.user_name].join(" ").toLowerCase().indexOf(search) >= 0;
      });
    }

    renderRhHistoryRows(rows);
  } catch (e) {
    var body = document.getElementById("rhHistoryBody");
    if (body) body.innerHTML = '<tr><td colspan="6" class="empty">Erro RH: ' + escapeDepenseHtml(e.message || e) + '</td></tr>';
    toast("Erro RH: " + (e.message || e), "error");
  } finally {
    rhHistoryLoading = false;
  }
}

async function loadRhDashboard() {
  try {
    var data = await getRhHistoryFromSupabase();
    var today = new Date().toISOString().split("T")[0];
    var monthKey = today.slice(0, 7);
    var activeEmployees = (data.employees || []).filter(function(emp) {
      return String(emp.status || "active").toLowerCase() === "active";
    });
    var todayPresent = (data.attendance || []).filter(function(row) {
      return row.attendance_date === today && String(row.status || "").toLowerCase() === "present";
    }).length;
    var monthPaid = (data.payments || []).filter(function(row) {
      return String(row.payment_date || "").slice(0, 7) === monthKey;
    }).reduce(function(sum, row) {
      return sum + (Number(row.amount) || 0);
    }, 0);
    var payroll = activeEmployees.reduce(function(sum, emp) {
      return sum + (Number(emp.base_salary) || 0);
    }, 0);

    if (document.getElementById("rh-kpi-active")) document.getElementById("rh-kpi-active").textContent = activeEmployees.length;
    if (document.getElementById("rh-kpi-present")) document.getElementById("rh-kpi-present").textContent = todayPresent;
    if (document.getElementById("rh-kpi-paid")) document.getElementById("rh-kpi-paid").textContent = fmt(monthPaid);
    if (document.getElementById("rh-kpi-payroll")) document.getElementById("rh-kpi-payroll").textContent = fmt(payroll);

    await renderRhEmployeeDatalist();
    renderRhHistoryRows(mapRhHistoryRows(data).slice(0, 80));
  } catch (e) {
    console.warn("Dashboard RH indisponivel:", e);
  }
}

function initRhPage() {
  var today = new Date().toISOString().split("T")[0];
  ["rh-emp-start", "rh-att-date", "rh-pay-date"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && !el.value) el.value = today;
  });

  switchRhTab("employee", document.getElementById("rh-tab-employee"));
  loadRhDashboard();
}
// Enregistrement par cle de license

async function saveTresorerie() {
  var data = {
    date: document.getElementById("tre-date").value,
    mouvement: document.getElementById("tre-mvt").value,
    tipo: document.getElementById("tre-type").value.trim(),
    desc: document.getElementById("tre-desc").value.trim(),
    montant: parseFloat(document.getElementById("tre-montant").value) || 0
  };

  if (data.montant <= 0) {
    toast("Entra um montant valide!", "error");
    return;
  }

  var btn = document.getElementById("treBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  try {
    await saveTreasuryManualEntryToSupabase(data);

    toast("Mouvement de tresorerie registado!", "success");

    document.getElementById("tre-type").value = "";
    document.getElementById("tre-desc").value = "";
    document.getElementById("tre-montant").value = "";

    loadTresorerie();

  } catch (e) {
    console.error("Erro tresorerie:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("treasury", data);
      toast("Sem internet: mouvement garde pour synchroniser depois.", "success");
      document.getElementById("tre-type").value = "";
      document.getElementById("tre-desc").value = "";
      document.getElementById("tre-montant").value = "";
      return;
    }
    toast("Erro tresorerie: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Registar Mouvement";
      btn.style.opacity = "1";
    }
  }
}
function renderMobileTreasuryHistory(rows) {
  var list = ensureMobileList("tresoBody", "mobileTreasuryHistoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhum movimento encontrado</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    var income = Number(row.income) || 0;
    var expense = Number(row.expense) || 0;
    var isIn = income > 0;
    var amount = isIn ? income : expense;

    return '<div class="mobile-treasury-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDepenseHtml(row.type || 'Mouvement') + '</div>' +
          '<div class="mobile-card-title">' + escapeDepenseHtml(row.desc || 'Sans description') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDepenseHtml(row.date || '') + '</div>' +
          '<div class="mobile-card-sub">' + renderActionAuthor(row) + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="mobile-treasury-amount ' + (isIn ? 'in' : 'out') + '">' +
            (isIn ? '+' : '-') + fmt(amount || 0) +
          '</div>' +
          '<div class="mobile-card-sub">Solde: ' + fmt(row.balance || 0) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function loadTresorerie() {
  var body = document.getElementById("tresoBody");
  if (!body) return;

  body.innerHTML = '<tr><td colspan="6" class="empty">A carregar...</td></tr>';

  var params = {
    from: document.getElementById("tre-from").value,
    to: document.getElementById("tre-to").value,
    type: document.getElementById("tre-filter-type").value.trim(),
    limit: 100
  };

  try {
    var data = await getTreasuryFromSupabase(params);

    data = data || {};

    document.getElementById("tr-balance").textContent = fmt(data.balance || 0);
    document.getElementById("tr-in").textContent = fmt(data.totalIn || 0);
    document.getElementById("tr-out").textContent = fmt(data.totalOut || 0);

    if (!data.entries || data.entries.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty">Nenhum movimento encontrado</td></tr>';
      renderMobileTreasuryHistory([]);
      return;
    }

    body.innerHTML = "";
    renderMobileTreasuryHistory(data.entries || []);

    data.entries.forEach(function(row) {
      body.innerHTML += "<tr>" +
        "<td>" + escapeDepenseHtml(row.date || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.type || "") + "</td>" +
        "<td>" + escapeDepenseHtml(row.desc || "") + "<div>" + renderActionAuthor(row) + "</div></td>" +
        '<td style="color:var(--green);font-weight:600;">' + ((row.income || 0) ? fmt(row.income) : "-") + "</td>" +
        '<td style="color:var(--red);font-weight:600;">' + ((row.expense || 0) ? fmt(row.expense) : "-") + "</td>" +
        '<td style="font-weight:700;color:var(--blue);">' + fmt(row.balance || 0) + "</td>" +
      "</tr>";
    });

  } catch (e) {
    console.error("Erro tresorerie:", e);
    body.innerHTML = '<tr><td colspan="6" class="empty">Erro ao carregar tresorerie</td></tr>';
    toast("Erro tresorerie: " + (e.message || e), "error");
  }
}
async function saveTreasuryManualEntryToSupabase(data) {
  var organizationId = getAzulOrganizationId();

  var result = await insertSingleWithAzulAudit("treasury_entries", {
      organization_id: organizationId,
      entry_date: data.date || new Date().toISOString().split("T")[0],
      movement: data.mouvement || "entrada",
      type: data.tipo || "",
      description: data.desc || "",
      amount: Number(data.montant) || 0
    });

  if (result.error) throw result.error;
}

async function getTreasuryFromSupabase(params) {
  var organizationId = getAzulOrganizationId();

  params = params || {};
  var from = params.from || "";
  var to = params.to || "";
  var typeFilter = String(params.type || "").trim().toLowerCase();

  var entries = [];

  var salesQuery = supabaseClient
    .from("sales")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) salesQuery = salesQuery.gte("sale_date", from);
  if (to) salesQuery = salesQuery.lte("sale_date", to);

 var salesResult = await salesQuery;
if (salesResult.error) throw salesResult.error;

var salesRows = salesResult.data || [];
var saleIds = salesRows.map(function(sale) {
  return sale.id;
});

var saleItemsBySale = {};

if (saleIds.length) {
    var saleItems = await fetchSaleItemsBySaleIds(saleIds);

  saleItems.forEach(function(item) {
    if (!saleItemsBySale[item.sale_id]) saleItemsBySale[item.sale_id] = [];
    saleItemsBySale[item.sale_id].push(item);
  });
}

salesRows.forEach(function(sale) {
    var cashIn = getCashInAmountFromPaymentLines(sale.payment_lines || [], sale.total);

    if (cashIn > 0) {
      entries.push({
        date: sale.sale_date || "",
        type: "Venda",
        desc: "Venda " + (sale.receipt_no || "") + " - valores recebidos",
        income: cashIn,
        expense: 0,
        user_name: sale.user_name || "",
        created_at: sale.created_at || ""
      });
    }
  var isExternal = String(sale.sale_type || "").toLowerCase() === "externo";

if (isExternal) {
  var externalItems = saleItemsBySale[sale.id] || [];

  var supplierCost = externalItems.reduce(function(sum, item) {
    return sum + (Number(item.purchase_price) || 0) * (Number(item.quantity) || 0);
  }, 0);

  if (supplierCost > 0) {
    entries.push({
      date: sale.sale_date || "",
      type: "Pagamento Fornecedor Externo",
      desc: "Custo fornecedor da venda " + (sale.receipt_no || ""),
      income: 0,
      expense: supplierCost,
      user_name: sale.user_name || "",
      created_at: sale.created_at || ""
    });
  }
}
  });

  

  var purchasesQuery = supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) purchasesQuery = purchasesQuery.gte("created_at", from);
  if (to) purchasesQuery = purchasesQuery.lte("created_at", to + "T23:59:59");

  var purchasesResult = await purchasesQuery;
  if (purchasesResult.error) throw purchasesResult.error;

  (purchasesResult.data || []).forEach(function(purchase) {
    var paid = getPurchasePaidAmount(purchase);

    if (paid > 0) {
      entries.push({
        date: String(purchase.created_at || "").slice(0, 10),
        type: "Achat",
        desc: "Achat fornecedor " + (purchase.supplier || ""),
        income: 0,
        expense: paid,
        user_name: purchase.user_name || "",
        created_at: purchase.created_at || ""
      });
    }
  });

  var expensesQuery = supabaseClient
    .from("expenses")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) expensesQuery = expensesQuery.gte("expense_date", from);
  if (to) expensesQuery = expensesQuery.lte("expense_date", to);

  var expensesResult = await expensesQuery;
  if (expensesResult.error) throw expensesResult.error;

  (expensesResult.data || []).forEach(function(expense) {
    entries.push({
      date: expense.expense_date || "",
      type: "Depense",
      desc: expense.description || expense.category || "",
      income: 0,
      expense: Number(expense.amount) || 0,
      user_name: expense.user_name || "",
      created_at: expense.created_at || ""
    });
  });

  var clientPayQuery = supabaseClient
    .from("client_payments")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) clientPayQuery = clientPayQuery.gte("payment_date", from);
  if (to) clientPayQuery = clientPayQuery.lte("payment_date", to);

  var clientPayResult = await clientPayQuery;
  if (clientPayResult.error) throw clientPayResult.error;

  (clientPayResult.data || []).forEach(function(pay) {
    entries.push({
      date: pay.payment_date || "",
      type: "Pagamento Cliente",
      desc: (pay.client_name || "") + (pay.note ? " - " + pay.note : ""),
      income: Number(pay.amount) || 0,
      expense: 0,
      user_name: pay.user_name || "",
      created_at: pay.created_at || ""
    });
  });

  var supplierPayQuery = supabaseClient
    .from("supplier_payments")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) supplierPayQuery = supplierPayQuery.gte("payment_date", from);
  if (to) supplierPayQuery = supplierPayQuery.lte("payment_date", to);

  var supplierPayResult = await supplierPayQuery;
  if (supplierPayResult.error) throw supplierPayResult.error;

  (supplierPayResult.data || []).forEach(function(pay) {
    entries.push({
      date: pay.payment_date || "",
      type: "Pagamento Fornecedor",
      desc: (pay.supplier || "") + (pay.note ? " - " + pay.note : ""),
      income: 0,
      expense: Number(pay.amount) || 0,
      user_name: pay.user_name || "",
      created_at: pay.created_at || ""
    });
  });

  var manualQuery = supabaseClient
    .from("treasury_entries")
    .select("*")
    .eq("organization_id", organizationId);

  if (from) manualQuery = manualQuery.gte("entry_date", from);
  if (to) manualQuery = manualQuery.lte("entry_date", to);

  var manualResult = await manualQuery;
  if (manualResult.error) throw manualResult.error;

  (manualResult.data || []).forEach(function(row) {
    var isIncome = row.movement === "entrada";

    entries.push({
      date: row.entry_date || "",
      type: row.type || "Manual",
      desc: row.description || "",
      income: isIncome ? Number(row.amount) || 0 : 0,
      expense: isIncome ? 0 : Number(row.amount) || 0,
      user_name: row.user_name || "",
      created_at: row.created_at || ""
    });
  });

  if (typeFilter) {
    entries = entries.filter(function(row) {
      return (
        String(row.type || "").toLowerCase().indexOf(typeFilter) >= 0 ||
        String(row.desc || "").toLowerCase().indexOf(typeFilter) >= 0
      );
    });
  }

  entries.sort(function(a, b) {
    var ak = String(a.date || "") + " " + String(a.created_at || "");
    var bk = String(b.date || "") + " " + String(b.created_at || "");
    return ak.localeCompare(bk);
  });

  var running = 0;

  entries = entries.map(function(row) {
    running += (Number(row.income) || 0) - (Number(row.expense) || 0);

    return {
      date: row.date,
      type: row.type,
      desc: row.desc,
      income: row.income,
      expense: row.expense,
      balance: running,
      user_name: row.user_name || "",
      created_at: row.created_at
    };
  });

  var totalIn = entries.reduce(function(sum, row) {
    return sum + (Number(row.income) || 0);
  }, 0);

  var totalOut = entries.reduce(function(sum, row) {
    return sum + (Number(row.expense) || 0);
  }, 0);

  var balance = totalIn - totalOut;

  entries.sort(function(a, b) {
    var ak = String(a.date || "") + " " + String(a.created_at || "");
    var bk = String(b.date || "") + " " + String(b.created_at || "");
    return bk.localeCompare(ak);
  });

  return {
    balance: balance,
    totalIn: totalIn,
    totalOut: totalOut,
    count: entries.length,
    entries: entries
  };
}

function htmlSafeAcct(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
  });
}

function acctSet(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

function acctAmountRow(label, amount, color) {
  return '<tr><td>' + htmlSafeAcct(label) + '</td><td style="text-align:right;font-weight:700;color:' + (color || 'var(--text)') + ';">' + fmt(amount || 0) + '</td></tr>';
}
function getCashInAmountFromPaymentLines(lines, fallbackTotal) {
  lines = lines || [];

  if (!Array.isArray(lines) || !lines.length) {
    return Number(fallbackTotal) || 0;
  }

  return lines.reduce(function(sum, line) {
    var method = String(line.method || "").toLowerCase();
    var amount = Number(line.montant) || 0;

    if (method.indexOf("credit") >= 0 || method.indexOf("credito") >= 0) {
      return sum;
    }

    return sum + amount;
  }, 0);
}

function getPurchasePaidAmount(row) {
  return Number(row.paid_amount) || 0;
}
function getAccountName(code) {
  var map = {
    "11": "Caixa / Banco",
    "12": "Clientes",
    "13": "Stock",
    "21": "Fornecedores",
    "31": "Capital proprio",
    "61": "Custo das mercadorias vendidas",
    "62": "Despesas operacionais",
    "71": "Vendas"
  };

  return map[code] || code;
}

async function createAccountingEntry(sourceType, sourceId, entryDate, description, lines) {
  var organizationId = getAzulOrganizationId();

  var totalDebit = lines.reduce(function(sum, line) {
    return sum + (Number(line.debit) || 0);
  }, 0);

  var totalCredit = lines.reduce(function(sum, line) {
    return sum + (Number(line.credit) || 0);
  }, 0);

  if (Math.round(totalDebit) !== Math.round(totalCredit)) {
    throw new Error("Ecriture comptable desequilibree: debit " + totalDebit + " / credit " + totalCredit);
  }

  var lineRows = lines.map(function(line) {
    return {
      account_code: line.account,
      account_name: getAccountName(line.account),
      debit: Number(line.debit) || 0,
      credit: Number(line.credit) || 0
    };
  });

  var entryResult = await supabaseClient.rpc("create_accounting_entry_for_org", {
    p_organization_id: organizationId,
    p_source_type: sourceType,
    p_source_id: sourceId,
    p_entry_date: entryDate || new Date().toISOString().split("T")[0],
    p_description: description || "",
    p_lines: lineRows
  });

  if (entryResult.error) throw entryResult.error;

  return entryResult.data;
}

function renderMobileAccountingRows(listId, rows, emptyText) {
  var list = ensureMobileList(listId, "mobile-" + listId);
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">' + escapeDepenseHtml(emptyText || "Aucun mouvement") + '</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    return '<div class="mobile-accounting-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDepenseHtml(row.kicker || '') + '</div>' +
          '<div class="mobile-card-title">' + escapeDepenseHtml(row.label || '') + '</div>' +
          (row.sub ? '<div class="mobile-card-sub">' + escapeDepenseHtml(row.sub || '') + '</div>' : '') +
        '</div>' +
        '<div class="mobile-accounting-amount ' + escapeDepenseHtml(row.kind || '') + '">' + fmt(row.amount || 0) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderMobileAccountingJournal(rows) {
  var list = ensureMobileList("acctJournalBody", "mobileAcctJournalList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhum movimento encontrado</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    var debito = row.debito != null ? row.debito : row.entree;
    var credito = row.credito != null ? row.credito : row.sortie;
    var isDebit = Number(debito) > 0;
    var amount = isDebit ? debito : credito;

    return '<div class="mobile-accounting-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDepenseHtml(row.type || 'Comptabilite') + '</div>' +
          '<div class="mobile-card-title">' + escapeDepenseHtml(row.desc || 'Sans description') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDepenseHtml(row.date || '') + ' · ' + escapeDepenseHtml(row.source || '') + '</div>' +
        '</div>' +
        '<div class="mobile-accounting-amount ' + (isDebit ? 'debit' : 'credit') + '">' +
          (isDebit ? '+' : '-') + fmt(amount || 0) +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function loadComptabilite() {
  var body = document.getElementById("acctJournalBody");
  if (!body) return;

  body.innerHTML = '<tr><td colspan="6" class="empty">A carregar...</td></tr>';

  var params = {
    from: (document.getElementById("acct-from") || {}).value || "",
    to: (document.getElementById("acct-to") || {}).value || "",
    type: ((document.getElementById("acct-type") || {}).value || "").trim(),
    limit: 200
  };

  try {
    var data = await getComptabiliteFromSupabase(params);

    data = data || {};

    var r = data.resume || {};
    var b = data.bilan || {};
    var p = data.period || {};

    var incomeRowsMobile = [
  { kicker: "Resultat", label: "Vendas", amount: r.vendas || 0, kind: "debit" },
  { kicker: "Resultat", label: "Custo das vendas", amount: r.coutVendas || 0, kind: "credit" },
  { kicker: "Resultat", label: "Lucro bruto", amount: r.beneficeBrut || 0, kind: "debit" },
  { kicker: "Resultat", label: "Despesas operacionais", amount: r.depenses || 0, kind: "credit" },
  { kicker: "Resultat", label: "Resultado operacional", amount: r.resultatNet || 0, kind: (r.resultatNet || 0) >= 0 ? "debit" : "credit" },
  { kicker: "Stock", label: "Compras de stock no periodo", amount: r.achats || 0, kind: "" },
  { kicker: "Credito", label: "Compras a credito", amount: r.comprasCredito || 0, kind: "credit" },
  { kicker: "Fornecedor", label: "Pagamentos a fornecedores", amount: r.pagamentosFornecedores || 0, kind: "credit" }
];

var balanceRowsMobile = [
  { kicker: "Ativo", label: "Tesouraria", amount: b.tresorerie || 0, kind: "debit" },
  { kicker: "Ativo", label: "Stock", amount: b.stock || 0, kind: "" },
  { kicker: "Ativo", label: "Clientes a receber", amount: b.clientesAReceber || 0, kind: "debit" },
  { kicker: "Ativo", label: "Total do ativo", amount: b.actifSimplifie || 0, kind: "debit" },
  { kicker: "Passivo", label: "Dividas fornecedores", amount: b.dividasFournisseurs || 0, kind: "credit" },
  { kicker: "Passivo", label: "Total do passivo", amount: b.passivo || 0, kind: "credit" },
  { kicker: "Capital", label: "Capital proprio simplificado", amount: b.capitaisProprios || 0, kind: (b.capitaisProprios || 0) >= 0 ? "debit" : "credit" }
];

renderMobileAccountingRows("acctIncomeBody", incomeRowsMobile, "Aucun resultat");
renderMobileAccountingRows("acctBalanceBody", balanceRowsMobile, "Aucun bilan");

    acctSet("acct-sales", fmt(r.vendas || 0));
    acctSet("acct-sales-n", (r.vendasCount || 0) + " vendas");
    acctSet("acct-gross", fmt(r.beneficeBrut || 0));
    acctSet("acct-margin", "Margem " + ((r.marge || 0).toFixed ? (r.marge || 0).toFixed(1) : r.marge) + "%");
    acctSet("acct-expenses", fmt(r.depenses || 0));
    acctSet("acct-purchases", "Compras " + fmt(r.achats || 0) + " | Credito " + fmt(r.comprasCredito || 0));
    acctSet("acct-net", fmt(r.resultatNet || 0));
    acctSet("acct-period", (p.from || "-") + " - " + (p.to || "-"));

    var income = document.getElementById("acctIncomeBody");

    if (income) {
      income.innerHTML =
        acctAmountRow("Vendas", r.vendas, "var(--green)") +
        acctAmountRow("Custo das vendas", r.coutVendas, "var(--red)") +
        acctAmountRow("Lucro bruto", r.beneficeBrut, "var(--blue)") +
        acctAmountRow("Despesas operacionais", r.depenses, "var(--red)") +
        acctAmountRow("Resultado operacional", r.resultatNet, (r.resultatNet || 0) >= 0 ? "var(--green)" : "var(--red)") +
        acctAmountRow("Compras de stock no periodo", r.achats, "var(--text)") +
        acctAmountRow("Compras a credito", r.comprasCredito, "var(--red)") +
        acctAmountRow("Pagamentos a fornecedores", r.pagamentosFornecedores, "var(--red)");
    }

    var balance = document.getElementById("acctBalanceBody");

    if (balance) {
      balance.innerHTML =
        acctAmountRow("Tesouraria", b.tresorerie, "var(--blue)") +
        acctAmountRow("Stock", b.stock, "var(--text)") +
        acctAmountRow("Clientes a receber", b.clientesAReceber, "var(--blue)") +
        acctAmountRow("Total do ativo", b.actifSimplifie, "var(--green)") +
        acctAmountRow("Dividas fornecedores", b.dividasFournisseurs, "var(--red)") +
        acctAmountRow("Total do passivo", b.passivo, "var(--red)") +
        acctAmountRow("Capital proprio simplificado", b.capitaisProprios, (b.capitaisProprios || 0) >= 0 ? "var(--green)" : "var(--red)");
    }

  if (!data.journal || !data.journal.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">Nenhum movimento encontrado</td></tr>';
      renderMobileAccountingJournal([]);
      return;
    }

    body.innerHTML = "";
    renderMobileAccountingJournal(data.journal || []);

    data.journal.forEach(function(row) {
      var debito = row.debito != null ? row.debito : row.entree;
      var credito = row.credito != null ? row.credito : row.sortie;

      body.innerHTML +=
        "<tr>" +
          "<td>" + htmlSafeAcct(row.date || "") + "</td>" +
          "<td>" + htmlSafeAcct(row.type || "") + "</td>" +
          "<td>" + htmlSafeAcct(row.desc || "") + "</td>" +
          '<td style="color:var(--green);font-weight:700;">' + ((debito || 0) ? fmt(debito) : "-") + "</td>" +
          '<td style="color:var(--red);font-weight:700;">' + ((credito || 0) ? fmt(credito) : "-") + "</td>" +
          "<td>" + htmlSafeAcct(row.source || "") + "</td>" +
        "</tr>";
    });

  } catch (e) {
    console.error("Erro comptabilite:", e);
    body.innerHTML = '<tr><td colspan="6" class="empty">Erro ao carregar comptabilite</td></tr>';
    toast("Erro comptabilite: " + (e.message || e), "error");
  }
}
async function getComptabiliteFromSupabase(params) {
  var organizationId = getAzulOrganizationId();

  params = params || {};
  var from = params.from || "";
  var to = params.to || "";
  var typeFilter = String(params.type || "").trim().toLowerCase();

  var entriesQuery = supabaseClient
    .from("accounting_entries")
    .select("*")
    .eq("organization_id", organizationId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (from) entriesQuery = entriesQuery.gte("entry_date", from);
  if (to) entriesQuery = entriesQuery.lte("entry_date", to);

  var entriesResult = await entriesQuery;
  if (entriesResult.error) throw entriesResult.error;

  var entries = entriesResult.data || [];

  if (!entries.length) {
    return {
      resume: {
        vendas: 0,
        vendasCount: 0,
        coutVendas: 0,
        beneficeBrut: 0,
        marge: 0,
        depenses: 0,
        achats: 0,
        comprasCredito: 0,
        pagamentosFornecedores: 0,
        resultatNet: 0
      },
      bilan: {
        tresorerie: 0,
        stock: 0,
        clientesAReceber: 0,
        actifSimplifie: 0,
        dividasFournisseurs: 0,
        passivo: 0,
        capitaisProprios: 0
      },
      period: {
        from: from || "-",
        to: to || "-"
      },
      journal: []
    };
  }

  var entryIds = entries.map(function(entry) {
    return entry.id;
  });

  var linesResult = await supabaseClient
    .from("accounting_lines")
    .select("*")
    .eq("organization_id", organizationId)
    .in("entry_id", entryIds);

  if (linesResult.error) throw linesResult.error;

  var lines = linesResult.data || [];

  var entriesById = {};
  entries.forEach(function(entry) {
    entriesById[entry.id] = entry;
  });

  function sumAccount(code, side, sourceType) {
    return lines.reduce(function(sum, line) {
      var entry = entriesById[line.entry_id] || {};

      if (String(line.account_code) !== String(code)) return sum;
      if (sourceType && entry.source_type !== sourceType) return sum;

      return sum + (Number(line[side]) || 0);
    }, 0);
  }

  var vendas = sumAccount("71", "credit");
  var coutVendas = sumAccount("61", "debit");
  var depenses = sumAccount("62", "debit");

  var achats = sumAccount("13", "debit", "purchase");
  var comprasCredito = sumAccount("21", "credit", "purchase");
  var pagamentosFornecedores = sumAccount("21", "debit", "supplier_payment");

  var tresorerie = sumAccount("11", "debit") - sumAccount("11", "credit");
  var stock = sumAccount("13", "debit") - sumAccount("13", "credit");
  var clientesAReceber = sumAccount("12", "debit") - sumAccount("12", "credit");
  var dividasFournisseurs = sumAccount("21", "credit") - sumAccount("21", "debit");

  var beneficeBrut = vendas - coutVendas;
  var resultatNet = beneficeBrut - depenses;
  var marge = vendas > 0 ? (beneficeBrut / vendas) * 100 : 0;

  var vendasCount = entries.filter(function(entry) {
    return entry.source_type === "sale";
  }).length;

  var journal = [];

  lines.forEach(function(line) {
    var entry = entriesById[line.entry_id] || {};

    journal.push({
      date: entry.entry_date || "",
      type: line.account_code + " - " + (line.account_name || getAccountName(line.account_code)),
      desc: entry.description || "",
      debito: Number(line.debit) || 0,
      credito: Number(line.credit) || 0,
      source: entry.source_type || "",
      created_at: entry.created_at || ""
    });
  });

  if (typeFilter) {
    journal = journal.filter(function(row) {
      return (
        String(row.type || "").toLowerCase().indexOf(typeFilter) >= 0 ||
        String(row.desc || "").toLowerCase().indexOf(typeFilter) >= 0 ||
        String(row.source || "").toLowerCase().indexOf(typeFilter) >= 0
      );
    });
  }

  journal.sort(function(a, b) {
    var ak = String(a.date || "") + " " + String(a.created_at || "");
    var bk = String(b.date || "") + " " + String(b.created_at || "");
    return bk.localeCompare(ak);
  });

  return {
    resume: {
      vendas: vendas,
      vendasCount: vendasCount,
      coutVendas: coutVendas,
      beneficeBrut: beneficeBrut,
      marge: marge,
      depenses: depenses,
      achats: achats,
      comprasCredito: comprasCredito,
      pagamentosFornecedores: pagamentosFornecedores,
      resultatNet: resultatNet
    },
    bilan: {
      tresorerie: tresorerie,
      stock: stock,
      clientesAReceber: clientesAReceber,
      actifSimplifie: tresorerie + stock + clientesAReceber,
      dividasFournisseurs: dividasFournisseurs,
      passivo: dividasFournisseurs,
      capitaisProprios: tresorerie + stock + clientesAReceber - dividasFournisseurs
    },
    period: {
      from: from || "-",
      to: to || "-"
    },
    journal: journal
  };
}
// ===== FORNECEDORES =====
async function saveFornecedor() {
  var data = {
    nome: document.getElementById("forn-nome").value.trim(),
    tel: document.getElementById("forn-tel").value.trim(),
    pais: document.getElementById("forn-pais").value.trim(),
    nota: document.getElementById("forn-nota").value.trim()
  };

  if (!data.nome) {
    toast("Entra o nome do fornecedor!", "error");
    return;
  }

  var btn = document.getElementById("fornBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  try {
    await upsertSupplierToSupabase(data);

    toast("Fornecedor guardado!", "success");

    document.getElementById("forn-nome").value = "";
    document.getElementById("forn-tel").value = "";
    document.getElementById("forn-pais").value = "";
    document.getElementById("forn-nota").value = "";

    await renderSupplierDatalists();
    await renderSupplierDirectory();

  } catch (e) {
    console.error("Erro fornecedor:", e);
    toast("Erro fornecedor: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Fornecedor";
      btn.style.opacity = "1";
    }
  }
}

// ===== FICHE CLIENT =====
var clientDetailRequestSeq = 0;

async function getClientNamesFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("sales")
    .select("client_name")
    .eq("organization_id", organizationId)
    .not("client_name", "is", null)
    .order("created_at", { ascending: false });

  if (result.error) throw result.error;

  var seen = {};
  return (result.data || [])
    .map(function(row) {
      return String(row.client_name || "").trim();
    })
    .filter(function(name) {
      if (!name || name.toLowerCase() === "anonimo") return false;
      var key = name.toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
}

async function renderClientDatalist() {
  try {
    var names = await getClientNamesFromSupabase();
    var html = names.map(function(name) {
      return '<option value="' + escapeDepenseHtml(name) + '"></option>';
    }).join("");

    document.querySelectorAll("#list-client").forEach(function(list) {
      list.innerHTML = html;
    });
  } catch (e) {
    console.error("Erro lista clientes:", e);
  }
}

async function loadClientDetail() {
  var nom = (document.getElementById("cli-search").value || "").trim();

  if (!nom) {
    toast("Entra um nome de cliente!", "error");
    return;
  }

  var el = document.getElementById("cli-result");
  el.innerHTML = '<div class="empty">A carregar...</div>';

  try {
    var data = await getClientFicheFromSupabase(nom);
    var initial = String(data.name || nom || "?").trim().charAt(0).toUpperCase();

    var html =
      '<div style="display:grid;gap:16px;">' +

        '<div style="background:#fff;border:1px solid var(--border);border-radius:18px;padding:18px;box-shadow:0 12px 30px rgba(0,0,0,.06);">' +
          '<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">' +
            '<div style="width:56px;height:56px;border-radius:16px;background:rgba(91,155,213,.14);color:var(--blue);display:grid;place-items:center;font-size:24px;font-weight:900;">' +
              escapeDepenseHtml(initial) +
            '</div>' +
            '<div>' +
              '<div style="font-family:Playfair Display,serif;font-size:25px;font-weight:800;">' + escapeDepenseHtml(data.name || nom) + '</div>' +
              '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Ficha do cliente</div>' +
            '</div>' +
          '</div>' +

          '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">' +
            '<div style="background:var(--surface2);border-radius:14px;padding:14px;">' +
              '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Total compras</div>' +
              '<div style="margin-top:6px;font-family:Playfair Display,serif;font-size:22px;font-weight:900;color:var(--blue);">' + fmt(data.totalAchat || 0) + '</div>' +
            '</div>' +
            '<div style="background:var(--surface2);border-radius:14px;padding:14px;">' +
              '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Divida</div>' +
              '<div style="margin-top:6px;font-family:Playfair Display,serif;font-size:22px;font-weight:900;color:var(--red);">' + fmt(data.totalDette || 0) + '</div>' +
            '</div>' +
            '<div style="background:var(--surface2);border-radius:14px;padding:14px;">' +
              '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Transacoes</div>' +
              '<div style="margin-top:6px;font-family:Playfair Display,serif;font-size:22px;font-weight:900;color:var(--blue);">' + (data.transactions || 0) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div style="background:#fff;border:1px solid var(--border);border-radius:18px;padding:16px;box-shadow:0 12px 30px rgba(0,0,0,.04);">' +
          '<div class="card-title">Historico</div>';

    if (data.historique && data.historique.length > 0) {
      html += '<div style="display:grid;gap:10px;">';

      data.historique.forEach(function(a) {
        html +=
          '<div style="display:flex;justify-content:space-between;gap:12px;padding:12px;border-radius:14px;background:var(--surface2);">' +
            '<div>' +
              '<div style="font-size:11px;color:var(--orange);font-weight:800;">' + escapeDepenseHtml(a.date || "") + '</div>' +
              '<div style="margin-top:3px;font-size:14px;font-weight:800;">' + escapeDepenseHtml(a.prod || "") + '</div>' +
              '<div style="margin-top:3px;font-size:12px;color:var(--muted);">Quantidade: ' + (a.qty || 0) + '</div>' +
            '</div>' +
            '<div style="font-size:15px;font-weight:900;color:var(--blue);white-space:nowrap;">' + fmt(a.total || 0) + '</div>' +
          '</div>';
      });

      html += '</div>';
    } else {
      html += '<div class="empty">Nenhuma venda encontrada</div>';
    }

    html += '</div></div>';

    el.innerHTML = html;

  } catch (e) {
    console.error("Erro fiche client:", e);
    el.innerHTML = '<div class="empty">Erro ao carregar cliente</div>';
    toast("Erro fiche client: " + (e.message || e), "error");
  }
}
async function savePagamentoClient() {
  if (!requireAzulAction("client_payment:create", "registar pagamento cliente")) return;

  var data = {
    date: document.getElementById("c-date").value,
    client: document.getElementById("c-client").value.trim(),
    montant: parseFloat(document.getElementById("c-montant").value) || 0,
    note: document.getElementById("c-note").value.trim()
  };

  if (!data.client || data.montant <= 0) {
    toast("Preenche cliente e montant!", "error");
    return;
  }

  var btn = document.getElementById("pg-cl-btn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  try {
    await registerClientPaymentInSupabase(data);

    toast("Pagamento registado!", "success");

    document.getElementById("c-client").value = "";
    document.getElementById("c-montant").value = "";
    document.getElementById("c-note").value = "";
    document.getElementById("restePayClient").textContent = "0 kz";

  } catch (e) {
    console.error("Erro pagamento cliente:", e);
    toast("Erro pagamento cliente: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Pagamento";
      btn.style.opacity = "1";
    }
  }
}
// =============================================================================================
// ============== Affichage reste a payer pour dette client et fournisseur =====================
// =============================================================================================

function updateResteAPayer(totalDu) {
  var cur = window._currency || 'Kz';
  var totalPaye = paiementLines.reduce(function(s,p) { return s+(p.montant||0); }, 0);
  var reste = Math.max(0, totalDu - totalPaye);
  var pe = document.getElementById('a-total-paye');
  var re = document.getElementById('a-reste-payer');
  if (pe) pe.textContent = new Intl.NumberFormat('pt-PT').format(totalPaye)+' '+cur;
  if (re) { re.textContent = new Intl.NumberFormat('pt-PT').format(reste)+' '+cur; re.style.color = reste>0?'var(--red)':'var(--green)'; }
}

async function updateResteApayerClient() {
  var cur = window._currency || "Kz";
  var client = (document.getElementById("c-client") || {}).value || "";
  var el = document.getElementById("restePayClient");

  if (!el || !client.trim()) {
    if (el) el.textContent = "0 " + cur;
    return;
  }

  try {
    var reste = await getClientDebtFromSupabase(client.trim());
    el.textContent = new Intl.NumberFormat("pt-PT").format(reste) + " " + cur;
  } catch (e) {
    console.error("Erro getClientDebt:", e);
  }
}

async function updateResteApayerFourn() {
  var cur = window._currency || "Kz";
  var fournisseur = (document.getElementById("p-forn") || {}).value || "";
  var el = document.getElementById("restePayFourn");

  if (!el || !fournisseur.trim()) {
    if (el) el.textContent = "0 " + cur;
    return;
  }

  try {
    var reste = await getSupplierDebtFromSupabase(fournisseur.trim());
    el.textContent = new Intl.NumberFormat("pt-PT").format(reste) + " " + cur;
  } catch (e) {
    console.error("Erro getSupplierDebt:", e);
  }
}
async function upsertSupplierToSupabase(data) {
  var organizationId = getAzulOrganizationId();
  var name = String(data.name || data.nome || data.forn || "").trim();

  if (!name) throw new Error("Nome do fornecedor obrigatorio.");

  var result = await supabaseClient.rpc("upsert_supplier_for_org", {
    p_organization_id: organizationId,
    p_name: name,
    p_phone: data.phone || data.tel || "",
    p_country: data.country || data.pais || "",
    p_note: data.note || data.nota || ""
  });

  if (result.error) throw result.error;

  return result.data || { name: name };
}
async function getSuppliersFromSupabase() {
  var organizationId = getAzulOrganizationId();

  var result = await supabaseClient
    .from("suppliers")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (result.error) throw result.error;

  return result.data || [];
}

async function renderSupplierDatalists() {
  try {
    var suppliers = await getSuppliersFromSupabase();

    var html = suppliers.map(function(supplier) {
      return '<option value="' + escapeDepenseHtml(supplier.name || "") + '"></option>';
    }).join("");

    ["list-forn", "list-pay-forn", "list-supplier-fiche"].forEach(function(id) {
      document.querySelectorAll("#" + id).forEach(function(list) {
        list.innerHTML = html;
      });
    });

  } catch (e) {
    console.error("Erro fornecedores datalist:", e);
  }
}

async function getSupplierDirectoryFromSupabase() {
  var organizationId = getAzulOrganizationId();
  var suppliers = await getSuppliersFromSupabase();

  var purchasesResult = await supabaseClient
    .from("purchases")
    .select("supplier")
    .eq("organization_id", organizationId)
    .not("supplier", "is", null)
    .order("created_at", { ascending: false });

  if (purchasesResult.error) throw purchasesResult.error;

  var map = {};

  suppliers.forEach(function(supplier) {
    var name = String(supplier.name || "").trim();
    if (!name) return;
    map[name.toLowerCase()] = supplier;
  });

  (purchasesResult.data || []).forEach(function(row) {
    var name = String(row.supplier || "").trim();
    if (!name) return;
    if (!map[name.toLowerCase()]) {
      map[name.toLowerCase()] = {
        name: name,
        phone: "",
        country: "",
        note: ""
      };
    }
  });

  return Object.keys(map).map(function(key) {
    return map[key];
  }).sort(function(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

async function renderSupplierDirectory() {
  var el = document.getElementById("supplier-directory");
  if (!el) return;

  el.innerHTML = '<div class="empty">A carregar fornecedores...</div>';

  try {
    var searchEl = document.getElementById("supplier-fiche-search");
    var search = String(searchEl ? searchEl.value : "").trim().toLowerCase();

    var suppliers = await getSupplierDirectoryFromSupabase();

    if (search) {
      suppliers = suppliers.filter(function(supplier) {
        return String(supplier.name || "").toLowerCase().indexOf(search) >= 0;
      });
    }

    if (!suppliers.length) {
      el.innerHTML = '<div class="empty">Aucun fournisseur trouvé.</div>';
      return;
    }

    el.innerHTML = suppliers.map(function(supplier) {
      var initial = String(supplier.name || "?").charAt(0).toUpperCase();

      return '' +
        '<button type="button" class="supplier-card-btn" data-name="' + escapeDepenseHtml(supplier.name || "") + '" onclick="openSupplierFicheFromCard(this)">' +
          '<span class="supplier-avatar">' + escapeDepenseHtml(initial) + '</span>' +
          '<span class="supplier-card-text">' +
            '<strong>' + escapeDepenseHtml(supplier.name || "") + '</strong>' +
            '<small>' + escapeDepenseHtml(supplier.phone || supplier.country || "Sans contact") + '</small>' +
          '</span>' +
        '</button>';
    }).join("");

  } catch (e) {
    console.error("Erro fornecedores:", e);
    el.innerHTML = '<div class="empty">Erreur ao carregar fornecedores.</div>';
  }
}

function openSupplierFicheFromCard(btn) {
  var name = btn.getAttribute("data-name") || "";
  var input = document.getElementById("supplier-fiche-search");
  if (input) input.value = name;
  loadSupplierFiche(name);
}

async function getSupplierFicheFromSupabase(name) {
  var organizationId = getAzulOrganizationId();
  name = String(name || "").trim();

  if (!name) throw new Error("Fornecedor obrigatorio.");

  var supplierResult = await supabaseClient
    .from("suppliers")
    .select("*")
    .eq("organization_id", organizationId)
    .ilike("name", name)
    .limit(1);

  if (supplierResult.error) throw supplierResult.error;

  var supplier = supplierResult.data && supplierResult.data.length
    ? supplierResult.data[0]
    : { name: name, phone: "", country: "", note: "" };

  var purchasesResult = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .ilike("supplier", name)
    .order("created_at", { ascending: false });

  if (purchasesResult.error) throw purchasesResult.error;

  var paymentsResult = await supabaseClient
    .from("supplier_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .ilike("supplier", name)
    .order("payment_date", { ascending: false });

  if (paymentsResult.error) throw paymentsResult.error;

  var purchases = purchasesResult.data || [];
  var payments = paymentsResult.data || [];

  var purchaseItems = await fetchPurchaseItemsByPurchaseIds(purchases.map(function(p) {
    return p.id;
  }));

  var itemsByPurchase = {};
  purchaseItems.forEach(function(item) {
    if (!itemsByPurchase[item.purchase_id]) itemsByPurchase[item.purchase_id] = [];
    itemsByPurchase[item.purchase_id].push(item);
  });

  var totalCompras = purchases.reduce(function(sum, p) {
    return sum + (Number(p.total) || 0);
  }, 0);

  var totalPago = purchases.reduce(function(sum, p) {
    return sum + (Number(p.paid_amount) || 0);
  }, 0);

  var saldo = purchases.reduce(function(sum, p) {
    return sum + (Number(p.remaining_amount) || 0);
  }, 0);

  return {
    supplier: supplier,
    purchases: purchases,
    payments: payments,
    itemsByPurchase: itemsByPurchase,
    totalCompras: totalCompras,
    totalPago: totalPago,
    saldo: saldo
  };
}

async function loadSupplierFiche(name) {
  var input = document.getElementById("supplier-fiche-search");
  name = String(name || (input ? input.value : "") || "").trim();

  if (!name) {
    toast("Escolhe um fornecedor.", "error");
    return;
  }

  var el = document.getElementById("supplier-fiche-result");
  if (!el) return;

  el.innerHTML = '<div class="empty">A carregar fiche fournisseur...</div>';

  try {
    var data = await getSupplierFicheFromSupabase(name);
    var supplier = data.supplier || {};
    var initial = String(supplier.name || name || "?").charAt(0).toUpperCase();

    var purchasesHtml = data.purchases.length
      ? data.purchases.map(function(purchase) {
          var items = data.itemsByPurchase[purchase.id] || [];

          var itemsHtml = items.length
            ? items.map(function(item) {
                return '<div class="supplier-line-item">' +
                  '<span>' + escapeDepenseHtml(item.product_name || "Produto") + '</span>' +
                  '<strong>' + (Number(item.quantity) || 0) + ' x ' + fmt(Number(item.purchase_price) || 0) + '</strong>' +
                '</div>';
              }).join("")
            : '<div class="muted">Sem artigos detalhados</div>';

          return '<div class="supplier-history-card">' +
            '<div class="supplier-history-head">' +
              '<div>' +
                '<strong>Achat #' + escapeDepenseHtml(String(purchase.id || "").slice(0, 8)) + '</strong>' +
                '<small>' + escapeDepenseHtml(String(purchase.created_at || "").slice(0, 10)) + '</small>' +
                renderActionAuthor(purchase) +
              '</div>' +
              '<div class="supplier-history-total">' + fmt(Number(purchase.total) || 0) + '</div>' +
            '</div>' +
            itemsHtml +
            '<div class="supplier-history-foot">' +
              '<span>Pago: ' + fmt(Number(purchase.paid_amount) || 0) + '</span>' +
              '<span>Reste: ' + fmt(Number(purchase.remaining_amount) || 0) + '</span>' +
            '</div>' +
          '</div>';
        }).join("")
      : '<div class="empty">Aucun achat trouvé.</div>';

    var paymentsHtml = data.payments.length
      ? data.payments.map(function(payment) {
          return '<div class="supplier-payment-row">' +
            '<div>' +
              '<strong>' + fmt(Number(payment.amount) || 0) + '</strong>' +
              '<small>' + escapeDepenseHtml(payment.note || "Paiement fournisseur") + '</small>' +
              renderActionAuthor(payment) +
            '</div>' +
            '<span>' + escapeDepenseHtml(payment.payment_date || "") + '</span>' +
          '</div>';
        }).join("")
      : '<div class="empty">Aucun paiement trouvé.</div>';

    el.innerHTML =
      '<div class="supplier-profile-card">' +
        '<div class="supplier-profile-top">' +
          '<div class="supplier-profile-avatar">' + escapeDepenseHtml(initial) + '</div>' +
          '<div>' +
            '<h3>' + escapeDepenseHtml(supplier.name || name) + '</h3>' +
            '<p>' + escapeDepenseHtml(supplier.phone || "Sans telephone") + '</p>' +
            '<p>' + escapeDepenseHtml(supplier.country || "Sans pays") + '</p>' +
          '</div>' +
        '</div>' +

        '<div class="supplier-note">' + escapeDepenseHtml(supplier.note || "Aucune note fournisseur.") + '</div>' +

        '<div class="supplier-kpis">' +
          '<div><span>Total achats</span><strong>' + fmt(data.totalCompras) + '</strong></div>' +
          '<div><span>Total paye</span><strong>' + fmt(data.totalPago) + '</strong></div>' +
          '<div><span>Dette</span><strong class="' + (data.saldo > 0 ? "text-red" : "text-green") + '">' + fmt(data.saldo) + '</strong></div>' +
        '</div>' +
      '</div>' +

      '<div class="supplier-two-cols">' +
        '<div class="card">' +
          '<div class="card-title">Historique des achats</div>' +
          purchasesHtml +
        '</div>' +
        '<div class="card">' +
          '<div class="card-title">Paiements</div>' +
          paymentsHtml +
        '</div>' +
      '</div>';

  } catch (e) {
    console.error("Erreur fiche fournisseur:", e);
    el.innerHTML = '<div class="empty">Erreur fiche fournisseur.</div>';
    toast("Erreur fiche fournisseur: " + (e.message || e), "error");
  }
}

var purchaseImportRows = [];
var purchaseImportRunning = false;

function downloadPurchaseCsvTemplate() {
  var csv =
    "date;supplier;designation;quantity;unit_price;total_amount;category;code;variation;photo;sale_price;payment_status;paid_amount\n" +
    "2026-05-19;Fornecedor Test;Tshirt Gucci;10;15000;150000;Roupa;TSH-001;M | Preto;;27000;paid;\n" +
    "2026-05-19;Fornecedor Test;Blazer Classico;5;27000;135000;Roupa;BLA-001;L | Branco;;45000;credit;50000\n";

  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");

  a.href = url;
  a.download = "azul_purchase_import_template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function detectCsvDelimiter(firstLine) {
  var semicolon = (firstLine.match(/;/g) || []).length;
  var comma = (firstLine.match(/,/g) || []).length;
  var tab = (firstLine.match(/\t/g) || []).length;

  if (semicolon >= comma && semicolon >= tab) return ";";
  if (tab >= comma) return "\t";
  return ",";
}

function parseCsvLine(line, delimiter) {
  var values = [];
  var current = "";
  var insideQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var char = line[i];
    var nextChar = line[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      current += '"';
      i++;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === delimiter && !insideQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function normalizeCsvHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "");
}

function parseCsvText(text, requiredHeaders) {
  var lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter(function(line) {
      return line.trim();
    });

  if (lines.length < 2) {
    throw new Error("Le fichier CSV est vide ou sans donnees.");
  }

  var delimiter = detectCsvDelimiter(lines[0]);
  var headers = parseCsvLine(lines[0], delimiter).map(normalizeCsvHeader);

  requiredHeaders = requiredHeaders || [];

  var missingHeaders = requiredHeaders.filter(function(header) {
    return headers.indexOf(header) === -1;
  });

  if (missingHeaders.length) {
    throw new Error("Colonnes manquantes: " + missingHeaders.join(", "));
  }

  return lines.slice(1).map(function(line) {
    var values = parseCsvLine(line, delimiter);
    var row = {};

    headers.forEach(function(header, index) {
      row[header] = values[index] || "";
    });

    return row;
  });
}

function parseImportNumber(value) {
  var clean = String(value || "")
    .replace(/Kz/gi, "")
    .replace(/AOA/gi, "")
    .replace(/[^\d,.-]/g, "")
    .trim();

  if (!clean) return 0;

  if (clean.indexOf(",") >= 0 && clean.indexOf(".") >= 0) {
    clean = clean.replace(/\./g, "").replace(",", ".");
  } else if (clean.indexOf(",") >= 0) {
    clean = clean.replace(",", ".");
  } else {
    clean = clean.replace(/\.(?=\d{3}(\D|$))/g, "");
  }

  return Number(clean) || 0;
}
function normalizeImportDate(value) {
  var raw = String(value || "").trim();

  if (!raw) {
    return new Date().toISOString().split("T")[0];
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  var match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return match[3] + "-" + String(match[2]).padStart(2, "0") + "-" + String(match[1]).padStart(2, "0");
  }

  return new Date().toISOString().split("T")[0];
}

function mapPurchaseImportRow(row, index) {
  var qty = parseImportNumber(row.quantity);
  var unitPrice = parseImportNumber(row.unit_price);
  var totalAmount = parseImportNumber(row.total_amount);

  if (!unitPrice && totalAmount && qty) {
    unitPrice = totalAmount / qty;
  }

  return {
    line: index + 2,
    date: normalizeImportDate(row.date),
    supplier: String(row.supplier || "").trim(),
    designation: String(row.designation || "").trim(),
    quantity: qty,
    unitPrice: unitPrice,
    totalAmount: totalAmount || qty * unitPrice,
    category: String(row.category || "").trim(),
    code: String(row.code || "").trim(),
    variation: String(row.variation || "").trim(),
    photo: String(row.photo || "").trim(),
    salePrice: parseImportNumber(row.sale_price),
    paymentStatus: String(row.payment_status || "paid").trim().toLowerCase(),
    paidAmount: parseImportNumber(row.paid_amount),
    valid: true,
    error: ""
  };
}

function validatePurchaseImportRow(row) {
  if (!row.supplier) return "Fournisseur obligatoire";
  if (!row.designation) return "Designation obligatoire";
  if (!row.quantity || row.quantity <= 0) return "Quantite invalide";
  if (!row.unitPrice || row.unitPrice <= 0) return "Prix unitaire invalide";
  if (row.paymentStatus !== "paid" && row.paymentStatus !== "credit") {
  return "payment_status doit etre paid ou credit";
  }
  return "";
}

function handlePurchaseCsvFile(event) {
  var file = event.target.files && event.target.files[0];

  if (!file) return;

  var reader = new FileReader();

  reader.onload = function(e) {
    try {
      var rawRows = parseCsvText(e.target.result || "", ["supplier", "designation", "quantity", "unit_price"]);

      purchaseImportRows = rawRows.map(function(row, index) {
        var mapped = mapPurchaseImportRow(row, index);
        mapped.error = validatePurchaseImportRow(mapped);
        mapped.valid = !mapped.error;
        return mapped;
      });

      renderPurchaseImportPreview();
    } catch (err) {
      purchaseImportRows = [];
      renderPurchaseImportPreview();
      toast("Erreur CSV: " + (err.message || err), "error");
    }
  };

  reader.readAsText(file, "UTF-8");
}

function renderPurchaseImportPreview() {
  var body = document.getElementById("purchase-import-preview");
  var summary = document.getElementById("purchase-import-summary");

  if (!body || !summary) return;

  if (!purchaseImportRows.length) {
    summary.textContent = "Aucun fichier selectionne.";
    body.innerHTML = '<tr><td colspan="10" class="empty">Le preview apparait ici</td></tr>';
    return;
  }

  var validRows = purchaseImportRows.filter(function(row) { return row.valid; });
  var invalidRows = purchaseImportRows.filter(function(row) { return !row.valid; });
  var total = validRows.reduce(function(sum, row) {
    return sum + row.quantity * row.unitPrice;
  }, 0);

  summary.innerHTML =
    '<strong>' + validRows.length + '</strong> lignes valides | ' +
    '<strong>' + invalidRows.length + '</strong> erreurs | Total: <strong>' + fmt(total) + '</strong>';

  body.innerHTML = purchaseImportRows.slice(0, 80).map(function(row) {
    var bg = row.valid ? "" : ' style="background:rgba(224,92,92,0.08);"';

    return '<tr' + bg + '>' +
      '<td>' + escapeDepenseHtml(row.date) + '</td>' +
      '<td>' + escapeDepenseHtml(row.supplier) + '</td>' +
      '<td>' + escapeDepenseHtml(row.designation || row.error) + '</td>' +
      '<td>' + escapeDepenseHtml(row.quantity) + '</td>' +
      '<td>' + escapeDepenseHtml(row.unitPrice) + '</td>' +
      '<td>' + escapeDepenseHtml(row.salePrice) + '</td>' +
      '<td>' + escapeDepenseHtml(row.category) + '</td>' +
      '<td>' + escapeDepenseHtml(row.code) + '</td>' +
      '<td>' + escapeDepenseHtml(row.variation) + '</td>' +
      '<td>' + escapeDepenseHtml(row.paymentStatus === "credit" ? "Credit" : "Paye") + '</td>' +
    '</tr>';
  }).join("");
}

function chunkImportArray(list, size) {
  var chunks = [];

  if (!Array.isArray(list)) {
    return chunks;
  }

  size = Number(size) || 100;

  for (var i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }

  return chunks;
}

async function fetchSaleItemsBySaleIds(saleIds) {
  var allItems = [];
  var ids = (saleIds || []).filter(Boolean);

  for (var i = 0; i < chunkImportArray(ids, 80).length; i++) {
    var chunk = chunkImportArray(ids, 80)[i];

    if (!chunk.length) continue;

    var result = await supabaseClient
      .from("sale_items")
      .select("*")
      .in("sale_id", chunk);

    if (result.error) throw result.error;

    allItems = allItems.concat(result.data || []);
  }

  return allItems;
}

async function fetchPurchaseItemsByPurchaseIds(purchaseIds) {
  var allItems = [];
  var ids = (purchaseIds || []).filter(Boolean);

  for (var i = 0; i < chunkImportArray(ids, 80).length; i++) {
    var chunk = chunkImportArray(ids, 80)[i];

    if (!chunk.length) continue;

    var result = await supabaseClient
      .from("purchase_items")
      .select("*")
      .in("purchase_id", chunk);

    if (result.error) throw result.error;

    allItems = allItems.concat(result.data || []);
  }

  return allItems;
}

function addInventoryMove(summary, productId, productName, field, qty) {
  qty = Number(qty) || 0;
  if (qty <= 0) return;

  var keys = [];

  if (productId) keys.push("id:" + productId);
  if (productName) keys.push("name:" + normalizeImportText(productName));

  keys.forEach(function(key) {
    if (!summary[key]) summary[key] = { entries: 0, exits: 0 };
    summary[key][field] += qty;
  });
}

async function getInventoryMovementSummaryFromSupabase() {
  var organizationId = getAzulOrganizationId();
  var summary = {};

  var purchasesResult = await supabaseClient
    .from("purchases")
    .select("id")
    .eq("organization_id", organizationId);

  if (purchasesResult.error) throw purchasesResult.error;

  var purchaseItems = await fetchPurchaseItemsByPurchaseIds((purchasesResult.data || []).map(function(row) {
    return row.id;
  }));

  purchaseItems.forEach(function(item) {
    addInventoryMove(summary, item.product_id, item.product_name, "entries", item.quantity);
  });

  var salesResult = await supabaseClient
    .from("sales")
    .select("id,sale_type")
    .eq("organization_id", organizationId);

  if (salesResult.error) throw salesResult.error;

  var saleById = {};
  (salesResult.data || []).forEach(function(sale) {
    saleById[sale.id] = sale;
  });

  var saleItems = await fetchSaleItemsBySaleIds((salesResult.data || []).map(function(row) {
    return row.id;
  }));

  saleItems.forEach(function(item) {
    var sale = saleById[item.sale_id] || {};
    if (String(sale.sale_type || "").toLowerCase() === "externo") return;

    addInventoryMove(summary, item.product_id, item.product_name, "exits", item.quantity);
  });

  return summary;
}

function applyInventoryMovementSummary(productList, summary) {
  summary = summary || {};

  return (productList || []).map(function(product) {
    var byId = summary["id:" + product.id];
    var byName = summary["name:" + normalizeImportText(product.name)];
    var movement = byId || byName || { entries: 0, exits: 0 };

    product.entries = Number(movement.entries) || 0;
    product.exits = Number(movement.exits) || 0;

    return product;
  });
}
function getPurchaseImportDuplicateKey(row) {
  return [
    normalizeImportText(row.date),
    normalizeImportText(row.supplier),
    normalizeImportText(row.designation || row.product_name),
    normalizeImportText(row.code),
    normalizeImportText(row.variation),
    String(Number(row.quantity) || 0),
    String(Number(row.unitPrice || row.purchase_price) || 0),
    String(Number(row.salePrice || row.sale_price) || 0)
  ].join("|");
}

async function fetchExistingPurchaseImportKeys(rows) {
  var organizationId = getAzulOrganizationId();
  var existing = {};
  var dates = [];
  var suppliers = [];

  (rows || []).forEach(function(row) {
    if (row.date && dates.indexOf(row.date) === -1) dates.push(row.date);
    if (row.supplier && suppliers.indexOf(row.supplier) === -1) suppliers.push(row.supplier);
  });

  if (!dates.length) return existing;

  dates.sort();

  var minDate = dates[0] + "T00:00:00";
  var maxDate = dates[dates.length - 1] + "T23:59:59";
  var purchases = [];

  for (var i = 0; i < chunkImportArray(suppliers, 80).length; i++) {
    var supplierChunk = chunkImportArray(suppliers, 80)[i];

    if (!supplierChunk.length) continue;

    var result = await supabaseClient
      .from("purchases")
      .select("id,supplier,created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", minDate)
      .lte("created_at", maxDate)
      .in("supplier", supplierChunk);

    if (result.error) throw result.error;

    purchases = purchases.concat(result.data || []);
  }

  var purchaseById = {};
  purchases.forEach(function(purchase) {
    purchaseById[purchase.id] = purchase;
  });

  var purchaseItems = await fetchPurchaseItemsByPurchaseIds(purchases.map(function(purchase) {
    return purchase.id;
  }));

  purchaseItems.forEach(function(item) {
    var purchase = purchaseById[item.purchase_id];
    if (!purchase) return;

    existing[getPurchaseImportDuplicateKey({
      date: String(purchase.created_at || "").slice(0, 10),
      supplier: purchase.supplier,
      designation: item.product_name,
      code: item.code,
      variation: item.variation,
      quantity: item.quantity,
      unitPrice: item.purchase_price,
      salePrice: item.sale_price
    })] = true;
  });

  return existing;
}

function getSaleImportDuplicateKey(row) {
  return [
    normalizeImportText(row.date),
    normalizeImportText(row.client || "Anonimo"),
    normalizeImportText(row.designation || row.product_name),
    normalizeImportText(row.origin || row.sale_type),
    String(Number(row.quantity) || 0),
    String(Number(row.unitPrice || row.unit_price) || 0),
    String(Number(row.totalAmount || row.total) || 0)
  ].join("|");
}

async function fetchExistingSaleImportKeys(rows) {
  var organizationId = getAzulOrganizationId();
  var existing = {
    keys: {},
    receipts: {}
  };

  var dates = [];

  (rows || []).forEach(function(row) {
    if (row.date && dates.indexOf(row.date) === -1) dates.push(row.date);
  });

  if (!dates.length) return existing;

  dates.sort();

  var result = await supabaseClient
    .from("sales")
    .select("id,receipt_no,sale_date,client_name,sale_type,total")
    .eq("organization_id", organizationId)
    .gte("sale_date", dates[0])
    .lte("sale_date", dates[dates.length - 1]);

  if (result.error) throw result.error;

  var sales = result.data || [];
  var saleById = {};

  sales.forEach(function(sale) {
    saleById[sale.id] = sale;

    if (sale.receipt_no) {
      existing.receipts[String(sale.receipt_no).trim()] = true;
    }
  });

  var saleItems = await fetchSaleItemsBySaleIds(sales.map(function(sale) {
    return sale.id;
  }));

  saleItems.forEach(function(item) {
    var sale = saleById[item.sale_id];
    if (!sale) return;

    existing.keys[getSaleImportDuplicateKey({
      date: sale.sale_date,
      client: sale.client_name,
      designation: item.product_name,
      origin: sale.sale_type,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      totalAmount: item.total
    })] = true;
  });

  return existing;
}

function normalizeImportText(value) {
  return String(value || "").trim().toLowerCase();
}

function getPurchaseImportProductKey(data) {
  var code = normalizeImportText(data.code);

  if (code) {
    return "code:" + code;
  }

  return [
    "product",
    normalizeImportText(data.designation || data.name),
    normalizeImportText(data.variation),
    Number(data.unitPrice || data.purchasePrice || 0) || 0,
    Number(data.salePrice || 0) || 0
  ].join("||");
}

async function fetchImportProducts(productNames, productCodes) {
  var organizationId = getAzulOrganizationId();
  var productsByKey = {};

  async function addRows(result) {
    if (result.error) throw result.error;

    (result.data || []).forEach(function(product) {
      var key = getPurchaseImportProductKey({
        code: product.code || "",
        designation: product.name || "",
        variation: product.variation || "",
        unitPrice: Number(product.purchase_price) || 0,
        salePrice: Number(product.sale_price) || 0
      });

      if (!productsByKey[key]) {
        productsByKey[key] = product;
      }
    });
  }

  for (var c = 0; c < chunkImportArray(productCodes, 80).length; c++) {
    var codeChunk = chunkImportArray(productCodes, 80)[c];

    if (!codeChunk.length) continue;

    await addRows(await supabaseClient
      .from("products")
      .select("*")
      .eq("organization_id", organizationId)
      .in("code", codeChunk)
      .order("created_at", { ascending: false }));
  }

  for (var n = 0; n < chunkImportArray(productNames, 80).length; n++) {
    var nameChunk = chunkImportArray(productNames, 80)[n];

    if (!nameChunk.length) continue;

    await addRows(await supabaseClient
      .from("products")
      .select("*")
      .eq("organization_id", organizationId)
      .in("name", nameChunk)
      .order("created_at", { ascending: false }));
  }

  return productsByKey;
}

async function ensureImportSuppliers(rows) {
  var organizationId = getAzulOrganizationId();
  var supplierNames = [];

  rows.forEach(function(row) {
    if (row.supplier && supplierNames.indexOf(row.supplier) === -1) {
      supplierNames.push(row.supplier);
    }
  });

  if (!supplierNames.length) return;

  var existingNames = {};

  for (var i = 0; i < chunkImportArray(supplierNames, 80).length; i++) {
    var chunk = chunkImportArray(supplierNames, 80)[i];

    var existing = await supabaseClient
      .from("suppliers")
      .select("name")
      .eq("organization_id", organizationId)
      .in("name", chunk);

    if (existing.error) throw existing.error;

    (existing.data || []).forEach(function(row) {
      existingNames[normalizeImportText(row.name)] = true;
    });
  }

  var toInsert = supplierNames
    .filter(function(name) {
      return !existingNames[normalizeImportText(name)];
    })
    .map(function(name) {
      return {
        organization_id: organizationId,
        name: name,
        phone: "",
        country: "",
        note: ""
      };
    });

  for (var j = 0; j < chunkImportArray(toInsert, 200).length; j++) {
    var insertChunk = chunkImportArray(toInsert, 200)[j];

    if (!insertChunk.length) continue;

    var insertResult = await supabaseClient
      .from("suppliers")
      .insert(insertChunk);

    if (insertResult.error) throw insertResult.error;
  }
}

async function createImportPurchaseAccountingBatch(purchaseGroupList) {
  var organizationId = getAzulOrganizationId();
  var entryRows = [];

  purchaseGroupList.forEach(function(group) {
    if (!group.purchase) return;

    entryRows.push({
      organization_id: organizationId,
      source_type: "purchase",
      source_id: group.purchase.id,
      entry_date: String(group.purchase.created_at || "").slice(0, 10),
      description: "Import achat fournisseur " + group.supplier
    });
  });

  if (!entryRows.length) return;

  var insertedEntries = [];

  for (var i = 0; i < chunkImportArray(entryRows, 300).length; i++) {
    var chunk = chunkImportArray(entryRows, 300)[i];

    var entryResult = await supabaseClient
      .from("accounting_entries")
      .insert(chunk)
      .select("id,source_id");

    if (entryResult.error) throw entryResult.error;

    insertedEntries = insertedEntries.concat(entryResult.data || []);
  }

  var entryBySourceId = {};

  insertedEntries.forEach(function(entry) {
    entryBySourceId[String(entry.source_id)] = entry;
  });

  var lineRows = [];

  purchaseGroupList.forEach(function(group) {
    if (!group.purchase) return;

    var entry = entryBySourceId[String(group.purchase.id)];
    if (!entry) return;

    var total = Number(group.purchase.total) || 0;
    var paid = Number(group.purchase.paid_amount) || 0;
    var remaining = Number(group.purchase.remaining_amount) || 0;

    lineRows.push({
      organization_id: organizationId,
      entry_id: entry.id,
      account_code: "13",
      account_name: getAccountName("13"),
      debit: total,
      credit: 0
    });

    if (paid > 0) {
      lineRows.push({
        organization_id: organizationId,
        entry_id: entry.id,
        account_code: "11",
        account_name: getAccountName("11"),
        debit: 0,
        credit: paid
      });
    }

    if (remaining > 0) {
      lineRows.push({
        organization_id: organizationId,
        entry_id: entry.id,
        account_code: "21",
        account_name: getAccountName("21"),
        debit: 0,
        credit: remaining
      });
    }
  });

  for (var j = 0; j < chunkImportArray(lineRows, 500).length; j++) {
    var lineChunk = chunkImportArray(lineRows, 500)[j];

    if (!lineChunk.length) continue;

    var lineResult = await supabaseClient
      .from("accounting_lines")
      .insert(lineChunk);

    if (lineResult.error) throw lineResult.error;
  }
}

async function savePurchaseImportBatchToSupabase(rows) {
  var organizationId = getAzulOrganizationId();
  var validRows = (rows || []).filter(function(row) {
    return row && row.valid;
  });

  if (!validRows.length) {
    throw new Error("Aucune ligne valide a importer.");
  }

  var existingPurchaseKeys = await fetchExistingPurchaseImportKeys(validRows);
  var usedPurchaseKeys = {};
  var skippedDuplicates = 0;

  validRows = validRows.filter(function(row) {
    var key = getPurchaseImportDuplicateKey(row);

    if (existingPurchaseKeys[key] || usedPurchaseKeys[key]) {
      skippedDuplicates++;
      return false;
    }

    usedPurchaseKeys[key] = true;
    return true;
  });

  if (!validRows.length) {
    return {
      products: 0,
      purchases: 0,
      items: 0,
      skipped: skippedDuplicates
    };
  }

  await ensureImportSuppliers(validRows);

  var productNames = [];
  var productCodes = [];

  validRows.forEach(function(row) {
    if (row.designation && productNames.indexOf(row.designation) === -1) {
      productNames.push(row.designation);
    }

    if (row.code && productCodes.indexOf(row.code) === -1) {
      productCodes.push(row.code);
    }
  });

  var existingProducts = await fetchImportProducts(productNames, productCodes);
  var productGroups = {};

  validRows.forEach(function(row) {
    var key = getPurchaseImportProductKey(row);

    if (!productGroups[key]) {
      productGroups[key] = {
        key: key,
        name: row.designation,
        supplier: row.supplier,
        category: row.category,
        code: row.code,
        photo: row.photo,
        variation: row.variation,
        variations: parseVariationList(row.variation),
        purchasePrice: row.unitPrice,
        salePrice: row.salePrice,
        quantity: 0
      };
    }

    productGroups[key].quantity += Number(row.quantity) || 0;
  });

  var productIdByKey = {};
  var updateProducts = [];
  var insertProducts = [];

  Object.keys(productGroups).forEach(function(key) {
    var group = productGroups[key];
    var existing = existingProducts[key];

    if (existing) {
      productIdByKey[key] = existing.id;

      updateProducts.push({
        id: existing.id,
        organization_id: organizationId,
        name: existing.name || group.name,
        supplier: group.supplier || existing.supplier || "",
        category: group.category || existing.category || "",
        code: group.code || existing.code || "",
        photo: group.photo || existing.photo || "",
        variation: group.variation || existing.variation || "",
        variations: group.variations.length ? group.variations : existing.variations || [],
        purchase_price: group.purchasePrice || Number(existing.purchase_price) || 0,
        sale_price: group.salePrice || Number(existing.sale_price) || 0,
        stock_warehouse: (Number(existing.stock_warehouse) || 0) + group.quantity,
        stock_shop: Number(existing.stock_shop) || 0,
        min_stock: Number(existing.min_stock) || 0
      });
    } else {
      insertProducts.push({
        organization_id: organizationId,
        name: group.name,
        supplier: group.supplier || "",
        category: group.category || "",
        code: group.code || "",
        photo: group.photo || "",
        variation: group.variation || "",
        variations: group.variations || [],
        purchase_price: group.purchasePrice || 0,
        sale_price: group.salePrice || 0,
        stock_warehouse: group.quantity,
        stock_shop: 0,
        min_stock: 0
      });
    }
  });

  for (var u = 0; u < chunkImportArray(updateProducts, 200).length; u++) {
    var updateChunk = chunkImportArray(updateProducts, 200)[u];

    if (!updateChunk.length) continue;

    var updateResult = await supabaseClient
  .from("products")
  .upsert(updateChunk, { onConflict: "id" });

  if (updateResult.error) throw updateResult.error;
  }

  for (var p = 0; p < chunkImportArray(insertProducts, 200).length; p++) {
    var insertChunk = chunkImportArray(insertProducts, 200)[p];

    if (!insertChunk.length) continue;

    var insertResult = await supabaseClient
      .from("products")
      .insert(insertChunk)
      .select("id,name,code,variation,purchase_price,sale_price");

    if (insertResult.error) throw insertResult.error;

    (insertResult.data || []).forEach(function(product) {
      var key = getPurchaseImportProductKey({
        code: product.code || "",
        designation: product.name || "",
        variation: product.variation || "",
        unitPrice: Number(product.purchase_price) || 0,
        salePrice: Number(product.sale_price) || 0
      });

      productIdByKey[key] = product.id;
    });
  }

  var purchaseGroups = {};

  validRows.forEach(function(row) {
    var groupKey = row.date + "||" + row.supplier + "||" + row.paymentStatus;

    if (!purchaseGroups[groupKey]) {
      purchaseGroups[groupKey] = {
        key: groupKey,
        date: row.date,
        supplier: row.supplier,
        paymentStatus: row.paymentStatus,
        paidAmount: 0,
        total: 0,
        rows: []
      };
    }

    purchaseGroups[groupKey].paidAmount += Number(row.paidAmount) || 0;
    purchaseGroups[groupKey].total += (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0);
    purchaseGroups[groupKey].rows.push(row);
  });

  var purchaseGroupList = Object.keys(purchaseGroups).map(function(key) {
    return purchaseGroups[key];
  });

  var purchaseRows = purchaseGroupList.map(function(group) {
    var isCredit = group.paymentStatus === "credit";
    var paidAmount = isCredit ? Math.min(group.total, group.paidAmount || 0) : group.total;
    var remainingAmount = isCredit ? Math.max(0, group.total - paidAmount) : 0;

    return {
      organization_id: organizationId,
      supplier: group.supplier,
      total: group.total,
      paid_amount: paidAmount,
      remaining_amount: remainingAmount,
      is_credit: remainingAmount > 0,
      created_at: group.date ? group.date + "T12:00:00" : undefined
    };
  });

  var insertedPurchases = [];

  for (var pr = 0; pr < chunkImportArray(purchaseRows, 200).length; pr++) {
    var purchaseChunk = chunkImportArray(purchaseRows, 200)[pr];

    var purchaseResult = await insertRowsWithAzulAudit(
      "purchases",
      purchaseChunk,
      "id,supplier,total,paid_amount,remaining_amount,created_at"
    );

    if (purchaseResult.error) throw purchaseResult.error;

    insertedPurchases = insertedPurchases.concat(purchaseResult.data || []);
  }

  var purchaseItems = [];

  purchaseGroupList.forEach(function(group, index) {
    var purchase = insertedPurchases[index];

    if (!purchase) return;

    group.purchase = purchase;

    group.rows.forEach(function(row) {
      var productKey = getPurchaseImportProductKey(row);
      var productId = productIdByKey[productKey];

      if (!productId) {
        throw new Error("Produit non trouve apres import: " + row.designation);
      }

      purchaseItems.push({
        purchase_id: purchase.id,
        product_id: productId,
        product_name: row.designation,
        category: row.category || "",
        code: row.code || "",
        photo: row.photo || "",
        variation: row.variation || "",
        variations: parseVariationList(row.variation),
        purchase_price: row.unitPrice || 0,
        sale_price: row.salePrice || 0,
        quantity: row.quantity || 0,
        supplier: row.supplier
      });
    });
  });

  for (var pi = 0; pi < chunkImportArray(purchaseItems, 300).length; pi++) {
    var itemChunk = chunkImportArray(purchaseItems, 300)[pi];

    var itemResult = await supabaseClient
      .from("purchase_items")
      .insert(itemChunk);

    if (itemResult.error) throw itemResult.error;
  }

    await createImportPurchaseAccountingBatch(purchaseGroupList);

  return {
    products: Object.keys(productGroups).length,
    purchases: insertedPurchases.length,
    items: purchaseItems.length,
    skipped: skippedDuplicates
  };
}

async function importPurchaseCsvRows() {
  if (!requireAzulAction("import:create", "importar dados")) return;

  var log = document.getElementById("purchase-import-log");

  if (purchaseImportRunning) {
    toast("Importation deja en cours...", "error");
    return;
  }

  if (!purchaseImportRows.length) {
    toast("Choisis d'abord un fichier CSV.", "error");
    return;
  }

  var invalidRows = purchaseImportRows.filter(function(row) {
    return !row.valid;
  });

  if (invalidRows.length) {
    toast("Corrige les lignes invalides avant l'import.", "error");

    if (log) {
      log.innerHTML = invalidRows.map(function(row) {
        return "Ligne " + row.line + ": " + row.error;
      }).join("<br>");
    }

    return;
  }

  purchaseImportRunning = true;

  var importBtn = document.querySelector(".import-submit-btn");
  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = "Importation...";
    importBtn.style.opacity = "0.65";
  }

  try {
    if (log) {
      log.innerHTML = "Importation rapide en cours...";
    }

    var result = await savePurchaseImportBatchToSupabase(purchaseImportRows);

    toast("Import termine: " + result.items + " lignes importees, " + (result.skipped || 0) + " doublons ignores.", "success");
    
    purchaseImportRows = [];
    renderPurchaseImportPreview();

    var fileInput = document.getElementById("purchase-import-file");
    if (fileInput) fileInput.value = "";

    products = [];

    if (log) {
      log.innerHTML =
        "Import termine avec succes: " +
        result.items + " lignes, " +
        result.products + " produits, " +
        result.purchases + " achats. Doublons ignores: " + (result.skipped || 0) + ".";
    }
  } catch (e) {
    console.error("Erreur import achats:", e);
    toast("Erreur import: " + (e.message || e), "error");

    if (log) {
      log.innerHTML = "Erreur: " + escapeDepenseHtml(e.message || e);
    }
  } finally {
    purchaseImportRunning = false;

    var importBtnEnd = document.querySelector(".import-submit-btn");
    if (importBtnEnd) {
      importBtnEnd.disabled = false;
      importBtnEnd.textContent = "Importer achats";
      importBtnEnd.style.opacity = "1";
    }
  }
}
var saleImportRows = [];
var saleImportRunning = false;

function downloadSaleCsvTemplate() {
  var csv =
    "date;designation;quantity;unit_price;cash;express;card;credit;total_amount;purchase_price;profit;origin;seller;client;receipt_no\n" +
    "2026-05-19;Tshirt Gucci;2;15000;30000;0;0;0;30000;8000;14000;interno;Moussa;Joao Silva;\n" +
    "2026-05-19;Blazer Classico;1;45000;0;45000;0;0;45000;27000;18000;Externo;Moussa;Anonimo;\n" +
    "2026-05-19;Jeans Azul;1;12000;0;0;0;12000;12000;7000;5000;interno;Moussa;Carlos;\n";

  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");

  a.href = url;
  a.download = "azul_sales_import_template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function normalizeSaleOrigin(value) {
  var raw = String(value || "").trim().toLowerCase();

  if (!raw) return "interno";
  if (raw === "externo" || raw === "externa" || raw === "commande" || raw === "external") return "Externo";

  return "interno";
}

function buildSalePaymentLines(row) {
  var lines = [];

  if (row.cash > 0) lines.push({ method: "Cash", montant: row.cash });
  if (row.express > 0) lines.push({ method: "Express", montant: row.express });
  if (row.card > 0) lines.push({ method: "Cartao", montant: row.card });
  if (row.credit > 0) lines.push({ method: "Credito", montant: row.credit });

  if (!lines.length && row.totalAmount > 0) {
    lines.push({ method: "Cash", montant: row.totalAmount });
  }

  return lines;
}

function getSaleImportPaymentTotal(row) {
  return (Number(row.cash) || 0) +
    (Number(row.express) || 0) +
    (Number(row.card) || 0) +
    (Number(row.credit) || 0);
}

function mapSaleImportRow(row, index) {
  var qty = parseImportNumber(row.quantity);
  var unitPrice = parseImportNumber(row.unit_price);
  var totalAmount = parseImportNumber(row.total_amount);

  if (!totalAmount && qty && unitPrice) {
    totalAmount = qty * unitPrice;
  }

  if (!unitPrice && totalAmount && qty) {
    unitPrice = totalAmount / qty;
  }

  return {
    line: index + 2,
    date: normalizeImportDate(row.date),
    designation: String(row.designation || "").trim(),
    quantity: qty,
    unitPrice: unitPrice,
    cash: parseImportNumber(row.cash),
    express: parseImportNumber(row.express),
    card: parseImportNumber(row.card),
    credit: parseImportNumber(row.credit),
    totalAmount: totalAmount,
    purchasePrice: parseImportNumber(row.purchase_price),
    profit: parseImportNumber(row.profit),
    origin: normalizeSaleOrigin(row.origin),
    seller: String(row.seller || "").trim(),
    client: String(row.client || "Anonimo").trim() || "Anonimo",
    receiptNo: String(row.receipt_no || "").trim(),
    valid: true,
    error: ""
  };
}

function validateSaleImportRow(row) {
  if (!row.designation) return "Designation obligatoire";
  if (!row.quantity || row.quantity <= 0) return "Quantite invalide";
  if (!row.unitPrice || row.unitPrice <= 0) return "Prix unitaire invalide";
  if (!row.totalAmount || row.totalAmount <= 0) return "Montant total invalide";

  var payTotal = getSaleImportPaymentTotal(row);

  if (Math.abs(payTotal - row.totalAmount) > 0.01) {
    return "Paiements differents du total";
  }

  if (row.credit > 0 && (!row.client || row.client === "Anonimo")) {
    return "Credit exige un nom client";
  }

  return "";
}

function handleSaleCsvFile(event) {
  var file = event.target.files && event.target.files[0];

  if (!file) return;

  var reader = new FileReader();

  reader.onload = function(e) {
    try {
      var rawRows = parseCsvText(e.target.result || "", ["date", "designation", "quantity", "unit_price"]);

      saleImportRows = rawRows.map(function(row, index) {
        var mapped = mapSaleImportRow(row, index);
        mapped.error = validateSaleImportRow(mapped);
        mapped.valid = !mapped.error;
        return mapped;
      });

      renderSaleImportPreview();
    } catch (err) {
      saleImportRows = [];
      renderSaleImportPreview();
      toast("Erreur CSV ventes: " + (err.message || err), "error");
    }
  };

  reader.readAsText(file, "UTF-8");
}

function renderSaleImportPreview() {
  var body = document.getElementById("sale-import-preview");
  var summary = document.getElementById("sale-import-summary");

  if (!body || !summary) return;

  if (!saleImportRows.length) {
    summary.textContent = "Aucun fichier selectionne.";
    body.innerHTML = '<tr><td colspan="12" class="empty">Le preview des ventes apparait ici</td></tr>';
    return;
  }

  var validRows = saleImportRows.filter(function(row) { return row.valid; });
  var invalidRows = saleImportRows.filter(function(row) { return !row.valid; });
  var total = validRows.reduce(function(sum, row) {
    return sum + row.totalAmount;
  }, 0);

  summary.innerHTML =
    '<strong>' + validRows.length + '</strong> ventes valides | ' +
    '<strong>' + invalidRows.length + '</strong> erreurs | Total: <strong>' + fmt(total) + '</strong>';

  body.innerHTML = saleImportRows.slice(0, 100).map(function(row) {
    var bg = row.valid ? "" : ' style="background:rgba(224,92,92,0.08);"';

    return '<tr' + bg + '>' +
      '<td>' + escapeDepenseHtml(row.date) + '</td>' +
      '<td>' + escapeDepenseHtml(row.designation || row.error) + '</td>' +
      '<td>' + escapeDepenseHtml(row.quantity) + '</td>' +
      '<td>' + escapeDepenseHtml(row.unitPrice) + '</td>' +
      '<td>' + escapeDepenseHtml(row.cash) + '</td>' +
      '<td>' + escapeDepenseHtml(row.express) + '</td>' +
      '<td>' + escapeDepenseHtml(row.card) + '</td>' +
      '<td>' + escapeDepenseHtml(row.credit) + '</td>' +
      '<td>' + escapeDepenseHtml(row.totalAmount) + '</td>' +
      '<td>' + escapeDepenseHtml(row.origin) + '</td>' +
      '<td>' + escapeDepenseHtml(row.client) + '</td>' +
      '<td>' + escapeDepenseHtml(row.receiptNo || "Auto") + '</td>' +
    '</tr>';
  }).join("");
}

function getSaleImportProductKey(row) {
  return normalizeImportText(row.designation);
}

async function fetchSaleImportProducts(rows) {
  var organizationId = getAzulOrganizationId();
  var byName = {};
  var pageSize = 1000;
  var from = 0;

  while (true) {
    var result = await supabaseClient
      .from("products")
      .select("id,name,purchase_price,sale_price,stock_shop,stock_warehouse,supplier,variation,variations")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);

    if (result.error) throw result.error;

    (result.data || []).forEach(function(product) {
      var key = normalizeImportText(product.name);
      if (key && !byName[key]) byName[key] = product;
    });

    if (!result.data || result.data.length < pageSize) break;
    from += pageSize;
  }

  return byName;
}

async function createSaleImportAccountingBatch(sales) {
  var organizationId = getAzulOrganizationId();
  var entryRows = [];

  sales.forEach(function(item) {
    entryRows.push({
      organization_id: organizationId,
      source_type: "sale",
      source_id: item.sale.id,
      entry_date: item.sale.sale_date,
      description: "Import venda " + item.sale.receipt_no
    });
  });

  if (!entryRows.length) return;

  var insertedEntries = [];

  for (var i = 0; i < chunkImportArray(entryRows, 300).length; i++) {
    var chunk = chunkImportArray(entryRows, 300)[i];

    var entryResult = await supabaseClient
      .from("accounting_entries")
      .insert(chunk)
      .select("id,source_id");

    if (entryResult.error) throw entryResult.error;

    insertedEntries = insertedEntries.concat(entryResult.data || []);
  }

  var entryBySourceId = {};
  insertedEntries.forEach(function(entry) {
    entryBySourceId[String(entry.source_id)] = entry;
  });

  var lineRows = [];

  sales.forEach(function(item) {
    var entry = entryBySourceId[String(item.sale.id)];
    if (!entry) return;

    var row = item.row;
    var total = Number(row.totalAmount) || 0;
    var cost = (Number(row.purchasePrice) || 0) * (Number(row.quantity) || 0);
    var cashIn = (Number(row.cash) || 0) + (Number(row.express) || 0) + (Number(row.card) || 0);
    var credit = Number(row.credit) || 0;

    if (cashIn > 0) {
      lineRows.push({
        organization_id: organizationId,
        entry_id: entry.id,
        account_code: "11",
        account_name: getAccountName("11"),
        debit: cashIn,
        credit: 0
      });
    }

    if (credit > 0) {
      lineRows.push({
        organization_id: organizationId,
        entry_id: entry.id,
        account_code: "12",
        account_name: getAccountName("12"),
        debit: credit,
        credit: 0
      });
    }

    lineRows.push({
      organization_id: organizationId,
      entry_id: entry.id,
      account_code: "71",
      account_name: getAccountName("71"),
      debit: 0,
      credit: total
    });

    if (cost > 0) {
      lineRows.push({
        organization_id: organizationId,
        entry_id: entry.id,
        account_code: "61",
        account_name: getAccountName("61"),
        debit: cost,
        credit: 0
      });

      lineRows.push({
        organization_id: organizationId,
        entry_id: entry.id,
        account_code: row.origin === "Externo" ? "11" : "13",
        account_name: getAccountName(row.origin === "Externo" ? "11" : "13"),
        debit: 0,
        credit: cost
      });
    }
  });

  for (var j = 0; j < chunkImportArray(lineRows, 500).length; j++) {
    var lineChunk = chunkImportArray(lineRows, 500)[j];

    if (!lineChunk.length) continue;

    var lineResult = await supabaseClient
      .from("accounting_lines")
      .insert(lineChunk);

    if (lineResult.error) throw lineResult.error;
  }
}

async function createSaleImportClientDebts(sales) {
  var organizationId = getAzulOrganizationId();
  var debtRows = [];

  sales.forEach(function(item) {
    var credit = Number(item.row.credit) || 0;

    if (credit <= 0) return;

       debtRows.push({
      organization_id: organizationId,
      sale_id: item.sale.id,
      client_name: item.row.client,
      total_amount: credit,
      paid_amount: 0,
      remaining_amount: credit,
      status: "open"
    });
  });

  for (var i = 0; i < chunkImportArray(debtRows, 300).length; i++) {
    var chunk = chunkImportArray(debtRows, 300)[i];

    if (!chunk.length) continue;

    var result = await supabaseClient
      .from("client_debts")
      .insert(chunk);

    if (result.error) throw result.error;
  }
}

async function getExistingSaleReceipts(receiptNos) {
  var organizationId = getAzulOrganizationId();
  var existing = {};

  receiptNos = (receiptNos || []).filter(function(receipt) {
    return String(receipt || "").trim();
  });

  for (var i = 0; i < chunkImportArray(receiptNos, 100).length; i++) {
    var chunk = chunkImportArray(receiptNos, 100)[i];

    if (!chunk.length) continue;

    var result = await supabaseClient
      .from("sales")
      .select("receipt_no")
      .eq("organization_id", organizationId)
      .in("receipt_no", chunk);

    if (result.error) throw result.error;

    (result.data || []).forEach(function(row) {
      existing[String(row.receipt_no || "").trim()] = true;
    });
  }

  return existing;
}

async function saveSaleImportBatchToSupabase(rows) {
  var organizationId = getAzulOrganizationId();
  var validRows = (rows || []).filter(function(row) {
    return row && row.valid;
  });

  if (!validRows.length) {
    throw new Error("Aucune vente valide a importer.");
  }

  var existingSaleImport = await fetchExistingSaleImportKeys(validRows);
  var usedSaleKeys = {};
  var skippedDuplicates = 0;

  validRows = validRows.filter(function(row) {
    var receiptNo = String(row.receiptNo || "").trim();
    var key = getSaleImportDuplicateKey(row);

    if ((receiptNo && existingSaleImport.receipts[receiptNo]) || existingSaleImport.keys[key] || usedSaleKeys[key]) {
      skippedDuplicates++;
      return false;
    }

    usedSaleKeys[key] = true;
    return true;
  });

  if (!validRows.length) {
    return {
      sales: 0,
      items: 0,
      skipped: skippedDuplicates
    };
  }

  var productsByName = await fetchSaleImportProducts(validRows);
  var receiptSeed = Date.now();

  var requestedReceipts = validRows.map(function(row) {
    return row.receiptNo;
  }).filter(function(receipt) {
    return String(receipt || "").trim();
  });

  var existingReceipts = await getExistingSaleReceipts(requestedReceipts);
  var usedReceipts = {};

  var saleRows = validRows.map(function(row, index) {
    var receiptNo = String(row.receiptNo || "").trim();

    if (!receiptNo || existingReceipts[receiptNo] || usedReceipts[receiptNo]) {
      receiptNo = "AZ-IMP-" + receiptSeed + "-" + String(index + 1).padStart(4, "0");
    }

    usedReceipts[receiptNo] = true;

    var paymentLines = buildSalePaymentLines(row);

    return {
      organization_id: organizationId,
      receipt_no: receiptNo,
      client_name: row.client || "Anonimo",
      sale_date: row.date,
      sale_type: row.origin,
      total: row.totalAmount,
      profit: row.profit || ((row.unitPrice - row.purchasePrice) * row.quantity),
      payment_summary: getPaymentSummary(paymentLines),
      payment_lines: paymentLines
    };
  });

  var insertedSales = [];

  for (var s = 0; s < chunkImportArray(saleRows, 300).length; s++) {
    var saleChunk = chunkImportArray(saleRows, 300)[s];

    var saleResult = await insertRowsWithAzulAudit(
      "sales",
      saleChunk,
      "id,receipt_no,sale_date,total"
    );

    if (saleResult.error) throw saleResult.error;

    insertedSales = insertedSales.concat(saleResult.data || []);
  }

  var saleItems = [];
  var stockChanges = {};

  validRows.forEach(function(row, index) {
    var sale = insertedSales[index];

    if (!sale) {
      throw new Error("Vente importee introuvable a la ligne " + row.line);
    }

    var product = productsByName[getSaleImportProductKey(row)] || {};
    var purchasePrice = row.purchasePrice || Number(product.purchase_price) || 0;

    saleItems.push({
      sale_id: sale.id,
      product_id: product.id || null,
      product_name: row.designation,
      quantity: row.quantity,
      unit_price: row.unitPrice,
      total: row.totalAmount,
      purchase_price: purchasePrice,
      profit: row.profit || ((row.unitPrice - purchasePrice) * row.quantity),
      variation: product.variation || "",
      variations: product.variations || []
    });

    row.purchasePrice = purchasePrice;

    if (row.origin !== "Externo" && product.id) {
      if (!stockChanges[product.id]) {
        stockChanges[product.id] = {
          product: product,
          qty: 0
        };
      }

      stockChanges[product.id].qty += Number(row.quantity) || 0;
    }
  });

  for (var i = 0; i < chunkImportArray(saleItems, 500).length; i++) {
    var itemChunk = chunkImportArray(saleItems, 500)[i];

    var itemResult = await supabaseClient
      .from("sale_items")
      .insert(itemChunk);

    if (itemResult.error) throw itemResult.error;
  }

  var stockRows = Object.keys(stockChanges).map(function(productId) {
    var entry = stockChanges[productId];

    return {
      id: productId,
      stock_shop: Math.max(0, (Number(entry.product.stock_shop) || 0) - entry.qty)
    };
  });

  for (var st = 0; st < stockRows.length; st++) {
    var stockResult = await supabaseClient
      .from("products")
      .update({
        stock_shop: stockRows[st].stock_shop
      })
      .eq("id", stockRows[st].id)
      .eq("organization_id", organizationId);

    if (stockResult.error) throw stockResult.error;
  }

  var saleLinks = insertedSales.map(function(sale, index) {
    return {
      sale: sale,
      row: validRows[index]
    };
  });

  await createSaleImportClientDebts(saleLinks);
  await createSaleImportAccountingBatch(saleLinks);

  return {
    sales: insertedSales.length,
    items: saleItems.length,
    skipped: skippedDuplicates
  };
}

async function importSaleCsvRows() {
  if (!requireAzulAction("import:create", "importar dados")) return;

  var log = document.getElementById("sale-import-log");

  if (saleImportRunning) {
    toast("Importation ventes deja en cours...", "error");
    return;
  }

  if (!saleImportRows.length) {
    toast("Choisis d'abord un fichier ventes.", "error");
    return;
  }

  var invalidRows = saleImportRows.filter(function(row) {
    return !row.valid;
  });

  if (invalidRows.length) {
    toast("Corrige les ventes invalides avant l'import.", "error");

    if (log) {
      log.innerHTML = invalidRows.map(function(row) {
        return "Ligne " + row.line + ": " + row.error;
      }).join("<br>");
    }

    return;
  }

  saleImportRunning = true;

  var btn = document.querySelector('button[onclick="importSaleCsvRows()"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Importation...";
    btn.style.opacity = "0.65";
  }

  try {
    if (log) log.innerHTML = "Importation ventes en cours...";

    var result = await saveSaleImportBatchToSupabase(saleImportRows);

    toast("Import ventes termine: " + result.sales + " ventes, " + (result.skipped || 0) + " doublons ignores.", "success");

    saleImportRows = [];
    renderSaleImportPreview();

    var fileInput = document.getElementById("sale-import-file");
    if (fileInput) fileInput.value = "";

    products = [];

    if (log) {
      log.innerHTML = "Import ventes termine: " + result.sales + " ventes, " + result.items + " lignes. Doublons ignores: " + (result.skipped || 0) + ".";
    }
  } catch (e) {
    console.error("Erreur import ventes:", e);
    toast("Erreur import ventes: " + (e.message || e), "error");

    if (log) {
      log.innerHTML = "Erreur: " + escapeDepenseHtml(e.message || e);
    }
  } finally {
    saleImportRunning = false;

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Importer ventes";
      btn.style.opacity = "1";
    }
  }
}
var expenseImportRows = [];
var expenseImportRunning = false;

function downloadExpenseCsvTemplate() {
  var csv =
    "date,category,description,amount\n" +
    "2026-05-20,Transport,Taxi livraison,5000\n" +
    "2026-05-20,Loyer,Loyer boutique,150000\n" +
    "2026-05-20,Electricite,Facture energie,35000\n";

  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");

  a.href = url;
  a.download = "azul_expenses_import_template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function mapExpenseImportRow(row, index) {
  return {
    line: index + 2,
    date: normalizeImportDate(row.date),
    category: String(row.category || "Autre").trim() || "Autre",
    description: String(row.description || "").trim(),
    amount: parseImportNumber(row.amount),
    valid: true,
    error: ""
  };
}

function validateExpenseImportRow(row) {
  if (!row.category) return "Categorie obligatoire";
  if (!row.description) return "Description obligatoire";
  if (!row.amount || row.amount <= 0) return "Montant invalide";
  return "";
}

function handleExpenseCsvFile(event) {
  var file = event.target.files && event.target.files[0];

  if (!file) return;

  var reader = new FileReader();

  reader.onload = function(e) {
    try {
      var rawRows = parseCsvText(e.target.result || "", ["date", "category", "description", "amount"]);

      expenseImportRows = rawRows.map(function(row, index) {
        var mapped = mapExpenseImportRow(row, index);
        mapped.error = validateExpenseImportRow(mapped);
        mapped.valid = !mapped.error;
        return mapped;
      });

      renderExpenseImportPreview();
    } catch (err) {
      expenseImportRows = [];
      renderExpenseImportPreview();
      toast("Erreur CSV depenses: " + (err.message || err), "error");
    }
  };

  reader.readAsText(file, "UTF-8");
}

function renderExpenseImportPreview() {
  var body = document.getElementById("expense-import-preview");
  var summary = document.getElementById("expense-import-summary");

  if (!body || !summary) return;

  if (!expenseImportRows.length) {
    summary.textContent = "Aucun fichier selectionne.";
    body.innerHTML = '<tr><td colspan="4" class="empty">Le preview des depenses apparait ici</td></tr>';
    return;
  }

  var validRows = expenseImportRows.filter(function(row) { return row.valid; });
  var invalidRows = expenseImportRows.filter(function(row) { return !row.valid; });
  var total = validRows.reduce(function(sum, row) {
    return sum + row.amount;
  }, 0);

  summary.innerHTML =
    '<strong>' + validRows.length + '</strong> depenses valides | ' +
    '<strong>' + invalidRows.length + '</strong> erreurs | Total: <strong>' + fmt(total) + '</strong>';

  body.innerHTML = expenseImportRows.slice(0, 100).map(function(row) {
    var bg = row.valid ? "" : ' style="background:rgba(224,92,92,0.08);"';

    return '<tr' + bg + '>' +
      '<td>' + escapeDepenseHtml(row.date) + '</td>' +
      '<td>' + escapeDepenseHtml(row.category || row.error) + '</td>' +
      '<td>' + escapeDepenseHtml(row.description) + '</td>' +
      '<td>' + escapeDepenseHtml(row.amount) + '</td>' +
    '</tr>';
  }).join("");
}

async function createExpenseImportAccountingBatch(expenses) {
  var organizationId = getAzulOrganizationId();
  var entryRows = (expenses || []).map(function(expense) {
    return {
      organization_id: organizationId,
      source_type: "expense",
      source_id: expense.id,
      entry_date: expense.expense_date,
      description: "Depense - " + (expense.description || expense.category || "")
    };
  });

  if (!entryRows.length) return;

  var insertedEntries = [];

  for (var i = 0; i < chunkImportArray(entryRows, 300).length; i++) {
    var chunk = chunkImportArray(entryRows, 300)[i];

    var entryResult = await supabaseClient
      .from("accounting_entries")
      .insert(chunk)
      .select("id,source_id");

    if (entryResult.error) throw entryResult.error;

    insertedEntries = insertedEntries.concat(entryResult.data || []);
  }

  var expenseById = {};
  expenses.forEach(function(expense) {
    expenseById[String(expense.id)] = expense;
  });

  var lineRows = [];

  insertedEntries.forEach(function(entry) {
    var expense = expenseById[String(entry.source_id)];
    if (!expense) return;

    var amount = Number(expense.amount) || 0;
    if (amount <= 0) return;

    lineRows.push({
      organization_id: organizationId,
      entry_id: entry.id,
      account_code: "62",
      account_name: getAccountName("62"),
      debit: amount,
      credit: 0
    });

    lineRows.push({
      organization_id: organizationId,
      entry_id: entry.id,
      account_code: "11",
      account_name: getAccountName("11"),
      debit: 0,
      credit: amount
    });
  });

  for (var j = 0; j < chunkImportArray(lineRows, 500).length; j++) {
    var lineChunk = chunkImportArray(lineRows, 500)[j];

    if (!lineChunk.length) continue;

    var lineResult = await supabaseClient
      .from("accounting_lines")
      .insert(lineChunk);

    if (lineResult.error) throw lineResult.error;
  }
}

function getExpenseImportKey(row) {
  return [
    normalizeImportText(row.expense_date || row.date),
    normalizeImportText(row.category),
    normalizeImportText(row.description),
    String(Number(row.amount) || 0)
  ].join("|");
}

function syncImportedExpenseCategories(rows) {
  var categories = getStoredDepenseCategories();
  var exists = {};

  categories.forEach(function(category) {
    exists[normalizeImportText(category)] = true;
  });

  (rows || []).forEach(function(row) {
    var category = String(row.category || "").trim();
    var key = normalizeImportText(category);

    if (category && !exists[key]) {
      categories.push(category);
      exists[key] = true;
    }
  });

  saveStoredDepenseCategories(categories);
  renderDepenseCategories();
}

async function fetchExistingExpenseImportKeys(rows) {
  var organizationId = getAzulOrganizationId();
  var existing = {};
  var dates = [];

  (rows || []).forEach(function(row) {
    if (row.date && dates.indexOf(row.date) === -1) {
      dates.push(row.date);
    }
  });

  for (var i = 0; i < chunkImportArray(dates, 80).length; i++) {
    var dateChunk = chunkImportArray(dates, 80)[i];

    if (!dateChunk.length) continue;

    var result = await supabaseClient
      .from("expenses")
      .select("expense_date,category,description,amount")
      .eq("organization_id", organizationId)
      .in("expense_date", dateChunk);

    if (result.error) throw result.error;

    (result.data || []).forEach(function(row) {
      existing[getExpenseImportKey(row)] = true;
    });
  }

  return existing;
}

async function saveExpenseImportBatchToSupabase(rows) {
  var organizationId = getAzulOrganizationId();
  var validRows = (rows || []).filter(function(row) {
    return row && row.valid;
  });

  if (!validRows.length) {
    throw new Error("Aucune depense valide a importer.");
  }

  var existingKeys = await fetchExistingExpenseImportKeys(validRows);
  var usedKeys = {};
  var skippedDuplicates = 0;

  var rowsToInsert = validRows.filter(function(row) {
    var key = getExpenseImportKey(row);

    if (existingKeys[key] || usedKeys[key]) {
      skippedDuplicates++;
      return false;
    }

    usedKeys[key] = true;
    return true;
  });

  if (!rowsToInsert.length) {
    syncImportedExpenseCategories(validRows);

    return {
      expenses: 0,
      skipped: skippedDuplicates
    };
  }

  var expenseRows = rowsToInsert.map(function(row) {
    return {
      organization_id: organizationId,
      expense_date: row.date,
      category: row.category,
      description: row.description,
      amount: row.amount
    };
  });

  var insertedExpenses = [];

  for (var i = 0; i < chunkImportArray(expenseRows, 500).length; i++) {
    var chunk = chunkImportArray(expenseRows, 500)[i];

    var result = await insertRowsWithAzulAudit(
      "expenses",
      chunk,
      "id,expense_date,category,description,amount"
    );

    if (result.error) throw result.error;

    insertedExpenses = insertedExpenses.concat(result.data || []);
  }

  await createExpenseImportAccountingBatch(insertedExpenses);
  syncImportedExpenseCategories(validRows);

  return {
    expenses: insertedExpenses.length,
    skipped: skippedDuplicates
  };
}

async function importExpenseCsvRows() {
  if (!requireAzulAction("import:create", "importar dados")) return;

  var log = document.getElementById("expense-import-log");

  if (expenseImportRunning) {
    toast("Importation depenses deja en cours...", "error");
    return;
  }

  if (!expenseImportRows.length) {
    toast("Choisis d'abord un fichier depenses.", "error");
    return;
  }

  var invalidRows = expenseImportRows.filter(function(row) {
    return !row.valid;
  });

  if (invalidRows.length) {
    toast("Corrige les depenses invalides avant l'import.", "error");

    if (log) {
      log.innerHTML = invalidRows.map(function(row) {
        return "Ligne " + row.line + ": " + row.error;
      }).join("<br>");
    }

    return;
  }

  expenseImportRunning = true;

  var btn = document.querySelector('button[onclick="importExpenseCsvRows()"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Importation...";
    btn.style.opacity = "0.65";
  }

  try {
    if (log) log.innerHTML = "Importation depenses en cours...";

    var result = await saveExpenseImportBatchToSupabase(expenseImportRows);

    toast("Import depenses termine: " + result.expenses + " depenses, " + (result.skipped || 0) + " doublons ignores.", "success");

    expenseImportRows = [];
    renderExpenseImportPreview();

    var fileInput = document.getElementById("expense-import-file");
    if (fileInput) fileInput.value = "";

    loadDashboard();
    loadDepenseInsights();

    if (log) {
            log.innerHTML = "Import depenses termine: " + result.expenses + " depenses. Doublons ignores: " + (result.skipped || 0) + ".";
    }
  } catch (e) {
    console.error("Erreur import depenses:", e);
    toast("Erreur import depenses: " + (e.message || e), "error");

    if (log) {
      log.innerHTML = "Erreur: " + escapeDepenseHtml(e.message || e);
    }
  } finally {
    expenseImportRunning = false;

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Importer depenses";
      btn.style.opacity = "1";
    }
  }
}
function switchImportTab(tab) {
  var panels = {
    purchases: document.getElementById("import-panel-purchases"),
    sales: document.getElementById("import-panel-sales"),
    expenses: document.getElementById("import-panel-expenses")
  };

  var tabs = {
    purchases: document.getElementById("import-tab-purchases"),
    sales: document.getElementById("import-tab-sales"),
    expenses: document.getElementById("import-tab-expenses")
  };

  Object.keys(panels).forEach(function(key) {
    if (panels[key]) panels[key].style.display = key === tab ? "block" : "none";
    if (tabs[key]) tabs[key].classList.toggle("active", key === tab);
  });
}

var correctionCurrentType = "sale";
var correctionSearchTimer = null;

function correctionToday() {
  return new Date().toISOString().split("T")[0];
}

function correctionSafe(value) {
  return typeof escapeDepenseHtml === "function" ? escapeDepenseHtml(value) : String(value == null ? "" : value);
}

function correctionSourceLabel(type) {
  var map = {
    sale: "Vente",
    purchase: "Achat",
    expense: "Depense",
    client_payment: "Paiement client",
    supplier_payment: "Paiement fournisseur"
  };

  return map[type] || type;
}

function switchCorrectionTab(type, btn) {
  correctionCurrentType = type || "sale";

  ["sale", "purchase", "expense", "payment"].forEach(function(name) {
    var tab = document.getElementById("correction-tab-" + name);
    if (tab) tab.classList.toggle("active", name === correctionCurrentType);
  });

  if (btn && btn.classList) btn.classList.add("active");
  loadCorrections();
}

function loadCorrectionsDebounced() {
  if (correctionSearchTimer) clearTimeout(correctionSearchTimer);
  correctionSearchTimer = setTimeout(loadCorrections, 250);
}

async function getCorrectionLogsForRows(rows) {
  var organizationId = getAzulOrganizationId();
  var ids = (rows || []).map(function(row) { return row.id; }).filter(Boolean);
  var logs = {};

  if (!ids.length) return logs;

  try {
    var result = await supabaseClient
      .from("corrections_log")
      .select("*")
      .eq("organization_id", organizationId)
      .in("source_id", ids);

    if (result.error) throw result.error;

    (result.data || []).forEach(function(log) {
      logs[String(log.source_type) + ":" + String(log.source_id)] = log;
    });
  } catch (e) {
    console.warn("Corrections log indisponible:", e);
  }

  return logs;
}

async function insertCorrectionLog(sourceType, sourceId, correctionType, correctionId, reason) {
  try {
    var result = await insertRowsWithAzulAudit("corrections_log", [{
        organization_id: getAzulOrganizationId(),
        source_type: sourceType,
        source_id: sourceId,
        correction_type: correctionType,
        correction_id: correctionId || null,
        reason: reason || "",
        user_name: localStorage.getItem("azul_user_name") || ""
      }]);

    if (result.error) throw result.error;
  } catch (e) {
    console.warn("Correction log non enregistre:", e);
  }
}

async function fetchCorrectionsRows(type, search) {
  var organizationId = getAzulOrganizationId();
  search = String(search || "").trim().toLowerCase();

  if (type === "sale") {
    var salesResult = await supabaseClient
      .from("sales")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(80);

    if (salesResult.error) throw salesResult.error;

    return (salesResult.data || []).filter(function(row) {
      var text = [row.receipt_no, row.client_name, row.payment_summary, row.sale_type].join(" ").toLowerCase();
      return String(row.sale_type || "").toLowerCase() !== "correction" &&
        String(row.receipt_no || "").indexOf("ANN-") !== 0 &&
        (!search || text.indexOf(search) >= 0);
    }).map(function(row) {
      return {
        id: row.id,
        sourceType: "sale",
        title: "Venda " + (row.receipt_no || "-"),
        subtitle: (row.client_name || "Anonimo") + " - " + (row.sale_type || "interno"),
        date: row.sale_date || String(row.created_at || "").slice(0, 10),
        amount: Number(row.total) || 0,
        raw: row
      };
    });
  }

  if (type === "purchase") {
    var purchasesResult = await supabaseClient
      .from("purchases")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(80);

    if (purchasesResult.error) throw purchasesResult.error;

    return (purchasesResult.data || []).filter(function(row) {
      var text = [row.supplier, row.total, row.remaining_amount].join(" ").toLowerCase();
      return String(row.supplier || "").indexOf("Annulation - ") !== 0 &&
        (!search || text.indexOf(search) >= 0);
    }).map(function(row) {
      return {
        id: row.id,
        sourceType: "purchase",
        title: "Achat fournisseur",
        subtitle: row.supplier || "Fornecedor",
        date: String(row.created_at || "").slice(0, 10),
        amount: Number(row.total) || 0,
        raw: row
      };
    });
  }

  if (type === "expense") {
    var expensesResult = await supabaseClient
      .from("expenses")
      .select("*")
      .eq("organization_id", organizationId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(80);

    if (expensesResult.error) throw expensesResult.error;

    return (expensesResult.data || []).filter(function(row) {
      var text = [row.category, row.description, row.amount].join(" ").toLowerCase();
      return String(row.category || "").indexOf("Annulation - ") !== 0 &&
        (!search || text.indexOf(search) >= 0);
    }).map(function(row) {
      return {
        id: row.id,
        sourceType: "expense",
        title: row.category || "Depense",
        subtitle: row.description || "Sans description",
        date: row.expense_date || String(row.created_at || "").slice(0, 10),
        amount: Number(row.amount) || 0,
        raw: row
      };
    });
  }

  var rows = [];

  var clientPaymentsResult = await supabaseClient
    .from("client_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("amount", 0)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(60);

  if (clientPaymentsResult.error) throw clientPaymentsResult.error;

  rows = rows.concat((clientPaymentsResult.data || []).map(function(row) {
    return {
      id: row.id,
      sourceType: "client_payment",
      title: "Paiement client",
      subtitle: row.client_name || "Cliente",
      date: row.payment_date || String(row.created_at || "").slice(0, 10),
      amount: Number(row.amount) || 0,
      raw: row
    };
  }));

  var supplierPaymentsResult = await supabaseClient
    .from("supplier_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("amount", 0)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(60);

  if (supplierPaymentsResult.error) throw supplierPaymentsResult.error;

  rows = rows.concat((supplierPaymentsResult.data || []).map(function(row) {
    return {
      id: row.id,
      sourceType: "supplier_payment",
      title: "Paiement fournisseur",
      subtitle: row.supplier || "Fornecedor",
      date: row.payment_date || String(row.created_at || "").slice(0, 10),
      amount: Number(row.amount) || 0,
      raw: row
    };
  }));

  if (search) {
    rows = rows.filter(function(row) {
      return [row.title, row.subtitle, row.amount, row.date].join(" ").toLowerCase().indexOf(search) >= 0;
    });
  }

  rows.sort(function(a, b) {
    return String(b.date || "").localeCompare(String(a.date || ""));
  });

  return rows;
}

async function loadCorrections() {
  var list = document.getElementById("correction-list");
  var search = document.getElementById("correction-search");

  if (!list) return;

  list.innerHTML = '<div class="empty">Chargement...</div>';

  try {
    var rows = await fetchCorrectionsRows(correctionCurrentType, search ? search.value : "");
    var logs = await getCorrectionLogsForRows(rows);

    if (!rows.length) {
      list.innerHTML = '<div class="empty">Aucun mouvement trouve.</div>';
      return;
    }

    list.innerHTML = rows.map(function(row) {
      var key = row.sourceType + ":" + row.id;
      var log = logs[key];
      var cancelled = !!log;

      return '<div class="correction-card ' + (cancelled ? 'is-cancelled' : '') + '">' +
        '<div class="correction-card-main">' +
          '<div class="correction-type">' + correctionSafe(correctionSourceLabel(row.sourceType)) + '</div>' +
          '<h3>' + correctionSafe(row.title) + '</h3>' +
          '<p>' + correctionSafe(row.subtitle) + '</p>' +
          renderActionAuthor(row.raw || {}) +
          '<div class="correction-meta">' +
            '<span>' + correctionSafe(row.date || "-") + '</span>' +
            '<strong>' + fmt(row.amount || 0) + '</strong>' +
          '</div>' +
          (cancelled ? '<div class="correction-cancelled">Deja corrige: ' + correctionSafe(log.reason || "Annulation") + '</div>' : '') +
        '</div>' +
        '<button class="correction-action" ' + (cancelled ? 'disabled' : '') +
          ' data-correction-type="' + correctionSafe(row.sourceType) + '" data-correction-id="' + correctionSafe(row.id) + '">' +
          (cancelled ? 'Corrige' : 'Annuler') +
        '</button>' +
      '</div>';
    }).join("");
  } catch (e) {
    console.error("Erreur corrections:", e);
    list.innerHTML = '<div class="empty">Erreur: ' + correctionSafe(e.message || e) + '</div>';
  }
}

async function confirmCorrectionCancel(sourceType, id) {
  if (!requireAzulAction("correction:create", "corrigir movimentos")) return;

  var reason = prompt("Pourquoi annuler ce mouvement ?");

  if (reason === null) return;
  reason = String(reason || "").trim();

  if (!reason) {
    toast("Ajoute une raison pour la correction.", "error");
    return;
  }

  if (!confirm("Confirmer l'annulation controlee ?")) return;

  try {
    if (sourceType === "sale") await cancelSaleWithCorrection(id, reason);
    else if (sourceType === "purchase") await cancelPurchaseWithCorrection(id, reason);
    else if (sourceType === "expense") await cancelExpenseWithCorrection(id, reason);
    else if (sourceType === "client_payment") await cancelClientPaymentWithCorrection(id, reason);
    else if (sourceType === "supplier_payment") await cancelSupplierPaymentWithCorrection(id, reason);
    else throw new Error("Type de correction inconnu.");

    toast("Correction enregistree.", "success");
    await loadProducts(true);
    loadCorrections();
    loadDashboard();
  } catch (e) {
    console.error("Erreur correction:", e);
    toast("Erreur correction: " + (e.message || e), "error");
  }
}

async function reverseAccountingForSource(originalType, originalId, correctionType, correctionId, date, description) {
  var organizationId = getAzulOrganizationId();

  var entriesResult = await supabaseClient
    .from("accounting_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_type", originalType)
    .eq("source_id", originalId);

  if (entriesResult.error) throw entriesResult.error;

  var entryIds = (entriesResult.data || []).map(function(row) { return row.id; });
  if (!entryIds.length) return;

  var linesResult = await supabaseClient
    .from("accounting_lines")
    .select("*")
    .eq("organization_id", organizationId)
    .in("entry_id", entryIds);

  if (linesResult.error) throw linesResult.error;

  var grouped = {};

  (linesResult.data || []).forEach(function(line) {
    var code = String(line.account_code || "");
    if (!code) return;
    if (!grouped[code]) grouped[code] = { account: code, debit: 0, credit: 0 };
    grouped[code].debit += Number(line.credit) || 0;
    grouped[code].credit += Number(line.debit) || 0;
  });

  var reverseLines = Object.keys(grouped).map(function(code) { return grouped[code]; })
    .filter(function(line) { return line.debit || line.credit; });

  if (!reverseLines.length) return;

  await createAccountingEntry(
    correctionType,
    correctionId,
    date || correctionToday(),
    description || "Correction",
    reverseLines
  );
}

async function updateProductStockDelta(productId, field, delta) {
  if (!productId || !field || !delta) return;

  var productResult = await supabaseClient
    .from("products")
    .select("id,stock_shop,stock_warehouse")
    .eq("id", productId)
    .limit(1);

  if (productResult.error) throw productResult.error;
  if (!productResult.data || !productResult.data.length) return;

  var product = productResult.data[0];
  var current = Number(product[field]) || 0;
  var update = {};
  update[field] = Math.max(0, current + (Number(delta) || 0));

  var updateResult = await supabaseClient
    .from("products")
    .update(update)
    .eq("id", productId);

  if (updateResult.error) throw updateResult.error;
}

async function cancelSaleWithCorrection(saleId, reason) {
  var organizationId = getAzulOrganizationId();

  var saleResult = await supabaseClient
    .from("sales")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", saleId)
    .single();

  if (saleResult.error) throw saleResult.error;
  var sale = saleResult.data;

  var itemsResult = await supabaseClient
    .from("sale_items")
    .select("*")
    .eq("sale_id", saleId);

  if (itemsResult.error) throw itemsResult.error;
  var items = itemsResult.data || [];

  var receiptNo = "ANN-" + String(sale.receipt_no || "").slice(0, 18);
  var correctionResult = await insertSingleWithAzulAudit("sales", {
      organization_id: organizationId,
      receipt_no: receiptNo,
      client_name: sale.client_name || "Anonimo",
      sale_date: correctionToday(),
      sale_type: "Correction",
      total: -Math.abs(Number(sale.total) || 0),
      profit: -(Number(sale.profit) || 0),
      payment_summary: "Annulation " + (sale.receipt_no || ""),
      payment_lines: [{ method: "Correction", montant: -Math.abs(Number(sale.total) || 0) }]
    });

  if (correctionResult.error) throw correctionResult.error;
  var correction = correctionResult.data;

  if (items.length) {
    var correctionItems = items.map(function(item) {
      var qty = Number(item.quantity) || 0;

      return {
        sale_id: correction.id,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: -Math.abs(qty),
        unit_price: Number(item.unit_price) || 0,
        total: -Math.abs(Number(item.total) || 0),
        purchase_price: Number(item.purchase_price) || 0,
        profit: -(Number(item.profit) || 0),
        variation: item.variation || "",
        variations: item.variations || []
      };
    });

    var itemsInsert = await supabaseClient.from("sale_items").insert(correctionItems);
    if (itemsInsert.error) throw itemsInsert.error;
  }

  if (String(sale.sale_type || "").toLowerCase() !== "externo") {
    for (var i = 0; i < items.length; i++) {
      await updateProductStockDelta(items[i].product_id, "stock_shop", Number(items[i].quantity) || 0);
    }
  }

  var debtResult = await supabaseClient
    .from("client_debts")
    .update({ remaining_amount: 0, status: "cancelled" })
    .eq("organization_id", organizationId)
    .eq("sale_id", saleId);

  if (debtResult.error) throw debtResult.error;

  await reverseAccountingForSource("sale", saleId, "sale_correction", correction.id, correctionToday(), "Annulation vente " + (sale.receipt_no || ""));
  await insertCorrectionLog("sale", saleId, "cancel", correction.id, reason);
}

async function cancelPurchaseWithCorrection(purchaseId, reason) {
  var organizationId = getAzulOrganizationId();

  var purchaseResult = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", purchaseId)
    .single();

  if (purchaseResult.error) throw purchaseResult.error;
  var purchase = purchaseResult.data;

  var items = await fetchPurchaseItemsByPurchaseIds([purchaseId]);

  var correctionResult = await insertSingleWithAzulAudit("purchases", {
      organization_id: organizationId,
      supplier: "Annulation - " + (purchase.supplier || "Fornecedor"),
      total: -Math.abs(Number(purchase.total) || 0),
      paid_amount: -Math.abs(Number(purchase.paid_amount) || 0),
      remaining_amount: -Math.abs(Number(purchase.remaining_amount) || 0),
      is_credit: false
    });

  if (correctionResult.error) throw correctionResult.error;
  var correction = correctionResult.data;

  if (items.length) {
    var correctionItems = items.map(function(item) {
      return {
        purchase_id: correction.id,
        product_id: item.product_id,
        product_name: item.product_name,
        category: item.category || "",
        purchase_price: Number(item.purchase_price) || 0,
        sale_price: Number(item.sale_price) || 0,
        quantity: -Math.abs(Number(item.quantity) || 0),
        supplier: item.supplier || purchase.supplier || "",
        code: item.code || "",
        variation: item.variation || "",
        variations: item.variations || [],
        photo: item.photo || ""
      };
    });

    var itemsInsert = await supabaseClient.from("purchase_items").insert(correctionItems);
    if (itemsInsert.error) throw itemsInsert.error;
  }

  for (var i = 0; i < items.length; i++) {
    await updateProductStockDelta(items[i].product_id, "stock_warehouse", -(Number(items[i].quantity) || 0));
  }

  await reverseAccountingForSource("purchase", purchaseId, "purchase_correction", correction.id, correctionToday(), "Annulation achat " + (purchase.supplier || ""));
  await insertCorrectionLog("purchase", purchaseId, "cancel", correction.id, reason);
}

async function cancelExpenseWithCorrection(expenseId, reason) {
  var organizationId = getAzulOrganizationId();

  var expenseResult = await supabaseClient
    .from("expenses")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", expenseId)
    .single();

  if (expenseResult.error) throw expenseResult.error;
  var expense = expenseResult.data;

  var correctionResult = await insertSingleWithAzulAudit("expenses", {
      organization_id: organizationId,
      expense_date: correctionToday(),
      category: "Annulation - " + (expense.category || "Depense"),
      description: "Correction: " + (expense.description || "") + " - " + reason,
      amount: -Math.abs(Number(expense.amount) || 0)
    });

  if (correctionResult.error) throw correctionResult.error;
  var correction = correctionResult.data;

  await reverseAccountingForSource("expense", expenseId, "expense_correction", correction.id, correctionToday(), "Annulation depense " + (expense.description || ""));
  await insertCorrectionLog("expense", expenseId, "cancel", correction.id, reason);
}

async function cancelClientPaymentWithCorrection(paymentId, reason) {
  var organizationId = getAzulOrganizationId();

  var paymentResult = await supabaseClient
    .from("client_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", paymentId)
    .single();

  if (paymentResult.error) throw paymentResult.error;
  var payment = paymentResult.data;
  var amount = Math.abs(Number(payment.amount) || 0);

  var correctionResult = await insertSingleWithAzulAudit("client_payments", {
      organization_id: organizationId,
      client_name: payment.client_name,
      amount: -amount,
      note: "Annulation paiement: " + reason,
      payment_date: correctionToday()
    });

  if (correctionResult.error) throw correctionResult.error;
  var correction = correctionResult.data;

  var debtResult = await supabaseClient
    .from("client_debts")
    .insert({
      organization_id: organizationId,
      sale_id: null,
      client_name: payment.client_name,
      total_amount: amount,
      paid_amount: 0,
      remaining_amount: amount,
      status: "open"
    });

  if (debtResult.error) throw debtResult.error;

  await reverseAccountingForSource("client_payment", paymentId, "client_payment_correction", correction.id, correctionToday(), "Annulation paiement client " + (payment.client_name || ""));
  await insertCorrectionLog("client_payment", paymentId, "cancel", correction.id, reason);
}

async function cancelSupplierPaymentWithCorrection(paymentId, reason) {
  var organizationId = getAzulOrganizationId();

  var paymentResult = await supabaseClient
    .from("supplier_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", paymentId)
    .single();

  if (paymentResult.error) throw paymentResult.error;
  var payment = paymentResult.data;
  var amount = Math.abs(Number(payment.amount) || 0);

  var correctionResult = await insertSingleWithAzulAudit("supplier_payments", {
      organization_id: organizationId,
      supplier: payment.supplier,
      amount: -amount,
      note: "Annulation paiement: " + reason,
      payment_date: correctionToday()
    });

  if (correctionResult.error) throw correctionResult.error;
  var correction = correctionResult.data;

  var purchasesResult = await supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("supplier", payment.supplier)
    .order("created_at", { ascending: false })
    .limit(1);

  if (purchasesResult.error) throw purchasesResult.error;

  if (purchasesResult.data && purchasesResult.data.length) {
    var purchase = purchasesResult.data[0];
    var updateResult = await supabaseClient
      .from("purchases")
      .update({
        paid_amount: Math.max(0, (Number(purchase.paid_amount) || 0) - amount),
        remaining_amount: (Number(purchase.remaining_amount) || 0) + amount,
        is_credit: true
      })
      .eq("id", purchase.id);

    if (updateResult.error) throw updateResult.error;
  }

  await reverseAccountingForSource("supplier_payment", paymentId, "supplier_payment_correction", correction.id, correctionToday(), "Annulation paiement fournisseur " + (payment.supplier || ""));
  await insertCorrectionLog("supplier_payment", paymentId, "cancel", correction.id, reason);
}

window.switchCorrectionTab = switchCorrectionTab;
window.loadCorrections = loadCorrections;
window.loadCorrectionsDebounced = loadCorrectionsDebounced;
window.confirmCorrectionCancel = confirmCorrectionCancel;
window.saveTeamMemberRoleStatus = saveTeamMemberRoleStatus;
window.rejectTeamMember = rejectTeamMember;
window.deleteTeamMember = deleteTeamMember;
window.createCustomRoleFromBase = createCustomRoleFromBase;

document.addEventListener("click", function(event) {
  var button = event.target.closest("[data-correction-type][data-correction-id]");
  if (!button || button.disabled) return;
  event.preventDefault();
  confirmCorrectionCancel(button.getAttribute("data-correction-type"), button.getAttribute("data-correction-id"));
});

// ===== UTILS =====
function fmt(n) {
  if (n === undefined || n === null || n === '') return '-';
  var cur = window._currency || 'Kz';
  return new Intl.NumberFormat(getLocale()).format(n) + ' ' + cur;
}

function toast(msg, type) {
  var t = document.getElementById('toast');
  if (toastTimer) clearTimeout(toastTimer);
  t.textContent = msg;
  t.className = 'toast ' + (type||'success') + ' show';
  toastTimer = setTimeout(function() {
    t.classList.remove('show');
    toastTimer = null;
  }, 3000);
}

var AZUL_LOCK_HASH_KEY = "azul_erp_lock_hash";
var AZUL_LOCKED_KEY = "azul_erp_locked";

async function azulHashPassword(password) {
  var data = new TextEncoder().encode(password);
  var hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map(function(byte) {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}

function getSettingsPageElement() {
  return document.getElementById("page-definicoes")
    || document.getElementById("page-def")
    || document.getElementById("page-settings")
    || document.getElementById("page-config")
    || document.getElementById("page-parametros");
}

function injectLockSettingsCard() {
  var page = getSettingsPageElement();
  if (!page || document.getElementById("erpLockSettingsCard")) return;

  var card = document.createElement("div");
  card.id = "erpLockSettingsCard";

  card.style.maxWidth = "700px";
  card.style.margin = "18px 0 30px";
  card.style.padding = "18px";
  card.style.border = "1px solid #ded8cc";
  card.style.borderRadius = "10px";
  card.style.background = "#fff";
  card.style.boxShadow = "0 8px 24px rgba(0,0,0,.05)";

  card.innerHTML = `
    <h3 style="margin:0 0 6px;color:#002f87;font-size:18px;">Segurança do ERP</h3>
    <p style="margin:0 0 14px;color:#8a8177;font-size:13px;">
      Defina um mot de passe para bloquear o acesso ao sistema.
    </p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
      <div style="position:relative;">
        <input id="erpLockPassword" type="password" placeholder="Novo mot de passe"
          style="width:100%;height:42px;border:1px solid #d8d2c7;border-radius:7px;padding:0 44px 0 12px;font-size:14px;">
        <button type="button" onclick="togglePasswordVisibility('erpLockPassword', this)"
          style="position:absolute;right:6px;top:5px;width:32px;height:32px;border:0;background:transparent;cursor:pointer;font-size:17px;">
         &#128065;
        </button>
      </div>

      <div style="position:relative;">
        <input id="erpLockPasswordConfirm" type="password" placeholder="Confirmar mot de passe"
          style="width:100%;height:42px;border:1px solid #d8d2c7;border-radius:7px;padding:0 44px 0 12px;font-size:14px;">
        <button type="button" onclick="togglePasswordVisibility('erpLockPasswordConfirm', this)"
          style="position:absolute;right:6px;top:5px;width:32px;height:32px;border:0;background:transparent;cursor:pointer;font-size:17px;">
         &#128065;
        </button>
      </div>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button onclick="saveErpLockPassword()"
        style="height:42px;border:0;border-radius:7px;padding:0 16px;background:#003b91;color:#fff;font-weight:700;cursor:pointer;">
        Guardar mot de passe
      </button>

      <button onclick="lockErpNow()"
        style="height:42px;border:0;border-radius:7px;padding:0 16px;background:#b91c1c;color:#fff;font-weight:700;cursor:pointer;">
        Déconnexion / Verrouiller
      </button>
    </div>
  `;

  page.appendChild(card);
}

async function saveErpLockPassword() {
  var pass = document.getElementById("erpLockPassword").value.trim();
  var confirm = document.getElementById("erpLockPasswordConfirm").value.trim();

  if (pass.length < 4) {
    toast("Le mot de passe doit avoir au moins 4 caracteres.", "error");
    return;
  }

  if (pass !== confirm) {
    toast("Les mots de passe ne correspondent pas.", "error");
    return;
  }

  var hash = await azulHashPassword(pass);
  localStorage.setItem(AZUL_LOCK_HASH_KEY, hash);

  document.getElementById("erpLockPassword").value = "";
  document.getElementById("erpLockPasswordConfirm").value = "";

  toast("Mot de passe de verrouillage enregistre.", "success");
}

function lockErpNow() {
  var hash = localStorage.getItem(AZUL_LOCK_HASH_KEY);

  if (!hash) {
    toast("Ajoute d'abord un mot de passe dans les parametres.", "error");
    return;
  }

  localStorage.setItem(AZUL_LOCKED_KEY, "1");

  setErpLockedVisualState(true);
  showErpLockScreen();
  startErpLockWatcher();
}
function showErpLockScreen() {
  setErpLockedVisualState(true);
  if (document.getElementById("erpLockOverlay")) return;

  document.body.style.overflow = "hidden";

  var overlay = document.createElement("div");
  overlay.id = "erpLockOverlay";

  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.width = "100vw";
  overlay.style.height = "100vh";
  overlay.style.zIndex = "999999";
  overlay.style.background = "linear-gradient(180deg, #f8f6f1 0%, #ece7db 100%)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.padding = "20px";

  overlay.innerHTML = `
    <div style="width:min(420px,100%);background:#fff;border-radius:22px;padding:28px 22px;box-shadow:0 24px 70px rgba(0,0,0,.22);text-align:center;">
      <div style="width:72px;height:72px;margin:0 auto 16px;border-radius:22px;background:#003b91;color:#fff;display:grid;place-items:center;font-size:34px;">
        &#128274;
      </div>

      <h2 style="margin:0 0 6px;color:#002f87;font-size:24px;">ERP verrouille</h2>
      <p style="margin:0 0 20px;color:#777;font-size:14px;">Entre le mot de passe pour continuer.</p>

      <div style="position:relative;margin-bottom:14px;">
        <input id="erpUnlockPassword" type="password" placeholder="Mot de passe"
          onkeydown="if(event.key === 'Enter') unlockErp()"
          style="width:100%;height:50px;border:1px solid #d8d2c7;border-radius:12px;padding:0 48px 0 14px;font-size:16px;outline:none;">
        <button type="button" onclick="togglePasswordVisibility('erpUnlockPassword', this)"
          style="position:absolute;right:8px;top:8px;width:34px;height:34px;border:0;background:transparent;cursor:pointer;font-size:18px;">
          &#128065;
        </button>
      </div>

      <button onclick="unlockErp()"
        style="width:100%;height:50px;border:0;border-radius:12px;background:#003b91;color:#fff;font-weight:800;font-size:15px;cursor:pointer;">
        Deverrouiller
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  setTimeout(function() {
    var input = document.getElementById("erpUnlockPassword");
    if (input) input.focus();
  }, 100);
}

async function unlockErp() {
  var input = document.getElementById("erpUnlockPassword");
  var pass = input ? input.value.trim() : "";

  if (!pass) {
    toast("Entre le mot de passe.", "error");
    return;
  }

  var savedHash = localStorage.getItem(AZUL_LOCK_HASH_KEY);
  var typedHash = await azulHashPassword(pass);

  if (typedHash !== savedHash) {
    toast("Mot de passe incorrect.", "error");
    input.value = "";
    input.focus();
    return;
  }

  localStorage.removeItem(AZUL_LOCKED_KEY);

  var overlay = document.getElementById("erpLockOverlay");
  if (overlay) overlay.remove();
  
  setErpLockedVisualState(false);
  stopErpLockWatcher();
  
  toast("ERP deverrouille.", "success");
}
function setSettingsUserText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value || "-";
}

function getCurrentDeviceNameForSettings() {
  if (typeof getDeviceName === "function") {
    return getDeviceName();
  }

  var ua = navigator.userAgent || "";

  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone/iPad";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac/i.test(ua)) return "Mac";

  return "Navegador";
}

async function renderSettingsUserCard() {
  var card = document.getElementById("settings-user-card");
  if (!card) return;

  var userName = localStorage.getItem("azul_user_name") || "";
  var userRole = localStorage.getItem("azul_user_role") || "member";
  var userStatus = "active";
  var orgName = localStorage.getItem("azul_organization_name") || "";
  var organizationId = localStorage.getItem("azul_organization_id") || "";
  var licenseKey = localStorage.getItem("azul_license_key") || "";
  var plan = localStorage.getItem("azul_plan") || "starter";
  var email = "";
  var phone = "";

  try {
    var userResult = await supabaseClient.auth.getUser();

    if (userResult && userResult.data && userResult.data.user) {
      var user = userResult.data.user;
      var meta = user.user_metadata || {};

      email = user.email || meta.email || "";
      phone = meta.phone || meta.numero || "";
      userName = userName || meta.name || meta.nome || "";
      userRole = userRole || meta.role || "member";

      if (organizationId && email) {
        var profileResult = await supabaseClient
          .from("profiles")
          .select("name, phone, role, status")
          .eq("organization_id", organizationId)
          .ilike("email", email)
          .maybeSingle();

        if (!profileResult.error && profileResult.data) {
          userName = profileResult.data.name || userName;
          phone = profileResult.data.phone || phone;
          userRole = profileResult.data.role || userRole;
          userStatus = profileResult.data.status || userStatus;
          localStorage.setItem("azul_user_role", userRole || "member");
          localStorage.setItem("azul_user_name", userName || "");
        }
      }
    }
  } catch (e) {
    console.warn("Nao foi possivel carregar o utilizador:", e);
  }

  var initial = String(userName || email || "U").trim().charAt(0).toUpperCase();

  setSettingsUserText("settings-user-avatar", initial);
  setSettingsUserText("settings-user-name", userName || "Utilizador");
  setSettingsUserText("settings-user-email", email || "-");
  setSettingsUserText("settings-user-phone", phone || "-");
  setSettingsUserText("settings-user-role", getTeamRoleLabel(userRole || "member"));
  setSettingsUserText("settings-user-status", getTeamStatusLabel(userStatus));
  setSettingsUserText("settings-user-org", orgName || "-");
  setSettingsUserText("settings-user-plan", plan || "-");
  setSettingsUserText("settings-user-license", licenseKey || "-");
  setSettingsUserText("settings-user-device", getCurrentDeviceNameForSettings());
}

function formatTeamDate(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (e) {
    return String(value);
  }
}

function getTeamRoleLabel(role) {
  role = String(role || "member").toLowerCase();

  if (azulRoleCatalogCache && azulRoleCatalogCache[role] && azulRoleCatalogCache[role].name) {
    return azulRoleCatalogCache[role].name;
  }

  var map = {
    owner: "Proprietario",
    manager: "Gerente",
    cashier: "Caixa",
    stock: "Stock",
    accountant: "Contabilista",
    readonly: "Leitura",
    member: "Utilizador"
  };

  return map[role] || role;
}

function getPermissionLabel(permission) {
  var meta = AZUL_PERMISSION_CATALOG[permission] || {};
  return meta.label || permission;
}

function getRolePermissionLabels(role, limit) {
  var def = getAzulRoleDefinition(role);
  var permissions = def.permissions || [];

  if (permissions.indexOf("*") >= 0) {
    return ["Acesso total"];
  }

  return permissions
    .filter(function(permission) { return permission.indexOf("page:") !== 0; })
    .slice(0, limit || 6)
    .map(getPermissionLabel);
}

function renderRolePermissionChips(role) {
  var labels = getRolePermissionLabels(role, 8);

  if (!labels.length) {
    return '<div class="team-permissions muted">Sem permissoes de accao.</div>';
  }

  return '<div class="team-permissions">' + labels.map(function(label) {
    return '<span>' + escapeDepenseHtml(label) + '</span>';
  }).join("") + '</div>';
}

function getTeamStatusLabel(status) {
  status = String(status || "active").toLowerCase();

  var map = {
    active: "Activo",
    pending: "Pendente",
    inactive: "Inactivo",
    suspended: "Suspenso",
    blocked: "Bloqueado"
  };

  return map[status] || status;
}

function canManageTeamRoles() {
  var role = getAzulCurrentRole();
  return role === "owner";
}

function getTeamMemberDomKey(email) {
  return String(email || "user").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

function getTeamRoleOptions(selectedRole, roleCatalog) {
  selectedRole = String(selectedRole || "member").toLowerCase();

  roleCatalog = roleCatalog || azulRoleCatalogCache || {};
  var roles = Object.keys(roleCatalog).map(function(code) {
    return [code, roleCatalog[code].name || getTeamRoleLabel(code), !!roleCatalog[code].isSystem];
  });

  if (!roles.length) {
    roles = Object.keys(AZUL_ROLE_PERMISSIONS).map(function(code) {
      return [code, getTeamRoleLabel(code), true];
    });
  }

  return roles.map(function(item) {
    var suffix = item[2] ? "" : " (personalizado)";
    return '<option value="' + item[0] + '"' + (item[0] === selectedRole ? " selected" : "") + '>' + item[1] + suffix + '</option>';
  }).join("");
}

function getTeamStatusOptions(selectedStatus) {
  selectedStatus = String(selectedStatus || "active").toLowerCase();

  var statuses = [
    ["active", "Activo"],
    ["pending", "Pendente"],
    ["inactive", "Inactivo"],
    ["suspended", "Suspenso"],
    ["blocked", "Bloqueado"]
  ];

  return statuses.map(function(item) {
    return '<option value="' + item[0] + '"' + (item[0] === selectedStatus ? " selected" : "") + '>' + item[1] + '</option>';
  }).join("");
}

function getTeamInitial(name, email) {
  return String(name || email || "U").trim().charAt(0).toUpperCase();
}

function slugifyCustomRole(value) {
  return "custom_" + String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function getBaseRoleOptionsForCustomRole() {
  var baseRoles = ["cashier", "stock", "accountant", "readonly", "manager"];

  return baseRoles.map(function(role) {
    return '<option value="' + role + '">' + escapeDepenseHtml(getTeamRoleLabel(role)) + '</option>';
  }).join("");
}

async function createCustomRoleFromBase() {
  if (!canManageTeamRoles()) {
    toast("Sem permissao para criar roles.", "error");
    return;
  }

  var organizationId = localStorage.getItem("azul_organization_id");
  var nameInput = document.getElementById("custom-role-name");
  var baseInput = document.getElementById("custom-role-base");
  var roleName = nameInput ? nameInput.value.trim() : "";
  var baseRole = baseInput ? baseInput.value : "readonly";

  if (!organizationId || !roleName) {
    toast("Informe o nome do role personalizado.", "error");
    return;
  }

  var baseDefinition = getAzulRoleDefinition(baseRole);
  var permissions = (baseDefinition.permissions || []).filter(function(permission) {
    return permission !== "*";
  });

  if ((baseDefinition.permissions || []).indexOf("*") >= 0) {
    permissions = Object.keys(AZUL_PERMISSION_CATALOG).filter(function(permission) {
      return permission !== "*";
    });
  }

  try {
    var result = await supabaseClient.rpc("upsert_custom_role", {
      p_organization_id: organizationId,
      p_code: slugifyCustomRole(roleName),
      p_name: roleName,
      p_permissions: permissions
    });

    if (result.error) throw result.error;

    toast("Role personalizado criado.", "success");
    if (nameInput) nameInput.value = "";

    await loadAzulRoleCatalog(true);
    await renderSettingsTeamCard();
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (msg.indexOf("TEAM_PERMISSION_DENIED") >= 0) msg = "Apenas o proprietario pode criar roles.";
    if (msg.indexOf("SYSTEM_ROLE_LOCKED") >= 0) msg = "Role do sistema nao pode ser alterado.";
    toast("Erro role: " + msg, "error");
  }
}

async function saveTeamMemberRoleStatus(encodedEmail) {
  if (!canManageTeamRoles()) {
    toast("Sem permissao para alterar a equipa.", "error");
    return;
  }

  var email = decodeURIComponent(String(encodedEmail || ""));
  var organizationId = localStorage.getItem("azul_organization_id");
  var key = getTeamMemberDomKey(email);
  var roleInput = document.getElementById("team-role-" + key);
  var statusInput = document.getElementById("team-status-" + key);

  if (!organizationId || !email || !roleInput || !statusInput) {
    toast("Utilizador invalido.", "error");
    return;
  }

  try {
    var result = await supabaseClient.rpc("update_team_member_role_status", {
      p_organization_id: organizationId,
      p_email: email,
      p_role: roleInput.value,
      p_status: statusInput.value
    });

    if (result.error) throw result.error;

    toast("Permissoes actualizadas.", "success");
    azulAuditCache = null;
    await renderSettingsUserCard();
    applyAzulRolePermissions();
    await renderSettingsTeamCard();
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);

    if (msg.indexOf("TEAM_PERMISSION_DENIED") >= 0) msg = "Apenas proprietario ou gerente pode alterar funcoes.";
    if (msg.indexOf("TEAM_OWNER_ONLY") >= 0) msg = "Apenas o proprietario pode alterar outro proprietario.";
    if (msg.indexOf("LAST_OWNER_REQUIRED") >= 0) msg = "A loja precisa manter pelo menos um proprietario activo.";
    if (msg.indexOf("TEAM_MEMBER_NOT_FOUND") >= 0) msg = "Utilizador nao encontrado na equipa.";

    toast("Erro equipa: " + msg, "error");
  }
}

async function rejectTeamMember(encodedEmail) {
  var email = decodeURIComponent(String(encodedEmail || ""));
  var key = getTeamMemberDomKey(email);
  var statusInput = document.getElementById("team-status-" + key);

  if (statusInput) statusInput.value = "blocked";
  await saveTeamMemberRoleStatus(encodedEmail);
}

async function deleteTeamMember(encodedEmail) {
  if (!canManageTeamRoles()) {
    toast("Sem permissao para eliminar utilizador.", "error");
    return;
  }

  var email = decodeURIComponent(String(encodedEmail || ""));
  var organizationId = localStorage.getItem("azul_organization_id");

  if (!organizationId || !email) {
    toast("Utilizador invalido.", "error");
    return;
  }

  if (!confirm("Eliminar definitivamente este utilizador da equipa?")) return;

  try {
    var result = await supabaseClient.rpc("delete_team_member", {
      p_organization_id: organizationId,
      p_email: email
    });

    if (result.error) throw result.error;

    toast("Utilizador eliminado.", "success");
    await renderSettingsTeamCard();
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);

    if (msg.indexOf("TEAM_PERMISSION_DENIED") >= 0) msg = "Apenas o proprietario pode eliminar utilizadores.";
    if (msg.indexOf("LAST_OWNER_REQUIRED") >= 0) msg = "Nao podes eliminar o ultimo proprietario activo.";
    if (msg.indexOf("TEAM_MEMBER_NOT_FOUND") >= 0) msg = "Utilizador nao encontrado.";

    toast("Erro equipa: " + msg, "error");
  }
}

function getCoreProfileAccessMessage(profile) {
  var status = String(profile && profile.status ? profile.status : "").toLowerCase();

  if (status === "pending") {
    return "A tua conta esta a aguardar autorizacao do proprietario.";
  }

  if (status === "blocked" || status === "inactive" || status === "suspended") {
    return "Acesso recusado pelo proprietario da loja.";
  }

  return "Acesso do utilizador invalido.";
}

function approvalSafeText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showPendingApprovalScreen(profile) {
  var existing = document.getElementById("approval-lock-screen");
  if (existing) existing.remove();

  document.body.classList.add("approval-locked");

  var name = approvalSafeText((profile && profile.name) || localStorage.getItem("azul_user_name") || "Utilizador");
  var email = approvalSafeText((profile && profile.email) || "");
  var organizationName = approvalSafeText(localStorage.getItem("azul_organization_name") || "a loja");

  var screen = document.createElement("div");
  screen.id = "approval-lock-screen";
  screen.className = "approval-lock-screen";
  screen.innerHTML = `
    <div class="approval-lock-card" role="dialog" aria-modal="true" aria-labelledby="approval-lock-title">
      <div class="approval-lock-head">
        <div class="approval-lock-mark">!</div>
      </div>
      <div class="approval-lock-body">
        <p class="approval-lock-eyebrow">Primeira utilizacao</p>
        <h1 id="approval-lock-title">Sessao em validacao</h1>
        <p class="approval-lock-text">
          A tua conta esta pronta para <strong>${organizationName}</strong>, mas a entrada ainda precisa ser aprovada pelo proprietario.
        </p>
        <div class="approval-lock-user">
          <strong>${name}</strong>
          <span>${email}</span>
        </div>
        <p class="approval-lock-hint">
          Pede ao proprietario para validar a tua sessao em Definicoes > Equipe. Assim que for aprovado, volta a entrar normalmente.
        </p>
        <button type="button" onclick="logoutPendingApproval()">Voltar ao login</button>
      </div>
    </div>
  `;

  document.body.appendChild(screen);
}

async function logoutPendingApproval() {
  try {
    await supabaseClient.auth.signOut();
  } catch (e) {
    console.warn("Erro ao terminar sessao pendente:", e);
  }

  clearAzulSession();
  window.location.replace("index.html");
}

async function getCurrentCoreProfile() {
  var organizationId = localStorage.getItem("azul_organization_id");
  var userResult = await supabaseClient.auth.getUser();

  if (userResult.error || !userResult.data || !userResult.data.user) {
    return null;
  }

  var user = userResult.data.user;
  var email = user.email || "";

  if (!email || !organizationId) return null;

  var result = await supabaseClient
    .from("profiles")
    .select("organization_id,name,email,phone,role,status")
    .eq("organization_id", organizationId)
    .ilike("email", email)
    .maybeSingle();

  if (result.error || !result.data) {
    result = await supabaseClient.rpc("get_login_profile_for_org", {
      p_organization_id: organizationId,
      p_identifier: email
    }).maybeSingle();
  }

  if (result.error && String(result.error.message || "").indexOf("get_login_profile_for_org") >= 0) {
    result = await supabaseClient.rpc("get_login_profile_v2", {
      p_identifier: email
    }).maybeSingle();
  }

  if (result.error) throw result.error;

  var profile = result.data || null;
  if (!profile || String(profile.organization_id) !== String(organizationId)) return null;

  return profile;
}

async function verifyCurrentUserAccess() {
  try {
    var profile = await getCurrentCoreProfile();

    if (!profile) {
      alert("Sessao de utilizador invalida. Entre novamente.");
      await supabaseClient.auth.signOut();
      clearAzulSession();
      window.location.replace("index.html");
      return false;
    }

    var status = String(profile.status || "active").toLowerCase();

    localStorage.setItem("azul_user_name", profile.name || profile.email || "Utilizador");
    localStorage.setItem("azul_user_role", profile.role || "member");
    localStorage.setItem("azul_user_status", status);

    if (status === "pending") {
      showPendingApprovalScreen(profile);
      return false;
    }

    if (status !== "active") {
      alert(getCoreProfileAccessMessage(profile));
      await supabaseClient.auth.signOut();
      clearAzulSession();
      window.location.replace("index.html");
      return false;
    }

    return true;
  } catch (e) {
    alert("Erro ao validar utilizador: " + (e.message || e));
    await supabaseClient.auth.signOut();
    clearAzulSession();
    window.location.replace("index.html");
    return false;
  }
}

window.logoutPendingApproval = logoutPendingApproval;

async function touchCurrentTeamUser() {
  var organizationId = localStorage.getItem("azul_organization_id");
  if (!organizationId) return;

  try {
    var userResult = await supabaseClient.auth.getUser();

    if (!userResult || !userResult.data || !userResult.data.user) return;

    var user = userResult.data.user;
    var meta = user.user_metadata || {};
    var email = user.email || meta.email || "";
    var name = localStorage.getItem("azul_user_name") || meta.name || meta.nome || "";
    var phone = meta.phone || meta.numero || "";
    var role = localStorage.getItem("azul_user_role") || meta.role || "member";

    if (!email) return;

    var result = await supabaseClient.rpc("touch_team_user", {
      p_organization_id: organizationId,
      p_name: name || email,
      p_phone: phone || "",
      p_email: email,
      p_role: role || "member"
    });

    if (result.error) throw result.error;
  } catch (e) {
    console.warn("Presenca da equipa nao actualizada:", e);
  }
}

async function renderSettingsTeamCard() {
  var list = document.getElementById("settings-team-list");
  var card = document.getElementById("settings-team-card");
  var organizationId = localStorage.getItem("azul_organization_id");

  if (!list || !organizationId) return;

  if (!canManageTeamRoles()) {
    if (card) card.style.display = "none";
    return;
  }

  if (card) card.style.display = "";

  list.innerHTML = '<div class="empty">A carregar equipa...</div>';

  try {
    await touchCurrentTeamUser();
    var roleCatalog = await loadAzulRoleCatalog(true);

    var result = await supabaseClient.rpc("get_organization_team", {
      p_organization_id: organizationId
    });

    if (result.error) throw result.error;

    var users = result.data || [];

    if (!users.length) {
      list.innerHTML = '<div class="empty">Nenhum utilizador encontrado.</div>';
      return;
    }

    var canManage = canManageTeamRoles();
    var customRoles = Object.keys(roleCatalog).filter(function(code) {
      return roleCatalog[code] && !roleCatalog[code].isSystem;
    });

    var customRoleBuilder = canManage ? `
      <div class="custom-role-builder">
        <div>
          <strong>Roles personalizados</strong>
          <span>Crie uma funcao a partir de um modelo e ajuste depois pela base de permissoes.</span>
        </div>
        <div class="custom-role-form">
          <input id="custom-role-name" type="text" placeholder="Ex: Caixa noite">
          <select id="custom-role-base">${getBaseRoleOptionsForCustomRole()}</select>
          <button type="button" onclick="createCustomRoleFromBase()">Criar role</button>
        </div>
        <div class="custom-role-list">
          ${customRoles.length ? customRoles.map(function(code) {
            return '<span>' + escapeDepenseHtml(roleCatalog[code].name || code) + '</span>';
          }).join("") : '<em>Nenhum role personalizado ainda.</em>'}
        </div>
      </div>
    ` : "";

    list.innerHTML = customRoleBuilder + users.map(function(user) {
      var name = user.name || "Utilizador";
      var email = user.email || "-";
      var phone = user.phone || "-";
      var rawRole = String(user.role || "member").toLowerCase();
      var role = getTeamRoleLabel(rawRole);
      var status = String(user.status || "active").toLowerCase();
      var statusText = getTeamStatusLabel(status);
      var initial = getTeamInitial(name, email);
      var key = getTeamMemberDomKey(email);
      var encodedEmail = encodeURIComponent(email);
      var controls = canManage ? `
            <div class="team-user-controls">
              <label>
                <span>Role</span>
                <select id="team-role-${escapeDepenseHtml(key)}">${getTeamRoleOptions(rawRole, roleCatalog)}</select>
              </label>

              <label>
                <span>Estado</span>
                <select id="team-status-${escapeDepenseHtml(key)}">${getTeamStatusOptions(status)}</select>
              </label>

              <button type="button" onclick="saveTeamMemberRoleStatus('${escapeDepenseHtml(encodedEmail)}')">Guardar</button>
              ${status === "pending" ? `<button type="button" class="approve" onclick="document.getElementById('team-status-${escapeDepenseHtml(key)}').value='active'; saveTeamMemberRoleStatus('${escapeDepenseHtml(encodedEmail)}')">Aceitar</button>` : ""}
              <button type="button" class="danger ghost" onclick="rejectTeamMember('${escapeDepenseHtml(encodedEmail)}')">Recusar</button>
              <button type="button" class="danger" onclick="deleteTeamMember('${escapeDepenseHtml(encodedEmail)}')">Eliminar</button>
            </div>
      ` : "";

      return `
        <div class="team-user-card">
          <div class="team-user-avatar">${escapeDepenseHtml(initial)}</div>

          <div class="team-user-info">
            <div class="team-user-top">
              <strong>${escapeDepenseHtml(name)}</strong>
              <span class="team-user-status ${escapeDepenseHtml(status)}">${escapeDepenseHtml(statusText)}</span>
            </div>

            <div class="team-user-meta">
              <span>${escapeDepenseHtml(role)}</span>
              <span>${escapeDepenseHtml(email)}</span>
              <span>${escapeDepenseHtml(phone)}</span>
            </div>

            <div class="team-user-last">
              Ultima actividade: ${escapeDepenseHtml(formatTeamDate(user.last_seen_at))}
            </div>

            ${renderRolePermissionChips(rawRole)}

            ${controls}
          </div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("Erro equipa:", e);
    list.innerHTML = '<div class="empty">Erro equipa: ' + escapeDepenseHtml(e.message || e) + '</div>';
  }
}
function initErpLockSystem() {
  injectLockSettingsCard();

  if (isErpLocked()) {
    setErpLockedVisualState(true);
    showErpLockScreen();
    startErpLockWatcher();
  }
}

document.addEventListener("DOMContentLoaded", initErpLockSystem);

function togglePasswordVisibility(inputId, button) {
  var input = document.getElementById(inputId);
  if (!input || !button) return;

  if (input.type === "password") {
    input.type = "text";
    button.innerHTML = "&#128584;";
    button.setAttribute("aria-label", "Masquer le mot de passe");
  } else {
    input.type = "password";
    button.innerHTML = "&#128065;";
    button.setAttribute("aria-label", "Afficher le mot de passe");
  }
}

function renderFornNameDatalist() {
  renderSupplierDatalists();
}

function renderFornPayDatalist() {
  renderSupplierDatalists();
}

async function migrateAccountingEntriesFromExistingData() {
  toast("Migration comptable deja terminee. Fonction desactivee pour eviter une relance accidentelle.", "error");
  return false;
}

var erpLockWatchTimer = null;

function isErpLocked() {
  return localStorage.getItem(AZUL_LOCKED_KEY) === "1";
}

function setErpLockedVisualState(locked) {
  if (locked) {
    document.documentElement.setAttribute("data-erp-locked", "1");
    document.body.style.overflow = "hidden";
  } else {
    document.documentElement.removeAttribute("data-erp-locked");
    document.body.style.overflow = "";
  }
}

function startErpLockWatcher() {
  if (erpLockWatchTimer) return;

  erpLockWatchTimer = setInterval(function() {
    if (!isErpLocked()) return;

    setErpLockedVisualState(true);

    if (!document.getElementById("erpLockOverlay")) {
      showErpLockScreen();
    }
  }, 700);
}

function stopErpLockWatcher() {
  if (erpLockWatchTimer) {
    clearInterval(erpLockWatchTimer);
    erpLockWatchTimer = null;
  }
}

// Correction finale: fournisseurs depuis Supabase, pas Google Sheet
renderFornNameDatalist = function() {
  renderSupplierDatalists();
};

renderFornPayDatalist = function() {
  renderSupplierDatalists();
};

refreshFornecedorDatalists = function() {
  renderSupplierDatalists();
};
