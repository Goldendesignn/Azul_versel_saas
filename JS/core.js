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
var services = [];
var productsLoading = false;
var servicesLoading = false;
var saleCatalogMode = "products";
var saleSaveInProgress = false;
var purchaseSaveInProgress = false;
var expenseSaveInProgress = false;
var clientPaymentInProgress = false;
var supplierPaymentInProgress = false;
var revSaveInProgress = false;
var revActionInProgress = false;
var revLastSelectionKey = "";

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
  return '<span class="action-author">Criado por ' + escapeDespesaHtml(getActionAuthorLabel(row)) + '</span>';
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
    await notifyAzulTableInsert(tableName, result.data);
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
  services: "service:create",
  client_payments: "client_payment:create",
  supplier_payments: "supplier_payment:create",
  corrections_log: "correction:create",
  treasury_entries: "cash:create",
  stock_transfers: "stock:transfer",
  deliveries: "logistics:create",
  reseller_consignments: "reseller:create",
  hr_employees: "hr:create",
  hr_attendance: "hr:create",
  hr_payments: "hr:create"
};

var azulNotificationsCache = [];
var azulNotificationsOpen = false;
var azulNotificationsTimer = null;
var azulPwaNotificationsReady = false;
var azulNotificationsRealtimeChannel = null;

function canReceiveAzulNotifications() {
  var role = getAzulCurrentRole();
  return role === "owner" || role === "manager";
}

function supportsAzulPwaNotifications() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

function getAzulVapidPublicKey() {
  return String(window.AZUL_VAPID_PUBLIC_KEY || localStorage.getItem("azul_vapid_public_key") || "").trim();
}

function hasAzulVapidPublicKey() {
  return getAzulVapidPublicKey().length > 20;
}

function urlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var rawData = window.atob(base64);
  var outputArray = new Uint8Array(rawData.length);

  for (var i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

function getAzulPwaNotificationStorageKey(userId) {
  var organizationId = localStorage.getItem("azul_organization_id") || "global";
  return "azul_pwa_seen_notifications_" + organizationId + "_" + (userId || "user");
}

function readAzulPwaSeenNotificationIds(userId) {
  try {
    var raw = localStorage.getItem(getAzulPwaNotificationStorageKey(userId));
    var parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function saveAzulPwaSeenNotificationIds(userId, rows) {
  try {
    var ids = (rows || [])
      .map(function(row) { return row && row.id ? String(row.id) : ""; })
      .filter(Boolean)
      .slice(0, 80);

    localStorage.setItem(getAzulPwaNotificationStorageKey(userId), JSON.stringify(ids));
  } catch (e) {}
}

function syncAzulPwaNotificationButton() {
  var btn = document.getElementById("pwaNotificationBtn");
  if (!btn) return;

  btn.classList.remove("active", "blocked");

  if (!supportsAzulPwaNotifications()) {
    btn.textContent = "Indisponivel";
    btn.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    if (hasAzulVapidPublicKey()) {
      btn.textContent = "Push ativo";
      btn.classList.add("active");
      btn.disabled = true;
    } else {
      btn.textContent = "Configurar Push";
      btn.disabled = false;
    }
    return;
  }

  if (Notification.permission === "denied") {
    btn.textContent = "Bloqueado";
    btn.classList.add("blocked");
    btn.disabled = true;
    return;
  }

  btn.textContent = "Ativar PWA";
  btn.disabled = false;
}

async function requestAzulPwaNotificationPermission() {
  if (!supportsAzulPwaNotifications()) {
    toast("Este navegador nao suporta notificacoes PWA.", "error");
    syncAzulPwaNotificationButton();
    return;
  }

  try {
    var permission = await Notification.requestPermission();
    syncAzulPwaNotificationButton();

    if (permission === "granted") {
      azulPwaNotificationsReady = true;
      await registerAzulPushSubscription(true);
      toast("Notificacoes PWA ativadas.", "success");
      await showAzulPwaNotification({
        id: "azul-test-" + Date.now(),
        title: "Notificacoes ativadas",
        message: "Vais receber alertas mesmo com a app fechada quando o Web Push estiver configurado.",
        source_type: "settings"
      }, true);
    } else if (permission === "denied") {
      toast("Permissao bloqueada no navegador. Ative nas definicoes do site.", "error");
    }
  } catch (e) {
    toast("Erro ao ativar notificacoes PWA.", "error");
  }
}

async function registerAzulPushSubscription(showFeedback) {
  if (!supportsAzulPwaNotifications()) return null;
  if (Notification.permission !== "granted") return null;

  var vapidPublicKey = getAzulVapidPublicKey();
  if (!vapidPublicKey) {
    if (showFeedback) toast("Falta configurar a chave publica VAPID em JS/push-config.js.", "error");
    syncAzulPwaNotificationButton();
    return null;
  }

  try {
    var registration = await navigator.serviceWorker.ready;
    var subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await createAzulPushSubscription(registration, vapidPublicKey);
    }

    await saveAzulPushSubscription(subscription);
    syncAzulPwaNotificationButton();
    return subscription;
  } catch (e) {
    console.warn("Subscricao push indisponivel:", e);
    if (showFeedback) toast("Erro ao registar Push. Verifique a chave VAPID.", "error");
    return null;
  }
}

async function createAzulPushSubscription(registration, vapidPublicKey) {
  try {
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
    });
  } catch (e) {
    var oldSubscription = await registration.pushManager.getSubscription();
    if (oldSubscription) {
      try {
        await oldSubscription.unsubscribe();
      } catch (ignored) {}

      return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }

    throw e;
  }
}

async function saveAzulPushSubscription(subscription) {
  if (!subscription || !supabaseClient) return;

  var organizationId = localStorage.getItem("azul_organization_id");
  if (!organizationId) return;

  var json = subscription.toJSON ? subscription.toJSON() : {};
  var keys = json.keys || {};
  var userResult = await supabaseClient.auth.getUser();
  var user = userResult && userResult.data ? userResult.data.user : null;
  var meta = user && user.user_metadata ? user.user_metadata : {};

  var row = {
    organization_id: organizationId,
    user_id: user && user.id ? user.id : null,
    user_name: localStorage.getItem("azul_user_name") || meta.name || meta.nome || "Utilizador",
    user_email: user && user.email ? user.email : "",
    user_role: getAzulCurrentRole(),
    device_id: localStorage.getItem("azul_device_id") || "",
    endpoint: subscription.endpoint,
    p256dh: keys.p256dh || "",
    auth: keys.auth || "",
    browser_name: typeof getCurrentDeviceNameForSettings === "function" ? getCurrentDeviceNameForSettings() : navigator.userAgent,
    active: true,
    last_seen_at: new Date().toISOString()
  };

  var result = await supabaseClient
    .from("push_subscriptions")
    .upsert(row, { onConflict: "endpoint" });

  if (result.error) throw result.error;
}

async function showAzulPwaNotification(row, force) {
  if (!supportsAzulPwaNotifications()) return;
  if (Notification.permission !== "granted") return;
  if (!force && azulNotificationsOpen) return;

  try {
    var registration = await navigator.serviceWorker.ready;
    if (!registration || !registration.showNotification) return;

    var title = row && row.title ? String(row.title) : "Azul Gestao";
    var message = row && row.message ? String(row.message) : "Nova notificacao";

    await registration.showNotification(title, {
      body: message,
      icon: "/Assets/icon-192.png",
      badge: "/Assets/icon-192.png",
      tag: row && row.id ? "azul-" + row.id : "azul-notification",
      renotify: false,
      data: {
        url: "/core.html",
        notificationId: row && row.id ? row.id : "",
        sourceType: row && row.source_type ? row.source_type : ""
      }
    });
  } catch (e) {
    console.warn("Notificacao PWA indisponivel:", e);
  }
}

async function showNewAzulPwaNotifications(rows, userId) {
  if (!supportsAzulPwaNotifications() || Notification.permission !== "granted") return;

  var seenIds = readAzulPwaSeenNotificationIds(userId);
  if (seenIds === null) {
    saveAzulPwaSeenNotificationIds(userId, rows);
    return;
  }

  var seenMap = {};
  seenIds.forEach(function(id) { seenMap[id] = true; });

  var unreadNewRows = (rows || []).filter(function(row) {
    if (!row || !row.id || seenMap[String(row.id)]) return false;
    return !isAzulNotificationRead(row, userId);
  });

  unreadNewRows.reverse().slice(0, 3).forEach(function(row) {
    showAzulPwaNotification(row, false);
  });

  saveAzulPwaSeenNotificationIds(userId, rows);
}

async function handleAzulRealtimeNotification(payload) {
  try {
    if (!payload || !canReceiveAzulNotifications()) return;

    var row = payload.new || null;
    if (!row) return;

    var role = getAzulCurrentRole();
    var userId = await getAzulCurrentUserId();

    if (!isAzulNotificationVisibleForCurrentUser(row, role, userId)) return;

    upsertAzulNotificationCache(row);
    await renderAzulNotifications();

    if (payload.eventType === "INSERT") {
      await showAzulPwaNotification(row, false);
      saveAzulPwaSeenNotificationIds(userId, azulNotificationsCache);
    }
  } catch (e) {
    console.warn("Realtime notificacoes indisponivel:", e);
  }
}

function stopAzulNotificationsRealtime() {
  try {
    if (azulNotificationsRealtimeChannel && supabaseClient && supabaseClient.removeChannel) {
      supabaseClient.removeChannel(azulNotificationsRealtimeChannel);
    }
  } catch (e) {}

  azulNotificationsRealtimeChannel = null;
}

function startAzulNotificationsRealtime() {
  if (!canReceiveAzulNotifications()) return false;
  if (!supabaseClient || !supabaseClient.channel) return false;

  var organizationId = localStorage.getItem("azul_organization_id");
  if (!organizationId) return false;

  stopAzulNotificationsRealtime();

  try {
    azulNotificationsRealtimeChannel = supabaseClient
      .channel("azul-notifications-" + organizationId)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: "organization_id=eq." + organizationId
      }, handleAzulRealtimeNotification)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "notifications",
        filter: "organization_id=eq." + organizationId
      }, handleAzulRealtimeNotification)
      .subscribe(function(status) {
        if (status === "SUBSCRIBED") {
          loadAzulNotifications(true);
        }
      });

    return true;
  } catch (e) {
    console.warn("Realtime notificacoes nao iniciado:", e);
    stopAzulNotificationsRealtime();
    return false;
  }
}

function getAzulNotificationTargetRoles(actorRole) {
  actorRole = String(actorRole || "").toLowerCase();

  if (actorRole === "owner") return [];
  if (actorRole === "manager") return ["owner"];
  return ["owner", "manager"];
}

function getAzulNotificationReadList(row) {
  var readBy = row && row.read_by;
  if (Array.isArray(readBy)) return readBy;

  if (typeof readBy === "string") {
    try {
      var parsed = JSON.parse(readBy);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  return [];
}

function isAzulNotificationRead(row, userId) {
  if (!userId) return false;
  return getAzulNotificationReadList(row).indexOf(userId) >= 0;
}

function isAzulNotificationVisibleForCurrentUser(row, role, userId) {
  if (!row) return false;

  var organizationId = localStorage.getItem("azul_organization_id") || "";
  if (organizationId && row.organization_id && String(row.organization_id) !== String(organizationId)) {
    return false;
  }

  var targets = Array.isArray(row.target_roles) ? row.target_roles : [];
  var actorId = row.actor_user_id ? String(row.actor_user_id) : "";

  return targets.indexOf(role) >= 0 && (!userId || actorId !== String(userId));
}

function sortAzulNotificationsCache() {
  azulNotificationsCache.sort(function(a, b) {
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
}

function upsertAzulNotificationCache(row) {
  if (!row || !row.id) return;

  var found = false;
  azulNotificationsCache = (azulNotificationsCache || []).map(function(item) {
    if (String(item.id) === String(row.id)) {
      found = true;
      return row;
    }
    return item;
  });

  if (!found) azulNotificationsCache.unshift(row);

  sortAzulNotificationsCache();
  azulNotificationsCache = azulNotificationsCache.slice(0, 50);
}

function formatAzulNotificationTime(value) {
  if (!value) return "";

  try {
    return new Date(value).toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (e) {
    return String(value);
  }
}

function getAzulNotificationFromTable(tableName, row) {
  row = row || {};
  var actor = getAzulCurrentUserName();

  if (tableName === "sales") {
    return {
      actionType: "sale:create",
      title: actor + " registou uma venda",
      message: "Total: " + fmt(Number(row.total) || 0),
      sourceType: "sale"
    };
  }

  if (tableName === "expenses") {
    return {
      actionType: "expense:create",
      title: actor + " registou uma despesa",
      message: (row.category || "Despesa") + " - " + fmt(Number(row.amount) || 0),
      sourceType: "expense"
    };
  }

  if (tableName === "client_payments") {
    return {
      actionType: "client_payment:create",
      title: actor + " registou um pagamento de cliente",
      message: (row.client_name || "Cliente") + " - " + fmt(Number(row.amount) || 0),
      sourceType: "client_payment"
    };
  }

  if (tableName === "supplier_payments") {
    return {
      actionType: "supplier_payment:create",
      title: actor + " registou um pagamento a fornecedor",
      message: (row.supplier || "Fornecedor") + " - " + fmt(Number(row.amount) || 0),
      sourceType: "supplier_payment"
    };
  }

  if (tableName === "treasury_entries") {
    return {
      actionType: "cash:create",
      title: actor + " registou movimento de tesouraria",
      message: (row.type || "Movimento") + " - " + fmt(Number(row.amount) || 0),
      sourceType: "treasury"
    };
  }

  if (tableName === "reseller_consignments") {
    return {
      actionType: "reseller:create",
      title: actor + " criou uma consignacao",
      message: (row.reseller_name || "Revendedor") + " - " + fmt(Number(row.total) || 0),
      sourceType: "reseller_consignment"
    };
  }

  if (tableName === "deliveries") {
    return {
      actionType: "logistics:create",
      title: actor + " criou uma entrega",
      message: (row.customer_name || "Cliente") + " - " + (row.delivery_number || "entrega") + " - " + fmt(Number(row.amount || 0) + Number(row.delivery_fee || 0)),
      sourceType: "delivery"
    };
  }

  if (tableName === "hr_payments") {
    return {
      actionType: "hr:create",
      title: actor + " registou pagamento RH",
      message: (row.employee_name || "Funcionario") + " - " + fmt(Number(row.amount) || 0),
      sourceType: "hr_payment"
    };
  }

  return null;
}

async function createAzulNotification(options) {
  try {
    options = options || {};
    var organizationId = localStorage.getItem("azul_organization_id");
    if (!organizationId || !options.title) return;

    var audit = await getAzulAuditFields();
    var actorRole = getAzulCurrentRole();
    var targetRoles = options.targetRoles || getAzulNotificationTargetRoles(actorRole);
    if (!targetRoles.length) return;

    var result = await supabaseClient.from("notifications").insert({
      organization_id: organizationId,
      actor_user_id: audit.created_by || null,
      actor_name: audit.user_name || getAzulCurrentUserName(),
      actor_role: actorRole,
      action_type: options.actionType || "action",
      title: options.title,
      message: options.message || "",
      source_type: options.sourceType || "",
      source_id: options.sourceId || null,
      target_roles: targetRoles,
      details: options.details || {}
    });

    if (result.error) throw result.error;
    loadAzulNotifications(true);
  } catch (e) {
    console.warn("Notification nao registada:", e);
  }
}

async function notifyAzulTableInsert(tableName, row) {
  var notification = getAzulNotificationFromTable(tableName, row);
  if (!notification) return;

  notification.sourceId = row && row.id ? row.id : null;
  notification.details = {
    source_table: tableName
  };

  await createAzulNotification(notification);
}

async function notifyAzulResellerAction(actionType, rows, amount) {
  rows = rows || [];
  var first = rows[0] || {};
  var count = rows.length;
  var resellerName = first.reseller_name || "Revendedor";
  var actor = getAzulCurrentUserName();
  var title = "";
  var message = "";
  var sourceType = "reseller";

  if (actionType === "reseller:payment") {
    title = actor + " registou pagamento de revendedor";
    message = resellerName + " - " + fmt(amount || 0) + " em " + count + " consignacao(oes)";
  } else if (actionType === "reseller:return") {
    title = actor + " registou devolucao de revendedor";
    message = resellerName + " - " + count + " consignacao(oes)";
  } else {
    title = actor + " criou consignacao para revendedor";
    message = resellerName + " - " + fmt(amount || 0) + " em " + count + " consignacao(oes)";
    sourceType = "reseller_consignment";
  }

  await createAzulNotification({
    actionType: actionType,
    title: title,
    message: message,
    sourceType: sourceType,
    sourceId: count === 1 && first.id ? first.id : null,
    details: {
      reseller_name: resellerName,
      consignments: rows.map(function(row) {
        return {
          id: row.id || "",
          consignment_no: row.consignment_no || "",
          total: Number(row.total) || 0,
          paid_amount: Number(row.paid_amount) || 0,
          status: row.status || ""
        };
      }),
      amount: Number(amount) || 0
    }
  });

  await logAzulAction(actionType, "reseller", "success", {
    source_table: "reseller_consignments",
    source_id: count === 1 && first.id ? first.id : null,
    reseller_name: resellerName,
    count: count,
    amount: Number(amount) || 0
  });
}

async function getAzulCurrentUserId() {
  try {
    var audit = await getAzulAuditFields();
    if (audit && audit.created_by) return audit.created_by;
  } catch (e) {}

  return "";
}

function setAzulNotificationBadge(count) {
  var badge = document.getElementById("notificationBadge");
  var subtitle = document.getElementById("notificationSubtitle");

  if (badge) {
    badge.textContent = count > 99 ? "99+" : String(count || 0);
    badge.style.display = count > 0 ? "grid" : "none";
  }

  if (subtitle) {
    subtitle.textContent = count > 0
      ? count + " nova(s) notificacao(oes)"
      : "Sem novas notificacoes";
  }
}

async function renderAzulNotifications() {
  var list = document.getElementById("notificationList");
  if (!list) return;

  var userId = await getAzulCurrentUserId();
  var currentRows = azulNotificationsCache || [];
  var unread = currentRows.filter(function(row) {
    return !isAzulNotificationRead(row, userId);
  }).length;

  setAzulNotificationBadge(unread);

  if (!currentRows.length) {
    list.innerHTML = '<div class="notification-empty">Nenhuma notificacao.</div>';
    return;
  }

  list.innerHTML = currentRows.map(function(row) {
    var read = isAzulNotificationRead(row, userId);

    return '<div class="notification-item ' + (read ? 'read' : 'unread') + '">' +
      '<div class="notification-dot"></div>' +
      '<div class="notification-content">' +
        '<div class="notification-title">' + escapeDespesaHtml(row.title || "Notificacao") + '</div>' +
        '<div class="notification-message">' + escapeDespesaHtml(row.message || "") + '</div>' +
        '<div class="notification-time">' + escapeDespesaHtml(formatAzulNotificationTime(row.created_at)) + '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}

async function loadAzulNotifications(silent) {
  var wrap = document.getElementById("notificationWrap");
  if (!wrap) return;

  if (!canReceiveAzulNotifications()) {
    wrap.style.display = "none";
    return;
  }

  wrap.style.display = "block";

  try {
    var organizationId = localStorage.getItem("azul_organization_id");
    if (!organizationId) return;

    var role = getAzulCurrentRole();
    var userId = await getAzulCurrentUserId();

    var result = await supabaseClient
      .from("notifications")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (result.error) throw result.error;

    azulNotificationsCache = (result.data || []).filter(function(row) {
      return isAzulNotificationVisibleForCurrentUser(row, role, userId);
    });

    await renderAzulNotifications();
    await showNewAzulPwaNotifications(azulNotificationsCache, userId);
  } catch (e) {
    if (!silent) console.warn("Notificacoes indisponiveis:", e);
    if (wrap) wrap.style.display = "none";
  }
}

function toggleAzulNotifications() {
  var panel = document.getElementById("notificationPanel");
  if (!panel) return;

  azulNotificationsOpen = !panel.classList.contains("open");
  panel.classList.toggle("open", azulNotificationsOpen);

  if (azulNotificationsOpen) {
    loadAzulNotifications(true);
  }
}

async function markAllAzulNotificationsRead() {
  try {
    var userId = await getAzulCurrentUserId();
    if (!userId) return;

    var unreadRows = (azulNotificationsCache || []).filter(function(row) {
      return !isAzulNotificationRead(row, userId);
    });

    for (var i = 0; i < unreadRows.length; i++) {
      var row = unreadRows[i];
      var readBy = getAzulNotificationReadList(row);
      if (readBy.indexOf(userId) < 0) readBy.push(userId);

      var result = await supabaseClient
        .from("notifications")
        .update({ read_by: readBy })
        .eq("id", row.id);

      if (result.error) throw result.error;
      row.read_by = readBy;
    }

    await renderAzulNotifications();
  } catch (e) {
    toast("Erro notificacoes: " + (e.message || e), "error");
  }
}

function startAzulNotifications() {
  syncAzulPwaNotificationButton();

  if (!canReceiveAzulNotifications()) {
    var wrap = document.getElementById("notificationWrap");
    if (wrap) wrap.style.display = "none";
    return;
  }

  azulPwaNotificationsReady = supportsAzulPwaNotifications() && Notification.permission === "granted";
  if (azulPwaNotificationsReady) registerAzulPushSubscription(false);
  loadAzulNotifications(true);
  checkOnlineOrderReminders(true);
  checkLogisticsReminders(true);
  startAzulNotificationsRealtime();

  if (azulNotificationsTimer) clearInterval(azulNotificationsTimer);
  azulNotificationsTimer = setInterval(function() {
    loadAzulNotifications(true);
    checkOnlineOrderReminders(true);
    checkLogisticsReminders(true);
  }, 120000);
}

document.addEventListener("click", function(event) {
  var panel = document.getElementById("notificationPanel");
  var wrap = document.getElementById("notificationWrap");
  if (!panel || !wrap || !panel.classList.contains("open")) return;
  if (wrap.contains(event.target)) return;

  panel.classList.remove("open");
  azulNotificationsOpen = false;
});

window.toggleAzulNotifications = toggleAzulNotifications;
window.markAllAzulNotificationsRead = markAllAzulNotificationsRead;
window.requestAzulPwaNotificationPermission = requestAzulPwaNotificationPermission;

var AZUL_CONTEXT_HELP = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Painel para acompanhar vendas, tesouraria, dividas, stock e alertas da loja.",
    main: [
      "Use o filtro de periodo para analisar hoje, semana, mes ou datas personalizadas.",
      "Os KPIs principais mostram vendas, lucro, despesas e alertas de stock.",
      "As secoes de dividas, stock inteligente e contabilidade resumem a saude do negocio."
    ],
    care: [
      "Se um valor parecer antigo, toque em Aplicar ou Atualizar.",
      "Os filtros do dashboard afectam os blocos de resumo do periodo."
    ],
    tip: "Comece o dia pelo dashboard para ver o que precisa de atencao antes de vender."
  },
  performance: {
    title: "Analise comercial",
    subtitle: "Painel detalhado para entender produtos, lucro, variacoes, clientes e horarios de venda.",
    main: [
      "Usa os filtros para comparar um periodo, produto, categoria ou vendedor.",
      "A vista Produtos mostra faturacao, lucro, margem e quantidade por artigo.",
      "A vista Dias e horas ajuda a escolher os melhores momentos para abrir, promover ou reforcar a equipe."
    ],
    care: [
      "As horas usam o momento real em que a venda foi registada.",
      "Quando filtras um produto ou categoria, todos os indicadores passam a mostrar apenas essa selecao."
    ],
    tip: "Comeca pelos produtos com maior lucro, nao apenas pelos que mais faturam."
  },
  venda: {
    title: "Nova venda",
    subtitle: "Modulo para registar vendas, escolher produtos, confirmar pagamento e emitir recibo.",
    main: [
      "Pesquise ou toque num produto para adicionar ao carrinho.",
      "Venda interna baixa o stock; venda externa nao baixa o stock.",
      "Pagamento a credito exige o nome do cliente para criar a divida."
    ],
    care: [
      "A verificacao de stock acontece na confirmacao quando a venda e interna.",
      "Pode combinar Cash, Express, Cartao e Credito no pagamento."
    ],
    tip: "No telemovel, use a barra Ver carrinho para abrir o pagamento sem perder a lista de produtos."
  },
  achat: {
    title: "Nova compra",
    subtitle: "Modulo para dar entrada de mercadoria, fornecedores, variacoes, imagens e dividas de compra.",
    main: [
      "Informe fornecedor, produto, quantidade, preco de compra e preco de venda.",
      "Se marcar compra a credito, o restante vira divida do fornecedor.",
      "Use importacao CSV para grandes listas de compras."
    ],
    care: [
      "O modo de stock definido nas Definicoes decide se a compra entra na loja ou no armazem.",
      "Codigo, categoria, variacao e foto ajudam a encontrar produtos depois."
    ],
    tip: "Para evitar erros de stock, registe primeiro a compra antes de fazer transferencias."
  },
  transfert: {
    title: "Estoque",
    subtitle: "Modulo para consultar stock, pesquisar produtos e transferir mercadoria do armazem para a loja.",
    main: [
      "Use a pesquisa para encontrar produto, fornecedor, codigo ou variacao.",
      "A tabela mostra loja, armazem, total e valor do stock.",
      "Quando usa armazem, transfira produtos para a loja antes da venda interna."
    ],
    care: [
      "Stock da loja e o stock usado na venda interna.",
      "Produtos esgotados ou abaixo do minimo aparecem tambem no dashboard."
    ],
    tip: "Com muitos produtos, pesquise pelo codigo ou fornecedor para ganhar tempo."
  },
  clientes: {
    title: "Clientes",
    subtitle: "Modulo para consultar ficha do cliente, historico, dividas e registar pagamentos recebidos.",
    main: [
      "Na ficha, pesquise o nome do cliente para ver compras, divida e transacoes.",
      "Em registar pagamento, informe cliente, data e montante pago.",
      "Pagamentos reduzem a divida criada por vendas a credito."
    ],
    care: [
      "Use sempre o mesmo nome do cliente para manter o historico unido.",
      "Vendas anonimas nao criam ficha de credito."
    ],
    tip: "Antes de aceitar uma nova venda a credito, consulte a ficha do cliente."
  },
  depenses: {
    title: "Despesas",
    subtitle: "Modulo para registar gastos da loja e acompanhar impacto no caixa e nos resultados.",
    main: [
      "Registe categoria, descricao, data e valor da despesa.",
      "O dashboard de despesas mostra totais e historico por periodo.",
      "As despesas entram na contabilidade e reduzem o resultado."
    ],
    care: [
      "Use categorias consistentes para relatórios mais limpos.",
      "Corrija despesas erradas pelo modulo Correcoes."
    ],
    tip: "Registe despesas no mesmo dia para manter a tesouraria realista."
  },
  rh: {
    title: "Recursos Humanos",
    subtitle: "Modulo para gerir colaboradores, presencas e pagamentos de equipa.",
    main: [
      "Crie a ficha do colaborador com funcao e contacto.",
      "Registe presencas para acompanhar actividade.",
      "Pagamentos RH ajudam a controlar custos da equipa."
    ],
    care: [
      "Mantenha nomes consistentes para evitar duplicados.",
      "Pagamentos RH podem aparecer nos relatórios conforme a configuracao."
    ],
    tip: "Use o RH para separar gastos de equipa das outras despesas operacionais."
  },
  forn: {
    title: "Fornecedores",
    subtitle: "Modulo para ver ficha do fornecedor, historico de compras, pagamentos e dividas.",
    main: [
      "Fornecedores podem ser criados automaticamente durante a compra.",
      "Abra a ficha para ver compras, pagamentos e saldo em aberto.",
      "Registe pagamentos a fornecedores quando liquidar uma divida."
    ],
    care: [
      "O nome do fornecedor deve ser escrito sempre igual.",
      "Compras a credito aumentam o valor a pagar ao fornecedor."
    ],
    tip: "Consulte fornecedores a pagar no dashboard antes de fazer novos pagamentos."
  },
  tresorerie: {
    title: "Tesouraria",
    subtitle: "Modulo para acompanhar entradas, saidas, saldo e movimentos de caixa.",
    main: [
      "Entradas podem vir de vendas, pagamentos de clientes e movimentos manuais.",
      "Saidas podem vir de despesas, fornecedores e movimentos manuais.",
      "Use filtros para analisar o periodo certo."
    ],
    care: [
      "Movimentos manuais devem ter descricao clara.",
      "Pagamentos registados nos outros modulos tambem afectam a tesouraria."
    ],
    tip: "Compare o saldo da tesouraria com o dinheiro real no fim do dia."
  },
  comptabilite: {
    title: "Contabilidade",
    subtitle: "Modulo para demonstracao de resultados, balanco simplificado e diario contabilistico.",
    main: [
      "A demonstracao mostra vendas, custo, lucro bruto, despesas e resultado.",
      "O balanco separa tesouraria, stock, clientes, revendedores e fornecedores.",
      "O diario mostra os lancamentos contabilisticos do periodo."
    ],
    care: [
      "Use datas correctas para obter um resumo fiscal confiavel.",
      "Correcoes criam movimentos de anulacao em vez de apagar historico."
    ],
    tip: "Antes de fechar o mes, confira vendas, despesas, compras e dividas."
  },
  corrections: {
    title: "Correcoes",
    subtitle: "Modulo para corrigir vendas, compras, despesas e pagamentos sem destruir o historico.",
    main: [
      "Pesquise o movimento errado pelo numero, cliente, fornecedor ou descricao.",
      "A correcao cria uma anulacao controlada.",
      "Use motivo claro para manter auditoria compreensivel."
    ],
    care: [
      "Nao use correcoes para operacoes ainda nao confirmadas.",
      "Algumas correcoes podem afectar stock, dividas, caixa e contabilidade."
    ],
    tip: "Corrigir e melhor do que apagar, porque protege o historico da loja."
  },
  revendeurs: {
    title: "Revendedores",
    subtitle: "Modulo para consignacao, pagamento, retorno e historico por revendedor.",
    main: [
      "Crie uma consignacao quando entregar produtos a um revendedor.",
      "Pagamento baixa a divida aberta da consignacao.",
      "Retorno devolve mercadoria ao stock quando nao houve pagamento."
    ],
    care: [
      "Consignacoes com status open aparecem como revendedores a receber.",
      "Se ja houve pagamento, faca correcao antes de devolver."
    ],
    tip: "Use nomes de revendedores consistentes para manter a ficha limpa."
  },
  logistica: {
    title: "Logistica",
    subtitle: "Modulo para planear entregas, acompanhar prazos e ligar encomendas online a entregas reais.",
    main: [
      "Crie uma entrega manual para clientes directos, grossistas ou entregas independentes.",
      "Use o painel para ver entregas abertas, de hoje, em rota e atrasadas.",
      "Nas encomendas online, use Logistica para transformar o pedido numa entrega acompanhada."
    ],
    care: [
      "Entregas com data prevista geram alertas antes do prazo.",
      "Ao marcar uma entrega online como entregue, a encomenda tambem fica entregue."
    ],
    tip: "Use o estado Em rota para saber exactamente o que saiu para entrega."
  },
  settings: {
    title: "Definicoes",
    subtitle: "Modulo para configurar identidade da loja, recibo, utilizadores, roles, stock e seguranca.",
    main: [
      "Proprietario gere equipa, roles e estado dos utilizadores.",
      "Configure logo, recibo, moeda e modo de stock.",
      "Use importacao para entrar compras, vendas e despesas antigas."
    ],
    care: [
      "Mudancas em stock e roles afectam o funcionamento de varios modulos.",
      "Apenas proprietario ou permissao adequada deve alterar configuracoes criticas."
    ],
    tip: "Configure primeiro identidade, moeda e modo de stock antes de iniciar testes reais."
  },
  import: {
    title: "Importacao",
    subtitle: "Modulo para importar compras, vendas e despesas via CSV modelo.",
    main: [
      "Baixe sempre o modelo CSV antes de preencher dados.",
      "Verifique a pre-visualizacao antes de importar.",
      "Grandes importacoes devem ser feitas por tipo: compras, depois vendas, depois despesas."
    ],
    care: [
      "Evite alterar os nomes das colunas do modelo.",
      "Duplicados podem ser rejeitados conforme as regras do importador."
    ],
    tip: "Teste primeiro com poucas linhas antes de importar ficheiros grandes."
  }
};

function getActiveAzulPageKey() {
  var active = document.querySelector(".page.active");
  if (!active || !active.id) return "dashboard";
  return active.id.replace(/^page-/, "");
}

function getContextHelpData(pageKey) {
  return AZUL_CONTEXT_HELP[pageKey] || AZUL_CONTEXT_HELP.dashboard;
}

function renderContextHelp(pageKey) {
  var data = getContextHelpData(pageKey);
  var title = document.getElementById("contextHelpTitle");
  var subtitle = document.getElementById("contextHelpSubtitle");
  var eyebrow = document.getElementById("contextHelpEyebrow");
  var body = document.getElementById("contextHelpBody");

  if (!title || !subtitle || !eyebrow || !body) return;

  eyebrow.textContent = "Ajuda contextual";
  title.textContent = data.title || "Ajuda Azul";
  subtitle.textContent = data.subtitle || "";

  var section = function(label, rows) {
    rows = rows || [];
    if (!rows.length) return "";

    return '<div class="context-help-section">' +
      '<h3>' + escapeDespesaHtml(label) + '</h3>' +
      '<ul class="context-help-list">' +
        rows.map(function(row) {
          return '<li>' + escapeDespesaHtml(row) + '</li>';
        }).join("") +
      '</ul>' +
    '</div>';
  };

  body.innerHTML =
    section("Como usar", data.main) +
    section("Atencao", data.care) +
    '<div class="context-help-tip"><strong>Dica rapida</strong>' + escapeDespesaHtml(data.tip || "") + '</div>';
}

function syncContextHelpButton() {
  var btn = document.getElementById("contextHelpBtn");
  if (!btn) return;

  var data = getContextHelpData(getActiveAzulPageKey());
  btn.setAttribute("aria-label", "Abrir ajuda: " + (data.title || "Azul"));
  btn.title = "Ajuda: " + (data.title || "Azul");
}

function openContextHelp(pageKey) {
  var key = pageKey || getActiveAzulPageKey();
  renderContextHelp(key);

  var panel = document.getElementById("contextHelpPanel");
  var backdrop = document.getElementById("contextHelpBackdrop");

  if (panel) {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
  }

  if (backdrop) backdrop.classList.add("open");
}

function closeContextHelp() {
  var panel = document.getElementById("contextHelpPanel");
  var backdrop = document.getElementById("contextHelpBackdrop");

  if (panel) {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  if (backdrop) backdrop.classList.remove("open");
}

var azulOnboardingIndex = 0;
var AZUL_ONBOARDING_SEEN_KEY = "azul_onboarding_seen_v2";
var AZUL_ONBOARDING_STEPS = [
  {
    title: "Bem-vindo ao Azul",
    icon: "dashboard",
    page: "dashboard",
    target: "#page-dashboard",
    intro: "Este e o painel principal do ERP. Aqui vais acompanhar vendas, stock, despesas, caixa e alertas importantes da tua loja.",
    bullets: [
      "O dashboard mostra a saude do negocio.",
      "Ele resume caixa, stock, vendas, dividas e alertas.",
      "Clica em Seguinte para ir para Definicoes."
    ]
  },
  {
    title: "Configurar a loja e o recibo",
    icon: "settings",
    page: "settings",
    target: "#cfg-name",
    intro: "Nas Definicoes defines identidade, recibo, moeda, tema, modo de stock, seguranca e preferencias principais.",
    bullets: [
      "Identidade no recibo: nome, slogan, contacto e dados que aparecem no recibo.",
      "Moeda e tema: adapta o ERP ao estilo da loja.",
      "Modo de stock: escolhe se a compra entra na loja ou no armazem.",
      "Seguranca: podes bloquear o ERP com palavra-passe local.",
      "Guarda as configuracoes antes de comecar a operar."
    ]
  },
  {
    title: "Gerir utilizadores e roles",
    icon: "rh",
    page: "settings",
    target: "#settings-user-card",
    intro: "A equipa define quem pode entrar no ERP e o que cada pessoa pode fazer.",
    bullets: [
      "O primeiro utilizador da organizacao fica como proprietario.",
      "Novos utilizadores podem ficar em espera ate o proprietario aprovar.",
      "Roles controlam acesso a vendas, stock, financeiro, configuracoes e outros modulos.",
      "Cada acao importante fica ligada ao utilizador que a fez."
    ]
  },
  {
    title: "Importar dados antigos",
    icon: "import",
    page: "import",
    target: "#page-import",
    intro: "Se a loja ja tem historico, usa a Importacao para carregar compras, vendas e despesas por ficheiros CSV modelo.",
    bullets: [
      "Baixa sempre o modelo CSV antes de preencher.",
      "Importa primeiro compras, depois vendas, depois despesas.",
      "Confere o preview antes de confirmar.",
      "Se a loja for nova, podes saltar esta etapa."
    ]
  },
  {
    title: "Adicionar o primeiro produto",
    icon: "achat",
    page: "achat",
    target: "#achat-tab-novo",
    intro: "Para criar produto e stock, entra em Nova Compra. Preenche o fornecedor e a linha do produto, depois regista a compra.",
    bullets: [
      "Fornecedor: escreve quem vendeu a mercadoria.",
      "Produto: coloca nome, quantidade, preco de compra e preco de venda.",
      "Imagem e variacao: usa quando houver foto, tamanho, cor ou modelo.",
      "Registar Compra: guarda o produto e actualiza o stock."
    ]
  },
  {
    title: "Cadastrar codigo de barras",
    icon: "barcode",
    page: "achat",
    target: "#achat-tab-novo",
    intro: "Quando o produto tem codigo de barras, guarda o codigo na compra para vender mais rapido depois.",
    bullets: [
      "No campo Codigo, podes escrever ou usar o icone de scanner quando estiver disponivel.",
      "O codigo ajuda a encontrar o produto no POS.",
      "Produtos importados por CSV tambem podem trazer codigo.",
      "Usa codigo unico para evitar confusao entre variacoes."
    ]
  },
  {
    title: "Controlar o stock",
    icon: "transfert",
    page: "transfert",
    target: "#page-transfert",
    intro: "No Estoque acompanhas quantidades da loja, armazem, alertas e transferencias de produtos.",
    bullets: [
      "Pesquisa o produto pelo nome, codigo, fornecedor ou categoria.",
      "Confere stock da loja, armazem e total.",
      "Usa transferencias quando a mercadoria sai do armazem para a loja.",
      "Este modulo ajuda a evitar vender produto acabado."
    ]
  },
  {
    title: "Ver historico de transferencias",
    icon: "transfert",
    page: "transfert",
    target: "#page-transfert",
    intro: "As transferencias mostram o movimento entre armazem e loja para saber quem mexeu no stock.",
    bullets: [
      "Use quando a mercadoria sai do armazem para a loja.",
      "O historico ajuda a descobrir erros de quantidade.",
      "Pesquise por produto quando houver muitos movimentos.",
      "O stock da loja e o que baixa na venda interna."
    ]
  },
  {
    title: "Organizar fornecedores",
    icon: "forn",
    page: "forn",
    target: "#page-forn",
    intro: "Em Fornecedores ves ficha, compras, pagamentos e dividas de cada fornecedor.",
    bullets: [
      "A compra cria ou actualiza o fornecedor automaticamente.",
      "Completa contacto, pais e observacoes quando precisares.",
      "Regista pagamentos para reduzir dividas.",
      "Usa a ficha para ver historico e saldo."
    ]
  },
  {
    title: "Fazer a primeira venda",
    icon: "venda",
    page: "venda",
    target: "#searchInput",
    intro: "Na Nova Venda pesquisas produtos, adicionas ao carrinho, escolhes o tipo de venda e confirmas o pagamento.",
    bullets: [
      "Pesquisa: encontra o produto pelo nome, codigo, fornecedor ou categoria.",
      "Carrinho: ajusta quantidade e preco quando for necessario.",
      "Stock ou Externo: stock baixa a loja; externo nao baixa stock.",
      "Pagamento: confirma cash, express, cartao, credito ou multipagamento."
    ]
  },
  {
    title: "Vender servicos",
    icon: "venda",
    page: "venda",
    target: "#sale-catalog-services",
    intro: "Quando vendes servicos, como mao de obra, instalacao, consultoria ou atendimento, usa a aba Servicos na venda.",
    bullets: [
      "Servico entra no carrinho como item sem stock.",
      "Define nome, preco e descricao quando necessario.",
      "A venda do servico entra nos KPIs, tesouraria e contabilidade.",
      "Use produto para mercadoria fisica e servico para trabalho vendido."
    ]
  },
  {
    title: "Usar scanner no POS",
    icon: "barcode",
    page: "venda",
    target: "#barcodeInput",
    intro: "O scanner ajuda a adicionar produtos ao carrinho com rapidez.",
    bullets: [
      "No PC, podes usar leitor USB ou Bluetooth no campo de codigo de barras.",
      "No telemovel, podes usar a camera para ler o codigo.",
      "Tambem existe o modo telefone como scanner para enviar produtos para o carrinho do PC.",
      "Depois do scan, confere o carrinho antes de confirmar o pagamento."
    ]
  },
  {
    title: "Acompanhar clientes",
    icon: "clientes",
    page: "clientes",
    target: "#page-clientes",
    intro: "Em Clientes acompanhas compras, credito, pagamentos recebidos e historico de cada cliente.",
    bullets: [
      "Vendas a credito exigem nome do cliente.",
      "A ficha mostra total comprado, divida e transacoes.",
      "Regista pagamentos quando o cliente paga depois.",
      "Usa a pesquisa para encontrar clientes rapidamente."
    ]
  },
  {
    title: "Registar a primeira despesa",
    icon: "depenses",
    page: "depenses",
    target: "#dep-panel-new",
    intro: "Nas Despesas registas custos da loja como renda, transporte, salario, energia ou outras saidas de caixa.",
    bullets: [
      "Escolhe a data e o tipo de despesa.",
      "Escreve uma descricao simples para reconhecer o gasto depois.",
      "Coloca o montante pago.",
      "Ao registar, a despesa entra no dashboard, tesouraria e contabilidade."
    ]
  },
  {
    title: "Controlar a tesouraria",
    icon: "tresorerie",
    page: "tresorerie",
    target: "#page-tresorerie",
    intro: "A Tesouraria mostra entradas, saidas, saldo e movimentos de caixa da loja.",
    bullets: [
      "Entradas podem vir de vendas e pagamentos recebidos.",
      "Saidas podem vir de despesas, compras e pagamentos a fornecedores.",
      "Usa filtros por data para fechar o dia ou o mes.",
      "Confere este modulo antes de fechar o caixa."
    ]
  },
  {
    title: "Ler a contabilidade",
    icon: "comptabilite",
    page: "comptabilite",
    target: "#page-comptabilite",
    intro: "A Contabilidade resume resultado, balanco simples e diario contabilistico.",
    bullets: [
      "Vendas, custo, lucro, despesas e resultado aparecem juntos.",
      "O balanco mostra caixa, stock, clientes, fornecedores e revendedores.",
      "O diario ajuda a auditar cada movimento.",
      "Usa o filtro de datas para analisar periodos."
    ]
  },
  {
    title: "Gerir revendedores",
    icon: "revendeurs",
    page: "revendeurs",
    target: "#page-revendeurs",
    intro: "Em Revendedores registas consignacoes, pagamentos, devolucoes e historico por revendedor.",
    bullets: [
      "Cria consignacao quando entregas produto ao revendedor.",
      "Pagamento baixa o valor em aberto.",
      "Devolucao fecha produtos que voltaram.",
      "Consignacoes abertas entram nas dividas de revendedores."
    ]
  },
  {
    title: "Criar a loja online",
    icon: "online",
    page: "online",
    target: "#online-panel-config",
    intro: "Venda Online cria uma vitrine publica para clientes escolherem produtos e enviarem pedido pelo WhatsApp.",
    bullets: [
      "Configura nome publico, WhatsApp, mensagem inicial, cor, fonte e logo.",
      "Seleciona os produtos que devem aparecer na loja publica.",
      "Ativa e guarda a loja para gerar o link publico.",
      "Qualquer cliente pode abrir o link sem conta Azul."
    ]
  },
  {
    title: "Acompanhar encomendas online",
    icon: "online",
    page: "online",
    target: "#online-tab-orders",
    intro: "As encomendas recebidas pela loja online ficam no sub-onglet Encomendas.",
    bullets: [
      "Confirma, prepara, planeia ou cancela a encomenda.",
      "Define data prevista e aviso antes do prazo.",
      "Encomendas atrasadas geram alerta para a equipa responsavel.",
      "Podes enviar uma encomenda para Logistica quando houver entrega."
    ]
  },
  {
    title: "Planear entregas",
    icon: "logistica",
    page: "logistica",
    target: "#page-logistica",
    intro: "Logistica acompanha entregas manuais, grossistas e encomendas vindas da Venda Online.",
    bullets: [
      "Cria entrega manual quando o pedido nao vem da loja online.",
      "Usa o painel para ver entregas abertas, de hoje, atrasadas e em rota.",
      "Muda o estado para pronta, em rota, entregue, falhada ou cancelada.",
      "O sistema envia alertas antes do prazo definido."
    ]
  },
  {
    title: "Gerir recursos humanos",
    icon: "rh",
    page: "rh",
    target: "#page-rh",
    intro: "Recursos Humanos ajuda a acompanhar funcionarios, presencas, pagamentos e historico.",
    bullets: [
      "Regista funcionarios com dados principais.",
      "Controla presencas quando precisares.",
      "Regista pagamentos de salario ou adiantamentos.",
      "Consulta historico para saber quem recebeu e quando."
    ]
  },
  {
    title: "Receber notificacoes",
    icon: "help",
    page: "settings",
    target: "#notificationWrap",
    intro: "As notificacoes avisam proprietario e gerente quando usuarios fazem acoes importantes.",
    bullets: [
      "Vendas, compras, despesas, consignacoes e entregas podem gerar notificacao.",
      "PWA Push pode avisar mesmo fora da pagina quando estiver configurado.",
      "O sino no topo mostra notificacoes recentes.",
      "Use as notificacoes para acompanhar a equipa sem estar sempre perto do caixa."
    ]
  },
  {
    title: "Corrigir erros com seguranca",
    icon: "corrections",
    page: "corrections",
    target: "#page-corrections",
    intro: "Correcoes serve para anular venda, compra, despesa ou pagamento mantendo o historico limpo.",
    bullets: [
      "Usa quando alguem registou uma operacao errada.",
      "A correcao nao deve apagar historico importante.",
      "Cada correcao fica auditada com o utilizador.",
      "Este modulo e melhor que editar dados manualmente."
    ]
  }
];

function getAzulOnboardingStep(index) {
  return AZUL_ONBOARDING_STEPS[index] || AZUL_ONBOARDING_STEPS[0];
}

function getAzulOnboardingStorageKey() {
  var organizationId = localStorage.getItem("azul_organization_id") || "local";
  return AZUL_ONBOARDING_SEEN_KEY + "_" + organizationId;
}

function hasSeenAzulOnboarding() {
  try {
    return localStorage.getItem(getAzulOnboardingStorageKey()) === "1";
  } catch (e) {
    return false;
  }
}

function markAzulOnboardingSeen() {
  try {
    localStorage.setItem(getAzulOnboardingStorageKey(), "1");
  } catch (e) {}
}

function syncAzulOnboardingSpace() {
  var panel = document.getElementById("azulOnboardingPanel");
  var height = panel ? Math.ceil(panel.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty("--azul-onboarding-space", (height ? height + 28 : 0) + "px");
}

function renderAzulOnboarding() {
  var step = getAzulOnboardingStep(azulOnboardingIndex);
  var title = document.getElementById("azulOnboardingTitle");
  var icon = document.getElementById("azulOnboardingIcon");
  var stepText = document.getElementById("azulOnboardingStep");
  var intro = document.getElementById("azulOnboardingIntro");
  var list = document.getElementById("azulOnboardingList");
  var prev = document.getElementById("azulOnboardingPrev");
  var next = document.getElementById("azulOnboardingNext");

  if (!title || !icon || !intro || !list) return;

  title.textContent = step.title;
  icon.innerHTML = typeof azulIcon === "function" ? azulIcon(step.icon) : String(azulOnboardingIndex + 1);
  if (stepText) stepText.textContent = "Tutorial " + (azulOnboardingIndex + 1) + "/" + AZUL_ONBOARDING_STEPS.length;
  intro.textContent = step.intro;

  list.innerHTML = (step.bullets || []).map(function(item) {
    return "<li>" + escapeDespesaHtml(item) + "</li>";
  }).join("");

  if (prev) prev.disabled = azulOnboardingIndex === 0;
  if (next) next.textContent = azulOnboardingIndex === AZUL_ONBOARDING_STEPS.length - 1 ? "Terminar" : "Seguinte";
  setTimeout(syncAzulOnboardingSpace, 0);
}

function openAzulOnboarding(forceManual) {
  if (!forceManual && hasSeenAzulOnboarding()) return;
  markAzulOnboardingSeen();

  azulOnboardingIndex = 0;
  openAzulOnboardingPage();
  renderAzulOnboarding();

  var backdrop = document.getElementById("azulOnboardingBackdrop");
  if (backdrop) {
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
  }
  document.body.classList.add("azul-onboarding-open");
  syncAzulOnboardingSpace();
  setTimeout(syncAzulOnboardingSpace, 80);
}

function restartAzulOnboarding() {
  openAzulOnboarding(true);
}

function startAzulOnboardingOnce() {
  if (hasSeenAzulOnboarding()) return;
  setTimeout(function() {
    openAzulOnboarding(false);
  }, 650);
}

function closeAzulOnboarding() {
  var backdrop = document.getElementById("azulOnboardingBackdrop");
  if (backdrop) {
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
  }
  document.body.classList.remove("azul-onboarding-open");
  document.documentElement.style.setProperty("--azul-onboarding-space", "0px");
}

function goAzulOnboardingStep(index) {
  azulOnboardingIndex = Math.max(0, Math.min(AZUL_ONBOARDING_STEPS.length - 1, index));
  openAzulOnboardingPage();
  renderAzulOnboarding();
}

function nextAzulOnboardingStep() {
  if (azulOnboardingIndex >= AZUL_ONBOARDING_STEPS.length - 1) {
    closeAzulOnboarding();
    return;
  }

  goAzulOnboardingStep(azulOnboardingIndex + 1);
}

function prevAzulOnboardingStep() {
  goAzulOnboardingStep(azulOnboardingIndex - 1);
}

function findAzulNavButton(page) {
  return document.querySelector(".tab[onclick*=\"goTo('" + page + "'\"]") ||
    document.querySelector(".tab[onclick*='goTo(\"" + page + "\"']");
}

function openAzulOnboardingTarget() {
  var step = getAzulOnboardingStep(azulOnboardingIndex);
  openAzulOnboardingPage();
}

function openAzulOnboardingPage() {
  var step = getAzulOnboardingStep(azulOnboardingIndex);

  if (step.page && typeof goTo === "function") {
    goTo(step.page, findAzulNavButton(step.page));
  }

  setTimeout(function() {
    var target = step.target ? document.querySelector(step.target) : null;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (typeof target.focus === "function" && /input|select|textarea/i.test(target.tagName || "")) {
        target.focus({ preventScroll: true });
      }
    }
  }, 260);
}

function initContextHelp() {
  syncContextHelpButton();

  window.addEventListener("resize", function() {
    var backdrop = document.getElementById("azulOnboardingBackdrop");
    if (backdrop && backdrop.classList.contains("open")) {
      syncAzulOnboardingSpace();
    }
  });

  document.addEventListener("keydown", function(event) {
    if (event.key === "Escape") {
      closeContextHelp();
      closeAzulOnboarding();
    }
  });
}

window.openContextHelp = openContextHelp;
window.closeContextHelp = closeContextHelp;
window.openAzulOnboarding = openAzulOnboarding;
window.restartAzulOnboarding = restartAzulOnboarding;
window.closeAzulOnboarding = closeAzulOnboarding;
window.goAzulOnboardingStep = goAzulOnboardingStep;
window.nextAzulOnboardingStep = nextAzulOnboardingStep;
window.prevAzulOnboardingStep = prevAzulOnboardingStep;
window.openAzulOnboardingTarget = openAzulOnboardingTarget;

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
  "page:online": { label: "Venda Online", group: "Paginas" },
  "page:logistica": { label: "Logistica", group: "Paginas" },
  "page:rh": { label: "Recursos Humanos", group: "Paginas" },
  "page:settings": { label: "Definicoes", group: "Paginas" },
  "page:import": { label: "Importacao", group: "Paginas" },
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
  "logistics:create": { label: "Criar entregas", group: "Logistica" },
  "logistics:view": { label: "Ver logistica", group: "Logistica" },
  "logistics:update": { label: "Atualizar entregas", group: "Logistica" },
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
    permissions: ["page:dashboard", "page:venda", "page:clientes", "page:logistica", "sale:create", "sale:view", "client:view", "client_payment:create", "logistics:create", "logistics:view", "logistics:update"]
  },
  stock: {
    name: "Stock",
    permissions: ["page:dashboard", "page:achat", "page:transfert", "page:forn", "page:import", "page:logistica", "purchase:create", "purchase:view", "stock:transfer", "supplier:view", "supplier_payment:create", "import:create", "logistics:create", "logistics:view", "logistics:update"]
  },
  accountant: {
    name: "Contabilista",
    permissions: ["page:dashboard", "page:depenses", "page:tresorerie", "page:comptabilite", "page:corrections", "page:rh", "page:logistica", "expense:create", "expense:view", "client_payment:create", "supplier_payment:create", "correction:create", "cash:view", "accounting:view", "hr:create", "hr:view", "logistics:view"]
  },
  readonly: {
    name: "Leitura",
    permissions: ["page:dashboard", "page:transfert", "page:clientes", "page:tresorerie", "page:comptabilite", "page:rh", "page:logistica", "sale:view", "purchase:view", "expense:view", "cash:view", "accounting:view", "hr:view", "logistics:view"]
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
  if (page === "performance") {
    return azulRoleAllows("pages", "dashboard");
  }
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

  Array.prototype.forEach.call(document.querySelectorAll("button[onclick*=\"goTo(\"]"), function(button) {
    if (button.classList && button.classList.contains("tab")) return;
    var page = extractGoToPage(button.getAttribute("onclick"));
    if (!page) return;
    button.style.display = canAccessAzulPage(page) ? "" : "none";
  });

  var treasuryCards = document.querySelectorAll(".quick-treasury-card");
  Array.prototype.forEach.call(treasuryCards, function(card) {
    card.style.display = canAccessAzulPage("tresorerie") ? "" : "none";
  });
}

var AZUL_ICON_PATHS = {
  dashboard: '<path d="M3 13h7V3H3z"></path><path d="M14 21h7V11h-7z"></path><path d="M14 8h7V3h-7z"></path><path d="M3 21h7v-5H3z"></path>',
  venda: '<circle cx="9" cy="20" r="1"></circle><circle cx="18" cy="20" r="1"></circle><path d="M2 3h3l3 12h10l3-8H6"></path>',
  achat: '<path d="M6 2l1.5 4h9L18 2"></path><path d="M3 6h18l-2 15H5z"></path><path d="M9 11h6"></path>',
  transfert: '<path d="M7 7h11l-3-3"></path><path d="M17 17H6l3 3"></path><path d="M5 12h14"></path>',
  clientes: '<path d="M16 21v-2a4 4 0 0 0-8 0v2"></path><circle cx="12" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>',
  depenses: '<path d="M12 1v22"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"></path>',
  rh: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
  forn: '<path d="M3 21h18"></path><path d="M5 21V7l8-4v18"></path><path d="M19 21V11l-6-4"></path><path d="M9 9h1"></path><path d="M9 13h1"></path><path d="M9 17h1"></path>',
  tresorerie: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M16 12h4"></path><circle cx="8" cy="12" r="2"></circle>',
  comptabilite: '<path d="M4 19.5V4a2 2 0 0 1 2-2h12v20H6a2 2 0 0 1-2-2.5z"></path><path d="M8 7h6"></path><path d="M8 11h8"></path><path d="M8 15h5"></path>',
  corrections: '<path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path>',
  revendeurs: '<path d="M3 7h18"></path><path d="M5 7l1 14h12l1-14"></path><path d="M9 7V5a3 3 0 0 1 6 0v2"></path><path d="M9 13h6"></path>',
  online: '<path d="M3 12h18"></path><path d="M12 3a15 15 0 0 1 0 18"></path><path d="M12 3a15 15 0 0 0 0 18"></path><circle cx="12" cy="12" r="9"></circle><path d="M7 16l2-5 3 3 5-7"></path>',
  logistica: '<path d="M10 17H6V6h11v11h-3"></path><path d="M17 9h3l2 4v4h-2"></path><circle cx="7" cy="17" r="2"></circle><circle cx="18" cy="17" r="2"></circle><path d="M7 17h9"></path><path d="M13 10h-3"></path>',
  settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.36.21.64.49.86.83.22.34.56.54.96.54H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51.63z"></path>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>',
  search: '<circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.35-4.35"></path>',
  barcode: '<path d="M3 5v14"></path><path d="M7 5v14"></path><path d="M11 5v14"></path><path d="M15 5v14"></path><path d="M19 5v14"></path><path d="M21 5v14"></path><path d="M4 3H2v4"></path><path d="M20 3h2v4"></path><path d="M4 21H2v-4"></path><path d="M20 21h2v-4"></path>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"></path><path d="M3 12A9 9 0 0 1 18.5 5.8"></path><path d="M18 3v4h-4"></path><path d="M6 21v-4h4"></path>',
  print: '<path d="M6 9V2h12v7"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><path d="M6 14h12v8H6z"></path>',
  add: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  pay: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path>',
  view: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle>',
  clear: '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path>',
  help: '<circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"></path><path d="M12 17h.01"></path>'
};

var AZUL_PAGE_ICON_MAP = {
  dashboard: "dashboard",
  performance: "dashboard",
  venda: "venda",
  achat: "achat",
  transfert: "transfert",
  clientes: "clientes",
  depenses: "depenses",
  rh: "rh",
  forn: "forn",
  tresorerie: "tresorerie",
  comptabilite: "comptabilite",
  corrections: "corrections",
  revendeurs: "revendeurs",
  online: "online",
  logistica: "logistica",
  settings: "settings",
  import: "import"
};

function azulIcon(name) {
  var path = AZUL_ICON_PATHS[name] || AZUL_ICON_PATHS.help;
  return '<svg class="az-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + path + '</svg>';
}

function setAzulButtonIcon(button, iconName) {
  if (!button || !iconName) return;
  if (button.dataset && button.dataset.noIcon === "1") return;

  var labelEl = button.querySelector(".az-label");
  var label = labelEl ? labelEl.textContent : button.textContent;
  label = String(label || "").trim();
  if (!label && button.getAttribute("aria-label")) label = button.getAttribute("aria-label");
  if (!label) return;

  button.classList.add("az-icon-button");
  button.innerHTML = azulIcon(iconName) + '<span class="az-label">' + escapeDespesaHtml(label) + '</span>';
}

function getAzulIconForButton(button) {
  var onclick = button.getAttribute("onclick") || "";
  var text = normalizeAzulIconText(button.textContent);
  var id = String(button.id || "").toLowerCase();
  var page = extractGoToPage(onclick);

  if (page && AZUL_PAGE_ICON_MAP[page]) return AZUL_PAGE_ICON_MAP[page];
  if (id.indexOf("notification") >= 0) return "help";
  if (id.indexOf("search") >= 0 || text.indexOf("pesquisar") >= 0 || text.indexOf("procurar") >= 0) return "search";
  if (text.indexOf("guardar") >= 0 || text.indexOf("salvar") >= 0) return "save";
  if (text.indexOf("atualizar") >= 0 || text.indexOf("actualizar") >= 0 || text.indexOf("aplicar") >= 0) return "refresh";
  if (text.indexOf("imprimir") >= 0) return "print";
  if (text.indexOf("adicionar") >= 0 || text.indexOf("criar") >= 0 || text.indexOf("novo") >= 0 || text.indexOf("nova") >= 0) return "add";
  if (text.indexOf("pagamento") >= 0 || text.indexOf("pagar") >= 0 || text.indexOf("receber") >= 0) return "pay";
  if (text.indexOf("ver tudo") >= 0 || text.indexOf("ver stock") >= 0 || text.indexOf("historico") >= 0 || text.indexOf("ficha") >= 0) return "view";
  if (text.indexOf("limpar") >= 0 || text.indexOf("eliminar") >= 0 || text.indexOf("remover") >= 0) return "clear";
  if (text.indexOf("import") >= 0 || text.indexOf("baixar") >= 0 || text.indexOf("modelo") >= 0 || text.indexOf("ficheiro") >= 0) return "import";
  if (text.indexOf("transfer") >= 0) return "transfert";

  return "";
}

function normalizeAzulIconText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function applyAzulIcons() {
  Array.prototype.forEach.call(document.querySelectorAll(".nav .tab[onclick]"), function(button) {
    var page = extractGoToPage(button.getAttribute("onclick"));
    setAzulButtonIcon(button, AZUL_PAGE_ICON_MAP[page] || "");
  });

  Array.prototype.forEach.call(document.querySelectorAll(
    ".mode-btn, .filter-btn, .form-submit, .dashboard-see-all, .import-primary-btn, .import-submit-btn, .import-file-btn"
  ), function(button) {
    setAzulButtonIcon(button, getAzulIconForButton(button));
  });

  var helpBtn = document.getElementById("contextHelpBtn");
  if (helpBtn) {
    helpBtn.innerHTML = '<span>' + azulIcon("help") + '</span><strong>Ajuda</strong>';
  }
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
  console.warn("Modo offline: verificacao da licenca ignorada temporariamente.", reason || "");

  if (typeof toast === "function") {
    toast("Modo offline: o ERP continua aberto. A licenca sera verificada quando a internet voltar.", "success");
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

      alert("Erro ao verificar aparelho: " + result.error.message);
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

    alert("Erro ao verificar aparelho: " + (e.message || e));
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

  return "Licenca invalida.";
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
      alert("Licenca invalida.");
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
    .select("id,name,category,supplier,purchase_price,sale_price,stock_warehouse,stock_shop,min_stock,created_at,code,variation,variations,photo")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (result.error) {
    throw result.error;
  }

  return (result.data || []).map(mapSupabaseProduct);
}

function isServicesTableMissing(error) {
  var msg = String(error && error.message ? error.message : error || "").toLowerCase();
  return msg.indexOf("services") >= 0 &&
    (msg.indexOf("could not find") >= 0 ||
      msg.indexOf("schema cache") >= 0 ||
      msg.indexOf("does not exist") >= 0 ||
      msg.indexOf("relation") >= 0);
}

function mapSupabaseService(row) {
  row = row || {};
  return {
    id: row.id || "",
    name: String(row.name || "").trim(),
    category: String(row.category || ""),
    price: Number(row.sale_price) || 0,
    salePrice: Number(row.sale_price) || 0,
    purchasePrice: Number(row.cost_price) || 0,
    costPrice: Number(row.cost_price) || 0,
    active: row.active !== false,
    isService: true,
    _searchText: [
      row.name || "",
      row.category || "",
      "servico",
      "servicos",
      "service"
    ].join(" ").toLowerCase()
  };
}

async function getServicesFromSupabase() {
  var organizationId = getAzulOrganizationId();
  if (!organizationId) return [];

  var result = await supabaseClient
    .from("services")
    .select("id,name,category,sale_price,cost_price,active,created_at")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (result.error) {
    if (isServicesTableMissing(result.error)) {
      console.warn("Tabela services ainda nao configurada.");
      return [];
    }
    throw result.error;
  }

  return (result.data || []).map(mapSupabaseService).filter(function(service) {
    return service && service.name;
  });
}

async function saveServiceToSupabase(data) {
  var organizationId = getAzulOrganizationId();
  if (!organizationId) throw new Error("Organizacao invalida.");

  var name = String(data && data.name || "").trim();
  var salePrice = Number(data && data.salePrice) || 0;

  if (!name) throw new Error("Informe o nome do servico.");
  if (salePrice <= 0) throw new Error("Informe o preco do servico.");

  var result = await insertSingleWithAzulAudit("services", {
    organization_id: organizationId,
    name: name,
    category: String(data.category || "").trim(),
    sale_price: salePrice,
    cost_price: Number(data.costPrice) || 0,
    active: true
  });

  if (result.error) throw result.error;
  return mapSupabaseService(result.data);
}

function isStockTransferHistoryMissing(error) {
  var msg = String(error && error.message ? error.message : error || "").toLowerCase();
  return msg.indexOf("stock_transfers") >= 0 &&
    (msg.indexOf("could not find") >= 0 ||
      msg.indexOf("schema cache") >= 0 ||
      msg.indexOf("does not exist") >= 0 ||
      msg.indexOf("relation") >= 0);
}

async function recordStockTransfers(rows) {
  rows = (rows || []).filter(function(row) {
    return row && row.organization_id && row.product_name && Number(row.quantity) > 0;
  });

  if (!rows.length) return false;

  try {
    var result = await insertRowsWithAzulAudit("stock_transfers", rows, "id");

    if (result.error) {
      if (isStockTransferHistoryMissing(result.error)) {
        console.warn("Tabela stock_transfers ainda nao configurada. Transferencia feita sem historico.");
        return false;
      }
      throw result.error;
    }

    return true;
  } catch (e) {
    if (isStockTransferHistoryMissing(e)) {
      console.warn("Tabela stock_transfers ainda nao configurada. Transferencia feita sem historico.");
      return false;
    }

    console.warn("Historico de transferencia nao gravado:", e);
    toast("Transferencia feita, mas o historico nao foi gravado.", "error");
    return false;
  }
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

  return {
    product_id: product.id,
    product_name: product.name,
    quantity: quantity,
    warehouse_before: warehouse,
    shop_before: shop,
    warehouse_after: warehouse - quantity,
    shop_after: shop + quantity
  };
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

  var movedRows = [];

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

    movedRows.push({
      product_id: row.id,
      product_name: row.name,
      quantity: warehouse,
      warehouse_before: warehouse,
      shop_before: shop,
      warehouse_after: 0,
      shop_after: shop + warehouse
    });
  }

  return movedRows;
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
    if (isServiceCartItem(item)) return;
    var key = getCartProductKey(item);
    if (!key) return;

    grouped[key] = (grouped[key] || 0) + (Number(item.qty) || 0);
  });

  return grouped;
}

function isServiceCartItem(item) {
  return !!(item && (item.isService || item.itemType === "service" || item.serviceId));
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

    if (!productRow && !isServiceCartItem(item)) {
      throw new Error("Produto nao encontrado: " + item.name);
    }

    var qtySold = Number(item.qty) || 0;
    var purchasePrice = isServiceCartItem(item)
      ? (Number(item.purchasePrice) || 0)
      : (Number(productRow.purchasePrice) || 0);
    var unitPrice = Number(item.price) || 0;

    saleItems.push({
      sale_id: sale.id,
      product_id: productRow ? productRow.id : null,
      product_name: item.name,
      quantity: qtySold,
      unit_price: unitPrice,
      total: unitPrice * qtySold,
      purchase_price: purchasePrice,
      profit: (unitPrice - purchasePrice) * qtySold,
      variation: isServiceCartItem(item) ? "Servico" : (item.selectedVariations || []).join(" | "),
      variations: isServiceCartItem(item) ? ["Servico"] : (item.selectedVariations || [])
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
  var creditAmount = getCreditoAmountFromPaymentLines(data.paymentLines || [], total);
  var physicalCost = saleItems.reduce(function(sum, item) {
    if (!item.product_id) return sum;
    return sum + (Number(item.purchase_price) || 0) * (Number(item.quantity) || 0);
  }, 0);
  var serviceCost = saleItems.reduce(function(sum, item) {
    if (item.product_id) return sum;
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

if (physicalCost > 0) {
  saleLines.push({ account: "61", debit: physicalCost, credit: 0 });

  if (isExternalSale) {
    // Venda externa: o fornecedor e pago directamente.
    saleLines.push({ account: "11", debit: 0, credit: physicalCost });
  } else {
    // Venda interna: a mercadoria sai do stock.
    saleLines.push({ account: "13", debit: 0, credit: physicalCost });
  }
}

if (serviceCost > 0) {
  saleLines.push({ account: "62", debit: serviceCost, credit: 0 });
  saleLines.push({ account: "11", debit: 0, credit: serviceCost });
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
  var payments = [];

  if (saleIds.length) {
    var itemsResult = await supabaseClient
      .from("sale_items")
      .select("*")
      .in("sale_id", saleIds);

    if (itemsResult.error) throw itemsResult.error;

    items = itemsResult.data || [];
  }

  var paymentsResult = await supabaseClient
    .from("client_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("client_name", clientName)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (paymentsResult.error) throw paymentsResult.error;
  payments = paymentsResult.data || [];

  var totalCompra = sales.reduce(function(sum, sale) {
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
      created_at: sale.created_at || "",
      prod: item.product_name || "",
      qty: Number(item.quantity) || 0,
      cash: 0,
      cartao: 0,
      express: 0,
      credito: 0,
      total: Number(item.total) || 0
    };
  }).sort(function(a, b) {
    return String(b.date || "").localeCompare(String(a.date || "")) ||
      String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });

  return {
    name: clientName,
    totalCompra: totalCompra,
    totalDette: totalDette,
    transactions: sales.length + payments.length,
    historique: historique,
    payments: payments
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

  var saleIds = sales.map(function(sale) {
    return sale.id;
  });

  var saleItems = saleIds.length ? await fetchSaleItemsBySaleIds(saleIds) : [];

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
      user_name: sale.user_name || "",
      created_at: sale.created_at || ""
    };
  });

  var resellerProjection = await getResellerSalesProjectionFromSupabase(params);
  var resellerRows = (resellerProjection.historyRows || []).map(function(row) {
    return {
      date: row.date || "",
      prod: row.prod || "",
      client: "Revendedor: " + (row.client || ""),
      qty: row.qty || 0,
      punit: row.punit || 0,
      total: row.total || 0,
      pay: row.pay || "Consignacao",
      recibo: row.recibo || "-",
      user_name: row.user_name || ""
    };
  });

  rows = rows.concat(resellerRows);

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

  rows.sort(function(a, b) {
    var ak = String(a.date || "") + " " + String(a.created_at || "");
    var bk = String(b.date || "") + " " + String(b.created_at || "");
    return bk.localeCompare(ak);
  });

  return rows;
}

function getResellerSalesDate(row) {
  return String(row && (row.closed_at || row.consignment_date || row.created_at) || "").slice(0, 10);
}

function parsePaymentSummaryToLines(summary, fallbackTotal) {
  summary = String(summary || "").trim();
  var lines = [];

  if (summary) {
    summary.split("+").forEach(function(part) {
      var pieces = part.split(":");
      var method = String(pieces[0] || "Cash").trim() || "Cash";
      var rawAmount = pieces.slice(1).join(":");
      var amount = parsePaymentAmount(rawAmount || "0");

      if (amount > 0) {
        lines.push({
          method: method,
          montant: amount
        });
      }
    });
  }

  if (!lines.length && Number(fallbackTotal) > 0) {
    lines.push({
      method: "Cash",
      montant: Number(fallbackTotal) || 0
    });
  }

  return lines;
}

async function getResellerSalesProjectionFromSupabase(params) {
  var organizationId = getAzulOrganizationId();

  params = params || {};
  var from = params.from || "";
  var to = params.to || "";

  var result = await supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("paid_amount", 0)
    .neq("status", "returned");

  if (result.error) {
    console.warn("Historico revendedores indisponivel:", result.error);
    return {
      sales: [],
      items: [],
      historyRows: []
    };
  }

  var consignments = (result.data || []).filter(function(row) {
    var date = getResellerSalesDate(row);
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });

  if (!consignments.length) {
    return {
      sales: [],
      items: [],
      historyRows: []
    };
  }

  var ids = consignments.map(function(row) {
    return row.id;
  });

  var itemsById = await getRevItemsForConsignments(ids);
  var flatItems = [];

  Object.keys(itemsById).forEach(function(id) {
    flatItems = flatItems.concat(itemsById[id] || []);
  });

  var costMap = await getRevProductCostMap(flatItems);
  var sales = [];
  var items = [];
  var historyRows = [];

  consignments.forEach(function(row) {
    var paid = Number(row.paid_amount) || 0;
    var total = Number(row.total) || 0;
    var ratio = total > 0 ? Math.min(1, paid / total) : 1;
    var date = getResellerSalesDate(row);
    var paymentLines = parsePaymentSummaryToLines(row.payment_summary, paid);
    var consignmentItems = itemsById[row.id] || [];
    var pseudoSaleId = "reseller:" + row.id;

    sales.push({
      id: pseudoSaleId,
      client_name: row.reseller_name || "Revendedor",
      sale_date: date,
      sale_type: "Revendedor",
      total: paid,
      profit: 0,
      payment_summary: row.payment_summary || "Consignacao",
      payment_lines: paymentLines,
      receipt_no: row.receipt_no || row.consignment_no || "-",
      user_name: row.user_name || "",
      created_at: row.closed_at || row.created_at || ""
    });

    consignmentItems.forEach(function(item) {
      var qty = Number(item.quantity) || 0;
      var unitPrice = Number(item.unit_price) || 0;
      var projectedQty = qty * ratio;
      var projectedTotal = (Number(item.total) || (qty * unitPrice)) * ratio;
      var purchasePrice = Number(costMap[item.product_id]) || 0;
      var projectedProfit = projectedTotal - (purchasePrice * projectedQty);

      items.push({
        sale_id: pseudoSaleId,
        product_id: item.product_id || "",
        product_name: item.product_name || "",
        quantity: projectedQty,
        unit_price: unitPrice,
        total: projectedTotal,
        purchase_price: purchasePrice,
        profit: projectedProfit,
        variation: item.variation || "",
        variations: item.variations || []
      });

      historyRows.push({
        date: date,
        prod: item.product_name || "",
        client: row.reseller_name || "Revendedor",
        qty: qty,
        punit: unitPrice,
        total: projectedTotal,
        pay: row.payment_summary || "Consignacao",
        recibo: row.receipt_no || row.consignment_no || "-",
        user_name: row.user_name || "",
        created_at: row.closed_at || row.created_at || ""
      });
    });
  });

  return {
    sales: sales,
    items: items,
    historyRows: historyRows
  };
}

function normalizePaymentMethod(method) {
  method = String(method || "").toLowerCase();

  if (method.indexOf("cash") >= 0) return "Cash";
  if (method.indexOf("express") >= 0) return "Express";
  if (method.indexOf("cart") >= 0 || method.indexOf("tpa") >= 0) return "Cartao";
  if (method.indexOf("credit") >= 0 || method.indexOf("credito") >= 0) return "Credito";

  return "Cash";
}
function getCreditoAmountFromPaymentLines(lines, total) {
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
  var creditAmount = getCreditoAmountFromPaymentLines(data.paymentLines || [], total);

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

  var resellerProjection = await getResellerSalesProjectionFromSupabase(filters);
  sales = sales.concat(resellerProjection.sales || []);
  items = items.concat(resellerProjection.items || []);

  var productsResult = await supabaseClient
    .from("products")
    .select("*")
    .eq("organization_id", organizationId);

  if (productsResult.error) throw productsResult.error;

  var productRows = productsResult.data || [];
  var dashboardProductRows = filterDashboardProducts(productRows, prodFilter, fornFilter);
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

  var stockAlertas = dashboardProductRows
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

var totalDespesas = expenseRows.reduce(function(sum, row) {
  return sum + (Number(row.amount) || 0);
}, 0);

var latestDespesas = expenseRows.slice(0, 5).map(function(row) {
  return {
    date: row.expense_date || "",
    desc: row.description || row.category || "",
    valor: Number(row.amount) || 0
  };
});
  var quickTreasury = await getDashboardQuickTreasuryFromSupabase(filters);
  var debts = await getDashboardDebtsFromSupabase(filters);
  var purchases = await getDashboardPurchasesFromSupabase(filters);
  var smartStock = getDashboardSmartStock(dashboardProductRows, items);
  var salesPerformance = getDashboardSalesPerformance(sales, items);
  var accountingSummary = getDashboardAccountingSummary(
    sales,
    items,
    expenseRows,
    dashboardProductRows,
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

  totalDespesas: totalDespesas,
  depensesCount: expenseRows.length,
  depenses: latestDespesas,
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

function getStockMode() {
  var mode = (config && config.stockMode) || (config && config.armazem ? "armazem" : "loja");
  return mode === "armazem" ? "armazem" : "loja";
}

function isWarehouseStockMode() {
  return getStockMode() === "armazem";
}

function getPurchaseStockUpdate(currentWarehouse, currentShop, quantity) {
  currentWarehouse = Number(currentWarehouse) || 0;
  currentShop = Number(currentShop) || 0;
  quantity = Number(quantity) || 0;

  if (isWarehouseStockMode()) {
    return {
      stock_warehouse: currentWarehouse + quantity,
      stock_shop: currentShop
    };
  }

  return {
    stock_warehouse: currentWarehouse,
    stock_shop: currentShop + quantity
  };
}

function normalizePurchaseProductIdentity(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getPurchaseVariationIdentity(value) {
  return parseVariationList(value)
    .map(normalizePurchaseProductIdentity)
    .filter(Boolean)
    .sort()
    .join("|");
}

function isSamePurchaseProduct(existingProduct, productName, category, variations) {
  if (
    normalizePurchaseProductIdentity(existingProduct && existingProduct.name) !==
    normalizePurchaseProductIdentity(productName)
  ) {
    return false;
  }

  var existingVariation = getPurchaseVariationIdentity(
    existingProduct && (existingProduct.variations || existingProduct.variation)
  );
  var incomingVariation = getPurchaseVariationIdentity(variations);

  if (existingVariation !== incomingVariation) {
    return false;
  }

  var existingCategory = normalizePurchaseProductIdentity(existingProduct && existingProduct.category);
  var incomingCategory = normalizePurchaseProductIdentity(category);

  return !existingCategory || !incomingCategory || existingCategory === incomingCategory;
}

async function upsertProductFromPurchase(item, supplier) {
  var organizationId = getAzulOrganizationId();

  var selectedProductId = String(item.productId || item.product_id || "").trim();
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
  var existingResult;

  if (selectedProductId) {
    existingResult = await existingQuery
      .eq("id", selectedProductId)
      .limit(1);
  } else if (code) {
    existingResult = await existingQuery
      .eq("code", code)
      .order("created_at", { ascending: true })
      .limit(1);
  } else {
    existingResult = await existingQuery
      .ilike("name", productName)
      .order("created_at", { ascending: true })
      .limit(50);
  }

  if (existingResult.error) {
    throw existingResult.error;
  }

  var existingProducts = existingResult.data || [];
  var existingProduct = selectedProductId || code
    ? (existingProducts[0] || null)
    : (existingProducts.find(function(product) {
        return isSamePurchaseProduct(product, productName, category, variations);
      }) || null);

  if (existingProduct) {
    var currentWarehouse = Number(existingProduct.stock_warehouse) || 0;
    var currentShop = Number(existingProduct.stock_shop) || 0;
    var stockUpdate = getPurchaseStockUpdate(currentWarehouse, currentShop, quantity);

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
        stock_warehouse: stockUpdate.stock_warehouse,
        stock_shop: stockUpdate.stock_shop
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
      stock_warehouse: isWarehouseStockMode() ? quantity : 0,
      stock_shop: isWarehouseStockMode() ? 0 : quantity,
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
  var isCredito = !!data.credit;
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
  
  var paidAmount = isCredito
  ? Math.min(total, Number(data.paidAmount || totalPaidFromLines || 0) || 0)
  : total;

  var remainingAmount = isCredito
    ? Math.max(0, total - paidAmount)
    : 0;

  var purchaseItems = [];

  for (var i = 0; i < items.length; i++) {
    var purchaseItem = items[i];
    var savedProduct = await upsertProductFromPurchase(purchaseItem, supplier);
    var itemVariations = parseVariationList(purchaseItem.variations || purchaseItem.variation || "");
    var itemVariation = itemVariations.join(" | ");

    purchaseItems.push({
      product_id: savedProduct.id,
      product_name: savedProduct.name,
      category: String(purchaseItem.category || savedProduct.category || ""),
      code: String(purchaseItem.code || savedProduct.code || ""),
      photo: String(purchaseItem.photo || savedProduct.photo || ""),
      variation: itemVariation || savedProduct.variation || "",
      variations: itemVariations.length ? itemVariations : savedProduct.variations || [],
      purchase_price: Number(purchaseItem.pa || purchaseItem.purchasePrice || purchaseItem.purchase_price) || 0,
      sale_price: Number(purchaseItem.pv || purchaseItem.salePrice || purchaseItem.sale_price || purchaseItem.targetMargin) || 0,
      quantity: Number(purchaseItem.qty || purchaseItem.quantity) || 0,
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

  await createAzulNotification({
    actionType: "purchase:create",
    title: getAzulCurrentUserName() + " registou uma compra",
    message: supplier + " - " + fmt(total),
    sourceType: "purchase",
    sourceId: purchase.id,
    details: {
      supplier: supplier,
      total: total,
      remaining_amount: remainingAmount
    }
  });

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
        toast('Nenhuma ligacao Google Sheet encontrada para o POS.', 'error');
      }
      if (done) done();
    })
    .withFailureHandler(function(e) {
      spreadsheetBindingReady = true;
      toast('Erro ao ler ligacao Google Sheet: ' + (e && e.message ? e.message : e), 'error');
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
  setupBarcodeKeyboardScanner();

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
  if (document.getElementById('transfer-history-from')) document.getElementById('transfer-history-from').value = first;
  if (document.getElementById('transfer-history-to')) document.getElementById('transfer-history-to').value = today;

  loadSettings();
  await renderSettingsUserCard();
  renderSettingsTeamCard();
  applyAzulRolePermissions();
  startAzulNotifications();
  initContextHelp();
  applyAzulIcons();
  startAzulOnboardingOnce();
  initPaymentLines();
  initCompraLines();
  cleanupLegacyCartFooter();

  ensureSpreadsheetBinding(function() {
    safeRun('Dashboard', loadDashboard);
    safeRun('Produits', loadProducts);
    safeRun('Consignations', loadOpenConsignations);
    safeRun('Pagamentos revendedores', renderRevPayLines);
    safeRun('Historico revendedores', loadRevHistory);
    safeRun('Categorias despesas', renderDespesaCategorias);
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
    //btn.textContent = 'Pagamento';
  }
}

// ===== NAVIGATION =====
function openMobileMenu() {
  if (typeof closeMobileCart === "function") closeMobileCart();

  var achatSummary = document.getElementById("mobileCompraSummary");
  var achatAddBtn = document.getElementById("mobileCompraAddBtn");

  if (achatSummary) achatSummary.style.display = "none";
  if (achatAddBtn) achatAddBtn.style.display = "none";

  document.body.classList.add("mobile-nav-open");
}

function closeMobileMenu() {
  document.body.classList.remove("mobile-nav-open");

  if (typeof renderMobileCompraSummary === "function") {
    renderMobileCompraSummary();
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
    if (page === 'performance') initSalesAnalyticsPage();
    if (page === 'depenses') initDespesasPage();
    if (page === 'rh') initRhPage();
    if (page === 'historique') loadHist();
    if (page === 'forn') {
      loadProducts();
      renderSupplierDatalists();
      switchFornTab('fiche', document.getElementById('forn-tab-fiche'));
    }
    if (page === 'clientes') renderClientDatalist();
    if (page === 'tresorerie') loadTesouraria();
    if (page === 'comptabilite') loadContabilidade();
    if (page === 'corrections') loadCorrections();
    if (page === 'transfert') {
      applyStockModeUi();
      loadProducts(true);
    }
    if (page === 'revendeurs') {
      renderRevProducts(products);
      renderRevCart();
      renderRevPayLines();
      loadOpenConsignations();
      switchRevendeurTab('create', document.getElementById('rev-tab-create'));
    }
    if (page === 'online') {
      loadOnlineStoreSettings();
    }
    if (page === 'logistica') {
      initLogisticaPage();
    }
    if (page === 'achat') {
      switchCompraTab('novo', document.getElementById('achat-tab-novo'));
      if (typeof renderMobileCompraSummary === 'function') renderMobileCompraSummary();
    }
    if (page === "forn" || page === "achat") {
      renderSupplierDatalists();
    }
    syncContextHelpButton();
    applyAzulIcons();
  } catch (e) {
    toast('Erro no separador: ' + (e && e.message ? e.message : e), 'error');
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
          '<div class="mobile-card-kicker">Venda #' + escapeDespesaHtml(v.recibo || '-') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(v.prod || '') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(v.client || 'Anonimo') + '  -  Qtd ' + (v.qty || 0) + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(v.date || '') + '</div>' +
          '<div class="mobile-card-sub">' + renderActionAuthor(v) + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="mobile-card-amount">' + fmt(v.total || 0) + '</div>' +
          '<div class="mobile-card-pill">' + escapeDespesaHtml(v.pay || 'Pago') + '</div>' +
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
    list.innerHTML = '<div class="empty">Nenhum produto encontrado</div>';
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
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(product.mainSupplier || 'Stock') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(product.name || '') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(getProductVariationLabel(product)) + '</div>' +
          '<div class="mobile-card-sub">Preco compra: ' + fmt(purchasePrice) + '</div>' +
        '</div>' +
        '<div class="mobile-card-amount">' + fmt(valeur) + '</div>' +
      '</div>' +
      '<div class="mobile-stock-grid">' +
        '<div class="mobile-stock-box"><div class="mobile-stock-label">Loja</div><div class="mobile-stock-value">' + stockBoutique + '</div></div>' +
        '<div class="mobile-stock-box"><div class="mobile-stock-label">Magasin</div><div class="mobile-stock-value">' + stockage + '</div></div>' +
        '<div class="mobile-stock-box"><div class="mobile-stock-label">Total</div><div class="mobile-stock-value">' + total + '</div></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderMobileTransferHistory(rows) {
  var list = ensureMobileList("transferHistoryBody", "mobileTransferHistoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma transferencia encontrada</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    return '<div class="mobile-transfer-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.transfer_date || '') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(row.product_name || '') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.from_location || 'Armazem') + ' -> ' + escapeDespesaHtml(row.to_location || 'Loja') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.note || 'Sem nota') + '</div>' +
          '<div class="mobile-card-sub">' + renderActionAuthor(row) + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="mobile-card-amount">' + (Number(row.quantity) || 0) + ' un</div>' +
          '<div class="mobile-card-pill">Transferencia</div>' +
        '</div>' +
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
  if (label.indexOf('filtr') >= 0 || label.indexOf('aplicar') >= 0 || label.indexOf('appliquer') >= 0) return 'Aplicacao do filtro...';
  if (label.indexOf('pesquisar') >= 0 || label.indexOf('rechercher') >= 0 || label.indexOf('search') >= 0) return 'Pesquisa em curso...';
  if (label.indexOf('registar') >= 0 || label.indexOf('enregistrer') >= 0 || label.indexOf('guardar') >= 0 || label.indexOf('save') >= 0) return 'A registar...';
  if (label.indexOf('confirm') >= 0 || label.indexOf('paiement') >= 0 || label.indexOf('pagamento') >= 0) return 'Confirmacao em curso...';
  if (label.indexOf('actualizar') >= 0 || label.indexOf('recharger') >= 0 || label.indexOf('refresh') >= 0) return 'A atualizar...';
  if (fn === 'getDashboardData') return 'Aplicacao do filtro...';
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
  t.innerHTML = '<span class="toast-spinner"></span><span>' + escapeDespesaHtml(label || '') + '</span>';
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
    {name:'Chapeu Abah', price:4000, stock:37, stockBoutique:20},
    {name:'Cinto Brilhante', price:8500, stock:13, stockBoutique:5},
    {name:'Chapeu Chines', price:4000, stock:8, stockBoutique:3},
    {name:'Avento', price:9000, stock:1, stockBoutique:1},
    {name:'Bavaria Man Intense', price:9000, stock:4, stockBoutique:2},
    {name:'Chapeu Lacoste', price:4000, stock:4, stockBoutique:2},
    {name:'Brown Orchid', price:9000, stock:2, stockBoutique:1}
  ];
  if (fn === 'getDashboardData') return {
    vendasHoje:54000, vendasHojeCount:3,
    vendasMes:387000, vendasMesCount:24,
    lucroMes:98000, alertas:3,
    topProdutos:[
      {name:'Blazer Classico', qty:15, total:405000},
      {name:'Chapeu Abah', qty:37, total:148000},
      {name:'Cinto Brilhante', qty:13, total:110500}
    ],
    pagamentos:{Cash:210000, Express:120000, Cartao:57000},
    stockAlertas:[
      {name:'Avento', stock:1, level:'critical'},
      {name:'Brown Orchid', stock:2, level:'warning'}
    ]
  };
  if (fn === 'getStockArmazem') return [
    {name:'Blazer Classico', qty:7},
    {name:'Chapeu Abah', qty:17},
    {name:'Cinto Brilhante', qty:8}
  ];
  if (fn === 'transferirTudo') return true;
  if (fn === 'getVendas') return [
    {date:'28/03/2026', prod:'Blazer Classico', client:'Joao Silva', qty:1, punit:27000, total:27000, pay:'Cash: 27000', recibo:'DUK-2603-0001'},
    {date:'28/03/2026', prod:'Chapeu Abah', client:'Maria Santos', qty:2, punit:4000, total:8000, pay:'Cash: 3000 + Express: 5000', recibo:'DUK-2603-0002'}
  ];
  if (fn === 'getTesouraria') return {
    balance: 128000,
    totalIn: 210000,
    totalOut: 82000,
    count: 4,
    entries: [
      {date:'03/04/2026', type:'Venda', desc:'Venda DUK-2604-0001 - Blazer', income:27000, expense:0, balance:128000},
      {date:'03/04/2026', type:'Despesa', desc:'Transporte - Taxi', income:0, expense:5000, balance:101000},
      {date:'02/04/2026', type:'Compra', desc:'Compra fornecedor Abah - costume', income:0, expense:45000, balance:106000},
      {date:'01/04/2026', type:'Entrada Manual', desc:'Capital initial', income:151000, expense:0, balance:151000}
    ]
  };
  if (fn === 'getConsignationsOpen') return [
    {id:'CON-260403-001', date:'03/04/2026', revendeur:'Moussa', total:18000, qty:3, items:['Blazer x1','Jeans x2']},
    {id:'CON-260402-003', date:'02/04/2026', revendeur:'Aicha', total:9000, qty:2, items:['Chapeu x2']}
  ];
  if (fn === 'getRevendeurDetail') return {
    nom:'Moussa',
    totalPossession:18000,
    openCount:1,
    ouvertes:[{id:'CON-260403-001', date:'03/04/2026', status:'Aberto', total:18000, qty:3, items:[{prod:'Blazer',qty:1,total:10000},{prod:'Jeans',qty:2,total:8000}]}],
    historique:[
      {id:'CON-260403-001', date:'03/04/2026', status:'Aberto', total:18000, qty:3, items:[{prod:'Blazer',qty:1,total:10000},{prod:'Jeans',qty:2,total:8000}]},
      {id:'CON-260330-002', date:'30/03/2026', status:'Pagoe', total:12000, qty:2, recibo:'CONS-260330-002', payment:'Cash: 12000', items:[{prod:'Taoette',qty:2,total:12000}]}
    ]
  };
  if (fn === 'getHistoriqueConsignations') return [
    {id:'CON-260403-001', actionDate:'03/04/2026', revendeur:'Moussa', status:'Aberto', itemsSummary:'Blazer x1, Jeans x2', total:18000, payment:'', recibo:''},
    {id:'CON-260330-002', actionDate:'30/03/2026', revendeur:'Moussa', status:'Pago', itemsSummary:'Taoette x2', total:12000, payment:'Cash: 12000', recibo:'CONS-260330-002'},
    {id:'CON-260329-001', actionDate:'29/03/2026', revendeur:'Aicha', status:'Devolvido', itemsSummary:'Chapeu x2', total:9000, payment:'', recibo:''}
  ];
  if (fn === 'getDespesaDashboard') return {
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
  if (fn === 'getHistoriqueDespesas') return [
    { date: '17/04/2026', category: 'Transport', description: 'Taxi fornecedor', amount: 5000 },
    { date: '16/04/2026', category: 'Loyer', description: 'Part du local', amount: 12000 },
    { date: '15/04/2026', category: 'Electricite', description: 'Recharge compteur', amount: 6000 },
    { date: '14/04/2026', category: 'Autre', description: 'Eau', amount: 4000 }
  ];
  if (fn === 'confirmerPagamentoConsignations') return { success:true, recibo:'CONS-TEST-001' };
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

async function getDashboardQuickTreasuryFromSupabase(filters) {
  filters = filters || {};
  var now = new Date();
  var today = localDateKey(now);
  var monthStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  var from = filters.from || monthStart;
  var to = filters.to || today;

  var allTreasury = await getTreasuryFromSupabase({
    from: from,
    to: to,
    limit: 5
    });
  var entries = allTreasury.entries || [];

  var periodSummary = summarizeTreasuryEntries(entries, from, to);

  return {
    balance: Number(allTreasury.balance) || 0,
    todayIn: periodSummary.totalIn,
    todayOut: periodSummary.totalOut,
    monthIn: periodSummary.totalIn,
    monthOut: periodSummary.totalOut,
    monthNet: periodSummary.net,
    latest: entries.slice(0, 5)
  };
}

function setQuickTreasuryText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = fmt(value || 0);
}

async function getResellerOpenDebtsFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();
  filters = filters || {};
  var from = filters.from || "";
  var to = filters.to || "";

  var query = supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .order("consignment_date", { ascending: false })
    .order("created_at", { ascending: false });

  var result = await query;

  if (result.error) {
    console.warn("Dividas de revendedores indisponiveis:", result.error);
    return {
      total: 0,
      count: 0,
      byReseller: [],
      rows: []
    };
  }

  var rows = (result.data || []).filter(function(row) {
    var status = String(row.status || "open").trim().toLowerCase();
    var date = String(row.consignment_date || row.created_at || "").slice(0, 10);

    if (status !== "open") return false;
    if (from && date && date < from) return false;
    if (to && date && date > to) return false;
    return true;
  }).map(function(row) {
    return Object.assign({}, row, {
      total: Number(row.total) || 0,
      remaining_amount: Number(row.total) || 0
    });
  }).filter(function(row) {
    return (Number(row.total) || 0) > 0;
  });

  var resellerMap = {};

  rows.forEach(function(row) {
    var name = String(row.reseller_name || "Revendedor").trim();
    var key = name.toLowerCase();

    if (!resellerMap[key]) {
      resellerMap[key] = {
        name: "Revendedor: " + name,
        total: 0,
        count: 0,
        isReseller: false
      };
    }

    resellerMap[key].total += Number(row.total) || 0;
    resellerMap[key].count += 1;
  });

  var byReseller = Object.keys(resellerMap).map(function(key) {
    return resellerMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var totalDebt = rows.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  return {
    total: totalDebt,
    count: rows.length,
    byReseller: byReseller,
    rows: rows
  };
}

function getRevConsignmentItemDebtValue(item, salePriceMap) {
  item = item || {};
  salePriceMap = salePriceMap || {};

  var qty = Number(item.quantity) || 0;
  var total = Number(item.total) || 0;
  var unitPrice = Number(item.unit_price) || 0;
  var productPrice = Number(salePriceMap[item.product_id]) || 0;

  if (total > 0) return total;
  if (unitPrice > 0) return qty * unitPrice;
  if (productPrice > 0) return qty * productPrice;

  return 0;
}

async function getRevProductSalePriceMap(items) {
  var ids = (items || []).map(function(item) {
    return item.product_id;
  }).filter(Boolean);

  var unique = Array.from(new Set(ids));
  var map = {};

  if (!unique.length) return map;

  for (var i = 0; i < chunkImportArray(unique, 80).length; i++) {
    var chunk = chunkImportArray(unique, 80)[i];
    if (!chunk.length) continue;

    var result = await supabaseClient
      .from("products")
      .select("id,sale_price")
      .in("id", chunk);

    if (result.error) {
      console.warn("Precos de produtos revendedores indisponiveis:", result.error);
      continue;
    }

    (result.data || []).forEach(function(product) {
      map[product.id] = Number(product.sale_price) || 0;
    });
  }

  return map;
}

function getMainDashboardText(key) {
  var dict = {
      period: 'Periodo', from: 'De', to: 'Ate', product: 'Produto', supplier: 'Fornecedor',
      today: 'Hoje', week: 'Esta semana', month: 'Este mes', custom: 'Personalizado',
      all: 'Todos', apply: 'Aplicar', print: 'Imprimir', refresh: 'Atualizar', seeAll: 'Ver tudo',
      sales: 'Vendas', profit: 'Lucro', expenses: 'Despesas', stockAlerts: 'Alertas Stock',
      revenueCost: 'Receita - Custo', missingProducts: 'produtos em falta',
      treasury: 'Tesouraria', quickTreasury: 'Tesouraria rapida', availableBalance: 'Saldo do periodo',
      monthlyBalance: 'Entradas - saidas no filtro', todayIn: 'Entradas do periodo', todayOut: 'Saidas do periodo',
      monthIn: 'Receitas filtradas', monthOut: 'Custos filtrados', monthResult: 'Resultado do periodo',
      cash: 'Cash', express: 'Express', card: 'Cartao', registos: 'registos',
      loadingMovements: 'A carregar movimentos...', noMovement: 'Nenhum movimento encontrado',
      debts: 'Dividas', debtSituation: 'Situacao das dividas',
      debtIntro: 'Clientes a receber e fornecedores a pagar.', clients: 'Clientes',
      suppliers: 'Fornecedores', clientsReceivable: 'Clientes a receber', suppliersPayable: 'Fornecedores a pagar',
      netBalance: 'Saldo liquido', receivablePayable: 'A receber - a pagar',
      openFiles: 'Fichas abertas', dossierUnit: 'fichas', clientSupplier: 'clientes + fornecedores',
      debtorClients: 'Clientes devedores', noClientDebt: 'Nenhuma divida de cliente',
      noSupplierDebt: 'Nenhuma divida de fornecedor', debtUnit: 'divida(s)', purchaseUnit: 'compra(s)',
      purchases: 'Compras', purchaseOverview: 'Visao de compras',
      purchaseIntro: 'Acompanhamento de compras, fornecedores e creditos.',
      newPurchase: 'Nova compra', todayPurchases: 'Compras no periodo', monthPurchases: 'Pago no periodo',
      creditPurchases: 'Credito do periodo', supplierDebt: 'Divida do periodo',
      remainingToPay: 'Resta pagar', mainSupplier: 'Fornecedor principal', latestPurchases: 'Ultimas compras',
      noPurchase: 'Nenhuma compra encontrada', remaining: 'Resta',
      stock: 'Stock', smartStock: 'Stock inteligente',
      stockIntro: 'Valor, rupturas, alertas e produtos parados.', viewStock: 'Ver stock',
      totalStockValue: 'Valor total do stock', shopWarehouse: 'Loja + armazem',
      outProducts: 'Produtos esgotados', totalStockZero: 'stock total a 0',
      lowStock: 'Stock baixo', belowMinimum: 'abaixo do minimo',
      dormantProducts: 'Produtos parados', notSoldPeriod: 'sem vendas no periodo',
      priorityAlerts: 'Alertas prioritarios', stockOk: 'Stock OK',
      shop: 'Loja', warehouse: 'Armazem', stockValue: 'Valor stock',
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
      valuedStock: 'Stock valorizado', resellerReceivables: 'Revendedores a receber', treasuryAsset: 'Tesouraria', simplifiedAssets: 'Ativo simplificado',
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
    };
  return dict[key] || key;
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
  setMainDashboardText('#page-dashboard .sales-performance-head .filter-btn', 'newSale');
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
  setMainDashboardTexts('#page-dashboard .accounting-mini-row > span', ['valuedStock', 'clientsReceivable', 'resellerReceivables', 'suppliersPayable', 'treasuryAsset']);
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
        '<strong>' + escapeDespesaHtml(row.type || getMainDashboardText('treasury')) + '</strong>' +
        '<small>' + escapeDespesaHtml(row.date || "") + ' - ' + escapeDespesaHtml(row.desc || "") + '</small>' +
      '</div>' +
      '<span class="' + (isIn ? "green" : "red") + '">' +
        (isIn ? "+" : "-") + fmt(isIn ? income : expense) +
      '</span>' +
    '</div>';
  }).join("");
}

async function getDashboardDebtsFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();
  filters = filters || {};
  var from = filters.from || "";
  var to = filters.to || "";

  var clientQuery = supabaseClient
    .from("client_debts")
    .select("*")
    .eq("organization_id", organizationId)
    .gt("remaining_amount", 0)
    .order("created_at", { ascending: false });

  if (from) clientQuery = clientQuery.gte("created_at", from + "T00:00:00");
  if (to) clientQuery = clientQuery.lte("created_at", to + "T23:59:59");

  var clientResult = await clientQuery;

  if (clientResult.error) throw clientResult.error;

  var supplierQuery = supabaseClient
    .from("purchases")
    .select("id,supplier,total,paid_amount,remaining_amount,created_at")
    .eq("organization_id", organizationId)
    .gt("remaining_amount", 0)
    .order("created_at", { ascending: false });

  if (from) supplierQuery = supplierQuery.gte("created_at", from + "T00:00:00");
  if (to) supplierQuery = supplierQuery.lte("created_at", to + "T23:59:59");

  var supplierResult = await supplierQuery;

  if (supplierResult.error) throw supplierResult.error;

  var clientMap = {};
  var supplierMap = {};
  var resellerDebts = await getResellerOpenDebtsFromSupabase(filters);

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

  (resellerDebts.byReseller || []).forEach(function(row) {
    var name = row.name || "Revendedor";

    if (!clientMap[name]) {
      clientMap[name] = {
        name: name,
        total: 0,
        count: 0,
        isReseller: true
      };
    }

    clientMap[name].total += Number(row.total) || 0;
    clientMap[name].count += Number(row.count) || 0;
    clientMap[name].isReseller = true;
  });

  var clients = Object.keys(clientMap).map(function(key) {
    return clientMap[key];
  }).sort(function(a, b) {
    if (!!a.isReseller !== !!b.isReseller) return a.isReseller ? -1 : 1;
    return b.total - a.total;
  });

  var suppliers = Object.keys(supplierMap).map(function(key) {
    return supplierMap[key];
  }).sort(function(a, b) {
    return b.total - a.total;
  });

  var clientOnlyRows = clients.filter(function(row) {
    return !row.isReseller;
  });

  var clientTotal = clients.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  var supplierTotal = suppliers.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  return {
    clientTotal: clientTotal,
    clientDebtTotal: clientTotal - (Number(resellerDebts.total) || 0),
    resellerTotal: Number(resellerDebts.total) || 0,
    resellerCount: Number(resellerDebts.count) || 0,
    supplierTotal: supplierTotal,
    net: clientTotal - supplierTotal,
    clientCount: clientOnlyRows.length,
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
  var resellerCount = document.getElementById("debt-reseller-count");
  var supplierCount = document.getElementById("debt-supplier-count");
  var openCount = document.getElementById("debt-open-count");

  if (clientTotal) clientTotal.textContent = fmt(data.clientDebtTotal != null ? data.clientDebtTotal : data.clientTotal || 0);
  if (supplierTotal) supplierTotal.textContent = fmt(data.supplierTotal || 0);
  if (net) {
    net.textContent = fmt(data.net || 0);
    net.style.color = (Number(data.net) || 0) < 0 ? "var(--red)" : "var(--green)";
  }

  if (clientCount) clientCount.textContent = formatDashboardCount(data.clientCount || 0, 'clients');
  if (resellerCount) {
    resellerCount.textContent = "Revendedores: " + fmt(data.resellerTotal || 0) + " (" + (data.resellerCount || 0) + ")";
    resellerCount.style.color = (Number(data.resellerTotal) || 0) > 0 ? "var(--orange)" : "var(--muted)";
  }
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
            '<strong>' + escapeDespesaHtml(row.name) + '</strong>' +
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
            '<strong>' + escapeDespesaHtml(row.name) + '</strong>' +
            '<small>' + formatDashboardCount(row.count || 0, 'purchaseUnit') + '</small>' +
          '</div>' +
          '<span class="red">' + fmt(row.total || 0) + '</span>' +
        '</div>';
      }).join("");
    }
  }
}

async function getDashboardPurchasesFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();
  filters = filters || {};
  var now = new Date();
  var today = localDateKey(now);
  var monthStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  var from = filters.from || monthStart;
  var to = filters.to || today;

  var query = supabaseClient
    .from("purchases")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (from) query = query.gte("created_at", from + "T00:00:00");
  if (to) query = query.lte("created_at", to + "T23:59:59");

  var result = await query;

  if (result.error) throw result.error;

  var rows = result.data || [];

  var periodRows = rows.filter(function(row) {
    var date = String(row.created_at || "").slice(0, 10);
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });

  var creditRows = periodRows.filter(function(row) {
    return (Number(row.remaining_amount) || 0) > 0;
  });

  var periodTotal = periodRows.reduce(function(sum, row) {
    return sum + (Number(row.total) || 0);
  }, 0);

  var paidTotal = periodRows.reduce(function(sum, row) {
    return sum + (Number(row.paid_amount) || 0);
  }, 0);

  var creditTotal = creditRows.reduce(function(sum, row) {
    return sum + (Number(row.remaining_amount) || 0);
  }, 0);

  var supplierMap = {};

  periodRows.forEach(function(row) {
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

  var latest = periodRows.slice(0, 6).map(function(row) {
    return {
      date: String(row.created_at || "").slice(0, 10),
      supplier: row.supplier || "Fornecedor",
      total: Number(row.total) || 0,
      paid: Number(row.paid_amount) || 0,
      debt: Number(row.remaining_amount) || 0
    };
  });

  return {
    todayTotal: periodTotal,
    todayCount: periodRows.length,
    monthTotal: paidTotal,
    monthCount: periodRows.length,
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
        '<strong>' + escapeDespesaHtml(row.supplier || "Fornecedor") + '</strong>' +
        '<small>' + escapeDespesaHtml(row.date || "") + '</small>' +
      '</div>' +
      '<div class="purchase-row-money">' +
        '<strong>' + fmt(row.total || 0) + '</strong>' +
        '<small>' + getMainDashboardText('remaining') + ': ' + fmt(row.debt || 0) + '</small>' +
      '</div>' +
    '</div>';
  }).join("");
}

function filterDashboardProducts(productRows, prodFilter, fornFilter) {
  prodFilter = String(prodFilter || "").trim().toLowerCase();
  fornFilter = String(fornFilter || "").trim().toLowerCase();

  if (!prodFilter && !fornFilter) {
    return productRows || [];
  }

  return (productRows || []).filter(function(product) {
    var productText = [
      product.name,
      product.code,
      product.category,
      product.variation,
      product.supplier,
      product.mainSupplier
    ].join(" ").toLowerCase();

    var supplierText = String(product.supplier || product.mainSupplier || "").toLowerCase();

    if (prodFilter && productText.indexOf(prodFilter) < 0) return false;
    if (fornFilter && supplierText.indexOf(fornFilter) < 0) return false;

    return true;
  });
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
            '<strong>' + escapeDespesaHtml(row.name) + '</strong>' +
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
            '<strong>' + escapeDespesaHtml(row.name) + '</strong>' +
            '<small>' + getMainDashboardText('stockValue') + ': ' + fmt(row.value || 0) + '</small>' +
          '</div>' +
          '<span>' + row.stock + ' ' + getMainDashboardText('unit') + '</span>' +
        '</div>';
      }).join("");
    }
  }
}

function isDashboardServiceSaleItem(item) {
  if (!item) return false;
  if (item.isService || item.itemType === "service" || item.service_id) return true;
  if (!item.product_id) return true;

  var variation = String(item.variation || "").toLowerCase();
  if (variation === "servico" || variation === "serviço" || variation.indexOf("servico") >= 0 || variation.indexOf("serviço") >= 0) {
    return true;
  }

  if (Array.isArray(item.variations)) {
    return item.variations.some(function(value) {
      var text = String(value || "").toLowerCase();
      return text === "servico" || text === "serviço";
    });
  }

  return false;
}

function getDashboardSalesPerformance(sales, saleItems) {
  sales = sales || [];
  saleItems = saleItems || [];
  var serviceItems = saleItems.filter(isDashboardServiceSaleItem);
  var productItems = saleItems.filter(function(item) {
    return !isDashboardServiceSaleItem(item);
  });

  var totalSales = sales.reduce(function(sum, sale) {
    return sum + (Number(sale.total) || 0);
  }, 0);

  var totalProfit = saleItems.reduce(function(sum, item) {
    return sum + (Number(item.profit) || 0);
  }, 0);

  var itemsSold = productItems.reduce(function(sum, item) {
    return sum + (Number(item.quantity) || 0);
  }, 0);

  var servicesSold = serviceItems.reduce(function(sum, item) {
    return sum + (Number(item.quantity) || 0);
  }, 0);

  var serviceRevenue = serviceItems.reduce(function(sum, item) {
    return sum + (Number(item.total) || 0);
  }, 0);

  var serviceProfit = serviceItems.reduce(function(sum, item) {
    return sum + (Number(item.profit) || 0);
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
    var seller = String(sale.seller || sale.vendor || sale.created_by || "Nao informado").trim() || "Nao informado";
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
    servicesSold: servicesSold,
    serviceRevenue: serviceRevenue,
    serviceProfit: serviceProfit,
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
  set("sales-service-count", new Intl.NumberFormat(getLocale()).format(data.servicesSold || 0));
  set("sales-service-revenue", fmt(data.serviceRevenue || 0));
  set("sales-service-profit", fmt(data.serviceProfit || 0));

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
            '<strong>' + (index + 1) + '. ' + escapeDespesaHtml(row.name) + '</strong>' +
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
            '<strong>' + escapeDespesaHtml(row.name) + '</strong>' +
            '<small>' + formatDashboardCount(row.count || 0, 'saleUnit') + '</small>' +
          '</div>' +
          '<span>' + fmt(row.total || 0) + '</span>' +
        '</div>';
      }).join("");
    }
  }
}

var salesAnalyticsState = {
  loaded: false,
  loading: false,
  data: null,
  selectedProductIndex: -1
};

function formatSalesAnalyticsDate(value) {
  var text = String(value || "").slice(0, 10);
  if (!text) return "-";
  var parts = text.split("-");
  if (parts.length !== 3) return text;
  return parts[2] + "/" + parts[1] + "/" + parts[0];
}

function getSalesAnalyticsDateRange() {
  var periodEl = document.getElementById("salesAnalyticsPeriod");
  var period = periodEl ? periodEl.value : "month";
  var now = new Date();
  var from = new Date(now.getFullYear(), now.getMonth(), 1);
  var to = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (period === "today") {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "7days") {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  } else if (period === "30days") {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  } else if (period === "custom") {
    var customFrom = document.getElementById("salesAnalyticsFrom");
    var customTo = document.getElementById("salesAnalyticsTo");
    return {
      period: period,
      from: customFrom && customFrom.value ? customFrom.value : localDateKey(from),
      to: customTo && customTo.value ? customTo.value : localDateKey(to)
    };
  }

  return {
    period: period,
    from: localDateKey(from),
    to: localDateKey(to)
  };
}

function onSalesAnalyticsPeriodChange() {
  var range = getSalesAnalyticsDateRange();
  var custom = range.period === "custom";

  Array.prototype.forEach.call(document.querySelectorAll(".sales-analytics-custom-date"), function(group) {
    group.classList.toggle("is-visible", custom);
  });

  var from = document.getElementById("salesAnalyticsFrom");
  var to = document.getElementById("salesAnalyticsTo");
  if (from && !from.value) from.value = range.from;
  if (to && !to.value) to.value = range.to;
}

function setSalesAnalyticsStatus(message, type) {
  var status = document.getElementById("salesAnalyticsStatus");
  if (!status) return;
  status.textContent = message || "";
  status.className = "sales-analytics-status" + (type ? " " + type : "");
}

function setSalesAnalyticsLoading(loading) {
  salesAnalyticsState.loading = !!loading;
  var button = document.getElementById("salesAnalyticsRefreshBtn");
  if (!button) return;
  button.disabled = !!loading;
  button.classList.toggle("is-loading", !!loading);
  button.textContent = loading ? "A carregar..." : "Atualizar";
}

function setSalesAnalyticsSelectOptions(id, rows, placeholder) {
  var select = document.getElementById(id);
  if (!select) return;
  var current = select.value;
  var html = '<option value="">' + escapeDespesaHtml(placeholder) + '</option>';

  (rows || []).forEach(function(row) {
    html += '<option value="' + escapeDespesaHtml(row.value) + '">' + escapeDespesaHtml(row.label) + '</option>';
  });

  select.innerHTML = html;
  if (current && (rows || []).some(function(row) { return row.value === current; })) {
    select.value = current;
  }
}

function getSalesAnalyticsItemKey(item) {
  if (item && item.product_id) return "id:" + String(item.product_id);
  return "name:" + String(item && item.product_name || "Produto").trim().toLowerCase();
}

function getSalesAnalyticsSeller(sale) {
  return String(sale && (sale.user_name || sale.seller || sale.vendor || sale.created_by) || "Nao informado").trim() || "Nao informado";
}

function parseSalesAnalyticsVariations(item) {
  var values = item && item.variations;

  if (typeof values === "string") {
    try {
      values = JSON.parse(values);
    } catch (e) {
      values = values.split(/[|,;/]+/);
    }
  }

  if (!Array.isArray(values)) values = [];

  if (!values.length && item && item.variation) {
    values = String(item.variation).split(/[|,;/]+/);
  }

  return values.map(function(value) {
    return String(value || "").trim();
  }).filter(function(value) {
    var normalized = value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return value && normalized !== "servico";
  });
}

function buildSalesAnalyticsData(sales, items, productRows, filters) {
  sales = sales || [];
  items = items || [];
  productRows = productRows || [];
  filters = filters || {};

  var productById = {};
  var productByName = {};
  productRows.forEach(function(product) {
    if (product.id) productById[String(product.id)] = product;
    productByName[String(product.name || "").trim().toLowerCase()] = product;
  });

  var sellerFilter = String(filters.seller || "");
  var filteredSales = sales.filter(function(sale) {
    return !sellerFilter || getSalesAnalyticsSeller(sale) === sellerFilter;
  });
  var allowedSaleIds = {};
  filteredSales.forEach(function(sale) {
    allowedSaleIds[String(sale.id)] = true;
  });

  var productFilter = String(filters.product || "");
  var categoryFilter = String(filters.category || "");
  var filteredItems = items.filter(function(item) {
    if (!allowedSaleIds[String(item.sale_id)]) return false;
    var product = productById[String(item.product_id || "")] ||
      productByName[String(item.product_name || "").trim().toLowerCase()] || {};
    var itemCategory = String(product.category || (isDashboardServiceSaleItem(item) ? "Servicos" : "Sem categoria"));

    if (productFilter && getSalesAnalyticsItemKey(item) !== productFilter) return false;
    if (categoryFilter && itemCategory !== categoryFilter) return false;
    return true;
  });

  var filteredSaleIds = {};
  filteredItems.forEach(function(item) {
    filteredSaleIds[String(item.sale_id)] = true;
  });
  filteredSales = filteredSales.filter(function(sale) {
    return filteredSaleIds[String(sale.id)] || (!productFilter && !categoryFilter && !items.length);
  });

  var saleById = {};
  filteredSales.forEach(function(sale) {
    saleById[String(sale.id)] = sale;
  });

  var amountBySale = {};
  filteredItems.forEach(function(item) {
    var id = String(item.sale_id);
    amountBySale[id] = (amountBySale[id] || 0) + (Number(item.total) || 0);
  });

  var hasItemFilter = !!(productFilter || categoryFilter);
  var revenue = filteredSales.reduce(function(sum, sale) {
    var id = String(sale.id);
    return sum + (hasItemFilter ? (amountBySale[id] || 0) : (Number(sale.total) || amountBySale[id] || 0));
  }, 0);
  var profit = filteredItems.reduce(function(sum, item) {
    return sum + (Number(item.profit) || 0);
  }, 0);
  var quantity = filteredItems.reduce(function(sum, item) {
    return sum + (Number(item.quantity) || 0);
  }, 0);

  var productMap = {};
  var variationMap = {};
  filteredItems.forEach(function(item) {
    var key = getSalesAnalyticsItemKey(item);
    var product = productById[String(item.product_id || "")] ||
      productByName[String(item.product_name || "").trim().toLowerCase()] || {};
    var qty = Number(item.quantity) || 0;
    var total = Number(item.total) || 0;
    var itemProfit = Number(item.profit) || 0;

    if (!productMap[key]) {
      productMap[key] = {
        key: key,
        name: item.product_name || product.name || "Produto",
        category: product.category || (isDashboardServiceSaleItem(item) ? "Servicos" : "Sem categoria"),
        quantity: 0,
        revenue: 0,
        profit: 0,
        saleIds: {},
        stock: (Number(product.stock_shop) || 0) + (Number(product.stock_warehouse) || 0),
        unitPrice: 0
      };
    }

    productMap[key].quantity += qty;
    productMap[key].revenue += total;
    productMap[key].profit += itemProfit;
    productMap[key].saleIds[String(item.sale_id)] = true;
    if (qty > 0) productMap[key].unitPrice = total / qty;

    var variations = parseSalesAnalyticsVariations(item);
    if (!variations.length) variations = ["Sem variacao"];

    variations.forEach(function(variation) {
      var variationKey = String(variation).toLowerCase();
      if (!variationMap[variationKey]) {
        variationMap[variationKey] = {
          name: variation,
          quantity: 0,
          revenue: 0,
          profit: 0,
          products: {}
        };
      }
      variationMap[variationKey].quantity += qty;
      variationMap[variationKey].revenue += total;
      variationMap[variationKey].profit += itemProfit;
      variationMap[variationKey].products[key] = true;
    });
  });

  var productsData = Object.keys(productMap).map(function(key) {
    var row = productMap[key];
    row.salesCount = Object.keys(row.saleIds).length;
    row.margin = row.revenue > 0 ? (row.profit / row.revenue) * 100 : 0;
    row.averagePrice = row.quantity > 0 ? row.revenue / row.quantity : 0;
    return row;
  }).sort(function(a, b) {
    return b.revenue - a.revenue;
  });

  var variationsData = Object.keys(variationMap).map(function(key) {
    var row = variationMap[key];
    row.productCount = Object.keys(row.products).length;
    row.margin = row.revenue > 0 ? (row.profit / row.revenue) * 100 : 0;
    return row;
  }).sort(function(a, b) {
    return b.quantity - a.quantity;
  });

  var clientsMap = {};
  var sellersMap = {};
  var dailyMap = {};
  var weekdayMap = {};
  var hourMap = {};
  var heatmap = {};
  var weekdayLabels = ["Domingo", "Segunda", "Terca", "Quarta", "Quinta", "Sexta", "Sabado"];

  filteredSales.forEach(function(sale) {
    var saleId = String(sale.id);
    var saleAmount = hasItemFilter ? (amountBySale[saleId] || 0) : (Number(sale.total) || amountBySale[saleId] || 0);
    var client = String(sale.client_name || "Anonimo").trim() || "Anonimo";
    var seller = getSalesAnalyticsSeller(sale);
    var dateKey = String(sale.sale_date || sale.created_at || "").slice(0, 10);
    var createdAt = sale.created_at ? new Date(sale.created_at) : null;

    if (!clientsMap[client]) clientsMap[client] = { name: client, total: 0, count: 0 };
    clientsMap[client].total += saleAmount;
    clientsMap[client].count += 1;

    if (!sellersMap[seller]) sellersMap[seller] = { name: seller, total: 0, count: 0 };
    sellersMap[seller].total += saleAmount;
    sellersMap[seller].count += 1;

    if (dateKey) {
      if (!dailyMap[dateKey]) dailyMap[dateKey] = { name: dateKey, total: 0, count: 0 };
      dailyMap[dateKey].total += saleAmount;
      dailyMap[dateKey].count += 1;
    }

    if (createdAt && !isNaN(createdAt.getTime())) {
      var weekday = createdAt.getDay();
      var hour = createdAt.getHours();
      var weekdayName = weekdayLabels[weekday];

      if (!weekdayMap[weekday]) weekdayMap[weekday] = { name: weekdayName, total: 0, count: 0, index: weekday };
      weekdayMap[weekday].total += saleAmount;
      weekdayMap[weekday].count += 1;

      if (!hourMap[hour]) hourMap[hour] = { hour: hour, total: 0, count: 0 };
      hourMap[hour].total += saleAmount;
      hourMap[hour].count += 1;
      heatmap[weekday + ":" + hour] = (heatmap[weekday + ":" + hour] || 0) + saleAmount;
    }
  });

  var clients = Object.keys(clientsMap).map(function(key) { return clientsMap[key]; }).sort(function(a, b) { return b.total - a.total; });
  var sellers = Object.keys(sellersMap).map(function(key) { return sellersMap[key]; }).sort(function(a, b) { return b.total - a.total; });
  var daily = Object.keys(dailyMap).map(function(key) { return dailyMap[key]; }).sort(function(a, b) { return a.name.localeCompare(b.name); });
  var weekdays = Object.keys(weekdayMap).map(function(key) { return weekdayMap[key]; }).sort(function(a, b) { return a.index - b.index; });
  var hours = Object.keys(hourMap).map(function(key) { return hourMap[key]; }).sort(function(a, b) { return a.hour - b.hour; });
  var bestDay = daily.slice().sort(function(a, b) { return b.total - a.total; })[0] || null;
  var bestHour = hours.slice().sort(function(a, b) { return b.total - a.total; })[0] || null;
  var bestVariationProfit = variationsData.slice().sort(function(a, b) { return b.profit - a.profit; })[0] || null;

  return {
    revenue: revenue,
    profit: profit,
    margin: revenue > 0 ? (profit / revenue) * 100 : 0,
    ticket: filteredSales.length ? revenue / filteredSales.length : 0,
    salesCount: filteredSales.length,
    quantity: quantity,
    productCount: productsData.length,
    products: productsData,
    variations: variationsData,
    clients: clients,
    sellers: sellers,
    daily: daily,
    weekdays: weekdays,
    hours: hours,
    heatmap: heatmap,
    bestDay: bestDay,
    bestHour: bestHour,
    bestVariation: variationsData[0] || null,
    bestVariationProfit: bestVariationProfit
  };
}

function getSalesAnalyticsFilters() {
  var range = getSalesAnalyticsDateRange();
  return {
    from: range.from,
    to: range.to,
    product: document.getElementById("salesAnalyticsProduct") ? document.getElementById("salesAnalyticsProduct").value : "",
    category: document.getElementById("salesAnalyticsCategory") ? document.getElementById("salesAnalyticsCategory").value : "",
    seller: document.getElementById("salesAnalyticsSeller") ? document.getElementById("salesAnalyticsSeller").value : ""
  };
}

async function getSalesAnalyticsFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();
  var salesQuery = supabaseClient
    .from("sales")
    .select("*")
    .eq("organization_id", organizationId)
    .gte("sale_date", filters.from)
    .lte("sale_date", filters.to)
    .order("sale_date", { ascending: true })
    .order("created_at", { ascending: true });

  var salesResult = await salesQuery;
  if (salesResult.error) throw salesResult.error;

  var sales = salesResult.data || [];
  var items = sales.length ? await fetchSaleItemsBySaleIds(sales.map(function(sale) { return sale.id; })) : [];
  var resellerProjection = await getResellerSalesProjectionFromSupabase(filters);
  sales = sales.concat(resellerProjection.sales || []);
  items = items.concat(resellerProjection.items || []);

  var productsResult = await supabaseClient
    .from("products")
    .select("id,name,category,stock_shop,stock_warehouse")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (productsResult.error) throw productsResult.error;
  var productRows = productsResult.data || [];

  var productOptionsMap = {};
  items.forEach(function(item) {
    var key = getSalesAnalyticsItemKey(item);
    if (!productOptionsMap[key]) {
      productOptionsMap[key] = {
        value: key,
        label: item.product_name || "Produto"
      };
    }
  });

  var categoriesMap = {};
  productRows.forEach(function(product) {
    var category = String(product.category || "Sem categoria").trim() || "Sem categoria";
    categoriesMap[category] = true;
  });
  if (items.some(isDashboardServiceSaleItem)) categoriesMap.Servicos = true;

  var sellersMap = {};
  sales.forEach(function(sale) {
    sellersMap[getSalesAnalyticsSeller(sale)] = true;
  });

  setSalesAnalyticsSelectOptions(
    "salesAnalyticsProduct",
    Object.keys(productOptionsMap).map(function(key) { return productOptionsMap[key]; }).sort(function(a, b) { return a.label.localeCompare(b.label); }),
    "Todos os produtos"
  );
  setSalesAnalyticsSelectOptions(
    "salesAnalyticsCategory",
    Object.keys(categoriesMap).sort().map(function(category) { return { value: category, label: category }; }),
    "Todas as categorias"
  );
  setSalesAnalyticsSelectOptions(
    "salesAnalyticsSeller",
    Object.keys(sellersMap).sort().map(function(seller) { return { value: seller, label: seller }; }),
    "Todos os vendedores"
  );

  return buildSalesAnalyticsData(sales, items, productRows, filters);
}

function renderSalesAnalyticsBarList(id, rows, labelFn) {
  var container = document.getElementById(id);
  if (!container) return;
  rows = rows || [];

  if (!rows.length) {
    container.innerHTML = '<div class="empty">Sem dados neste periodo.</div>';
    return;
  }

  var max = rows.reduce(function(value, row) {
    return Math.max(value, Number(row.total) || 0);
  }, 0) || 1;

  container.innerHTML = rows.map(function(row) {
    var width = Math.max(3, ((Number(row.total) || 0) / max) * 100);
    return '<div class="sales-analytics-bar-row">' +
      '<div class="sales-analytics-bar-label"><strong>' + escapeDespesaHtml(labelFn ? labelFn(row) : row.name) + '</strong><span>' + fmt(row.total || 0) + '</span></div>' +
      '<div class="sales-analytics-bar-track"><span style="width:' + width.toFixed(2) + '%"></span></div>' +
    '</div>';
  }).join("");
}

function renderSalesAnalyticsCompactList(id, rows) {
  var container = document.getElementById(id);
  if (!container) return;
  rows = (rows || []).slice(0, 6);

  if (!rows.length) {
    container.innerHTML = '<div class="empty">Sem dados neste periodo.</div>';
    return;
  }

  container.innerHTML = rows.map(function(row, index) {
    return '<div class="sales-analytics-compact-row">' +
      '<span class="sales-analytics-rank">' + (index + 1) + '</span>' +
      '<div><strong>' + escapeDespesaHtml(row.name) + '</strong><small>' + row.count + ' venda(s)</small></div>' +
      '<b>' + fmt(row.total || 0) + '</b>' +
    '</div>';
  }).join("");
}

function renderSalesAnalyticsSummary(data) {
  var set = function(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = value;
  };

  set("salesAnalyticsRevenue", fmt(data.revenue || 0));
  set("salesAnalyticsRevenueSub", data.salesCount + " venda(s)");
  set("salesAnalyticsProfit", fmt(data.profit || 0));
  set("salesAnalyticsProfitSub", "Margem " + (Number(data.margin || 0).toFixed(1)).replace(".", ",") + "%");
  set("salesAnalyticsTicket", fmt(data.ticket || 0));
  set("salesAnalyticsQuantity", new Intl.NumberFormat(getLocale()).format(data.quantity || 0));
  set("salesAnalyticsQuantitySub", data.productCount + " produto(s) diferente(s)");
  set("salesAnalyticsBestDay", data.bestDay ? formatSalesAnalyticsDate(data.bestDay.name) : "-");
  set("salesAnalyticsBestDaySub", fmt(data.bestDay ? data.bestDay.total : 0));
  set("salesAnalyticsBestHour", data.bestHour ? String(data.bestHour.hour).padStart(2, "0") + ":00" : "-");
  set("salesAnalyticsBestHourSub", (data.bestHour ? data.bestHour.count : 0) + " venda(s)");

  var top = document.getElementById("salesAnalyticsTopProducts");
  var topRows = (data.products || []).slice(0, 6);
  if (top) {
    top.innerHTML = topRows.length ? topRows.map(function(row, index) {
      return '<button type="button" class="sales-analytics-ranking-row" onclick="openSalesAnalyticsProduct(' + (data.products || []).indexOf(row) + ')">' +
        '<span class="sales-analytics-rank">' + (index + 1) + '</span>' +
        '<div><strong>' + escapeDespesaHtml(row.name) + '</strong><small>' + new Intl.NumberFormat(getLocale()).format(row.quantity || 0) + ' un. | Lucro ' + fmt(row.profit || 0) + '</small></div>' +
        '<b>' + fmt(row.revenue || 0) + '</b>' +
      '</button>';
    }).join("") : '<div class="empty">Sem produtos vendidos neste periodo.</div>';
  }

  renderSalesAnalyticsBarList("salesAnalyticsDailyBars", (data.daily || []).slice(-14), function(row) {
    return formatSalesAnalyticsDate(row.name);
  });
  renderSalesAnalyticsCompactList("salesAnalyticsClients", data.clients);
  renderSalesAnalyticsCompactList("salesAnalyticsSellers", data.sellers);
}

function renderSalesAnalyticsProducts() {
  var data = salesAnalyticsState.data || {};
  var productsData = (data.products || []).slice();
  var search = document.getElementById("salesAnalyticsProductSearch");
  var sort = document.getElementById("salesAnalyticsProductSort");
  var term = String(search && search.value || "").trim().toLowerCase();
  var sortKey = String(sort && sort.value || "revenue");
  productsData.sort(function(a, b) {
    return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0);
  });
  var filtered = productsData.map(function(row, index) {
    return { row: row, index: (data.products || []).indexOf(row) };
  }).filter(function(entry) {
    return !term || [entry.row.name, entry.row.category].join(" ").toLowerCase().indexOf(term) >= 0;
  });
  var body = document.getElementById("salesAnalyticsProductsBody");
  var mobile = document.getElementById("salesAnalyticsProductsMobile");

  if (body) {
    body.innerHTML = filtered.length ? filtered.map(function(entry) {
      var row = entry.row;
      return '<tr tabindex="0" onclick="openSalesAnalyticsProduct(' + entry.index + ')" onkeydown="if(event.key===\'Enter\')openSalesAnalyticsProduct(' + entry.index + ')">' +
        '<td><strong>' + escapeDespesaHtml(row.name) + '</strong><small>' + escapeDespesaHtml(row.category) + '</small></td>' +
        '<td>' + new Intl.NumberFormat(getLocale()).format(row.quantity || 0) + '</td>' +
        '<td>' + fmt(row.revenue || 0) + '</td>' +
        '<td class="green">' + fmt(row.profit || 0) + '</td>' +
        '<td>' + (Number(row.margin || 0).toFixed(1)).replace(".", ",") + '%</td>' +
        '<td>' + row.salesCount + '</td>' +
      '</tr>';
    }).join("") : '<tr><td colspan="6" class="empty">Nenhum produto encontrado.</td></tr>';
  }

  if (mobile) {
    mobile.innerHTML = filtered.length ? filtered.map(function(entry) {
      var row = entry.row;
      return '<button type="button" class="sales-analytics-product-mobile" onclick="openSalesAnalyticsProduct(' + entry.index + ')">' +
        '<div><strong>' + escapeDespesaHtml(row.name) + '</strong><small>' + escapeDespesaHtml(row.category) + ' | ' + new Intl.NumberFormat(getLocale()).format(row.quantity || 0) + ' un.</small></div>' +
        '<div><b>' + fmt(row.revenue || 0) + '</b><small>Lucro ' + fmt(row.profit || 0) + '</small></div>' +
      '</button>';
    }).join("") : '<div class="empty">Nenhum produto encontrado.</div>';
  }
}

function openSalesAnalyticsProduct(index) {
  var data = salesAnalyticsState.data || {};
  var row = (data.products || [])[Number(index)];
  if (!row) return;
  salesAnalyticsState.selectedProductIndex = Number(index);
  switchSalesAnalyticsTab("products");

  var detail = document.getElementById("salesAnalyticsProductDetail");
  if (!detail) return;
  detail.innerHTML =
    '<div class="sales-analytics-product-title">' +
      '<div><span class="eyebrow">Detalhe do produto</span><h3>' + escapeDespesaHtml(row.name) + '</h3><p>' + escapeDespesaHtml(row.category) + '</p></div>' +
      '<span class="sales-analytics-stock-badge">' + new Intl.NumberFormat(getLocale()).format(row.stock || 0) + ' em stock</span>' +
    '</div>' +
    '<div class="sales-analytics-detail-grid">' +
      '<div><span>Faturacao</span><strong>' + fmt(row.revenue || 0) + '</strong></div>' +
      '<div><span>Lucro</span><strong class="green">' + fmt(row.profit || 0) + '</strong></div>' +
      '<div><span>Margem</span><strong>' + (Number(row.margin || 0).toFixed(1)).replace(".", ",") + '%</strong></div>' +
      '<div><span>Quantidade</span><strong>' + new Intl.NumberFormat(getLocale()).format(row.quantity || 0) + '</strong></div>' +
      '<div><span>Preco medio</span><strong>' + fmt(row.averagePrice || 0) + '</strong></div>' +
      '<div><span>Vendas</span><strong>' + row.salesCount + '</strong></div>' +
    '</div>' +
    '<div class="sales-analytics-insight">' +
      '<strong>Leitura rapida</strong>' +
      '<p>' + (row.margin >= 30 ? 'Boa margem. Este produto contribui bem para o lucro.' : row.margin > 0 ? 'Margem moderada. Confirma o preco de compra e o preco de venda.' : 'Produto sem lucro registado. Verifica custos e precos.') + '</p>' +
    '</div>';
}

function renderSalesAnalyticsVariations(data) {
  var set = function(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = value;
  };
  set("salesAnalyticsBestVariation", data.bestVariation ? data.bestVariation.name : "-");
  set("salesAnalyticsBestVariationSub", new Intl.NumberFormat(getLocale()).format(data.bestVariation ? data.bestVariation.quantity : 0) + " unidades");
  set("salesAnalyticsBestVariationProfit", data.bestVariationProfit ? data.bestVariationProfit.name : "-");
  set("salesAnalyticsBestVariationProfitSub", fmt(data.bestVariationProfit ? data.bestVariationProfit.profit : 0));

  var list = document.getElementById("salesAnalyticsVariationsList");
  var rows = data.variations || [];
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma variacao registada neste periodo.</div>';
    return;
  }

  var max = rows.reduce(function(value, row) { return Math.max(value, row.quantity || 0); }, 0) || 1;
  list.innerHTML = rows.map(function(row) {
    var width = Math.max(3, ((row.quantity || 0) / max) * 100);
    return '<div class="sales-analytics-variation-row">' +
      '<div class="sales-analytics-variation-main"><strong>' + escapeDespesaHtml(row.name) + '</strong><small>' + row.productCount + ' produto(s)</small></div>' +
      '<div class="sales-analytics-variation-metrics"><span>' + new Intl.NumberFormat(getLocale()).format(row.quantity || 0) + ' un.</span><b>' + fmt(row.revenue || 0) + '</b><em>Lucro ' + fmt(row.profit || 0) + '</em></div>' +
      '<div class="sales-analytics-bar-track"><span style="width:' + width.toFixed(2) + '%"></span></div>' +
    '</div>';
  }).join("");
}

function renderSalesAnalyticsTiming(data) {
  renderSalesAnalyticsBarList("salesAnalyticsWeekdays", data.weekdays || [], function(row) {
    return row.name;
  });

  var hoursContainer = document.getElementById("salesAnalyticsHours");
  var hours = data.hours || [];
  if (hoursContainer) {
    hoursContainer.innerHTML = hours.length ? hours.map(function(row) {
      return '<div class="sales-analytics-hour-card">' +
        '<strong>' + String(row.hour).padStart(2, "0") + ':00</strong>' +
        '<span>' + fmt(row.total || 0) + '</span>' +
        '<small>' + row.count + ' venda(s)</small>' +
      '</div>';
    }).join("") : '<div class="empty">Sem horarios disponiveis.</div>';
  }

  var heatmapContainer = document.getElementById("salesAnalyticsHeatmap");
  if (!heatmapContainer) return;
  var weekdayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
  var maxHeat = Object.keys(data.heatmap || {}).reduce(function(value, key) {
    return Math.max(value, Number(data.heatmap[key]) || 0);
  }, 0) || 1;
  var html = '<div class="sales-analytics-heatmap-corner"></div>';
  for (var hour = 0; hour < 24; hour++) {
    html += '<div class="sales-analytics-heatmap-hour">' + String(hour).padStart(2, "0") + '</div>';
  }
  weekdayLabels.forEach(function(day, weekday) {
    html += '<div class="sales-analytics-heatmap-day">' + day + '</div>';
    for (var heatHour = 0; heatHour < 24; heatHour++) {
      var value = Number((data.heatmap || {})[weekday + ":" + heatHour]) || 0;
      var intensity = value > 0 ? Math.max(0.14, value / maxHeat) : 0;
      html += '<div class="sales-analytics-heat-cell" style="--heat:' + intensity.toFixed(3) + '" title="' +
        escapeDespesaHtml(day + " " + String(heatHour).padStart(2, "0") + ":00 - " + fmt(value)) + '"></div>';
    }
  });
  heatmapContainer.innerHTML = html;
}

function renderSalesAnalytics(data) {
  salesAnalyticsState.data = data;
  renderSalesAnalyticsSummary(data);
  renderSalesAnalyticsProducts();
  renderSalesAnalyticsVariations(data);
  renderSalesAnalyticsTiming(data);

  if (salesAnalyticsState.selectedProductIndex >= 0) {
    openSalesAnalyticsProduct(salesAnalyticsState.selectedProductIndex);
  }
}

function switchSalesAnalyticsTab(tab, button) {
  var target = document.getElementById("sales-analytics-" + tab);
  if (!target) return;
  Array.prototype.forEach.call(document.querySelectorAll(".sales-analytics-panel"), function(panel) {
    panel.classList.remove("active");
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-sales-analytics-tab]"), function(tabButton) {
    tabButton.classList.toggle("active", tabButton.getAttribute("data-sales-analytics-tab") === tab);
  });
  target.classList.add("active");
  if (button && button.classList) button.classList.add("active");
}

async function loadSalesAnalytics(force) {
  if (salesAnalyticsState.loading) return;
  if (salesAnalyticsState.loaded && !force) return;
  var filters = getSalesAnalyticsFilters();
  setSalesAnalyticsLoading(true);
  setSalesAnalyticsStatus("A analisar vendas de " + formatSalesAnalyticsDate(filters.from) + " ate " + formatSalesAnalyticsDate(filters.to) + "...", "loading");

  try {
    var data = await getSalesAnalyticsFromSupabase(filters);
    salesAnalyticsState.loaded = true;
    salesAnalyticsState.selectedProductIndex = -1;
    renderSalesAnalytics(data);
    setSalesAnalyticsStatus(
      data.salesCount
        ? data.salesCount + " venda(s) analisada(s) entre " + formatSalesAnalyticsDate(filters.from) + " e " + formatSalesAnalyticsDate(filters.to) + "."
        : "Nenhuma venda encontrada para os filtros escolhidos.",
      data.salesCount ? "success" : "empty"
    );
    applyAzulIcons();
  } catch (e) {
    console.error("Erro analise comercial:", e);
    setSalesAnalyticsStatus("Nao foi possivel carregar a analise: " + (e.message || e), "error");
    toast("Erro na analise comercial: " + (e.message || e), "error");
  } finally {
    setSalesAnalyticsLoading(false);
  }
}

function initSalesAnalyticsPage() {
  onSalesAnalyticsPeriodChange();
  loadSalesAnalytics(true);
}

window.initSalesAnalyticsPage = initSalesAnalyticsPage;
window.loadSalesAnalytics = loadSalesAnalytics;
window.onSalesAnalyticsPeriodChange = onSalesAnalyticsPeriodChange;
window.switchSalesAnalyticsTab = switchSalesAnalyticsTab;
window.renderSalesAnalyticsProducts = renderSalesAnalyticsProducts;
window.openSalesAnalyticsProduct = openSalesAnalyticsProduct;

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

  var receivables = Number(debts.clientDebtTotal != null ? debts.clientDebtTotal : debts.clientTotal) || 0;
  var resellerReceivables = Number(debts.resellerTotal) || 0;
  var payables = Number(debts.supplierTotal) || 0;
  var cash = Number(quickTreasury.balance) || 0;

  var assets = cash + stockValue + receivables + resellerReceivables;
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
    resellerReceivables: resellerReceivables,
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
  set("acct-sum-reseller-receivables", fmt(data.resellerReceivables || 0));
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
    return '<div class="important-alert-row ' + escapeDespesaHtml(alert.level || "warning") + '">' +
      '<div class="important-alert-dot"></div>' +
      '<div class="important-alert-content">' +
        '<strong>' + escapeDespesaHtml(alert.title || "Alerta") + '</strong>' +
        '<small>' + escapeDespesaHtml(alert.desc || "") + '</small>' +
      '</div>' +
      '<button class="important-alert-action" aria-label="Ver mais" onclick="goTo(\'' + escapeDespesaHtml(alert.page || "dashboard") + '\', null)">' +
        '<span>></span>' +
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
  document.getElementById('k-depenses').textContent = fmt(d.totalDespesas);
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
        '<div class="top-name">' + escapeDespesaHtml(p.name || '') + '</div>' +
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
        '<span>' + escapeDespesaHtml(a.name || '') + '</span>' +
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
  var title = 'Resumo Dashboard';
  var salesLabel = 'Vendas totais';
  var salesCountLabel = 'Transacoes';
  var profitLabel = 'Lucro total';
  var expenseLabel = 'Despesas totais';
  var alertsLabel = 'Alertas stock';
  var paymentLabel = 'Vendas por pagamento';
  var topLabel = 'Top produtos';
  var periodLabel = 'Periodo';
  var printedLabel = 'Impresso em';
  var noDataLabel = 'Sem dados';
  var depCountLabel = 'Registos despesas';

  var logoImage = (config && config.receiptLogo) ? '<img src="' + escapeDashboardTicketText(config.receiptLogo) + '" style="display:block;max-width:100%;height:auto;margin:0 auto 8px auto;object-fit:contain;width:' + escapeDashboardTicketText((config.receiptLogoSize || '16') + 'mm') + ';">' : '';
  var shopName = escapeDashboardTicketText((config && config.name) || 'Azul Gestao');
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
      '<div class="line"><span>' + expenseLabel + '</span><span>' + escapeDashboardTicketText(fmt(d.totalDespesas || 0)) + '</span></div>' +
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
  toast("Dashboard ainda a carregar...", "info");
}, 30000);

  try {
    var data = await getDashboardDataFromSupabase(filters);

    if (requestId !== dashboardRequestSeq) return;

    if (dashboardLoadingTimer) {
      clearTimeout(dashboardLoadingTimer);
      dashboardLoadingTimer = null;
    }

    renderDashboardData(data);
    applyPortugueseText();
    applyAzulIcons();

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
var barcodeKeyboardBuffer = "";
var barcodeKeyboardTimer = null;
var barcodeScannerStream = null;
var barcodeScannerFrame = null;
var barcodeScannerBusy = false;
var barcodeScannerTarget = null;
var barcodeLastScan = { code: "", at: 0 };
var BARCODE_DUPLICATE_DELAY_MS = 2600;
var BARCODE_SCAN_RESUME_DELAY_MS = 1800;
var phoneScannerSession = null;
var phoneScannerChannel = null;
var phoneScannerUrl = "";
var phoneScannerPollTimer = null;
var phoneScannerModalAutoHidden = false;
var phoneScannerProcessedEvents = {};
var productsLastLoadedAt = 0;
var PRODUCT_CACHE_MS = 60000;

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
    var key = String(product.id || product.code || [
      name,
      product.variation,
      Array.isArray(product.variations) ? product.variations.join('|') : '',
      product.salePrice || product.price || ''
    ].join('|')).toLowerCase();
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

function renderProductDependentViews() {
  renderCompraProductDatalist();
  renderFornPayDatalist();
  renderFornNameDatalist();
  rendertransfertDatalist();
  renderProductProfileOptions();
  renderClientDatalist();
}

function refreshProductHeavyViews() {
  renderRevProducts(products);
  renderinventaire(products);
}

function shouldUseCachedProducts(forceRefresh) {
  return !forceRefresh &&
    products &&
    products.length &&
    productsLastLoadedAt &&
    Date.now() - productsLastLoadedAt < PRODUCT_CACHE_MS;
}

function enrichProductsInBackground() {
  getInventoryMovementSummaryFromSupabase()
    .then(function(summary) {
      products = applyInventoryMovementSummary(products, summary);
      refreshProductHeavyViews();
    })
    .catch(function(e) {
      console.warn("Resumo de movimentos indisponivel:", e);
    });

  servicesLoading = true;
  getServicesFromSupabase()
    .then(function(data) {
      services = data || [];
      if (saleCatalogMode === "services") filterProds();
    })
    .catch(function(serviceError) {
      console.warn("Erro ao carregar servicos:", serviceError);
      services = [];
    })
    .finally(function() {
      servicesLoading = false;
    });
}

async function loadProducts(forceRefresh) {
  if (productsLoading) return;

  var vendaPage = document.getElementById("page-venda");
  var vendaActive = vendaPage && vendaPage.classList.contains("active");

  if (shouldUseCachedProducts(forceRefresh)) {
    filterProds();
    if (!vendaActive) {
      refreshProductHeavyViews();
      renderProductDependentViews();
    }
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
    productsLastLoadedAt = Date.now();

    setVendaProductsLoading(false);
    filterProds();
    renderProductDependentViews();
    refreshProductHeavyViews();
    enrichProductsInBackground();

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
function renderCompraProductDatalist() {
  var list = document.getElementById('prodList');
  if (!list) return;

  // 1. carregar les nom des fornecedores
  var name = (products || [])
    .map(p => p.name)
    .filter(f => f && f.trim() !== '');

  // 2. enlever les doublons
  var uniques = [...new Set(name)];

  // 3. gerar les options
  list.innerHTML = uniques.map(function(f) {
    return '<option value="' + escapeDespesaHtml(f) + '"></option>';
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
      return '<option value="' + escapeDespesaHtml(f) + '"></option>';
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
  gsCall('getVendas', params, function(data) {
    data = data || [];
    
    var list = document.getElementById('list-client');
    if (!list) return;

    // 1. carregar les fornecedores
    var clients = [...new Set(
      data
        .map(a => (a.client || '').trim().toLowerCase())
        .filter(c => c !== '')
    )];

    // 3. gerar les options
    list.innerHTML = clients.map(function(client) {
  return '<option value="' + client + '">' + client + '</option>';
  }).join('');
  });
}

function rendertransfertDatalist() {
  var list = document.getElementById('transProdList');
  if (!list) return;

  // 1. carregar les fornecedores
  var name = (products || [])
    .map(p => p.name)
    .filter(f => f && f.trim() !== '');

  // 2. enlever les doublons
  var uniques = [...new Set(name)];

  // 3. gerar les options
  list.innerHTML = uniques.map(function(f) {
    return '<option value="' + escapeDespesaHtml(f) + '"></option>';
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
  renderCompraLines();
}

function applyCompraProductPreset(index, value) {
  achatLines[index].prod = value;
  var normalizedValue = normalizePurchaseProductIdentity(value);
  var product = (products || []).find(function(p) {
    return normalizePurchaseProductIdentity(p.name) === normalizedValue;
  });
  achatLines[index].productId = product ? (product.id || "") : "";
  if (!product) return;
  achatLines[index].code = achatLines[index].code || product.code || '';
  achatLines[index].category = achatLines[index].category || product.category || '';
  achatLines[index].variation = achatLines[index].variation || product.variation || '';
  achatLines[index].variations = achatLines[index].variations && achatLines[index].variations.length ? achatLines[index].variations : parseVariationList(product.variation || product.variations || []);
  achatLines[index].photo = achatLines[index].photo || product.photo || '';
  achatLines[index].targetMargin = achatLines[index].targetMargin || product.price || product.targetMargin || '';
  achatLines[index].price = achatLines[index].price || product.purchasePrice || product.price || 0;
  var forn = document.getElementById('a-forn');
  if (forn && !forn.value && product.mainSupplier) forn.value = product.mainSupplier;
  renderCompraLines();
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

function addCompraVariation(index) {
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
  renderCompraLines();
}

function removeCompraVariation(index, chipIndex) {
  if (!achatLines[index]) return;
  achatLines[index].variations = achatLines[index].variations || [];
  achatLines[index].variations.splice(chipIndex, 1);
  achatLines[index].variation = achatLines[index].variations.join(' | ');
  renderCompraLines();
}

function handleCompraPhotoFile(event, index) {
  var file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file || !achatLines[index]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    achatLines[index].photo = e && e.target ? (e.target.result || '') : '';
    renderCompraLines();
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
  var html = '<option value="">Escolher produto...</option>';
  (products || []).forEach(function(p) {
    html += '<option value="' + escapeDespesaHtml(p.name) + '">' + escapeDespesaHtml(p.name) + (p.code ? ' [' + escapeDespesaHtml(p.code) + ']' : '') + '</option>';
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
    toast('Escolhe primeiro um produto.', 'error');
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
      btn.textContent = getText('save_product_profile') || 'Guardar ficha do produto';
    }
  });
}

function normalizeBarcodeValue(value) {
  return String(value || "").trim();
}

function getBarcodeKey(value) {
  return normalizeBarcodeValue(value).toLowerCase();
}

function findProductsByBarcode(code) {
  var key = getBarcodeKey(code);
  if (!key) return [];

  return (products || []).filter(function(product) {
    return getBarcodeKey(product && product.code) === key;
  });
}

function chooseBarcodeProduct(matches) {
  matches = Array.isArray(matches) ? matches.filter(Boolean) : [];
  if (!matches.length) return null;

  var available = matches.find(function(product) {
    return (Number(product.stockBoutique) || 0) > 0;
  });

  return available || matches[0];
}

function setBarcodeStatus(message, type) {
  var status = document.getElementById("barcodeStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.remove("success", "error", "warning");
  if (type) status.classList.add(type);
}

async function addProductByBarcode(code, options) {
  options = options || {};
  code = normalizeBarcodeValue(code);

  if (!code) {
    setBarcodeStatus("Lê ou escreve um codigo de barras.", "warning");
    return null;
  }

  if (!products || !products.length) {
    await loadProducts(true);
  }

  var matches = findProductsByBarcode(code);
  var product = chooseBarcodeProduct(matches);

  if (!product) {
    setBarcodeStatus("Produto nao encontrado: " + code, "error");
    toast("Produto nao encontrado para o codigo: " + code, "error");
    return null;
  }

  if (matches.length > 1) {
    setBarcodeStatus("Codigo repetido. Foi escolhido: " + product.name, "warning");
  } else {
    setBarcodeStatus("Adicionado: " + product.name, "success");
  }

  if (saleCatalogMode !== "products") {
    switchSaleCatalog("products");
  }

  addToCart(product.id || product.name, product.stockBoutique, {
    suppressFocus: !!options.suppressFocus
  });
  toast("Produto adicionado: " + product.name, "success");
  renderBarcodeScannerCartStrip(product);

  if (!options.keepInput) {
    var input = document.getElementById("barcodeInput");
    if (input) {
      input.value = "";
      if (!options.suppressFocus) input.focus();
    }
  }

  return product;
}

function handleBarcodeInputKey(event) {
  if (!event) return;
  if (event.key === "Enter") {
    event.preventDefault();
    scanBarcodeFromInput();
  }
}

function scanBarcodeFromInput() {
  var input = document.getElementById("barcodeInput");
  addProductByBarcode(input ? input.value : "");
}

function isVendaPageActiveForBarcode() {
  var page = document.getElementById("page-venda");
  var panel = document.getElementById("vente-panel-novo");
  return !!(page && page.classList.contains("active") && (!panel || panel.style.display !== "none"));
}

function isTypingInFormField(target) {
  if (!target) return false;
  var tag = String(target.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function setupBarcodeKeyboardScanner() {
  var input = document.getElementById("barcodeInput");
  if (input) {
    input.addEventListener("focus", function() {
      setBarcodeStatus("Pronto para ler codigo de barras.", "");
    });
  }

  document.addEventListener("keydown", function(event) {
    if (!isVendaPageActiveForBarcode()) return;
    if (isTypingInFormField(event.target)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;

    if (event.key === "Enter") {
      if (barcodeKeyboardBuffer.length >= 4) {
        event.preventDefault();
        var code = barcodeKeyboardBuffer;
        barcodeKeyboardBuffer = "";
        addProductByBarcode(code);
      }
      return;
    }

    if (event.key && event.key.length === 1) {
      barcodeKeyboardBuffer += event.key;
      if (barcodeKeyboardTimer) clearTimeout(barcodeKeyboardTimer);
      barcodeKeyboardTimer = setTimeout(function() {
        barcodeKeyboardBuffer = "";
      }, 80);
    }
  });
}

function setBarcodeScannerStatus(message, type) {
  var status = document.getElementById("barcodeScannerStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.remove("success", "error");
  if (type) status.classList.add(type);
}

async function getBarcodeDetectorInstance() {
  if (!("BarcodeDetector" in window)) return null;

  var preferred = [
    "ean_13",
    "ean_8",
    "upc_a",
    "upc_e",
    "code_128",
    "code_39",
    "code_93",
    "itf",
    "qr_code"
  ];

  try {
    if (typeof BarcodeDetector.getSupportedFormats === "function") {
      var supported = await BarcodeDetector.getSupportedFormats();
      var formats = preferred.filter(function(format) {
        return supported.indexOf(format) >= 0;
      });
      return formats.length ? new BarcodeDetector({ formats: formats }) : new BarcodeDetector();
    }
  } catch (e) {
    console.warn("Formats BarcodeDetector indisponiveis:", e);
  }

  return new BarcodeDetector();
}

function applyBarcodeToCompraLine(index, code) {
  index = Number(index);
  code = normalizeBarcodeValue(code);

  if (!achatLines[index] || !code) return false;

  achatLines[index].code = code;
  renderCompraLines();

  setTimeout(function() {
    var input = document.querySelector('[data-achat-code-index="' + index + '"]');
    if (input) input.focus();
  }, 50);

  toast("Codigo de barras inserido.", "success");
  return true;
}

async function handleBarcodeScanResult(code, options) {
  options = options || {};
  var target = barcodeScannerTarget || { mode: "sale" };

  if (target.mode === "purchase") {
    applyBarcodeToCompraLine(target.index, code);
    return null;
  }

  var input = document.getElementById("barcodeInput");
  if (input) input.value = code;
  return await addProductByBarcode(code, {
    keepInput: !!options.keepInput,
    suppressFocus: !!options.suppressFocus
  });
}

function openCompraBarcodeScanner(index) {
  openBarcodeScanner({ mode: "purchase", index: index });
}

function renderBarcodeScannerCartStrip(lastProduct) {
  var strip = document.getElementById("barcodeCartStrip");
  if (!strip) return;

  var title = document.getElementById("barcodeCartTitle");
  var meta = document.getElementById("barcodeCartMeta");
  var count = getCartCountMobile();
  var total = getCartTotalMobile();

  strip.style.display = cart && cart.length ? "flex" : "none";

  if (title) {
    title.textContent = lastProduct && lastProduct.name
      ? "Adicionado: " + lastProduct.name
      : "Carrinho actualizado";
  }

  if (meta) {
    meta.textContent = count + " produtos | " + fmt(total);
  }
}

async function openBarcodeScanner(options) {
  var modal = document.getElementById("barcodeScannerModal");
  var video = document.getElementById("barcodeScannerVideo");

  if (!modal || !video) return;
  barcodeScannerTarget = options || { mode: "sale" };
  renderBarcodeScannerCartStrip();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    barcodeScannerTarget = null;
    toast("Camera indisponivel neste navegador. Usa leitor USB/Bluetooth.", "error");
    return;
  }

  var detector = await getBarcodeDetectorInstance();
  if (!detector) {
    barcodeScannerTarget = null;
    toast("Este navegador nao suporta leitura por camera. Usa leitor USB/Bluetooth.", "error");
    return;
  }

  try {
    modal.style.display = "grid";
    modal.setAttribute("aria-hidden", "false");
    setBarcodeScannerStatus("A iniciar camera...", "");

    barcodeScannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    video.srcObject = barcodeScannerStream;
    await video.play();
    barcodeScannerBusy = false;
    setBarcodeScannerStatus("Procura o codigo de barras...", "");
    scanBarcodeVideoFrame(detector, video);
  } catch (e) {
    console.error("Erro leitor barcode:", e);
    closeBarcodeScanner();
    toast("Nao foi possivel abrir a camera: " + (e.message || e), "error");
  }
}

async function scanBarcodeVideoFrame(detector, video) {
  if (!video || !detector || barcodeScannerBusy || !barcodeScannerStream) return;

  try {
    var codes = await detector.detect(video);

    if (codes && codes.length) {
      barcodeScannerBusy = true;
      var code = codes[0].rawValue || codes[0].rawValueText || "";
      var target = barcodeScannerTarget;
      var now = Date.now();

      if (barcodeLastScan.code === code && now - barcodeLastScan.at < BARCODE_DUPLICATE_DELAY_MS) {
        barcodeScannerBusy = false;
        barcodeScannerFrame = window.requestAnimationFrame(function() {
          scanBarcodeVideoFrame(detector, video);
        });
        return;
      }

      barcodeLastScan = { code: code, at: now };

      if (target && target.mode === "purchase") {
        setBarcodeScannerStatus("Codigo encontrado: " + code, "success");
        closeBarcodeScanner();
        barcodeScannerTarget = target;
        await handleBarcodeScanResult(code);
        barcodeScannerTarget = null;
        return;
      }

      barcodeScannerTarget = target || { mode: "sale" };
      setBarcodeScannerStatus("Produto detectado. A adicionar ao carrinho...", "success");
      var addedProduct = await handleBarcodeScanResult(code, {
        keepInput: true,
        suppressFocus: true
      });

      if (addedProduct) {
        setBarcodeScannerStatus("Adicionado: " + addedProduct.name + ". Aguarde um instante para ler o proximo produto.", "success");
      } else {
        setBarcodeScannerStatus("Codigo nao encontrado: " + code + ". Pode tentar outro.", "error");
      }

      setTimeout(function() {
        barcodeScannerBusy = false;
        if (barcodeScannerStream) {
          barcodeScannerFrame = window.requestAnimationFrame(function() {
            scanBarcodeVideoFrame(detector, video);
          });
        }
      }, BARCODE_SCAN_RESUME_DELAY_MS);
      return;
    }
  } catch (e) {
    console.warn("Erro durante leitura barcode:", e);
  }

  if (barcodeScannerStream) {
    barcodeScannerFrame = window.requestAnimationFrame(function() {
      scanBarcodeVideoFrame(detector, video);
    });
  }
}

function closeBarcodeScanner() {
  var modal = document.getElementById("barcodeScannerModal");
  var video = document.getElementById("barcodeScannerVideo");

  if (barcodeScannerFrame) {
    window.cancelAnimationFrame(barcodeScannerFrame);
    barcodeScannerFrame = null;
  }

  if (barcodeScannerStream) {
    barcodeScannerStream.getTracks().forEach(function(track) {
      track.stop();
    });
    barcodeScannerStream = null;
  }

  if (video) {
    video.pause();
    video.srcObject = null;
  }

  barcodeScannerBusy = false;
  barcodeScannerTarget = null;

  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
}

function getPhoneScannerDeviceName() {
  var ua = String(navigator.userAgent || "");
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone";
  if (/windows/i.test(ua)) return "Windows";
  if (/macintosh|mac os/i.test(ua)) return "Mac";
  return "Caixa";
}

function setPhoneScannerStatus(message, type) {
  var status = document.getElementById("phoneScannerStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("error", type === "error");
}

function renderPhoneScannerCartStrip(lastProduct) {
  var title = document.getElementById("phoneScannerCartTitle");
  var meta = document.getElementById("phoneScannerCartMeta");
  if (!title || !meta) return;

  if (lastProduct && lastProduct.name) {
    title.textContent = "Recebido: " + lastProduct.name;
  } else if (cart && cart.length) {
    title.textContent = "Carrinho actualizado";
  } else {
    title.textContent = "Carrinho vazio";
  }

  meta.textContent = getCartCountMobile() + " produtos | " + fmt(getCartTotalMobile());
}

function buildPhoneScannerUrl(session) {
  var url = new URL("scanner.html", window.location.href);
  url.searchParams.set("session", session.id);
  url.searchParams.set("token", session.session_token);
  return url.toString();
}

function setPhoneScannerQr(url) {
  var qr = document.getElementById("phoneScannerQr");
  var urlBox = document.getElementById("phoneScannerUrl");

  phoneScannerUrl = url || "";

  if (qr) {
    qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=" + encodeURIComponent(phoneScannerUrl);
  }

  if (urlBox) {
    urlBox.textContent = phoneScannerUrl;
    urlBox.title = phoneScannerUrl;
  }
}

function stopPhoneScannerRealtime() {
  if (phoneScannerChannel && supabaseClient && supabaseClient.removeChannel) {
    try {
      supabaseClient.removeChannel(phoneScannerChannel);
    } catch (e) {
      console.warn("Erro ao fechar canal do scanner:", e);
    }
  }

  phoneScannerChannel = null;
}

function hidePhoneScannerModalAfterConnect() {
  var modal = document.getElementById("phoneScannerModal");
  if (phoneScannerModalAutoHidden) return;

  phoneScannerModalAutoHidden = true;

  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  setBarcodeStatus("Telefone conectado. Os produtos lidos vao entrar no carrinho automaticamente.", "success");
  toast("Telefone conectado ao carrinho.", "success");
}

function stopPhoneScannerPolling() {
  if (phoneScannerPollTimer) {
    clearInterval(phoneScannerPollTimer);
    phoneScannerPollTimer = null;
  }
}

async function markPhoneScannerSessionClosed() {
  if (!phoneScannerSession || !phoneScannerSession.id || !supabaseClient) return;

  try {
    await supabaseClient
      .from("pos_scan_sessions")
      .update({ status: "closed", last_seen_at: new Date().toISOString() })
      .eq("id", phoneScannerSession.id);
  } catch (e) {
    console.warn("Sessao scanner nao fechada no servidor:", e);
  }
}

async function handlePhoneScannerEvent(payload) {
  var row = payload && payload.new ? payload.new : payload;
  if (!row || !row.barcode) return;
  if (!phoneScannerSession || String(row.session_id) !== String(phoneScannerSession.id)) return;
  if (row.id && phoneScannerProcessedEvents[row.id]) return;
  if (row.id) phoneScannerProcessedEvents[row.id] = true;

  var code = normalizeBarcodeValue(row.barcode);
  hidePhoneScannerModalAfterConnect();
  setPhoneScannerStatus("Codigo recebido: " + code + ". A adicionar ao carrinho...", "");

  var product = await addProductByBarcode(code, {
    keepInput: true,
    suppressFocus: true
  });

  renderPhoneScannerCartStrip(product);

  try {
    await supabaseClient
      .from("pos_scan_events")
      .update({
        status: product ? "processed" : "error",
        product_name: product && product.name ? product.name : null,
        error_message: product ? null : "Produto nao encontrado",
        processed_at: new Date().toISOString()
      })
      .eq("id", row.id);
  } catch (e) {
    console.warn("Evento scanner nao actualizado:", e);
  }

  if (product) {
    setPhoneScannerStatus("Adicionado pelo telefone: " + product.name, "");
  } else {
    setPhoneScannerStatus("Codigo recebido, mas produto nao encontrado: " + code, "error");
  }
}

async function pollPhoneScannerSession() {
  if (!phoneScannerSession || !phoneScannerSession.id || !supabaseClient) return;

  try {
    var sessionResult = await supabaseClient
      .from("pos_scan_sessions")
      .select("id,status,created_at,last_seen_at,expires_at")
      .eq("id", phoneScannerSession.id)
      .single();

    if (!sessionResult.error && sessionResult.data) {
      var session = sessionResult.data;
      var createdAt = new Date(session.created_at || 0).getTime();
      var lastSeenAt = new Date(session.last_seen_at || 0).getTime();

      if (session.status !== "active" || (session.expires_at && new Date(session.expires_at).getTime() < Date.now())) {
        setBarcodeStatus("Sessao do telefone terminou. Abre uma nova sessao para continuar.", "warning");
        stopPhoneScannerPolling();
        stopPhoneScannerRealtime();
        phoneScannerSession = null;
        return;
      }

      if (lastSeenAt && createdAt && lastSeenAt - createdAt > 400) {
        hidePhoneScannerModalAfterConnect();
      }
    }

    var eventsResult = await supabaseClient
      .from("pos_scan_events")
      .select("id,session_id,barcode,status,created_at")
      .eq("session_id", phoneScannerSession.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20);

    if (eventsResult.error) throw eventsResult.error;

    var rows = Array.isArray(eventsResult.data) ? eventsResult.data : [];
    for (var i = 0; i < rows.length; i++) {
      await handlePhoneScannerEvent(rows[i]);
    }
  } catch (e) {
    console.warn("Polling scanner telefone falhou:", e);
  }
}

function startPhoneScannerPolling() {
  stopPhoneScannerPolling();
  pollPhoneScannerSession();
  phoneScannerPollTimer = setInterval(pollPhoneScannerSession, 850);
}

function startPhoneScannerRealtime(session) {
  if (!supabaseClient || !supabaseClient.channel || !session || !session.id) {
    setPhoneScannerStatus("Realtime indisponivel. Verifica o SQL do scanner.", "error");
    return;
  }

  stopPhoneScannerRealtime();

  phoneScannerChannel = supabaseClient
    .channel("pos-phone-scanner-" + session.id)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "pos_scan_events",
      filter: "session_id=eq." + session.id
    }, handlePhoneScannerEvent)
    .subscribe(function(status) {
      if (status === "SUBSCRIBED") {
        setPhoneScannerStatus("Sessao pronta. Leia o QR code com o telefone.", "");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setPhoneScannerStatus("Ligacao em tempo real instavel. Verifica Supabase Realtime.", "error");
      }
    });
}

async function openPhoneScannerSession() {
  var modal = document.getElementById("phoneScannerModal");
  if (!modal) return;

  if (!supabaseClient) {
    toast("Supabase indisponivel.", "error");
    return;
  }

  var organizationId = getAzulOrganizationId();
  if (!organizationId) return;

  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
  setPhoneScannerStatus("A criar sessao...", "");
  setPhoneScannerQr("");
  renderPhoneScannerCartStrip();

  stopPhoneScannerRealtime();
  stopPhoneScannerPolling();
  phoneScannerModalAutoHidden = false;
  phoneScannerProcessedEvents = {};

  try {
    var userResult = await supabaseClient.auth.getUser();
    var user = userResult && userResult.data ? userResult.data.user : null;

    var result = await supabaseClient
      .from("pos_scan_sessions")
      .insert({
        organization_id: organizationId,
        device_name: getPhoneScannerDeviceName(),
        created_by: user && user.id ? user.id : null,
        status: "active"
      })
      .select("id, session_token, expires_at, created_at, last_seen_at")
      .single();

    if (result.error) throw result.error;

    phoneScannerSession = result.data;
    var scannerUrl = buildPhoneScannerUrl(phoneScannerSession);
    setPhoneScannerQr(scannerUrl);
    startPhoneScannerRealtime(phoneScannerSession);
    startPhoneScannerPolling();
  } catch (e) {
    console.error("Erro sessao scanner telefone:", e);
    setPhoneScannerStatus("Erro ao criar sessao. Executa SQL/pos_phone_scanner.sql no Supabase.", "error");
    toast("Erro scanner telefone: " + (e.message || e), "error");
  }
}

async function closePhoneScannerSession() {
  var modal = document.getElementById("phoneScannerModal");
  stopPhoneScannerRealtime();
  stopPhoneScannerPolling();
  await markPhoneScannerSessionClosed();
  phoneScannerSession = null;
  phoneScannerUrl = "";
  phoneScannerModalAutoHidden = false;
  phoneScannerProcessedEvents = {};

  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
}

async function copyPhoneScannerLink() {
  if (!phoneScannerUrl) {
    toast("Cria primeiro uma sessao de scanner.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(phoneScannerUrl);
    toast("Link copiado.", "success");
  } catch (e) {
    toast("Nao foi possivel copiar. Usa o QR code.", "error");
  }
}

function openPhoneScannerLink() {
  if (!phoneScannerUrl) {
    toast("Cria primeiro uma sessao de scanner.", "error");
    return;
  }
  window.open(phoneScannerUrl, "_blank", "noopener,noreferrer");
}

var onlineStoreSettings = null;
var onlineSelectedProductIds = {};
var onlineStoreLink = "";
var onlineStoreLoading = false;
var onlineOrders = [];
var onlineCurrentTab = "config";

function normalizeOnlinePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeOnlineColor(value) {
  var color = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return "#0b3d91";
}

function getOnlineFontFamily(value) {
  var font = String(value || "").trim();
  var allowed = [
    "Arial, Helvetica, sans-serif",
    "Inter, Arial, sans-serif",
    "Verdana, Geneva, sans-serif",
    "Georgia, serif",
    "Trebuchet MS, Arial, sans-serif"
  ];
  return allowed.indexOf(font) >= 0 ? font : allowed[0];
}

function syncOnlineThemeColorText(value) {
  var color = normalizeOnlineColor(value);
  var colorInput = document.getElementById("online-theme-color");
  if (colorInput && /^#[0-9a-f]{6}$/i.test(String(value || "").trim())) {
    colorInput.value = color;
  }
}

function updateOnlineLogoPreview(value) {
  var preview = document.getElementById("online-logo-preview");
  if (!preview) return;

  var logo = String(value || "").trim();
  preview.innerHTML = "";

  if (logo) {
    var img = document.createElement("img");
    img.src = logo;
    img.alt = "Logo da loja";
    img.onerror = function() {
      preview.textContent = "A";
    };
    preview.appendChild(img);
    return;
  }

  preview.textContent = String((document.getElementById("online-store-name") || {}).value || "Azul").trim().charAt(0).toUpperCase() || "A";
}

function clearOnlineLogo() {
  var input = document.getElementById("online-logo-url");
  var file = document.getElementById("online-logo-file");
  if (input) input.value = "";
  if (file) file.value = "";
  updateOnlineLogoPreview("");
}

function handleOnlineLogoFile(input) {
  var file = input && input.files && input.files[0];
  if (!file) return;

  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type || "")) {
    toast("Escolha uma imagem PNG, JPG ou WebP.", "error");
    input.value = "";
    return;
  }

  if (file.size > 1500 * 1024) {
    toast("Logo muito pesado. Usa uma imagem com menos de 1.5 MB.", "error");
    input.value = "";
    return;
  }

  var reader = new FileReader();
  reader.onload = function(event) {
    var dataUrl = String(event.target && event.target.result || "");
    var logoInput = document.getElementById("online-logo-url");
    if (logoInput) logoInput.value = dataUrl;
    updateOnlineLogoPreview(dataUrl);
    toast("Logo carregado. Clique em Guardar loja.", "success");
  };
  reader.onerror = function() {
    toast("Nao foi possivel carregar a imagem.", "error");
  };
  reader.readAsDataURL(file);
}

function slugifyOnlineStore(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function getDefaultOnlineSlug() {
  var base = localStorage.getItem("azul_organization_name") || config.name || "loja-azul";
  var slug = slugifyOnlineStore(base);
  if (!slug) slug = "loja-azul";
  return slug + "-" + String(getAzulOrganizationId() || "").slice(0, 8);
}

function isOnlineStoreTableMissing(error) {
  var msg = String(error && error.message ? error.message : error || "").toLowerCase();
  return (msg.indexOf("online_store_settings") >= 0 ||
    msg.indexOf("online_orders") >= 0 ||
    msg.indexOf("online_order_items") >= 0 ||
    msg.indexOf("create_online_order") >= 0) &&
    (msg.indexOf("could not find") >= 0 ||
      msg.indexOf("schema cache") >= 0 ||
      msg.indexOf("does not exist") >= 0 ||
      msg.indexOf("relation") >= 0);
}

function refreshOnlineStoreModule() {
  loadOnlineStoreSettings(true);
  if (onlineCurrentTab === "orders") loadOnlineOrders();
}

function switchOnlineTab(tab, btn) {
  onlineCurrentTab = tab || "config";

  ["config", "products", "orders"].forEach(function(name) {
    var panel = document.getElementById("online-panel-" + name);
    var tabBtn = document.getElementById("online-tab-" + name);
    if (panel) panel.style.display = name === onlineCurrentTab ? "" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === onlineCurrentTab);
  });

  if (btn && btn.classList) {
    btn.classList.add("active");
  }

  if (onlineCurrentTab === "products") {
    renderOnlineProductList();
  }

  if (onlineCurrentTab === "orders") {
    loadOnlineOrders();
  }
}

function getOnlineStorePublicUrl(settings) {
  settings = settings || onlineStoreSettings || {};
  var url = new URL("loja.html", window.location.href);
  if (settings.slug) {
    url.searchParams.set("loja", settings.slug);
  } else {
    url.searchParams.set("org", getAzulOrganizationId());
  }
  return url.toString();
}

function setOnlineStoreStatus(message, isError) {
  var el = document.getElementById("online-store-status");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = isError ? "var(--red)" : "var(--muted)";
}

function updateOnlineStoreLink(settings) {
  var linkBox = document.getElementById("online-public-link");
  var qr = document.getElementById("online-store-qr");
  var qrEmpty = document.getElementById("online-qr-empty");

  onlineStoreLink = settings && settings.active ? getOnlineStorePublicUrl(settings) : "";

  if (linkBox) {
    linkBox.textContent = onlineStoreLink || "Ativa e guarda a loja para gerar o link publico.";
    linkBox.title = onlineStoreLink || "";
  }

  if (qr) {
    qr.style.display = onlineStoreLink ? "block" : "none";
    qr.src = onlineStoreLink
      ? "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=12&data=" + encodeURIComponent(onlineStoreLink)
      : "";
  }

  if (qrEmpty) {
    qrEmpty.style.display = onlineStoreLink ? "none" : "block";
  }
}

function applyOnlineStoreForm(settings) {
  settings = settings || {};

  var active = document.getElementById("online-active");
  var storeName = document.getElementById("online-store-name");
  var whatsapp = document.getElementById("online-whatsapp");
  var slug = document.getElementById("online-slug");
  var heroTitle = document.getElementById("online-hero-title");
  var message = document.getElementById("online-message");
  var themeColor = document.getElementById("online-theme-color");
  var themeColorText = document.getElementById("online-theme-color-text");
  var fontFamily = document.getElementById("online-font-family");
  var logoUrl = document.getElementById("online-logo-url");
  var showStock = document.getElementById("online-show-stock");
  var color = normalizeOnlineColor(settings.theme_color);

  if (active) active.checked = !!settings.active;
  if (storeName) storeName.value = settings.store_name || config.name || localStorage.getItem("azul_organization_name") || "Azul";
  if (whatsapp) whatsapp.value = settings.whatsapp_phone || config.phone || "";
  if (slug) slug.value = settings.slug || getDefaultOnlineSlug();
  if (heroTitle) heroTitle.value = settings.hero_title || "Escolha os produtos";
  if (message) message.value = settings.welcome_message || "Ola, quero comprar estes produtos:";
  if (themeColor) themeColor.value = color;
  if (themeColorText) themeColorText.value = color;
  if (fontFamily) fontFamily.value = getOnlineFontFamily(settings.font_family);
  if (logoUrl) logoUrl.value = settings.logo_url || config.logo || "";
  updateOnlineLogoPreview(logoUrl ? logoUrl.value : "");
  if (showStock) showStock.checked = settings.show_stock !== false;

  onlineSelectedProductIds = {};
  (Array.isArray(settings.product_ids) ? settings.product_ids : []).forEach(function(id) {
    onlineSelectedProductIds[String(id)] = true;
  });

  updateOnlineStoreLink(settings);
}

function collectSelectedOnlineProductIds() {
  var ids = [];
  document.querySelectorAll(".online-product-check").forEach(function(input) {
    if (input.checked && input.value) ids.push(input.value);
  });
  return ids;
}

function renderOnlineProductList() {
  var list = document.getElementById("online-products-list");
  if (!list) return;

  var q = String((document.getElementById("online-product-search") || {}).value || "").trim().toLowerCase();
  var source = products || [];
  var rows = q ? source.filter(function(product) {
    return productSearchText(product).indexOf(q) >= 0;
  }) : source;

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhum produto encontrado.</div>';
    return;
  }

  list.innerHTML = rows.map(function(product) {
    var id = String(product.id || "");
    var checked = onlineSelectedProductIds[id] ? " checked" : "";
    var safeName = escapeDespesaHtml(product.name || "");
    var safePhoto = escapeDespesaHtml(product.photo || "");
    var img = safePhoto
      ? '<img src="' + safePhoto + '" alt="' + safeName + '">'
      : '<div class="online-product-placeholder">' + escapeDespesaHtml(String(product.name || "A").charAt(0).toUpperCase()) + '</div>';

    return '<label class="online-product-card">' +
      img +
      '<span class="online-product-info">' +
        '<strong title="' + safeName + '">' + safeName + '</strong>' +
        '<span>' + fmt(product.salePrice || product.price || 0) + '</span>' +
        '<small>' + escapeDespesaHtml(product.category || "Sem categoria") + ' | Loja: ' + (Number(product.stockBoutique) || 0) + '</small>' +
      '</span>' +
      '<input class="online-product-check" type="checkbox" value="' + escapeDespesaHtml(id) + '"' + checked + ' onchange="syncOnlineProductSelection(this)">' +
    '</label>';
  }).join("");
}

function syncOnlineProductSelection(input) {
  if (!input || !input.value) return;
  if (input.checked) onlineSelectedProductIds[String(input.value)] = true;
  else delete onlineSelectedProductIds[String(input.value)];
}

function selectAllOnlineProducts(select) {
  (products || []).forEach(function(product) {
    if (!product || !product.id) return;
    if (select) onlineSelectedProductIds[String(product.id)] = true;
    else delete onlineSelectedProductIds[String(product.id)];
  });
  renderOnlineProductList();
}

async function loadOnlineStoreSettings(forceRefresh) {
  if (onlineStoreLoading && !forceRefresh) return;
  onlineStoreLoading = true;
  setOnlineStoreStatus("A carregar loja online...", false);

  try {
    if (!products || !products.length || forceRefresh) {
      await loadProducts(forceRefresh);
    }

    var organizationId = getAzulOrganizationId();
    var result = await supabaseClient
      .from("online_store_settings")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (result.error) throw result.error;

    onlineStoreSettings = result.data || {
      organization_id: organizationId,
      active: false,
      slug: getDefaultOnlineSlug(),
      whatsapp_phone: config.phone || "",
      store_name: config.name || localStorage.getItem("azul_organization_name") || "Azul",
      hero_title: "Escolha os produtos",
      welcome_message: "Ola, quero comprar estes produtos:",
      theme_color: "#0b3d91",
      font_family: "Arial, Helvetica, sans-serif",
      logo_url: config.logo || "",
      show_stock: true,
      product_ids: []
    };

    applyOnlineStoreForm(onlineStoreSettings);
    renderOnlineProductList();
    setOnlineStoreStatus(onlineStoreSettings.active ? "Loja online ativa." : "Loja online desativada.", false);
    if (onlineCurrentTab === "orders") loadOnlineOrders();
  } catch (e) {
    console.error("Erro loja online:", e);
    if (isOnlineStoreTableMissing(e)) {
      setOnlineStoreStatus("Executa SQL/online_store.sql no Supabase antes de usar este modulo.", true);
    } else {
      setOnlineStoreStatus("Erro loja online: " + (e.message || e), true);
    }
  } finally {
    onlineStoreLoading = false;
  }
}

async function saveOnlineStoreSettings() {
  var organizationId = getAzulOrganizationId();
  if (!organizationId) return;

  var active = !!((document.getElementById("online-active") || {}).checked);
  var phone = normalizeOnlinePhone((document.getElementById("online-whatsapp") || {}).value);
  var slug = slugifyOnlineStore((document.getElementById("online-slug") || {}).value) || getDefaultOnlineSlug();
  var productIds = collectSelectedOnlineProductIds();

  if (active && !phone) {
    toast("Informe o numero WhatsApp antes de ativar a loja.", "error");
    return;
  }

  if (active && !productIds.length) {
    toast("Seleciona pelo menos um produto para publicar.", "error");
    return;
  }

  var payload = {
    organization_id: organizationId,
    active: active,
    slug: slug,
    whatsapp_phone: phone,
    store_name: String((document.getElementById("online-store-name") || {}).value || config.name || "Azul").trim(),
    hero_title: String((document.getElementById("online-hero-title") || {}).value || "Escolha os produtos").trim(),
    welcome_message: String((document.getElementById("online-message") || {}).value || "Ola, quero comprar estes produtos:").trim(),
    theme_color: normalizeOnlineColor((document.getElementById("online-theme-color-text") || {}).value || (document.getElementById("online-theme-color") || {}).value),
    font_family: getOnlineFontFamily((document.getElementById("online-font-family") || {}).value),
    logo_url: String((document.getElementById("online-logo-url") || {}).value || "").trim(),
    show_stock: !!((document.getElementById("online-show-stock") || {}).checked),
    product_ids: productIds
  };

  try {
    var result = await supabaseClient
      .from("online_store_settings")
      .upsert(payload, { onConflict: "organization_id" })
      .select()
      .single();

    if (result.error) throw result.error;

    onlineStoreSettings = result.data;
    applyOnlineStoreForm(onlineStoreSettings);
    renderOnlineProductList();
    try {
      localStorage.setItem("azul_online_store_updated", JSON.stringify({
        organization_id: organizationId,
        slug: onlineStoreSettings.slug || "",
        at: Date.now()
      }));
    } catch (storageError) {}
    setOnlineStoreStatus(active ? "Loja online guardada e ativa." : "Loja online guardada, mas desativada.", false);
    toast("Loja online guardada.", "success");
  } catch (e) {
    console.error("Erro guardar loja online:", e);
    toast("Erro loja online: " + (e.message || e), "error");
    if (isOnlineStoreTableMissing(e)) {
      setOnlineStoreStatus("Executa SQL/online_store.sql no Supabase.", true);
    }
  }
}

async function copyOnlineStoreLink() {
  if (!onlineStoreLink) {
    toast("Ativa e guarda a loja primeiro.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(onlineStoreLink);
    toast("Link da loja copiado.", "success");
  } catch (e) {
    toast("Nao foi possivel copiar o link.", "error");
  }
}

function openOnlineStoreLink() {
  if (!onlineStoreLink) {
    toast("Ativa e guarda a loja primeiro.", "error");
    return;
  }
  window.open(onlineStoreLink, "_blank", "noopener,noreferrer");
}

function getOnlineOrderStatusLabel(status) {
  var labels = {
    pending: "Pendente",
    confirmed: "Confirmada",
    planned: "Planeada",
    preparing: "Em preparacao",
    delivered: "Entregue",
    canceled: "Cancelada"
  };
  return labels[status] || status || "Pendente";
}

function formatOnlineOrderDate(value) {
  if (!value) return "";
  var date = new Date(value);
  if (isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleString("pt-AO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatOnlineOrderDateTimeInput(value) {
  if (!value) return "";
  var date = new Date(value);
  if (isNaN(date.getTime())) return "";
  var offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getOnlineOrderScheduleState(order) {
  if (!order || !order.scheduled_for || order.status === "delivered" || order.status === "canceled") {
    return "";
  }

  var scheduled = new Date(order.scheduled_for);
  if (isNaN(scheduled.getTime())) return "";

  var now = new Date();
  if (scheduled.getTime() < now.getTime()) return "overdue";

  var sameDay = scheduled.getFullYear() === now.getFullYear() &&
    scheduled.getMonth() === now.getMonth() &&
    scheduled.getDate() === now.getDate();

  if (sameDay) return "today";
  return "planned";
}

function isOnlineOrderReminderDue(order) {
  if (!order || !order.scheduled_for || order.reminder_sent_at) return false;
  if (order.status === "delivered" || order.status === "canceled") return false;

  var scheduled = new Date(order.scheduled_for);
  if (isNaN(scheduled.getTime())) return false;

  var before = Number(order.reminder_before_minutes);
  if (!isFinite(before) || before < 0) before = 60;

  return Date.now() >= scheduled.getTime() - before * 60000;
}

function getOnlineOrderScheduleLabel(order) {
  if (!order || !order.scheduled_for) return "Nao planeada";

  var state = getOnlineOrderScheduleState(order);
  var prefix = "Planeada para ";
  if (state === "overdue") prefix = "Atrasada desde ";
  if (state === "today") prefix = "Hoje as ";

  return prefix + formatOnlineOrderDate(order.scheduled_for);
}

function getOnlineOrderItems(order) {
  var items = order && order.online_order_items;
  return Array.isArray(items) ? items : [];
}

function renderOnlineOrderKpis() {
  var pending = 0;
  var planned = 0;
  var overdue = 0;

  onlineOrders.forEach(function(order) {
    if (order.status === "pending") {
      pending++;
    }
    if (order.scheduled_for && order.status !== "delivered" && order.status !== "canceled") planned++;
    if (getOnlineOrderScheduleState(order) === "overdue") overdue++;
  });

  var pendingEl = document.getElementById("online-orders-pending");
  var plannedEl = document.getElementById("online-orders-planned");
  var overdueEl = document.getElementById("online-orders-overdue");
  var countEl = document.getElementById("online-orders-count");

  if (pendingEl) pendingEl.textContent = String(pending);
  if (plannedEl) plannedEl.textContent = String(planned);
  if (overdueEl) overdueEl.textContent = String(overdue);
  if (countEl) countEl.textContent = String(onlineOrders.length);
}

function renderOnlineOrders() {
  var list = document.getElementById("online-orders-list");
  if (!list) return;

  renderOnlineOrderKpis();

  var filter = String((document.getElementById("online-order-status-filter") || {}).value || "");
  var rows = filter ? onlineOrders.filter(function(order) {
    return order.status === filter;
  }) : onlineOrders;

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma encomenda online encontrada.</div>';
    return;
  }

  list.innerHTML = rows.map(function(order) {
    var items = getOnlineOrderItems(order);
    var itemText = items.map(function(item) {
      return escapeDespesaHtml(item.product_name || "Produto") +
        " x" + (Number(item.quantity) || 0);
    }).join(" | ");
    var phone = normalizeOnlinePhone(order.customer_phone || "");
    var waLink = phone ? "https://wa.me/" + phone : "";
    var scheduleState = getOnlineOrderScheduleState(order);
    var priority = order.priority === "urgent" ? "Urgente" : "Normal";

    return '<article class="online-order-card ' + (scheduleState ? 'schedule-' + scheduleState : '') + '">' +
      '<div class="online-order-main">' +
        '<div class="online-order-title">' +
          '<strong>' + escapeDespesaHtml(order.order_number || "Encomenda") + '</strong>' +
          '<span class="online-order-status">' + escapeDespesaHtml(getOnlineOrderStatusLabel(order.status)) + '</span>' +
          '<span class="online-order-priority">' + escapeDespesaHtml(priority) + '</span>' +
        '</div>' +
        '<div class="online-order-meta">' +
          escapeDespesaHtml(order.customer_name || "Cliente") + ' | ' +
          escapeDespesaHtml(order.customer_phone || "") + '<br>' +
          escapeDespesaHtml(order.customer_address || "") + '<br>' +
          escapeDespesaHtml(formatOnlineOrderDate(order.created_at || order.createdAt || "")) +
        '</div>' +
        '<div class="online-order-schedule ' + (scheduleState ? 'is-' + scheduleState : '') + '">' +
          escapeDespesaHtml(getOnlineOrderScheduleLabel(order)) +
          (order.delivery_note ? '<br><small>' + escapeDespesaHtml(order.delivery_note) + '</small>' : '') +
        '</div>' +
        '<div class="online-order-items">' + (itemText || "Sem itens") + '</div>' +
      '</div>' +
      '<div class="online-order-total">' + fmt(order.total || 0) + '</div>' +
      renderOnlineOrderPlanForm(order) +
      '<div class="online-order-actions">' +
        (waLink ? '<a href="' + waLink + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' : '') +
        renderOnlineOrderStatusButtons(order) +
      '</div>' +
    '</article>';
  }).join("");
}

function renderOnlineOrderPlanForm(order) {
  var id = escapeDespesaHtml(order.id || "");
  var dateValue = escapeDespesaHtml(formatOnlineOrderDateTimeInput(order.scheduled_for));
  var note = escapeDespesaHtml(order.delivery_note || "");
  var reminder = Number(order.reminder_before_minutes);
  if (!isFinite(reminder) || reminder < 0) reminder = 60;
  var priority = order.priority || "normal";

  function selected(value, current) {
    return String(value) === String(current) ? " selected" : "";
  }

  return '<div class="online-order-plan">' +
    '<div class="online-plan-field">' +
      '<label>Data prevista</label>' +
      '<input type="datetime-local" id="online-schedule-' + id + '" value="' + dateValue + '">' +
    '</div>' +
    '<div class="online-plan-field">' +
      '<label>Avisar antes</label>' +
      '<select id="online-reminder-' + id + '">' +
        '<option value="30"' + selected(30, reminder) + '>30 min</option>' +
        '<option value="60"' + selected(60, reminder) + '>1 hora</option>' +
        '<option value="180"' + selected(180, reminder) + '>3 horas</option>' +
        '<option value="1440"' + selected(1440, reminder) + '>1 dia</option>' +
      '</select>' +
    '</div>' +
    '<div class="online-plan-field">' +
      '<label>Prioridade</label>' +
      '<select id="online-priority-' + id + '">' +
        '<option value="normal"' + selected("normal", priority) + '>Normal</option>' +
        '<option value="urgent"' + selected("urgent", priority) + '>Urgente</option>' +
      '</select>' +
    '</div>' +
    '<div class="online-plan-field online-plan-note">' +
      '<label>Nota interna</label>' +
      '<input type="text" id="online-note-' + id + '" value="' + note + '" placeholder="Ex: preparar antes das 10h">' +
    '</div>' +
    '<button type="button" class="primary" onclick="saveOnlineOrderPlan(\'' + id + '\')">Planear</button>' +
  '</div>';
}

function renderOnlineOrderStatusButtons(order) {
  var id = escapeDespesaHtml(order.id || "");
  var status = order.status || "pending";
  var html = "";

  if (status === "pending") {
    html += '<button type="button" class="primary" onclick="updateOnlineOrderStatus(\'' + id + '\', \'confirmed\')">Confirmar</button>';
  }
  if (status === "pending" || status === "confirmed" || status === "planned") {
    html += '<button type="button" onclick="updateOnlineOrderStatus(\'' + id + '\', \'preparing\')">Preparar</button>';
  }
  if (status !== "delivered" && status !== "canceled") {
    html += '<button type="button" onclick="sendOnlineOrderToLogistics(\'' + id + '\')">Logistica</button>';
    html += '<button type="button" class="primary" onclick="updateOnlineOrderStatus(\'' + id + '\', \'delivered\')">Entregue</button>';
    html += '<button type="button" class="danger" onclick="updateOnlineOrderStatus(\'' + id + '\', \'canceled\')">Cancelar</button>';
  }

  return html || '<button type="button" onclick="updateOnlineOrderStatus(\'' + id + '\', \'pending\')">Reabrir</button>';
}

async function loadOnlineOrders() {
  var list = document.getElementById("online-orders-list");
  if (list) list.innerHTML = '<div class="empty">A carregar encomendas...</div>';

  try {
    var organizationId = getAzulOrganizationId();
    if (!organizationId) return;

    var result = await supabaseClient
      .from("online_orders")
      .select("*, online_order_items(*)")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (result.error) throw result.error;

    onlineOrders = result.data || [];
    renderOnlineOrders();
    checkOnlineOrderReminders(true);
  } catch (e) {
    console.error("Erro encomendas online:", e);
    if (list) {
      list.innerHTML = '<div class="empty">Erro ao carregar encomendas. Executa SQL/online_store.sql no Supabase.</div>';
    }
  }
}

async function saveOnlineOrderPlan(orderId) {
  if (!orderId) return;

  var scheduleInput = document.getElementById("online-schedule-" + orderId);
  var reminderInput = document.getElementById("online-reminder-" + orderId);
  var priorityInput = document.getElementById("online-priority-" + orderId);
  var noteInput = document.getElementById("online-note-" + orderId);
  var scheduleValue = String(scheduleInput && scheduleInput.value || "").trim();

  if (!scheduleValue) {
    toast("Escolha a data prevista da encomenda.", "error");
    return;
  }

  var scheduled = new Date(scheduleValue);
  if (isNaN(scheduled.getTime())) {
    toast("Data prevista invalida.", "error");
    return;
  }

  var payload = {
    scheduled_for: scheduled.toISOString(),
    reminder_before_minutes: Math.max(0, Number(reminderInput && reminderInput.value) || 60),
    reminder_sent_at: null,
    delivery_note: String(noteInput && noteInput.value || "").trim(),
    priority: priorityInput && priorityInput.value === "urgent" ? "urgent" : "normal",
    status: "planned"
  };

  try {
    var result = await supabaseClient
      .from("online_orders")
      .update(payload)
      .eq("id", orderId)
      .select()
      .single();

    if (result.error) throw result.error;

    toast("Encomenda planeada.", "success");
    await loadOnlineOrders();
  } catch (e) {
    console.error("Erro planear encomenda:", e);
    toast("Erro planear: " + (e.message || e), "error");
  }
}

async function updateOnlineOrderStatus(orderId, status) {
  if (!orderId || !status) return;

  try {
    var result = await supabaseClient
      .from("online_orders")
      .update({ status: status })
      .eq("id", orderId)
      .select()
      .single();

    if (result.error) throw result.error;

    toast("Estado da encomenda atualizado.", "success");
    await loadOnlineOrders();
  } catch (e) {
    console.error("Erro atualizar encomenda:", e);
    toast("Erro encomenda: " + (e.message || e), "error");
  }
}

async function checkOnlineOrderReminders(silent) {
  try {
    var organizationId = getAzulOrganizationId();
    if (!organizationId || typeof createAzulNotification !== "function") return;

    var result = await supabaseClient
      .from("online_orders")
      .select("id, order_number, customer_name, scheduled_for, reminder_before_minutes, reminder_sent_at, status")
      .eq("organization_id", organizationId)
      .not("scheduled_for", "is", null)
      .is("reminder_sent_at", null)
      .in("status", ["confirmed", "planned", "preparing"])
      .limit(50);

    if (result.error) throw result.error;

    var dueRows = (result.data || []).filter(isOnlineOrderReminderDue);
    for (var i = 0; i < dueRows.length; i++) {
      var order = dueRows[i];
      var state = getOnlineOrderScheduleState(order);
      await createAzulNotification({
        actionType: "online_order:reminder",
        title: state === "overdue" ? "Encomenda atrasada" : "Encomenda perto do prazo",
        message: (order.customer_name || "Cliente") + " - " + (order.order_number || "encomenda") + " - " + formatOnlineOrderDate(order.scheduled_for),
        sourceType: "online_order",
        sourceId: order.id || null,
        targetRoles: ["owner", "manager"],
        details: {
          scheduled_for: order.scheduled_for,
          reminder_before_minutes: order.reminder_before_minutes || 60
        }
      });

      await supabaseClient
        .from("online_orders")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", order.id);
    }

    if (!silent && dueRows.length) toast("Alertas de encomenda enviados.", "success");
  } catch (e) {
    console.warn("Erro alertas encomendas:", e);
  }
}

var logisticsDeliveries = [];
var logisticsCurrentTab = "new";
var logisticsLoading = false;

function isLogisticsTableMissing(error) {
  var msg = String(error && error.message ? error.message : error || "").toLowerCase();
  return msg.indexOf("deliveries") >= 0 &&
    (msg.indexOf("could not find") >= 0 ||
      msg.indexOf("schema cache") >= 0 ||
      msg.indexOf("does not exist") >= 0 ||
      msg.indexOf("relation") >= 0);
}

function setLogisticsStatus(message, isError) {
  var el = document.getElementById("logistics-status");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = isError ? "var(--red)" : "var(--muted)";
}

function generateLogisticsNumber() {
  var now = new Date();
  var stamp = now.toISOString().slice(2, 10).replace(/-/g, "") + "-" +
    now.toTimeString().slice(0, 8).replace(/:/g, "");
  return "ENT-" + stamp + "-" + Math.random().toString(16).slice(2, 6).toUpperCase();
}

function getLogisticsStatusLabel(status) {
  var labels = {
    pending: "Pendente",
    scheduled: "Agendada",
    ready: "Pronta",
    in_route: "Em rota",
    delivered: "Entregue",
    failed: "Falhada",
    canceled: "Cancelada"
  };
  return labels[status] || status || "Pendente";
}

function formatLogisticsDate(value) {
  return formatOnlineOrderDate(value);
}

function formatLogisticsDateTimeInput(value) {
  return formatOnlineOrderDateTimeInput(value);
}

function getLogisticsScheduleState(row) {
  if (!row || !row.scheduled_for || row.status === "delivered" || row.status === "canceled" || row.status === "failed") return "";
  var scheduled = new Date(row.scheduled_for);
  if (isNaN(scheduled.getTime())) return "";
  var now = new Date();
  if (scheduled.getTime() < now.getTime()) return "overdue";
  var sameDay = scheduled.getFullYear() === now.getFullYear() &&
    scheduled.getMonth() === now.getMonth() &&
    scheduled.getDate() === now.getDate();
  return sameDay ? "today" : "planned";
}

function isLogisticsReminderDue(row) {
  if (!row || !row.scheduled_for || row.reminder_sent_at) return false;
  if (row.status === "delivered" || row.status === "canceled" || row.status === "failed") return false;
  var scheduled = new Date(row.scheduled_for);
  if (isNaN(scheduled.getTime())) return false;
  var before = Number(row.reminder_before_minutes);
  if (!isFinite(before) || before < 0) before = 60;
  return Date.now() >= scheduled.getTime() - before * 60000;
}

function normalizeLogisticsPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildLogisticsDescriptionFromOrder(order) {
  var items = getOnlineOrderItems(order);
  if (!items.length) return order && order.order_number ? "Encomenda " + order.order_number : "Encomenda online";
  return items.map(function(item) {
    return (item.product_name || "Produto") + " x" + (Number(item.quantity) || 0);
  }).join(" | ");
}

function getLogisticsOpenStatuses() {
  return ["pending", "scheduled", "ready", "in_route"];
}

function setDefaultLogisticsDate() {
  var input = document.getElementById("log-date");
  if (!input || input.value) return;
  var date = new Date(Date.now() + 60 * 60000);
  input.value = formatLogisticsDateTimeInput(date.toISOString());
}

function initLogisticaPage() {
  setDefaultLogisticsDate();
  switchLogisticsTab(logisticsCurrentTab || "new", document.getElementById("log-tab-" + (logisticsCurrentTab || "new")));
  loadLogisticsDeliveries(false);
}

function switchLogisticsTab(tab, btn) {
  logisticsCurrentTab = tab || "new";
  ["new", "panel", "list"].forEach(function(name) {
    var panel = document.getElementById("log-panel-" + name);
    var tabBtn = document.getElementById("log-tab-" + name);
    if (panel) panel.style.display = name === logisticsCurrentTab ? "" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === logisticsCurrentTab);
  });
  if (btn && btn.classList) btn.classList.add("active");
  if (logisticsCurrentTab === "panel" || logisticsCurrentTab === "list") renderLogisticsDeliveries();
}

function collectLogisticsFormPayload(source) {
  source = source || {};
  var organizationId = getAzulOrganizationId();
  var hasSourceSchedule = Object.prototype.hasOwnProperty.call(source, "scheduled_for");
  var scheduleValue = hasSourceSchedule ? source.scheduled_for : String((document.getElementById("log-date") || {}).value || "").trim();
  var scheduledIso = null;

  if (scheduleValue) {
    var scheduled = new Date(scheduleValue);
    if (isNaN(scheduled.getTime())) {
      throw new Error("Data prevista invalida.");
    }
    scheduledIso = scheduled.toISOString();
  }

  var customerName = source.customer_name || String((document.getElementById("log-customer") || {}).value || "").trim();
  var customerAddress = source.customer_address || String((document.getElementById("log-address") || {}).value || "").trim();
  var phone = source.customer_phone || String((document.getElementById("log-phone") || {}).value || "").trim();
  var description = source.description || String((document.getElementById("log-description") || {}).value || "").trim();

  if (!organizationId) throw new Error("Organizacao invalida. Entre novamente.");
  if (!customerName) throw new Error("Informe o nome do cliente.");
  if (!customerAddress) throw new Error("Informe o endereco de entrega.");

  return {
    organization_id: organizationId,
    delivery_number: source.delivery_number || generateLogisticsNumber(),
    source_type: source.source_type || "manual",
    source_id: source.source_id || null,
    customer_name: customerName,
    customer_phone: phone,
    customer_address: customerAddress,
    description: description,
    amount: Number(source.amount != null ? source.amount : (document.getElementById("log-amount") || {}).value) || 0,
    delivery_fee: Number(source.delivery_fee != null ? source.delivery_fee : (document.getElementById("log-fee") || {}).value) || 0,
    scheduled_for: scheduledIso,
    reminder_before_minutes: Math.max(0, Number(source.reminder_before_minutes != null ? source.reminder_before_minutes : (document.getElementById("log-reminder") || {}).value) || 60),
    reminder_sent_at: null,
    driver_name: source.driver_name || String((document.getElementById("log-driver") || {}).value || "").trim(),
    status: source.status || (scheduledIso ? "scheduled" : "pending"),
    priority: source.priority || (((document.getElementById("log-priority") || {}).value === "urgent") ? "urgent" : "normal"),
    note: source.note || String((document.getElementById("log-note") || {}).value || "").trim()
  };
}

function resetLogisticsForm() {
  ["log-customer", "log-phone", "log-address", "log-description", "log-driver", "log-note"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = "";
  });
  var amount = document.getElementById("log-amount");
  var fee = document.getElementById("log-fee");
  var priority = document.getElementById("log-priority");
  var reminder = document.getElementById("log-reminder");
  var date = document.getElementById("log-date");
  if (amount) amount.value = "0";
  if (fee) fee.value = "0";
  if (priority) priority.value = "normal";
  if (reminder) reminder.value = "60";
  if (date) date.value = "";
  setDefaultLogisticsDate();
}

async function createManualLogisticsDelivery() {
  if (!requireAzulAction("logistics:create", "criar entrega")) return;

  try {
    var payload = collectLogisticsFormPayload();
    var result = await insertSingleWithAzulAudit("deliveries", payload);
    if (result.error) throw result.error;

    resetLogisticsForm();
    setLogisticsStatus("Entrega criada.", false);
    toast("Entrega criada.", "success");
    await loadLogisticsDeliveries(true);
    switchLogisticsTab("list", document.getElementById("log-tab-list"));
  } catch (e) {
    console.error("Erro criar entrega:", e);
    var msg = isLogisticsTableMissing(e) ? "Executa SQL/logistics_module.sql no Supabase antes de usar Logistica." : (e.message || e);
    setLogisticsStatus(msg, true);
    toast("Erro logistica: " + msg, "error");
  }
}

async function sendOnlineOrderToLogistics(orderId) {
  if (!requireAzulAction("logistics:create", "enviar para logistica")) return;
  var order = (onlineOrders || []).find(function(item) { return String(item.id) === String(orderId); });
  if (!order) {
    toast("Encomenda nao encontrada.", "error");
    return;
  }

  try {
    var existing = await supabaseClient
      .from("deliveries")
      .select("id, delivery_number")
      .eq("organization_id", getAzulOrganizationId())
      .eq("source_type", "online_order")
      .eq("source_id", orderId)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (existing.data) {
      toast("Esta encomenda ja esta na logistica: " + existing.data.delivery_number, "success");
      openLogisticsFromOnline();
      return;
    }

    var payload = collectLogisticsFormPayload({
      source_type: "online_order",
      source_id: order.id,
      customer_name: order.customer_name || "Cliente",
      customer_phone: order.customer_phone || "",
      customer_address: order.customer_address || "Endereco nao informado",
      description: buildLogisticsDescriptionFromOrder(order),
      amount: Number(order.total) || 0,
      delivery_fee: 0,
      scheduled_for: order.scheduled_for || null,
      reminder_before_minutes: Number(order.reminder_before_minutes) || 60,
      priority: order.priority || "normal",
      status: order.scheduled_for ? "scheduled" : "pending",
      note: order.delivery_note || "Criada a partir da Venda Online"
    });

    var result = await insertSingleWithAzulAudit("deliveries", payload);
    if (result.error) throw result.error;

    toast("Encomenda enviada para logistica.", "success");
    await updateOnlineOrderStatus(orderId, order.scheduled_for ? "planned" : "confirmed");
    await loadLogisticsDeliveries(true);
    openLogisticsFromOnline();
  } catch (e) {
    console.error("Erro enviar logistica:", e);
    toast("Erro logistica: " + (isLogisticsTableMissing(e) ? "Executa SQL/logistics_module.sql no Supabase." : (e.message || e)), "error");
  }
}

function openLogisticsFromOnline() {
  var tab = Array.prototype.find.call(document.querySelectorAll(".nav .tab"), function(btn) {
    return String(btn.getAttribute("onclick") || "").indexOf("logistica") >= 0;
  });
  goTo("logistica", tab);
  switchLogisticsTab("list", document.getElementById("log-tab-list"));
}

async function loadLogisticsDeliveries(force) {
  if (logisticsLoading && !force) return;
  logisticsLoading = true;

  var list = document.getElementById("logistics-list");
  var priority = document.getElementById("logistics-priority-list");
  if (list && !logisticsDeliveries.length) list.innerHTML = '<div class="empty">A carregar entregas...</div>';
  if (priority && !logisticsDeliveries.length) priority.innerHTML = '<div class="empty">A carregar entregas...</div>';

  try {
    var organizationId = getAzulOrganizationId();
    if (!organizationId) return;

    var result = await supabaseClient
      .from("deliveries")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(250);

    if (result.error) throw result.error;

    logisticsDeliveries = result.data || [];
    renderLogisticsDeliveries();
    checkLogisticsReminders(true);
    setLogisticsStatus(logisticsDeliveries.length ? "Logistica atualizada." : "Nenhuma entrega criada.", false);
  } catch (e) {
    console.error("Erro logistica:", e);
    var msg = isLogisticsTableMissing(e) ? "Executa SQL/logistics_module.sql no Supabase para ativar o modulo." : "Erro ao carregar entregas: " + (e.message || e);
    if (list) list.innerHTML = '<div class="empty">' + escapeDespesaHtml(msg) + '</div>';
    if (priority) priority.innerHTML = '<div class="empty">' + escapeDespesaHtml(msg) + '</div>';
    setLogisticsStatus(msg, true);
  } finally {
    logisticsLoading = false;
  }
}

function renderLogisticsKpis() {
  var openStatuses = getLogisticsOpenStatuses();
  var open = 0;
  var today = 0;
  var overdue = 0;
  var route = 0;

  logisticsDeliveries.forEach(function(row) {
    var state = getLogisticsScheduleState(row);
    if (openStatuses.indexOf(row.status) >= 0) open++;
    if (state === "today") today++;
    if (state === "overdue") overdue++;
    if (row.status === "in_route") route++;
  });

  var openEl = document.getElementById("log-kpi-open");
  var todayEl = document.getElementById("log-kpi-today");
  var overdueEl = document.getElementById("log-kpi-overdue");
  var routeEl = document.getElementById("log-kpi-route");
  if (openEl) openEl.textContent = String(open);
  if (todayEl) todayEl.textContent = String(today);
  if (overdueEl) overdueEl.textContent = String(overdue);
  if (routeEl) routeEl.textContent = String(route);
}

function filterLogisticsRows(rows) {
  var query = String((document.getElementById("log-search") || {}).value || "").trim().toLowerCase();
  var status = String((document.getElementById("log-status-filter") || {}).value || "");
  var dateFilter = String((document.getElementById("log-date-filter") || {}).value || "");

  return (rows || []).filter(function(row) {
    if (status && row.status !== status) return false;
    var state = getLogisticsScheduleState(row);
    if (dateFilter === "today" && state !== "today") return false;
    if (dateFilter === "overdue" && state !== "overdue") return false;
    if (!query) return true;

    var text = [
      row.delivery_number,
      row.customer_name,
      row.customer_phone,
      row.customer_address,
      row.description,
      row.driver_name,
      row.status
    ].join(" ").toLowerCase();
    return text.indexOf(query) >= 0;
  });
}

function renderLogisticsDeliveries() {
  renderLogisticsKpis();
  renderLogisticsPriorityList();

  var list = document.getElementById("logistics-list");
  if (!list) return;

  var rows = filterLogisticsRows(logisticsDeliveries);
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma entrega encontrada.</div>';
    return;
  }

  list.innerHTML = rows.map(renderLogisticsCard).join("");
}

function renderLogisticsPriorityList() {
  var list = document.getElementById("logistics-priority-list");
  if (!list) return;

  var rows = (logisticsDeliveries || []).filter(function(row) {
    return getLogisticsOpenStatuses().indexOf(row.status) >= 0;
  }).sort(function(a, b) {
    var aState = getLogisticsScheduleState(a) === "overdue" ? 0 : getLogisticsScheduleState(a) === "today" ? 1 : 2;
    var bState = getLogisticsScheduleState(b) === "overdue" ? 0 : getLogisticsScheduleState(b) === "today" ? 1 : 2;
    if (aState !== bState) return aState - bState;
    return new Date(a.scheduled_for || a.created_at || 0).getTime() - new Date(b.scheduled_for || b.created_at || 0).getTime();
  }).slice(0, 8);

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma entrega aberta.</div>';
    return;
  }

  list.innerHTML = rows.map(renderLogisticsCard).join("");
}

function renderLogisticsCard(row) {
  var id = escapeDespesaHtml(row.id || "");
  var status = escapeDespesaHtml(getLogisticsStatusLabel(row.status));
  var state = getLogisticsScheduleState(row);
  var priority = row.priority === "urgent" ? "Urgente" : "Normal";
  var phone = normalizeLogisticsPhone(row.customer_phone || "");
  var wa = phone ? "https://wa.me/" + phone : "";
  var total = Number(row.amount || 0) + Number(row.delivery_fee || 0);
  var schedule = row.scheduled_for ? formatLogisticsDate(row.scheduled_for) : "Sem data prevista";
  var source = row.source_type === "online_order" ? "Venda Online" : "Manual";

  return '<article class="logistics-delivery-card ' + (state ? 'schedule-' + state : '') + '">' +
    '<div class="logistics-delivery-main">' +
      '<div class="logistics-delivery-title">' +
        '<strong title="' + escapeDespesaHtml(row.delivery_number || "") + '">' + escapeDespesaHtml(row.delivery_number || "Entrega") + '</strong>' +
        '<span class="online-order-status">' + status + '</span>' +
        '<span class="online-order-priority">' + escapeDespesaHtml(priority) + '</span>' +
        '<span class="logistics-source">' + escapeDespesaHtml(source) + '</span>' +
      '</div>' +
      '<div class="logistics-delivery-meta">' +
        '<b>' + escapeDespesaHtml(row.customer_name || "Cliente") + '</b>' +
        (row.customer_phone ? ' | ' + escapeDespesaHtml(row.customer_phone) : '') + '<br>' +
        escapeDespesaHtml(row.customer_address || "") + '<br>' +
        escapeDespesaHtml(schedule) +
        (row.driver_name ? ' | Entregador: ' + escapeDespesaHtml(row.driver_name) : '') +
      '</div>' +
      (row.description ? '<div class="logistics-delivery-desc">' + escapeDespesaHtml(row.description) + '</div>' : '') +
      (row.note ? '<div class="logistics-delivery-note">' + escapeDespesaHtml(row.note) + '</div>' : '') +
    '</div>' +
    '<div class="logistics-delivery-total">' + fmt(total) + '</div>' +
    '<div class="logistics-actions">' +
      (wa ? '<a href="' + wa + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' : '') +
      renderLogisticsStatusButtons(id, row.status) +
    '</div>' +
  '</article>';
}

function renderLogisticsStatusButtons(id, status) {
  var html = "";
  if (status === "pending" || status === "scheduled") html += '<button type="button" onclick="updateLogisticsDeliveryStatus(\'' + id + '\', \'ready\')">Pronta</button>';
  if (status === "pending" || status === "scheduled" || status === "ready") html += '<button type="button" class="primary" onclick="updateLogisticsDeliveryStatus(\'' + id + '\', \'in_route\')">Em rota</button>';
  if (getLogisticsOpenStatuses().indexOf(status) >= 0) {
    html += '<button type="button" class="primary" onclick="updateLogisticsDeliveryStatus(\'' + id + '\', \'delivered\')">Entregue</button>';
    html += '<button type="button" onclick="updateLogisticsDeliveryStatus(\'' + id + '\', \'failed\')">Falhou</button>';
    html += '<button type="button" class="danger" onclick="updateLogisticsDeliveryStatus(\'' + id + '\', \'canceled\')">Cancelar</button>';
  }
  if (status === "delivered" || status === "failed" || status === "canceled") {
    html += '<button type="button" onclick="updateLogisticsDeliveryStatus(\'' + id + '\', \'pending\')">Reabrir</button>';
  }
  return html;
}

async function updateLogisticsDeliveryStatus(id, status) {
  if (!requireAzulAction("logistics:update", "atualizar entrega")) return;
  if (!id || !status) return;

  var current = (logisticsDeliveries || []).find(function(row) { return String(row.id) === String(id); }) || {};
  var payload = {
    status: status,
    delivered_at: status === "delivered" ? new Date().toISOString() : null
  };

  try {
    var result = await supabaseClient
      .from("deliveries")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (result.error) throw result.error;

    if (result.data && result.data.source_type === "online_order" && result.data.source_id) {
      var onlineStatus = status === "delivered" ? "delivered" : status === "canceled" ? "canceled" : "preparing";
      await supabaseClient
        .from("online_orders")
        .update({ status: onlineStatus })
        .eq("id", result.data.source_id);
    }

    await logAzulAction("logistics:update", "logistica", "success", {
      source_table: "deliveries",
      source_id: id,
      status: status
    });

    await createAzulNotification({
      actionType: "logistics:update",
      title: getAzulCurrentUserName() + " atualizou uma entrega",
      message: (current.delivery_number || "Entrega") + " - " + getLogisticsStatusLabel(status),
      sourceType: "delivery",
      sourceId: id,
      details: {
        status: status
      }
    });

    toast("Entrega atualizada.", "success");
    await loadLogisticsDeliveries(true);
    if (onlineCurrentTab === "orders") loadOnlineOrders();
  } catch (e) {
    console.error("Erro atualizar entrega:", e);
    toast("Erro entrega: " + (e.message || e), "error");
  }
}

async function checkLogisticsReminders(silent) {
  try {
    var organizationId = getAzulOrganizationId();
    if (!organizationId || typeof createAzulNotification !== "function") return;

    var result = await supabaseClient
      .from("deliveries")
      .select("id, delivery_number, customer_name, scheduled_for, reminder_before_minutes, reminder_sent_at, status")
      .eq("organization_id", organizationId)
      .not("scheduled_for", "is", null)
      .is("reminder_sent_at", null)
      .in("status", getLogisticsOpenStatuses())
      .limit(50);

    if (result.error) throw result.error;

    var dueRows = (result.data || []).filter(isLogisticsReminderDue);
    for (var i = 0; i < dueRows.length; i++) {
      var delivery = dueRows[i];
      var state = getLogisticsScheduleState(delivery);

      await createAzulNotification({
        actionType: "logistics:reminder",
        title: state === "overdue" ? "Entrega atrasada" : "Entrega perto do prazo",
        message: (delivery.customer_name || "Cliente") + " - " + (delivery.delivery_number || "entrega") + " - " + formatLogisticsDate(delivery.scheduled_for),
        sourceType: "delivery",
        sourceId: delivery.id || null,
        targetRoles: ["owner", "manager"],
        details: {
          scheduled_for: delivery.scheduled_for,
          reminder_before_minutes: delivery.reminder_before_minutes || 60
        }
      });

      await supabaseClient
        .from("deliveries")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", delivery.id);
    }

    if (!silent && dueRows.length) toast("Alertas de logistica enviados.", "success");
  } catch (e) {
    if (!isLogisticsTableMissing(e)) console.warn("Erro alertas logistica:", e);
  }
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
    var safeName = escapeDespesaHtml(p.name || '');
    var safePhoto = escapeDespesaHtml(p.photo || '');
    var div = document.createElement('div');
    div.className = 'prod-card' + (out ? ' out' : '');
    div.innerHTML =
      '<img class="prod-img" src="' + safePhoto + '" alt="Produto">' +
      '<div class="prod-name" title="' + safeName + '">' + safeName + '</div>' +
      '<div class="prod-price" title="' + fmt(p.salePrice || p.price || 0) + '">' + fmt(p.salePrice || p.price || 0) + '</div>' +
      (meta && meta.some(function(item) { return item && item.trim() !== ''; })
      ? '<div class="prod-variation">' 
        + meta
            .filter(function(item) { return item && item.trim() !== ''; })
            .map(function(item) {
              return "<span style='border:0.5px solid var(--muted);border-radius:5px;padding:5px;margin-right:10px;'>" + escapeDespesaHtml(item) + "</span>";
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

function switchSaleCatalog(mode) {
  saleCatalogMode = mode === "services" ? "services" : "products";

  var productTab = document.getElementById("sale-catalog-products");
  var serviceTab = document.getElementById("sale-catalog-services");
  var servicePanel = document.getElementById("serviceQuickPanel");
  var search = document.getElementById("searchInput");

  if (productTab) productTab.classList.toggle("active", saleCatalogMode === "products");
  if (serviceTab) serviceTab.classList.toggle("active", saleCatalogMode === "services");
  if (servicePanel) servicePanel.style.display = saleCatalogMode === "services" ? "" : "none";
  if (search) search.placeholder = saleCatalogMode === "services" ? "Pesquisar servico..." : "Pesquisar produto...";

  filterProds();
}

function renderServices(list) {
  var g = document.getElementById('prodGrid');
  if (!g) return;

  if (servicesLoading) {
    g.innerHTML = '<div class="empty" style="grid-column:1/-1">A carregar servicos...</div>';
    return;
  }

  list = (Array.isArray(list) ? list : []).filter(function(service) {
    return service && service.name;
  });

  if (!list.length) {
    g.innerHTML = '<div class="empty" style="grid-column:1/-1">Sem servicos. Cria o primeiro servico acima.</div>';
    return;
  }

  g.innerHTML = '';
  list.forEach(function(service) {
    var safeName = escapeDespesaHtml(service.name || '');
    var safeCategory = escapeDespesaHtml(service.category || 'Servico');
    var div = document.createElement('div');
    div.className = 'prod-card service-card';
    div.innerHTML =
      '<div class="service-card-icon">' + (typeof azulIcon === "function" ? azulIcon("settings") : "S") + '</div>' +
      '<div class="prod-name" title="' + safeName + '">' + safeName + '</div>' +
      '<div class="prod-price" title="' + fmt(service.salePrice || service.price || 0) + '">' + fmt(service.salePrice || service.price || 0) + '</div>' +
      '<div class="service-card-meta">' + safeCategory + '</div>' +
      '<div class="prod-stock">Sem controlo de stock</div>';

    div.onclick = function() {
      addServiceToCart(service.id);
    };

    g.appendChild(div);
  });
}

async function saveServiceQuick() {
  if (!requireAzulAction("sale:create", "criar servico")) return;

  var nameInput = document.getElementById("service-name");
  var priceInput = document.getElementById("service-price");
  var costInput = document.getElementById("service-cost");
  var categoryInput = document.getElementById("service-category");
  var name = nameInput ? nameInput.value.trim() : "";
  var price = priceInput ? Number(priceInput.value) || 0 : 0;
  var cost = costInput ? Number(costInput.value) || 0 : 0;
  var category = categoryInput ? categoryInput.value.trim() : "";

  try {
    var service = await saveServiceToSupabase({
      name: name,
      salePrice: price,
      costPrice: cost,
      category: category
    });

    services.unshift(service);
    if (nameInput) nameInput.value = "";
    if (priceInput) priceInput.value = "";
    if (costInput) costInput.value = "";
    if (categoryInput) categoryInput.value = "";
    filterProds();
    toast("Servico guardado!", "success");
  } catch (e) {
    console.error("Erro servico:", e);
    if (isServicesTableMissing(e)) {
      toast("Tabela de servicos ainda nao instalada. Executa SQL/services_module.sql no Supabase.", "error");
      return;
    }
    toast("Erro ao guardar servico: " + (e.message || e), "error");
  }
}

function filterProds() {
  var input = document.getElementById('searchInput');
  var q = String((input && input.value) || '').trim().toLowerCase();
  if (saleCatalogMode === "services") {
    var serviceSource = services || [];
    var serviceList = q ? serviceSource.filter(function(service) {
      return String(service._searchText || service.name || "").toLowerCase().indexOf(q) >= 0;
    }) : serviceSource;
    renderServices(serviceList);
    return;
  }

  var source = products || [];
  var list = q ? source.filter(function(p) {
    return productSearchText(p).indexOf(q) >= 0;
  }) : source;
  renderProds(list);
}
// ===== CART =====
function addToCart(productIdOrName, stock, options) {
  options = options || {};
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

  if (!options.suppressFocus) {
    setTimeout(function() {
      var inputs = document.querySelectorAll(".ci-price-input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  }
}

function addServiceToCart(serviceIdOrName, options) {
  options = options || {};
  var service = (services || []).find(function(s) {
    return String(s.id) === String(serviceIdOrName);
  }) || (services || []).find(function(s) {
    return s.name === serviceIdOrName;
  }) || {};

  var salePrice = Number(service.salePrice || service.price) || 0;

  cart.push({
    productId: "",
    serviceId: service.id || "",
    itemType: "service",
    name: service.name || String(serviceIdOrName || ""),
    baseName: service.name || String(serviceIdOrName || ""),
    supplier: "",
    purchasePrice: Number(service.costPrice || service.purchasePrice) || 0,
    price: salePrice,
    regularPrice: salePrice,
    qty: 1,
    stock: 0,
    availableVariations: [],
    selectedVariations: [],
    isService: true
  });

  renderCart();

  if (!options.suppressFocus) {
    setTimeout(function() {
      var inputs = document.querySelectorAll(".ci-price-input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  }
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
    renderBarcodeScannerCartStrip();
    renderPhoneScannerCartStrip();
    return;
  }
  el.innerHTML = '';
  var total = 0;
  cart.forEach(function(item, i) {
    total += item.price * item.qty;
    var checks = (item.availableVariations || []).map(function(v) {
      var checked = (item.selectedVariations || []).indexOf(v) >= 0 ? 'checked' : '';
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface2);cursor:pointer;"><input type="checkbox" ' + checked + ' onclick="event.stopPropagation();" onchange="toggleCartVariation(event, ' + i + ',\'' + encodeURIComponent(v) + '\')">' + escapeDespesaHtml(v) + '</label>';
    }).join('');
    var safeItemName = escapeDespesaHtml(item.name || '');
    var serviceBadge = item && item.isService ? '<span class="cart-service-badge">Servico</span>' : '';
    var div = document.createElement('div');
    div.className = 'cart-item';
    div.setAttribute('data-index', i);
    div.innerHTML =
      '<div style="width:100%;">' +
        '<div class="cart-item-head">' +
          '<div class="ci-name" title="' + safeItemName + '">' + safeItemName + serviceBadge + '</div>' +
          '<button class="ci-del" onclick="removeItem(' + i + ')">x</button>' +
        '</div>' +
        '<div class="cart-item-main">' +
          '<div style="display:flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">' +
            '<button class="qbtn" style="background:none;width:18px;height:18px;" onclick="chgQty(' + i + ',-1)">-</button>' +
            '<span class="qnum">' + item.qty + '</span>' +
            '<button class="qbtn" style="background:none;width:18px;height:18px;" onclick="chgQty(' + i + ',1)">+</button>' +
          '</div>' +
          '<input type="number" class="ci-price-input" placeholder="' + getText('sale_price_placeholder') + '" value="' + (item.price||'') + '" min="0" onchange="updatePrice(' + i + ', this.value)" oninput="updatePrice(' + i + ', this.value)">' +
          '<div class="ci-total" id="ci-total-' + i + '" style="white-space:nowrap;">' + (item.price > 0 ? fmt(item.price * item.qty) : '-') + '</div>' +
        '</div>' +
        (checks ? '<div class="cart-variation-row">' + checks + '</div>' : '') +
      '</div>';
    el.appendChild(div);
  });
  document.getElementById('cartTotal').textContent = fmt(total);
  document.getElementById('confirmBtn').disabled = false;
  document.getElementById('confirmBtn').textContent = getText('payment');
  cleanupLegacyCartFooter();
  updatePaymentStatus();
  renderMobileCartBar();
  renderBarcodeScannerCartStrip();
  renderPhoneScannerCartStrip();
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

// ===== REVENDEDORES CLEAN MODULE =====
function getRevTodayDate() {
  return new Date().toISOString().split("T")[0];
}

function getRevProductById(id) {
  return (products || []).find(function(product) {
    return String(product.id) === String(id);
  }) || null;
}

function getRevCartProductQty(productId) {
  return (revCart || []).reduce(function(sum, item) {
    return sum + (String(item.productId) === String(productId) ? (Number(item.qty) || 0) : 0);
  }, 0);
}

function getRevLineName(item) {
  var variations = item && item.selectedVariations && item.selectedVariations.length
    ? " (" + item.selectedVariations.join(" / ") + ")"
    : "";
  return String(item && item.name ? item.name : "") + variations;
}

function getRevLineTotal(item) {
  return (Number(item && item.qty) || 0) * (Number(item && item.price) || 0);
}

function switchRevendeurTab(tab, btn) {
  ["create", "manage", "history"].forEach(function(name) {
    var panel = document.getElementById("rev-panel-" + name);
    var tabBtn = document.getElementById("rev-tab-" + name);
    if (panel) panel.style.display = name === tab ? "" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === tab);
  });

  if (btn && btn.classList) btn.classList.add("active");

  if (tab === "create") {
    renderRevProducts(products || []);
    renderRevCart();
  }

  if (tab === "manage") {
    loadRevendeurNames();
    loadRevendeurConsignations();
    renderRevPayLines();
  }

  if (tab === "history") {
    loadRevendeurNames();
    loadRevHistory();
  }
}

function renderRevProducts(list) {
  var grid = document.getElementById("revProdGrid");
  if (!grid) return;

  list = (Array.isArray(list) ? list : []).filter(function(product) {
    return product && product.name;
  });

  if (!list.length) {
    grid.innerHTML = '<div class="empty">Sem produtos disponiveis</div>';
    return;
  }

  grid.innerHTML = "";

  list.forEach(function(product) {
    var stock = Number(product.stockBoutique) || 0;
    var out = stock <= 0;
    var variations = parseVariationList(product.variation || product.variations);
    var card = document.createElement("button");
    card.type = "button";
    card.className = "reseller-product-card" + (out ? " is-out" : "");
    card.disabled = out;
    card.onclick = function() {
      addToRevCart(product.id, stock);
    };

    var img = product.photo
      ? '<img src="' + escapeDespesaHtml(product.photo) + '" alt="Produto" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\';"><span class="reseller-product-placeholder" style="display:none;">A</span>'
      : '<span class="reseller-product-placeholder">A</span>';

    card.innerHTML =
      '<div class="reseller-product-img">' + img + '</div>' +
      '<div class="reseller-product-info">' +
        '<strong title="' + escapeDespesaHtml(product.name || "") + '">' + escapeDespesaHtml(product.name || "") + '</strong>' +
        '<span>' + escapeDespesaHtml(product.code || product.category || "Produto") + '</span>' +
        '<em>' + escapeDespesaHtml(variations.length ? variations.join(" / ") : "Sem variacao") + '</em>' +
      '</div>' +
      '<div class="reseller-product-side">' +
        '<b>' + fmt(product.price || product.salePrice || 0) + '</b>' +
        '<small>' + (out ? "Esgotado" : stock + " un") + '</small>' +
      '</div>';

    grid.appendChild(card);
  });
}

function filterRevProducts() {
  var input = document.getElementById("rev-search");
  var q = String(input && input.value || "").trim().toLowerCase();
  var source = products || [];
  var list = q ? source.filter(function(product) {
    return productSearchText(product).indexOf(q) >= 0;
  }) : source;
  renderRevProducts(list);
}

function addToRevCart(productIdOrName, stock) {
  var product = getRevProductById(productIdOrName) || (products || []).find(function(row) {
    return row.name === productIdOrName;
  });

  if (!product) {
    toast("Produto nao encontrado.", "error");
    return;
  }

  var available = Number(stock != null ? stock : product.stockBoutique) || 0;
  var reserved = getRevCartProductQty(product.id);

  if (reserved >= available) {
    toast("Stock insuficiente para consignacao. Disponivel: " + available, "error");
    return;
  }

  revCart.push({
    productId: product.id || "",
    name: product.name || "",
    baseName: product.name || "",
    supplier: product.supplier || product.mainSupplier || "",
    purchasePrice: Number(product.purchasePrice) || 0,
    price: Number(product.price || product.salePrice) || 0,
    qty: 1,
    stock: available,
    availableVariations: parseVariationList(product.variation || product.variations),
    selectedVariations: []
  });

  renderRevCart();
}

function renderRevCart() {
  var body = document.getElementById("revCartBody");
  var totalEl = document.getElementById("revTotal");
  if (!body) return;

  if (!revCart.length) {
    body.innerHTML = '<div class="empty">Adiciona produtos</div>';
    if (totalEl) totalEl.textContent = fmt(0);
    return;
  }

  var total = 0;
  body.innerHTML = "";

  revCart.forEach(function(item, index) {
    total += getRevLineTotal(item);
    var variations = (item.availableVariations || []).map(function(variation) {
      var checked = (item.selectedVariations || []).indexOf(variation) >= 0 ? " checked" : "";
      return '<label><input type="checkbox"' + checked + ' onchange="toggleRevVariation(' + index + ',\'' + encodeURIComponent(variation) + '\')">' + escapeDespesaHtml(variation) + '</label>';
    }).join("");

    var row = document.createElement("div");
    row.className = "reseller-cart-line";
    row.innerHTML =
      '<div class="reseller-cart-line-head">' +
        '<strong title="' + escapeDespesaHtml(item.name || "") + '">' + escapeDespesaHtml(item.name || "") + '</strong>' +
        '<button type="button" onclick="removeRevItem(' + index + ')">x</button>' +
      '</div>' +
      (variations ? '<div class="reseller-variation-row">' + variations + '</div>' : '<div class="reseller-line-muted">Sem variacao</div>') +
      '<div class="reseller-cart-controls">' +
        '<div class="reseller-qty">' +
          '<button type="button" onclick="chgRevQty(' + index + ',-1)">-</button>' +
          '<span>' + (item.qty || 0) + '</span>' +
          '<button type="button" onclick="chgRevQty(' + index + ',1)">+</button>' +
        '</div>' +
        '<input type="number" min="0" value="' + (item.price || "") + '" oninput="updateRevPrice(' + index + ', this.value)" placeholder="Preco">' +
        '<b>' + fmt(getRevLineTotal(item)) + '</b>' +
      '</div>';

    body.appendChild(row);
  });

  if (totalEl) totalEl.textContent = fmt(total);
}

function toggleRevVariation(index, encodedVariation) {
  if (!revCart[index]) return;
  var value = decodeURIComponent(encodedVariation || "");
  var selected = revCart[index].selectedVariations || [];
  var pos = selected.indexOf(value);
  if (pos >= 0) selected.splice(pos, 1);
  else selected.push(value);
  revCart[index].selectedVariations = selected;
  renderRevCart();
}

function chgRevQty(index, delta) {
  if (!revCart[index]) return;

  var next = (Number(revCart[index].qty) || 0) + delta;
  if (next <= 0) {
    revCart.splice(index, 1);
    renderRevCart();
    return;
  }

  var productId = revCart[index].productId;
  var otherQty = (revCart || []).reduce(function(sum, item, itemIndex) {
    return sum + (itemIndex !== index && String(item.productId) === String(productId) ? (Number(item.qty) || 0) : 0);
  }, 0);

  if (otherQty + next > (Number(revCart[index].stock) || 0)) {
    toast("Stock insuficiente para consignacao. Disponivel: " + revCart[index].stock, "error");
    return;
  }

  revCart[index].qty = next;
  renderRevCart();
}

function updateRevPrice(index, value) {
  if (!revCart[index]) return;
  revCart[index].price = Number(value) || 0;
  renderRevCart();
}

function removeRevItem(index) {
  revCart.splice(index, 1);
  renderRevCart();
}

function clearRevCart() {
  revCart = [];
  var search = document.getElementById("rev-search");
  if (search) search.value = "";
  renderRevCart();
  renderRevProducts(products || []);
}

function validateRevCartStock() {
  var grouped = {};

  (revCart || []).forEach(function(item) {
    grouped[item.productId] = (grouped[item.productId] || 0) + (Number(item.qty) || 0);
  });

  Object.keys(grouped).forEach(function(productId) {
    var product = getRevProductById(productId);
    var stock = Number(product && product.stockBoutique) || 0;
    if (!product) throw new Error("Produto nao encontrado.");
    if (grouped[productId] > stock) {
      throw new Error("Stock insuficiente para " + product.name + ". Disponivel: " + stock);
    }
  });
}

async function updateRevProductStocksAfterConsignment() {
  var grouped = {};

  (revCart || []).forEach(function(item) {
    grouped[item.productId] = (grouped[item.productId] || 0) + (Number(item.qty) || 0);
  });

  for (var productId in grouped) {
    var product = getRevProductById(productId);
    if (!product) continue;

    var result = await supabaseClient
      .from("products")
      .update({ stock_shop: Math.max(0, (Number(product.stockBoutique) || 0) - grouped[productId]) })
      .eq("id", productId);

    if (result.error) throw result.error;
  }
}

async function createConsignmentsInSupabase(data) {
  var organizationId = getAzulOrganizationId();
  var resellerName = String(data.revendeur || "").trim();
  var date = data.date || getRevTodayDate();
  var items = data.items || [];
  var batchNo = generateConsignmentNo();

  if (!resellerName) throw new Error("Nome do revendedor obrigatorio.");
  if (!items.length) throw new Error("Adiciona pelo menos um produto.");

  validateRevCartStock();

  var created = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var product = getRevProductById(item.productId);
    if (!product) throw new Error("Produto nao encontrado: " + item.name);

    var qty = Number(item.qty) || 0;
    var price = Number(item.price) || 0;
    var total = qty * price;
    var consignmentNo = batchNo + "-" + String(i + 1).padStart(2, "0");

    var consignmentResult = await insertSingleWithAzulAudit("reseller_consignments", {
      organization_id: organizationId,
      consignment_no: consignmentNo,
      reseller_name: resellerName,
      consignment_date: date,
      status: "open",
      total: total,
      paid_amount: 0,
      payment_summary: "",
      receipt_no: ""
    });

    if (consignmentResult.error) throw consignmentResult.error;

    var consignment = consignmentResult.data;
    var itemResult = await insertRowsWithAzulAudit("reseller_consignment_items", [{
      organization_id: organizationId,
      consignment_id: consignment.id,
      product_id: product.id,
      product_name: getRevLineName(item),
      quantity: qty,
      unit_price: price,
      total: total,
      variation: (item.selectedVariations || []).join(" | "),
      variations: item.selectedVariations || []
    }]);

    if (itemResult.error) throw itemResult.error;
    created.push(consignment);
  }

  await updateRevProductStocksAfterConsignment();

  return {
    batchNo: batchNo,
    count: created.length,
    rows: created
  };
}

async function saveConsignation() {
  if (revSaveInProgress) {
    toast("Consignacao ja esta a ser registada. Aguarde...", "error");
    return;
  }

  var resellerName = String((document.getElementById("rev-name") || {}).value || "").trim();
  var btn = document.getElementById("revSaveBtn");

  if (!resellerName) {
    toast("Entra o nome do revendedor.", "error");
    return;
  }

  if (!revCart.length) {
    toast("Adiciona pelo menos um produto.", "error");
    return;
  }

  var invalid = revCart.find(function(item) {
    return !item.qty || item.qty <= 0 || !item.price || item.price <= 0;
  });

  if (invalid) {
    toast("Verifica quantidade e preco de " + invalid.name + ".", "error");
    return;
  }

  revSaveInProgress = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
  }

  try {
    var result = await createConsignmentsInSupabase({
      date: (document.getElementById("rev-date") || {}).value || getRevTodayDate(),
      revendeur: resellerName,
      items: revCart.map(function(item) {
        return Object.assign({}, item);
      })
    });

    toast("Consignacao criada: " + result.batchNo + " (" + result.count + " item/ns).", "success");
    clearRevCart();
    await loadProducts(true);
    await loadRevendeurNames();

    var manage = document.getElementById("rev-manage-name");
    var hist = document.getElementById("rev-history-name");
    if (manage) manage.value = resellerName;
    if (hist) hist.value = resellerName;
    await loadRevendeurConsignations();
    loadRevHistory();
  } catch (e) {
    console.error("Erro consignacao revendedor:", e);
    toast("Erro consignacao: " + (e.message || e), "error");
  } finally {
    revSaveInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Criar consignacao";
    }
  }
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

async function loadRevendeurNames() {
  var select = document.getElementById("rev-manage-name");
  var datalist = document.getElementById("revendeur-list");

  try {
    var names = await getResellerNamesFromSupabase();
    var current = select ? select.value : "";

    if (select) {
      select.innerHTML = '<option value="">Escolher revendedor</option>' + names.map(function(name) {
        return '<option value="' + escapeDespesaHtml(name) + '">' + escapeDespesaHtml(name) + '</option>';
      }).join("");
      if (current && names.indexOf(current) >= 0) select.value = current;
    }

    if (datalist) {
      datalist.innerHTML = names.map(function(name) {
        return '<option value="' + escapeDespesaHtml(name) + '"></option>';
      }).join("");
    }
  } catch (e) {
    console.error("Erro ao carregar revendedores:", e);
  }
}

function loadOpenConsignations() {
  loadRevendeurNames();
  if (document.getElementById("rev-panel-manage") && document.getElementById("rev-panel-manage").style.display !== "none") {
    loadRevendeurConsignations();
  }
  if (document.getElementById("rev-panel-history") && document.getElementById("rev-panel-history").style.display !== "none") {
    loadRevHistory();
  }
}

async function getConsignmentsByResellerFromSupabase(name) {
  var organizationId = getAzulOrganizationId();

  if (!name) return [];

  var result = await supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("reseller_name", name)
    .eq("status", "open")
    .order("consignment_date", { ascending: false })
    .order("created_at", { ascending: false });

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

  var salePriceMap = await getRevProductSalePriceMap(itemsResult.data || []);

  return rows.map(function(row) {
    var items = itemsById[row.id] || [];
    var paid = Number(row.paid_amount) || 0;
    var itemsTotal = items.reduce(function(sum, item) {
      return sum + getRevConsignmentItemDebtValue(item, salePriceMap);
    }, 0);
    var total = itemsTotal > 0 ? itemsTotal : (Number(row.total) || 0);
    return {
      id: row.id,
      displayId: row.consignment_no || row.id,
      date: row.consignment_date || "",
      created_at: row.created_at || "",
      revendeur: row.reseller_name || "",
      status: row.status || "open",
      total: total,
      paid: paid,
      due: Math.max(0, total - paid),
      qty: items.reduce(function(sum, item) { return sum + (Number(item.quantity) || 0); }, 0),
      items: items
    };
  });
}

function getRevSelectionIds() {
  return Array.prototype.slice.call(document.querySelectorAll(".rev-open-check:checked"))
    .map(function(input) { return input.value; })
    .filter(Boolean);
}

function getSelectedRevOpenList() {
  var ids = getRevSelectionIds();
  return (revOpenConsignations || []).filter(function(item) {
    return ids.indexOf(String(item.id)) >= 0;
  });
}

async function loadRevendeurConsignations() {
  var select = document.getElementById("rev-manage-name");
  var box = document.getElementById("rev-open-list");
  var name = String(select && select.value || "").trim();

  if (!box) return;

  revLastSelectionKey = "";
  revOpenConsignations = [];
  box.innerHTML = '<div class="empty">A carregar...</div>';

  if (!name) {
    box.innerHTML = '<div class="empty">Escolhe um revendedor para ver consignacoes abertas.</div>';
    updateRevActionPanel();
    return;
  }

  try {
    var list = await getConsignmentsByResellerFromSupabase(name);
    revOpenConsignations = list;

    if (!list.length) {
      box.innerHTML = '<div class="empty">Nenhuma consignacao aberta.</div>';
      updateRevActionPanel();
      return;
    }

    box.innerHTML = list.map(function(row) {
      var itemSummary = (row.items || []).map(function(item) {
        return (item.product_name || "-") + " x" + (item.quantity || 0);
      }).join(", ");

      return '<label class="reseller-open-card">' +
        '<input type="checkbox" class="rev-open-check" value="' + escapeDespesaHtml(row.id) + '" onchange="updateRevActionPanel()">' +
        '<span>' +
          '<strong>' + escapeDespesaHtml(row.displayId) + '</strong>' +
          '<em>' + escapeDespesaHtml(row.date) + ' | ' + escapeDespesaHtml(itemSummary) + '</em>' +
          '<small>Pago: ' + fmt(row.paid) + ' | Resto: ' + fmt(row.due) + '</small>' +
        '</span>' +
        '<b>' + fmt(row.total) + '</b>' +
      '</label>';
    }).join("");

    updateRevActionPanel();
  } catch (e) {
    console.error("Erro consignacoes revendedor:", e);
    box.innerHTML = '<div class="empty">Erro ao carregar consignacoes.</div>';
    toast("Erro revendedor: " + (e.message || e), "error");
  }
}

function renderRevPayLines() {
  var wrap = document.getElementById("rev-pay-lines");
  if (!wrap) return;

  var methods = ["Cash", "Express", "Cartao"];
  wrap.innerHTML = (revPaymentLines || []).map(function(line, index) {
    var options = methods.map(function(method) {
      return '<option value="' + method + '"' + (line.method === method ? " selected" : "") + '>' + method + '</option>';
    }).join("");

    return '<div class="reseller-pay-line">' +
      '<select onchange="revPaymentLines[' + index + '].method=this.value">' + options + '</select>' +
      '<input type="number" min="0" value="' + (line.montant || "") + '" placeholder="Montante" oninput="revPaymentLines[' + index + '].montant=Number(this.value)||0">' +
      (revPaymentLines.length > 1 ? '<button type="button" onclick="removeRevPayLine(' + index + ')">x</button>' : '<span></span>') +
    '</div>';
  }).join("");
}

function addRevPayLine() {
  revPaymentLines.push({ method: "Express", montant: 0 });
  renderRevPayLines();
}

function removeRevPayLine(index) {
  if (revPaymentLines.length <= 1) return;
  revPaymentLines.splice(index, 1);
  renderRevPayLines();
}

function updateRevActionPanel() {
  var action = String((document.getElementById("rev-action-type") || {}).value || "payment");
  var paymentPanel = document.getElementById("rev-payment-panel");
  var returnPanel = document.getElementById("rev-return-panel");
  var confirmBtn = document.getElementById("revActionConfirmBtn");
  var paymentSummary = document.getElementById("rev-payment-summary");
  var returnSummary = document.getElementById("rev-return-summary");
  var totalEl = document.getElementById("rev-payment-total");
  var selected = getSelectedRevOpenList();
  var selectionKey = selected.map(function(row) { return row.id; }).sort().join("|");
  var totalDue = selected.reduce(function(sum, row) { return sum + (Number(row.due) || 0); }, 0);

  if (paymentPanel) paymentPanel.style.display = action === "payment" ? "" : "none";
  if (returnPanel) returnPanel.style.display = action === "return" ? "" : "none";
  if (confirmBtn) confirmBtn.textContent = action === "return" ? "Confirmar devolucao" : "Confirmar pagamento";
  if (totalEl) totalEl.textContent = fmt(totalDue);

  var summaryHtml = selected.length ? selected.map(function(row) {
    return '<div class="reseller-summary-row">' +
      '<span><strong>' + escapeDespesaHtml(row.displayId) + '</strong><small>' + escapeDespesaHtml(row.date) + '</small></span>' +
      '<b>' + fmt(row.due) + '</b>' +
    '</div>';
  }).join("") : '<div class="empty">Seleciona uma consignacao.</div>';

  if (paymentSummary) paymentSummary.innerHTML = summaryHtml;
  if (returnSummary) {
    var hasPaid = selected.some(function(row) { return Number(row.paid) > 0; });
    returnSummary.innerHTML = summaryHtml + (hasPaid ? '<div class="reseller-warning">Consignacoes com pagamento nao podem ser devolvidas directamente.</div>' : "");
  }

  if (selectionKey !== revLastSelectionKey) {
    revPaymentLines = [{ method: "Cash", montant: totalDue }];
    revLastSelectionKey = selectionKey;
    renderRevPayLines();
  }
}

function getRevPaymentSummary(lines) {
  return (lines || []).map(function(line) {
    return line.method + ": " + formatPaymentAmount(line.montant || 0);
  }).join(" + ");
}

async function getRevItemsForConsignments(ids) {
  if (!ids.length) return {};

  var result = await supabaseClient
    .from("reseller_consignment_items")
    .select("*")
    .in("consignment_id", ids);

  if (result.error) throw result.error;

  var byId = {};
  (result.data || []).forEach(function(item) {
    if (!byId[item.consignment_id]) byId[item.consignment_id] = [];
    byId[item.consignment_id].push(item);
  });
  return byId;
}

async function getRevProductCostMap(items) {
  var ids = (items || []).map(function(item) { return item.product_id; }).filter(Boolean);
  var unique = Array.from(new Set(ids));
  var map = {};

  if (!unique.length) return map;

  var result = await supabaseClient
    .from("products")
    .select("id,purchase_price")
    .in("id", unique);

  if (result.error) throw result.error;

  (result.data || []).forEach(function(product) {
    map[product.id] = Number(product.purchase_price) || 0;
  });
  return map;
}

async function paySelectedConsignmentsInSupabase(ids, paymentLines, actionDate) {
  var organizationId = getAzulOrganizationId();
  var activeLines = (paymentLines || []).filter(function(line) {
    return Number(line.montant) > 0;
  });

  if (!ids.length) throw new Error("Seleciona pelo menos uma consignacao.");
  if (!activeLines.length) throw new Error("Adiciona um pagamento.");

  var totalPaid = activeLines.reduce(function(sum, line) {
    return sum + (Number(line.montant) || 0);
  }, 0);

  var result = await supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .in("id", ids)
    .eq("status", "open")
    .order("consignment_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (result.error) throw result.error;

  var rows = result.data || [];
  var totalDue = rows.reduce(function(sum, row) {
    return sum + Math.max(0, (Number(row.total) || 0) - (Number(row.paid_amount) || 0));
  }, 0);

  if (totalPaid > totalDue + 0.01) {
    throw new Error("Pagamento maior que a divida selecionada. Divida: " + fmt(totalDue));
  }

  var itemsById = await getRevItemsForConsignments(rows.map(function(row) { return row.id; }));
  var receiptNo = "REV-" + Date.now();
  var remainingPayment = totalPaid;
  var paidRows = [];

  for (var i = 0; i < rows.length && remainingPayment > 0; i++) {
    var row = rows[i];
    var currentPaid = Number(row.paid_amount) || 0;
    var total = Number(row.total) || 0;
    var due = Math.max(0, total - currentPaid);
    if (due <= 0) continue;

    var applied = Math.min(due, remainingPayment);
    var newPaid = currentPaid + applied;
    var fullyPaid = newPaid >= total - 0.01;
    var items = itemsById[row.id] || [];
    var costMap = await getRevProductCostMap(items);
    var cost = items.reduce(function(sum, item) {
      return sum + ((Number(item.quantity) || 0) * (costMap[item.product_id] || 0));
    }, 0);

    var updateResult = await supabaseClient
      .from("reseller_consignments")
      .update({
        paid_amount: newPaid,
        status: fullyPaid ? "paid" : "open",
        payment_summary: getRevPaymentSummary(activeLines),
        receipt_no: receiptNo,
        closed_at: fullyPaid ? new Date().toISOString() : null
      })
      .eq("organization_id", organizationId)
      .eq("id", row.id);

    if (updateResult.error) throw updateResult.error;

    paidRows.push(Object.assign({}, row, {
      paid_amount: newPaid,
      status: fullyPaid ? "paid" : "open",
      applied_amount: applied,
      receipt_no: receiptNo
    }));

    var accountingLines = [
      { account: "11", debit: applied, credit: 0 },
      { account: "71", debit: 0, credit: applied }
    ];

    if (fullyPaid && cost > 0) {
      accountingLines.push({ account: "61", debit: cost, credit: 0 });
      accountingLines.push({ account: "13", debit: 0, credit: cost });
    }

    await createAccountingEntry(
      "reseller_payment",
      row.id,
      actionDate || getRevTodayDate(),
      "Pagamento revendedor " + (row.reseller_name || ""),
      accountingLines
    );

    remainingPayment -= applied;
  }

  return {
    paid: totalPaid,
    due: totalDue,
    partial: totalPaid < totalDue - 0.01,
    rows: paidRows
  };
}

async function returnSelectedConsignmentsInSupabase(ids) {
  var organizationId = getAzulOrganizationId();

  if (!ids.length) throw new Error("Seleciona pelo menos uma consignacao.");

  var result = await supabaseClient
    .from("reseller_consignments")
    .select("*")
    .eq("organization_id", organizationId)
    .in("id", ids)
    .eq("status", "open");

  if (result.error) throw result.error;

  var rows = result.data || [];

  if (rows.some(function(row) { return Number(row.paid_amount) > 0; })) {
    throw new Error("Uma consignacao ja tem pagamento. Faca uma correcao antes da devolucao.");
  }

  var itemsById = await getRevItemsForConsignments(rows.map(function(row) { return row.id; }));

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var items = itemsById[row.id] || [];

    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var productResult = await supabaseClient
        .from("products")
        .select("id,stock_shop")
        .eq("id", item.product_id)
        .single();

      if (productResult.error) throw productResult.error;

      var stockResult = await supabaseClient
        .from("products")
        .update({ stock_shop: (Number(productResult.data.stock_shop) || 0) + (Number(item.quantity) || 0) })
        .eq("id", item.product_id);

      if (stockResult.error) throw stockResult.error;
    }

    var updateResult = await supabaseClient
      .from("reseller_consignments")
      .update({
        status: "returned",
        payment_summary: "Devolucao",
        closed_at: new Date().toISOString()
      })
      .eq("organization_id", organizationId)
      .eq("id", row.id);

    if (updateResult.error) throw updateResult.error;
  }

  return {
    count: rows.length,
    total: rows.reduce(function(sum, row) {
      return sum + (Number(row.total) || 0);
    }, 0),
    rows: rows
  };
}

async function confirmRevAction() {
  if (revActionInProgress) {
    toast("Accao em curso. Aguarde...", "error");
    return;
  }

  var action = String((document.getElementById("rev-action-type") || {}).value || "payment");
  var ids = getRevSelectionIds();
  var btn = document.getElementById("revActionConfirmBtn");

  if (!ids.length) {
    toast("Seleciona pelo menos uma consignacao.", "error");
    return;
  }

  revActionInProgress = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A processar...";
  }

  try {
    if (action === "return") {
      var returnResult = await returnSelectedConsignmentsInSupabase(ids);
      await notifyAzulResellerAction("reseller:return", returnResult.rows || [], returnResult.total || 0);
      toast("Mercadoria devolvida ao stock.", "success");
    } else {
      var paymentResult = await paySelectedConsignmentsInSupabase(
        ids,
        revPaymentLines,
        (document.getElementById("rev-action-date") || {}).value || getRevTodayDate()
      );
      await notifyAzulResellerAction("reseller:payment", paymentResult.rows || [], paymentResult.paid || 0);
      toast(paymentResult.partial ? "Pagamento parcial registado." : "Pagamento registado.", "success");
    }

    revPaymentLines = [{ method: "Cash", montant: 0 }];
    revLastSelectionKey = "";
    await loadProducts(true);
    await loadRevendeurConsignations();
    loadRevHistory();
    loadDashboard();
  } catch (e) {
    console.error("Erro accao revendedor:", e);
    toast("Erro revendedor: " + (e.message || e), "error");
  } finally {
    revActionInProgress = false;
    if (btn) {
      btn.disabled = false;
    }
    updateRevActionPanel();
  }
}

function getRevStatusLabel(status) {
  var value = String(status || "").toLowerCase();
  if (value === "paid") return "Pago";
  if (value === "returned" || value === "devolvido") return "Devolvido";
  if (value === "cancelled") return "Cancelado";
  return "Aberto";
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

  var itemsById = await getRevItemsForConsignments(rows.map(function(row) { return row.id; }));
  var allItems = [];
  Object.keys(itemsById).forEach(function(id) {
    allItems = allItems.concat(itemsById[id] || []);
  });
  var salePriceMap = await getRevProductSalePriceMap(allItems);

  return rows.map(function(row) {
    var items = itemsById[row.id] || [];
    var itemTotal = items.reduce(function(sum, item) {
      return sum + getRevConsignmentItemDebtValue(item, salePriceMap);
    }, 0);

    return {
      id: row.consignment_no || row.id,
      actionDate: row.consignment_date || "",
      created_at: row.created_at || "",
      revendeur: row.reseller_name || "",
      status: row.status || "open",
      statusLabel: getRevStatusLabel(row.status),
      itemsSummary: items.map(function(item) {
        return (item.product_name || "-") + " x" + (item.quantity || 0);
      }).join(", "),
      total: itemTotal > 0 ? itemTotal : (Number(row.total) || 0),
      paid: Number(row.paid_amount) || 0,
      payment: row.payment_summary || "",
      recibo: row.receipt_no || ""
    };
  });
}

function renderMobileRevHistory(rows) {
  var list = ensureMobileList("revHistoryBody", "mobileRevHistoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Sem historico revendedor</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    return '<div class="mobile-rev-history-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.id || "-") + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(row.revendeur || "Revendedor") + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.actionDate || "") + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.itemsSummary || "") + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="mobile-card-amount">' + fmt(row.total || 0) + '</div>' +
          '<div class="mobile-rev-pill ' + escapeDespesaHtml(String(row.status || "open").toLowerCase()) + '">' + escapeDespesaHtml(row.statusLabel || row.status || "") + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mobile-rev-extra">' +
        '<span>Pago: ' + fmt(row.paid || 0) + '</span>' +
        '<span>Recibo: ' + escapeDespesaHtml(row.recibo || "-") + '</span>' +
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
    var rows = await getResellerHistoryFromSupabase({
      revendeur: String((document.getElementById("rev-history-name") || {}).value || "").trim(),
      from: String((document.getElementById("rev-history-from") || {}).value || ""),
      to: String((document.getElementById("rev-history-to") || {}).value || "")
    });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">Nenhum historico encontrado</td></tr>';
      renderMobileRevHistory([]);
      return;
    }

    renderMobileRevHistory(rows);
    body.innerHTML = rows.map(function(row) {
      return '<tr>' +
        '<td>' + escapeDespesaHtml(row.id || "") + '</td>' +
        '<td>' + escapeDespesaHtml(row.actionDate || "") + '</td>' +
        '<td>' + escapeDespesaHtml(row.revendeur || "") + '</td>' +
        '<td>' + escapeDespesaHtml(row.statusLabel || "") + '</td>' +
        '<td style="font-size:11px;line-height:1.4;">' + escapeDespesaHtml(row.itemsSummary || "") + '</td>' +
        '<td style="font-weight:700;color:var(--blue);">' + fmt(row.total || 0) + '</td>' +
        '<td>' + fmt(row.paid || 0) + '</td>' +
        '<td>' + escapeDespesaHtml(row.recibo || "-") + '</td>' +
      '</tr>';
    }).join("");
  } catch (e) {
    console.error("Erro historico revendedor:", e);
    body.innerHTML = '<tr><td colspan="8" class="empty">Erro ao carregar historico</td></tr>';
    renderMobileRevHistory([]);
    toast("Erro historico revendedor: " + (e.message || e), "error");
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

function parsePaymentAmount(value) {
  var text = String(value == null ? "" : value)
    .replace(/[^\d,.-]/g, "")
    .replace(/\s/g, "");

  if (!text) return 0;

  if (text.indexOf(",") >= 0 && text.indexOf(".") >= 0) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.indexOf(",") >= 0) {
    text = text.replace(",", ".");
  }

  return Number(text) || 0;
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
    var inp = '<input type="number" placeholder="Montante" value="'+(p.montant||'')+'" min="0" '+
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
    btn.style.background = "color-mix(in srgb, var(--blue) 10%, transparent)";
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

  if (saleSaveInProgress) {
    toast("Venda ja esta a ser registada. Aguarde...", "error");
    return;
  }

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

var hasCredito = getCreditoAmountFromPaymentLines(finalPaymentLines, totalVenda) > 0;
var clientName = document.getElementById("clientInput").value.trim();

if (hasCredito && !clientName) {
  toast("Venda a credito precisa de nome do cliente.", "error");
  return;
}

  var btn = document.getElementById("paymentConfirmBtn") || document.getElementById("confirmBtn");
  saleSaveInProgress = true;

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
    saleSaveInProgress = false;
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
          ? '<img class="mobile-cart-img" src="' + escapeDespesaHtml(img) + '" alt="">'
          : '<div class="mobile-cart-img mobile-cart-img-empty"></div>';
        var subText = isServiceCartItem(item) ? "Servico sem stock" : "Stock loja: " + (item.stock || 0) + " un";
        
        return '<div class="mobile-cart-item">' +
          '<div class="mobile-cart-item-main">' +
            imgHtml +
            '<div>' +
              '<div class="mobile-cart-name">' + escapeDespesaHtml(getItemDisplayName(item)) + '</div>' +
              '<div class="mobile-cart-sub">' + escapeDespesaHtml(subText) + '</div>' +
              '<div class="mobile-cart-price">' + fmt(item.price || 0) + '</div>' +
              '<div class="mobile-cart-sub">Total ' + fmt((item.price || 0) * (item.qty || 0)) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="mobile-cart-actions">' +
            '<button class="mobile-cart-delete" onclick="removeItem(' + index + '); renderMobileCartPage(); event.stopPropagation();">x</button>' +
            '<div class="mobile-cart-qty">' +
              '<button onclick="chgQty(' + index + ', -1); renderMobileCartPage(); event.stopPropagation();">-</button>' +
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
      '<button onclick="removeMobilePaymentLine(' + index + ')">x</button>' +
    '</div>';
  }).join("");

  page.innerHTML =
    '<div class="mobile-cart-head">' +
      '<button class="mobile-cart-back" onclick="closeMobileCart()"><</button>' +
      '<div class="mobile-cart-title">Carrinho</div>' +
      '<button class="mobile-cart-clear" onclick="clearCart(); renderMobileCartPage(); renderMobileCartBar();">Limpar</button>' +
    '</div>' +
    '<div class="mobile-cart-body">' +
      itemsHtml +
      '<div class="mobile-payment-card">' +
        '<div class="mobile-payment-type">' +
         '<button type="button" class="' + (selectedType !== "Externo" ? "active" : "") + '" onclick="event.preventDefault(); setMobileSaleType(\'interno\')">Interno</button>' +
'<button type="button" class="' + (selectedType === "Externo" ? "active" : "") + '" onclick="event.preventDefault(); setMobileSaleType(\'Externo\')">Externo</button>' +
        '</div>' +
        paymentHtml +
        '<button class="mobile-add-pay" onclick="addMobilePaymentLine()">+ Adicionar meio de pagamento</button>' +
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
  if (rlogo) rlogo.textContent = (config && config.name) || 'Azul Gestao';

  var rslogan = document.getElementById('r-slogan');
  if (rslogan) rslogan.textContent = (config && config.slogan) || '';


  // Infos de base
  document.getElementById('r-num').textContent = d.recibo;
  document.getElementById('r-date').textContent = d.date;
  document.getElementById('r-client').textContent = d.client;
  document.getElementById('r-pay').textContent = d.pagamento || d.pay || "-";
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

  // Aplicar config personnalisation
  var cfg = config || {};

  // Adresse et telephone
  var addrEl = document.getElementById('r-address-line');
  var phoneEl = document.getElementById('r-phone-line');
  if (addrEl) {
    addrEl.textContent = cfg.address || '';
    addrEl.style.display = cfg.address && cfg.showAddress !== false ? 'block' : 'none';
  }
  if (phoneEl) {
    phoneEl.textContent = cfg.phone || '';
    phoneEl.style.display = cfg.phone && cfg.showAddress !== false ? 'block' : 'none';
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
  if (thanksEl) thanksEl.textContent = cfg.footer || ('Obrigado por escolher ' + (cfg.name || 'a nossa loja') + '!');

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

function switchCompraTab(tab, btn) {
  ["novo", "historico"].forEach(function(name) {
    var panel = document.getElementById("achat-panel-" + name);
    var tabBtn = document.getElementById("achat-tab-" + name);

    if (panel) panel.style.display = name === tab ? "block" : "none";
    if (tabBtn) tabBtn.classList.toggle("active", name === tab);
  });

  if (tab === "novo" && typeof renderMobileCompraSummary === "function") {
    renderMobileCompraSummary();
  }

  if (tab === "historico") {
    loadCompraHistorique();
  }
}

function loadCompraHistoriqueDebounced() {
  clearTimeout(achatHistorySearchTimer);
  achatHistorySearchTimer = setTimeout(function() {
    loadCompraHistorique();
  }, 250);
}

async function getCompraHistoriqueFromSupabase() {
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

async function loadCompraHistorique() {
  var body = document.getElementById("achatHistoryBody");
  var cards = document.getElementById("achatHistoryCards");

  if (body) body.innerHTML = '<tr><td colspan="10" class="empty">A carregar...</td></tr>';
  if (cards) cards.innerHTML = '<div class="empty">A carregar...</div>';

  try {
    var data = await getCompraHistoriqueFromSupabase();
    var rows = data.rows || [];
    var summary = data.summary || {};

    document.getElementById("achatHistTotal").textContent = fmt(summary.total || 0);
    document.getElementById("achatHistPaid").textContent = fmt(summary.paid || 0);
    document.getElementById("achatHistDebt").textContent = fmt(summary.debt || 0);
    document.getElementById("achatHistQty").textContent = new Intl.NumberFormat(getLocale()).format(summary.qty || 0);
    document.getElementById("achatHistCount").textContent = (summary.count || 0) + " achats";

    if (!rows.length) {
      if (body) body.innerHTML = '<tr><td colspan="10" class="empty">Nenhuma compra encontrada</td></tr>';
      if (cards) cards.innerHTML = '<div class="empty">Nenhuma compra encontrada</div>';
      return;
    }

    if (body) {
      body.innerHTML = rows.map(function(row) {
        return '<tr>' +
          '<td>' + escapeDespesaHtml(row.date) + '</td>' +
          '<td>' + escapeDespesaHtml(row.supplier) + '<div>' + renderActionAuthor(row) + '</div></td>' +
          '<td>' + escapeDespesaHtml(row.product) + '</td>' +
          '<td>' + escapeDespesaHtml(row.code || "-") + '</td>' +
          '<td>' + escapeDespesaHtml(row.variation || "-") + '</td>' +
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
              '<strong>' + escapeDespesaHtml(row.product) + '</strong>' +
              '<span>' + escapeDespesaHtml(row.supplier || "Fornecedor") + '</span>' +
              renderActionAuthor(row) +
            '</div>' +
            '<b>' + fmt(row.total) + '</b>' +
          '</div>' +
          '<div class="achat-history-card-meta">' +
            '<span>' + escapeDespesaHtml(row.date) + '</span>' +
            '<span>Qtd: ' + row.qty + '</span>' +
            '<span>P. Compra: ' + fmt(row.unit) + '</span>' +
          '</div>' +
          '<div class="achat-history-card-meta">' +
            '<span>Code: ' + escapeDespesaHtml(row.code || "-") + '</span>' +
            '<span>Var: ' + escapeDespesaHtml(row.variation || "-") + '</span>' +
          '</div>' +
        '</div>';
      }).join("");
    }

  } catch (e) {
    console.error("Erro historico achat:", e);
    if (body) body.innerHTML = '<tr><td colspan="10" class="empty">Erro ao carregar historico</td></tr>';
    if (cards) cards.innerHTML = '<div class="empty">Erro ao carregar historico</div>';
    toast("Erro historico compra: " + (e.message || e), "error");
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

function initCompraLines() {
  achatLines = [{ date: new Date().toISOString().split('T')[0], productId: '', prod: '', code: '', category: '', variation: '', variations: [], photo: '', targetMargin: '', qty: 0, price: 0 }];
  paiementLines = [];
  renderCompraLines();
}

function addCompraLine() {
  achatLines.push({ date: new Date().toISOString().split('T')[0], productId: '', prod: '', code: '', category: '', variation: '', variations: [], photo: '', targetMargin: '', qty: 0, price: 0 });
  renderCompraLines();
  setTimeout(function() {
    var inputs = document.querySelectorAll('.al-prod');
    if (inputs.length) inputs[inputs.length-1].focus();
  }, 50);
}

function removeCompraLine(i) {
  if (achatLines.length <= 1) { toast('Tem que ter pelo menos uma linha!', 'error'); return; }
  achatLines.splice(i, 1);
  renderCompraLines();
}

function renderCompraCodeScannerInput(index, line) {
  var value = escapeDespesaHtml((line && line.code) || "");
  return '<div class="achat-code-scan-wrap">' +
    '<input type="text" data-achat-code-index="' + index + '" class="form-input achat-cell-input achat-code-input" value="' + value + '" placeholder="Codigo" oninput="achatLines[' + index + '].code=this.value">' +
    '<button type="button" class="achat-code-scan-btn" onclick="openCompraBarcodeScanner(' + index + ')" aria-label="Ler codigo de barras">' +
      (typeof azulIcon === "function" ? azulIcon("barcode") : "|||") +
    '</button>' +
  '</div>';
}

function renderCompraLines() {
  var tbody = document.getElementById('achat-lines-body');
  if (!tbody) return;
  var cur = window._currency || 'Kz';
  tbody.innerHTML = '';

  achatLines.forEach(function(line, i) {
    line.variations = line.variations && line.variations.length ? line.variations : parseVariationList(line.variation);
    var total = (line.qty || 0) * (line.price || 0);
    var variationChips = !line.variations.length ? '' : '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + line.variations.map(function(label, chipIndex) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:var(--surface2);border:1px solid var(--border);font-size:11px;">' + label + '<button type="button" onclick="removeCompraVariation(' + i + ',' + chipIndex + ')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;line-height:1;">x</button></span>';
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
          '<input type="file" accept="image/*" style="display:none;" onchange="handleCompraPhotoFile(event,' + i + ')">' +
        '</label>' +
        '</div>' +
      '</td>' +
      '<td class="achat-date-product-cell">' +
        '<div class="achat-field-stack" style="min-width:260px;">' +
          //Date
          '<input type="date" class="form-input achat-cell-input" value="' + line.date + '" onchange="achatLines[' + i + '].date=this.value">' +
          //Nom du produit
          '<input type="text" class="form-input achat-cell-input prod al-prod" value="' + (line.prod || '') + '" placeholder="Produto..." list="prodList" oninput="achatLines[' + i + '].prod=this.value;achatLines[' + i + '].productId=\'\'" onchange="applyCompraProductPreset(' + i + ', this.value)">' +
          '<div class="achat-mini-grid">' +
            //code du produit
            renderCompraCodeScannerInput(i, line) +
            //categorie
            '<input type="text" class="form-input achat-cell-input" value="' + (line.category || '') + '" placeholder="Categoria" oninput="achatLines[' + i + '].category=this.value">' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td>' +
        '<div class="achat-variation-stack">'+
          '<div class="achat-variation-box">'+
            //variation
            '<input type="text" class="form-input achat-cell-input" id="al-var-new-' + i + '" placeholder="Nova variacao">' +
            //bouton ajouter variable
            '<button type="button" onclick="addCompraVariation(' + i + ')" class="achat-add-var-btn">+</button>' +
          '</div>' +
          // variacao antiga caso o produto ja esteja registado
          variationChips +
          //selection image
          '<div class="achat-mini-grid">' +
            renderCompraCodeScannerInput(i, line) +
            '<input type="text" class="form-input achat-cell-input" value="' + (line.category || '') + '" placeholder="Categoria" oninput="achatLines[' + i + '].category=this.value">' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td>' +
        '<div class="achat-price-stack">' +
        //prix unitaire
        '<input type="number" class="form-input achat-cell-input price" value="' + (line.price || '') + '" placeholder="P. compra" min="0" step="0.01" oninput="achatLines[' + i + '].price=parseFloat(this.value)||0;renderCompraTotals();">' +
        '<div class="achat-price-row">'+
          //Quantidade
          '<input type="number" class="form-input achat-cell-input qty" value="' + (line.qty || '') + '" placeholder="Qtd" min="1" oninput="achatLines[' + i + '].qty=parseFloat(this.value)||0;renderCompraTotals();">' +
          //prix de vente
          '<input type="number" class="form-input achat-cell-input" value="' + (line.targetMargin || '') + '" placeholder="Preco venda" min="0" step="0.01" oninput="achatLines[' + i + '].targetMargin=this.value">' +
        '</div>' +
        '</div>' +
      '</td>' +
      //Montante total
      '<td class="achat-total-cell">' +
        //Montante total
        '<h4>Total</h4>'+
        '<span id="al-total-' + i + '"></span>' +
      '</td>' +
      //Supprimer 
      '<td style="text-align:center;">' +
        '<button onclick="removeCompraLine(' + i + ')" class="achat-remove-btn">Supprimer</button>' +
      '</td>';

    tbody.appendChild(tr);
  });

  renderCompraTotals();
}
function ensureMobileCompraControls() {
  var page = document.getElementById("page-achat");
  if (!page) return;

  if (!document.getElementById("mobileCompraAddBtn")) {
    var addBtn = document.createElement("button");
    addBtn.id = "mobileCompraAddBtn";
    addBtn.className = "mobile-achat-add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+";
    addBtn.onclick = function() {
      addCompraLine();
      renderMobileCompraSummary();
    };
    page.appendChild(addBtn);
  }

  if (!document.getElementById("mobileCompraSummary")) {
    var summary = document.createElement("div");
    summary.id = "mobileCompraSummary";
    summary.className = "mobile-achat-summary";
    page.appendChild(summary);
  }
}

function getCompraSummaryTotal() {
  return (achatLines || []).reduce(function(sum, line) {
    return sum + (Number(line.qty) || 0) * (Number(line.price) || 0);
  }, 0);
}

function getCompraSummaryCount() {
  return (achatLines || []).reduce(function(sum, line) {
    return sum + (Number(line.qty) || 0);
  }, 0);
}

function renderMobileCompraSummary() {
  ensureMobileCompraControls();

  var summary = document.getElementById("mobileCompraSummary");
  var addBtn = document.getElementById("mobileCompraAddBtn");

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
      '<div class="mobile-achat-summary-title">' + getCompraSummaryCount() + ' itens no pedido</div>' +
      '<div class="mobile-achat-summary-total">' + fmt(getCompraSummaryTotal()) + '</div>' +
    '</div>' +
    '<button class="mobile-achat-summary-btn" onclick="saveCompra()">Registar</button>';
}
function renderCompraTotals() {
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

  updateResteAPagor(total);

  if (typeof renderMobileCompraSummary === "function") {
    renderMobileCompraSummary();
  }
}

function toggleCredito() {
  var checked = document.getElementById('a-credit').checked;
  document.getElementById('a-credit-fields').style.display = checked ? 'block' : 'none';
  if (checked && paiementLines.length === 0) addPagamentoLine();
  renderPagamentoLines();
  renderMobileCompraSummary();
}

function addPagamentoLine() {
  var totalDu = achatLines.reduce(function(s,l) { return s+(l.qty||0)*(l.price||0); }, 0);
  var totalPago = paiementLines.reduce(function(s,p) { return s+(p.montant||0); }, 0);
  if (totalPago >= totalDu && paiementLines.length > 0) {
    toast('Total ja pago integralmente!', 'error'); return;
  }
  paiementLines.push({ date: new Date().toISOString().split('T')[0], montant: 0 });
  renderPagamentoLines();
}

function removePagamentoLine(i) {
  paiementLines.splice(i, 1);
  renderPagamentoLines();
}

function renderPagamentoLines() {
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
          'onchange="paiementLines['+i+'].montant=parseFloat(this.value)||0;renderPagamentoLines();">' +
      '</td>' +
      '<td style="padding:5px 8px;text-align:right;font-size:12px;font-weight:600;color:'+(reste>=0&&!over?'var(--green)':'var(--red)')+';">' +
        (over ? ' Depasse!' : new Intl.NumberFormat('pt-PT').format(Math.max(0,reste))+' '+cur) +
      '</td>' +
      '<td style="padding:5px 8px;text-align:center;">' +
        '<button onclick="removePagamentoLine('+i+')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:15px;opacity:0.6;">x</button>' +
      '</td>';
    tbody.appendChild(tr);
  });

  updateResteAPagor(totalDu);
}

async function saveCompra() {
  if (!requireAzulAction("purchase:create", "registar achat")) return;

  if (purchaseSaveInProgress) {
    toast("Compra ja esta a ser registada. Aguarde...", "error");
    return;
  }

  var supplier = document.getElementById("a-forn").value.trim();

  if (!supplier) {
    toast("Entra o fornecedor!", "error");
    return;
  }

  var items = (achatLines || []).map(function (line) {
    return {
      productId: line.productId || "",
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
  purchaseSaveInProgress = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "A registar...";
    btn.style.opacity = "0.6";
  }

  var purchasePayload = {
    forn: supplier,
    items: items,
    purchaseDate: (achatLines[0] && achatLines[0].date) || "",
    credit: document.getElementById("a-credit").checked,
    payments: paiementLines || []
  };

  try {
   await savePurchaseToSupabase(purchasePayload);

    toast("Compra registado!", "success");

    document.getElementById("a-forn").value = "";
    document.getElementById("a-credit").checked = false;

    initCompraLines();
    await loadProducts(true);
    if (document.getElementById("achat-panel-historico") && document.getElementById("achat-panel-historico").style.display !== "none") {
      loadCompraHistorique();
    }

  } catch (e) {
    console.error("Erro Supabase achat:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("purchase", purchasePayload);
      toast("Sem internet: achat garde pour synchroniser depois.", "success");
      document.getElementById("a-forn").value = "";
      document.getElementById("a-credit").checked = false;
      initCompraLines();
      return;
    }
    toast("Erro ao registar achat: " + (e.message || e), "error");

  } finally {
    purchaseSaveInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Compra";
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

  var debtTotal = await getSupplierDebtFromSupabase(supplier);
  if (amount > debtTotal + 0.01) {
    throw new Error("O pagamento nao pode ultrapassar a divida do fornecedor. Divida actual: " + fmt(debtTotal) + ".");
  }

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
    row.statut = row.saldo > 0 ? "Aberto" : "Tout paye";
    return row;
  }).sort(function(a, b) {
    return b.saldo - a.saldo;
  });
}


// ===== PAGAMENTO FORNECEDOR =====
async function savePagamentoForn() {
  if (!requireAzulAction("supplier_payment:create", "registar pagamento fornecedor")) return;

  if (supplierPaymentInProgress) {
    toast("Pagamento ja esta a ser registado. Aguarde...", "error");
    return;
  }

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

  supplierPaymentInProgress = true;
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
    supplierPaymentInProgress = false;
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
            '<div style="font-size:15px;font-weight:800;">' + escapeDespesaHtml(d.forn) + '</div>' +
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
async function getStockTransfersFromSupabase(filters) {
  var organizationId = getAzulOrganizationId();
  filters = filters || {};

  var query = supabaseClient
    .from("stock_transfers")
    .select("*")
    .eq("organization_id", organizationId)
    .order("transfer_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(300);

  if (filters.from) query = query.gte("transfer_date", filters.from);
  if (filters.to) query = query.lte("transfer_date", filters.to);

  var result = await query;

  if (result.error) {
    if (isStockTransferHistoryMissing(result.error)) return { missing: true, rows: [] };
    throw result.error;
  }

  var rows = result.data || [];
  var search = String(filters.search || "").trim().toLowerCase();

  if (search) {
    rows = rows.filter(function(row) {
      return [
        row.product_name,
        row.from_location,
        row.to_location,
        row.note,
        row.user_name
      ].join(" ").toLowerCase().indexOf(search) >= 0;
    });
  }

  return { missing: false, rows: rows };
}

async function loadTransferHistory() {
  var body = document.getElementById("transferHistoryBody");
  if (!body) return;

  body.innerHTML = '<tr><td colspan="7" class="empty">A carregar...</td></tr>';
  renderMobileTransferHistory([]);

  try {
    var result = await getStockTransfersFromSupabase({
      from: (document.getElementById("transfer-history-from") || {}).value || "",
      to: (document.getElementById("transfer-history-to") || {}).value || "",
      search: (document.getElementById("transfer-history-search") || {}).value || ""
    });

    if (result.missing) {
      body.innerHTML = '<tr><td colspan="7" class="empty">Cria a tabela stock_transfers no Supabase para activar o historico.</td></tr>';
      renderMobileTransferHistory([]);
      return;
    }

    var rows = result.rows || [];

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma transferencia encontrada</td></tr>';
      renderMobileTransferHistory([]);
      return;
    }

    body.innerHTML = rows.map(function(row) {
      return '<tr>' +
        '<td>' + escapeDespesaHtml(row.transfer_date || '') + '</td>' +
        '<td>' + escapeDespesaHtml(row.product_name || '') + '</td>' +
        '<td>' + (Number(row.quantity) || 0) + '</td>' +
        '<td>' + escapeDespesaHtml(row.from_location || 'Armazem') + '</td>' +
        '<td>' + escapeDespesaHtml(row.to_location || 'Loja') + '</td>' +
        '<td>' + escapeDespesaHtml(row.note || '') + '</td>' +
        '<td>' + renderActionAuthor(row) + '</td>' +
      '</tr>';
    }).join('');

    renderMobileTransferHistory(rows);
  } catch (e) {
    console.error("Erro historico transferencias:", e);
    body.innerHTML = '<tr><td colspan="7" class="empty">Erro ao carregar historico</td></tr>';
    renderMobileTransferHistory([]);
    toast("Erro historico transferencias: " + (e.message || e), "error");
  }
}

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
    var transferInfo = await transferProductToShop(data.prod, data.qty);
    await recordStockTransfers([{
      organization_id: getAzulOrganizationId(),
      transfer_date: data.date || new Date().toISOString().split("T")[0],
      product_id: transferInfo.product_id || null,
      product_name: transferInfo.product_name || data.prod,
      quantity: data.qty,
      from_location: "Armazem",
      to_location: "Loja",
      transfer_type: "single_to_shop",
      note: data.obs || ""
    }]);

    await createAzulNotification({
      actionType: "stock:transfer",
      title: getAzulCurrentUserName() + " transferiu stock",
      message: data.prod + " - " + data.qty + " unidade(s)",
      sourceType: "stock_transfer",
      details: {
        product: data.prod,
        quantity: data.qty
      }
    });

    toast("Transferencia registada!", "success");

    document.getElementById("t-prod").value = "";
    document.getElementById("t-qty").value = "";
    document.getElementById("t-obs").value = "";

    await loadProducts(true);
    if (document.getElementById("transferHistorico") && document.getElementById("transferHistorico").style.display !== "none") {
      await loadTransferHistory();
    }

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
        "<td>" + escapeDespesaHtml(v.date || "") + "</td>" +
        "<td>" + escapeDespesaHtml(v.prod || "") + "</td>" +
        "<td>" + escapeDespesaHtml(v.client || "-") + "</td>" +
        "<td>" + v.qty + "</td>" +
        "<td>" + fmt(v.punit) + "</td>" +
        '<td style="color:var(--blue);font-weight:600">' + fmt(v.total) + "</td>" +
        '<td><span class="tbadge ' + payClass + '">' + escapeDespesaHtml(v.pay || "-") + "</span></td>" +
        '<td style="font-size:10px;color:var(--muted)">' +
          '<div>' + escapeDespesaHtml(v.recibo || "-") + '</div>' +
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
  slogan: 'O sistema de gestao que o seu negocio merece',
  currency: 'Kz',
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
  var loja = document.getElementById('stock-opt-loja');
  var armazem  = document.getElementById('stock-opt-armazem');
  if (loja) loja.style.borderColor = mode === 'loja' ? (selectedSetupColor || '#0b3d91') : '#e0e0e0';
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
    b.style.background = 'color-mix(in srgb, var(--blue) 10%, transparent)';
  });
  applyConfig();
}

function finishSetup() {
  var name = document.getElementById('setup-name').value.trim();
  if (!name) { alert('Por favor insere o nome da loja!'); return; }
  config.name = name;
  config.slogan = document.getElementById('setup-slogan').value.trim() || 'O sistema de gestao que o seu negocio merece';
  config.currency = document.getElementById('setup-currency').value;
  config.stockMode = document.querySelector('input[name="stockMode"]:checked').value; // 'loja' ou 'armazem'
  config.armazem = config.stockMode === 'armazem'; // true se for armazem, false se for apenas loja
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
  mode = mode === 'armazem' ? 'armazem' : 'loja';
  config.stockMode = mode;
  config.armazem   = mode === 'armazem';
  var toggle = document.getElementById('toggleArmazem');
  if (toggle) toggle.checked = config.armazem;
  // Highlight selected option
  var b = document.getElementById('cfg-stock-loja');
  var a = document.getElementById('cfg-stock-armazem');
  if (b) b.style.borderColor = mode === 'loja' ? 'var(--blue)' : 'var(--border)';
  if (a) a.style.borderColor = mode === 'armazem'  ? 'var(--blue)' : 'var(--border)';
  // Sync radio
  var radios = document.querySelectorAll('input[name="cfgStockMode"]');
  radios.forEach(function(r) { r.checked = r.value === mode; });
  saveConfig();
  applyConfig();
  applyStockModeUi();
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
////////////////////////////// Textos fixos em portugues /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
function getLocale() {
  return 'pt-PT';
}


function getText(key) {
  var dict = {
      revconsselect : 'Selecione um consignacao.',
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
      tab_online: 'Venda Online',
      tab_logistica: 'Logistica',
      save_settings: 'Guardar configuracoes',
      reset_setup: 'Reiniciar configuracao',
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
      rev_create: 'Criar Consignacao',
      rev_pay: 'Confirmar Pagamento',
      rev_return: 'Retornar Mercadoria',
      rev_open: 'Consignacao aberta',
      rev_name: 'Nome do revendedor',
      rev_search: 'Pesquisar produto...',
      rev_price_placeholder: 'Preco consignacao...',
      sale_price_placeholder: 'Preco venda...',
      anonymous: 'Anonimo',
      receipt_thanks: 'Obrigado por escolher ',
      receipt_footer_default: 'Obrigado pela sua preferencia!',
      settings_saved: 'Configuracoes guardadas!',
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
      no_open_consignment: 'Nenhuma consignacao aberta',
      reseller_required: 'Entra o nome do revendedor!',
      add_one_product: 'Ajoute ao menos um produto!',
      enter_price_for: 'Entra o preco para {name}',
      consignment_created: 'Consignacao criada: {id}',
      consignment_paid: 'Consignacao paga com sucesso!',
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
      stock_insufficient_consignment: 'Stock insuficiente para consignacao.',
      stock_insufficient_product: 'Stock insuficiente para este produto.',
      at_least_one_line: 'Tem que ter pelo menos uma linha!',
      purchase_fully_paid: 'Total ja pago integralmente!',
      fill_supplier_name: 'Entra o nome do fornecedor!',
      fill_all_product_fields: 'Preenche todos os campos de cada produto!',
      purchase_payment_too_high: 'O total dos pagamentos ultrapassa o total da encomenda!',
      purchase_registered: 'Compra registada com sucesso!',
      fill_supplier_and_amount: 'Preenche fornecedor e montante!',
      supplier_payment_registered: 'Pagamento registado!',
      no_supplier_debts: 'Sem dividas registadas',
      fill_product_and_quantity: 'Preenche produto e quantidade!',
      transfer_registered: 'Transferencia registada!',
      no_sales_found: 'Nenhuma venda encontrada',
      finish_setup_name_required: 'Por favor insere o nome da loja!',
      setup_saved: 'Configuracao guardada!',
      warehouse_empty: 'Armazem vazio - nada a transferir',
      products_to_transfer: '{count} produtos a transferir',
      no_warehouse_stock: 'Nenhum stock no armazem!',
      transferring: 'A transferir...',
      transferred: 'Transferido!',
      transfer_done_reload: 'Transferencia concluida! Recarrega o stock para confirmar.',
      all_stock_transferred: 'Todo o stock transferido para a loja!',
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
      stock_shop_only: 'Stock apenas na loja',
      stock_shop_only_desc: 'Compras entram directamente na loja. Sem transferencias.',
      stock_shop_warehouse: 'Stock loja + armazem',
      stock_shop_warehouse_desc: 'Compras entram no armazem, depois transferes para a loja.',
      receipt_customization: 'Personalizacao do recibo',
      receipt_logo_image: 'Imagem do logo do recibo',
      receipt_logo_remove: 'Remover imagem',
      receipt_logo_size: 'Tamanho do logo do recibo',
      receipt_show: 'Mostrar no recibo',
      direct_edit_mode: 'Modo de edicao directa',
      direct_edit_desc:'Desbloqueia as folhas por 1 minuto para corrigir ou eliminar linhas. Bloqueia automaticamente depois',
      client_file_tab: 'Ficha cliente',
      client_payment_tab: 'Registar pagamento',
      search_client_placeholder: 'Nome do cliente...',
      search_button: 'Pesquisar',
      client_search_empty: 'Pesquisa um cliente para ver a sua ficha',
      client_payment_title: 'Registar Pagamento do Cliente',
      amount_paid: 'Montante pago',
      amount_remaining: 'Montante restante',
      credit_limit_warning: 'ultrapassou o limite do credito',
      new_expense_tab: 'Nova Despesa',
      expense_dashboard_tab: 'Dashboard de Despesas',
      expense_history_tab: 'Historico Despesas',
      expense_category_new: 'Nova categoria...',
      add_button: 'Adicionar',
      register_expense_button: 'Registar Despesa',
      register_purchase_button: 'Registar Compra',
      save_product_profile: 'Guardar ficha do produto',
      registering: 'A registar...',
      create_consignment_button: 'Criar Consignacao',
      confirm_payment_button: 'Confirmar pagamento',
      confirm_return_button: 'Confirmar retorno'
    };
  return dict[key] || key;
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
  setPageTitle('page-logistica', getText('tab_logistica'));
}
//appl
function applyPortugueseText() {
  window._applyingLanguage = true;
  try {
    document.documentElement.lang = 'pt';
    var tabs = document.querySelectorAll('.nav .tab');
    var keys = ['tab_dashboard','tab_venda','tab_achat','tab_transfert','tab_clientes','tab_depenses','tab_rh','tab_forn','tab_tresorerie','tab_comptabilite','tab_corrections','tab_revendeurs','tab_online','tab_logistica','tab_settings'];
    tabs.forEach(function(tab, index) {
      if (keys[index]) tab.textContent = getText(keys[index]);
    });

    var ui = {
      dashLabels: ['Periodo','De','Ate','Produto','Fornecedor'],
      dashOptions: ['Hoje','Esta semana','Este mes','Personalizado'],
      kpiLabels: ['Vendas','Lucro','Despesas','Alertas Stock'],
      kpiSubProfit: 'Receita - Custo',
      kpiSubAlerts: 'produtos em falta',
      dashCards: ['Top Produtos','Meios de Pagamento','Alertas de Stock Baixo','Ultimas Despesas'],
      payLabels: ['Cash','Express','Cartao'],
      achatTabs: ['Nova Compra','Registar Pagamento','Resumo de Dividas'],
      histHeaders: ['Data','Produto','Cliente','Qtd','P.Unit','Total','Pagamento','N Recibo'],
      settingsCards: ['Identidade da loja','Moeda','Tema','Modo de Stock','Personalizacao do Recibo','Seguranca'],
      resellerCards: ['Nova Consignacao','Artigos em consignacao','Acoes','Ficha Revendedor'],
      treasuryCards: ['Novo Movimento','Filtros','Historico dos Movimentos'],
      kpiLabelTreso: ['Saldo atual','Entradas','Saidas'],
      tresoformlabel: ['Data','Movimento','Tipo','Montante','Descricao','De','A','O tipo contem'],
      tresotabletext: ['Data','Tipo','Descricao','Entradas','Saidas','Saldo'],
      tresobuttontext: ['Atualizar','Registar Movimento','Aplicar filtros'],
      dashtext: ['Dashboard de Despesas','De','Ate','Categoria','Total de Despesas','Media','Por despesa','Maximo','Categoria','Hoje','Despesas do dia','Por categoria','Evolucao diaria'],
      histdeptext: ['Historico de Despesas','Data','Categoria','Descricao','Montante'],
      ongletrevtext: ['Nova','Pagamento / Retorno','Historico do Revendedor'],
      pagamentoLabelText: ['Data','Fornecedor','Montante pago','Montante restante: ','Nota (opcional)'],
      enredepensetext: ['Data','Tipo','Descricao','Montante'],
      titreconsigntiontext: 'Registar consignacao',
      revFormLabels: ['Data','Nome do revendedor','Revendedor','Data da acao','Acao','Revendedor','De','A'],
      revTableHeaders: ['ID','Data','Revendedor','Estado','Artigos','Total','Pagamento','Recibo'],
      revModeBtnTexts: ['Nova Consignacao','Pagamento / Retorno','Historico do Revendedor'],
      revSectionTitleTexts: ['Revendedores','Registar Consignacao','Pagamento e Retorno','Historico do Revendedor'],
      inventairetabletext: ['Designacao','Fornecedor','Entradas','Saidas','Stock da Loja','Stock do Deposito','Total','Preco de Compra','Valor'],
      kpiInventairetext: ['Stock Total','Valor Total do Stock','Stock em Armazem','Valor do Stock em Armazem','Stock da Loja','Valor do Stock da Loja'],
      inventairetitretext: ['Inventarios']
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
    var revFormLabel = document.querySelectorAll('#page-revendeurs .form-label');
    revFormLabel.forEach(function(el, i) { if (ui.revFormLabels[i]) el.textContent = ui.revFormLabels[i]; });
    var revTableHeader = document.querySelectorAll('#page-revendeurs th');
    revTableHeader.forEach(function(el, i) { if (ui.revTableHeaders[i]) el.textContent = ui.revTableHeaders[i]; });

    if (document.getElementById('rev-name')) document.getElementById('rev-name').placeholder = 'Insere o nome do revendedor';
    if (document.getElementById('rev-search')) document.getElementById('rev-search').placeholder = 'Pesquisar produto...';
    if (document.getElementById('rev-history-name')) document.getElementById('rev-history-name').placeholder = 'Nome do revendedor';
    var revActionType = document.getElementById('rev-action-type');
    if (revActionType) {
      if (revActionType.options[0]) revActionType.options[0].text = 'Pagamento';
      if (revActionType.options[1]) revActionType.options[1].text = 'Retorno de mercadoria';
    }
    var revAddPayBtn = document.querySelector('#rev-payment-panel button[onclick="addRevPayLine()"]');
    if (revAddPayBtn) revAddPayBtn.textContent = '+ Adicionar meio de pagamento';
    var revTotalPayLabel = document.querySelector('#rev-payment-total');
    if (revTotalPayLabel && revTotalPayLabel.previousElementSibling) revTotalPayLabel.previousElementSibling.textContent = 'Total a pagar';
    var revManageName = document.getElementById('rev-manage-name');
    if (revManageName && revManageName.options[0]) revManageName.options[0].text = 'Escolher um revendedor';

    var enredepense = document.querySelectorAll('#dep-panel-new .form-label');
    enredepense.forEach(function(el, i) { if (ui.enredepensetext[i]) el.textContent = ui.enredepensetext[i]; });
    if (document.getElementById('dep-desc')) document.getElementById('dep-desc').placeholder = 'Descricao da despesa...';

    var pagamentoLabel = document.querySelectorAll('#achat-panel-pagamento .form-label');
    pagamentoLabel.forEach(function(el, i) { if (ui.pagamentoLabelText[i]) el.textContent = ui.pagamentoLabelText[i]; });

    var dashFormLabels = document.querySelectorAll('#page-dashboard .form-label');
    dashFormLabels.forEach(function(el, i) { if (ui.dashLabels[i]) el.textContent = ui.dashLabels[i]; });
    var tresobutton = document.querySelectorAll('#page-tresorerie button');
    tresobutton.forEach(function(el, i) { if (ui.tresobuttontext[i]) el.textContent = ui.tresobuttontext[i]; });
    var tresokpilabels = document.querySelectorAll('#page-tresorerie .kpi-label');
    tresokpilabels.forEach(function(el, i) { if (ui.kpiLabelTreso[i]) el.textContent = ui.kpiLabelTreso[i]; });
    var tresoformlabels = document.querySelectorAll('#page-tresorerie .form-label');
    tresoformlabels.forEach(function(el, i) { if (ui.tresoformlabel[i]) el.textContent = ui.tresoformlabel[i]; });
    var tresotable = document.querySelectorAll('#page-tresorerie .data-table th');
    tresotable.forEach(function(el, i) { if (ui.tresotabletext[i]) el.textContent = ui.tresotabletext[i]; });
    if (document.getElementById('tre-desc')) document.getElementById('tre-desc').placeholder = 'Descricao do movimento...';
    if (document.getElementById('tre-filter-type')) document.getElementById('tre-filter-type').placeholder = 'Ex: Venda, Despesa, Compra...';

    var periodSelect = document.getElementById('df-period');
    if (periodSelect) ui.dashOptions.forEach(function(txt, i) { if (periodSelect.options[i]) periodSelect.options[i].text = txt; });
    if (document.getElementById('df-prod')) document.getElementById('df-prod').placeholder = 'Todos';
    if (document.getElementById('df-forn')) document.getElementById('df-forn').placeholder = 'Todos';
    var dashBtn = document.getElementById('dashApplyBtn');
    if (dashBtn) dashBtn.textContent = 'Aplicar';
    var dashPrintBtn = document.getElementById('dashPrintBtn');
    if (dashPrintBtn) dashPrintBtn.textContent = 'Imprimir';
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
    var clearBtn = document.querySelector('.cart-actions .ghost');
    if (clearBtn) clearBtn.textContent = getText('clear_cart');
    var saleAddPay = document.querySelector('.payment-box button[onclick="addSalePaymentLine()"]');
    if (saleAddPay) saleAddPay.textContent = getText('add_payment_method');
    var saleProgress = document.getElementById('sale-progress');
    if (saleProgress) saleProgress.textContent = getText('register_sale');
    var paymentConfirmBtn = document.querySelector('#payment-modal .payment-confirm');
    if (paymentConfirmBtn) paymentConfirmBtn.textContent = getText('confirm_sale');
    var paymentProgress = document.getElementById('payment-progress');
    if (paymentProgress) paymentProgress.textContent = getText('register_sale');
    var paymentModalTitle = document.querySelector('#payment-modal .payment-title');
    if (paymentModalTitle) paymentModalTitle.textContent = getText('payment');
    var paymentModalAdd = document.querySelector('#payment-modal button[onclick="addSalePaymentLine()"]');
    if (paymentModalAdd) paymentModalAdd.textContent = getText('add_payment_method');

    ['achat-tab-novo','achat-tab-pagamento','achat-tab-resumo'].forEach(function(id, i) {
      var el = document.getElementById(id);
      if (el) el.textContent = ui.achatTabs[i];
    });
    var histHeaders = document.querySelectorAll('#histBody').length ? document.querySelectorAll('#page-venda th') : [];
    histHeaders.forEach(function(el, i) { if (ui.histHeaders[i]) el.textContent = ui.histHeaders[i]; });
    var themeLight = document.getElementById('cfg-theme-light');
    if (themeLight) themeLight.textContent = getText('light_theme');
    var themeDark = document.getElementById('cfg-theme-dark');
    if (themeDark) themeDark.textContent = getText('dark_theme');
    var stockBoutique = document.querySelector('#cfg-stock-loja strong');
    if (stockBoutique) stockBoutique.textContent = getText('stock_shop_only');
    var stockBoutiqueDesc = document.querySelector('#cfg-stock-loja small');
    if (stockBoutiqueDesc) stockBoutiqueDesc.textContent = getText('stock_shop_only_desc');
    var stockArmazem = document.querySelector('#cfg-stock-armazem strong');
    if (stockArmazem) stockArmazem.textContent = getText('stock_shop_warehouse');
    var stockArmazemDesc = document.querySelector('#cfg-stock-armazem small');
    if (stockArmazemDesc) stockArmazemDesc.textContent = getText('stock_shop_warehouse_desc');
    var settingsCards = document.querySelectorAll('#page-settings .settings-grid .card > .card-title');
    settingsCards.forEach(function(el, i) { if (ui.settingsCards[i]) el.textContent = ui.settingsCards[i]; });
    var receiptLabels = document.querySelectorAll('#page-settings .settings-grid .card:nth-child(5) .form-label');
    [getText('receipt_logo_image'), getText('receipt_logo_size'), getText('receipt_show')].forEach(function(txt, i) {
      if (receiptLabels[i]) receiptLabels[i].textContent = txt;
    });
    var clearLogoBtn = document.getElementById('cfg-logo-clear');
    if (clearLogoBtn) clearLogoBtn.textContent = getText('receipt_logo_remove');
    var editModeTitle = document.querySelector('#page-settings .settings-grid .card:nth-child(6) .card-title');
    if (editModeTitle) editModeTitle.textContent = getText('direct_edit_mode');
    var editModeDesc = document.querySelector('#page-settings .settings-grid .card:nth-child(6) p');
    if (editModeDesc) editModeDesc.textContent = getText('direct_edit_desc');
    var saveSettingsBtn = document.querySelector('button[onclick="saveSettings()"]');
    if (saveSettingsBtn) saveSettingsBtn.textContent = getText('save_settings');
    var productProfileBtn = document.getElementById('product-profile-save-btn');
    if (productProfileBtn && !productProfileBtn.disabled) productProfileBtn.textContent = getText('save_product_profile');
    var resetSetupBtn = document.querySelector('button[onclick="resetSetup()"]');
    if (resetSetupBtn) resetSetupBtn.textContent = getText('reset_setup');
    var editModeBtn = document.getElementById('editModeBtn');
    if (editModeBtn && !editModeBtn.disabled && editModeBtn.textContent.indexOf('ACT') === -1) editModeBtn.textContent = getText('edit_mode_button');
    var revSaveBtn = document.getElementById('rev-save-btn');
    if (revSaveBtn) revSaveBtn.textContent = getText('rev_create');
    var revCards = document.querySelectorAll('#page-revendeurs .card-title');
    revCards.forEach(function(el, i) { if (ui.resellerCards[i]) el.textContent = ui.resellerCards[i]; });
    var revAction = document.querySelector('#rev-action-card');
    if (revAction) {
      var labels = revAction.querySelectorAll('.form-label');
      if (labels[1]) labels[1].textContent = getText('rev_name');
      if (labels[2]) labels[2].textContent = getText('rev_open');
      var actions = revAction.querySelectorAll('button');
      if (actions[0]) actions[0].textContent = getText('rev_create');
      if (actions[1]) actions[1].textContent = getText('rev_pay');
      if (actions[2]) actions[2].textContent = getText('rev_return');
    }
    var treasuryCards = document.querySelectorAll('#page-tresorerie .card-title');
    treasuryCards.forEach(function(el, i) { if (ui.treasuryCards[i]) el.textContent = ui.treasuryCards[i]; });
    var clientTabFiche = document.getElementById('client-tab-fiche');
    if (clientTabFiche) clientTabFiche.textContent = getText('client_file_tab');
    var clientTabPayment = document.getElementById('client-tab-pagamento');
    if (clientTabPayment) clientTabPayment.textContent = getText('client_payment_tab');
    var clientSearch = document.getElementById('clientSearch');
    if (clientSearch) clientSearch.placeholder = getText('search_client_placeholder');
    var clientSearchBtn = document.querySelector('#page-clientes button[onclick="searchClientFicha()"]');
    if (clientSearchBtn) clientSearchBtn.textContent = getText('search_button');
    var clientInitialEmpty = document.querySelector('#clientFichaResult .empty');
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
    var depAddCat = document.querySelector('button[onclick="addDespesaCategory()"]');
    if (depAddCat) depAddCat.textContent = getText('add_button');
    var depBtn = document.getElementById('dep-btn');
    if (depBtn && !depBtn.disabled) depBtn.textContent = getText('register_expense_button');

    var cartEmpty = document.querySelector('#cartItems .empty');
    if (cartEmpty) cartEmpty.textContent = getText('cart_empty');
    var prodEmpty = document.querySelector('#productsGrid .empty');
    if (prodEmpty && !productsLoading) prodEmpty.textContent = getText('no_products');
    var topEmpty = document.querySelector('#topProdutos .empty');
    if (topEmpty) topEmpty.textContent = getText('no_data');
    var depEmpty = document.querySelector('#ultimasDespesas .empty');
    if (depEmpty) depEmpty.textContent = getText('no_expenses');
    var revProdEmpty = document.querySelector('#revProducts .empty');
    if (revProdEmpty) revProdEmpty.textContent = getText('no_products');
    var revCartEmpty = document.querySelector('#revCart .empty');
    if (revCartEmpty) revCartEmpty.textContent = getText('add_products');
    var revDetailEmpty = document.querySelector('#revOpenDetail .empty');
    if (revDetailEmpty) revDetailEmpty.textContent = getText('loading');
    var resumoEmpty = document.querySelector('#resumoDividas .empty');
    if (resumoEmpty && resumoEmpty.textContent.indexOf('dettes') >= 0) resumoEmpty.textContent = getText('no_supplier_debts');
    var tresoEmpty = document.querySelector('#tresoBody .empty');
    if (tresoEmpty) tresoEmpty.textContent = getText('loading');
    var clientEmpty = document.querySelector('#clientFichaResult .empty');
    if (clientEmpty && clientEmpty.textContent.indexOf('cliente') >= 0) clientEmpty.textContent = getText('loading');
    syncPageTitles();
    applyAzulIcons();
  } catch (e) {
    console.error('applyPortugueseText failed', e);
  } finally {
    window._applyingLanguage = false;
  }
}
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////// Fim dos textos fixos em portugues /////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Textos fixos aplicados apenas por configuracao/carregamento para evitar loops de UI.
function saveAllSettings() {
  config.name     = document.getElementById('cfg-name').value.trim() || config.name;
  config.slogan   = document.getElementById('cfg-slogan').value.trim() || config.slogan;
  config.currency = document.getElementById('cfg-currency').value;

  // Champs du recibo
  config.address     = document.getElementById('cfg-address').value.trim();
  config.phone       = document.getElementById('cfg-phone').value.trim();
  config.footer      = document.getElementById('cfg-footer').value.trim() || 'Obrigado pela sua preferencia!';
  config.receiptFont = (document.getElementById('cfg-font') || {}).value || config.receiptFont || 'DM Sans';
  config.receiptFontSize = (document.getElementById('cfg-font-size') || {}).value || config.receiptFontSize || '10';
  config.receiptLogo = ((document.getElementById('cfg-logo-url') || {}).value || '').trim();
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
  var modeRadio = document.querySelector('input[name="cfgStockMode"]:checked');
  if (modeRadio) {
    config.stockMode = modeRadio.value === 'armazem' ? 'armazem' : 'loja';
    config.armazem = config.stockMode === 'armazem';
  } else {
    var toggle = document.getElementById('toggleArmazem');
    config.armazem = !!(toggle && toggle.checked);
    config.stockMode = config.armazem ? 'armazem' : 'loja';
  }
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
  root.setAttribute('data-theme', selectedSetupTheme);
  var themeBackground = selectedSetupTheme === 'dark' ? '#0b0f14' : '#ffffff';
  var readableColor = readableAccentColor(selectedSetupColor, themeBackground);
  var readableColor2 = readableAccentColor(selectedSetupColor2, themeBackground);
  root.style.setProperty('--blue', readableColor);
  root.style.setProperty('--blue2', readableColor2);
  root.style.setProperty('--accent-text', textOnColor(readableColor));
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', readableColor);

  // Apply theme
  if (selectedSetupTheme === 'dark') {
    root.style.setProperty('--bg', '#0b0f14');
    root.style.setProperty('--surface', '#151a21');
    root.style.setProperty('--surface2', '#202733');
    root.style.setProperty('--border', '#364152');
    root.style.setProperty('--text', '#f8fafc');
    root.style.setProperty('--muted', '#b6c0cc');
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

  applyPortugueseText();
  // Sincronizar campos do recibo
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
  // Sincronizar campos do recibo
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
    btn.style.background = isActive ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : '';
  });

  // Sync stock mode radios
  var modeVal = config.stockMode || (config.armazem ? 'armazem' : 'loja');
  if (modeVal === 'boutique') modeVal = 'loja';
  var radios = document.querySelectorAll('input[name="cfgStockMode"]');
  radios.forEach(function(r) { r.checked = r.value === modeVal; });
  var b = document.getElementById('cfg-stock-loja');
  var a = document.getElementById('cfg-stock-armazem');
  if (b) b.style.borderColor = modeVal === 'loja' ? 'var(--blue)' : 'var(--border)';
  if (a) a.style.borderColor = modeVal === 'armazem'  ? 'var(--blue)' : 'var(--border)';
  // Armazem toggle (hidden, kept for compatibility)
  var toggle = document.getElementById('toggleArmazem');
  if (toggle) toggle.checked = config.armazem;

  applyStockModeUi();
}

function applyStockModeUi() {
  var warehouseMode = isWarehouseStockMode();
  var singleBtn = document.getElementById("modeSingle");
  var tudoBtn = document.getElementById("modeTudo");
  var stockBtn = document.getElementById("modestock");
  var singlePanel = document.getElementById("transferSingle");
  var tudoPanel = document.getElementById("transferTudo");
  var stockPanel = document.getElementById("stock");
  var historyPanel = document.getElementById("transferHistorico");

  if (singleBtn) singleBtn.style.display = warehouseMode ? "" : "none";
  if (tudoBtn) tudoBtn.style.display = warehouseMode ? "" : "none";

  if (!warehouseMode) {
    if (singlePanel) singlePanel.style.display = "none";
    if (tudoPanel) tudoPanel.style.display = "none";
    if (stockPanel && (!historyPanel || historyPanel.style.display === "none")) stockPanel.style.display = "block";
    if (singleBtn) singleBtn.classList.remove("active");
    if (tudoBtn) tudoBtn.classList.remove("active");
    if (stockBtn && (!historyPanel || historyPanel.style.display === "none")) stockBtn.classList.add("active");
  }
}

// ===== TRANSFERENCIA MODO TOGGLE =====
function switchMode(mode, btn) {
  if (!isWarehouseStockMode() && mode !== 'stock' && mode !== 'historico') {
    mode = 'stock';
    btn = document.getElementById('modestock') || btn;
  }

  document.querySelectorAll('#page-transfert .mode-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn && btn.classList) btn.classList.add('active');
  document.getElementById('transferSingle').style.display = mode === 'single' ? 'block' : 'none';
  document.getElementById('transferTudo').style.display = mode === 'tudo' ? 'block' : 'none';
  document.getElementById('stock').style.display = mode === 'stock' ? 'block' : 'none';
  document.getElementById('transferHistorico').style.display = mode === 'historico' ? 'block' : 'none';

  if (mode === 'stock') {
    loadProducts(true);
  }
  if (mode === 'historico') {
    loadTransferHistory();
  }

  applyStockModeUi();
}

var stockArmazem = [];

async function carregarStockArmazem() {
  var el = document.getElementById("tudo-preview");
  var btn = document.getElementById("btnTudoLoja");

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
        escapeDespesaHtml(p.name || "") +
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

async function transferirTudoLoja() {
  var btn = document.getElementById("btnTudoLoja");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "A transferir...";
  }

  try {
    var movedRows = await transferAllProductsToShop();
    var count = movedRows.length;
    var today = new Date().toISOString().split("T")[0];

    await recordStockTransfers(movedRows.map(function(row) {
      return {
        organization_id: getAzulOrganizationId(),
        transfer_date: today,
        product_id: row.product_id || null,
        product_name: row.product_name || "",
        quantity: Number(row.quantity) || 0,
        from_location: "Armazem",
        to_location: "Loja",
        transfer_type: "all_to_shop",
        note: "Transferencia total para loja"
      };
    }));

    await createAzulNotification({
      actionType: "stock:transfer",
      title: getAzulCurrentUserName() + " transferiu todo o stock",
      message: count + " produto(s) enviados para a loja",
      sourceType: "stock_transfer",
      details: {
        count: count,
        type: "all_to_shop"
      }
    });

    stockArmazem = [];
    document.getElementById("tudo-preview").innerHTML =
      '<div class="empty">Transferencia concluida! Todo o stock foi enviado para a loja.</div>';

    toast(count + " produtos transferidos para a loja!", "success");

    await loadProducts(true);
    if (document.getElementById("transferHistorico") && document.getElementById("transferHistorico").style.display !== "none") {
      await loadTransferHistory();
    }

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
function getStoredDespesaCategorias() {
  var defaults = ['Loyer', 'Electricite', 'Transport', 'Salaire', 'Autre'];
  try {
    var raw = localStorage.getItem('depenseCategorias');
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

function saveStoredDespesaCategorias(list) {
  try {
    localStorage.setItem('depenseCategorias', JSON.stringify(list || []));
  } catch (e) {}
}

function renderDespesaCategorias(selectedValue) {
  var select = document.getElementById('dep-tipo');
  var categories = getStoredDespesaCategorias();
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

function addDespesaCategory() {
  var input = document.getElementById('dep-new-category');
  if (!input) return;
  var value = (input.value || '').trim();
  if (!value) {
    toast('Entre une categorie.', 'error');
    return;
  }
  var categories = getStoredDespesaCategorias();
  var exists = categories.some(function(item) { return item.toLowerCase() === value.toLowerCase(); });
  if (!exists) {
    categories.push(value);
    saveStoredDespesaCategorias(categories);
  }
  renderDespesaCategorias(value);
  input.value = '';
  toast('Categoria ajoutee !', 'success');
}

function escapeDespesaHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDespesaFilters() {
  return {
    from: (document.getElementById('dep-filter-from') || {}).value || '',
    to: (document.getElementById('dep-filter-to') || {}).value || '',
    category: (document.getElementById('dep-filter-category') || {}).value || ''
  };
}

function setDespesaLoading(isLoading) {
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
    btn.textContent = btn.getAttribute('data-original-text') || 'Aplicar';
  }
}

function renderDespesaCategoryChart(list) {
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
        '<strong>' + escapeDespesaHtml(item.category || '-') + '</strong>' +
        '<span>' + fmt(total) + '</span>' +
      '</div>' +
      '<div style="height:10px;border-radius:999px;background:var(--surface);overflow:hidden;">' +
        '<div style="height:100%;width:' + width + '%;background:linear-gradient(90deg,var(--blue),#f3d98b);border-radius:999px;"></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderDespesaDayChart(list) {
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
      '<div style="font-size:10px;text-align:center;line-height:1.2;">' + escapeDespesaHtml(item.date || '') + '</div>' +
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

function getProductVariationLabel(product) {
  product = product || {};
  var variations = Array.isArray(product.variations) ? product.variations : parseVariationList(product.variation || "");
  var label = variations.length ? variations.join(" / ") : String(product.variation || "").trim();
  return label || "Sem variacao";
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
  var valeurlojatext = document.getElementById('valeurloja');
  var nbrestock = document.getElementById('nbreStock');
  var nbrestocktotal = document.getElementById('nbreStocktotal');
  var nbreloja = document.getElementById('nbreloja');

  if (!body) return;

  function setInventoryText(el, value) {
    if (el) el.innerHTML = value;
  }

products = filterInventoryProducts(products || []);
renderMobileInventory(products);

  var valeurtotal = 0;
  var valeurTotalBoutique = 0;
  var valeurTotalStock = 0;
  var totalloja = 0;
  var totalstock = 0;
  var nbreProductTotal = 0;

  if (!products.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">Nenhum produto encontrado</td></tr>';
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
    var valeurloja = purchasePrice * stockBoutique;

    valeurtotal += valeur;
    valeurTotalBoutique += valeurloja;
    valeurTotalStock += valeurstock;

    nbreProductTotal += stocktotal;
    totalloja += stockBoutique;
    totalstock += stockage;

    return '<tr>' +
      '<td><strong>' + escapeDespesaHtml(product.name || '') + '</strong><br><small class="stock-variation-label">' + escapeDespesaHtml(getProductVariationLabel(product)) + '</small></td>' +
      '<td>' + escapeDespesaHtml(product.mainSupplier || '') + '</td>' +
      '<td>' + entries + '</td>' +
      '<td>' + exits + '</td>' +
      '<td>' + stockBoutique + '</td>' +
      '<td>' + stockage + '</td>' +
      '<td>' + stocktotal + '</td>' +
      '<td>' + fmt(purchasePrice) + '</td>' +
      '<td style="font-weight:600;color:var(--red);">' + fmt(valeur) + '</td>' +
    '</tr>';
  }).join('');

  setInventoryText(nbrestocktotal, nbreProductTotal);
  setInventoryText(valeurtext, fmt(valeurtotal));
  setInventoryText(valeurlojatext, fmt(valeurTotalBoutique));
  setInventoryText(valeurstocktext, fmt(valeurTotalStock));
  setInventoryText(nbrestock, totalstock);
  setInventoryText(nbreloja, totalloja);
}
function renderMobileDespesaHistory(rows) {
  var list = ensureMobileList("depHistoryBody", "mobileDespesaHistoryList");
  if (!list) return;

  rows = rows || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhuma despesa encontrada</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    return '<div class="mobile-expense-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.category || 'Despesa') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(row.description || 'Sem descricao') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.date || '') + '</div>' +
          '<div class="mobile-card-sub">' + renderActionAuthor(row) + '</div>' +
        '</div>' +
        '<div class="mobile-expense-amount">-' + fmt(row.amount || 0) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}
function renderDespesaHistory(rows) {
  var body = document.getElementById('depHistoryBody');
  if (!body) return;

  rows = rows || [];
  renderMobileDespesaHistory(rows);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Nenhuma despesa encontrada</td></tr>';
    return;
  }

  body.innerHTML = rows.map(function(row) {
    return '<tr>' +
      '<td>' + escapeDespesaHtml(row.date || '') + '</td>' +
      '<td>' + escapeDespesaHtml(row.category || '') + '</td>' +
      '<td>' + escapeDespesaHtml(row.description || '') + '<div>' + renderActionAuthor(row) + '</div></td>' +
      '<td style="font-weight:600;color:var(--red);">-' + fmt(row.amount || 0) + '</td>' +
    '</tr>';
  }).join('');
}

function renderDespesaDashboard(data) {
  data = data || {};
  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  setText('dep-kpi-total', fmt(data.total || 0));
  setText('dep-kpi-count', (data.count || 0) + ' registos');
  setText('dep-kpi-avg', fmt(data.average || 0));
  setText('dep-kpi-max', fmt(data.max || 0));
  setText('dep-kpi-max-cat', data.maxCategory || 'Categoria');
  setText('dep-kpi-today', fmt(data.todayTotal || 0));
  renderDespesaCategoryChart(data.byCategory || []);
  renderDespesaDayChart(data.byDay || []);
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

async function getDespesaDashboardFromSupabase(filters) {
  var rows = await getExpensesFromSupabase(filters);

  var total = rows.reduce(function(sum, row) {
    return sum + (Number(row.amount) || 0);
  }, 0);

  var count = rows.length;
  var average = count ? total / count : 0;
  var max = 0;
  var maxCategory = "Categoria";
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
async function loadDespesaInsights() {
  var filters = getDespesaFilters();

  setDespesaLoading(true);

  try {
    var dashboard = await getDespesaDashboardFromSupabase(filters);
    renderDespesaDashboard(dashboard || {});

    var rows = await getExpensesFromSupabase(filters);
    renderDespesaHistory(mapExpensesToHistoryRows(rows));

  } catch (e) {
    console.error("Erro depenses:", e);
    toast("Erro depenses: " + (e.message || e), "error");

  } finally {
    setDespesaLoading(false);
  }
}

function switchDespesaTab(tab, btn) {
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

function initDespesasPage() {
  renderDespesaCategorias();
  var today = localDateKey(new Date());
  var from = document.getElementById('dep-filter-from');
  var to = document.getElementById('dep-filter-to');
  if (from && !from.value) from.value = today.slice(0, 8) + '01';
  if (to && !to.value) to.value = today;
  loadDespesaInsights();
  var defaultBtn = document.getElementById('dep-tab-new');
  if (defaultBtn) switchDespesaTab('new', defaultBtn);
}

async function saveDespesa() {
  if (!requireAzulAction("expense:create", "registar despesa")) return;

  if (expenseSaveInProgress) {
    toast("Despesa ja esta a ser registada. Aguarde...", "error");
    return;
  }

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
  expenseSaveInProgress = true;

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
      "Despesa - " + expense.description,
      [
        { account: "62", debit: Number(expense.amount) || 0, credit: 0 },
        { account: "11", debit: 0, credit: Number(expense.amount) || 0 }
      ]
    );

    toast("Despesa registada!", "success");

    document.getElementById("dep-desc").value = "";
    document.getElementById("dep-montant").value = "";

    loadDespesaInsights();
    loadDashboard();

  } catch (e) {
    console.error("Erro despesa:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("expense", data);
      toast("Sem internet: despesa guardada para sincronizar depois.", "success");
      document.getElementById("dep-desc").value = "";
      document.getElementById("dep-montant").value = "";
      return;
    }
    toast("Erro despesa: " + (e.message || e), "error");

  } finally {
    expenseSaveInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Despesa";
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
      return '<option value="' + escapeDespesaHtml(emp.name || "") + '"></option>';
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
          '<td>' + escapeDespesaHtml(row.type) + '</td>' +
          '<td>' + escapeDespesaHtml(row.date || '') + '</td>' +
          '<td>' + escapeDespesaHtml(row.employee || '') + '</td>' +
          '<td>' + escapeDespesaHtml(row.detail || '') + '</td>' +
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
              '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.type || 'RH') + '</div>' +
              '<div class="mobile-card-title">' + escapeDespesaHtml(row.employee || '') + '</div>' +
              '<div class="mobile-card-sub">' + escapeDespesaHtml(row.detail || '') + '</div>' +
              '<div class="mobile-card-sub">' + escapeDespesaHtml(row.date || '') + '</div>' +
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
    if (body) body.innerHTML = '<tr><td colspan="6" class="empty">Erro RH: ' + escapeDespesaHtml(e.message || e) + '</td></tr>';
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
// Registo por chave de licenca

async function saveTesouraria() {
  var data = {
    date: document.getElementById("tre-date").value,
    movimento: document.getElementById("tre-mvt").value,
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

    toast("Movimento de tresorerie registado!", "success");

    document.getElementById("tre-type").value = "";
    document.getElementById("tre-desc").value = "";
    document.getElementById("tre-montant").value = "";

    loadTesouraria();

  } catch (e) {
    console.error("Erro tresorerie:", e);
    if (typeof azulIsOfflineError === "function" && azulIsOfflineError(e)) {
      azulQueueOfflineOperation("treasury", data);
      toast("Sem internet: movimento guardado para sincronizar depois.", "success");
      document.getElementById("tre-type").value = "";
      document.getElementById("tre-desc").value = "";
      document.getElementById("tre-montant").value = "";
      return;
    }
    toast("Erro tresorerie: " + (e.message || e), "error");

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Registar Movimento";
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
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.type || 'Movimento') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(row.desc || 'Sem descricao') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.date || '') + '</div>' +
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

async function loadTesouraria() {
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
        "<td>" + escapeDespesaHtml(row.date || "") + "</td>" +
        "<td>" + escapeDespesaHtml(row.type || "") + "</td>" +
        "<td>" + escapeDespesaHtml(row.desc || "") + "<div>" + renderActionAuthor(row) + "</div></td>" +
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
      movement: data.movimento || "entrada",
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

  var resellerProjection = await getResellerSalesProjectionFromSupabase({
    from: from,
    to: to
  });

  (resellerProjection.sales || []).forEach(function(sale) {
    var cashIn = getCashInAmountFromPaymentLines(sale.payment_lines || [], sale.total);

    if (cashIn > 0) {
      entries.push({
        date: sale.sale_date || "",
        type: "Venda Revendedor",
        desc: "Pagamento revendedor " + (sale.client_name || "") + " - " + (sale.receipt_no || ""),
        income: cashIn,
        expense: 0,
        user_name: sale.user_name || "",
        created_at: sale.created_at || ""
      });
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
        type: "Compra",
        desc: "Compra fornecedor " + (purchase.supplier || ""),
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
      type: "Despesa",
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

function buildResellerDebtAccountingRows(resellerDebts) {
  return ((resellerDebts && resellerDebts.rows) || []).map(function(row) {
    return {
      date: row.consignment_date || String(row.created_at || "").slice(0, 10),
      type: "12 - Clientes / Revendedores",
      desc: "Divida revendedor " + (row.reseller_name || "Revendedor") + " - " + (row.consignment_no || ""),
      debito: Number(row.remaining_amount) || 0,
      credito: 0,
      source: "reseller_debt",
      created_at: row.created_at || ""
    };
  });
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

  var totalCredito = lines.reduce(function(sum, line) {
    return sum + (Number(line.credit) || 0);
  }, 0);

  if (Math.round(totalDebit) !== Math.round(totalCredito)) {
    throw new Error("Ecriture comptable desequilibree: debit " + totalDebit + " / credit " + totalCredito);
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
    list.innerHTML = '<div class="empty">' + escapeDespesaHtml(emptyText || "Nenhum movimento") + '</div>';
    return;
  }

  list.innerHTML = rows.map(function(row) {
    return '<div class="mobile-accounting-card">' +
      '<div class="mobile-card-top">' +
        '<div>' +
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.kicker || '') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(row.label || '') + '</div>' +
          (row.sub ? '<div class="mobile-card-sub">' + escapeDespesaHtml(row.sub || '') + '</div>' : '') +
        '</div>' +
        '<div class="mobile-accounting-amount ' + escapeDespesaHtml(row.kind || '') + '">' + fmt(row.amount || 0) + '</div>' +
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
          '<div class="mobile-card-kicker">' + escapeDespesaHtml(row.type || 'Contabilidade') + '</div>' +
          '<div class="mobile-card-title">' + escapeDespesaHtml(row.desc || 'Sem descricao') + '</div>' +
          '<div class="mobile-card-sub">' + escapeDespesaHtml(row.date || '') + '  -  ' + escapeDespesaHtml(row.source || '') + '</div>' +
        '</div>' +
        '<div class="mobile-accounting-amount ' + (isDebit ? 'debit' : 'credit') + '">' +
          (isDebit ? '+' : '-') + fmt(amount || 0) +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function loadContabilidade() {
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
    var data = await getContabilidadeFromSupabase(params);

    data = data || {};

    var r = data.resume || {};
    var b = data.bilan || {};
    var p = data.period || {};

    var incomeRowsMobile = [
  { kicker: "Resultado", label: "Vendas", amount: r.vendas || 0, kind: "debit" },
  { kicker: "Resultado", label: "Custo das vendas", amount: r.coutVendas || 0, kind: "credit" },
  { kicker: "Resultado", label: "Lucro bruto", amount: r.beneficeBrut || 0, kind: "debit" },
  { kicker: "Resultado", label: "Despesas operacionais", amount: r.depenses || 0, kind: "credit" },
  { kicker: "Resultado", label: "Resultado operacional", amount: r.resultatNet || 0, kind: (r.resultatNet || 0) >= 0 ? "debit" : "credit" },
  { kicker: "Stock", label: "Compras de stock no periodo", amount: r.achats || 0, kind: "" },
  { kicker: "Credito", label: "Compras a credito", amount: r.comprasCredito || 0, kind: "credit" },
  { kicker: "Fornecedor", label: "Pagamentos a fornecedores", amount: r.pagamentosFornecedores || 0, kind: "credit" }
];

var balanceRowsMobile = [
  { kicker: "Ativo", label: "Tesouraria", amount: b.tresorerie || 0, kind: "debit" },
  { kicker: "Ativo", label: "Stock", amount: b.stock || 0, kind: "" },
  { kicker: "Ativo", label: "Clientes a receber", amount: b.clientesAReceber || 0, kind: "debit" },
  { kicker: "Ativo", label: "Revendedores a receber", amount: b.revendedoresAReceber || 0, kind: "debit" },
  { kicker: "Ativo", label: "Total do ativo", amount: b.actifSimplifie || 0, kind: "debit" },
  { kicker: "Passivo", label: "Dividas fornecedores", amount: b.dividasFornecedors || 0, kind: "credit" },
  { kicker: "Passivo", label: "Total do passivo", amount: b.passivo || 0, kind: "credit" },
  { kicker: "Capital", label: "Capital proprio simplificado", amount: b.capitaisProprios || 0, kind: (b.capitaisProprios || 0) >= 0 ? "debit" : "credit" }
];

renderMobileAccountingRows("acctIncomeBody", incomeRowsMobile, "Nenhum resultado");
renderMobileAccountingRows("acctBalanceBody", balanceRowsMobile, "Nenhum balanco");

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
        acctAmountRow("Despesas operacionais", r.despesas, "var(--red)") +
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
        acctAmountRow("Revendedores a receber", b.revendedoresAReceber, "var(--orange)") +
        acctAmountRow("Total do ativo", b.actifSimplifie, "var(--green)") +
        acctAmountRow("Dividas fornecedores", b.dividasFornecedors, "var(--red)") +
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
    console.error("Erro contabilidade:", e);
    body.innerHTML = '<tr><td colspan="6" class="empty">Erro ao carregar contabilidade</td></tr>';
    toast("Erro contabilidade: " + (e.message || e), "error");
  }
}
async function getContabilidadeFromSupabase(params) {
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
  var resellerDebts = await getResellerOpenDebtsFromSupabase({
    from: from,
    to: to
  });
  var resellerDebtJournal = buildResellerDebtAccountingRows(resellerDebts);

  if (!entries.length) {
    if (typeFilter) {
      resellerDebtJournal = resellerDebtJournal.filter(function(row) {
        return (
          String(row.type || "").toLowerCase().indexOf(typeFilter) >= 0 ||
          String(row.desc || "").toLowerCase().indexOf(typeFilter) >= 0 ||
          String(row.source || "").toLowerCase().indexOf(typeFilter) >= 0
        );
      });
    }

    var resellerReceivableOnly = Number(resellerDebts.total) || 0;

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
        revendedoresAReceber: resellerReceivableOnly,
        actifSimplifie: resellerReceivableOnly,
        dividasFornecedors: 0,
        passivo: 0,
        capitaisProprios: resellerReceivableOnly
      },
      period: {
        from: from || "-",
        to: to || "-"
      },
      journal: resellerDebtJournal
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
  var revendedoresAReceber = Number(resellerDebts.total) || 0;
  var dividasFornecedors = sumAccount("21", "credit") - sumAccount("21", "debit");

  var beneficeBrut = vendas - coutVendas;
  var resultatNet = beneficeBrut - depenses;
  var marge = vendas > 0 ? (beneficeBrut / vendas) * 100 : 0;

  var vendasCount = entries.filter(function(entry) {
    return entry.source_type === "sale" || entry.source_type === "reseller_payment";
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

  journal = journal.concat(resellerDebtJournal);

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
      revendedoresAReceber: revendedoresAReceber,
      actifSimplifie: tresorerie + stock + clientesAReceber + revendedoresAReceber,
      dividasFornecedors: dividasFornecedors,
      passivo: dividasFornecedors,
      capitaisProprios: tresorerie + stock + clientesAReceber + revendedoresAReceber - dividasFornecedors
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
      return '<option value="' + escapeDespesaHtml(name) + '"></option>';
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
              escapeDespesaHtml(initial) +
            '</div>' +
            '<div>' +
              '<div style="font-family:Playfair Display,serif;font-size:25px;font-weight:800;">' + escapeDespesaHtml(data.name || nom) + '</div>' +
              '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Ficha do cliente</div>' +
            '</div>' +
          '</div>' +

          '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">' +
            '<div style="background:var(--surface2);border-radius:14px;padding:14px;">' +
              '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Total compras</div>' +
              '<div style="margin-top:6px;font-family:Playfair Display,serif;font-size:22px;font-weight:900;color:var(--blue);">' + fmt(data.totalCompra || 0) + '</div>' +
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
              '<div style="font-size:11px;color:var(--orange);font-weight:800;">' + escapeDespesaHtml(a.date || "") + '</div>' +
              '<div style="margin-top:3px;font-size:14px;font-weight:800;">' + escapeDespesaHtml(a.prod || "") + '</div>' +
              '<div style="margin-top:3px;font-size:12px;color:var(--muted);">Quantidade: ' + (a.qty || 0) + '</div>' +
            '</div>' +
            '<div style="font-size:15px;font-weight:900;color:var(--blue);white-space:nowrap;">' + fmt(a.total || 0) + '</div>' +
          '</div>';
      });

      html += '</div>';
    } else {
      html += '<div class="empty">Nenhuma venda encontrada</div>';
    }

    html += '</div>' +
      '<div style="background:#fff;border:1px solid var(--border);border-radius:18px;padding:16px;box-shadow:0 12px 30px rgba(0,0,0,.04);">' +
        '<div class="card-title">Pagamentos da divida</div>';

    if (data.payments && data.payments.length > 0) {
      html += '<div style="display:grid;gap:10px;">';

      data.payments.forEach(function(payment) {
        html +=
          '<div style="display:flex;justify-content:space-between;gap:12px;padding:12px;border-radius:14px;background:var(--surface2);">' +
            '<div>' +
              '<div style="font-size:11px;color:var(--orange);font-weight:800;">' + escapeDespesaHtml(payment.payment_date || "") + '</div>' +
              '<div style="margin-top:3px;font-size:14px;font-weight:800;">Pagamento recebido</div>' +
              '<div style="margin-top:3px;font-size:12px;color:var(--muted);">' + escapeDespesaHtml(payment.note || "-") + '</div>' +
              renderActionAuthor(payment) +
            '</div>' +
            '<div style="font-size:15px;font-weight:900;color:var(--green);white-space:nowrap;">' + fmt(payment.amount || 0) + '</div>' +
          '</div>';
      });

      html += '</div>';
    } else {
      html += '<div class="empty">Nenhum pagamento de divida encontrado</div>';
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

  if (clientPaymentInProgress) {
    toast("Pagamento ja esta a ser registado. Aguarde...", "error");
    return;
  }

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
  clientPaymentInProgress = true;

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
    clientPaymentInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = " Registar Pagamento";
      btn.style.opacity = "1";
    }
  }
}
// =============================================================================================
// ============== Visualizacao do valor restante para divida de cliente e fornecedor =====================
// =============================================================================================

function updateResteAPagor(totalDu) {
  var cur = window._currency || 'Kz';
  var totalPago = paiementLines.reduce(function(s,p) { return s+(p.montant||0); }, 0);
  var reste = Math.max(0, totalDu - totalPago);
  var pe = document.getElementById('a-total-paye');
  var re = document.getElementById('a-reste-payer');
  if (pe) pe.textContent = new Intl.NumberFormat('pt-PT').format(totalPago)+' '+cur;
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
  var fornecedor = (document.getElementById("p-forn") || {}).value || "";
  var el = document.getElementById("restePayFourn");

  if (!el || !fornecedor.trim()) {
    if (el) el.textContent = "0 " + cur;
    return;
  }

  try {
    var reste = await getSupplierDebtFromSupabase(fornecedor.trim());
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
      return '<option value="' + escapeDespesaHtml(supplier.name || "") + '"></option>';
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
      el.innerHTML = '<div class="empty">Nenhum fornecedor encontrado.</div>';
      return;
    }

    el.innerHTML = suppliers.map(function(supplier) {
      var initial = String(supplier.name || "?").charAt(0).toUpperCase();

      return '' +
        '<button type="button" class="supplier-card-btn" data-name="' + escapeDespesaHtml(supplier.name || "") + '" onclick="openSupplierFicheFromCard(this)">' +
          '<span class="supplier-avatar">' + escapeDespesaHtml(initial) + '</span>' +
          '<span class="supplier-card-text">' +
            '<strong>' + escapeDespesaHtml(supplier.name || "") + '</strong>' +
            '<small>' + escapeDespesaHtml(supplier.phone || supplier.country || "Sem contacto") + '</small>' +
          '</span>' +
        '</button>';
    }).join("");

  } catch (e) {
    console.error("Erro fornecedores:", e);
    el.innerHTML = '<div class="empty">Erro ao carregar fornecedores.</div>';
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

  el.innerHTML = '<div class="empty">A carregar ficha do fornecedor...</div>';

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
                  '<span>' + escapeDespesaHtml(item.product_name || "Produto") + '</span>' +
                  '<strong>' + (Number(item.quantity) || 0) + ' x ' + fmt(Number(item.purchase_price) || 0) + '</strong>' +
                '</div>';
              }).join("")
            : '<div class="muted">Sem artigos detalhados</div>';

          return '<div class="supplier-history-card">' +
            '<div class="supplier-history-head">' +
              '<div>' +
                '<strong>Compra #' + escapeDespesaHtml(String(purchase.id || "").slice(0, 8)) + '</strong>' +
                '<small>' + escapeDespesaHtml(String(purchase.created_at || "").slice(0, 10)) + '</small>' +
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
      : '<div class="empty">Nenhuma compra encontrada.</div>';

    var paymentsHtml = data.payments.length
      ? data.payments.map(function(payment) {
          return '<div class="supplier-payment-row">' +
            '<div>' +
              '<strong>' + fmt(Number(payment.amount) || 0) + '</strong>' +
              '<small>' + escapeDespesaHtml(payment.note || "Pagamento fornecedor") + '</small>' +
              renderActionAuthor(payment) +
            '</div>' +
            '<span>' + escapeDespesaHtml(payment.payment_date || "") + '</span>' +
          '</div>';
        }).join("")
      : '<div class="empty">Nenhum pagamento encontrado.</div>';

    el.innerHTML =
      '<div class="supplier-profile-card">' +
        '<div class="supplier-profile-top">' +
          '<div class="supplier-profile-avatar">' + escapeDespesaHtml(initial) + '</div>' +
          '<div>' +
            '<h3>' + escapeDespesaHtml(supplier.name || name) + '</h3>' +
            '<p>' + escapeDespesaHtml(supplier.phone || "Sem telefone") + '</p>' +
            '<p>' + escapeDespesaHtml(supplier.country || "Sem pais") + '</p>' +
          '</div>' +
        '</div>' +

        '<div class="supplier-note">' + escapeDespesaHtml(supplier.note || "Nenhuma nota do fornecedor.") + '</div>' +

        '<div class="supplier-kpis">' +
          '<div><span>Total achats</span><strong>' + fmt(data.totalCompras) + '</strong></div>' +
          '<div><span>Total pago</span><strong>' + fmt(data.totalPago) + '</strong></div>' +
          '<div><span>Dette</span><strong class="' + (data.saldo > 0 ? "text-red" : "text-green") + '">' + fmt(data.saldo) + '</strong></div>' +
        '</div>' +
      '</div>' +

      '<div class="supplier-two-cols">' +
        '<div class="card">' +
          '<div class="card-title">Historico de compras</div>' +
          purchasesHtml +
        '</div>' +
        '<div class="card">' +
          '<div class="card-title">Pagamentos</div>' +
          paymentsHtml +
        '</div>' +
      '</div>';

  } catch (e) {
    console.error("Erro ficha fornecedor:", e);
    el.innerHTML = '<div class="empty">Erro ficha fornecedor.</div>';
    toast("Erro ficha fornecedor: " + (e.message || e), "error");
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
    throw new Error("O ficheiro CSV esta vazio ou sem dados.");
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
  if (!row.supplier) return "Fornecedor obrigatorio";
  if (!row.designation) return "Designacao obrigatoria";
  if (!row.quantity || row.quantity <= 0) return "Quantidade invalida";
  if (!row.unitPrice || row.unitPrice <= 0) return "Preco unitario invalido";
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
      toast("Erro CSV: " + (err.message || err), "error");
    }
  };

  reader.readAsText(file, "UTF-8");
}

function renderPurchaseImportPreview() {
  var body = document.getElementById("purchase-import-preview");
  var summary = document.getElementById("purchase-import-summary");

  if (!body || !summary) return;

  if (!purchaseImportRows.length) {
    summary.textContent = "Nenhum ficheiro selecionado.";
    body.innerHTML = '<tr><td colspan="10" class="empty">Le preview apparait ici</td></tr>';
    return;
  }

  var validRows = purchaseImportRows.filter(function(row) { return row.valid; });
  var invalidRows = purchaseImportRows.filter(function(row) { return !row.valid; });
  var total = validRows.reduce(function(sum, row) {
    return sum + row.quantity * row.unitPrice;
  }, 0);

  summary.innerHTML =
    '<strong>' + validRows.length + '</strong> linhas validas | ' +
    '<strong>' + invalidRows.length + '</strong> erreurs | Total: <strong>' + fmt(total) + '</strong>';

  body.innerHTML = purchaseImportRows.slice(0, 80).map(function(row) {
    var bg = row.valid ? "" : ' style="background:rgba(224,92,92,0.08);"';

    return '<tr' + bg + '>' +
      '<td>' + escapeDespesaHtml(row.date) + '</td>' +
      '<td>' + escapeDespesaHtml(row.supplier) + '</td>' +
      '<td>' + escapeDespesaHtml(row.designation || row.error) + '</td>' +
      '<td>' + escapeDespesaHtml(row.quantity) + '</td>' +
      '<td>' + escapeDespesaHtml(row.unitPrice) + '</td>' +
      '<td>' + escapeDespesaHtml(row.salePrice) + '</td>' +
      '<td>' + escapeDespesaHtml(row.category) + '</td>' +
      '<td>' + escapeDespesaHtml(row.code) + '</td>' +
      '<td>' + escapeDespesaHtml(row.variation) + '</td>' +
      '<td>' + escapeDespesaHtml(row.paymentStatus === "credit" ? "Credito" : "Pago") + '</td>' +
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
      description: "Import achat fornecedor " + group.supplier
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
    throw new Error("Nenhuma linha valida para importar.");
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
      var stockUpdate = getPurchaseStockUpdate(existing.stock_warehouse, existing.stock_shop, group.quantity);
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
        stock_warehouse: stockUpdate.stock_warehouse,
        stock_shop: stockUpdate.stock_shop,
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
        stock_warehouse: isWarehouseStockMode() ? group.quantity : 0,
        stock_shop: isWarehouseStockMode() ? 0 : group.quantity,
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
    var isCredito = group.paymentStatus === "credit";
    var paidAmount = isCredito ? Math.min(group.total, group.paidAmount || 0) : group.total;
    var remainingAmount = isCredito ? Math.max(0, group.total - paidAmount) : 0;

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
        throw new Error("Produto nao encontrado apos importacao: " + row.designation);
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
    toast("Escolhe primeiro um ficheiro CSV.", "error");
    return;
  }

  var invalidRows = purchaseImportRows.filter(function(row) {
    return !row.valid;
  });

  if (invalidRows.length) {
    toast("Corrigido as linhas invalidas antes da importacao.", "error");

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

    toast("Import termine: " + result.items + " lignes importees, " + (result.skipped || 0) + " duplicados ignorados.", "success");
    
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
    console.error("Erro importacao compras:", e);
    toast("Erro importacao: " + (e.message || e), "error");

    if (log) {
      log.innerHTML = "Erro: " + escapeDespesaHtml(e.message || e);
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
  if (!row.designation) return "Designacao obrigatoria";
  if (!row.quantity || row.quantity <= 0) return "Quantidade invalida";
  if (!row.unitPrice || row.unitPrice <= 0) return "Preco unitario invalido";
  if (!row.totalAmount || row.totalAmount <= 0) return "Montante total invalido";

  var payTotal = getSaleImportPaymentTotal(row);

  if (Math.abs(payTotal - row.totalAmount) > 0.01) {
    return "Pagamentos differents du total";
  }

  if (row.credit > 0 && (!row.client || row.client === "Anonimo")) {
    return "Credito exige un nom client";
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
      toast("Erro CSV vendas: " + (err.message || err), "error");
    }
  };

  reader.readAsText(file, "UTF-8");
}

function renderSaleImportPreview() {
  var body = document.getElementById("sale-import-preview");
  var summary = document.getElementById("sale-import-summary");

  if (!body || !summary) return;

  if (!saleImportRows.length) {
    summary.textContent = "Nenhum ficheiro selecionado.";
    body.innerHTML = '<tr><td colspan="12" class="empty">Le preview des ventes apparait ici</td></tr>';
    return;
  }

  var validRows = saleImportRows.filter(function(row) { return row.valid; });
  var invalidRows = saleImportRows.filter(function(row) { return !row.valid; });
  var total = validRows.reduce(function(sum, row) {
    return sum + row.totalAmount;
  }, 0);

  summary.innerHTML =
    '<strong>' + validRows.length + '</strong> vendas validas | ' +
    '<strong>' + invalidRows.length + '</strong> erreurs | Total: <strong>' + fmt(total) + '</strong>';

  body.innerHTML = saleImportRows.slice(0, 100).map(function(row) {
    var bg = row.valid ? "" : ' style="background:rgba(224,92,92,0.08);"';

    return '<tr' + bg + '>' +
      '<td>' + escapeDespesaHtml(row.date) + '</td>' +
      '<td>' + escapeDespesaHtml(row.designation || row.error) + '</td>' +
      '<td>' + escapeDespesaHtml(row.quantity) + '</td>' +
      '<td>' + escapeDespesaHtml(row.unitPrice) + '</td>' +
      '<td>' + escapeDespesaHtml(row.cash) + '</td>' +
      '<td>' + escapeDespesaHtml(row.express) + '</td>' +
      '<td>' + escapeDespesaHtml(row.card) + '</td>' +
      '<td>' + escapeDespesaHtml(row.credit) + '</td>' +
      '<td>' + escapeDespesaHtml(row.totalAmount) + '</td>' +
      '<td>' + escapeDespesaHtml(row.origin) + '</td>' +
      '<td>' + escapeDespesaHtml(row.client) + '</td>' +
      '<td>' + escapeDespesaHtml(row.receiptNo || "Auto") + '</td>' +
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
    throw new Error("Nenhuma venda valida para importar.");
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
      throw new Error("Venda importada nao encontrada na linha " + row.line);
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
    toast("Escolhe primeiro um ficheiro de vendas.", "error");
    return;
  }

  var invalidRows = saleImportRows.filter(function(row) {
    return !row.valid;
  });

  if (invalidRows.length) {
    toast("Corrigido as vendas invalidas antes da importacao.", "error");

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

    toast("Import ventes termine: " + result.sales + " ventes, " + (result.skipped || 0) + " duplicados ignorados.", "success");

    saleImportRows = [];
    renderSaleImportPreview();

    var fileInput = document.getElementById("sale-import-file");
    if (fileInput) fileInput.value = "";

    products = [];

    if (log) {
      log.innerHTML = "Import ventes termine: " + result.sales + " ventes, " + result.items + " lignes. Doublons ignores: " + (result.skipped || 0) + ".";
    }
  } catch (e) {
    console.error("Erro importacao vendas:", e);
    toast("Erro importacao vendas: " + (e.message || e), "error");

    if (log) {
      log.innerHTML = "Erro: " + escapeDespesaHtml(e.message || e);
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
    "2026-05-20,Loyer,Loyer loja,150000\n" +
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
  if (!row.category) return "Categoria obrigatoria";
  if (!row.description) return "Descricao obrigatoria";
  if (!row.amount || row.amount <= 0) return "Montante invalido";
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
      toast("Erro CSV despesas: " + (err.message || err), "error");
    }
  };

  reader.readAsText(file, "UTF-8");
}

function renderExpenseImportPreview() {
  var body = document.getElementById("expense-import-preview");
  var summary = document.getElementById("expense-import-summary");

  if (!body || !summary) return;

  if (!expenseImportRows.length) {
    summary.textContent = "Nenhum ficheiro selecionado.";
    body.innerHTML = '<tr><td colspan="4" class="empty">A pre-visualizacao das despesas aparece aqui</td></tr>';
    return;
  }

  var validRows = expenseImportRows.filter(function(row) { return row.valid; });
  var invalidRows = expenseImportRows.filter(function(row) { return !row.valid; });
  var total = validRows.reduce(function(sum, row) {
    return sum + row.amount;
  }, 0);

  summary.innerHTML =
    '<strong>' + validRows.length + '</strong> despesas validas | ' +
    '<strong>' + invalidRows.length + '</strong> erreurs | Total: <strong>' + fmt(total) + '</strong>';

  body.innerHTML = expenseImportRows.slice(0, 100).map(function(row) {
    var bg = row.valid ? "" : ' style="background:rgba(224,92,92,0.08);"';

    return '<tr' + bg + '>' +
      '<td>' + escapeDespesaHtml(row.date) + '</td>' +
      '<td>' + escapeDespesaHtml(row.category || row.error) + '</td>' +
      '<td>' + escapeDespesaHtml(row.description) + '</td>' +
      '<td>' + escapeDespesaHtml(row.amount) + '</td>' +
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
      description: "Despesa - " + (expense.description || expense.category || "")
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

function syncImportedExpenseCategorias(rows) {
  var categories = getStoredDespesaCategorias();
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

  saveStoredDespesaCategorias(categories);
  renderDespesaCategorias();
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
    throw new Error("Nenhuma despesa valida para importar.");
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
    syncImportedExpenseCategorias(validRows);

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
  syncImportedExpenseCategorias(validRows);

  return {
    expenses: insertedExpenses.length,
    skipped: skippedDuplicates
  };
}

async function importExpenseCsvRows() {
  if (!requireAzulAction("import:create", "importar dados")) return;

  var log = document.getElementById("expense-import-log");

  if (expenseImportRunning) {
    toast("Importacao de despesas ja esta em curso...", "error");
    return;
  }

  if (!expenseImportRows.length) {
    toast("Escolhe primeiro um ficheiro de despesas.", "error");
    return;
  }

  var invalidRows = expenseImportRows.filter(function(row) {
    return !row.valid;
  });

  if (invalidRows.length) {
    toast("Corrigido as despesas invalidas antes da importacao.", "error");

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
    if (log) log.innerHTML = "Importacao de despesas em curso...";

    var result = await saveExpenseImportBatchToSupabase(expenseImportRows);

    toast("Importacao de despesas concluida: " + result.expenses + " despesas, " + (result.skipped || 0) + " duplicados ignorados.", "success");

    expenseImportRows = [];
    renderExpenseImportPreview();

    var fileInput = document.getElementById("expense-import-file");
    if (fileInput) fileInput.value = "";

    loadDashboard();
    loadDespesaInsights();

    if (log) {
            log.innerHTML = "Importacao de despesas concluida: " + result.expenses + " despesas. Duplicados ignorados: " + (result.skipped || 0) + ".";
    }
  } catch (e) {
    console.error("Erro importacao despesas:", e);
    toast("Erro importacao despesas: " + (e.message || e), "error");

    if (log) {
      log.innerHTML = "Erro: " + escapeDespesaHtml(e.message || e);
    }
  } finally {
    expenseImportRunning = false;

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Importar despesas";
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
  return typeof escapeDespesaHtml === "function" ? escapeDespesaHtml(value) : String(value == null ? "" : value);
}

function correctionSourceLabel(type) {
  var map = {
    sale: "Venda",
    purchase: "Compra",
    expense: "Despesa",
    client_payment: "Pagamento client",
    supplier_payment: "Pagamento fornecedor"
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
    await createAzulNotification({
      actionType: "correction:create",
      title: getAzulCurrentUserName() + " registou uma correcao",
      message: correctionSourceLabel(sourceType) + " - " + (reason || "Annulacao"),
      sourceType: sourceType,
      sourceId: sourceId,
      details: {
        correction_type: correctionType,
        correction_id: correctionId || null,
        reason: reason || ""
      }
    });
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
      return String(row.supplier || "").indexOf("Anulacao - ") !== 0 &&
        (!search || text.indexOf(search) >= 0);
    }).map(function(row) {
      return {
        id: row.id,
        sourceType: "purchase",
        title: "Compra fornecedor",
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
      return String(row.category || "").indexOf("Anulacao - ") !== 0 &&
        (!search || text.indexOf(search) >= 0);
    }).map(function(row) {
      return {
        id: row.id,
        sourceType: "expense",
        title: row.category || "Despesa",
        subtitle: row.description || "Sem descricao",
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
      title: "Pagamento client",
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
      title: "Pagamento fornecedor",
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

  list.innerHTML = '<div class="empty">A carregar...</div>';

  try {
    var rows = await fetchCorrectionsRows(correctionCurrentType, search ? search.value : "");
    var logs = await getCorrectionLogsForRows(rows);

    if (!rows.length) {
      list.innerHTML = '<div class="empty">Nenhum movimento encontrado.</div>';
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
          (cancelled ? '<div class="correction-cancelled">Ja corrigido: ' + correctionSafe(log.reason || "Anulacao") + '</div>' : '') +
        '</div>' +
        '<button class="correction-action" ' + (cancelled ? 'disabled' : '') +
          ' data-correction-type="' + correctionSafe(row.sourceType) + '" data-correction-id="' + correctionSafe(row.id) + '">' +
          (cancelled ? 'Corrigido' : 'Anular') +
        '</button>' +
      '</div>';
    }).join("");
  } catch (e) {
    console.error("Erro correcoes:", e);
    list.innerHTML = '<div class="empty">Erro: ' + correctionSafe(e.message || e) + '</div>';
  }
}

async function confirmCorrectionCancel(sourceType, id) {
  if (!requireAzulAction("correction:create", "corrigir movimentos")) return;

  var reason = prompt("Por que deseja anular este movimento?");

  if (reason === null) return;
  reason = String(reason || "").trim();

  if (!reason) {
    toast("Ajoute une raison pour la correction.", "error");
    return;
  }

  if (!confirm("Confirmar anulacao controlada?")) return;

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
    console.error("Erro correcao:", e);
    toast("Erro correcao: " + (e.message || e), "error");
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
      payment_summary: "Anulacao " + (sale.receipt_no || ""),
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

  await reverseAccountingForSource("sale", saleId, "sale_correction", correction.id, correctionToday(), "Anulacao venda " + (sale.receipt_no || ""));
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
      supplier: "Anulacao - " + (purchase.supplier || "Fornecedor"),
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
    await updateProductStockDelta(
      items[i].product_id,
      isWarehouseStockMode() ? "stock_warehouse" : "stock_shop",
      -(Number(items[i].quantity) || 0)
    );
  }

  await reverseAccountingForSource("purchase", purchaseId, "purchase_correction", correction.id, correctionToday(), "Anulacao compra " + (purchase.supplier || ""));
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
      category: "Anulacao - " + (expense.category || "Despesa"),
      description: "Correction: " + (expense.description || "") + " - " + reason,
      amount: -Math.abs(Number(expense.amount) || 0)
    });

  if (correctionResult.error) throw correctionResult.error;
  var correction = correctionResult.data;

  await reverseAccountingForSource("expense", expenseId, "expense_correction", correction.id, correctionToday(), "Anulacao despesa " + (expense.description || ""));
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
      note: "Anulacao pagamento: " + reason,
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

  await reverseAccountingForSource("client_payment", paymentId, "client_payment_correction", correction.id, correctionToday(), "Anulacao pagamento cliente " + (payment.client_name || ""));
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
      note: "Anulacao pagamento: " + reason,
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

  await reverseAccountingForSource("supplier_payment", paymentId, "supplier_payment_correction", correction.id, correctionToday(), "Anulacao pagamento fornecedor " + (payment.supplier || ""));
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
  card.className = "lock-settings-card";

  card.innerHTML = `
    <h3>Seguranca do ERP</h3>
    <p>
      Defina um mot de passe para bloquear o acesso ao sistema.
    </p>

    <div class="lock-settings-grid">
      <div class="lock-password-wrap">
        <input id="erpLockPassword" type="password" placeholder="Novo mot de passe"
          autocomplete="new-password">
        <button type="button" onclick="togglePasswordVisibility('erpLockPassword', this)"
          class="lock-eye-btn">
         &#128065;
        </button>
      </div>

      <div class="lock-password-wrap">
        <input id="erpLockPasswordConfirm" type="password" placeholder="Confirmar mot de passe"
          autocomplete="new-password">
        <button type="button" onclick="togglePasswordVisibility('erpLockPasswordConfirm', this)"
          class="lock-eye-btn">
         &#128065;
        </button>
      </div>
    </div>

    <div class="lock-actions">
      <button class="erp-lock-btn erp-lock-save" onclick="saveErpLockPassword()">
        Guardar mot de passe
      </button>

      <button class="erp-lock-btn erp-lock-danger" onclick="lockErpNow()">
        Sair / Bloquear
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

  toast("Palavra-passe de bloqueio guardada.", "success");
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
        <input id="erpUnlockPassword" type="password" placeholder="Palavra-passe"
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
    toast("Palavra-passe incorrect.", "error");
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
    return '<span>' + escapeDespesaHtml(label) + '</span>';
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
    return '<option value="' + role + '">' + escapeDespesaHtml(getTeamRoleLabel(role)) + '</option>';
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

  var repairResult = await supabaseClient.rpc("ensure_first_owner_profile", {
    p_organization_id: organizationId
  }).maybeSingle();

  if (!repairResult.error && repairResult.data) {
    profile = repairResult.data;
  } else if (repairResult.error) {
    var repairMessage = String(repairResult.error.message || "");
    var repairCode = String(repairResult.error.code || "");

    if (
      repairMessage.indexOf("ensure_first_owner_profile") < 0 &&
      repairCode !== "PGRST202"
    ) {
      throw repairResult.error;
    }
  }

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
            return '<span>' + escapeDespesaHtml(roleCatalog[code].name || code) + '</span>';
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
                <select id="team-role-${escapeDespesaHtml(key)}">${getTeamRoleOptions(rawRole, roleCatalog)}</select>
              </label>

              <label>
                <span>Estado</span>
                <select id="team-status-${escapeDespesaHtml(key)}">${getTeamStatusOptions(status)}</select>
              </label>

              <button type="button" onclick="saveTeamMemberRoleStatus('${escapeDespesaHtml(encodedEmail)}')">Guardar</button>
              ${status === "pending" ? `<button type="button" class="approve" onclick="document.getElementById('team-status-${escapeDespesaHtml(key)}').value='active'; saveTeamMemberRoleStatus('${escapeDespesaHtml(encodedEmail)}')">Aceitar</button>` : ""}
              <button type="button" class="danger ghost" onclick="rejectTeamMember('${escapeDespesaHtml(encodedEmail)}')">Recusar</button>
              <button type="button" class="danger" onclick="deleteTeamMember('${escapeDespesaHtml(encodedEmail)}')">Eliminar</button>
            </div>
      ` : "";

      return `
        <div class="team-user-card">
          <div class="team-user-avatar">${escapeDespesaHtml(initial)}</div>

          <div class="team-user-info">
            <div class="team-user-top">
              <strong>${escapeDespesaHtml(name)}</strong>
              <span class="team-user-status ${escapeDespesaHtml(status)}">${escapeDespesaHtml(statusText)}</span>
            </div>

            <div class="team-user-meta">
              <span>${escapeDespesaHtml(role)}</span>
              <span>${escapeDespesaHtml(email)}</span>
              <span>${escapeDespesaHtml(phone)}</span>
            </div>

            <div class="team-user-last">
              Ultima actividade: ${escapeDespesaHtml(formatTeamDate(user.last_seen_at))}
            </div>

            ${renderRolePermissionChips(rawRole)}

            ${controls}
          </div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("Erro equipa:", e);
    list.innerHTML = '<div class="empty">Erro equipa: ' + escapeDespesaHtml(e.message || e) + '</div>';
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

// Correction finale: fornecedores depuis Supabase, pas Google Sheet
renderFornNameDatalist = function() {
  renderSupplierDatalists();
};

renderFornPayDatalist = function() {
  renderSupplierDatalists();
};

refreshFornecedorDatalists = function() {
  renderSupplierDatalists();
};
