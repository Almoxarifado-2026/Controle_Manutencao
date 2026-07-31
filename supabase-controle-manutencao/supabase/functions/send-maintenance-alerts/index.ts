// ══════════════════════════════════════════════════════════════════════════
//  send-maintenance-alerts
//
//  Roda com frequência (a cada 15-30 min — ver README.md) mas só REALMENTE
//  verifica e envia quando bate com o dia/horário configurado pela pessoa
//  no próprio app (aba Configuração → Notificações). Isso é o que permite
//  trocar o dia/horário direto no app, sem precisar mexer neste arquivo
//  nem reimplantar nada no Supabase depois da configuração inicial.
//
//  Confere (cada categoria pode ser ligada/desligada no app):
//    • 📄 Documentos (CRLV/CIV/CIPP) vencendo em N dias, ou já vencidos
//    • 📋 Checklist preventiva em atraso (zona amarela/vermelha já
//      configurada no próprio app, em Checklist → "Configurar Limites")
//    • 🚧 Veículos indisponíveis há mais de N horas
//  Para cada condição nova (que ainda não tinha sido avisada antes — ver
//  /manutencao/alertas_enviados no Firebase), envia UMA notificação push
//  resumida para cada aparelho inscrito.
//
//  Este arquivo não faz nada sozinho: precisa ser publicado (deploy) no
//  projeto Supabase de vocês e agendado. Passo a passo completo em
//  README.md, na mesma pasta.
// ══════════════════════════════════════════════════════════════════════════

// @ts-ignore — import via especificador "npm:" (suportado nativamente pelo
// runtime de Edge Functions do Supabase, que é baseado em Deno)
import webpush from "npm:web-push@3.6.7";
// @ts-ignore — geração do PDF do Checklist Preventiva (anexado no e-mail)
import { jsPDF } from "npm:jspdf@2.5.1";
// @ts-ignore
import autoTable from "npm:jspdf-autotable@5.0.8";

const FIREBASE_URL = Deno.env.get("FIREBASE_URL") ?? "https://controle-troca-oleo-default-rtdb.firebaseio.com";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:contato@example.com";

// ── E-mail via Resend (opcional) ──────────────────────────────────────────
// RESEND_API_KEY é cadastrada como secret (ver README.md). Se não for
// configurada, o envio de e-mail simplesmente é pulado (não quebra o resto).
// EMAIL_REMETENTE pode ser trocado por um endereço do seu próprio domínio
// verificado no Resend; até lá, "onboarding@resend.dev" funciona sem
// verificação nenhuma (é o remetente de testes que o Resend libera de cara).
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_REMETENTE = Deno.env.get("EMAIL_REMETENTE") ?? "Controle de Manutenção <onboarding@resend.dev>";

