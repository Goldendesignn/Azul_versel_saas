var productStore = null;
var productItem = null;
var productStoreProducts = [];
var productQuantity = 1;
var productSelectedVariation = "";
var productSelectedMediaIndex = 0;
var productPageCart = [];

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

function getProductRegularPrice(product) {
  product = product || {};
  return Number(product.original_sale_price || product.regular_price || product.base_sale_price || product.sale_price || 0);
}

function isProductPromo(product) {
  var price = Number(product && product.sale_price) || 0;
  var regular = getProductRegularPrice(product);
  return !!(product && product.promo_active && price > 0 && regular > price);
}

function renderProductPriceBlock(product) {
  var price = Number(product && product.sale_price) || 0;
  if (!isProductPromo(product)) {
    return '<div class="product-price">' + productMoney(price) + '</div>';
  }
  var regular = getProductRegularPrice(product);
  var label = String(product.promo_label || "").trim();
  return '<div class="product-price-box">' +
    '<span class="product-promo-label">' + productEscape(label || "Promocao activa") + '</span>' +
    '<span class="product-old-price">' + productMoney(regular) + '</span>' +
    '<div class="product-price">' + productMoney(price) + '</div>' +
    '<span class="product-promo-save">Poupa ' + productMoney(regular - price) + '</span>' +
  '</div>';
}

function renderProductCardPrice(product) {
  var price = Number(product && product.sale_price) || 0;
  if (!isProductPromo(product)) {
    return '<div class="shop-product-price">' + productMoney(price) + '</div>';
  }
  var regular = getProductRegularPrice(product);
  return '<div class="shop-product-price-row">' +
    '<span class="shop-product-old-price">' + productMoney(regular) + '</span>' +
    '<div class="shop-product-price">' + productMoney(price) + '</div>' +
    '<span class="shop-product-save">' + productEscape(product.promo_label || ('Poupa ' + productMoney(regular - price))) + '</span>' +
  '</div>';
}

function normalizeProductPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function getProductStockStatus(product) {
  var stock = Number(product && product.stock_shop) || 0;
  if (productStore && productStore.show_stock && stock <= 0) {
    return { className: "is-out", label: "Esgotado", text: "Produto sem stock" };
  }
  if (productStore && productStore.show_stock && stock > 0 && stock <= 3) {
    return { className: "is-low", label: "Poucas unidades", text: stock + " disponivel" };
  }
  if (productStore && productStore.show_stock) {
    return { className: "is-available", label: "Disponivel", text: stock + " disponiveis" };
  }
  return { className: "is-available", label: "Disponivel", text: "Por encomenda" };
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

function productCartUrl() {
  var url = new URL(productCatalogUrl());
  url.searchParams.set("cart", "open");
  return url.toString();
}

function goToProductCart() {
  window.location.href = productCartUrl();
}

function getProductCartStorageKey() {
  var org = productParam("org");
  var slug = productParam("loja");
  return "azul_online_cart_" + (org ? "org_" + org : "slug_" + String(slug || "").toLowerCase());
}

function normalizeProductCartRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(function(row) {
    return {
      product_id: row.product_id || row.id || "",
      name: row.name || "",
      code: row.code || "",
      variation: row.variation || "",
      quantity: Number(row.quantity || row.qty) || 0,
      price: Number(row.price) || 0
    };
  }).filter(function(row) {
    return row.product_id && row.quantity > 0;
  });
}

function loadProductPageCartFromStorage() {
  try {
    productPageCart = normalizeProductCartRows(JSON.parse(localStorage.getItem(getProductCartStorageKey()) || "[]"));
  } catch (e) {
    productPageCart = [];
  }
}

