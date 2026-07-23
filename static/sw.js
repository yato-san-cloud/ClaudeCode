// 紹介状アプリ Service Worker
// 院内利用前提: HTML/JSON は network-first、静的アセットは cache-first
const CACHE = "chiro-app-v1";
const STATIC_ASSETS = [
    "/",
    "/referral",
    "/xray",
    "/static/css/style.css",
    "/static/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // 静的アセットは cache-first
    if (url.pathname.startsWith("/static/")) {
        event.respondWith(
            caches.match(req).then(
                (cached) =>
                    cached ||
                    fetch(req).then((res) => {
                        const clone = res.clone();
                        caches.open(CACHE).then((c) => c.put(req, clone));
                        return res;
                    })
            )
        );
        return;
    }

    // HTML/JSON は network-first、オフライン時はキャッシュへフォールバック
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res.ok && req.headers.get("accept")?.includes("text/html")) {
                    const clone = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, clone));
                }
                return res;
            })
            .catch(() => caches.match(req))
    );
});
