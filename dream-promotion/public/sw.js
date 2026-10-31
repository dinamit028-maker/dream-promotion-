// Dream Promotion — notifications on the owner's phone (Web Push). Nothing is cached here.
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Dream Promotion', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Dream Promotion', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag, data: { url: d.url || '/' }, dir: 'rtl', lang: 'he',
    // 2.112.1: with the phone's sound and a vibration, again even when one with the same tag is still shown, and it stays
    // until it is seen (the sound itself is the phone's: on an iPhone — Settings → Notifications → Dream → Sounds)
    silent: false, renotify: Boolean(d.tag), requireInteraction: true, vibrate: [300, 120, 300, 120, 300],
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
