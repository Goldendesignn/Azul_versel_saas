document.addEventListener("DOMContentLoaded", async function () {
  var organizationId = localStorage.getItem("azul_organization_id");

  try {
    var sessionResult = await supabaseClient.auth.getSession();

    if (organizationId && sessionResult.data && sessionResult.data.session) {
      window.location.href = "core.html";
      return;
    }

    if (sessionResult.data && sessionResult.data.session) {
      await restoreSessionFromAuth();
      return;
    }

    if (organizationId) {
      clearLoginSessionOnly();
    }
  } catch (e) {
    console.warn("Sessao nao restaurada:", e);
  }
});

function clearLoginSessionOnly() {
  localStorage.removeItem("azul_organization_id");
  localStorage.removeItem("azul_organization_name");
  localStorage.removeItem("azul_user_name");
  localStorage.removeItem("azul_user_role");
  localStorage.removeItem("azul_user_status");
  localStorage.removeItem("azul_license_key");
  localStorage.removeItem("azul_plan");
}

function showMessage(text, type) {
  var box = document.getElementById("login-message");
  if (!box) return;

  box.textContent = text || "";
  box.className = "login-message" + (type === "success" ? " success" : "");
}

function normalizeLicense(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function formatLicenseInput(input) {
  input.value = normalizeLicense(input.value);
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

  return "Navegador";
}

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function isEmail(value) {
  return String(value || "").indexOf("@") >= 0;
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

  return "Erro ao validar a licenca.";
}

function getAuthErrorMessage(error) {
  var raw = String(error && error.message ? error.message : error || "");
  var msg = raw.toLowerCase();

  if (msg.indexOf("invalid login") >= 0 || msg.indexOf("invalid credentials") >= 0) {
    return "Email/telefone ou palavra-passe incorretos.";
  }

  if (msg.indexOf("already registered") >= 0 || msg.indexOf("already exists") >= 0 || msg.indexOf("user already") >= 0) {
    return "Este email ja tem conta. Use a opcao Entrar.";
  }

  if (msg.indexOf("signup") >= 0 && msg.indexOf("disabled") >= 0) {
    return "O registo de novos usuarios esta desativado no Supabase.";
  }

  if (msg.indexOf("password") >= 0) {
    return "A palavra-passe deve ter pelo menos 6 caracteres.";
  }

  if (msg.indexOf("auth_session_required") >= 0) {
    return "A conta foi criada, mas a sessao ainda nao esta ativa. Confirme o email ou entre novamente.";
  }

  if (msg.indexOf("existing_auth_password_required") >= 0) {
    return "Este email ja existe na autenticacao. Use a palavra-passe antiga ou elimine o utilizador em Supabase Authentication > Users.";
  }

  if (msg.indexOf("auth_email_confirmation_required") >= 0) {
    return "Confirme o email recebido e volte a concluir a ativacao com a mesma licenca.";
  }

  if (msg.indexOf("email") >= 0) {
    return "Verifique o email informado.";
  }

  return "Erro Supabase Auth: " + raw;
}

function getDeviceAccessMessage(row) {
  row = row || {};

  if (row.message === "DEVICE_LIMIT_REACHED") {
    return "Limite de aparelhos atingido: " + (row.active_devices || 0) + "/" + (row.device_limit || 0) + ". Contacte o administrador.";
  }

  if (row.message === "LICENCA_INATIVA") {
    return "Licenca desativada. Contacte o administrador.";
  }

  if (row.message === "LICENCA_EXPIRADA") {
    return "Licenca expirada. Renove a sua assinatura.";
  }

  return "Acesso recusado.";
}

function getProfileAccessMessage(profile) {
  var status = String(profile && profile.status ? profile.status : "").toLowerCase();

  if (status === "pending") {
    return "A tua conta esta a aguardar autorizacao do proprietario.";
  }

  if (status === "blocked" || status === "inactive" || status === "suspended") {
    return "Acesso recusado. Contacte o proprietario da loja.";
  }

  return "";
}

function isProfileActive(profile) {
  return String(profile && profile.status ? profile.status : "active").toLowerCase() === "active";
}

function isProfilePending(profile) {
  return String(profile && profile.status ? profile.status : "").toLowerCase() === "pending";
}

async function getProfileByIdentifier(identifier) {
  var result = await supabaseClient.rpc("get_login_profile_v2", {
    p_identifier: identifier
  }).maybeSingle();

  if (result.error && String(result.error.message || "").indexOf("get_login_profile_v2") >= 0) {
    result = await supabaseClient.rpc("get_login_profile", {
      p_identifier: identifier
    });
  }

  if (result.error) {
    throw result.error;
  }

  return Array.isArray(result.data) ? (result.data[0] || null) : (result.data || null);
}

async function ensureFirstOwnerProfile(profile) {
  if (!profile || !profile.organization_id) return profile;

  var result = await supabaseClient.rpc("ensure_first_owner_profile", {
    p_organization_id: profile.organization_id
  }).maybeSingle();

  if (result.error) {
    var message = String(result.error.message || "");

    // Mantem compatibilidade enquanto o SQL da V2 ainda nao foi instalado.
    if (
      message.indexOf("ensure_first_owner_profile") >= 0 ||
      message.indexOf("PGRST202") >= 0
    ) {
      return profile;
    }

    throw result.error;
  }

  return result.data || profile;
}

async function checkOrganizationAccess(organizationId) {
  var result = await supabaseClient.rpc("check_license_status", {
    p_organization_id: organizationId
  });

  if (result.error) {
    throw result.error;
  }

  return result.data;
}

async function registerLicenseOrTeamAccess(data) {
  var result = await supabaseClient.rpc("register_license_access", {
    p_license_key: data.licence,
    p_store_name: data.storeName,
    p_name: data.nom,
    p_phone: data.numero,
    p_email: data.email
  }).maybeSingle();

  if (result.error) {
    throw result.error;
  }

  return result.data || null;
}

async function validateLicenseForRegistration(licenseKey) {
  var result = await supabaseClient.rpc("validate_license_registration", {
    p_license_key: licenseKey
  }).maybeSingle();

  if (result.error) throw result.error;
  return result.data || null;
}

async function authenticateRegistrationUser(data) {
  var signInResult = await supabaseClient.auth.signInWithPassword({
    email: data.email,
    password: data.password
  });

  if (!signInResult.error && signInResult.data && signInResult.data.session) {
    return signInResult.data.session;
  }

  var signUpResult = await supabaseClient.auth.signUp({
    email: data.email,
    password: data.password,
    options: {
      data: {
        name: data.nom,
        phone: data.numero
      }
    }
  });

  if (signUpResult.error) {
    var signUpMessage = String(signUpResult.error.message || "").toLowerCase();

    if (
      signUpMessage.indexOf("already") >= 0 ||
      signUpMessage.indexOf("registered") >= 0 ||
      signUpMessage.indexOf("exists") >= 0
    ) {
      throw new Error("EXISTING_AUTH_PASSWORD_REQUIRED");
    }

    throw signUpResult.error;
  }

  var signUpUser = signUpResult.data && signUpResult.data.user;
  var identities = signUpUser && Array.isArray(signUpUser.identities)
    ? signUpUser.identities
    : null;

  // Supabase pode ocultar que o email ja existe devolvendo um utilizador sem identidade.
  if (identities && identities.length === 0) {
    throw new Error("EXISTING_AUTH_PASSWORD_REQUIRED");
  }

  var session = signUpResult.data && signUpResult.data.session;

  if (!session) {
    throw new Error("AUTH_EMAIL_CONFIRMATION_REQUIRED");
  }

  return session;
}

function saveSession(organization, profile, licenseKey) {
  localStorage.setItem("azul_organization_id", organization.id || organization.organization_id);
  localStorage.setItem("azul_organization_name", organization.name || "");
  localStorage.setItem("azul_user_name", profile && profile.name ? profile.name : "");
  localStorage.setItem("azul_user_role", profile && profile.role ? profile.role : "member");
  localStorage.setItem("azul_user_status", profile && profile.status ? profile.status : "active");
  localStorage.setItem("azul_license_key", licenseKey || organization.license_key || "");
  localStorage.setItem("azul_plan", organization.plan || "starter");
}

function openCoreSession(organization, profile, licenseKey) {
  saveSession(organization, profile, licenseKey);
  window.location.replace("core.html");
}

async function restoreSessionFromAuth() {
  var userResult = await supabaseClient.auth.getUser();

  if (userResult.error || !userResult.data || !userResult.data.user) {
    return false;
  }

  var user = userResult.data.user;
  var email = user.email || "";

  if (!email) return false;

  var profile = await getProfileByIdentifier(email);

  if (!profile || !profile.organization_id) {
    return false;
  }

  profile = await ensureFirstOwnerProfile(profile);

  if (!isProfileActive(profile) && !isProfilePending(profile)) {
    await supabaseClient.auth.signOut();
    showMessage(getProfileAccessMessage(profile));
    return false;
  }

  var organization = await checkOrganizationAccess(profile.organization_id);

  openCoreSession(organization, profile, organization.license_key);
  return true;
}

async function loginAccount() {
  var btn = document.getElementById("account-login-btn");
  var identifier = document.getElementById("login-identifier").value.trim();
  var password = document.getElementById("login-password").value;

  if (!identifier || !password) {
    showMessage("Informe email/telefone e palavra-passe.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "A entrar...";
  showMessage("");

  try {
    var profile = null;
    var authEmail = "";

    if (isEmail(identifier)) {
      authEmail = identifier.toLowerCase();
    } else {
      profile = await getProfileByIdentifier(identifier);
      authEmail = profile && profile.email ? profile.email : "";
    }

    if (!authEmail) {
      showMessage("Conta nao encontrada.");
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    var authResult = await supabaseClient.auth.signInWithPassword({
      email: authEmail,
      password: password
    });

    if (authResult.error) {
      showMessage(getAuthErrorMessage(authResult.error));
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    if (!profile) {
      profile = await getProfileByIdentifier(authEmail);
    }

    if (!profile || !profile.organization_id) {
      showMessage("A conta existe, mas ainda nao esta ligada a uma empresa. Use Criar conta com uma licenca valida.");
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    profile = await ensureFirstOwnerProfile(profile);

    if (!isProfileActive(profile) && !isProfilePending(profile)) {
      await supabaseClient.auth.signOut();
      showMessage(getProfileAccessMessage(profile));
      btn.disabled = false;
      btn.textContent = "Entrar";
      return;
    }

    var organization = await checkOrganizationAccess(profile.organization_id);

    openCoreSession(organization, profile, organization.license_key);

  } catch (e) {
    showMessage(getLicenseErrorMessage(e));
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
}

async function login() {
  var btn = document.getElementById("login-btn");

  var data = {
    licence: normalizeLicense(document.getElementById("license").value),
    storeName: document.getElementById("store-name").value.trim(),
    nom: document.getElementById("nom").value.trim(),
    numero: document.getElementById("numero").value.trim(),
    email: document.getElementById("email").value.trim().toLowerCase(),
    password: document.getElementById("register-password").value,
    passwordConfirm: document.getElementById("register-password-confirm").value
  };

  if (!data.licence || !data.storeName || !data.nom || !data.numero || !data.email || !data.password) {
    showMessage("Preencha todos os campos obrigatorios.");
    return;
  }

  if (!isEmail(data.email)) {
    showMessage("Informe um email valido.");
    return;
  }

  if (data.password.length < 6) {
    showMessage("A palavra-passe deve ter pelo menos 6 caracteres.");
    return;
  }

  if (data.password !== data.passwordConfirm) {
    showMessage("As palavras-passe nao coincidem.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "A ativar...";
  showMessage("");

  try {
    var licensePreview = await validateLicenseForRegistration(data.licence);

    if (!licensePreview || !licensePreview.organization_id) {
      showMessage("Licenca invalida.");
      btn.disabled = false;
      btn.textContent = "Ativar o meu ERP";
      return;
    }

    await authenticateRegistrationUser(data);

    var access = await registerLicenseOrTeamAccess(data);

    if (!access || !access.organization_id) {
      throw new Error("LICENCA_INVALIDA");
    }

    var organization = {
      id: access.organization_id,
      name: access.organization_name || data.storeName,
      license_key: access.license_key || data.licence,
      plan: access.plan || "starter"
    };

    var profile = {
      organization_id: access.organization_id,
      name: data.nom,
      phone: data.numero,
      email: data.email,
      role: access.role || "member",
      status: access.status || "pending"
    };

    profile = await ensureFirstOwnerProfile(profile);

    if (!isProfileActive(profile) && !isProfilePending(profile)) {
      await supabaseClient.auth.signOut();
      showMessage(getProfileAccessMessage(profile));
      btn.disabled = false;
      btn.textContent = "Ativar o meu ERP";
      return;
    }

    openCoreSession(organization, profile, organization.license_key);

  } catch (e) {
    var message = String(e && e.message ? e.message : e || "");
    showMessage(
      message.indexOf("AUTH_") >= 0 ||
      message.toLowerCase().indexOf("password") >= 0 ||
      message.toLowerCase().indexOf("email") >= 0 ||
      message.toLowerCase().indexOf("already") >= 0
        ? getAuthErrorMessage(e)
        : getLicenseErrorMessage(e)
    );
    btn.disabled = false;
    btn.textContent = "Ativar o meu ERP";
  }
}
