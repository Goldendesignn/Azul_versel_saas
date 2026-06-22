var shopStore = null;
var shopProducts = [];
var shopCart = [];
var shopCartOpen = false;
var shopHeroIndex = 0;
var shopHeroTimer = null;
var shopHeroTouchStartX = 0;
var shopCategories = [];
var shopActiveCategory = "";

function shopParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function shopMoney(value) {
  value = Number(value) || 0;
  return value.toLocaleString("pt-AO", { maximumFractionDigits: 0 }) + " Kz";
}

function shopEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeShopPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeShopColor(value) {
  var color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#0b3d91";
}

function darkenShopColor(hex) {
  var color = normalizeShopColor(hex).slice(1);
  var parts = [0, 2, 4].map(function(start) {
    return Math.max(0, Math.round(parseInt(color.slice(start, start + 2), 16) * 0.62));
  });
  return "#" + parts.map(function(part) {
    return part.toString(16).padStart(2, "0");
  }).join("");
}

function getShopFontFamily(value) {
  var font = String(value || "").trim();
  var allowed = [
    "Arial, Helvetica, sans-serif",
    "Inter, Arial, sans-serif",
    "Verdana, Geneva, sans-serif",
    "Georgia, serif",
    "Trebuchet MS, Arial, sans-serif"
  ];
  return allowed.indexOf(font) >= 0 ? font : allowed[0];
}

function getShopIdentityKey() {
  var org = shopParam("org");
  var slug = shopParam("loja");
  if (org) return "org:" + org;
  if (slug) return "slug:" + slug.toLowerCase();
  return "";
}

function getShopThemeCacheKey() {
  var key = getShopIdentityKey();
  return key ? "azul_shop_theme_" + key : "";
}

function saveShopThemeCache(store) {
  var key = getShopThemeCacheKey();
  if (!key || !store) return;

  try {
    localStorage.setItem(key, JSON.stringify({
      store_name: store.store_name || "Loja Azul",
      hero_title: store.hero_title || "Escolha os produtos",
      hero_slides: normalizeShopHeroSlides(store.hero_slides),
      welcome_message: store.welcome_message || "",
      theme_color: normalizeShopColor(store.theme_color),
      font_family: getShopFontFamily(store.font_family),
      logo_url: String(store.logo_url || "").trim(),
      cached_at: Date.now()
    }));
  } catch (e) {}
}

function readShopThemeCache() {
  var key = getShopThemeCacheKey();
  if (!key) return null;

  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch (e) {
    return null;
  }
}

function normalizeShopHeroSlides(value) {
  var rows = Array.isArray(value) ? value : [];
  return rows.slice(0, 10).filter(function(row) {
    return row && String(row.image_url || "").trim();
  }).map(function(row) {
    return {
      image_url: String(row.image_url || "").trim(),
      title: String(row.title || "").trim(),
      subtitle: String(row.subtitle || "").trim(),
      button_label: String(row.button_label || "").trim()
    };
  });
}

function stopShopHeroAutoplay() {
  if (!shopHeroTimer) return;
  clearInterval(shopHeroTimer);
  shopHeroTimer = null;
}

function startShopHeroAutoplay() {
  stopShopHeroAutoplay();
  var slides = document.querySelectorAll(".shop-hero-slide");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (slides.length < 2 || reduceMotion || document.hidden) return;
  shopHeroTimer = setInterval(function() {
    showShopHeroSlide(shopHeroIndex + 1);
  }, 5500);
}

function showShopHeroSlide(index, restart) {
  var slides = document.querySelectorAll(".shop-hero-slide");
  var dots = document.querySelectorAll(".shop-hero-dot");
  if (!slides.length) return;

  shopHeroIndex = (Number(index) + slides.length) % slides.length;
  slides.forEach(function(slide, slideIndex) {
    var active = slideIndex === shopHeroIndex;
    slide.classList.toggle("is-active", active);
    slide.setAttribute("aria-hidden", active ? "false" : "true");
  });
  dots.forEach(function(dot, dotIndex) {
    var active = dotIndex === shopHeroIndex;
    dot.classList.toggle("is-active", active);
    dot.setAttribute("aria-current", active ? "true" : "false");
  });
  if (restart) startShopHeroAutoplay();
}

