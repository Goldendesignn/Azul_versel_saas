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
    var { data: organization, error } = await supabaseClient
      .from("organizations")
      .select("*")
      .eq("license_key", data.licence)
      .eq("status", "active")
      .single();

   if (error || !organization) {
  console.error("Erro Supabase:", error);

  showMessage(
    error ? "Erro Supabase: " + error.message : "Licenca invalida ou inativa."
  );

  btn.disabled = false;
  btn.textContent = "Ativar";
  return;
}


    var { error: profileError } = await supabaseClient
      .from("profiles")
      .insert({
        organization_id: organization.id,
        name: data.nom,
        phone: data.numero,
        email: data.email || null,
        role: "owner"
      });

    if (profileError) {
      throw profileError;
    }

    localStorage.setItem("azul_organization_id", organization.id);
    localStorage.setItem("azul_organization_name", organization.name);
    localStorage.setItem("azul_user_name", data.nom);

    document.body.innerHTML = `
      <div style="font-family: Arial; text-align:center; padding:40px;">
        <h1>Licenca ativada</h1>
        <p>Bem-vindo ao Azul Gestao</p>
        <p>Abrindo sistema...</p>
      </div>
    `;

    setTimeout(function () {
      window.location.href = "core.html";
    }, 1200);

  } catch (e) {
    showMessage(e.message || "Erro ao ativar licenca.");
    btn.disabled = false;
    btn.textContent = "Ativar";
  }
}
