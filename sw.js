const CACHE = "training-offline-v2";

const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",

  // Optional images (remove any that don't exist EXACTLY)
  "./images/OIP.jpg",
  "./images/OIP1.jpg",
  "./images/latzug.webp",
  "./images/Dumbbell-Bench-Press_Using-Too-Heavy-Weights.jpg",
  "./images/bicep-curls-1655286150.avif",
  "./images/how_to_plank.webp"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).catch(() => {
        // Offline fallback
        return caches.match("./") || caches.match("./index.html");
      });
    })
  );
});
