const { TransicaoInvalidaError } = require("./errors");

const STATUS_EXECUCAO = Object.freeze({
  NA_FILA: "NA_FILA",
  EM_DIAGNOSTICO: "EM_DIAGNOSTICO",
  EM_REPARO: "EM_REPARO",
  FINALIZADA: "FINALIZADA",
  FALHOU: "FALHOU"
});

/** NA_FILA → EM_DIAGNOSTICO → EM_REPARO → FINALIZADA; FALHOU de qualquer etapa ativa. */
const TRANSICOES = Object.freeze({
  NA_FILA: ["EM_DIAGNOSTICO", "FALHOU"],
  EM_DIAGNOSTICO: ["EM_REPARO", "FALHOU"],
  EM_REPARO: ["FINALIZADA", "FALHOU"],
  FINALIZADA: [],
  FALHOU: []
});

const STATUS_ATIVOS = [STATUS_EXECUCAO.NA_FILA, STATUS_EXECUCAO.EM_DIAGNOSTICO, STATUS_EXECUCAO.EM_REPARO];

const MINUTO = 60000;

function arredondar(valor) {
  return Math.round(valor * 100) / 100;
}

class Execucao {
  static get STATUS() {
    return STATUS_EXECUCAO;
  }

  static get STATUS_ATIVOS() {
    return [...STATUS_ATIVOS];
  }

  static podeTransicionar(de, para) {
    return (TRANSICOES[de] || []).includes(para);
  }

  static assertTransicao(de, para) {
    if (!this.podeTransicionar(de, para)) {
      throw new TransicaoInvalidaError(`Execução ${de} não pode ir para ${para}`);
    }
  }

  static validarPrioridade(prioridade) {
    const valor = Number(prioridade);
    if (!Number.isInteger(valor) || valor < 1 || valor > 5) {
      throw new TransicaoInvalidaError("Prioridade deve ser um inteiro de 1 (mais urgente) a 5");
    }
    return valor;
  }

  /**
   * Minutos gastos em cada etapa, a partir do timeline. A etapa atual (se a
   * execução ainda está ativa) conta até `agora`.
   */
  static tempoPorEtapa(timeline = [], agora = new Date()) {
    const ordenado = [...timeline].sort((a, b) => new Date(a.em) - new Date(b.em));
    const tempos = {};

    ordenado.forEach((entrada, i) => {
      if (!STATUS_ATIVOS.includes(entrada.status)) return;
      const fim = ordenado[i + 1] ? new Date(ordenado[i + 1].em) : new Date(agora);
      const minutos = Math.max(0, (fim - new Date(entrada.em)) / MINUTO);
      tempos[entrada.status] = arredondar((tempos[entrada.status] || 0) + minutos);
    });

    return tempos;
  }

  /** Tempo de trabalho na oficina: do início do diagnóstico até a finalização. */
  static tempoDeTrabalho(timeline = []) {
    const inicio = timeline.find((t) => t.status === STATUS_EXECUCAO.EM_DIAGNOSTICO);
    const fim = timeline.find((t) => t.status === STATUS_EXECUCAO.FINALIZADA);
    if (!inicio || !fim) return null;
    return arredondar(Math.max(0, (new Date(fim.em) - new Date(inicio.em)) / MINUTO));
  }

  /**
   * Métricas das execuções finalizadas: tempo médio por etapa e tempo médio de
   * trabalho por serviço (cada execução conta para todos os seus serviços).
   */
  static calcularMetricas(execucoes) {
    const finalizadas = execucoes.filter((e) => e.status === STATUS_EXECUCAO.FINALIZADA);
    const somaEtapas = {};
    const porServico = new Map();

    for (const execucao of finalizadas) {
      const etapas = this.tempoPorEtapa(execucao.timeline);
      for (const [status, minutos] of Object.entries(etapas)) {
        somaEtapas[status] = (somaEtapas[status] || 0) + minutos;
      }

      const trabalho = this.tempoDeTrabalho(execucao.timeline);
      if (trabalho == null) continue;

      for (const servico of execucao.servicos || []) {
        const chave = servico.servicoId ?? servico.nome;
        const atual = porServico.get(chave) || { servicoId: servico.servicoId, nome: servico.nome, execucoes: 0, totalMinutos: 0 };
        atual.execucoes += 1;
        atual.totalMinutos += trabalho;
        porServico.set(chave, atual);
      }
    }

    const tempoMedioPorEtapaMinutos = Object.fromEntries(
      Object.entries(somaEtapas).map(([status, total]) => [status, arredondar(total / finalizadas.length)])
    );

    const tempoMedioPorServico = [...porServico.values()]
      .map(({ totalMinutos, ...servico }) => ({ ...servico, tempoMedioMinutos: arredondar(totalMinutos / servico.execucoes) }))
      .sort((a, b) => b.execucoes - a.execucoes);

    return { totalFinalizadas: finalizadas.length, tempoMedioPorEtapaMinutos, tempoMedioPorServico };
  }
}

module.exports = Execucao;
module.exports.STATUS_EXECUCAO = STATUS_EXECUCAO;
