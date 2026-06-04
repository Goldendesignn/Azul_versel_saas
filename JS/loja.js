var shopStore = null;
var shopProducts = [];
var shopCart = [];
var shopCartOpen = false;

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
    product.category,
    product.code,
    product.variation,
    Array.isArray(product.variations) ? product.variations.join(" ") : product.variations
  ].map(function(value) {
    if (value && typeof value === "object") return JSON.stringify(value).toLowerCase();
    return String(value || "").toLowerCase();
  }).join(" ");
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
      if (container) container.innerHTML = '<div class="shop-empty">Loja indisponivel.</div>';
      return;
    }

    shopStore = data.store || {};
    shopProducts = Array.isArray(data.products) ? data.products : [];
    applyShopStore();
    renderShopProducts();
    renderShopCart();
  } catch (e) {
    console.error("Erro loja:", e);
    if (container) container.innerHTML = '<div class="shop-empty">Erro ao carregar loja.</div>';
  }
}

function applyShopStore() {
  var name = shopStore.store_name || "Loja Azul";
  var welcome = shopStore.welcome_message || "Adiciona produtos ao carrinho e envia o pedido pelo WhatsApp.";

  document.title = name;

  var shopName = document.getElementById("shopName");
  var heroTitle = document.getElementById("shopHeroTitle");
  var welcomeEl = document.getElementById("shopWelcome");

  if (shopName) shopName.textContent = name;
  if (heroTitle) heroTitle.textContent = name;
  if (welcomeEl) welcomeEl.textContent = welcome;
}

function renderShopProducts() {
  var container = document.getElementById("shopProducts");
  if (!container) return;

  var q = String((document.getElementById("shopSearch") || {}).value || "").trim().toLowerCase();
  var list = q ? shopProducts.filter(function(product) {
    return productSearchText(product).indexOf(q) >= 0;
  }) : shopProducts;

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
    var hasStockLimit = shopStore.show_stock && stock > 0;
    var isOut = shopStore.show_stock && stock <= 0;
    var photo = String(product.photo || "").trim();
    var firstLetter = shopEscape(String(product.name || "A").charAt(0).toUpperCase());
    var variation = shopEscape(product.variation || "");
    var stockText = shopStore.show_stock
      ? (stock > 0 ? "Disponivel: " + stock : "Esgotado")
      : "Disponivel";
    var image = photo
      ? '<div class="shop-product-image"><img src="' + shopEscape(photo) + '" alt="' + name + '"></div>'
      : '<div class="shop-product-image">' + firstLetter + '</div>';
    var meta = category + (variation ? " | " + variation : "") + " | " + shopEscape(stockText);

    return '<article class="shop-product-card' + (isOut ? ' is-out' : '') + '">' +
      image +
      '<div class="shop-product-info">' +
        '<strong title="' + name + '">' + name + '</strong>' +
        '<small title="' + meta + '">' + meta + '</small>' +
        '<div class="shop-product-price">' + shopMoney(price) + '</div>' +
      '</div>' +
      '<div class="shop-product-actions">' +
        '<div class="shop-qty">' +
          '<button type="button" onclick="changeShopQty(\'' + id + '\', -1)">-</button>' +
          '<span id="shop-qty-' + id + '">1</span>' +
          '<button type="button" onclick="changeShopQty(\'' + id + '\', 1)"' + (hasStockLimit ? ' data-stock="' + stock + '"' : '') + '>+</button>' +
        '</div>' +
        '<button type="button" class="shop-add-btn" onclick="addShopProduct(\'' + id + '\')"' + (isOut ? ' disabled' : '') + '>' + (isOut ? 'Esgotado' : 'Adicionar') + '</button>' +
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

function sendShopCartToWhatsApp() {
  if (!shopCart.length) return;

  openShopCart();

  var customer = getShopCustomerData();
  if (!customer) return;

  var phone = normalizeShopPhone(shopStore.whatsapp_phone);
  if (!phone) {
    alert("Numero WhatsApp indisponivel.");
    return;
  }

  var url = "https://wa.me/" + phone + "?text=" + encodeURIComponent(buildWhatsAppMessage(customer));
  window.open(url, "_blank", "noopener,noreferrer");
}

function scrollToCart() {
  openShopCart();
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

document.addEventListener("DOMContentLoaded", loadShop);
