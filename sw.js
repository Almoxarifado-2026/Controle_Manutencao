// ══════════════════════════════════════════════════════
// Service Worker — Controle de Manutenção Preventiva
// Precisa ficar na MESMA pasta do index.html no GitHub Pages
// (registrado com: navigator.serviceWorker.register('./sw.js'))
// ══════════════════════════════════════════════════════
const CACHE = 'preventivas-v4';

// Recursos estáticos de CDN que valem cachear para funcionar offline
const CDN_CACHE_URLS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

self.addEventListener('install', e => {
  // skipWaiting força este novo SW a assumir imediatamente, sem
  // esperar todas as abas antigas fecharem — elimina o "preso na
  // versão antiga até fechar tudo" que PWAs costumam sofrer.
  self.skipWaiting();

  // Pré-cacheia CDNs em segundo plano durante o install
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(CDN_CACHE_URLS.map(url =>
        cache.add(url).catch(() => {}) // falha silenciosa — offline no install é ok
      ))
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k)) // apaga apenas caches ANTIGOS
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Avisa todas as abas abertas para recarregarem com o código novo.
        // Aguarda 500ms para o clients.claim() propagar antes de avisar —
        // evita race condition onde a aba recebe SW_UPDATED antes de estar
        // sob controle do novo SW.
        return new Promise(res => setTimeout(res, 500)).then(() =>
          self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
            clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
          })
        );
      })
  );
});

// Também responde ao SKIP_WAITING enviado pelo HTML (registro do SW)
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // ── 1. HTML principal — SEMPRE da rede, nunca do cache ──
  // Garante que toda recarga/abertura usa o código mais recente.
  // Fallback para cache apenas se estiver completamente offline.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // ── 2. Firebase — NUNCA passa por cache ──
  // Dados de veículos, indisponíveis, checklist, histórico etc. devem
  // sempre vir do servidor. Cache de dados do Firebase causaria exibição
  // de informações desatualizadas sem nenhum aviso na tela.
  if (url.hostname.endsWith('firebaseio.com') || url.hostname.endsWith('firebase.com')) {
    return; // deixa o fetch passar direto, sem respondWith
  }

  // ── 3. CDNs e recursos estáticos — cache-first com fallback de rede ──
  // Melhora performance e permite uso offline. Atualiza o cache em segundo
  // plano quando a rede responde, sem bloquear a exibição da página.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fromNetwork = fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => null);

      // Se temos cache, entrega imediatamente e atualiza por trás (stale-while-revalidate)
      // Se não temos cache, espera a rede responder
      return cached || fromNetwork;
    })
  );
});
