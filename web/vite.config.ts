import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

function staticShellWorker(): Plugin {
  return {
    name: "tsudoi-static-shell-worker",
    generateBundle(_options, bundle) {
      const staticAssets = Object.values(bundle)
        .map((file) => file.fileName)
        .filter((file) => file === "index.html" || (/^assets\/.+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(file)));
      const assetPaths = ["/", ...staticAssets.map((file) => `/${file}`)];
      const version = JSON.stringify(staticAssets.sort());
      const source = `const CACHE="tsudoi-static-shell-${stableHash(version)}";\nconst ASSETS=${JSON.stringify(assetPaths)};\nself.addEventListener("install",event=>{event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(ASSETS);await self.skipWaiting()})())});\nself.addEventListener("activate",event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith("tsudoi-static-shell-")&&name!==CACHE)await caches.delete(name);await self.clients.claim()})())});\nself.addEventListener("fetch",event=>{const request=event.request;if(request.method!=="GET")return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/public/")||url.pathname==="/mcp"||url.pathname.startsWith("/events/"))return;if(request.mode==="navigate"){if(url.pathname!=="/")return;event.respondWith((async()=>{try{return await fetch(request)}catch{const cache=await caches.open(CACHE);const cached=await cache.match("/");return cached??Response.error()}})());return}if(ASSETS.includes(url.pathname)){event.respondWith((async()=>{const cache=await caches.open(CACHE);return (await cache.match(url.pathname))||fetch(request)})())}});`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

export default defineConfig({ plugins: [svelte(), staticShellWorker()], build: { outDir: "dist", emptyOutDir: true } });
