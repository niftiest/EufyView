// Service Worker for EufyView PWA
// Minimal SW to satisfy installability requirements

const CACHE_NAME = 'eufy-view-v2';
const PRECACHE = [
    '/',
    '/index.html',
    '/css/styles.css',
    '/js/app.js',
    '/icon-192.svg',
    '/icon-512.svg',
    '/manifest.json'
];

// Install: precache shell assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Fetch: network-first for API/streams, cache-fallback for shell
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Never cache API, WebSocket upgrades, or video streams
    if (url.pathname.startsWith('/api') ||
        url.pathname.endsWith('.mp4') ||
        url.pathname === '/health' ||
        url.pathname === '/config' ||
        e.request.method !== 'GET') {
        return; // Let browser handle normally
    }

    e.respondWith(
        fetch(e.request)
            .then(response => {
                // Update cache with fresh copy
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                return response;
            })
            .catch(() => caches.match(e.request))
    );
});
