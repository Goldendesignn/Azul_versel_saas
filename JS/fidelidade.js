(function() {
  var card = document.getElementById("loyaltyPublicCard");

  function fmt(n) {
    return new Intl.NumberFormat("pt-PT").format(Number(n) || 0);
  }

  function money(n) {
    return fmt(n) + " Kz";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getToken() {
    return new URLSearchParams(window.location.search).get("t") || "";
  }

  function renderError(message) {
    card.innerHTML =
      '<div class="loyalty-public-logo">Azul</div>' +
      '<div class="loyalty-public-error">' + escapeHtml(message) + '</div>';
  }

  function renderCard(data) {
    var discount = Number(data.redeem_points || 0) > 0 && Number(data.redeem_value || 0) > 0
      ? fmt(data.redeem_points) + " pontos podem valer " + money(data.redeem_value) + " de desconto."
      : "Guarde os seus pontos para as proximas compras.";

    card.innerHTML =
      '<div class="loyalty-public-logo">Azul</div>' +
      '<h1 class="loyalty-public-title">' + escapeHtml(data.client_name || "Cliente") + '</h1>' +
      '<div class="loyalty-public-store">' + escapeHtml(data.organization_name || "Loja") + '</div>' +
      '<div class="loyalty-public-points">' +
        '<strong>' + fmt(data.points_balance) + '</strong>' +
        '<span>pontos disponiveis</span>' +
      '</div>' +
      '<div class="loyalty-public-grid">' +
        '<div><small>Total comprado</small><b>' + money(data.total_spent) + '</b></div>' +
        '<div><small>Pontos ganhos</small><b>' + fmt(data.total_points_earned) + '</b></div>' +
        '<div><small>Pontos usados</small><b>' + fmt(data.total_points_used) + '</b></div>' +
        '<div><small>Regra</small><b>' + money(data.kz_per_point) + ' = 1 ponto</b></div>' +
      '</div>' +
      '<div class="loyalty-public-note">' + escapeHtml(discount) + '</div>';
  }

  async function init() {
    var token = getToken();
    if (!token) {
      renderError("Ficha de fidelidade invalida.");
      return;
    }

    var result = await supabaseClient.rpc("get_public_loyalty_card", { p_token: token });
    if (result.error) {
      renderError("Nao foi possivel carregar a ficha.");
      return;
    }

    var data = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!data) {
      renderError("Ficha de fidelidade nao encontrada.");
      return;
    }

    renderCard(data);
  }

  init().catch(function(error) {
    console.error("Erro fidelidade publica:", error);
    renderError("Erro ao carregar a ficha.");
  });
})();
