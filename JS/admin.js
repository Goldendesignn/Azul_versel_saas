const adminSupabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey: "azul_admin_auth",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

var organizationsCache = [];

function adminMsg(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

async function loginAdmin() {
  var email = document.getElementById("admin-email").value.trim();
  var password = document.getElementById("admin-password").value.trim();

  if (!email || !password) {
    adminMsg("admin-login-msg", "Entre email et mot de passe.");
    return;
  }

  var result = await adminSupabaseClient.auth.signInWithPassword({
    email: email,
    password: password
  });

  if (result.error) {
    adminMsg("admin-login-msg", "Accès refusé.");
    return;
  }

  showAdminPanel();
}

async function logoutAdmin() {
  await adminSupabaseClient.auth.signOut();
  location.reload();
}

function showAdminPanel() {
  document.getElementById("admin-login").style.display = "none";
  document.getElementById("admin-panel").style.display = "block";
  loadOrganizations();
}

function generateLicenseKey() {
  function part() {
    return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "X");
  }

  return "AZUL-" + part() + "-" + part() + "-" + part();
}

function fillGeneratedLicense() {
  document.getElementById("org-license").value = generateLicenseKey();
}

function htmlSafe(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch];
  });
}

async function createOrganization() {
  adminMsg("admin-form-msg", "");

  var expires = document.getElementById("org-expires").value;
  var notes = document.getElementById("org-notes").value.trim();

  var result = await adminSupabaseClient.rpc("admin_create_license", {
    p_expires_at: expires ? expires + "T23:59:59" : null,
    p_notes: notes || null
  });

  if (result.error) {
    adminMsg("admin-form-msg", "Erreur: " + result.error.message);
    return;
  }

  var org = result.data;

  document.getElementById("org-license").value = org.license_key || "";
  document.getElementById("org-expires").value = "";
  document.getElementById("org-notes").value = "";

  adminMsg("admin-form-msg", "Licence générée: " + (org.license_key || ""));
  loadOrganizations();
}
async function loadOrganizations() {
  var list = document.getElementById("organizations-list");
  list.innerHTML = '<div class="empty">Chargement...</div>';

  var result = await adminSupabaseClient.rpc("admin_list_clients");

  if (result.error) {
    list.innerHTML = '<div class="empty">Erreur: ' + htmlSafe(result.error.message) + '</div>';
    return;
  }

  organizationsCache = result.data || [];
  renderOrganizations();
}
function renderOrganizations() {
  var list = document.getElementById("organizations-list");
  var q = (document.getElementById("admin-search").value || "").toLowerCase();

 var rows = organizationsCache.filter(function(org) {
  return [
    org.name,
    org.phone,
    org.email,
    org.current_license_key,
    org.current_license_status,
    org.status
  ].join(" ").toLowerCase().indexOf(q) >= 0;
});

  if (!rows.length) {
    list.innerHTML = '<div class="empty">Aucun client trouvé.</div>';
    return;
  }

  list.innerHTML = rows.map(function(org) {
    var status = org.status || "inactive";
    var nextStatus = status === "active" ? "suspended" : "active";
    var actionText = status === "active" ? "Désactiver" : "Réactiver";

    return `
      <div class="org-item">
        <div class="org-top">
          <div>
            <div class="org-name">${htmlSafe(org.name || "Client")}</div>
            <div class="org-meta">
              Licence: <strong>${htmlSafe(org.current_license_key || "-")}</strong><br>
              Statut licence: ${htmlSafe(org.current_license_status || "-")}<br>
              Plan: ${htmlSafe(org.plan || "starter")}<br>
              Expiration: ${htmlSafe(org.expires_at ? String(org.expires_at).slice(0, 10) : "Sans expiration")}<br>
              Activations: ${htmlSafe(org.activation_count || 0)} / ${htmlSafe(org.activation_limit || 1)}<br>
              Téléphone: ${htmlSafe(org.phone || "-")}<br>
              Email: ${htmlSafe(org.email || "-")}<br>
              Appareils: ${htmlSafe(org.active_devices || 0)} / ${htmlSafe(org.device_limit || 1)}<br>
              Créé: ${htmlSafe(String(org.created_at || "").slice(0, 10))}
            </div>
          </div>

          <span class="status ${htmlSafe(status)}">${htmlSafe(status)}</span>
        </div>

        <div class="org-actions">
          <button onclick="copyLicense('${htmlSafe(org.current_license_key || "")}')">Copier licence</button>
          <button onclick="createRenewalLicense('${org.id}')">Renouveler</button>
          <button onclick="changeOrganizationStatus('${org.id}', '${nextStatus}')">${actionText}</button>
          <button onclick="changeDeviceLimit('${org.id}')">Appareils</button>
          <button onclick="openDevicesPreview('${org.id}')">Voir appareils</button>
          
        </div>
      </div>
    `;
  }).join("");
}

