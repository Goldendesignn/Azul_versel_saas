var ADMIN_CODE = "9059";
var organizationsCache = [];

function adminMsg(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

function unlockAdmin() {
  var code = document.getElementById("admin-code").value.trim();

  if (code !== ADMIN_CODE) {
    adminMsg("admin-login-msg", "Code admin incorrect.");
    return;
  }

  sessionStorage.setItem("azul_admin_unlocked", "1");
  showAdminPanel();
}

function logoutAdmin() {
  sessionStorage.removeItem("azul_admin_unlocked");
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

  var name = document.getElementById("org-name").value.trim();
  var phone = document.getElementById("org-phone").value.trim();
  var email = document.getElementById("org-email").value.trim();
  var license = document.getElementById("org-license").value.trim().toUpperCase();
  var status = document.getElementById("org-status").value;

  if (!name) {
    adminMsg("admin-form-msg", "Nom client obligatoire.");
    return;
  }

  if (!license) {
    license = generateLicenseKey();
    document.getElementById("org-license").value = license;
  }

  var result = await supabaseClient
    .from("organizations")
    .insert({
      name: name,
      phone: phone,
      email: email || null,
      license_key: license,
      status: status
    })
    .select()
    .single();

  if (result.error) {
    adminMsg("admin-form-msg", "Erreur: " + result.error.message);
    return;
  }

  document.getElementById("org-name").value = "";
  document.getElementById("org-phone").value = "";
  document.getElementById("org-email").value = "";
  document.getElementById("org-license").value = "";
  document.getElementById("org-status").value = "active";

  adminMsg("admin-form-msg", "Licence créée.");
  loadOrganizations();
}

async function loadOrganizations() {
  var list = document.getElementById("organizations-list");
  list.innerHTML = '<div class="empty">Chargement...</div>';

  var result = await supabaseClient
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });

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
      org.license_key,
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
              Licence: <strong>${htmlSafe(org.license_key || "-")}</strong><br>
              Téléphone: ${htmlSafe(org.phone || "-")}<br>
              Email: ${htmlSafe(org.email || "-")}<br>
              Créé: ${htmlSafe(String(org.created_at || "").slice(0, 10))}
            </div>
          </div>

          <span class="status ${htmlSafe(status)}">${htmlSafe(status)}</span>
        </div>

        <div class="org-actions">
          <button onclick="copyLicense('${htmlSafe(org.license_key || "")}')">Copier licence</button>
          <button onclick="changeOrganizationStatus('${org.id}', '${nextStatus}')">${actionText}</button>
        </div>
      </div>
    `;
  }).join("");
}

async function changeOrganizationStatus(id, status) {
  var result = await supabaseClient
    .from("organizations")
    .update({ status: status })
    .eq("id", id);

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

document.addEventListener("DOMContentLoaded", function() {
  if (sessionStorage.getItem("azul_admin_unlocked") === "1") {
    showAdminPanel();
  }
});
