var productStore = null;
var productItem = null;
var productStoreProducts = [];
var productQuantity = 1;
var productSelectedVariation = "";
var productSelectedMediaIndex = 0;

function productParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function productEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function productMoney(value) {
  return (Number(value) || 0).toLocaleString("pt-AO", { maximumFractionDigits: 0 }) + " Kz";
}

function normalizeProductPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeProductColor(value) {
  var color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#0b3d91";
}

function darkenProductColor(hex) {
  var color = normalizeProductColor(hex).slice(1);
  return "#" + [0, 2, 4].map(function(start) {
    var part = Math.max(0, Math.round(parseInt(color.slice(start, start + 2), 16) * .62));
    return part.toString(16).padStart(2, "0");
  }).join("");
}

function productCatalogUrl() {
  var url = new URL("loja.html", window.location.href);
  var org = productParam("org");
  var slug = productParam("loja");
  if (org) url.searchParams.set("org", org);
  if (slug) url.searchParams.set("loja", slug);
  return url.toString();
}

function applyProductBranding(store) {
  store = store || {};
  var color = normalizeProductColor(store.theme_color);
  var logo = String(store.logo_url || "").trim() || "Assets/icon-192.png";
  var font = String(store.font_family || "").trim() || "Arial, Helvetica, sans-serif";

  document.documentElement.style.setProperty("--blue", color);
  document.documentElement.style.setProperty("--blue2", darkenProductColor(color));
  document.documentElement.style.setProperty("--shop-font-family", font);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", color);

  var name = document.getElementById("productStoreName");
  var image = document.getElementById("productStoreLogo");
  if (name) name.textContent = store.store_name || "Loja Azul";
  if (image) image.src = logo;
  document.title = productItem && productItem.name
    ? productItem.name + " | " + (store.store_name || "Loja")
    : (store.store_name || "Loja Azul");
  document.documentElement.classList.remove("shop-style-pending");
}

