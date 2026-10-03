/* BANDOHQ · service worker — tar emot push-notiser och visar dem.
   Ingen cache: appen hämtas alltid färsk, det här är bara för notiserna. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'BANDOHQ', {
    body: d.body || '',
    icon: 'apple-touch-icon.png',
    badge: 'apple-touch-icon.png',
    tag: d.kind || 'bandohq',          /* samma sort ersätter föregående i stället för att staplas */
    renotify: true,
    data: { url: d.url || './' }
  }));
});

/* Tryck på notisen: öppna appen (eller ta fram den om den redan är öppen). */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