function saveProductPageCartToStorage() {
  try {
    localStorage.setItem(getProductCartStorageKey(), JSON.stringify(productPageCart.map(function(item) {
      return {
        id: item.product_id,
        product_id: item.product_id,
        name: item.name,
        code: item.code,
        variation: item.variation,
        price: Number(item.price) || 0,
        qty: Number(item.quantity) || 0,
        quantity: Number(item.quantity) || 0
      };
    })));
  } catch (e) {}
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

function renderProductMediaElement(media, name, lazy, compact) {
  if (!media || !media.url) {
    return productEscape(String(productItem && productItem.name || "A").charAt(0).toUpperCase());
  }
  var url = productEscape(media.url);
  if (media.type === "video") {
    if (compact) {
      return '<video src="' + url + '" muted playsinline preload="metadata"></video><span class="product-video-badge">Video</span>';
    }
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
        var stockStatus = getProductStockStatus(item);
        var isOut = stockStatus.className === "is-out";
        var variation = productEscape(item.variation || "");
        var meta = category + (variation ? " | " + variation : "");
        var image = renderSimilarProductMedia(item, name);

        return '<article class="shop-product-card' + (isOut ? ' is-out' : '') + '" tabindex="0" role="link" onclick="openSimilarProduct(\'' + id + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openSimilarProduct(\'' + id + '\')}">' +
          '<div class="shop-product-media-wrap">' +
            image +
            (isProductPromo(item) ? '<span class="shop-promo-badge">Promo</span>' : '') +
            '<span class="shop-stock-badge ' + stockStatus.className + '">' + productEscape(stockStatus.label) + '</span>' +
          '</div>' +
          '<div class="shop-product-info">' +
            '<strong title="' + name + '">' + name + '</strong>' +
            '<small title="' + meta + '">' + meta + '</small>' +
            '<span class="shop-product-stock-text">' + productEscape(stockStatus.text) + '</span>' +
            renderProductCardPrice(item) +
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
  var stockStatus = getProductStockStatus(productItem);
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
          renderProductMediaElement(media, productItem.name || "Produto", true, true) +
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
        renderProductPriceBlock(productItem) +
        '<p class="product-description">' + description + '</p>' +
        '<div class="product-trust-strip">' +
          '<span><b>W</b> Pedido directo no WhatsApp</span>' +
          '<span><b>&#10003;</b> Confirmacao rapida da loja</span>' +
        '</div>' +
        '<div class="product-meta-line">' +
          (productItem.code ? '<span>Codigo: ' + productEscape(productItem.code) + '</span>' : '') +
          '<span class="' + stockStatus.className + '">' + productEscape(stockStatus.label) + ': ' + productEscape(stockStatus.text) + '</span>' +
        '</div>' +
        '<div class="product-order-panel">' +
          (variations.length
            ? '<fieldset class="product-fieldset"><legend>Escolher tamanho ou variacao</legend><p class="product-field-hint">Toca numa opcao antes de pedir. Assim a loja recebe o pedido sem confusao.</p><div class="product-variation-list">' + variationButtons + '</div></fieldset>'
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
          '<button type="button" class="product-cart-add-button" id="productCartAddButton" onclick="addProductToPageCart()"' + (isOut ? ' disabled' : '') + '>' +
            '<span aria-hidden="true">+</span>' +
            '<strong>' + (isOut ? 'Produto esgotado' : 'Adicionar ao carrinho') + '</strong>' +
          '</button>' +
          '<div class="product-cart-summary" id="productCartSummary" aria-live="polite"></div>' +
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
  renderProductCartSummary();
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

function getCurrentProductCartItem() {
  return {
    product_id: productItem.id,
    name: productItem.name || "Produto",
    code: productItem.code || "",
    variation: productSelectedVariation || "",
    quantity: productQuantity,
    price: Number(productItem.sale_price) || 0
  };
}

function validateProductChoiceForCart() {
  if (!productItem) return false;
  var variations = normalizeProductVariations(productItem);
  if (variations.length && !productSelectedVariation) {
    setProductFormError("Escolha primeiro o tamanho ou a variacao.");
    var firstVariation = document.querySelector(".product-variation-button");
    if (firstVariation) firstVariation.focus();
    return false;
  }
  return true;
}

function addProductToPageCart() {
  if (!validateProductChoiceForCart()) return;

  loadProductPageCartFromStorage();
  var item = getCurrentProductCartItem();
  var existing = productPageCart.find(function(cartItem) {
    return String(cartItem.product_id) === String(item.product_id)
      && String(cartItem.variation || "") === String(item.variation || "");
  });

  if (existing) {
    existing.quantity += item.quantity;
  } else {
    productPageCart.push(item);
  }

  productQuantity = 1;
  var qty = document.getElementById("productQuantity");
  var total = document.getElementById("productOrderTotal");
  if (qty) qty.textContent = "1";
  if (total) total.textContent = productMoney(Number(productItem.sale_price) || 0);
  setProductFormError("");
  saveProductPageCartToStorage();
  renderProductCartSummary(true);
}

function getProductCartLines() {
  if (productPageCart.length) return productPageCart.slice();
  if (!productItem) return [];
  return [getCurrentProductCartItem()];
}

function getProductCartTotal() {
  return getProductCartLines().reduce(function(sum, item) {
    return sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0));
  }, 0);
}

function getProductPageCartTotalOnly() {
  return productPageCart.reduce(function(sum, item) {
    return sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0));
  }, 0);
}

function getProductPageCartQty() {
  return productPageCart.reduce(function(sum, item) {
    return sum + (Number(item.quantity) || 0);
  }, 0);
}

function renderProductFloatingCartBubble(justAdded) {
  var bubble = document.getElementById("productFloatingCart");
  if (!bubble) {
    bubble = document.createElement("button");
    bubble.type = "button";
    bubble.id = "productFloatingCart";
    bubble.className = "product-floating-cart";
    bubble.onclick = goToProductCart;
    document.body.appendChild(bubble);
  }

  var qty = getProductPageCartQty();
  if (!qty) {
    bubble.hidden = true;
    bubble.classList.remove("just-added");
    return;
  }

  bubble.hidden = false;
  bubble.innerHTML =
    '<span class="product-floating-cart-icon" aria-hidden="true">+</span>' +
    '<span class="product-floating-cart-text">' +
      '<b>Ver carrinho</b>' +
      '<small>' + qty + (qty === 1 ? ' produto' : ' produtos') + ' | ' + productMoney(getProductPageCartTotalOnly()) + '</small>' +
    '</span>';
  bubble.classList.toggle("just-added", !!justAdded);
  if (justAdded) {
    setTimeout(function() {
      bubble.classList.remove("just-added");
    }, 800);
  }
}

function renderProductCartSummary(justAdded) {
  renderProductFloatingCartBubble(justAdded);
  var box = document.getElementById("productCartSummary");
  if (!box) return;
  if (!productPageCart.length) {
    box.innerHTML = '<span>O carrinho esta vazio. Adiciona o produto ou pede directamente pelo WhatsApp.</span>';
    box.classList.remove("has-item", "just-added");
    return;
  }

  var qty = productPageCart.reduce(function(sum, item) {
    return sum + (Number(item.quantity) || 0);
  }, 0);
  box.innerHTML =
    '<strong>' + qty + (qty === 1 ? ' produto no carrinho' : ' produtos no carrinho') + '</strong>' +
    '<button type="button" class="product-cart-summary-link" onclick="goToProductCart()">Ver carrinho: ' + productMoney(getProductPageCartTotalOnly()) + '</button>';
  box.classList.add("has-item");
  box.classList.toggle("just-added", !!justAdded);
  if (justAdded) {
    setTimeout(function() {
      box.classList.remove("just-added");
    }, 800);
  }
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
    "Produtos:"
  ];

  getProductCartLines().forEach(function(item) {
    var meta = [item.code, item.variation].filter(Boolean).join(" | ");
    lines.push("- " + item.name + (meta ? " (" + meta + ")" : "") + " | Qtd: " + item.quantity + " | Total: " + productMoney(item.quantity * item.price));
  });

  lines.push("Total: " + productMoney(getProductCartTotal()));
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
    p_items: getProductCartLines().map(function(item) {
      return {
        product_id: item.product_id,
        quantity: item.quantity,
        variation: item.variation || ""
      };
    }),
    p_whatsapp_message: message
  });

  if (result.error) throw result.error;
  var data = result.data || {};
  if (!data.ok) throw new Error(data.message || "Nao foi possivel criar a encomenda.");
  return data.order || {};
}

async function sendProductToWhatsApp() {
  if (!productItem || !productStore) return;
  if (!productPageCart.length && !validateProductChoiceForCart()) return;

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
    loadProductPageCartFromStorage();
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
