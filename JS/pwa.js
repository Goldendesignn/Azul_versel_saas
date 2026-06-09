(function() {
  function installMobileButtonFeedback() {
    if (window.__azulMobileButtonFeedbackInstalled) return;
    window.__azulMobileButtonFeedbackInstalled = true;

    var style = document.createElement("style");
    style.id = "azul-mobile-button-feedback-style";
    style.textContent = [
      "@media (max-width: 900px), (pointer: coarse) {",
      "  button.azul-mobile-busy {",
      "    position: relative !important;",
      "    pointer-events: none !important;",
      "    user-select: none !important;",
      "    color: transparent !important;",
      "    text-shadow: none !important;",
      "  }",
      "  button.azul-mobile-busy > * {",
      "    visibility: hidden !important;",
      "  }",
      "  button.azul-mobile-busy::after {",
      "    content: '';",
      "    position: absolute;",
      "    width: 18px;",
      "    height: 18px;",
      "    left: 50%;",
      "    top: 50%;",
      "    margin: -11px 0 0 -11px;",
      "    border: 3px solid currentColor;",
      "    border-right-color: transparent;",
      "    border-radius: 50%;",
      "    color: var(--azul-button-spinner-color, #ffffff);",
      "    animation: azul-mobile-button-spin .65s linear infinite;",
      "  }",
      "  button.azul-mobile-busy:disabled {",
      "    opacity: .78;",
      "  }",
      "}",
      "@keyframes azul-mobile-button-spin {",
      "  to { transform: rotate(360deg); }",
      "}",
      "@media (prefers-reduced-motion: reduce) {",
      "  button.azul-mobile-busy::after { animation-duration: 1.2s; }",
      "}"
    ].join("\n");
    document.head.appendChild(style);

    function isMobileInteraction() {
      return window.matchMedia &&
        window.matchMedia("(max-width: 900px), (pointer: coarse)").matches;
    }

    function isInstantControl(button) {
      if (button.hasAttribute("data-no-mobile-loading")) return true;
      if (button.closest(".nav, nav, [role='tablist']")) return true;
      if (button.matches(
        ".tab, .mode-btn, .login-tab, .import-tab, .sale-catalog-tab, " +
        ".mobile-menu-btn, .notification-btn, .payment-modal-close, " +
        ".devices-preview-close, .shop-mobile-cart-summary, .shop-cart-button, " +
        ".context-help-fab, .onboarding-secondary, .onboarding-primary"
      )) return true;

      var aria = String(button.getAttribute("aria-label") || "").toLowerCase();
      if (/fechar|abrir menu|notifica|close|menu/.test(aria)) return true;

      var label = String(button.textContent || "").trim().toLowerCase();
      if (!label || /^(x|×|\+|-|\^|<|>)$/.test(label)) return true;

      return false;
    }

    function isActionButton(button) {
      if (button.hasAttribute("data-mobile-loading")) return true;

      var label = String(button.textContent || "").trim().toLowerCase();
      return /(registar|registrar|guardar|confirmar|enviar|atualizar|actualizar|refresh|aplicar|filtrar|pesquisar|gerar|eliminar|desativar|reativar|renovar|importar|transferir|criar|ativar|alterar|terminar sessao|entrar)/.test(label);
    }

    function showBusy(button) {
      if (
        !button ||
        button.classList.contains("azul-mobile-busy")
      ) return;

      var startedAt = Date.now();
      var background = window.getComputedStyle(button).backgroundColor || "";
      var rgb = background.match(/\d+(?:\.\d+)?/g);

      if (rgb && rgb.length >= 3) {
        var luminance =
          (Number(rgb[0]) * 0.299 + Number(rgb[1]) * 0.587 + Number(rgb[2]) * 0.114) / 255;
        button.style.setProperty(
          "--azul-button-spinner-color",
          luminance > 0.72 ? "#0f172a" : "#ffffff"
        );
      }

      button.classList.add("azul-mobile-busy");
      button.setAttribute("aria-busy", "true");

      function finishWhenReady() {
        var elapsed = Date.now() - startedAt;

        if (elapsed < 900 || (button.disabled && elapsed < 30000)) {
          window.setTimeout(finishWhenReady, 150);
          return;
        }

        button.classList.remove("azul-mobile-busy");
        button.removeAttribute("aria-busy");
        button.style.removeProperty("--azul-button-spinner-color");
      }

      window.setTimeout(finishWhenReady, 150);
    }

    document.addEventListener("click", function(event) {
      if (!isMobileInteraction()) return;

      var button = event.target && event.target.closest
        ? event.target.closest("button")
        : null;

      if (!button) return;
      if (button.disabled || isInstantControl(button) || !isActionButton(button)) return;

      // Executa primeiro o onclick existente e aplica o bloqueio logo depois.
      window.setTimeout(function() {
        showBusy(button);
      }, 0);
    });
  }

  installMobileButtonFeedback();

  if (!("serviceWorker" in navigator)) return;

  var refreshing = false;

  navigator.serviceWorker.addEventListener("controllerchange", function() {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", function() {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(function(registration) {
      registration.update();

      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      registration.addEventListener("updatefound", function() {
        var worker = registration.installing;
        if (!worker) return;

        worker.addEventListener("statechange", function() {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    }).catch(function(error) {
      console.warn("PWA non activee:", error);
    });
  });
})();
