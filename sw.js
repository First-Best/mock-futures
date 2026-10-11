// 24시 모의선물 서비스 워커: 홈 화면 앱 설치와 (나중에) 체결 알림용.
// 화면(index.html)은 늘 인터넷에서 새로 받고, 인터넷이 끊겼을 때만 마지막으로 받은 화면을 보여 줘요. 시세·순위 요청은 건드리지 않아요.
const CACHE = 'mock24-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok) { const copy = r.clone(); e.waitUntil(caches.open(CACHE).then(c => c.put('./', copy))); }
      return r;
    } catch (err) {
      return (await caches.match('./')) || new Response('<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">인터넷에 연결되지 않았어요. 연결되면 다시 열어 주세요.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  })());
});
// 체결 알림 (서버 알림 기능을 켜면 쓰여요)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '24시 모의선물', { body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/maskable-192.png', tag: d.tag, data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) if (c.url.startsWith(self.registration.scope)) { await c.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
