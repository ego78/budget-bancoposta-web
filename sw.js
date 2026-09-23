const CACHE="budget-personale-v4.1-shell";
const SHELL=["./","./index.html","./manifest.json","./icons/icon-192.png","./icons/icon-512.png","./icons/apple-touch-icon.png"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET") return;
  // Never cache banking, Firebase, auth or other cross-origin/private traffic.
  if(u.origin!==self.location.origin) return;
  e.respondWith(fetch(e.request).then(r=>{
    const copy=r.clone();
    if(r.ok && ["document","style","script","image","manifest"].includes(e.request.destination))
      caches.open(CACHE).then(c=>c.put(e.request,copy));
    return r;
  }).catch(()=>caches.match(e.request).then(r=>r||caches.match("./index.html"))));
});