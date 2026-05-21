(function() {
  var CACHE_KEY = "azul_i18n_mymemory_cache_v1";
  var EMAIL_KEY = "azul_i18n_mymemory_email";
  var CUSTOM_KEY = "azul_i18n_custom_resources_v1";

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value || {}));
  }

  function getLang() {
    try {
      if (typeof getCurrentLanguage === "function") {
        return getCurrentLanguage();
      }
      if (typeof config !== "undefined" && config && config.language) {
        return config.language;
      }
      return (window.config && window.config.language) || "pt";
    } catch (e) {
      try {
        var saved = JSON.parse(localStorage.getItem("pos_config") || "{}");
        return saved.language || "pt";
      } catch (e2) {
        return "pt";
      }
    }
  }

  function normalizeLang(lang) {
    lang = String(lang || "pt").toLowerCase();
    if (lang.indexOf("fr") === 0) return "fr";
    if (lang.indexOf("en") === 0) return "en";
    return "pt";
  }

  function pack(pt, fr, en) {
    return { pt: pt, fr: fr, en: en };
  }

  function normalizeStaticKey(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  var STATIC_TEXTS = {};

  function addStatic(keys, pt, fr, en) {
    keys.concat([pt, fr, en]).forEach(function(key) {
      STATIC_TEXTS[normalizeStaticKey(key)] = pack(pt, fr, en);
    });
  }

  [
    [["Dashboard"], "Dashboard", "Dashboard", "Dashboard"],
    [["Nova Venda", "Novo venda", "Nouvelle vente"], "Nova Venda", "Nouvelle Vente", "New Sale"],
    [["Nova Compra", "Novo Achat", "Nouvel achat"], "Nova Compra", "Nouvel Achat", "New Purchase"],
    [["Estoque", "Stock"], "Estoque", "Stock", "Stock"],
    [["Clientes", "Clients"], "Clientes", "Clients", "Clients"],
    [["Depenses", "Despesas", "DÃ©penses", "Dépenses"], "Despesas", "Depenses", "Expenses"],
    [["Fornecedores", "Fournisseurs"], "Fornecedores", "Fournisseurs", "Suppliers"],
    [["Tresorerie", "TrÃ©sorerie", "Trésorerie"], "Tesouraria", "Tresorerie", "Treasury"],
    [["Comptabilite", "ComptabilitÃ©", "Comptabilité"], "Contabilidade", "Comptabilite", "Accounting"],
    [["Revendeurs"], "Revendedores", "Revendeurs", "Resellers"],
    [["Definicoes", "DefiniÃ§Ãµes", "Définitions"], "Definicoes", "Parametres", "Settings"],

    [["Periodo", "Periode", "PÃ©riode"], "Periodo", "Periode", "Period"],
    [["Hoje"], "Hoje", "Aujourd'hui", "Today"],
    [["Esta semana"], "Esta semana", "Cette semaine", "This week"],
    [["Este mes", "Este mÃªs"], "Este mes", "Ce mois", "This month"],
    [["Personalizado"], "Personalizado", "Personnalise", "Custom"],
    [["De"], "De", "De", "From"],
    [["Ate", "AtÃ©"], "Ate", "A", "To"],
    [["Produto", "Produit"], "Produto", "Produit", "Product"],
    [["Fornecedor", "Fournisseur"], "Fornecedor", "Fournisseur", "Supplier"],
    [["Todos"], "Todos", "Tous", "All"],
    [["Aplicar", "Appliquer"], "Aplicar", "Appliquer", "Apply"],
    [["Imprimir"], "Imprimir", "Imprimer", "Print"],
    [["Actualiser", "Actualizar", "Refresh"], "Actualizar", "Actualiser", "Refresh"],
    [["Tout voir"], "Ver tudo", "Tout voir", "View all"],
    [["Filtrar", "Filtrer"], "Filtrar", "Filtrer", "Filter"],
    [["Effacer"], "Limpar", "Effacer", "Clear"],

    [["Vendas", "Ventes"], "Vendas", "Ventes", "Sales"],
    [["Lucro"], "Lucro", "Benefice", "Profit"],
    [["Receita - Custo"], "Receita - Custo", "Recettes - Couts", "Revenue - Cost"],
    [["Alertas Stock"], "Alertas de Stock", "Alertes Stock", "Stock Alerts"],
    [["produtos em falta"], "produtos em falta", "produits en rupture", "missing products"],
    [["0 transacoes", "0 transaÃ§Ãµes"], "0 transacoes", "0 transactions", "0 transactions"],
    [["0 registos"], "0 registos", "0 enregistrements", "0 records"],
    [["Top Produtos"], "Top Produtos", "Top Produits", "Top Products"],
    [["Meios de Pagamento"], "Meios de Pagamento", "Moyens de Paiement", "Payment Methods"],
    [["Alertas de Stock Baixo"], "Alertas de Stock Baixo", "Alertes de Stock Bas", "Low Stock Alerts"],
    [["Ultimas Depenses", "Ãšltimas Despesas"], "Ultimas Despesas", "Dernieres Depenses", "Latest Expenses"],

    [["TrÃ©sorerie rapide", "Trésorerie rapide", "Tresorerie rapide"], "Tesouraria rapida", "Tresorerie rapide", "Quick Treasury"],
    [["Solde disponible"], "Saldo disponivel", "Solde disponible", "Available Balance"],
    [["Solde du mois"], "Saldo do mes", "Solde du mois", "Monthly balance"],
    [["EntrÃ©es aujourdâ€™hui", "Entrées aujourd'hui"], "Entradas hoje", "Entrees aujourd'hui", "Today's inflows"],
    [["Sorties aujourdâ€™hui", "Sorties aujourd'hui"], "Saidas hoje", "Sorties aujourd'hui", "Today's outflows"],
    [["EntrÃ©es du mois", "Entrées du mois"], "Entradas do mes", "Entrees du mois", "Monthly inflows"],
    [["Sorties du mois"], "Saidas do mes", "Sorties du mois", "Monthly outflows"],
    [["RÃ©sultat du mois", "Résultat du mois"], "Resultado do mes", "Resultat du mois", "Monthly result"],
    [["A carregar mouvements..."], "A carregar movimentos...", "Chargement des mouvements...", "Loading movements..."],

    [["Situation des dettes"], "Situacao das dividas", "Situation des dettes", "Debt Situation"],
    [["Clients Ã  recevoir", "Clients à recevoir"], "Clientes a receber", "Clients a recevoir", "Client receivables"],
    [["Fournisseurs Ã  payer", "Fournisseurs à payer"], "Fornecedores a pagar", "Fournisseurs a payer", "Supplier payables"],
    [["Clients Ã  recevoir et fournisseurs Ã  payer.", "Clients à recevoir et fournisseurs à payer."], "Clientes a receber e fornecedores a pagar.", "Clients a recevoir et fournisseurs a payer.", "Client receivables and supplier payables."],
    [["Solde net"], "Saldo liquido", "Solde net", "Net balance"],
    [["Ã€ recevoir - Ã  payer", "À recevoir - à payer"], "A receber - a pagar", "A recevoir - a payer", "Receivable - payable"],
    [["Dossiers ouverts"], "Dossiers abertos", "Dossiers ouverts", "Open files"],
    [["clients + fournisseurs"], "clientes + fornecedores", "clients + fournisseurs", "clients + suppliers"],
    [["Clients dÃ©biteurs", "Clients débiteurs"], "Clientes devedores", "Clients debiteurs", "Debtor clients"],
    [["0 clients"], "0 clientes", "0 clients", "0 clients"],
    [["0 fournisseurs"], "0 fornecedores", "0 fournisseurs", "0 suppliers"],

    [["Vue achats"], "Visao de compras", "Vue achats", "Purchase Overview"],
    [["Suivi des achats, fournisseurs et crÃ©dits.", "Suivi des achats, fournisseurs et crédits."], "Acompanhamento de compras, fornecedores e creditos.", "Suivi des achats, fournisseurs et credits.", "Purchases, suppliers and credit tracking."],
    [["Achats aujourdâ€™hui", "Achats aujourd'hui"], "Compras hoje", "Achats aujourd'hui", "Today's purchases"],
    [["Achats du mois"], "Compras do mes", "Achats du mois", "Monthly purchases"],
    [["Achats Ã  crÃ©dit", "Achats à crédit"], "Compras a credito", "Achats a credit", "Credit purchases"],
    [["Dette fournisseurs"], "Divida fornecedores", "Dette fournisseurs", "Supplier debt"],
    [["Reste Ã  payer", "Reste a payer"], "Resta pagar", "Reste a payer", "Remaining to pay"],
    [["Fournisseur principal"], "Fornecedor principal", "Fournisseur principal", "Main supplier"],
    [["Derniers achats"], "Ultimas compras", "Derniers achats", "Latest purchases"],
    [["0 achats"], "0 compras", "0 achats", "0 purchases"],

    [["Stock intelligent"], "Stock inteligente", "Stock intelligent", "Smart Stock"],
    [["Valeur, ruptures, alertes et produits dormants."], "Valor, rupturas, alertas e produtos parados.", "Valeur, ruptures, alertes et produits dormants.", "Value, shortages, alerts and dormant products."],
    [["Voir stock"], "Ver stock", "Voir stock", "View stock"],
    [["Valeur totale stock"], "Valor total do stock", "Valeur totale stock", "Total stock value"],
    [["Boutique + dÃ©pÃ´t", "Boutique + dépôt"], "Boutique + armazem", "Boutique + depot", "Shop + warehouse"],
    [["Produits finis"], "Produtos esgotados", "Produits finis", "Out of stock"],
    [["stock total Ã  0", "stock total à 0"], "stock total a 0", "stock total a 0", "total stock at 0"],
    [["Stock faible"], "Stock baixo", "Stock faible", "Low stock"],
    [["sous le minimum"], "abaixo do minimo", "sous le minimum", "below minimum"],
    [["Produits dormants"], "Produtos parados", "Produits dormants", "Dormant products"],
    [["pas vendus sur la pÃ©riode", "pas vendus sur la période"], "sem vendas no periodo", "pas vendus sur la periode", "not sold in the period"],
    [["Alertes prioritaires"], "Alertas prioritarios", "Alertes prioritaires", "Priority Alerts"],

    [["Performance commerciale"], "Performance comercial", "Performance commerciale", "Sales Performance"],
    [["Ticket moyen, marge, clients et rythme des ventes."], "Ticket medio, margem, clientes e ritmo de vendas.", "Ticket moyen, marge, clients et rythme des ventes.", "Average ticket, margin, clients and sales pace."],
    [["Nouvelle vente"], "Nova venda", "Nouvelle vente", "New sale"],
    [["Ticket moyen"], "Ticket medio", "Ticket moyen", "Average ticket"],
    [["total ventes / transactions"], "total vendas / transacoes", "total ventes / transactions", "total sales / transactions"],
    [["Nombre de ventes"], "Numero de vendas", "Nombre de ventes", "Sales count"],
    [["transactions"], "transacoes", "transactions", "transactions"],
    [["Articles vendus"], "Artigos vendidos", "Articles vendus", "Items sold"],
    [["quantitÃ© totale", "quantité totale"], "quantidade total", "quantite totale", "total quantity"],
    [["Marge moyenne"], "Margem media", "Marge moyenne", "Average margin"],
    [["profit / ventes"], "lucro / vendas", "profit / ventes", "profit / sales"],
    [["Meilleur client"], "Melhor cliente", "Meilleur client", "Best client"],
    [["Meilleur vendeur"], "Melhor vendedor", "Meilleur vendeur", "Best seller"],
    [["Origine dominante"], "Origem dominante", "Origine dominante", "Dominant origin"],
    [["Plus gros panier"], "Maior carrinho", "Plus gros panier", "Biggest cart"],
    [["Top clients"], "Top clientes", "Top clients", "Top clients"],
    [["Origine des ventes"], "Origem das vendas", "Origine des ventes", "Sales origin"],

    [["Fiscal / Comptable"], "Fiscal / Contabil", "Fiscal / Comptable", "Tax / Accounting"],
    [["RÃ©sumÃ© fiscal/comptable", "Résumé fiscal/comptable"], "Resumo fiscal/contabil", "Resume fiscal/comptable", "Tax/accounting summary"],
    [["Vue simplifiÃ©e du rÃ©sultat, stock, crÃ©ances et dettes.", "Vue simplifiée du résultat, stock, créances et dettes."], "Visao simplificada do resultado, stock, valores a receber e dividas.", "Vue simplifiee du resultat, stock, creances et dettes.", "Simplified view of result, stock, receivables and debts."],
    [["Chiffre dâ€™affaires", "Chiffre d'affaires"], "Volume de negocios", "Chiffre d'affaires", "Revenue"],
    [["Ventes de la pÃ©riode", "Ventes de la période"], "Vendas do periodo", "Ventes de la periode", "Period sales"],
    [["CoÃ»t marchandises", "Coût marchandises"], "Custo das mercadorias", "Cout marchandises", "Cost of goods"],
    [["Prix dâ€™achat vendus", "Prix d'achat vendus"], "Preco de compra vendido", "Prix d'achat vendus", "Purchase cost sold"],
    [["Marge brute"], "Margem bruta", "Marge brute", "Gross margin"],
    [["Charges de la pÃ©riode", "Charges de la période"], "Despesas do periodo", "Charges de la periode", "Period expenses"],
    [["RÃ©sultat net estimÃ©", "Résultat net estimé"], "Resultado liquido estimado", "Resultat net estime", "Estimated net result"],
    [["Marge nette: 0%"], "Margem liquida: 0%", "Marge nette: 0%", "Net margin: 0%"],
    [["Stock valorisÃ©", "Stock valorisé"], "Stock valorizado", "Stock valorise", "Valued stock"],
    [["Actif simplifiÃ©", "Actif simplifié"], "Ativo simplificado", "Actif simplifie", "Simplified assets"],
    [["Passif simplifiÃ©", "Passif simplifié"], "Passivo simplificado", "Passif simplifie", "Simplified liabilities"],
    [["Situation nette"], "Situacao liquida", "Situation nette", "Net position"],

    [["Alertes"], "Alertas", "Alertes", "Alerts"],
    [["Alertes importantes"], "Alertas importantes", "Alertes importantes", "Important Alerts"],
    [["Ce qui demande ton attention avant de continuer Ã  vendre.", "Ce qui demande ton attention avant de continuer à vendre."], "O que precisa da tua atencao antes de continuar a vender.", "Ce qui demande ton attention avant de continuer a vendre.", "What needs attention before selling more."],
    [["Critiques"], "Criticos", "Critiques", "Critical"],
    [["Ã  traiter vite", "à traiter vite"], "a tratar rapido", "a traiter vite", "handle quickly"],
    [["Ã€ surveiller", "À surveiller"], "A acompanhar", "A surveiller", "To watch"],
    [["risque moyen"], "risco medio", "risque moyen", "medium risk"],
    [["Total alertes"], "Total alertas", "Total alertes", "Total alerts"],
    [["sur la pÃ©riode", "sur la période"], "no periodo", "sur la periode", "in the period"],
    [["A carregar alertes..."], "A carregar alertas...", "Chargement des alertes...", "Loading alerts..."],
    [["A carregar...", "A charger...", "Chargement..."], "A carregar...", "Chargement...", "Loading..."],
    [["A verificar..."], "A verificar...", "Verification...", "Checking..."],

    [["Carrinho"], "Carrinho", "Panier", "Cart"],
    [["Limpar"], "Limpar", "Vider", "Clear"],
    [["Data da venda"], "Data da venda", "Date de vente", "Sale date"],
    [["Adiciona produtos ao carrinho"], "Adiciona produtos ao carrinho", "Ajoute des produits au panier", "Add products to the cart"],
    [["Total"], "Total", "Total", "Total"],
    [["Stock"], "Stock", "Stock", "Stock"],
    [["Commande"], "Encomenda", "Commande", "Order"],
    [["Paiement"], "Pagamento", "Paiement", "Payment"],
    [["+ Ajouter moyen de paiement"], "+ Adicionar meio de pagamento", "+ Ajouter moyen de paiement", "+ Add payment method"],
    [["Pago: 0 Kz / Total: 0 Kz"], "Pago: 0 Kz / Total: 0 Kz", "Paye: 0 Kz / Total: 0 Kz", "Paid: 0 Kz / Total: 0 Kz"],
    [["A registar venda..."], "A registar venda...", "Enregistrement de la vente...", "Registering sale..."],
    [["Historico", "Historique"], "Historico", "Historique", "History"],
    [["Clica em Filtrar para carregar"], "Clica em Filtrar para carregar", "Clique sur Filtrer pour charger", "Click Filter to load"],

    [["Registar Novo Achat"], "Registar Nova Compra", "Enregistrer Nouvel Achat", "Register New Purchase"],
    [["Nome do fornecedor"], "Nome do fornecedor", "Nom du fournisseur", "Supplier name"],
    [["+ Adicionar produto"], "+ Adicionar produto", "+ Ajouter produit", "+ Add product"],
    [["Pedido total"], "Pedido total", "Total commande", "Order total"],
    [["Compra a crÃ©dito", "Compra a crédito"], "Compra a credito", "Achat a credit", "Credit purchase"],
    [["Marque esta caixa se ainda nÃ£o tiver pago integralmente a este fornecedor."], "Marque esta caixa se ainda nao tiver pago integralmente a este fornecedor.", "Coche si ce fournisseur n'est pas encore totalement paye.", "Check if this supplier has not been fully paid yet."],
    [["Total devido"], "Total devido", "Total du", "Amount due"],
    [["Pagamentos efetuados"], "Pagamentos efetuados", "Paiements effectues", "Payments made"],
    [["Valor pago"], "Valor pago", "Montant paye", "Amount paid"],
    [["Resto"], "Resto", "Reste", "Remaining"],
    [["+ Pagamento adicional"], "+ Pagamento adicional", "+ Paiement additionnel", "+ Additional payment"],
    [["Total paye"], "Total pago", "Total paye", "Total paid"],
    [["Registar Achat"], "Registar Compra", "Enregistrer Achat", "Register Purchase"],
    [["Historique des achats"], "Historico de compras", "Historique des achats", "Purchase History"],
    [["Recherche par produit, fournisseur, code ou variation."], "Pesquisa por produto, fornecedor, codigo ou variacao.", "Recherche par produit, fournisseur, code ou variation.", "Search by product, supplier, code or variation."],
    [["Total achats"], "Total compras", "Total achats", "Total purchases"],
    [["Total payÃ©", "Total payé"], "Total pago", "Total paye", "Total paid"],
    [["Dette"], "Divida", "Dette", "Debt"],
    [["QuantitÃ©", "Quantidade", "Quantité"], "Quantidade", "Quantite", "Quantity"],
    [["articles achetÃ©s", "articles achetés"], "artigos comprados", "articles achetes", "items purchased"]
  ].forEach(function(item) {
    addStatic(item[0], item[1], item[2], item[3]);
  });

  function cacheKey(sourceLang, targetLang, text) {
    return normalizeLang(sourceLang) + "|" + normalizeLang(targetLang) + "|" + String(text || "").trim();
  }

  function getCustomResources() {
    return readJson(CUSTOM_KEY, {});
  }

  function setCustomResource(lang, key, value) {
    var resources = getCustomResources();
    lang = normalizeLang(lang);
    resources[lang] = resources[lang] || {};
    resources[lang][key] = value;
    writeJson(CUSTOM_KEY, resources);
  }

  function t(key, fallback, lang) {
    lang = normalizeLang(lang || getLang());
    var resources = getCustomResources();
    if (resources[lang] && resources[lang][key]) return resources[lang][key];
    return fallback || key;
  }

  async function translateWithMyMemory(text, sourceLang, targetLang) {
    text = String(text || "").trim();
    sourceLang = normalizeLang(sourceLang || "pt");
    targetLang = normalizeLang(targetLang || getLang());

    if (!text || sourceLang === targetLang) return text;

    var cache = readJson(CACHE_KEY, {});
    var key = cacheKey(sourceLang, targetLang, text);
    if (cache[key]) return cache[key];

    var email = localStorage.getItem(EMAIL_KEY) || "";
    var url = "https://api.mymemory.translated.net/get?q=" +
      encodeURIComponent(text) +
      "&langpair=" + encodeURIComponent(sourceLang + "|" + targetLang);

    if (email) {
      url += "&de=" + encodeURIComponent(email);
    }

    var response = await fetch(url);
    if (!response.ok) {
      throw new Error("MyMemory HTTP " + response.status);
    }

    var data = await response.json();
    var translated = data &&
      data.responseData &&
      data.responseData.translatedText
        ? String(data.responseData.translatedText)
        : text;

    cache[key] = translated;
    writeJson(CACHE_KEY, cache);
    return translated;
  }

  function shouldTranslateElement(el) {
    if (!el || !el.textContent) return false;
    if (el.children && el.children.length) return false;
    if (el.closest("table,.data-table,.prod-grid,.mobile-card-list,.cart,.receipt-box,.toast,.payment-modal")) return false;
    if (/^(input|textarea|select|option|script|style)$/i.test(el.tagName)) return false;

    var text = el.textContent.trim();
    if (!text || text.length < 3 || text.length > 80) return false;
    if (/^[\d\s.,:;/%()+-]+$/.test(text)) return false;
    return true;
  }

  function getTranslatableElements(root) {
    root = root || document.querySelector(".page.active") || document.body;
    return Array.prototype.slice.call(root.querySelectorAll("button,label,h1,h2,h3,h4,.card-title,.section-title,.form-label,.kpi-label,.empty,p,span"))
      .filter(shouldTranslateElement);
  }

  function snapshotVisibleTexts() {
    return getTranslatableElements().map(function(el) {
      return {
        el: el,
        text: el.textContent.trim()
      };
    });
  }

  async function translateVisiblePage(targetLang, sourceLang) {
    targetLang = normalizeLang(targetLang || getLang());
    sourceLang = normalizeLang(sourceLang || "pt");

    var candidates = getTranslatableElements();
    var translated = 0;

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!shouldTranslateElement(el)) continue;

      var original = el.textContent.trim();
      try {
        el.textContent = await translateWithMyMemory(original, sourceLang, targetLang);
        translated += 1;
      } catch (e) {
        console.warn("MyMemory translation failed:", e);
      }
    }

    return translated;
  }

  async function translateUnchangedTexts(snapshots, sourceLang, targetLang) {
    targetLang = normalizeLang(targetLang || getLang());
    sourceLang = normalizeLang(sourceLang || "pt");

    if (targetLang === sourceLang || targetLang === "pt") return 0;

    var translated = 0;

    for (var i = 0; i < snapshots.length; i++) {
      var item = snapshots[i];
      if (!item.el || !document.body.contains(item.el)) continue;
      if (item.el.textContent.trim() !== item.text) continue;

      try {
        item.el.textContent = await translateWithMyMemory(item.text, sourceLang, targetLang);
        translated += 1;
      } catch (e) {
        console.warn("MyMemory auto translation failed:", e);
      }
    }

    return translated;
  }

  var staticApplyTimer = null;
  var staticApplying = false;

  function translateStaticText(text, lang) {
    lang = normalizeLang(lang || getLang());
    var row = STATIC_TEXTS[normalizeStaticKey(text)];
    if (!row) return null;
    return row[lang] || row.pt || text;
  }

  function applyStaticDictionary(root, forcedLang) {
    if (staticApplying) return 0;
    root = root || document;
    var lang = normalizeLang(forcedLang || getLang());
    var translated = 0;
    var selector = "button,label,h1,h2,h3,h4,p,span,small,th,td,option,.card-title,.section-title,.form-label,.kpi-label,.kpi-sub,.empty,.eyebrow";

    staticApplying = true;
    try {
      Array.prototype.slice.call(root.querySelectorAll(selector)).forEach(function(el) {
        if (!el || !el.textContent) return;
        if (/^(script|style)$/i.test(el.tagName)) return;
        if (el.children && el.children.length) return;

        var current = el.textContent;
        var next = translateStaticText(current, lang);
        if (next && next !== current.trim()) {
          el.textContent = next;
          translated += 1;
        }
      });

      Array.prototype.slice.call(root.querySelectorAll("input[placeholder],textarea[placeholder]")).forEach(function(el) {
        var next = translateStaticText(el.getAttribute("placeholder"), lang);
        if (next && next !== el.getAttribute("placeholder")) {
          el.setAttribute("placeholder", next);
          translated += 1;
        }
      });
    } finally {
      staticApplying = false;
    }

    return translated;
  }

  function scheduleStaticDictionary(root, forcedLang) {
    clearTimeout(staticApplyTimer);
    staticApplyTimer = setTimeout(function() {
      applyStaticDictionary(root || document, forcedLang);
    }, 120);
  }

  function watchStaticTexts() {
    if (!document.body || window.__azulStaticI18nObserver) return;
    window.__azulStaticI18nObserver = new MutationObserver(function(mutations) {
      if (staticApplying || window._applyingLanguage) return;
      var shouldRun = mutations.some(function(mutation) {
        return mutation.type === "childList" && mutation.addedNodes && mutation.addedNodes.length;
      });
      if (shouldRun) scheduleStaticDictionary(document);
    });
    window.__azulStaticI18nObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function handleLanguageSelectChange(select) {
    var previousLang = normalizeLang(getLang());
    var targetLang = normalizeLang(select && select.value ? select.value : previousLang);
    var snapshots = snapshotVisibleTexts();

    try {
      if (typeof config !== "undefined" && config) {
        config.language = targetLang;
      }
    } catch (e) {}

    if (window.config) {
      window.config.language = targetLang;
    }

    if (typeof saveConfig === "function") {
      saveConfig();
    }

    if (typeof applyLanguage === "function") {
      applyLanguage();
    }

    setTimeout(function() {
      applyStaticDictionary(document, targetLang);
      translateUnchangedTexts(snapshots, previousLang, targetLang);
    }, 80);
  }

  function bindLanguageSelect() {
    var select = document.getElementById("cfg-language");
    if (!select || select.dataset.azulI18nBound === "1") return;

    select.dataset.azulI18nBound = "1";
    select.addEventListener("change", function() {
      handleLanguageSelectChange(select);
    });
  }

  window.AzulI18n = {
    t: t,
    set: setCustomResource,
    getEmail: function() { return localStorage.getItem(EMAIL_KEY) || ""; },
    setEmail: function(email) { localStorage.setItem(EMAIL_KEY, String(email || "").trim()); },
    clearCache: function() { localStorage.removeItem(CACHE_KEY); },
    translateText: translateWithMyMemory,
    translateVisiblePage: translateVisiblePage,
    translateUnchangedTexts: translateUnchangedTexts,
    applyStaticDictionary: applyStaticDictionary,
    scheduleStaticDictionary: scheduleStaticDictionary,
    handleLanguageSelectChange: handleLanguageSelectChange,
    bindLanguageSelect: bindLanguageSelect
  };

  document.addEventListener("DOMContentLoaded", function() {
    bindLanguageSelect();
    applyStaticDictionary(document);
    watchStaticTexts();
  });

  setTimeout(function() {
    bindLanguageSelect();
    applyStaticDictionary(document);
    watchStaticTexts();
  }, 1200);
})();