function scrollToShopProducts() {
  var products = document.getElementById("shopProducts");
  if (products) products.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderShopHero(store) {
  var track = document.getElementById("shopHeroTrack");
  var dots = document.getElementById("shopHeroDots");
  var prev = document.getElementById("shopHeroPrev");
  var next = document.getElementById("shopHeroNext");
  if (!track || !dots) return;

  var slides = normalizeShopHeroSlides(store && store.hero_slides);
  var fallbackTitle = shopEscape(store.hero_title || "Escolha os produtos");
  var fallbackMessage = shopEscape(store.welcome_message || "Adiciona produtos ao carrinho e envia o pedido pelo WhatsApp.");
  var hero = document.getElementById("shopHero");
  if (hero) hero.classList.toggle("is-fallback", !slides.length);

  if (!slides.length) {
    track.innerHTML =
      '<article class="shop-hero-slide is-active shop-hero-fallback" aria-hidden="false">' +
        '<div class="shop-hero-content">' +
          '<span>Compra pelo WhatsApp</span>' +
          '<h1 id="shopHeroTitle">' + fallbackTitle + '</h1>' +
          '<p id="shopWelcome">' + fallbackMessage + '</p>' +
        '</div>' +
      '</article>';
  } else {
    track.innerHTML = slides.map(function(slide, index) {
      var title = shopEscape(slide.title || store.hero_title || "Escolha os produtos");
      var subtitle = shopEscape(slide.subtitle || store.welcome_message || "");
      var button = shopEscape(slide.button_label || "Ver produtos");
      return '<article class="shop-hero-slide' + (index === 0 ? ' is-active' : '') + '" aria-hidden="' + (index === 0 ? 'false' : 'true') + '">' +
        '<img src="' + shopEscape(slide.image_url) + '" alt="" ' +
          (index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"') + '>' +
        '<div class="shop-hero-shade"></div>' +
        '<div class="shop-hero-content">' +
          '<span>Compra pelo WhatsApp</span>' +
          '<h1>' + title + '</h1>' +
          (subtitle ? '<p>' + subtitle + '</p>' : '') +
          '<button type="button" class="shop-hero-cta" onclick="scrollToShopProducts()">' + button + '</button>' +
        '</div>' +
      '</article>';
    }).join("");
  }

  dots.innerHTML = slides.length > 1 ? slides.map(function(_, index) {
    return '<button type="button" class="shop-hero-dot' + (index === 0 ? ' is-active' : '') + '" onclick="showShopHeroSlide(' + index + ', true)" aria-label="Ver imagem ' + (index + 1) + '" aria-current="' + (index === 0 ? 'true' : 'false') + '"></button>';
  }).join("") : "";

  if (prev) prev.hidden = slides.length < 2;
  if (next) next.hidden = slides.length < 2;
  shopHeroIndex = 0;
  startShopHeroAutoplay();
}

function applyShopBranding(store, saveCache) {
  store = store || {};
  var name = store.store_name || "Loja Azul";
  var hero = store.hero_title || "Escolha os produtos";
  var welcome = store.welcome_message || "Adiciona produtos ao carrinho e envia o pedido pelo WhatsApp.";
  var themeColor = normalizeShopColor(store.theme_color);
  var fontFamily = getShopFontFamily(store.font_family);
  var logoUrl = String(store.logo_url || "").trim() || "Assets/icon-192.png";

  document.title = name;
  document.documentElement.style.setProperty("--blue", themeColor);
  document.documentElement.style.setProperty("--blue2", darkenShopColor(themeColor));
  document.documentElement.style.setProperty("--shop-font-family", fontFamily);

  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", themeColor);

  var shopName = document.getElementById("shopName");

  if (shopName) shopName.textContent = name;
  renderShopHero(Object.assign({}, store, {
    hero_title: hero,
    welcome_message: welcome
  }));

  document.querySelectorAll(".shop-brand img").forEach(function(img) {
    img.src = logoUrl;
  });

  document.documentElement.classList.remove("shop-style-pending");
  if (saveCache) saveShopThemeCache(store);
}

function applyCachedShopBranding() {
  var cached = readShopThemeCache();
  if (cached && cached.theme_color) applyShopBranding(cached, false);
}

function getShopInputValue(id) {
  var el = document.getElementById(id);
  return String(el ? el.value : "").trim();
}

function setShopFormError(message, targetId) {
  var error = document.getElementById("shopFormError");
  var fields = ["shopCustomerName", "shopCustomerPhone", "shopCustomerAddress"];

  fields.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle("is-invalid", id === targetId);
  });

  if (error) error.textContent = message || "";

  if (targetId) {
    var target = document.getElementById(targetId);
    if (target) {
      openShopCart();
      setTimeout(function() { target.focus(); }, 180);
    }
  }
}

