const AZUL_CACHE = "azul-pwa-v72";

const AZUL_STATIC_ASSETS = [
  "/",
  "/index.html",
  "/core.html",
  "/admin.html",
  "/manifest.webmanifest",
  "/CSS/login.css",
  "/CSS/core.css",
  "/CSS/admin.css",
  "/JS/pwa.js",
  "/JS/supabase.js",
  "/JS/push-config.js",
  "/JS/login.js",
  "/JS/core.js",
  "/JS/admin.js",
  "/JS/offline.js",
  "/Assets/azul-icon.png",
  "/Assets/icon-192.png",
  "/Assets/icon-512.png",
  "/Assets/maskable-512.png"
];

self.addEventListener("install", function(event) {
  event.waitUntil(
    caches.open(AZUL_CACHE).then(function(cache) {
      return cache.addAll(
        AZUL_STATIC_ASSETS.map(function(asset) {
          return new Request(asset, { cache: "reload" });
        })
      ).catch(function() {
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("message", function(event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(key) { return key !== AZUL_CACHE; })
          .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("notificationclick", function(event) {
  event.notification.close();

  var data = event.notification && event.notification.data ? event.notification.data : {};
  var targetUrl = data.url || "/core.html";
  var targetHref = new URL(targetUrl, self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url && client.url.indexOf(targetHref) === 0 && "focus" in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetHref);
      }

      return Promise.resolve();
    })
  );
});

self.addEventListener("push", function(event) {
  var payload = {
    title: "Azul Gestao",
    body: "Nova notificacao",
    icon: "/Assets/icon-192.png",
    badge: "/Assets/icon-192.png",
    data: {
      url: "/core.html"
    }
  };

  if (event.data) {
    try {
      var incoming = event.data.json();
      payload = Object.assign(payload, incoming || {});
      payload.data = Object.assign({ url: "/core.html" }, incoming && incoming.data ? incoming.data : {});
    } catch (e) {
      payload.body = event.data.text() || payload.body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Azul Gestao", {
      body: payload.body || "Nova notificacao",
      icon: payload.icon || "/Assets/icon-192.png",
      badge: payload.badge || "/Assets/icon-192.png",
      tag: payload.tag || "azul-push",
      renotify: true,
      data: payload.data || { url: "/core.html" }
    })
  );
});

self.addEventListener("fetch", function(event) {
  var request = event.request;
  var url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.hostname.indexOf("supabase.co") >= 0 || url.hostname.indexOf("supabase.com") >= 0) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(function(response) {
          var clone = response.clone();
          caches.open(AZUL_CACHE).then(function(cache) {
            cache.put(request, clone);
          });
          return response;
        })
        .catch(function() {
          return caches.match(request).then(function(cached) {
            return cached || caches.match("/index.html");
          });
        })
    );
    return;
  }

  var isAppCode =
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".webmanifest");

  if (isAppCode) {
    event.respondWith(
      fetch(new Request(request, { cache: "no-store" }))
        .then(function(response) {
          if (!response || response.status !== 200) return response;
          var clone = response.clone();
          caches.open(AZUL_CACHE).then(function(cache) {
            cache.put(request, clone);
          });
          return response;
        })
        .catch(function() {
          return caches.match(request);
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function(cached) {
      return cached || fetch(request).then(function(response) {
        if (!response || (response.status !== 200 && response.type !== "opaque")) return response;
        var clone = response.clone();
        caches.open(AZUL_CACHE).then(function(cache) {
          cache.put(request, clone);
        });
        return response;
      });
    })
  );
});
