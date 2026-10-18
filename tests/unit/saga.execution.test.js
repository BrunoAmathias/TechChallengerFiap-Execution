const { CriarExecucao, AvancarExecucao, AlterarPrioridade, ConsultarExecucoes, RESULTADO } = require('../../src/application/execucao.service');
const { criarHandlers } = require('../../src/application/handlers');
const { criarEvento } = require('../../src/application/events/eventFactory');
const { NaoEncontradoError, TransicaoInvalidaError, ConflitoError } = require('../../src/domain/errors');

/** "MongoDB" em memória para os casos de uso. */
function montar() {
  const db = { execucoes: [], outbox: [], processados: new Set() };
  let seq = 0;
  const copia = (e) => (e ? JSON.parse(JSON.stringify(e)) : null);

  const execucaoRepository = {
    criar: jest.fn(async (dados) => {
      const nova = { ...dados, id: `exec-${++seq}`, tecnico: null, motivoFalha: null, createdAt: new Date() };
      db.execucoes.push(nova);
      return copia(nova);
    }),
    buscarPorId: jest.fn(async (id) => copia(db.execucoes.find((e) => e.id === id))),
    buscarPorOsId: jest.fn(async (osId) => copia(db.execucoes.find((e) => e.osId === Number(osId)))),
    transicionar: jest.fn(async (id, de, { status, entradaTimeline, campos }) => {
      const e = db.execucoes.find((x) => x.id === id && x.status === de);
      if (!e) return null;
      Object.assign(e, { status, ...campos });
      e.timeline.push(entradaTimeline);
      return copia(e);
    }),
    atualizarPrioridade: jest.fn(async (id, prioridade) => {
      const e = db.execucoes.find((x) => x.id === id);
      e.prioridade = prioridade;
      return copia(e);
    }),
    listarFila: jest.fn(async (statuses) =>
      db.execucoes.filter((e) => statuses.includes(e.status)).sort((a, b) => a.prioridade - b.prioridade).map(copia)
    ),
    listarFinalizadas: jest.fn(async () => db.execucoes.filter((e) => e.status === 'FINALIZADA').map(copia))
  };

  const deps = {
    execucaoRepository,
    outboxRepository: { adicionar: jest.fn(async (e) => db.outbox.push(e)) },
    processedEventsRepository: {
      registrar: jest.fn(async (id) => {
        if (db.processados.has(id)) return false;
        db.processados.add(id);
        return true;
      })
    },
    unitOfWork: { run: jest.fn((fn) => fn({ session: true })) }
  };

  const useCases = {
    criarExecucao: new CriarExecucao(deps),
    avancarExecucao: new AvancarExecucao(deps),
    alterarPrioridade: new AlterarPrioridade(deps),
    consultar: new ConsultarExecucoes(deps)
  };
  return { db, deps, useCases, handlers: criarHandlers(useCases) };
}

function pagamentoConfirmado(osId = 42, extra = {}) {
  return {
    ...criarEvento(
      'pagamento.confirmado',
      {
        osId,
        orcamentoId: 7,
        pagamentoId: 3,
        valor: 180,
        servicos: [{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1 }],
        pecas: [{ pecaId: 4, nome: 'Filtro', quantidade: 2 }],
        ...extra
      },
      { correlationId: osId }
    ),
    source: 'billing-service'
  };
}

