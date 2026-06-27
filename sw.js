// ══════════════════════════════════════════════════════
// Service Worker — Controle de Manutenção Preventiva
// Precisa ficar na MESMA pasta do index.html no GitHub Pages
// (registrado com: navigator.serviceWorker.register('./sw.js'))
// ══════════════════════════════════════════════════════
const CACHE = 'preventivas-v3';

self.addEventListener('install', e => {
  // skipWaiting força este novo SW a assumir imediatamente, sem
  // esperar todas as abas antigas fecharem — elimina o "preso na
  // versão antiga até fechar tudo" que PWAs costumam sofrer.
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k)))) // apaga TODO cache antigo, sem exceção
      .then(() => self.clients.claim())
      .then(() => {
        // Avisa todas as abas abertas para recarregarem com o código novo
        return self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // O documento HTML principal (navegação de página) NUNCA é servido do
  // cache — sempre busca da rede com cache-busting, garantindo que toda
  // vez que a página é aberta/recarregada, o código mais recente é usado.
  // Isso é o que resolve "abro o link e ainda mostra a versão antiga".
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request)) // só usa cache se estiver REALMENTE offline
    );
    return;
  }

  // Chamadas ao Firebase (dados de veículos, indisponíveis, checklist etc.):
  // NUNCA passam por cache nem por fallback de cache. Antes, uma falha de
  // rede de meio segundo (comum em 4G/Wi-Fi) fazia o app receber uma cópia
  // ANTIGA guardada no aparelho como se fosse resposta válida — sem erro
  // nenhum aparecer na tela. Isso é o que causava "dados antigos" ao abrir
  // o link, ao trocar de aba, depois de salvar, e ao não ver a atualização
  // feita em outro aparelho. Deixando passar direto (sem respondWith), o
  // pedido vai sempre para a rede de verdade; se falhar, falha mesmo — e o
  // próprio app já trata esse erro (retry automático / aviso na tela).
  if (url.hostname.endsWith('firebaseio.com')) {
    return;
  }

  // Demais recursos (CDNs externos, ícones): network-first com cache de
  // fallback, para continuar funcionando rapidamente offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
