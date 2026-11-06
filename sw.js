// Keeps the app on the phone so it opens with no signal.
// Bump VERSION whenever you change any app file, so phones pick up the update.
const VERSION = "aol-v3";
const SHELL = [
  "./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Never cache the records API; the app handles offline for that itself.
  if (url.hostname.endsWith("google.com") || url.hostname.endsWith("googleusercontent.com")) return;

  // App files: serve from the phone, refresh in the background.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(hit => {
        const net = fetch(e.request).then(res => {
          if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => hit || caches.match("./index.html"));
        return hit || net;
      })
    );
    return;
  }

  // Fonts: cache after first load.
  if (url.hostname.includes("fonts.g")) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        caches.open(VERSION).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit))
    );
  }
});