function normalizeProductVariations(product) {
  var value = product && product.variations;
  var rows = [];

  if (Array.isArray(value)) {
    rows = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      var parsed = JSON.parse(value);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      rows = value.split(/[|,;/]+/);
    }
  }

  if (!rows.length && product && product.variation) {
    rows = String(product.variation).split(/[|,;/]+/);
  }

  var seen = {};
  return rows.map(function(row) {
    if (row && typeof row === "object") {
      return String(row.label || row.name || row.value || row.size || "").trim();
    }
    return String(row || "").trim();
  }).filter(function(label) {
    var key = label.toLowerCase();
    if (!label || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function productPageUrl(productId) {
  var url = new URL("produto.html", window.location.href);
  var org = productParam("org");
  var slug = productParam("loja");
  if (org) url.searchParams.set("org", org);
  if (slug) url.searchParams.set("loja", slug);
  url.searchParams.set("produto", productId);
  return url.toString();
}

function openSimilarProduct(productId) {
  window.location.href = productPageUrl(productId);
}

function getSimilarProducts() {
  if (!productItem) return [];
  var currentId = String(productItem.id || "");
  var category = String(productItem.category || "").trim().toLowerCase();
  var available = productStoreProducts.filter(function(item) {
    return String(item.id || "") !== currentId;
  });
  var sameCategory = available.filter(function(item) {
    return category && String(item.category || "").trim().toLowerCase() === category;
  });
  var otherProducts = available.filter(function(item) {
    return sameCategory.indexOf(item) < 0;
  });
  return sameCategory.concat(otherProducts).slice(0, 4);
}

function getProductMediaRows(item) {
  var rows = Array.isArray(item && item.online_media) ? item.online_media : [];
  rows = rows.map(function(row, index) {
    return {
      url: String(row.url || row.media_url || "").trim(),
      type: row.type === "video" || row.media_type === "video" ? "video" : "image",
      is_main: !!row.is_main,
      sort_order: Number(row.sort_order || index) || 0
    };
  }).filter(function(row) {
    return !!row.url;
  }).sort(function(a, b) {
    if (a.is_main !== b.is_main) return a.is_main ? -1 : 1;
    return a.sort_order - b.sort_order;
  });

  if (!rows.length && item && item.photo) {
    rows.push({ url: String(item.photo || ""), type: "image", is_main: true, sort_order: 0 });
  }
  return rows;
}

function renderProductMediaElement(media, name, lazy) {
  if (!media || !media.url) {
    return productEscape(String(productItem && productItem.name || "A").charAt(0).toUpperCase());
  }
  var url = productEscape(media.url);
  if (media.type === "video") {
    return '<video src="' + url + '" controls playsinline preload="metadata"></video>';
  }
  return '<img src="' + url + '" alt="' + productEscape(name || "Produto") + '"' + (lazy ? ' loading="lazy"' : '') + '>';
}

function renderSimilarProductMedia(item, name) {
  var media = getProductMediaRows(item)[0] || null;
  if (media && media.type === "video") {
    return '<div class="shop-product-image"><video src="' + productEscape(media.url) + '" muted playsinline loop preload="metadata"></video></div>';
  }
  if (media && media.url) {
    return '<div class="shop-product-image"><img src="' + productEscape(media.url) + '" alt="' + name + '" loading="lazy"></div>';
  }
  return '<div class="shop-product-image">' + productEscape(String(item.name || "A").charAt(0).toUpperCase()) + '</div>';
}

function selectProductMedia(index) {
  var rows = getProductMediaRows(productItem);
  productSelectedMediaIndex = Math.max(0, Math.min(Number(index) || 0, rows.length - 1));
  renderProductDetail();
}

function renderSimilarProducts() {
  var rows = getSimilarProducts();
  if (!rows.length) return "";

  return '<section class="similar-products-section">' +
    '<div class="similar-products-heading">' +
      '<div><span>Continua a descobrir</span><h2>Produtos similares</h2></div>' +
      '<a href="' + productEscape(productCatalogUrl()) + '">Ver todo o catalogo</a>' +
    '</div>' +
    '<div class="similar-products-grid">' +
      rows.map(function(item) {
        var id = productEscape(item.id);
        var name = productEscape(item.name || "Produto");
        var category = productEscape(item.category || "Produto");
        var stock = Number(item.stock_shop) || 0;
        var isOut = productStore.show_stock && stock <= 0;
        var variation = productEscape(item.variation || "");
        var stockText = productStore.show_stock
          ? (stock > 0 ? "Disponivel: " + stock : "Esgotado")
          : "Disponivel";
        var meta = category + (variation ? " | " + variation : "") + " | " + productEscape(stockText);
        var image = renderSimilarProductMedia(item, name);

        return '<article class="shop-product-card' + (isOut ? ' is-out' : '') + '" tabindex="0" role="link" onclick="openSimilarProduct(\'' + id + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openSimilarProduct(\'' + id + '\')}">' +
          image +
          '<div class="shop-product-info">' +
            '<strong title="' + name + '">' + name + '</strong>' +
            '<small title="' + meta + '">' + meta + '</small>' +
            '<div class="shop-product-price">' + productMoney(item.sale_price) + '</div>' +
          '</div>' +
          '<div class="shop-product-actions">' +
            '<button type="button" class="shop-view-btn" tabindex="-1">' + (isOut ? 'Ver produto esgotado' : 'Ver produto') + ' <span aria-hidden="true">&rarr;</span></button>' +
          '</div>' +
        '</article>';
      }).join("") +
    '</div>' +
  '</section>';
}

function renderProductDetail() {
  var container = document.getElementById("productDetail");
  if (!container || !productItem) return;

  var name = productEscape(productItem.name || "Produto");
  var category = productEscape(productItem.category || "Produto");
  var description = productEscape(productItem.description || "Produto disponivel para encomenda. Escolhe a opcao desejada e envia o pedido pelo WhatsApp.");
  var price = Number(productItem.sale_price) || 0;
  var stock = Number(productItem.stock_shop) || 0;
  var isOut = productStore.show_stock && stock <= 0;
  var variations = normalizeProductVariations(productItem);
  var mediaRows = getProductMediaRows(productItem);
  if (productSelectedMediaIndex >= mediaRows.length) productSelectedMediaIndex = 0;
  var currentMedia = mediaRows[productSelectedMediaIndex] || null;

  if (!productSelectedVariation && variations.length === 1) {
    productSelectedVariation = variations[0];
  }

  var image = renderProductMediaElement(currentMedia, productItem.name || "Produto", false);
  var thumbs = mediaRows.length > 1
    ? '<div class="product-media-thumbs">' + mediaRows.map(function(media, index) {
        return '<button type="button" class="product-media-thumb' + (index === productSelectedMediaIndex ? ' is-active' : '') + '" onclick="selectProductMedia(' + index + ')" aria-label="Ver media ' + (index + 1) + '">' +
          renderProductMediaElement(media, productItem.name || "Produto", true) +
        '</button>';
      }).join("") + '</div>'
    : "";
  var variationButtons = variations.map(function(label) {
    var active = label === productSelectedVariation;
    return '<button type="button" class="product-variation-button' + (active ? ' is-active' : '') + '" onclick="selectProductVariation(\'' + encodeURIComponent(label) + '\', this)" aria-pressed="' + (active ? 'true' : 'false') + '">' + productEscape(label) + '</button>';
  }).join("");

  container.innerHTML =
    '<div class="product-layout">' +
      '<div class="product-media">' +
        '<div class="product-main-image">' + image + '</div>' +
        thumbs +
      '</div>' +
      '<div class="product-info-panel">' +
        '<span class="product-category">' + category + '</span>' +
        '<h1 class="product-title">' + name + '</h1>' +
        '<div class="product-price">' + productMoney(price) + '</div>' +
        '<p class="product-description">' + description + '</p>' +
        '<div class="product-meta-line">' +
          (productItem.code ? '<span>Codigo: ' + productEscape(productItem.code) + '</span>' : '') +
          (productStore.show_stock ? '<span>' + (stock > 0 ? stock + ' unidade(s) disponiveis' : 'Produto esgotado') + '</span>' : '<span>Disponivel por encomenda</span>') +
        '</div>' +
        '<div class="product-order-panel">' +
          (variations.length
            ? '<fieldset class="product-fieldset"><legend>Escolher tamanho ou variacao</legend><div class="product-variation-list">' + variationButtons + '</div></fieldset>'
            : '') +
          '<fieldset class="product-fieldset">' +
            '<legend>Quantidade</legend>' +
            '<div class="product-quantity">' +
              '<button type="button" onclick="changeProductQuantity(-1)" aria-label="Diminuir quantidade">-</button>' +
              '<strong id="productQuantity">1</strong>' +
              '<button type="button" onclick="changeProductQuantity(1)" aria-label="Aumentar quantidade">+</button>' +
            '</div>' +
          '</fieldset>' +
          '<div class="product-order-summary"><span>Total do pedido</span><strong id="productOrderTotal">' + productMoney(price) + '</strong></div>' +
          '<div class="product-form-title">Dados para entrega</div>' +
          '<div class="product-customer-form">' +
            '<input type="text" id="productCustomerName" placeholder="O seu nome" autocomplete="name">' +
            '<input type="tel" id="productCustomerPhone" placeholder="WhatsApp: ex. 244923000000" autocomplete="tel">' +
            '<textarea id="productCustomerAddress" placeholder="Endereco de entrega" rows="3" autocomplete="street-address"></textarea>' +
            '<div class="product-form-error" id="productFormError"></div>' +
          '</div>' +
          '<button type="button" class="product-whatsapp-button" id="productWhatsappButton" onclick="sendProductToWhatsApp()"' + (isOut ? ' disabled' : '') + '>' +
            '<span class="product-whatsapp-icon">W</span>' +
            '<span>' + (isOut ? 'Produto esgotado' : 'Pedir pelo WhatsApp') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    renderSimilarProducts();
}

function selectProductVariation(encodedLabel, button) {
  productSelectedVariation = decodeURIComponent(encodedLabel || "");
  document.querySelectorAll(".product-variation-button").forEach(function(item) {
    var active = item === button;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-pressed", active ? "true" : "false");
  });
  setProductFormError("");
}

function changeProductQuantity(delta) {
  if (!productItem) return;
  var next = Math.max(1, productQuantity + Number(delta || 0));
  if (productStore && productStore.show_stock) {
    var stock = Number(productItem.stock_shop) || 0;
    if (stock > 0) next = Math.min(stock, next);
  }
  productQuantity = next;
  var qty = document.getElementById("productQuantity");
  var total = document.getElementById("productOrderTotal");
  if (qty) qty.textContent = String(productQuantity);
  if (total) total.textContent = productMoney(productQuantity * (Number(productItem.sale_price) || 0));
}

function setProductFormError(message, targetId) {
  ["productCustomerName", "productCustomerPhone", "productCustomerAddress"].forEach(function(id) {
    var input = document.getElementById(id);
    if (input) input.classList.toggle("is-invalid", id === targetId);
  });
  var error = document.getElementById("productFormError");
  if (error) error.textContent = message || "";
  if (targetId) {
    var target = document.getElementById(targetId);
    if (target) target.focus();
  }
}

function getProductCustomer() {
  var nameInput = document.getElementById("productCustomerName");
  var phoneInput = document.getElementById("productCustomerPhone");
  var addressInput = document.getElementById("productCustomerAddress");
  var name = String(nameInput ? nameInput.value : "").trim();
  var phone = String(phoneInput ? phoneInput.value : "").trim();
  var address = String(addressInput ? addressInput.value : "").trim();

  if (!name) {
    setProductFormError("Informe o seu nome.", "productCustomerName");
    return null;
  }
  if (normalizeProductPhone(phone).length < 8) {
    setProductFormError("Informe um numero WhatsApp valido.", "productCustomerPhone");
    return null;
  }
  if (!address) {
    setProductFormError("Informe o endereco de entrega.", "productCustomerAddress");
    return null;
  }

  setProductFormError("");
  return { name: name, phone: phone, address: address };
}

function buildProductWhatsAppMessage(customer) {
  var lines = [
    productStore.welcome_message || "Ola, quero comprar este produto:",
    "",
    "Produto: " + (productItem.name || "Produto"),
    "Quantidade: " + productQuantity
  ];
  if (productSelectedVariation) lines.push("Tamanho/variacao: " + productSelectedVariation);
  if (productItem.code) lines.push("Codigo: " + productItem.code);
  lines.push("Total: " + productMoney(productQuantity * (Number(productItem.sale_price) || 0)));
  lines.push("");
  lines.push("Dados do cliente:");
  lines.push("Nome: " + customer.name);
  lines.push("WhatsApp: " + customer.phone);
  lines.push("Endereco: " + customer.address);
  return lines.join("\n");
}

async function createProductOrder(customer, message) {
  var result = await supabaseClient.rpc("create_online_order", {
    p_org_id: productParam("org") || null,
    p_slug: productParam("loja") || null,
    p_customer_name: customer.name,
    p_customer_phone: customer.phone,
    p_customer_address: customer.address,
    p_items: [{
      product_id: productItem.id,
      quantity: productQuantity,
      variation: productSelectedVariation
    }],
    p_whatsapp_message: message
  });

  if (result.error) throw result.error;
  var data = result.data || {};
  if (!data.ok) throw new Error(data.message || "Nao foi possivel criar a encomenda.");
  return data.order || {};
}

async function sendProductToWhatsApp() {
  if (!productItem || !productStore) return;
  var variations = normalizeProductVariations(productItem);
  if (variations.length && !productSelectedVariation) {
    setProductFormError("Escolha primeiro o tamanho ou a variacao.");
    var firstVariation = document.querySelector(".product-variation-button");
    if (firstVariation) firstVariation.focus();
    return;
  }

  var customer = getProductCustomer();
  if (!customer) return;
  var phone = normalizeProductPhone(productStore.whatsapp_phone);
  if (!phone) {
    setProductFormError("O numero WhatsApp da loja nao esta disponivel.");
    return;
  }

  var button = document.getElementById("productWhatsappButton");
  try {
    if (button) {
      button.disabled = true;
      button.querySelector("span:last-child").textContent = "A criar encomenda...";
    }
    var message = buildProductWhatsAppMessage(customer);
    var order = await createProductOrder(customer, message);
    var finalMessage = order.order_number
      ? "Encomenda: " + order.order_number + "\n\n" + message
      : message;
    window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(finalMessage), "_blank", "noopener,noreferrer");
  } catch (e) {
    setProductFormError("Erro ao criar encomenda: " + (e.message || e));
  } finally {
    if (button) {
      button.disabled = !!(productStore.show_stock && Number(productItem.stock_shop) <= 0);
      button.querySelector("span:last-child").textContent = button.disabled ? "Produto esgotado" : "Pedir pelo WhatsApp";
    }
  }
}

async function loadProductPage() {
  var container = document.getElementById("productDetail");
  var productId = productParam("produto");
  var org = productParam("org");
  var slug = productParam("loja");

  if (!productId || (!org && !slug)) {
    document.documentElement.classList.remove("shop-style-pending");
    if (container) container.innerHTML = '<div class="product-error">Link do produto invalido.</div>';
    return;
  }

  try {
    var result = await supabaseClient.rpc("get_online_store", {
      p_org_id: org || null,
      p_slug: slug || null
    });
    if (result.error) throw result.error;
    var data = result.data || {};
    if (!data.ok) throw new Error(data.message || "Loja indisponivel.");

    productStore = data.store || {};
    productStoreProducts = Array.isArray(data.products) ? data.products : [];
    productItem = productStoreProducts.find(function(item) {
      return String(item.id) === String(productId);
    }) || null;
    if (!productItem) throw new Error("Produto indisponivel nesta loja.");

    productSelectedMediaIndex = 0;
    applyProductBranding(productStore);
    renderProductDetail();
  } catch (e) {
    document.documentElement.classList.remove("shop-style-pending");
    if (container) container.innerHTML = '<div class="product-error">' + productEscape(e.message || "Erro ao carregar produto.") + '</div>';
  }
}

document.addEventListener("DOMContentLoaded", function() {
  var backButton = document.getElementById("productBackButton");
  if (backButton) backButton.addEventListener("click", function() {
    window.location.href = productCatalogUrl();
  });
  loadProductPage();
});