describe('CriarExecucao (pagamento.confirmado)', () => {
  it('cria o item NA_FILA com timeline e publica execucao.status_atualizado', async () => {
    const { db, handlers } = montar();
    const e = pagamentoConfirmado();

    const r = await handlers['pagamento.confirmado'](e);

    expect(r.resultado).toBe(RESULTADO.CRIADA);
    expect(db.execucoes[0]).toMatchObject({
      osId: 42,
      orcamentoId: 7,
      pagamentoId: 3,
      prioridade: 3,
      status: 'NA_FILA',
      servicos: [{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1 }],
      pecas: [{ pecaId: 4, nome: 'Filtro', quantidade: 2 }]
    });
    expect(db.execucoes[0].timeline).toEqual([
      { status: 'NA_FILA', em: new Date(e.occurredAt), por: 'sistema', observacao: 'Pagamento confirmado' }
    ]);
    expect(db.outbox[0]).toMatchObject({
      type: 'execucao.status_atualizado',
      source: 'execution-service',
      correlationId: '42',
      causationId: e.eventId,
      payload: { osId: 42, execucaoId: 'exec-1', status: 'NA_FILA', statusAnterior: null }
    });
  });

  it('usa a prioridade do evento quando informada e ignora duplicados', async () => {
    const { db, handlers } = montar();
    const e = pagamentoConfirmado(42, { prioridade: 1 });

    await handlers['pagamento.confirmado'](e);
    expect((await handlers['pagamento.confirmado'](e)).resultado).toBe(RESULTADO.DUPLICADO);
    expect((await handlers['pagamento.confirmado'](pagamentoConfirmado(42))).resultado).toBe(RESULTADO.JA_EXISTE);

    expect(db.execucoes).toHaveLength(1);
    expect(db.execucoes[0].prioridade).toBe(1);
  });

  it('aceita evento sem itens nem osId no payload (usa o correlationId)', async () => {
    const { db, handlers } = montar();
    const e = { ...pagamentoConfirmado(), payload: {} };

    await handlers['pagamento.confirmado'](e);

    expect(db.execucoes[0]).toMatchObject({ osId: 42, servicos: [], pecas: [] });
  });
});

describe('AvancarExecucao', () => {
  async function comExecucao() {
    const ctx = montar();
    await ctx.handlers['pagamento.confirmado'](pagamentoConfirmado());
    ctx.db.outbox.length = 0;
    return ctx;
  }

  it('fluxo completo: diagnóstico → reparo → finalizar, com timeline e eventos', async () => {
    const { db, useCases } = await comExecucao();

    await useCases.avancarExecucao.execute('exec-1', 'EM_DIAGNOSTICO', { tecnico: 'Ana', observacao: 'Barulho no motor' });
    await useCases.avancarExecucao.execute('exec-1', 'EM_REPARO', {});
    const final = await useCases.avancarExecucao.execute('exec-1', 'FINALIZADA', { observacao: 'Ok' });

    expect(final).toMatchObject({ status: 'FINALIZADA', tecnico: 'Ana' });
    expect(final.timeline.map((x) => `${x.status}:${x.por}`)).toEqual(['NA_FILA:sistema', 'EM_DIAGNOSTICO:Ana', 'EM_REPARO:Ana', 'FINALIZADA:Ana']);
    expect(db.outbox.map((x) => [x.type, x.payload.status ?? null])).toEqual([
      ['execucao.status_atualizado', 'EM_DIAGNOSTICO'],
      ['execucao.status_atualizado', 'EM_REPARO'],
      ['execucao.finalizada', null]
    ]);
    expect(db.outbox[0].payload).toMatchObject({ statusAnterior: 'NA_FILA', tecnico: 'Ana' });
    expect(db.outbox[2].payload).toMatchObject({ osId: 42, execucaoId: 'exec-1', tecnico: 'Ana' });
    expect(db.outbox[2].payload.tempoTrabalhoMinutos).toBeGreaterThanOrEqual(0);
  });

  it('falha: exige motivo e publica execucao.falhou com o status anterior', async () => {
    const { db, useCases } = await comExecucao();

    await expect(useCases.avancarExecucao.execute('exec-1', 'FALHOU', {})).rejects.toThrow(/motivo/);

    const r = await useCases.avancarExecucao.execute('exec-1', 'FALHOU', { motivo: 'Peça indisponível', usuario: 7 });

    expect(r).toMatchObject({ status: 'FALHOU', motivoFalha: 'Peça indisponível' });
    expect(r.timeline.at(-1)).toMatchObject({ status: 'FALHOU', por: 'usuario:7', observacao: 'Peça indisponível' });
    expect(db.outbox[0]).toMatchObject({ type: 'execucao.falhou', payload: { osId: 42, statusAnterior: 'NA_FILA', motivo: 'Peça indisponível' } });
  });

  it('rejeita etapa fora de ordem, execução inexistente e alteração concorrente', async () => {
    const { db, deps, useCases } = await comExecucao();

    await expect(useCases.avancarExecucao.execute('exec-1', 'FINALIZADA')).rejects.toThrow(TransicaoInvalidaError);
    await expect(useCases.avancarExecucao.execute('nao-existe', 'EM_DIAGNOSTICO')).rejects.toThrow(NaoEncontradoError);

    deps.execucaoRepository.transicionar.mockResolvedValueOnce(null);
    await expect(useCases.avancarExecucao.execute('exec-1', 'EM_DIAGNOSTICO')).rejects.toThrow(ConflitoError);
    expect(db.outbox).toHaveLength(0);
  });

  it('sem técnico nem usuário, a entrada do timeline fica como sistema', async () => {
    const { useCases } = await comExecucao();
    const r = await useCases.avancarExecucao.execute('exec-1', 'EM_DIAGNOSTICO');
    expect(r.timeline.at(-1).por).toBe('sistema');
  });
});

