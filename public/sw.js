const STATIC_CACHE = "line-web-static-v7";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/app-icon.svg",
  "/icons/app-icon-180.png",
  "/icons/app-icon-192.png",
  "/icons/app-icon-512.png",
  "/icons/apple-touch-icon-114.png",
  "/icons/apple-touch-icon-57.png",
  "/icons/apple-startup-320x460.png",
  "/icons/apple-startup-640x920.png",
  "/icons/apple-startup-640x1096.png",
];
const NETWORK_FIRST_PATHS = new Set([
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;

  if (request.mode === "navigate" || NETWORK_FIRST_PATHS.has(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, copy);
            });
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html"))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }

        const copy = response.clone();
        caches.open(STATIC_CACHE).then((cache) => {
          cache.put(request, copy);
        });

        return response;
      });
    }),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "LINE Web Chat";
  const chatMid = data.chatMid || "";
  const accountId = data.accountId || "";
  const options = {
    body: data.body || "新しいメッセージ",
    icon: "/icons/app-icon-192.png",
    badge: "/icons/app-icon-192.png",
    tag: data.tag || (accountId + ":" + chatMid) || "line-web",
    renotify: true,
    data: { chatMid: chatMid, accountId: accountId },
  };

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // アプリがフォーカスされている場合は OS 通知を抑制し、アプリ内処理に委ねる（二重通知防止）
      const focused = clients.filter((c) => c.focused);
      if (focused.length > 0) {
        for (const client of focused) {
          client.postMessage({ type: "push:message", chatMid: chatMid, accountId: accountId });
        }
        return undefined;
      }
      return self.registration.showNotification(title, options);
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  const chatMid = info.chatMid;
  const accountId = info.accountId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          client.postMessage({ type: "notification:click", chatMid: chatMid, accountId: accountId });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/").then((client) => {
          if (client) client.postMessage({ type: "notification:click", chatMid: chatMid, accountId: accountId });
        });
      }
    }),
  );
});
