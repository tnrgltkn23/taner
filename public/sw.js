self.addEventListener('install',event=>{self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const url=new URL('/gunluk-verilerim/',self.location.origin).href;const tabs=await self.clients.matchAll({type:'window',includeUncontrolled:true});const tab=tabs.find(t=>t.url===url);if(tab)return tab.focus();return self.clients.openWindow(url);})());});
