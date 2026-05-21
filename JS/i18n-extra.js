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

  function handleLanguageSelectChange(select) {
    var previousLang = normalizeLang(getLang());
    var targetLang = normalizeLang(select && select.value ? select.value : previousLang);
    var snapshots = snapshotVisibleTexts();

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
    handleLanguageSelectChange: handleLanguageSelectChange,
    bindLanguageSelect: bindLanguageSelect
  };

  document.addEventListener("DOMContentLoaded", function() {
    bindLanguageSelect();
  });

  setTimeout(bindLanguageSelect, 1200);
})();
