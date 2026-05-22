const AZUL_CACHE = "azul-pwa-v20";

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
  "/JS/i18n-extra.js",
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
      return cache.addAll(AZUL_STATIC_ASSETS).catch(function() {
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
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