function getShopCustomerData() {
  var name = getShopInputValue("shopCustomerName");
  var phoneRaw = getShopInputValue("shopCustomerPhone");
  var phone = normalizeShopPhone(phoneRaw);
  var address = getShopInputValue("shopCustomerAddress");

  if (!name) {
    setShopFormError("Informe o seu nome para enviar o pedido.", "shopCustomerName");
    return null;
  }

  if (!phone || phone.length < 8) {
    setShopFormError("Informe um numero WhatsApp valido.", "shopCustomerPhone");
    return null;
  }

  if (!address) {
    setShopFormError("Informe o endereco de entrega.", "shopCustomerAddress");
    return null;
  }

  setShopFormError("", "");

  return {
    name: name,
    phone: phoneRaw,
    phoneDigits: phone,
    address: address
  };
}

function productSearchText(product) {
  return [
    product.name,
    product.base_name,
    product.category,
    product.base_category,
    product.code,
    product.description,
    product.variation,
    Array.isArray(product.variations) ? product.variations.join(" ") : product.variations
  ].map(function(value) {
    if (value && typeof value === "object") return JSON.stringify(value).toLowerCase();
    return String(value || "").toLowerCase();
  }).join(" ");
}

function getShopProductMainMedia(product) {
  var rows = Array.isArray(product && product.online_media) ? product.online_media : [];
  return rows.find(function(item) {
    return item && item.is_main && item.type === "image";
  }) || rows.find(function(item) {
    return item && item.type === "image";
  }) || rows[0] || null;
}

function renderShopProductMedia(product, name) {
  var media = getShopProductMainMedia(product);
  var url = media && media.url ? String(media.url).trim() : String(product.photo || "").trim();
  if (media && media.type === "video" && url) {
    return '<div class="shop-product-image"><video src="' + shopEscape(url) + '" muted playsinline loop preload="metadata"></video></div>';
  }
  if (url) {
    return '<div class="shop-product-image"><img src="' + shopEscape(url) + '" alt="' + name + '"></div>';
  }
  return '<div class="shop-product-image">' + shopEscape(String(product.name || "A").charAt(0).toUpperCase()) + '</div>';
}

function normalizeShopCategory(value) {
  return String(value || "").trim().toLocaleLowerCase("pt");
}

function buildShopCategories() {
  var byKey = {};

  (shopProducts || []).forEach(function(product) {
    var label = String(product.category || "").trim() || "Sem categoria";
    var key = normalizeShopCategory(label);
    if (!byKey[key]) {
      byKey[key] = {
        key: key,
        label: label,
        count: 0
      };
    }
    byKey[key].count += 1;
  });

  shopCategories = Object.keys(byKey).map(function(key) {
    return byKey[key];
  }).sort(function(a, b) {
    return a.label.localeCompare(b.label, "pt", { sensitivity: "base" });
  });

  if (shopActiveCategory && !byKey[shopActiveCategory]) {
    shopActiveCategory = "";
  }
}

function renderShopCategories() {
  var track = document.getElementById("shopCategoryTrack");
  if (!track) return;

  buildShopCategories();
  var rows = [{
    key: "",
    label: "Todos",
    count: shopProducts.length
  }].concat(shopCategories);

  track.innerHTML = rows.map(function(category, index) {
    var active = category.key === shopActiveCategory;
    return '<button type="button" class="shop-category-chip' + (active ? ' is-active' : '') + '"' +
      ' onclick="selectShopCategory(' + index + ', this)"' +
      ' aria-pressed="' + (active ? 'true' : 'false') + '">' +
        '<span>' + shopEscape(category.label) + '</span>' +
        '<small>' + category.count + '</small>' +
      '</button>';
  }).join("");
}

