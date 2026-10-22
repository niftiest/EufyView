// Service Worker for EufyView PWA
// Minimal SW to satisfy installability requirements

const CACHE_NAME = 'eufy-view-v30';
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

// Fetch: network-first for sub-resources, cache-fallback. NEVER intercept page
// navigations — the browser must handle them (and any auth redirect) natively.
// Returning a redirected response from a SW for a navigation hangs the load
// (this was the recurring stuck-on-splash bug).
self.addEventListener('fetch', (e) => {
    if (e.request.mode === 'navigate') return;

    const url = new URL(e.request.url);

    // Never cache API, WebSocket upgrades, video streams, frame polls, or push
    if (url.pathname.startsWith('/api') ||
        url.pathname.startsWith('/push') ||
        url.pathname.startsWith('/admin') ||
        url.pathname.startsWith('/auth') ||
        url.pathname.startsWith('/frame/') ||
        url.pathname.startsWith('/history/') ||
        url.pathname.endsWith('.mp4') ||
        url.pathname.endsWith('.jpg') ||
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

// ============================================================================
// Web Push — background detection notifications
// ============================================================================

// Show a notification when a push arrives (works while the app is closed).
// IMPORTANT: the subscription is userVisibleOnly, so we MUST show a
// notification for every push. If we ever return without showing one, Chrome
// records a budget violation and, after a few, REVOKES the subscription
// (endpoint starts returning 410). So always call showNotification here.
self.addEventListener('push', (e) => {
    e.waitUntil((async () => {
        let data = {};
        try { data = e.data ? e.data.json() : {}; } catch (_) {}

        const title = data.title || 'EufyView';
        const body = data.body || '';
        const tag = data.tag || 'eufyview';
        // `update`: the event thumbnail for an alert already shown ("Full Effect"
        // style) — replace it in place without buzzing the phone a second time.
        const update = !!data.update;
        const image = data.image ? await loadNotificationImage(data.image) : undefined;

        await self.registration.showNotification(title, {
            body,
            tag,
            renotify: !update,
            silent: update,
            image,
            // Doorbell rings stay on screen and buzz harder, like the official
            // app's separate ring alert vs. motion alert.
            requireInteraction: data.event === 'ring',
            vibrate: update ? undefined : (data.event === 'ring' ? [300, 100, 300, 100, 300] : [200]),
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            data: { serialNumber: data.serialNumber, event: data.event }
        });
    })());
});

// Fetch the thumbnail ourselves (same-origin, so it also passes Cloudflare
// Access) and inline it as a data: URL; the OS's own image fetch may not carry
// cookies. Falls back to the plain URL, which the token alone authorizes.
async function loadNotificationImage(path) {
    const url = new URL(path, self.location.origin).href;
    try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return url;
        const blob = await res.blob();
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
    } catch (_) {
        return url;
    }
}

// Decode a base64url VAPID key into the Uint8Array subscribe() expects.
function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// When the browser rotates/expires the push subscription, it fires this event.
// Re-subscribe with the server's VAPID key and re-register so notifications
// keep working without the user having to re-enable them. (Same-origin fetch
// carries the session cookie, so the server re-binds it to the right user.)
self.addEventListener('pushsubscriptionchange', (e) => {
    e.waitUntil((async () => {
        try {
            const res = await fetch('/push/key');
            const { publicKey } = await res.json();
            if (!publicKey) return;
            const sub = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8Array(publicKey)
            });
            await fetch('/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // oldEndpoint lets the server carry this person's camera/type/
                // style settings over — the worker can't read the page's copy.
                body: JSON.stringify({
                    subscription: sub,
                    oldEndpoint: e.oldSubscription ? e.oldSubscription.endpoint : undefined
                })
            });
        } catch (err) {
            // best-effort; the client also re-syncs on next app open
        }
    })());
});

// Tap a notification → open/focus the app and deep-link to that camera's mode
// chooser. The camera serial rides along in notification.data.serialNumber.
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const sn = e.notification.data && e.notification.data.serialNumber;
    e.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows) {
            if ('focus' in client) {
                await client.focus();
                if (sn) client.postMessage({ type: 'open-camera', serialNumber: sn });
                return;
            }
        }
        if (self.clients.openWindow) {
            return self.clients.openWindow(sn ? ('/?camera=' + encodeURIComponent(sn)) : '/');
        }
    })());
});
