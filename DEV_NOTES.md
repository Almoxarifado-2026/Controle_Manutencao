# DEV_NOTES.md — Notas técnicas do Controle de Manutenção

Este documento existe pra quem (inclusive uma futura conversa com o Claude)
for mexer no `Controle_Manutencao.html` não precisar redescobrir do zero
umas pegadinhas que já causaram bug repetido.

## Arquitetura em 1 parágrafo

É um único arquivo HTML (`Controle_Manutencao.html`, ~21 mil linhas) rodando
como PWA estático no GitHub Pages, sem nenhum servidor próprio. Os dados
ficam no Firebase Realtime Database, acessado direto via REST (`fbGet`/
`fbPut`, não o SDK do Firebase) — inclusive com um "relay" via Supabase Edge
Function pra contornar bloqueio de rede corporativo a `*.firebaseio.com`
(ver `FIREBASE_RELAY_URL` no código). O `sw.js` cuida do cache/PWA/offline.

## ⚠️ Regra #1: todo deploy precisa mudar a versão do `sw.js`

O navegador só percebe que existe uma versão nova do Service Worker quando
o **conteúdo do `sw.js` muda byte a byte**. Se você editar só o HTML e
esquecer de subir a versão do `CACHE_NAME` no `sw.js`, o app vai continuar
servindo a versão antiga do cache pra sempre (ou até alguém limpar o cache
manualmente), mesmo com o arquivo novo já publicado.

**Sempre que publicar uma mudança no HTML, mude também:**
```js
const CACHE_NAME = 'manutencao-vNNN';  // sobe o número
```

## Modo escuro — como funciona (e onde ele quebra)

O modo escuro **não é uma paleta de cores "de verdade"** com variáveis CSS
bem definidas para cada elemento. Ele funciona catando, no HTML que já
existia (pensado só pra modo claro), pedacinhos de `style="..."` que batem
com cores conhecidas, e trocando na hora:

1. **CSS estático** (`<style>`, seção "MODO ESCURO DO SISTEMA"): regras
   tipo `html.dark-mode [style*="color:#1e293b"] { color: #e2e8f0 !important; }`
   — troca qualquer elemento com essa cor de texto, e outras parecidas
   (`[style*="background:#f1f5f9"]` etc para fundos).
2. **Correção dinâmica via JS** (`_aplicarCorrecaoDarkModeDinamica()`,
   perto de `toggleDarkMode()`): roda num MutationObserver + timer, olha a
   cor computada (`getComputedStyle`) de cada elemento dentro de
   `.pagina.active`, e se bater com uma cor "clara" conhecida
   (`_DM_FUNDOS_CLAROS_RGB`) ou "escura" conhecida
   (`_DM_TEXTOS_ESCUROS_RGB`), troca via `el.style.background`/`el.style.color`.

### O bug que apareceu repetidas vezes

Um elemento com fundo **colorido de propósito** (ex: badge amarelo de
"aguardando", botão azul-claro de "Editar") tem texto numa cor que também é
usada em MUITOS outros lugares como "texto escuro comum" (ex: `#1e293b`,
`#555`, `#64748b`). O mecanismo acima não sabe diferenciar "texto escuro
comum, que precisa clarear porque o fundo dele vai escurecer" de "texto
escuro que é PARTE do design de um badge/botão, cujo fundo não muda". Ele
clareia os dois do mesmo jeito — e se o fundo não estiver na lista de
fundos que também escurecem, o resultado é texto claro sobre fundo claro
(quase invisível).

**Antes de criar qualquer badge/botão com cor de fundo "de propósito"**, rode:
```bash
python3 dev-tools/verificar_contraste_dark_mode.py Controle_Manutencao.html
```
Se aparecer um problema novo, o jeito mais simples de resolver (nessa ordem
de preferência):

1. **Use as classes prontas** (`.badge-ok`, `.badge-warn`, `.badge-danger`,
   `.badge-info`, `.badge-neutral` — ver `<style>`, logo depois de
   `.btn-cancel`) em vez de repetir cor solta no `style=""`. Elas já têm
   `!important` e não são tocadas pelo mecanismo automático.
2. Se precisar de uma cor nova que essas classes não cobrem, adicione uma
   exceção de CSS na seção "MODO ESCURO DO SISTEMA", no mesmo padrão das
   que já existem:
   ```css
   html.dark-mode [style*="background:#SUACOR"][style*="color:#OUTRACOR"] {
     color: #OUTRACOR !important;
   }
   ```
3. Se o elemento for tocado pela correção via JS e uma exceção de CSS não
   for suficiente (ex: o próprio JS reescreve o atributo `style`, fazendo a
   exceção de CSS "sumir" — foi o que causou o bug do botão "Editar"
   piscando), adicione a classe `no-dark-dim` no elemento. A função de JS
   já verifica essa classe e pula o elemento por completo.

### Por que às vezes a correção "pisca"

Se você usar SÓ uma exceção de CSS baseada em `[style*="..."]` num
elemento que a função de JS também mexe, pode piscar: a função de JS lê a
cor computada (que já reflete sua exceção de CSS), acha que ainda precisa
"corrigir", e sobrescreve `el.style.color` diretamente — o que muda o
TEXTO do atributo `style`, fazendo sua exceção baseada em `[style*="..."]`
parar de bater. Na próxima renderização, sua exceção volta a valer, o JS
roda nele de novo, e assim por diante. **Solução: `no-dark-dim`, não uma
exceção de CSS sozinha**, para qualquer elemento que a correção de JS
também alcance (dentro de `.pagina.active` ou `.overlay.open .modal`).

## Convenção para código novo

Indicadores/badges de status (verde=ok, amarelo=atenção, vermelho=
problema, azul=info, cinza=neutro) devem usar as classes prontas:
```html
<span class="badge-ok">✅ Em Dia</span>
<span class="badge-warn">🟡 Próximo</span>
<span class="badge-danger">🔴 Vencido</span>
```
Em vez de:
```html
<span style="background:#dcfce7;color:#166534;...">✅ Em Dia</span>
```
Isso centraliza a cor num lugar só (fácil de ajustar globalmente depois) e
já vem protegido contra o bug acima.

## Checklist antes de publicar uma mudança

- [ ] Rodei `verificar_contraste_dark_mode.py` e não apareceu problema novo
- [ ] Subi a versão do `CACHE_NAME` no `sw.js`
- [ ] Testei no modo claro E no modo escuro
- [ ] Testei em largura de celular (≤400px) — muita coisa quebra só nessa largura
- [ ] Se mexi em alguma aba com sub-abas (Indisponíveis) ou botões que
      viraram parte de outra aba (Configuração), testei a navegação entre
      elas
