/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{
    url: string
    revision?: string | null
  }>
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

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

