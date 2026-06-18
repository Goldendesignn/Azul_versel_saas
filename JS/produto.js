var productStore = null;
var productList = [];
var selectedProduct = null;
var selectedVariation = "";
var productQty = 1;

function productParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function productMoney(value) {
  value = Number(value) || 0;
  return value.toLocaleString("pt-AO", { maximumFractionDigits: 0 }) + " Kz";
}

function productEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeProductColor(value) {
  var color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#0b3d91";
}

function darkenProductColor(hex) {
  var color = normalizeProductColor(hex).slice(1);
  return "#" + [0, 2, 4].map(function(start) {
    var part = Math.max(0, Math.round(parseInt(color.slice(start, start + 2), 16) * 0.62));
    return part.toString(16).padStart(2, "0");
  }).join("");
}

function getProductFontFamily(value) {
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

function applyProductBranding(store) {
  store = store || {};
  var name = store.store_name || "Loja Azul";
  var themeColor = normalizeProductColor(store.theme_color);
  var logoUrl = String(store.logo_url || "").trim() || "Assets/icon-192.png";

  document.title = selectedProduct ? selectedProduct.name : name;
  document.documentElement.style.setProperty("--blue", themeColor);
  document.documentElement.style.setProperty("--blue2", darkenProductColor(themeColor));
  document.documentElement.style.setProperty("--shop-font-family", getProductFontFamily(store.font_family));

  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", themeColor);

  var storeName = document.getElementById("productStoreName");
  var logo = document.getElementById("productStoreLogo");
  if (storeName) storeName.textContent = name;
  if (logo) logo.src = logoUrl;

  document.documentElement.classList.remove("shop-style-pending");
}

function productVariationList(product) {
  if (!product) return [];
  if (Array.isArray(product.variations)) {
    return product.variations.map(function(item) {
      return String(item || "").trim();
    }).filter(Boolean);
  }
  if (typeof product.variations === "string") {
    try {
      var parsed = JSON.parse(product.variations);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (e) {}
    return product.variations.split(/[,\n|;]/).map(function(item) {
      return item.trim();
    }).filter(Boolean);
  }
  return product.variation ? [String(product.variation).trim()] : [];
}

function getProductIdentityUrl(productId) {
  var url = new URL("produto.html", window.location.href);
  var org = productParam("org");
  var slug = productParam("loja");
  if (org) url.searchParams.set("org", org);
  if (slug) url.searchParams.set("loja", slug);
  url.searchParams.set("produto", productId);
  return url.toString();
}

function setProductError(message, targetId) {
  var el = document.getElementById("productFormError");
  ["productCustomerName", "productCustomerPhone", "productCustomerAddress"].forEach(function(id) {
    var field = document.getElementById(id);
    if (field) field.classList.toggle("is-invalid", id === targetId);
  });
  if (el) el.textContent = message || "";
}

function getProductInput(id) {
  var el = document.getElementById(id);
  return String(el ? el.value : "").trim();
}

function setProductQty(next) {
  var stock = Number(selectedProduct && selectedProduct.stock_shop) || 0;
  var limit = productStore && productStore.show_stock && stock > 0 ? stock : 9999;
  productQty = Math.max(1, Math.min(limit, Number(next) || 1));
  var qtyEl = document.getElementById("productQtyValue");
  var totalEl = document.getElementById("productOrderTotal");
  if (qtyEl) qtyEl.textContent = productQty;
  if (totalEl) totalEl.textContent = productMoney(productQty * (Number(selectedProduct.sale_price) || 0));
}

function changeProductQty(delta) {
  setProductQty(productQty + Number(delta || 0));
}

function selectProductVariation(value) {
  selectedVariation = String(value || "");
  document.querySelectorAll(".product-option").forEach(function(button) {
    var active = button.getAttribute("data-value") === selectedVariation;
    button.classList.toggle("is-active", active);
  });
}

function renderSimilarProducts() {
  var wrap = document.getElementById("similarProducts");
  if (!wrap || !selectedProduct) return;

  var currentId = String(selectedProduct.id);
  var category = String(selectedProduct.category || "").trim().toLowerCase();
  var similar = productList.filter(function(product) {
    return String(product.id) !== currentId &&
      String(product.category || "").trim().toLowerCase() === category;
  }).slice(0, 6);

  if (!similar.length) {
    similar = productList.filter(function(product) {
      return String(product.id) !== currentId;
    }).slice(0, 6);
  }

  if (!similar.length) {
    wrap.innerHTML = "";
    return;
  }

  wrap.innerHTML =
    '<h2>Produtos similares</h2>' +
    '<div class="similar-grid">' +
      similar.map(renderSimilarCard).join("") +
    '</div>';
}

function renderSimilarCard(product) {
  var id = productEscape(product.id);
  var name = productEscape(product.name || "Produto");
  var category = productEscape(product.category || "Produto");
  var variation = productVariationList(product).join(" | ") || product.variation || "sem variacao";
  var photo = String(product.photo || "").trim();
  var firstLetter = productEscape(String(product.name || "A").charAt(0).toUpperCase());
  var image = photo
    ? '<div class="shop-product-image"><img src="' + productEscape(photo) + '" alt="' + name + '"></div>'
    : '<div class="shop-product-image">' + firstLetter + '</div>';

  return '<article class="shop-product-card" role="link" tabindex="0" onclick="location.href=\'' + getProductIdentityUrl(id) + '\'" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();location.href=\'' + getProductIdentityUrl(id) + '\'}">' +
    image +
    '<div class="shop-product-info">' +
      '<strong title="' + name + '">' + name + '</strong>' +
      '<small>' + category + ' | ' + productEscape(variation) + '</small>' +
      '<div class="shop-product-price">' + productMoney(product.sale_price) + '</div>' +
    '</div>' +
    '<div class="shop-product-actions">' +
      '<button type="button" class="shop-view-btn" tabindex="-1">Ver produto <span aria-hidden="true">&rarr;</span></button>' +
    '</div>' +
  '</article>';
}

function renderProduct() {
  var container = document.getElementById("productDetail");
  if (!container || !selectedProduct) return;

  var name = productEscape(selectedProduct.name || "Produto");
  var description = productEscape(selectedProduct.description || "Produto disponivel para encomenda pelo WhatsApp.");
  var price = productMoney(selectedProduct.sale_price);
  var category = productEscape(selectedProduct.category || "Produto");
  var stock = Number(selectedProduct.stock_shop) || 0;
  var photo = String(selectedProduct.photo || "").trim();
  var firstLetter = productEscape(String(selectedProduct.name || "A").charAt(0).toUpperCase());
  var variations = productVariationList(selectedProduct);
  selectedVariation = variations[0] || String(selectedProduct.variation || "").trim();

  var image = photo
    ? '<img src="' + productEscape(photo) + '" alt="' + name + '" loading="eager" fetchpriority="high">'
    : '<div class="product-photo-placeholder">' + firstLetter + '</div>';

  container.innerHTML =
    '<div class="product-layout">' +
      '<div class="product-gallery">' +
        '<div class="product-photo">' + image + '</div>' +
      '</div>' +
      '<aside class="product-info-panel">' +
        '<div>' +
          '<div class="product-muted">' + category + (stock > 0 ? ' | Disponivel' : '') + '</div>' +
          '<h1 class="product-title">' + name + '</h1>' +
        '</div>' +
        '<div class="product-price">' + price + '</div>' +
        '<p class="product-description">' + description + '</p>' +
        '<div>' +
          '<div class="product-section-title">Tamanho / variacao</div>' +
          '<div class="product-options" id="productOptions">' +
            (variations.length ? variations.map(function(item) {
              var safe = productEscape(item);
              return '<button type="button" class="product-option' + (item === selectedVariation ? ' is-active' : '') + '" data-value="' + safe + '" onclick="selectProductVariation(\'' + safe + '\')">' + safe + '</button>';
            }).join("") : '<span class="product-muted">Sem variacao</span>') +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="product-section-title">Quantidade</div>' +
          '<div class="product-qty">' +
            '<button type="button" onclick="changeProductQty(-1)">-</button>' +
            '<span id="productQtyValue">1</span>' +
            '<button type="button" onclick="changeProductQty(1)">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="product-total">' +
          '<span>Total do pedido</span>' +
          '<strong id="productOrderTotal">' + productMoney(selectedProduct.sale_price) + '</strong>' +
        '</div>' +
        '<div>' +
          '<div class="product-section-title">Dados para entrega</div>' +
          '<div class="product-customer-form">' +
            '<input type="text" id="productCustomerName" placeholder="O seu nome" autocomplete="name">' +
            '<input type="tel" id="productCustomerPhone" placeholder="WhatsApp: ex. 244923000000" autocomplete="tel">' +
            '<textarea id="productCustomerAddress" placeholder="Endereco de entrega" autocomplete="street-address"></textarea>' +
          '</div>' +
          '<div class="product-form-error" id="productFormError"></div>' +
        '</div>' +
        '<button type="button" class="product-whatsapp-btn" id="productWhatsappBtn" onclick="sendProductOrder()">Pedir pelo WhatsApp</button>' +
      '</aside>' +
    '</div>' +
    '<section class="similar-products" id="similarProducts"></section>';

  setProductQty(1);
  renderSimilarProducts();
}

function buildProductWhatsappMessage(orderNumber) {
  var lines = [
    productStore.welcome_message || "Ola, quero comprar este produto:",
    "",
    "Pedido: " + (orderNumber || "novo"),
    "Produto: " + (selectedProduct.name || "Produto"),
    selectedVariation ? "Variacao: " + selectedVariation : "",
    "Quantidade: " + productQty,
    "Total: " + productMoney(productQty * (Number(selectedProduct.sale_price) || 0)),
    "",
    "Nome: " + getProductInput("productCustomerName"),
    "WhatsApp: " + getProductInput("productCustomerPhone"),
    "Endereco: " + getProductInput("productCustomerAddress")
  ].filter(function(line) {
    return line !== "";
  });
  return lines.join("\n");
}

async function sendProductOrder() {
  if (!selectedProduct || !productStore) return;

  var name = getProductInput("productCustomerName");
  var phone = getProductInput("productCustomerPhone").replace(/[^\d]/g, "");
  var address = getProductInput("productCustomerAddress");

  if (!name) return setProductError("Escreve o teu nome.", "productCustomerName");
  if (!phone || phone.length < 8) return setProductError("Escreve um numero de WhatsApp valido.", "productCustomerPhone");
  if (!address) return setProductError("Escreve o endereco de entrega.", "productCustomerAddress");
  setProductError("");

  var button = document.getElementById("productWhatsappBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "A preparar pedido...";
  }

  try {
    var item = {
      product_id: selectedProduct.id,
      quantity: productQty,
      variation: selectedVariation
    };
    var previewMessage = buildProductWhatsappMessage("");
    var result = await supabaseClient.rpc("create_online_order", {
      p_org_id: productParam("org") || null,
      p_slug: productParam("loja") || null,
      p_customer_name: name,
      p_customer_phone: phone,
      p_customer_address: address,
      p_items: [item],
      p_whatsapp_message: previewMessage
    });

    if (result.error) throw result.error;
    var data = result.data || {};
    if (!data.ok) throw new Error(data.message || "Nao foi possivel criar o pedido.");

    var message = buildProductWhatsappMessage(data.order && data.order.order_number);
    var storePhone = String(productStore.whatsapp_phone || "").replace(/[^\d]/g, "");
    if (!storePhone) throw new Error("WhatsApp da loja nao configurado.");
    window.open("https://wa.me/" + storePhone + "?text=" + encodeURIComponent(message), "_blank");
  } catch (e) {
    setProductError(e.message || "Erro ao enviar pedido.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Pedir pelo WhatsApp";
    }
  }
}

async function loadProductPage() {
  var productId = productParam("produto");
  var container = document.getElementById("productDetail");

  try {
    var result = await supabaseClient.rpc("get_online_store", {
      p_org_id: productParam("org") || null,
      p_slug: productParam("loja") || null
    });
    if (result.error) throw result.error;

    var data = result.data || {};
    if (!data.ok) throw new Error(data.message || "Loja indisponivel");

    productStore = data.store || {};
    productList = Array.isArray(data.products) ? data.products : [];
    selectedProduct = productList.find(function(product) {
      return String(product.id) === String(productId);
    });
    if (!selectedProduct) throw new Error("Produto nao encontrado.");

    applyProductBranding(productStore);
    renderProduct();
  } catch (e) {
    console.error("Erro produto:", e);
    document.documentElement.classList.remove("shop-style-pending");
    if (container) container.innerHTML = '<div class="product-error">' + productEscape(e.message || "Erro ao carregar produto.") + '</div>';
  }
}

document.addEventListener("DOMContentLoaded", function() {
  var back = document.getElementById("productBackButton");
  if (back) {
    back.addEventListener("click", function() {
      var url = new URL("loja.html", window.location.href);
      var org = productParam("org");
      var slug = productParam("loja");
      if (org) url.searchParams.set("org", org);
      if (slug) url.searchParams.set("loja", slug);
      window.location.href = url.toString();
    });
  }
  loadProductPage();
});
