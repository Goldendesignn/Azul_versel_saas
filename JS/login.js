document.addEventListener("DOMContentLoaded", function () {
  var organizationId = localStorage.getItem("azul_organization_id");

  if (organizationId) {
    window.location.href = "core.html";
  }
});

function showMessage(text, type) {
  var box = document.getElementById("login-message");
  box.textContent = text || "";
  box.className = "login-message" + (type === "success" ? " success" : "");
}

function normalizeLicense(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function formatLicenseInput(input) {
  input.value = normalizeLicense(input.value);
}

function getOrCreateLoginDeviceId() {
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

function getLoginDeviceName() {
  var ua = navigator.userAgent || "";

  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone/iPad";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac/i.test(ua)) return "Mac";

  return "Navigateur";
}

function showLoginMode(mode) {
  var isRegister = mode === "register";
  var tabLogin = document.getElementById("tab-login");
  var tabRegister = document.getElementById("tab-register");
  var panelLogin = document.getElementById("panel-login");
  var panelRegister = document.getElementById("panel-register");

  if (tabLogin) tabLogin.classList.toggle("active", !isRegister);
  if (tabRegister) tabRegister.classList.toggle("active", isRegister);
  if (panelLogin) panelLogin.classList.toggle("active", !isRegister);
  if (panelRegister) panelRegister.classList.toggle("active", isRegister);

  showMessage("");
}

function loginAccount() {
  showMessage("A entrada por conta sera ativada na proxima etapa.");
}

function getLicenseErrorMessage(error) {
  var msg = String(error && error.message ? error.message : error || "");

  if (msg.indexOf("LICENCA_INVALIDA") >= 0) {
    return "Licenca invalida.";
  }

  if (msg.indexOf("LICENCA_INATIVA") >= 0) {
    return "Licenca desativada. Contacte o administrador.";
  }

  if (msg.indexOf("LICENCA_EXPIRADA") >= 0) {
    return "Licenca expirada. Renove a sua assinatura.";
  }

  if (msg.indexOf("DEVICE_LIMIT_REACHED") >= 0) {
    return "Limite de aparelhos atingido. Contacte o administrador.";
  }

  return "Erro ao ativar a licenca.";
}

async function verifyLoginDeviceAccess(organizationId) {
  var result = await supabaseClient.rpc("register_device_access", {
    p_organization_id: organizationId,
    p_device_id: getOrCreateLoginDeviceId(),
    p_device_name: getLoginDeviceName()
  });

  if (result.error) {
    showMessage(getLicenseErrorMessage(result.error));
    return false;
  }

  var row = Array.isArray(result.data) ? result.data[0] : result.data;

  if (!row || !row.allowed) {
    showMessage(getDeviceAccessMessage(row));
    return false;
  }

  return true;
}

async function login() {
  var btn = document.getElementById("login-btn");

  var data = {
    nom: document.getElementById("nom").value.trim(),
    numero: document.getElementById("numero").value.trim(),
    email: document.getElementById("email").value.trim(),
    licence: normalizeLicense(document.getElementById("license").value)
  };

  if (!data.nom || !data.numero || !data.licence) {
    showMessage("Preenche nome, telefone e chave de licenca.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "A verificar...";
  showMessage("");

  try {
    var result = await supabaseClient.rpc("activate_license", {
      p_license_key: data.licence,
      p_owner_name: data.nom,
      p_owner_phone: data.numero,
      p_owner_email: data.email || null
    });

    if (result.error) {
      showMessage(getLicenseErrorMessage(result.error));
      btn.disabled = false;
      btn.textContent = "Ativar";
      return;
    }

    var organization = result.data;

    if (!organization || !organization.id) {
      showMessage("Licence invalide.");
      btn.disabled = false;
      btn.textContent = "Ativar";
      return;
    }

    var deviceAllowed = await verifyLoginDeviceAccess(organization.id);

    if (!deviceAllowed) {
      btn.disabled = false;
      btn.textContent = "Ativar";
      return;
    }

    var profileResult = await supabaseClient
      .from("profiles")
      .upsert({
        organization_id: organization.id,
        name: data.nom,
        phone: data.numero,
        email: data.email || null,
        role: "owner"
      }, {
        onConflict: "organization_id,phone"
      });

    if (profileResult.error) {
      console.warn("Profil non cree, mais licence activee:", profileResult.error);
    }

    localStorage.setItem("azul_organization_id", organization.id);
    localStorage.setItem("azul_organization_name", organization.name || "");
    localStorage.setItem("azul_user_name", data.nom);
    localStorage.setItem("azul_license_key", organization.license_key || "");
    localStorage.setItem("azul_plan", organization.plan || "starter");

    document.body.innerHTML = `
      <div style="font-family: Arial; text-align:center; padding:40px;">
        <h1>Licenca ativada</h1>
        <p>Bem-vindo ao Azul Gestao</p>
        <p>Abrindo sistema...</p>
      </div>
    `;

    setTimeout(function () {
      window.location.href = "core.html";
    }, 1000);

  } catch (e) {
    showMessage(getLicenseErrorMessage(e));
    btn.disabled = false;
    btn.textContent = "Ativar";
  }
}
