const path = require('node:path');
const { loadFeature, defineFeature } = require('jest-cucumber');
const { CriarExecucao, AvancarExecucao, AlterarPrioridade, ConsultarExecucoes } = require('../../src/application/execucao.service');
const { criarHandlers } = require('../../src/application/handlers');
const { criarEvento } = require('../../src/application/events/eventFactory');
const { TransicaoInvalidaError } = require('../../src/domain/errors');

const feature = loadFeature(path.join(__dirname, 'saga-execution.feature'));

/** Execution com "MongoDB" (execuções, outbox, processed_events) e broker em memória. */
function criarMundo() {
  const db = { execucoes: [], outbox: [], processados: new Set() };
  const copia = (e) => (e ? JSON.parse(JSON.stringify(e)) : null);
  let seq = 0;

  const execucaoRepository = {
    criar: async (dados) => {
      const nova = { ...dados, id: `exec-${++seq}`, tecnico: null, motivoFalha: null, createdAt: new Date(Date.now() + seq) };
      db.execucoes.push(nova);
      return copia(nova);
    },
    buscarPorId: async (id) => copia(db.execucoes.find((e) => e.id === id)),
    buscarPorOsId: async (osId) => copia(db.execucoes.find((e) => e.osId === Number(osId))),
    transicionar: async (id, de, { status, entradaTimeline, campos }) => {
      const e = db.execucoes.find((x) => x.id === id && x.status === de);
      if (!e) return null;
      Object.assign(e, { status, ...campos });
      e.timeline.push(entradaTimeline);
      return copia(e);
    },
    atualizarPrioridade: async (id, prioridade) => {
      const e = db.execucoes.find((x) => x.id === id);
      e.prioridade = prioridade;
      return copia(e);
    },
    listarFila: async (statuses) =>
      db.execucoes
        .filter((e) => statuses.includes(e.status))
        .sort((a, b) => a.prioridade - b.prioridade || new Date(a.createdAt) - new Date(b.createdAt))
        .map(copia),
    listarFinalizadas: async () => db.execucoes.filter((e) => e.status === 'FINALIZADA').map(copia)
  };

  const deps = {
    execucaoRepository,
    outboxRepository: { adicionar: async (e) => db.outbox.push(e) },
    processedEventsRepository: {
      registrar: async (id) => {
        if (db.processados.has(id)) return false;
        db.processados.add(id);
        return true;
      }
    },
    unitOfWork: { run: (fn) => fn({}) }
  };

  const useCases = {
    criarExecucao: new CriarExecucao(deps),
    avancar: new AvancarExecucao(deps),
    prioridade: new AlterarPrioridade(deps),
    consultar: new ConsultarExecucoes(deps)
  };
  const handlers = criarHandlers({ criarExecucao: useCases.criarExecucao });

  const mundo = {
    db,
    useCases,
    erro: null,
    pagamentoConfirmado: (osId, servico) =>
      handlers['pagamento.confirmado']({
        ...criarEvento(
          'pagamento.confirmado',
          { osId, orcamentoId: 1, pagamentoId: 1, servicos: [{ servicoId: 1, nome: servico, quantidade: 1 }], pecas: [] },
          { correlationId: osId }
        ),
        source: 'billing-service'
      }),
    execucao: (osId = 42) => db.execucoes.find((e) => e.osId === osId),
    eventos: (type) => db.outbox.filter((e) => e.type === type),
    avancar: (status, opcoes) => useCases.avancar.execute(mundo.execucao().id, status, opcoes)
  };
  return mundo;
}

defineFeature(feature, (test) => {
  let mundo;

  const contexto = (given) =>
    given(/^que o Billing publicou "pagamento.confirmado" para a OS (\d+) com o serviço "(.*)"$/, async (osId, servico) => {
      mundo = criarMundo();
      await mundo.pagamentoConfirmado(Number(osId), servico);
    });

  const execucaoFica = (step) => step(/^a execução (?:fica|continua|entra na fila como) "(.*)"$/, (status) => expect(mundo.execucao().status).toBe(status));
  const eventoComStatus = (step) =>
    step(/^o evento "(.*)" é publicado com status "(.*)"$/, (type, status) => {
      expect(mundo.eventos(type).some((e) => e.payload.status === status && e.payload.osId === 42 && e.source === 'execution-service')).toBe(true);
    });
  const diagnostico = (step) => step(/^o mecânico "(.*)" inicia o diagnóstico$/, (tecnico) => mundo.avancar('EM_DIAGNOSTICO', { tecnico }));

  test('Reparo concluído', ({ given, then, and, when }) => {
    contexto(given);
    execucaoFica(then);
    eventoComStatus(and);
    diagnostico(when);
    execucaoFica(then);
    eventoComStatus(and);
    when('o mecânico inicia o reparo', () => mundo.avancar('EM_REPARO', {}));
    execucaoFica(then);
    when('o mecânico finaliza a execução', () => mundo.avancar('FINALIZADA', { observacao: 'Tudo certo' }));
    execucaoFica(then);
    and(/^o evento "(.*)" é publicado$/, (type) => {
      expect(mundo.eventos(type)).toHaveLength(1);
      expect(mundo.eventos(type)[0].payload).toMatchObject({ osId: 42, tecnico: 'Ana' });
    });
    and(/^o timeline registra (\d+) etapas feitas por "(.*)" a partir do diagnóstico$/, (n, tecnico) => {
      const timeline = mundo.execucao().timeline;
      expect(timeline).toHaveLength(Number(n));
      expect(timeline.slice(1).every((t) => t.por === tecnico)).toBe(true);
    });
  });

  test('Falha no reparo dispara a compensação', ({ given, when, and, then }) => {
    contexto(given);
    diagnostico(when);
    and(/^o mecânico registra a falha "(.*)"$/, (motivo) => mundo.avancar('FALHOU', { motivo }));
    execucaoFica(then);
    and(/^o evento "(.*)" é publicado com o motivo "(.*)"$/, (type, motivo) => {
      expect(mundo.eventos(type)).toHaveLength(1);
      expect(mundo.eventos(type)[0].payload).toMatchObject({ osId: 42, motivo, statusAnterior: 'EM_DIAGNOSTICO' });
    });
  });

  test('Etapa fora de ordem é rejeitada', ({ given, when, then, and }) => {
    contexto(given);
    when('o mecânico tenta finalizar a execução que ainda está na fila', async () => {
      mundo.erro = await mundo.avancar('FINALIZADA', {}).catch((err) => err);
    });
    then('a operação é rejeitada como transição inválida', () => expect(mundo.erro).toBeInstanceOf(TransicaoInvalidaError));
    execucaoFica(and);
  });

  test('Fila ordenada por prioridade', ({ given, and, when, then }) => {
    contexto(given);
    and(/^que o Billing também publicou "pagamento.confirmado" para a OS (\d+)$/, (osId) => mundo.pagamentoConfirmado(Number(osId), 'Alinhamento'));
    when(/^a OS (\d+) recebe prioridade (\d+)$/, (osId, prioridade) => mundo.useCases.prioridade.execute(mundo.execucao(Number(osId)).id, Number(prioridade)));
    then(/^a fila mostra primeiro a OS (\d+) e depois a OS (\d+)$/, async (primeira, segunda) => {
      const fila = await mundo.useCases.consultar.fila();
      expect(fila.map((e) => e.osId)).toEqual([Number(primeira), Number(segunda)]);
    });
  });
});
