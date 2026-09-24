/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{
    url: string
    revision?: string | null
  }>
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Every route is the same SPA shell (vercel.json rewrites all paths to index.html), but the
// precache only knows `/` and `/index.html`. Without this an offline launch at the manifest's
// `/app`, or an offline reload of any deep link, misses the cache and fails.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// On SKIP_WAITING (from the "Refresh" toast) the new worker activates, but
// without clients.claim() it never takes over the already-open page — so no
// `controllerchange` fires and vite-plugin-pwa's reload never runs. Claiming on
// activate makes the new worker control the page immediately → controllerchange
// → reload. (On a first-ever install there's no prior controller, so workbox's
// `isUpdate` is false and no reload is triggered — no first-load reload loop.)
clientsClaim()

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

