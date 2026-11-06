const CACHE = 'data-app-interfaz-v10';
const INTERFAZ = ['./', './index.html', './estilos.css', './app.js', './campos.js', './offline.js', './dictado.js', './captura-voz.js', './manifest.webmanifest', './logo-dataapp-192.png', './logo-dataapp-512.png'];

self.addEventListener('install', evento => {
  evento.waitUntil(caches.open(CACHE).then(cache => cache.addAll(INTERFAZ)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', evento => {
  evento.waitUntil(caches.keys().then(claves => Promise.all(claves
    .filter(clave => clave.startsWith('data-app-interfaz-') && clave !== CACHE)
    .map(clave => caches.delete(clave)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', evento => {
  const url = new URL(evento.request.url);
  if (evento.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const base = new URL(self.registration.scope);
  const recurso = INTERFAZ.find(ruta => new URL(ruta, base).pathname === url.pathname);
  if (!recurso) return;
  evento.respondWith(fetch(evento.request).catch(async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(new URL(recurso, base))) || Response.error();
  }));
});
