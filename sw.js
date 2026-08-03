// ─────────────────────────────────────────────────────────────────────────────
//  sw.js — Service Worker para Controle de Manutenção
//  Estratégia:
//    • Network-first para o HTML principal (sempre busca a versão mais
//      recente; cai para o cache só se a rede falhar/demorar — evita
//      ficar preso numa versão antiga em cache)
//    • Cache-first para os demais recursos do shell (raramente mudam)
//    • Network-only para Firebase (dados sempre frescos)
//    • Network-only para SSE (EventSource não é cacheável)
//    • Responde SKIP_WAITING para troca imediata de versão
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ IMPORTANTE: o navegador só percebe que há uma versão nova do
// Service Worker quando o conteúdo de sw.js muda byte a byte. Mudar
// SÓ o Controle_Manutencao.html (sem tocar aqui) faz o navegador
// continuar servindo o HTML antigo via cache-first, achando que nada
// mudou — mesmo com o arquivo novo já publicado no GitHub Pages.
// Por isso: A CADA atualização do HTML, mude também o número abaixo
// (ex.: v2 → v3). Isso muda o conteúdo deste arquivo, o navegador
// detecta a diferença, baixa o SW novo, e o cache antigo é descartado
// no 'activate' (ver mais abaixo).
const CACHE_NAME = 'manutencao-v211';

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

  // 6) HTML principal → NETWORK-FIRST: sempre tenta buscar a versão mais
  //    recente na rede primeiro, e só usa o cache se a rede falhar
  //    (offline ou timeout). Isso elimina a dependência de lembrar de
  //    "subir a versão do cache" a cada atualização do HTML — sem essa
  //    troca, o navegador podia continuar servindo um HTML antigo do
  //    cache indefinidamente, mesmo com uma versão nova já publicada no
  //    GitHub Pages, porque o sw.js em si não tinha mudado e o navegador
  //    nunca detectava que havia algo novo para buscar.
  const ehHtmlPrincipal = url.pathname.endsWith('Controle_Manutencao.html') || url.pathname.endsWith('/');
  if (ehHtmlPrincipal) {
    event.respondWith(
      Promise.race([
        fetch(event.request, { cache: 'no-store' }),
        // Não deixa a rede lenta travar o carregamento da página
        // indefinidamente — depois de 4s sem resposta, cai para o cache
        // (se existir) enquanto a rede continua tentando em segundo plano.
        new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), 4000))
      ])
        .then(response => {
          if (response.ok && url.origin === self.location.origin) {
            const respClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./Controle_Manutencao.html')))
    );
    return;
  }

  // 7) Demais recursos do shell (ícones, manifest, etc.) → Cache-first com
  //    fallback para network — esses raramente mudam, então não precisam
  //    da mesma urgência de atualização do HTML principal.
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

// Ícone usado nas notificações — o ícone "de verdade" do app é gerado
// dinamicamente via Canvas dentro do HTML (ver initPWA()), então não existe
// um arquivo icon-192.png real no servidor para o Service Worker buscar
// (ele roda de forma independente da página, às vezes sem nenhuma aba
// aberta). Por isso, aqui usamos um SVG embutido com o mesmo visual
// (fundo azul-marinho + 🔧), que sempre existe, não depende de rede nem
// de a página ter rodado antes.
const PUSH_ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' +
  '<rect width="192" height="192" rx="34" fill="#1e3a8a"/>' +
  '<text x="96" y="130" font-size="100" text-anchor="middle">🔧</text>' +
  '</svg>'
);

// ── Push: recebe a notificação enviada pela função externa (Supabase) ───────
// O payload esperado é um JSON: { title, body, url? }. Se o envio não vier
// como JSON (ou vier vazio), usamos um texto genérico em vez de falhar
// silenciosamente sem mostrar nada ao usuário.
self.addEventListener('push', event => {
  let dados = { title: '🔧 Controle de Manutenção', body: 'Você tem novidades para conferir.' };
  try {
    if (event.data) dados = { ...dados, ...event.data.json() };
  } catch (e) { /* mantém o texto genérico acima */ }

  event.waitUntil(
    self.registration.showNotification(dados.title, {
      body: dados.body,
      icon: PUSH_ICON,
      badge: PUSH_ICON,
      data: { url: dados.url || './Controle_Manutencao.html' },
      vibrate: [100, 50, 100]
    })
  );
});

// ── Clique na notificação: foca numa aba já aberta do app, ou abre uma nova ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './Controle_Manutencao.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      for (const client of clientsArr) {
        if (client.url.includes('Controle_Manutencao.html') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
