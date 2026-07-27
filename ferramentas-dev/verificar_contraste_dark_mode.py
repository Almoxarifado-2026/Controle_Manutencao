#!/usr/bin/env python3
# ══════════════════════════════════════════════════════════════════════════
#  verificar_contraste_dark_mode.py
#
#  Varre o Controle_Manutencao.html procurando o MESMO tipo de bug que
#  corrigimos várias vezes numa sessão só: um elemento com fundo claro
#  "fixo" (que o modo escuro do sistema NÃO escurece) pareado com uma cor
#  de texto que o modo escuro CLAREIA — resultado: texto quase invisível.
#
#  Isso acontece porque o modo escuro deste app não é feito com uma
#  paleta de cores "de verdade" (variáveis CSS bem definidas) — ele
#  procura, no HTML já pronto, pedaços de texto tipo "color:#1e293b" e
#  troca por uma cor clara. Funciona na maioria dos casos, mas quebra
#  sempre que um elemento tem uma cor de fundo colorida "de propósito"
#  (um badge de status, um botão) que não está na lista de fundos que
#  esse mesmo mecanismo também escurece.
#
#  COMO USAR:
#    python3 verificar_contraste_dark_mode.py Controle_Manutencao.html
#
#  O script não modifica nada — só avisa. Se aparecer algo na lista,
#  o jeito mais simples de corrigir é um dos dois (ver DEV_NOTES.md):
#    a) Adicionar `no-dark-dim` na classe do elemento (se for algo que a
#       função de JS mexe) — faz a correção automática pular esse elemento.
#    b) Adicionar uma exceção de CSS logo depois da lista genérica em
#       "MODO ESCURO DO SISTEMA", tipo:
#       html.dark-mode [style*="background:#SUACOR"][style*="color:#OUTRACOR"] {
#         color: #OUTRACOR !important;
#       }
# ══════════════════════════════════════════════════════════════════════════

import re
import sys

# Cores de texto que o modo escuro deste app clareia automaticamente
# (ver função _aplicarCorrecaoDarkModeDinamica() e a lista de seletores
# CSS "[style*=color:...]" na seção MODO ESCURO DO SISTEMA do HTML).
DARK_TEXT_TARGETS = {
    '#1b3a6d', '#1e293b', '#1e3a8a', '#0f172a', '#334155', '#475569',
    '#374151', '#16365c', '#555', '#555555',
    '#64748b', '#94a3b8', '#6b7280', '#999', '#999999', '#aaa', '#aaaaaa',
}

# Fundos que o modo escuro JÁ escurece automaticamente (portanto seguros
# de parear com as cores de texto acima).
SAFE_BACKGROUNDS = {
    '#fff', '#ffffff', 'white',
    '#f8fafc', '#f1f5f9', '#f0fdf4', '#eff6ff', '#f0f9ff', '#fafafa', '#f9fafb',
    '#1e293b',  # já é escuro por natureza — não tem o que "clarear"
}

STYLE_RE = re.compile(r'style="([^"]*)"')
BG_RE = re.compile(r'background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6}|white|rgba?\([^)]*\))')
COLOR_RE = re.compile(r'(?<!background-)color\s*:\s*(#[0-9a-fA-F]{3,6}|white)')
NO_DARK_DIM_RE = re.compile(r'class="[^"]*no-dark-dim[^"]*"')

# Reconhece exceções já resolvidas via CSS, no formato que usamos no
# arquivo, ex:
#   html.dark-mode [style*="background:#f0f0f0"][style*="color:#555"] { ... }
# (a ordem dos dois atributos no seletor pode vir trocada)
CSS_EXCECAO_RE = re.compile(
    r'\[style\*="background:\s*(#[0-9a-fA-F]{3,6})"\]\[style\*="color:\s*(#[0-9a-fA-F]{3,6})"\]'
    r'|\[style\*="color:\s*(#[0-9a-fA-F]{3,6})"\]\[style\*="background:\s*(#[0-9a-fA-F]{3,6})"\]'
)


def extrair_excecoes_css(conteudo):
    """Retorna o conjunto de pares (fundo, cor) que já têm uma exceção de
    CSS dedicada em algum lugar do arquivo (não precisa ser perto do
    elemento — exceções costumam ficar centralizadas na seção de dark
    mode)."""
    pares = set()
    for m in CSS_EXCECAO_RE.finditer(conteudo):
        if m.group(1) and m.group(2):
            pares.add((m.group(1).lower(), m.group(2).lower()))
        elif m.group(3) and m.group(4):
            pares.add((m.group(4).lower(), m.group(3).lower()))
    return pares


def verificar(caminho_arquivo):
    with open(caminho_arquivo, encoding='utf-8') as f:
        conteudo = f.read()

    excecoes_css = extrair_excecoes_css(conteudo)

    achados = []
    for m in STYLE_RE.finditer(conteudo):
        estilo = m.group(1)
        bgs = BG_RE.findall(estilo)
        cores = COLOR_RE.findall(estilo)
        if not bgs or not cores:
            continue

        bg = bgs[0].lower()
        cor = cores[-1].lower()  # a última declaração de "color:" é a que vale
        if bg.startswith('rgba'):
            continue  # fundo semitransparente — normalmente seguro em qualquer tema
        if cor not in DARK_TEXT_TARGETS or bg in SAFE_BACKGROUNDS:
            continue

        # Já tem uma exceção de CSS dedicada pra esse par exato de cores?
        if (bg, cor) in excecoes_css:
            continue

        # Já tem a proteção "no-dark-dim" bem perto? Provavelmente já é um
        # caso conhecido e resolvido — ainda assim reportamos como "info",
        # não como problema, pra não gerar alarme falso.
        contexto = conteudo[max(0, m.start() - 120):m.start()]
        protegido = bool(NO_DARK_DIM_RE.search(contexto))

        linha = conteudo[:m.start()].count('\n') + 1
        achados.append((linha, bg, cor, protegido, estilo[:80]))

    return achados


def main():
    if len(sys.argv) < 2:
        print('Uso: python3 verificar_contraste_dark_mode.py Controle_Manutencao.html')
        sys.exit(1)

    achados = verificar(sys.argv[1])
    problemas = [a for a in achados if not a[3]]
    ja_protegidos = [a for a in achados if a[3]]

    print(f'Analisado: {sys.argv[1]}\n')

    if not problemas:
        print('✅ Nenhuma combinação perigosa de fundo-claro + texto-clareado encontrada.')
    else:
        print(f'⚠️  {len(problemas)} combinação(ões) perigosa(s) encontrada(s):\n')
        for linha, bg, cor, _, estilo in problemas:
            print(f'  Linha {linha}: fundo {bg} + texto {cor}')
            print(f'    style="{estilo}..."')
            print()
        print('Ver DEV_NOTES.md → seção "Modo escuro" para como corrigir.')

    if ja_protegidos:
        print(f'\nℹ️  {len(ja_protegidos)} combinação(ões) parecida(s), mas já com no-dark-dim por perto (provavelmente já corrigidas).')

    sys.exit(1 if problemas else 0)


if __name__ == '__main__':
    main()
