// supabase/functions/firebase-relay/index.ts
//
// Relay simples: recebe QUALQUER requisição (GET, incluindo SSE via
// EventSource, e escritas PUT/POST/PATCH/DELETE) que o app mandaria
// direto pro Firebase Realtime Database, e repassa a requisição a
// partir do servidor do Supabase (São Paulo), contornando o bloqueio
// de *.firebaseio.com na rede da empresa.
//
// O corpo da resposta do Firebase é repassado como stream (sem
// bufferizar), o que permite proxiar tanto JSON comum quanto o stream
// contínuo do SSE — para SSE, isso significa que a função fica com a
// conexão aberta enquanto o cliente estiver escutando.
//
// Deploy (--no-verify-jwt é essencial: sem isso, o Supabase exige um JWT
// válido no header Authorization, e o app não manda nenhum):
//   supabase functions deploy firebase-relay --no-verify-jwt
//
// Teste rápido depois do deploy (sem precisar de nenhuma chave):
//   curl -X PUT "https://tmadekehzdobhxasdtma.supabase.co/functions/v1/firebase-relay/teste.json" \
//     -H "Content-Type: application/json" \
//     -d '{"ok":true}'
//
// Atenção: com --no-verify-jwt, esse endpoint fica público — qualquer um
// com a URL pode escrever no seu Firebase através dele. Isso NÃO piora a
// segurança em relação a hoje (o Firebase já aceita escrita direta sem
// segredo nenhum), mas se um dia vocês travarem o Firebase com regras/
// token, essa function precisa ser atualizada junto.

const FIREBASE_BASE = 'https://controle-troca-oleo-default-rtdb.firebaseio.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-http-method-override',
};

Deno.serve(async (req: Request) => {
  // Requisição de preflight CORS do navegador
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);

    // Remove o prefixo da função para obter o caminho real dentro do
    // Realtime Database. Ex.: /functions/v1/firebase-relay/manutencao/veiculos.json
    // vira /manutencao/veiculos.json
    const caminho = url.pathname.replace(/^\/functions\/v1\/firebase-relay/, '') || '/';
    const urlFirebase = FIREBASE_BASE + caminho + url.search;

    const headersFirebase: Record<string, string> = { 'Content-Type': 'application/json' };

    // Repassa o X-HTTP-Method-Override recebido do app: sem isso, o Firebase
    // trata a requisição como POST puro (cria chave nova) em vez de PATCH
    // (atualiza/mescla), mesmo que o app tenha pedido explicitamente um PATCH.
    const methodOverride = req.headers.get('x-http-method-override');
    if (methodOverride) {
      headersFirebase['X-HTTP-Method-Override'] = methodOverride;
    }

    // Repassa o Accept recebido do navegador: é ele quem faz o Firebase decidir
    // se a resposta é um JSON normal ou um stream SSE (text/event-stream).
    // O EventSource do navegador manda esse header automaticamente — sem
    // repassá-lo aqui, o Firebase sempre responderia como JSON comum e o
    // SSE via relay não funcionaria.
    const aceite = req.headers.get('accept');
    if (aceite) {
      headersFirebase['Accept'] = aceite;
    }

    const init: RequestInit = {
      method: req.method,
      headers: headersFirebase,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.text();
    }

    const respostaFirebase = await fetch(urlFirebase, init);
    const tipoConteudo = respostaFirebase.headers.get('Content-Type') || 'application/json';

    // Repassa o corpo como STREAM, sem esperar ele terminar (respostaFirebase.body
    // já é um ReadableStream). Isso é essencial para o SSE: se a gente esperasse
    // o corpo inteiro (ex.: .text()) antes de responder, ficaríamos travados aqui
    // para sempre, já que uma conexão SSE do Firebase nunca "termina" sozinha.
    // Para JSON normal (GET/PUT/PATCH/DELETE) isso também funciona igual antes,
    // só que sem o passo extra de bufferizar tudo em memória.
    return new Response(respostaFirebase.body, {
      status: respostaFirebase.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': tipoConteudo,
        // Evita qualquer buffering intermediário no stream SSE
        ...(tipoConteudo.includes('text/event-stream') ? { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } : {}),
      },
    });
  } catch (erro) {
    return new Response(JSON.stringify({ error: String(erro) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
