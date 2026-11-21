const CACHE_PREFIX = "jarvis-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/jarvis-mark.svg"];
const IMMUTABLE_ASSET = /\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|webp)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/index.html", response.clone());
        }
        return response;
      } catch {
        return (await caches.match("/index.html")) ?? Response.error();
      }
    })());
    return;
  }

  if (IMMUTABLE_ASSET.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request, { cache: "no-store" });
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })());
    return;
  }

  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith((async () => (await caches.match(request)) ?? fetch(request, { cache: "no-store" }))());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});