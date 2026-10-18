const newrelic = require("newrelic");
const Execucao = require("../domain/execucao");
const { NaoEncontradoError, ConflitoError, TransicaoInvalidaError } = require("../domain/errors");
const EventTypes = require("./events/eventTypes");
const { criarEvento } = require("./events/eventFactory");

const { STATUS } = Execucao;

const RESULTADO = Object.freeze({ CRIADA: "criada", DUPLICADO: "duplicado", JA_EXISTE: "ja_existe" });

function eventoDaEtapa(execucao, statusAnterior) {
  const opcoes = { correlationId: execucao.osId };
  const base = { osId: execucao.osId, execucaoId: execucao.id };

  if (execucao.status === STATUS.FINALIZADA) {
    return criarEvento(
      EventTypes.EXECUCAO_FINALIZADA,
      {
        ...base,
        tecnico: execucao.tecnico,
        tempoTrabalhoMinutos: Execucao.tempoDeTrabalho(execucao.timeline),
        tempoPorEtapaMinutos: Execucao.tempoPorEtapa(execucao.timeline)
      },
      opcoes
    );
  }

  if (execucao.status === STATUS.FALHOU) {
    return criarEvento(
      EventTypes.EXECUCAO_FALHOU,
      { ...base, statusAnterior, motivo: execucao.motivoFalha, tecnico: execucao.tecnico },
      opcoes
    );
  }

  return criarEvento(
    EventTypes.EXECUCAO_STATUS_ATUALIZADO,
    { ...base, status: execucao.status, statusAnterior, tecnico: execucao.tecnico },
    opcoes
  );
}

/** pagamento.confirmado → item NA_FILA (com timeline) + execucao.status_atualizado. */
class CriarExecucao {
  constructor({ execucaoRepository, outboxRepository, processedEventsRepository, unitOfWork }) {
    this.execucaoRepository = execucaoRepository;
    this.outboxRepository = outboxRepository;
    this.processedEventsRepository = processedEventsRepository;
    this.unitOfWork = unitOfWork;
  }

  async execute(evento) {
    const p = evento.payload || {};
    const osId = Number(p.osId ?? evento.correlationId);

    return this.unitOfWork.run(async (session) => {
      const novo = await this.processedEventsRepository.registrar(evento.eventId, evento.type, session);
      if (!novo) return { resultado: RESULTADO.DUPLICADO };

      const existente = await this.execucaoRepository.buscarPorOsId(osId, session);
      if (existente) return { resultado: RESULTADO.JA_EXISTE, execucao: existente };

      const execucao = await this.execucaoRepository.criar(
        {
          osId,
          orcamentoId: p.orcamentoId,
          pagamentoId: p.pagamentoId,
          prioridade: p.prioridade && Number.isInteger(Number(p.prioridade)) ? Execucao.validarPrioridade(p.prioridade) : 3,
          status: STATUS.NA_FILA,
          servicos: (p.servicos || []).map((s) => ({ servicoId: s.servicoId, nome: s.nome, quantidade: s.quantidade })),
          pecas: (p.pecas || []).map((x) => ({ pecaId: x.pecaId, nome: x.nome, quantidade: x.quantidade })),
          timeline: [{ status: STATUS.NA_FILA, em: new Date(evento.occurredAt), por: "sistema", observacao: "Pagamento confirmado" }]
        },
        session
      );

      await this.outboxRepository.adicionar(
        { ...eventoDaEtapa(execucao, null), causationId: evento.eventId },
        session
      );

      return { resultado: RESULTADO.CRIADA, execucao };
    });
  }
}

/**
 * Avança a execução de etapa (diagnóstico, reparo, finalização ou falha) e
 * publica o evento correspondente na mesma transação.
 */
class AvancarExecucao {
  constructor({ execucaoRepository, outboxRepository, unitOfWork }) {
    this.execucaoRepository = execucaoRepository;
    this.outboxRepository = outboxRepository;
    this.unitOfWork = unitOfWork;
  }

