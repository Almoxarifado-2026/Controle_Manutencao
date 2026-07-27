# Notificações Push — Controle de Manutenção

Este pacote adiciona avisos automáticos (mesmo com ninguém com o app aberto) para:
- 📄 Documentos vencendo (dias de antecedência configurável), ou já vencidos
- 📋 Checklist preventiva atrasado (mesmos limites já configurados no app)
- 🚧 Veículos indisponíveis há mais de N horas (configurável)

Cada categoria pode ser ligada/desligada, e o **dia da semana e horário da
verificação são escolhidos direto no app** — nada disso precisa ser
reconfigurado aqui depois da instalação inicial.

## Como funciona (resumo)

O app (HTML) já foi atualizado para:
1. Pedir permissão de notificação ao usuário (botão "🔔 Notificações", na aba **Configuração**)
2. Guardar a "inscrição" do aparelho no Firebase, em `/manutencao/push_subscriptions`
3. Guardar as preferências (o que avisar, dias de antecedência, dia/horário) em `/manutencao/config_notificacoes`

O que falta é publicar a função `send-maintenance-alerts` (nesta pasta) no Supabase de vocês
e agendá-la para rodar a cada 15 minutos — ela é quem lê a configuração e os dados, e realmente **dispara** a notificação só no dia/horário escolhido.

## Passo a passo

### 1. Instalar a CLI do Supabase (se ainda não tiver)
```bash
npm install -g supabase
```

### 2. Entrar na sua conta e linkar o projeto já existente
```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF
```
> `SEU_PROJECT_REF` é o identificador do projeto — está na URL do painel do Supabase
> (ex: `tmadekehzdobhxasdtma`, o mesmo que já aparece no `FIREBASE_RELAY_URL` do app).

### 3. Copiar a pasta `supabase/` deste pacote para dentro do seu projeto Supabase
Se seu projeto Supabase já tem uma pasta `supabase/functions/`, é só copiar a
subpasta `send-maintenance-alerts/` pra dentro dela. Se não tiver, `supabase init`
primeiro, depois copie o `send-maintenance-alerts/`.

### 4. Configurar as chaves (secrets)
As chaves VAPID já vêm geradas neste pacote (`vapid_keys.txt`) — **a pública já
está no HTML do app**, só falta cadastrar as duas no Supabase:

```bash
supabase secrets set VAPID_PUBLIC_KEY="BD_DfK3ao_FCS5by7R6hov877tQsyDJkzGeGW2p_0SJplb7cbL1PKJRXqtXsbzRlODRdUd3hPlceo9V-9LTNZ0k"
supabase secrets set VAPID_PRIVATE_KEY="Xy_LuO-EKDQu8TygIsKKpBdidzcx0-HULtaW9StuUQ4"
supabase secrets set VAPID_SUBJECT="mailto:SEU_EMAIL@empresa.com"
```
> ⚠️ **A `VAPID_PRIVATE_KEY` é secreta** — nunca coloque ela no HTML/GitHub. Só
> aqui, como secret do Supabase. Se em algum momento ela vazar, gere um novo
> par de chaves e troque também a `PUSH_VAPID_PUBLIC_KEY` no
> `Controle_Manutencao.html`.

Por padrão a função aponta pro mesmo Firebase que o app já usa
(`controle-troca-oleo-default-rtdb.firebaseio.com`). Se algum dia isso mudar,
defina também: `supabase secrets set FIREBASE_URL="https://..."`.

### 5. Publicar a função
```bash
supabase functions deploy send-maintenance-alerts --no-verify-jwt
```
`--no-verify-jwt` porque quem vai chamar essa função é um agendador (cron), não
uma pessoa logada.

### 6. Testar manualmente (opcional, mas recomendado)
```bash
curl -X POST https://SEU_PROJECT_REF.supabase.co/functions/v1/send-maintenance-alerts
```
Deve responder algo como `{"ok":true,"avisos":2,"dispositivos_notificados":1}`.
- Se responder `avisos:0, motivo:"nada novo para avisar"` → nada está vencendo/atrasado agora, normal.
- Se responder `avisos:0, motivo:"fora do dia/horário configurado..."` → a função está funcionando, só não é a hora configurada ainda. Pra testar na hora, abra o app → Configuração → Notificações e ajuste o horário pra daqui a alguns minutos, salve, e rode o `curl` de novo depois.

### 7. Agendar para rodar a cada 15 minutos
Diferente da primeira versão, agora o **dia e horário são configurados
dentro do próprio app** (aba Configuração → Notificações). Para isso
funcionar, a função precisa ser chamada com frequência — ela mesma decide,
a cada chamada, se está "no horário" configurado ou não, e só faz alguma
coisa quando bate.

No painel do Supabase: **Database → Extensions** → habilite `pg_cron` e
`pg_net` (se ainda não estiverem habilitadas). Depois, em **SQL Editor**,
rode:

```sql
select cron.schedule(
  'alertas-manutencao-checagem',
  '*/15 * * * *',  -- a cada 15 minutos, o dia todo
  $$
  select net.http_post(
    url := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/send-maintenance-alerts',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
```

> Se você mudar `*/15` para outro intervalo (ex: `*/30` = a cada 30 min),
> ajuste também a constante `INTERVALO_CRON_MINUTOS` no topo do
> `index.ts` e publique de novo — é ela que define a "margem de
> tolerância" em torno do horário escolhido no app, para nenhuma chamada
> passar batido.

Rodar a cada 15 min não gasta mais notificações nem manda nada repetido —
a checagem em si é bem leve (poucas leituras no Firebase) e só dispara
notificação quando realmente está no dia/horário configurado.

## Ajustando as regras
**Dia/horário de verificação, quais categorias avisar, dias de antecedência
de documento e horas de indisponível — tudo isso agora é configurável
direto no app**, em **⚙️ Configuração → Notificações**, sem precisar mexer
neste arquivo nem reimplantar nada. A pessoa marca o que quer receber, o
horário e os dias da semana, clica em "Salvar configuração", e pronto — a
função lê essa configuração toda vez que roda.

O que só é ajustável aqui no `index.ts` mesmo (não tem UI no app pra isso):
- Os limites do checklist (amarelo/vermelho) — esses já vêm de
  **Checklist → Configurar Limites**, no próprio app, sem precisar de nada
  aqui.
- O texto/formato da notificação (`titulo`/`corpo`, perto do final do
  arquivo).
- O intervalo do cron (`INTERVALO_CRON_MINUTOS`, ver passo 7).

## Testando no celular
1. Abra o app, vá em **⚙️ Configuração → 🔔 Notificações** e toque para ativar.
2. Aceite a permissão que o navegador pedir.
3. No iPhone: **precisa instalar o app na tela de início primeiro**
   (compartilhar → "Adicionar à Tela de Início"), e ter iOS 16.4 ou mais novo —
   Safari não manda push pra sites comuns, só pra apps instalados.
4. No Android: funciona direto no Chrome, instalado ou não.