function selectShopCategory(index, button) {
  var rows = [{
    key: "",
    label: "Todos",
    count: shopProducts.length
  }].concat(shopCategories);
  var selected = rows[Number(index)] || rows[0];
  shopActiveCategory = selected.key;

  document.querySelectorAll(".shop-category-chip").forEach(function(chip) {
    var active = chip === button;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  });

  if (button && typeof button.scrollIntoView === "function") {
    button.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
  renderShopProducts();
}

function scrollShopCategories(direction) {
  var track = document.getElementById("shopCategoryTrack");
  if (!track) return;
  track.scrollBy({
    left: Number(direction || 1) * Math.max(220, track.clientWidth * .72),
    behavior: "smooth"
  });
}

function findShopProduct(id) {
  return shopProducts.find(function(item) {
    return String(item.id) === String(id);
  });
}

function getShopCartQty(id) {
  var item = shopCart.find(function(row) {
    return String(row.id) === String(id);
  });
  return item ? Number(item.qty) || 0 : 0;
}

async function loadShop() {
  var org = shopParam("org");
  var slug = shopParam("loja");
  var container = document.getElementById("shopProducts");

  if (!org && !slug) {
    document.documentElement.classList.remove("shop-style-pending");
    if (container) container.innerHTML = '<div class="shop-empty">Link da loja invalido.</div>';
    return;
  }

  try {
    var result = await supabaseClient.rpc("get_online_store", {
      p_org_id: org || null,
      p_slug: slug || null
    });

    if (result.error) throw result.error;

    var data = result.data || {};
    if (!data.ok) {
      document.documentElement.classList.remove("shop-style-pending");
      if (container) container.innerHTML = '<div class="shop-empty">Loja indisponivel.</div>';
      return;
    }

    shopStore = data.store || {};
    shopProducts = Array.isArray(data.products) ? data.products : [];
    applyShopStore();
    renderShopCategories();
    renderShopProducts();
  } catch (e) {
    console.error("Erro loja:", e);
    document.documentElement.classList.remove("shop-style-pending");
    if (container) container.innerHTML = '<div class="shop-empty">Erro ao carregar loja.</div>';
  }
}

function applyShopStore() {
  applyShopBranding(shopStore, true);
}

function openShopProduct(id) {
  var url = new URL("produto.html", window.location.href);
  var org = shopParam("org");
  var slug = shopParam("loja");
  if (org) url.searchParams.set("org", org);
  if (slug) url.searchParams.set("loja", slug);
  url.searchParams.set("produto", id);
  window.location.href = url.toString();
}

function renderShopProducts() {
  var container = document.getElementById("shopProducts");
  if (!container) return;

  var q = String((document.getElementById("shopSearch") || {}).value || "").trim().toLowerCase();
  var list = shopProducts.filter(function(product) {
    var category = normalizeShopCategory(product.category || "Sem categoria");
    var matchesCategory = !shopActiveCategory || category === shopActiveCategory;
    var matchesSearch = !q || productSearchText(product).indexOf(q) >= 0;
    return matchesCategory && matchesSearch;
  });

  if (!list.length) {
    container.innerHTML = '<div class="shop-empty">Nenhum produto encontrado.</div>';
    return;
  }

  container.innerHTML = list.map(function(product) {
    var id = shopEscape(product.id);
    var name = shopEscape(product.name || "");
    var category = shopEscape(product.category || "Produto");
    var price = Number(product.sale_price) || 0;
    var stock = Number(product.stock_shop) || 0;
    var isOut = shopStore.show_stock && stock <= 0;
    var variation = shopEscape(product.variation || "");
    var stockText = shopStore.show_stock
      ? (stock > 0 ? "Disponivel: " + stock : "Esgotado")
      : "Disponivel";
    var image = renderShopProductMedia(product, name);
    var meta = category + (variation ? " | " + variation : "") + " | " + shopEscape(stockText);

    return '<article class="shop-product-card' + (isOut ? ' is-out' : '') + '" role="link" tabindex="0" onclick="openShopProduct(\'' + id + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openShopProduct(\'' + id + '\')}">' +
      image +
      '<div class="shop-product-info">' +
        '<strong title="' + name + '">' + name + '</strong>' +
        '<small title="' + meta + '">' + meta + '</small>' +
        '<div class="shop-product-price">' + shopMoney(price) + '</div>' +
      '</div>' +
      '<div class="shop-product-actions">' +
        '<button type="button" class="shop-view-btn" tabindex="-1">' + (isOut ? 'Ver produto esgotado' : 'Ver produto') + ' <span aria-hidden="true">&rarr;</span></button>' +
      '</div>' +
    '</article>';
  }).join("");
}

function getTempQty(id) {
  var el = document.getElementById("shop-qty-" + id);
  return Math.max(1, Number(el ? el.textContent : 1) || 1);
}

function changeShopQty(id, delta) {
  var el = document.getElementById("shop-qty-" + id);
  if (!el) return;
  var product = findShopProduct(id);
  var next = Math.max(1, getTempQty(id) + delta);

  if (product && shopStore && shopStore.show_stock) {
    var stock = Number(product.stock_shop) || 0;
    if (stock > 0) next = Math.min(stock, next);
  }

  el.textContent = String(next);
}

function addShopProduct(id) {
  var product = findShopProduct(id);
  if (!product) return;

  var qty = getTempQty(id);
  var stock = Number(product.stock_shop) || 0;

  if (shopStore.show_stock) {
    if (stock <= 0) {
      alert("Produto esgotado.");
      return;
    }

    if (getShopCartQty(id) + qty > stock) {
      alert("Stock disponivel: " + stock + " unidade(s).");
      return;
    }
  }

  var existing = shopCart.find(function(item) {
    return String(item.id) === String(id);
  });

  if (existing) {
    existing.qty += qty;
  } else {
    shopCart.push({
      id: product.id,
      name: product.name || "",
      code: product.code || "",
      variation: product.variation || "",
      price: Number(product.sale_price) || 0,
      qty: qty
    });
  }

  var qtyEl = document.getElementById("shop-qty-" + id);
  if (qtyEl) qtyEl.textContent = "1";
  renderShopCart();
}

function clearShopCart() {
  shopCart = [];
  renderShopCart();
}

function getShopCartTotal() {
  return shopCart.reduce(function(sum, item) {
    return sum + ((Number(item.price) || 0) * (Number(item.qty) || 0));
  }, 0);
}

function renderShopCart() {
  var list = document.getElementById("shopCartList");
  var count = document.getElementById("shopCartCount");
  var mobileCount = document.getElementById("shopMobileCartCount");
  var mobileTotal = document.getElementById("shopMobileCartTotal");
  var total = document.getElementById("shopCartTotal");
  var btn = document.getElementById("shopWhatsappBtn");

  var qty = shopCart.reduce(function(sum, item) {
    return sum + (Number(item.qty) || 0);
  }, 0);

  if (count) count.textContent = String(qty);
  if (mobileCount) mobileCount.textContent = qty + (qty === 1 ? " produto" : " produtos");
  if (mobileTotal) mobileTotal.textContent = shopMoney(getShopCartTotal());
  if (total) total.textContent = shopMoney(getShopCartTotal());
  if (btn) btn.disabled = !shopCart.length;

  if (!list) return;

  if (!shopCart.length) {
    list.innerHTML = '<div class="shop-empty">Nenhum produto no carrinho.</div>';
    return;
  }

  list.innerHTML = shopCart.map(function(item) {
    var meta = [item.code, item.variation].filter(Boolean).join(" | ");
    return '<div class="shop-cart-item">' +
      '<div><strong>' + shopEscape(item.name) + '</strong><small>' + (meta ? shopEscape(meta) + ' | ' : '') + item.qty + ' x ' + shopMoney(item.price) + '</small></div>' +
      '<span>' + shopMoney(item.qty * item.price) + '</span>' +
    '</div>';
  }).join("");
}

function buildWhatsAppMessage(customer) {
  var lines = [];
  lines.push(shopStore.welcome_message || "Ola, quero comprar estes produtos:");
  lines.push("");
  lines.push("Dados do cliente:");
  lines.push("Nome: " + customer.name);
  lines.push("WhatsApp: " + customer.phone);
  lines.push("Endereco: " + customer.address);
  lines.push("");
  lines.push("Produtos:");

  shopCart.forEach(function(item) {
    var meta = [item.code, item.variation].filter(Boolean).join(" | ");
    lines.push("- " + item.name + (meta ? " (" + meta + ")" : "") + " | Qtd: " + item.qty + " | Total: " + shopMoney(item.qty * item.price));
  });

  lines.push("");
  lines.push("Total: " + shopMoney(getShopCartTotal()));

  return lines.join("\n");
}

function getShopOrderItemsPayload() {
  return shopCart.map(function(item) {
    return {
      product_id: item.id,
      quantity: Number(item.qty) || 1
    };
  });
}

async function createShopOrder(customer, message) {
  var org = shopParam("org");
  var slug = shopParam("loja");
  var result = await supabaseClient.rpc("create_online_order", {
    p_org_id: org || null,
    p_slug: slug || null,
    p_customer_name: customer.name,
    p_customer_phone: customer.phone,
    p_customer_address: customer.address,
    p_items: getShopOrderItemsPayload(),
    p_whatsapp_message: message
  });

  if (result.error) throw result.error;

  var data = result.data || {};
  if (!data.ok) throw new Error(data.message || "Nao foi possivel criar a encomenda.");

  return data.order || {};
}

function injectShopOrderNumber(message, order) {
  if (!order || !order.order_number) return message;
  return "Encomenda: " + order.order_number + "\n\n" + message;
}

async function sendShopCartToWhatsApp() {
  if (!shopCart.length) return;

  openShopCart();

  var customer = getShopCustomerData();
  if (!customer) return;
  var btn = document.getElementById("shopWhatsappBtn");

  var phone = normalizeShopPhone(shopStore.whatsapp_phone);
  if (!phone) {
    alert("Numero WhatsApp indisponivel.");
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "A criar encomenda...";
    }

    var message = buildWhatsAppMessage(customer);
    var order = await createShopOrder(customer, message);
    var finalMessage = injectShopOrderNumber(message, order);
    var url = "https://wa.me/" + phone + "?text=" + encodeURIComponent(finalMessage);
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    alert("Erro ao criar encomenda: " + (e.message || e));
  } finally {
    if (btn) {
      btn.disabled = !shopCart.length;
      btn.textContent = "Enviar pedido no WhatsApp";
    }
  }
}

function scrollToCart() {
  openShopCart();
  if (window.matchMedia && window.matchMedia("(max-width: 720px)").matches) return;
  var cart = document.getElementById("shopCart");
  if (cart) cart.scrollIntoView({ behavior: "smooth", block: "end" });
}

function toggleShopCart(forceOpen) {
  var cart = document.getElementById("shopCart");
  if (!cart) return;

  shopCartOpen = typeof forceOpen === "boolean" ? forceOpen : !shopCartOpen;
  cart.classList.toggle("is-open", shopCartOpen);
}

function openShopCart() {
  toggleShopCart(true);
}

function bindShopCartToggle() {
  var button = document.getElementById("shopCartToggle");
  if (!button) return;

  button.addEventListener("click", function() {
    toggleShopCart();
  });
}

function shouldReloadShopForSettingsUpdate(payload) {
  if (!payload) return false;
  var org = shopParam("org");
  var slug = shopParam("loja");
  if (org && payload.organization_id && String(org) === String(payload.organization_id)) return true;
  if (slug && payload.slug && String(slug).toLowerCase() === String(payload.slug).toLowerCase()) return true;
  return false;
}

window.addEventListener("storage", function(event) {
  if (event.key !== "azul_online_store_updated") return;

  try {
    var payload = JSON.parse(event.newValue || "{}");
    if (shouldReloadShopForSettingsUpdate(payload)) {
      loadShop();
    }
  } catch (e) {}
});

document.addEventListener("DOMContentLoaded", function() {
  applyCachedShopBranding();
  var hero = document.getElementById("shopHero");
  var prev = document.getElementById("shopHeroPrev");
  var next = document.getElementById("shopHeroNext");

  if (prev) prev.addEventListener("click", function() {
    showShopHeroSlide(shopHeroIndex - 1, true);
  });
  if (next) next.addEventListener("click", function() {
    showShopHeroSlide(shopHeroIndex + 1, true);
  });
  if (hero) {
    hero.addEventListener("mouseenter", stopShopHeroAutoplay);
    hero.addEventListener("mouseleave", startShopHeroAutoplay);
    hero.addEventListener("touchstart", function(event) {
      shopHeroTouchStartX = event.touches && event.touches[0] ? event.touches[0].clientX : 0;
    }, { passive: true });
    hero.addEventListener("touchend", function(event) {
      var endX = event.changedTouches && event.changedTouches[0] ? event.changedTouches[0].clientX : 0;
      var distance = endX - shopHeroTouchStartX;
      if (Math.abs(distance) > 45) {
        showShopHeroSlide(shopHeroIndex + (distance < 0 ? 1 : -1), true);
      }
    }, { passive: true });
  }
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) stopShopHeroAutoplay();
    else startShopHeroAutoplay();
  });
  loadShop();
});
