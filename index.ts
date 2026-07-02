// supabase/functions/firebase-relay/index.ts
//
// Relay simples: recebe as ESCRITAS (PUT/POST/PATCH/DELETE) que o app
// mandaria direto pro Firebase Realtime Database, e repassa a
// requisição a partir do servidor do Supabase (São Paulo), contornando
// o bloqueio de *.firebaseio.com na rede da empresa.
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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    const init: RequestInit = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.text();
    }

    const respostaFirebase = await fetch(urlFirebase, init);
    const corpo = await respostaFirebase.text();

    return new Response(corpo, {
      status: respostaFirebase.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': respostaFirebase.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (erro) {
    return new Response(JSON.stringify({ error: String(erro) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
