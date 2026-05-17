function showMessage(text, type) {
  var box = document.getElementById('login-message');
  box.textContent = text || '';
  box.className = 'login-message' + (type === 'success' ? ' success' : '');
}

function normalizeLicense(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function formatLicenseInput(input) {
  input.value = normalizeLicense(input.value);
}

function login() {
  var btn = document.getElementById('login-btn');

  var data = {
    nom: document.getElementById('nom').value.trim(),
    numero: document.getElementById('numero').value.trim(),
    email: document.getElementById('email').value.trim(),
    licence: normalizeLicense(document.getElementById('license').value),
    statut: "active"
  };

  if (!data.nom || !data.numero || !data.licence) {
    showMessage('Preenche nome, telefone e chave de licenca.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'A verificar...';
  showMessage('');

  google.script.run
    .withSuccessHandler(function(resultat) {

      if (resultat && resultat.ok === false) {
        showMessage(resultat.message || 'Licenca invalida.');
        btn.disabled = false;
        btn.textContent = 'Ativar';
        return;
      }

      // 🎉 UI succès joli
      document.body.innerHTML = `
        <div style="
          height:100vh;
          display:flex;
          align-items:center;
          justify-content:center;
          flex-direction:column;
          font-family:Arial,sans-serif;
          text-align:center;
        ">
          <h1 style="color:#0b3d91;">✅ Licenca ativada</h1>
          <p style="font-size:16px;">Bem-vindo ao Azul Gestao</p>
          <p style="color:#777;">Abrindo sistema...</p>
        </div>
      `;

      // ⏱️ délai + ouverture POS
      setTimeout(function () {
        google.script.host.close();

        google.script.run
          .withFailureHandler(function(e) {
            alert("Erro ao abrir POS: " + e.message);
          })
          .abrirPOSApresActivation();

      }, 1200);
    })

    .withFailureHandler(function(e) {
      showMessage((e && e.message) ? e.message : 'Erro ao ativar licenca.');
      btn.disabled = false;
      btn.textContent = 'Ativar';
    })

    .saveUtilisateur(data.nom, data.numero, data.email, data.licence, data.statut);
}