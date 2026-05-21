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
      return (window.config && window.config.language) || "pt";
    } catch (e) {
      return "pt";
    }
  }

  function normalizeLang(lang) {
    lang = String(lang || "pt").toLowerCase();
    if (lang.indexOf("fr") === 0) return "fr";
    if (lang.indexOf("en") === 0) return "en";
    return "pt";
  }

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

  async function translateVisiblePage(targetLang, sourceLang) {
    targetLang = normalizeLang(targetLang || getLang());
    sourceLang = normalizeLang(sourceLang || "pt");

    var root = document.querySelector(".page.active") || document.body;
    var candidates = Array.prototype.slice.call(root.querySelectorAll("button,label,h1,h2,h3,h4,.card-title,.section-title,.form-label,.kpi-label,.empty,p,span"));
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

  function ensureI18nSettingsCard() {
    var page = document.getElementById("page-settings");
    if (!page || document.getElementById("azulI18nSettingsCard")) return;

    var grid = page.querySelector('div[style*="grid-template-columns"]') || page;
    var card = document.createElement("div");
    card.className = "card azul-i18n-card";
    card.id = "azulI18nSettingsCard";
    card.style.gridColumn = "1/-1";
    card.innerHTML =
      '<div class="card-title">Traduction intelligente</div>' +
      '<p class="azul-i18n-help">Les traductions internes restent prioritaires. MyMemory sert seulement a aider pour les textes manquants ou visibles.</p>' +
      '<div class="azul-i18n-grid">' +
        '<div class="form-group">' +
          '<label class="form-label">Email MyMemory</label>' +
          '<input id="azulMyMemoryEmail" class="form-input" type="email" placeholder="email optionnel pour quota plus eleve">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label">Source</label>' +
          '<select id="azulI18nSource" class="form-input"><option value="pt">Portugais</option><option value="fr">Francais</option><option value="en">Anglais</option></select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label">Cible</label>' +
          '<select id="azulI18nTarget" class="form-input"><option value="fr">Francais</option><option value="pt">Portugais</option><option value="en">Anglais</option></select>' +
        '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Texte test</label>' +
        '<input id="azulI18nTestText" class="form-input" type="text" placeholder="Ex: Registar despesa">' +
      '</div>' +
      '<div class="azul-i18n-actions">' +
        '<button type="button" class="form-submit" onclick="AzulI18n.translateTest()">Traduire le test</button>' +
        '<button type="button" class="filter-btn" onclick="AzulI18n.translateCurrentPage()">Traduire la page active</button>' +
      '</div>' +
      '<div id="azulI18nResult" class="azul-i18n-result"></div>';

    var saveCard = page.querySelector('.card button[onclick="saveAllSettings()"]');
    if (saveCard && saveCard.closest(".card")) {
      grid.insertBefore(card, saveCard.closest(".card"));
    } else {
      grid.appendChild(card);
    }

    var email = document.getElementById("azulMyMemoryEmail");
    var target = document.getElementById("azulI18nTarget");
    if (email) {
      email.value = localStorage.getItem(EMAIL_KEY) || "";
      email.addEventListener("input", function() {
        localStorage.setItem(EMAIL_KEY, email.value.trim());
      });
    }
    if (target) target.value = getLang();
  }

  window.AzulI18n = {
    t: t,
    set: setCustomResource,
    getEmail: function() { return localStorage.getItem(EMAIL_KEY) || ""; },
    setEmail: function(email) { localStorage.setItem(EMAIL_KEY, String(email || "").trim()); },
    clearCache: function() { localStorage.removeItem(CACHE_KEY); },
    translateText: translateWithMyMemory,
    translateVisiblePage: translateVisiblePage,
    translateTest: async function() {
      var source = document.getElementById("azulI18nSource");
      var target = document.getElementById("azulI18nTarget");
      var text = document.getElementById("azulI18nTestText");
      var result = document.getElementById("azulI18nResult");
      if (!text || !text.value.trim()) return;

      if (result) result.textContent = "Traduction...";
      try {
        var translated = await translateWithMyMemory(text.value, source ? source.value : "pt", target ? target.value : getLang());
        if (result) result.textContent = translated;
      } catch (e) {
        if (result) result.textContent = "Erreur MyMemory: " + (e.message || e);
      }
    },
    translateCurrentPage: async function() {
      var source = document.getElementById("azulI18nSource");
      var target = document.getElementById("azulI18nTarget");
      var result = document.getElementById("azulI18nResult");
      if (result) result.textContent = "Traduction de la page...";

      var count = await translateVisiblePage(target ? target.value : getLang(), source ? source.value : "pt");
      if (result) result.textContent = count + " texte(s) traduit(s).";
    },
    initSettingsCard: ensureI18nSettingsCard
  };

  document.addEventListener("DOMContentLoaded", function() {
    ensureI18nSettingsCard();
  });
})();