  async execute(id, para, { tecnico = null, observacao = null, motivo = null, usuario = null } = {}) {
    if (para === STATUS.FALHOU && !motivo) {
      throw new TransicaoInvalidaError("Informe o motivo da falha");
    }

    const resultado = await this.unitOfWork.run(async (session) => {
      const atual = await this.execucaoRepository.buscarPorId(id, session);
      if (!atual) throw new NaoEncontradoError(`Execução ${id} não encontrada`);

      Execucao.assertTransicao(atual.status, para);

      const responsavel = tecnico || atual.tecnico;
      const campos = {};
      if (tecnico) campos.tecnico = tecnico;
      if (para === STATUS.FALHOU) campos.motivoFalha = motivo;

      const execucao = await this.execucaoRepository.transicionar(
        id,
        atual.status,
        {
          status: para,
          campos,
          entradaTimeline: {
            status: para,
            em: new Date(),
            por: responsavel || (usuario != null ? `usuario:${usuario}` : "sistema"),
            observacao: para === STATUS.FALHOU ? motivo : observacao
          }
        },
        session
      );

      if (!execucao) throw new ConflitoError(`A execução ${id} foi alterada por outra requisição; tente novamente`);

      await this.outboxRepository.adicionar(eventoDaEtapa(execucao, atual.status), session);
      return { execucao, de: atual.status };
    });

    newrelic.recordCustomEvent("SagaEtapa", {
      osId: String(resultado.execucao.osId),
      evento: `execucao.${para.toLowerCase()}`,
      servico: "execution-service",
      statusAnterior: resultado.de,
      duracaoMinutos: Execucao.tempoPorEtapa(resultado.execucao.timeline)[resultado.de] ?? 0
    });

    return resultado.execucao;
  }
}

class AlterarPrioridade {
  constructor({ execucaoRepository }) {
    this.execucaoRepository = execucaoRepository;
  }

  async execute(id, prioridade) {
    const valor = Execucao.validarPrioridade(prioridade);
    const execucao = await this.execucaoRepository.buscarPorId(id);
    if (!execucao) throw new NaoEncontradoError(`Execução ${id} não encontrada`);
    if (!Execucao.STATUS_ATIVOS.includes(execucao.status)) {
      throw new TransicaoInvalidaError(`Execução ${execucao.status} não está mais na fila`);
    }
    return this.execucaoRepository.atualizarPrioridade(id, valor);
  }
}

class ConsultarExecucoes {
  constructor({ execucaoRepository }) {
    this.execucaoRepository = execucaoRepository;
  }

  comTempos(execucao) {
    return { ...execucao, tempoPorEtapaMinutos: Execucao.tempoPorEtapa(execucao.timeline) };
  }

  async fila(status) {
    const statuses = status ? [status] : Execucao.STATUS_ATIVOS;
    const invalidos = statuses.filter((s) => !Object.values(STATUS).includes(s));
    if (invalidos.length) throw new TransicaoInvalidaError(`Status inválido: ${invalidos.join(", ")}`);

    return (await this.execucaoRepository.listarFila(statuses)).map((e) => this.comTempos(e));
  }

  async porId(id) {
    const execucao = await this.execucaoRepository.buscarPorId(id);
    if (!execucao) throw new NaoEncontradoError(`Execução ${id} não encontrada`);
    return this.comTempos(execucao);
  }

  async porOs(osId) {
    const execucao = await this.execucaoRepository.buscarPorOsId(osId);
    if (!execucao) throw new NaoEncontradoError(`Nenhuma execução para a OS ${osId}`);
    return this.comTempos(execucao);
  }

  async metricas() {
    return Execucao.calcularMetricas(await this.execucaoRepository.listarFinalizadas());
  }
}

module.exports = { CriarExecucao, AvancarExecucao, AlterarPrioridade, ConsultarExecucoes, RESULTADO, eventoDaEtapa };
