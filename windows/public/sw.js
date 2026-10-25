// Offline shell for the web app. /assets/* files carry a hash in their name (never change):
// cache first. Pages: network first, but after 3 s the cached copy is used, so a slow link
// never stalls the start. The API (/api/*) is never cached here; notes live in IndexedDB.
const C = "coucou-shell-v3";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/")) return;
  const net = () => fetch(e.request, { cache: "no-store" }).then((r) => { if (r.ok) caches.open(C).then((c) => c.put(e.request, r.clone())); return r; });
  const cached = () => caches.match(e.request);
  if (u.pathname.startsWith("/assets/")) {
    e.respondWith(cached().then((m) => m || net()));
    return;
  }
  e.respondWith(
    Promise.race([net(), new Promise((_, no) => setTimeout(no, 3000))])
      .catch(async () => (await cached()) || net())
      .catch(async () => (await caches.match("/web.html")) || (await caches.match("/")) || Response.error()));
});