// A cada quantos minutos o agendador (cron) chama esta função — usado só
// pra calcular a "janela de tolerância" em torno do horário configurado
// (ver mais abaixo). Se você mudar o agendamento no README, ajuste aqui
// também. Ex: cron rodando a cada 15 min → tolerância de ±10 min garante
// que nenhuma execução "passa direto" do horário configurado.
const INTERVALO_CRON_MINUTOS = 15;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function fbGet(path: string): Promise<any> {
  try {
    const r = await fetch(FIREBASE_URL + path);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
async function fbPut(path: string, data: unknown): Promise<void> {
  try {
    await fetch(FIREBASE_URL + path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch (e) {
    console.error("fbPut falhou:", path, e);
  }
}
async function fbDelete(path: string): Promise<void> {
  try {
    await fetch(FIREBASE_URL + path, { method: "DELETE" });
  } catch (e) {
    console.error("fbDelete falhou:", path, e);
  }
}

// Manda um e-mail (via Resend) com a lista completa de avisos para cada
// destinatário cadastrado no app, opcionalmente com PDFs anexados (ex.:
// checklist por programador). Não lança erro para fora — se falhar, só
// registra no log, sem derrubar o resto da função (push continua
// funcionando normalmente mesmo se o e-mail falhar por algum motivo).
async function enviarEmailResend(
  destinatarios: string[],
  titulo: string,
  avisos: string[],
  anexos: { filename: string; content: string }[] = []
): Promise<number> {
  if (!RESEND_API_KEY || destinatarios.length === 0) return 0;
  const listaHtml = avisos.map(a => `<li style="margin-bottom:6px">${a}</li>`).join("");
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px">
      <h2 style="color:#1e3a8a">🔧 ${titulo}</h2>
      <ul style="padding-left:18px;color:#1e293b">${listaHtml}</ul>
      ${anexos.length ? `<p style="color:#1e293b;font-size:13px">📎 Checklist completo em anexo, separado por programador.</p>` : ""}
      <p style="color:#94a3b8;font-size:12px;margin-top:20px">Aviso automático do Controle de Manutenção.</p>
    </div>`;
  let enviados = 0;
  for (const destino of destinatarios) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: EMAIL_REMETENTE,
          to: [destino],
          subject: titulo,
          html,
          ...(anexos.length ? { attachments: anexos } : {}),
        }),
      });
      if (r.ok) enviados++;
      else console.error("Resend recusou envio para", destino, await r.text());
    } catch (e) {
      console.error("Falha ao enviar e-mail para", destino, e);
    }
  }
  return enviados;
}

// ── Cores das células, iguais às usadas no app (exportarPDFCheck) ──────────
function _diasCor(dias: number) {
  if (dias > 14) return { fill: [255, 199, 206], text: [156, 0, 6] };
  if (dias >= 10) return { fill: [255, 235, 156], text: [156, 87, 0] };
  return { fill: [198, 239, 206], text: [39, 98, 33] };
}
function _corrCor(qtd: number) {
  if (qtd >= 4) return { fill: [255, 199, 206], text: [156, 0, 6] };
  if (qtd === 3) return { fill: [255, 235, 156], text: [156, 87, 0] };
  if (qtd > 0) return { fill: [198, 239, 206], text: [39, 98, 33] };
  return { fill: [243, 244, 246], text: [156, 163, 175] };
}

// Gera o PDF do Checklist Preventiva de UM programador, com o mesmo layout
// (título roxo, KPIs de corretivas, tabela colorida por dias/corretivas)
// usado no botão "Exportar PDF" do app — só que rodando aqui no servidor,
// sem precisar de navegador nenhum aberto.
function gerarPdfChecklistProgramador(programador: string, linhas: any[]): ArrayBuffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(88, 28, 135);
  doc.rect(0, 0, pageW, 46, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(`Checklist Preventiva — ${programador}`, 18, 22);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`${linhas.length} registro(s) · Ordenado por dias (maior → menor)`, 18, 38);

  const agora = new Date();
  doc.setFontSize(8);
  doc.text(
    `Gerado em: ${agora.toLocaleDateString("pt-BR")} ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`,
    pageW - 18,
    22,
    { align: "right" }
  );

  const totCav = linhas.reduce((s, c) => s + (c.qtd_corr_cav_auto || c.qtd_corr_cav || 0), 0);
  const totReb = linhas.reduce((s, c) => s + (c.qtd_corr_reb_auto || c.qtd_corr_reb || 0), 0);
  doc.setTextColor(30, 41, 59);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(`QTD CORRETIVAS CAVALO: ${totCav}    QTD CORRETIVAS REBOQUE: ${totReb}    TOTAL: ${totCav + totReb}`, 18, 62);

  const ordenadas = linhas.slice().sort((a, b) => (b.dias || 0) - (a.dias || 0));
  const corpo = ordenadas.map(c => {
    const corrCav = c.qtd_corr_cav_auto || c.qtd_corr_cav || 0;
    const corrReb = c.qtd_corr_reb_auto || c.qtd_corr_reb || 0;
    return [
      c.programador || "—",
      c.cavalo || "—",
      c.tipo || "—",
      c.reboque || "—",
      c.ult_prev || "—",
      `${c.dias || 0}d`,
      c.obs_log || "—",
      c.obs_comp || "—",
      String(corrCav),
      String(corrReb),
      c.retorno_log || "—",
    ];
  });

  autoTable(doc, {
    startY: 72,
    head: [["PROGRAMADOR", "CAVALO", "TIPO", "REBOQUE", "ÚLT. PREVENTIVA", "DIAS", "OBS LOGÍSTICA", "OBS COMPRAS", "CORR. CAVALO", "CORR. REBOQUE", "RETORNO LOG."]],
    body: corpo,
    styles: { fontSize: 7.5, cellPadding: 4, valign: "middle" },
    headStyles: { fillColor: [27, 58, 109], textColor: [255, 255, 255], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 247, 255] },
    columnStyles: { 5: { halign: "center" }, 8: { halign: "center" }, 9: { halign: "center" }, 10: { halign: "center" } },
    didParseCell: (data: any) => {
      if (data.section !== "body") return;
      if (data.column.index === 5) {
        const dias = parseInt(String(data.cell.raw)) || 0;
        const cor = _diasCor(dias);
        data.cell.styles.fillColor = cor.fill;
        data.cell.styles.textColor = cor.text;
        data.cell.styles.fontStyle = "bold";
      }
      if (data.column.index === 8 || data.column.index === 9) {
        const qtd = parseInt(String(data.cell.raw)) || 0;
        const cor = _corrCor(qtd);
        data.cell.styles.fillColor = cor.fill;
        data.cell.styles.textColor = cor.text;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  return doc.output("arraybuffer");
}

// Converte um ArrayBuffer/Uint8Array para base64 — necessário porque os
// anexos do Resend precisam vir como string base64, e Deno não tem um
// atalho pronto pra isso em buffers grandes sem estourar o limite de
// argumentos do String.fromCharCode.
function _arrayBufferParaBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binario = "";
  const tamanhoBloco = 8192;
  for (let i = 0; i < bytes.length; i += tamanhoBloco) {
    binario += String.fromCharCode(...bytes.subarray(i, i + tamanhoBloco));
  }
  // @ts-ignore — btoa é global no Deno
  return btoa(binario);
}

// Dias corridos entre uma data "AAAA-MM-DD" (vencimento de documento) e hoje.
// Retorna positivo se JÁ passou, negativo se ainda falta.
function diasDesde(dataISO: string): number | null {
  if (!dataISO) return null;
  const dt = new Date(dataISO.slice(0, 10) + "T00:00:00");
  if (isNaN(dt.getTime())) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje.getTime() - dt.getTime()) / 86400000);
}

// Dia da semana (0=domingo...6=sábado) e "HH:MM" no horário de Brasília,
// independente de em qual fuso o servidor do Supabase estiver rodando.
function agoraNoBrasil(): { diaSemana: number; horaMinuto: string; minutosDoDia: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const partes = fmt.formatToParts(new Date());
  const mapaDia: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const diaTxt = partes.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hora = parseInt(partes.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minuto = parseInt(partes.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { diaSemana: mapaDia[diaTxt] ?? 0, horaMinuto: `${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`, minutosDoDia: hora * 60 + minuto };
}

function dentroDaJanela(horarioConfigurado: string, minutosAgora: number): boolean {
  const [hStr, mStr] = (horarioConfigurado || "07:00").split(":");
  const minutosConfigurados = (parseInt(hStr, 10) || 0) * 60 + (parseInt(mStr, 10) || 0);
  const tolerancia = Math.ceil(INTERVALO_CRON_MINUTOS / 2) + 2; // margem de segurança
  return Math.abs(minutosAgora - minutosConfigurados) <= tolerancia;
}

Deno.serve(async (_req: Request) => {
  const configRaw = await fbGet("/manutencao/config_notificacoes.json");
  const config = {
    categorias: {
      documentos: configRaw?.categorias?.documentos !== false,
      checklist: configRaw?.categorias?.checklist !== false,
      indisponiveis: configRaw?.categorias?.indisponiveis !== false,
    },
    dias_antecedencia_docs: configRaw?.dias_antecedencia_docs || 15,
    horas_indisponivel: configRaw?.horas_indisponivel || 48,
    horario: configRaw?.horario || "07:00",
    horario_tarde: configRaw?.horario_tarde || "",
    dias_semana: Array.isArray(configRaw?.dias_semana) && configRaw.dias_semana.length ? configRaw.dias_semana : [0, 1, 2, 3, 4, 5, 6],
    email_ativo: !!configRaw?.email_ativo,
    emails: Array.isArray(configRaw?.emails) ? configRaw.emails : [],
  };

  // ── Só segue adiante se for o dia/horário certo (configurado no app) ──
  // Confere os dois horários possíveis (manhã sempre, tarde só se
  // preenchida) — basta bater com QUALQUER um dos dois pra seguir.
  const { diaSemana, horaMinuto, minutosDoDia } = agoraNoBrasil();
  const bateManha = dentroDaJanela(config.horario, minutosDoDia);
  const bateTarde = !!config.horario_tarde && dentroDaJanela(config.horario_tarde, minutosDoDia);
  if (!config.dias_semana.includes(diaSemana) || !(bateManha || bateTarde)) {
    const horariosConfigurados = [config.horario, config.horario_tarde].filter(Boolean).join(" ou ");
    return new Response(
      JSON.stringify({
        ok: true,
        avisos: 0,
        motivo: `fora do dia/horário configurado (agora: dia ${diaSemana} ${horaMinuto}, configurado: dias ${config.dias_semana.join(",")} às ${horariosConfigurados})`,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const [subs, documentos, checklist, indisponiveis, limitesRaw, jaEnviadosRaw] = await Promise.all([
    fbGet("/manutencao/push_subscriptions.json"),
    config.categorias.documentos ? fbGet("/manutencao/documentos.json") : null,
    config.categorias.checklist ? fbGet("/manutencao/checklist.json") : null,
    config.categorias.indisponiveis ? fbGet("/manutencao/indisponiveis.json") : null,
    fbGet("/manutencao/config_checklist.json"),
    fbGet("/manutencao/alertas_enviados.json"),
  ]);

  // ⚠️ checklist.json e indisponiveis.json passaram a ser gravados como
  // OBJETO indexado por chave (não mais array cru) depois da correção do
  // bug de "formato antigo". Um Array.isArray(...) aqui sempre dava falso
  // pra esse formato novo, e os avisos de Checklist/Indisponíveis paravam
  // de disparar silenciosamente. paraArray() aceita os dois formatos.
  function paraArray(v: any): any[] {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.values(v);
    return [];
  }

  const limites =
    limitesRaw && limitesRaw.amarelo && limitesRaw.vermelho
      ? limitesRaw
      : { amarelo: 10, vermelho: 15 };
  const jaEnviados: Record<string, string> = jaEnviadosRaw || {};
  const novosRegistros: Record<string, string> = {};
  const avisos: string[] = [];
  const agoraISO = new Date().toISOString();

  function marcarSeNovo(chave: string, texto: string) {
    novosRegistros[chave] = agoraISO;
    if (jaEnviados[chave]) return; // esse marco específico já foi avisado antes — não repete
    avisos.push(texto);
  }

  // 1) Documentos — vence em até N dias (configurável), ou já venceu
  if (config.categorias.documentos && documentos && typeof documentos === "object") {
    for (const doc of Object.values<any>(documentos)) {
      if (!doc || !doc.vencimento || !doc.placa) continue;
      const diasPassados = diasDesde(doc.vencimento);
      if (diasPassados === null) continue;
      const diasRestantes = -diasPassados;
      const tipo = String(doc.tipo || "").toUpperCase();
      if (diasPassados > 0) {
        marcarSeNovo(`doc_${doc.placa}_${doc.tipo}_vencido`, `📄 ${tipo} de ${doc.placa} venceu`);
      } else if (diasRestantes <= config.dias_antecedencia_docs) {
        marcarSeNovo(
          `doc_${doc.placa}_${doc.tipo}_aviso`,
          `📄 ${tipo} de ${doc.placa} vence em ${diasRestantes}d`
        );
      }
    }
  }

  // 2) Checklist preventiva em atraso (mesmos limites configurados no app)
  const checklistArr = paraArray(checklist);
  let houveAvisoChecklist = false;
  if (config.categorias.checklist) {
    for (const c of checklistArr) {
      if (!c || !c.ult_prev) continue;
      const partes = String(c.ult_prev).split("/");
      if (partes.length !== 3) continue;
      const [d, m, a] = partes.map((x: string) => parseInt(x, 10));
      if (!d || !m || !a) continue;
      const dt = new Date(a, m - 1, d);
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const dias = Math.floor((hoje.getTime() - dt.getTime()) / 86400000);
      c.dias = dias; // guarda pra reaproveitar na geração do PDF, sem reprocessar a data
      const placaRef = c.cavalo || c.reboque || "?";
      if (dias >= limites.vermelho) {
        marcarSeNovo(`chk_${c.cavalo}_${c.reboque}_vermelho`, `📋 Checklist de ${placaRef} atrasado (${dias}d)`);
        houveAvisoChecklist = true;
      } else if (dias >= limites.amarelo) {
        marcarSeNovo(`chk_${c.cavalo}_${c.reboque}_amarelo`, `📋 Checklist de ${placaRef} próximo do prazo (${dias}d)`);
        houveAvisoChecklist = true;
      }
    }
  }

  // 3) Indisponíveis há mais de N horas (configurável) e ainda sem saída
  if (config.categorias.indisponiveis) {
    for (const r of paraArray(indisponiveis)) {
      if (!r || r.saida || !r.entrada || !r.id) continue;
      const horas = (Date.now() - new Date(r.entrada).getTime()) / 3600000;
      if (horas < config.horas_indisponivel) continue;
      marcarSeNovo(`indisp_${r.id}`, `🚧 ${r.placa || "veículo"} indisponível há ${Math.floor(horas)}h`);
    }
  }

  // Salva os marcos vistos nesta rodada — na próxima execução, os que já
  // foram avisados não geram notificação de novo (só quando o "marco"
  // muda, ex: de amarelo pra vermelho, ou quando o registro é resolvido
  // e reaparece futuramente como um marco novo).
  await fbPut("/manutencao/alertas_enviados.json", { ...jaEnviados, ...novosRegistros });

  if (avisos.length === 0) {
    return new Response(JSON.stringify({ ok: true, avisos: 0, motivo: "nada novo para avisar" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const titulo = avisos.length === 1 ? "🔧 Controle de Manutenção" : `🔧 ${avisos.length} avisos de manutenção`;

  // ── PDF do Checklist, um por programador, só quando há aviso de
  // checklist nesta rodada (evita gerar/anexar PDF à toa em rodadas que
  // só têm aviso de documento ou de indisponível, por exemplo) ──
  const anexosPdf: { filename: string; content: string }[] = [];
  if (config.email_ativo && houveAvisoChecklist && checklistArr.length) {
    const porProgramador = new Map<string, any[]>();
    for (const c of checklistArr) {
      if (!c || !c.programador) continue;
      if (!porProgramador.has(c.programador)) porProgramador.set(c.programador, []);
      porProgramador.get(c.programador)!.push(c);
    }
    for (const [programador, linhas] of porProgramador) {
      try {
        const pdfBuffer = gerarPdfChecklistProgramador(programador, linhas);
        anexosPdf.push({
          filename: `Checklist_Preventiva_-_${programador.replace(/[^\w-]/g, "_")}.pdf`,
          content: _arrayBufferParaBase64(pdfBuffer),
        });
      } catch (e) {
        console.error("Falha ao gerar PDF do checklist para", programador, e);
      }
    }
  }

  // ── E-mail: independe de ter algum aparelho com push inscrito ──
  const emailsEnviados = config.email_ativo
    ? await enviarEmailResend(config.emails, titulo, avisos, anexosPdf)
    : 0;

  // ── Push: só se houver algum aparelho inscrito ──
  if (!subs || typeof subs !== "object" || Object.keys(subs).length === 0) {
    return new Response(
      JSON.stringify({ ok: true, avisos: avisos.length, motivo: "nenhum aparelho inscrito", emails_enviados: emailsEnviados, pdfs_anexados: anexosPdf.length }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const corpo = avisos.slice(0, 3).join(" · ") + (avisos.length > 3 ? ` · +${avisos.length - 3}` : "");
  const payload = JSON.stringify({ title: titulo, body: corpo });

  let enviadosOk = 0;
  for (const [deviceId, sub] of Object.entries<any>(subs)) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      enviadosOk++;
    } catch (e: any) {
      if (e && (e.statusCode === 410 || e.statusCode === 404)) {
        // Inscrição expirada/inválida (usuário desinstalou, trocou de
        // navegador, etc.) — remove pra parar de tentar enviar pra ela.
        await fbDelete(`/manutencao/push_subscriptions/${deviceId}.json`);
      } else {
        console.error("Falha ao enviar push para", deviceId, e?.message || e);
      }
    }
  }

  return new Response(
    JSON.stringify({ ok: true, avisos: avisos.length, dispositivos_notificados: enviadosOk, emails_enviados: emailsEnviados, pdfs_anexados: anexosPdf.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});
