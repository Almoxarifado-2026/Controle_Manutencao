// ─────────────────────────────────────────────────────────────────────────────
//  sw.js — Service Worker para Controle de Manutenção
//  Estratégia:
//    • Cache-first para o shell do app (HTML principal)
//    • Network-only para Firebase (dados sempre frescos)
//    • Network-only para SSE (EventSource não é cacheável)
//    • Responde SKIP_WAITING para troca imediata de versão
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'manutencao-v1';

// Recursos do shell que devem ser cacheados na instalação
const SHELL_URLS = [
  './',
  './Controle_Manutencao.html',
];

// Domínios que NUNCA devem passar pelo cache (sempre network)
const NETWORK_ONLY_HOSTS = [
  'firebaseio.com',
  'firebase.google.com',
  'googleapis.com',
];

// ── Install: cacheia o shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_URLS).catch(err => {
        // Se o HTML não estiver disponível no momento da instalação (ex: offline),
        // ignora silenciosamente — o cache será preenchido na próxima vez.
        console.warn('[SW] Shell cache parcial:', err.message);
      });
    })
  );
  // Assume controle imediatamente quando o HTML mandar SKIP_WAITING
  // (o HTML já trata isso via postMessage)
});

// ── Activate: remove caches antigos ──────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => {
      // Avisa a página que o SW novo assumiu
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
      });
      return self.clients.claim();
    })
  );
});

// ── Fetch: intercepta requisições ────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1) Requisições não-GET → sempre network (PUT/PATCH/DELETE no Firebase)
  if (event.request.method !== 'GET') return;

  // 2) Firebase e APIs externas → sempre network, sem cache
  if (NETWORK_ONLY_HOSTS.some(host => url.hostname.includes(host))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 3) SSE (EventSource) → sempre network
  const acceptHeader = event.request.headers.get('Accept') || '';
  if (acceptHeader.includes('text/event-stream')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 4) Parâmetros anti-cache (_fresh, _v) → sempre network, sem guardar
  if (url.searchParams.has('_fresh') || url.searchParams.has('_v')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 5) Protocolo não-http (blob:, chrome-extension:, etc.) → ignora
  if (!url.protocol.startsWith('http')) return;

  // 6) Shell do app → Cache-first com fallback para network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Não estava no cache → busca na rede e cacheia
      return fetch(event.request).then(response => {
        // Só cacheia respostas válidas de mesma origem
        if (
          response.ok &&
          response.type !== 'opaque' &&
          url.origin === self.location.origin
        ) {
          const respClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
        }
        return response;
      }).catch(() => {
        // Offline e sem cache → tenta servir o HTML principal como fallback
        return caches.match('./Controle_Manutencao.html');
      });
    })
  );
});

// ── Message: SKIP_WAITING enviado pelo HTML ───────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
