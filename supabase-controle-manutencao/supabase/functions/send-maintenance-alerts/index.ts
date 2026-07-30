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

const FIREBASE_URL = Deno.env.get("FIREBASE_URL") ?? "https://controle-troca-oleo-default-rtdb.firebaseio.com";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:contato@example.com";

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
  if (config.categorias.checklist && Array.isArray(checklist)) {
    for (const c of checklist) {
      if (!c || !c.ult_prev) continue;
      const partes = String(c.ult_prev).split("/");
      if (partes.length !== 3) continue;
      const [d, m, a] = partes.map((x: string) => parseInt(x, 10));
      if (!d || !m || !a) continue;
      const dt = new Date(a, m - 1, d);
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const dias = Math.floor((hoje.getTime() - dt.getTime()) / 86400000);
      const placaRef = c.cavalo || c.reboque || "?";
      if (dias >= limites.vermelho) {
        marcarSeNovo(`chk_${c.cavalo}_${c.reboque}_vermelho`, `📋 Checklist de ${placaRef} atrasado (${dias}d)`);
      } else if (dias >= limites.amarelo) {
        marcarSeNovo(`chk_${c.cavalo}_${c.reboque}_amarelo`, `📋 Checklist de ${placaRef} próximo do prazo (${dias}d)`);
      }
    }
  }

  // 3) Indisponíveis há mais de N horas (configurável) e ainda sem saída
  if (config.categorias.indisponiveis && Array.isArray(indisponiveis)) {
    for (const r of indisponiveis) {
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
  if (!subs || typeof subs !== "object" || Object.keys(subs).length === 0) {
    return new Response(JSON.stringify({ ok: true, avisos: avisos.length, motivo: "nenhum aparelho inscrito" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const titulo = avisos.length === 1 ? "🔧 Controle de Manutenção" : `🔧 ${avisos.length} avisos de manutenção`;
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
    JSON.stringify({ ok: true, avisos: avisos.length, dispositivos_notificados: enviadosOk }),
    { headers: { "Content-Type": "application/json" } }
  );
});