describe('Prioridade e consultas', () => {
  it('altera a prioridade de execuções ativas', async () => {
    const { db, handlers, useCases } = montar();
    await handlers['pagamento.confirmado'](pagamentoConfirmado(1));
    await handlers['pagamento.confirmado'](pagamentoConfirmado(2));

    await useCases.alterarPrioridade.execute('exec-2', 1);
    const fila = await useCases.consultar.fila();

    expect(fila.map((e) => e.osId)).toEqual([2, 1]);
    expect(fila[0].tempoPorEtapaMinutos).toHaveProperty('NA_FILA');
    expect(db.execucoes[1].prioridade).toBe(1);
  });

  it('não altera prioridade inválida, de execução encerrada ou inexistente', async () => {
    const { handlers, useCases } = montar();
    await handlers['pagamento.confirmado'](pagamentoConfirmado());

    await expect(useCases.alterarPrioridade.execute('exec-1', 9)).rejects.toThrow(TransicaoInvalidaError);
    await expect(useCases.alterarPrioridade.execute('x', 2)).rejects.toThrow(NaoEncontradoError);

    await useCases.avancarExecucao.execute('exec-1', 'FALHOU', { motivo: 'x' });
    await expect(useCases.alterarPrioridade.execute('exec-1', 2)).rejects.toThrow(/não está mais na fila/);
  });

  it('consulta por id, por OS, fila por status e métricas', async () => {
    const { handlers, useCases } = montar();
    await handlers['pagamento.confirmado'](pagamentoConfirmado());
    await useCases.avancarExecucao.execute('exec-1', 'EM_DIAGNOSTICO');
    await useCases.avancarExecucao.execute('exec-1', 'EM_REPARO');
    await useCases.avancarExecucao.execute('exec-1', 'FINALIZADA');

    expect((await useCases.consultar.porId('exec-1')).status).toBe('FINALIZADA');
    expect((await useCases.consultar.porOs(42)).id).toBe('exec-1');
    expect(await useCases.consultar.fila('FINALIZADA')).toHaveLength(1);
    expect(await useCases.consultar.fila()).toHaveLength(0);
    expect((await useCases.consultar.metricas()).totalFinalizadas).toBe(1);

    await expect(useCases.consultar.fila('QUALQUER')).rejects.toThrow(/Status inválido/);
    await expect(useCases.consultar.porId('x')).rejects.toThrow(NaoEncontradoError);
    await expect(useCases.consultar.porOs(9)).rejects.toThrow(NaoEncontradoError);
  });
});