async function changeOrganizationStatus(id, status) {
  var result = await adminSupabaseClient.rpc("admin_set_organization_status", {
    p_organization_id: id,
    p_status: status
  });

  if (result.error) {
    alert("Erreur: " + result.error.message);
    return;
  }

  loadOrganizations();
}

async function copyLicense(key) {
  if (!key) return;

  try {
    await navigator.clipboard.writeText(key);
    alert("Licence copiée.");
  } catch (e) {
    prompt("Copie la licence:", key);
  }
}
async function createRenewalLicense(organizationId) {
  var result = await adminSupabaseClient.rpc("admin_create_renewal_license", {
    p_organization_id: organizationId,
    p_expires_at: null,
    p_notes: "Renouvellement"
  });

  if (result.error) {
    alert("Erreur: " + result.error.message);
    return;
  }

  alert("Nouvelle licence: " + result.data.license_key);
  loadOrganizations();
}

async function changeDeviceLimit(organizationId) {
  var value = prompt("Nombre d'appareils autorises:");

  if (!value) return;

  var limit = parseInt(value, 10);

  if (!limit || limit < 1) {
    alert("Limite invalide.");
    return;
  }

  var result = await adminSupabaseClient.rpc("admin_set_device_limit", {
    p_organization_id: organizationId,
    p_device_limit: limit
  });

  if (result.error) {
    alert("Erreur: " + result.error.message);
    return;
  }

  loadOrganizations();
}
function formatAdminDate(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleString("fr-FR", {
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

function closeDevicesPreview() {
  var modal = document.getElementById("devices-preview-modal");
  if (modal) modal.remove();
}

async function openDevicesPreview(organizationId) {
  var org = organizationsCache.find(function(item) {
    return item.id === organizationId;
  });

  var modal = document.createElement("div");
  modal.id = "devices-preview-modal";
  modal.className = "devices-preview-backdrop";

  modal.innerHTML = `
    <div class="devices-preview">
      <div class="devices-preview-head">
        <div>
          <div class="devices-preview-kicker">Appareils connectés</div>
          <h2>${htmlSafe(org && org.name ? org.name : "Client")}</h2>
          <p>${htmlSafe(org && org.email ? org.email : "-")}</p>
        </div>
        <button type="button" class="devices-preview-close" onclick="closeDevicesPreview()">×</button>
      </div>

      <div class="devices-preview-stats">
        <div>
          <strong>${htmlSafe(org && org.active_devices != null ? org.active_devices : 0)}</strong>
          <span>Actifs</span>
        </div>
        <div>
          <strong>${htmlSafe(org && org.device_limit != null ? org.device_limit : 1)}</strong>
          <span>Limite</span>
        </div>
      </div>

      <div id="devices-preview-body" class="devices-preview-body">
        <div class="empty">Chargement des appareils...</div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  var body = document.getElementById("devices-preview-body");

  var result = await adminSupabaseClient.rpc("admin_list_devices", {
    p_organization_id: organizationId
  });

  if (result.error) {
    body.innerHTML = '<div class="empty">Erreur: ' + htmlSafe(result.error.message) + '</div>';
    return;
  }

  var devices = result.data || [];

  if (!devices.length) {
    body.innerHTML = '<div class="empty">Aucun appareil connecté.</div>';
    return;
  }

  body.innerHTML = devices.map(function(device) {
    var statusClass = device.active ? "active" : "inactive";
    var statusText = device.active ? "Actif" : "Inactif";
    var shortId = String(device.device_id || "").slice(0, 8);

    return `
      <div class="device-card">
        <div class="device-icon">${htmlSafe(String(device.device_name || "A").charAt(0).toUpperCase())}</div>

        <div class="device-info">
          <div class="device-main">
            <strong>${htmlSafe(device.device_name || "Appareil")}</strong>
            <span class="device-status ${statusClass}">${statusText}</span>
          </div>

          <div class="device-meta">
            ID: ${htmlSafe(shortId || "-")}<br>
            Première connexion ERP: ${htmlSafe(formatAdminDate(device.first_login_at))}<br>
            Dernière activité: ${htmlSafe(formatAdminDate(device.last_seen_at))}<br>
            ${htmlSafe(device.last_seen_label || "")}
          </div>
        </div>
      </div>
    `;
  }).join("");
}
document.addEventListener("DOMContentLoaded", async function() {
  var result = await adminSupabaseClient.auth.getSession();

  if (result.data && result.data.session) {
    showAdminPanel();
  }
});
