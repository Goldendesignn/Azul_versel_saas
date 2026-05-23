(function() {
  if (!("serviceWorker" in navigator)) return;

  var refreshing = false;

  navigator.serviceWorker.addEventListener("controllerchange", function() {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", function() {
    navigator.serviceWorker.register("/sw.js").then(function(registration) {
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
