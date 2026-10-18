const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const database = require('../../src/infrastructure/database/connection');
const unitOfWork = require('../../src/infrastructure/database/unitOfWork');
const outboxRepository = require('../../src/infrastructure/repositories/outbox.repository');
const processedEventsRepository = require('../../src/infrastructure/repositories/processedEvents.repository');
const execucaoRepository = require('../../src/infrastructure/repositories/execucao.repository');
const { Execucao, OutboxEvent, ProcessedEvent } = require('../../src/infrastructure/database/models');
const { useCases, handlers } = require('../../src/container');
const { criarEvento } = require('../../src/application/events/eventFactory');

jest.setTimeout(120000);

let replSet;

function pagamentoConfirmado(osId) {
  return {
    ...criarEvento(
      'pagamento.confirmado',
      { osId, orcamentoId: 1, pagamentoId: 1, servicos: [{ servicoId: 1, nome: 'Troca de óleo', quantidade: 1 }], pecas: [] },
      { correlationId: osId }
    ),
    source: 'billing-service'
  };
}

beforeAll(async () => {
  // Transações do MongoDB exigem replica set (o Atlas M0 já é um)
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await database.conectar(replSet.getUri('execution_db'));
  await Promise.all([Execucao.init(), OutboxEvent.init(), ProcessedEvent.init()]);
});

afterAll(async () => {
  await database.desconectar();
  await replSet?.stop();
});

beforeEach(async () => {
  await Promise.all([Execucao.deleteMany({}), OutboxEvent.deleteMany({}), ProcessedEvent.deleteMany({})]);
});

describe('Execution Service (integração com MongoDB replica set)', () => {
  it('pagamento.confirmado cria a execução e o evento no outbox na mesma transação, uma única vez', async () => {
    const e = pagamentoConfirmado(42);

    expect((await handlers['pagamento.confirmado'](e)).resultado).toBe('criada');
    expect((await handlers['pagamento.confirmado'](e)).resultado).toBe('duplicado');
    expect((await handlers['pagamento.confirmado'](pagamentoConfirmado(42))).resultado).toBe('ja_existe');

    expect(await Execucao.countDocuments()).toBe(1);
    const outbox = await OutboxEvent.find().lean();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ type: 'execucao.status_atualizado', aggregateId: '42', publishedAt: null });
  });

  it('fluxo de etapas com timeline e métricas', async () => {
    await handlers['pagamento.confirmado'](pagamentoConfirmado(7));
    const { id } = await execucaoRepository.buscarPorOsId(7);

    await useCases.avancarExecucao.execute(id, 'EM_DIAGNOSTICO', { tecnico: 'Ana' });
    await useCases.avancarExecucao.execute(id, 'EM_REPARO');
    await useCases.avancarExecucao.execute(id, 'FINALIZADA');

    const execucao = await useCases.consultar.porId(id);
    expect(execucao.status).toBe('FINALIZADA');
    expect(execucao.timeline.map((t) => t.status)).toEqual(['NA_FILA', 'EM_DIAGNOSTICO', 'EM_REPARO', 'FINALIZADA']);
    expect(execucao.timeline[1].por).toBe('Ana');

    const tipos = (await OutboxEvent.find().sort({ createdAt: 1 }).lean()).map((o) => o.type);
    expect(tipos).toEqual(['execucao.status_atualizado', 'execucao.status_atualizado', 'execucao.status_atualizado', 'execucao.finalizada']);

    const metricas = await useCases.consultar.metricas();
    expect(metricas.totalFinalizadas).toBe(1);
    expect(metricas.tempoMedioPorServico[0]).toMatchObject({ servicoId: 1, execucoes: 1 });
  });

  it('desfaz a transação inteira quando algo falha no meio (nem execução nem outbox nem processed_events)', async () => {
    const e = pagamentoConfirmado(9);
    const original = outboxRepository.adicionar;
    outboxRepository.adicionar = jest.fn().mockRejectedValue(new Error('falha simulada'));

    await expect(handlers['pagamento.confirmado'](e)).rejects.toThrow('falha simulada');
    outboxRepository.adicionar = original;

    expect(await Execucao.countDocuments()).toBe(0);
    expect(await ProcessedEvent.countDocuments()).toBe(0);

    // a nova tentativa (retry do consumer) processa normalmente
    expect((await handlers['pagamento.confirmado'](e)).resultado).toBe('criada');
  });

  it('controle de concorrência: a mesma etapa não é aplicada duas vezes', async () => {
    await handlers['pagamento.confirmado'](pagamentoConfirmado(11));
    const { id } = await execucaoRepository.buscarPorOsId(11);

    const resultados = await Promise.allSettled([
      useCases.avancarExecucao.execute(id, 'EM_DIAGNOSTICO', { tecnico: 'Ana' }),
      useCases.avancarExecucao.execute(id, 'EM_DIAGNOSTICO', { tecnico: 'Bia' })
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const execucao = await execucaoRepository.buscarPorId(id);
    expect(execucao.timeline.filter((t) => t.status === 'EM_DIAGNOSTICO')).toHaveLength(1);
    expect(await OutboxEvent.countDocuments({ type: 'execucao.status_atualizado' })).toBe(2);
  });

  it('fila ordenada por prioridade e chegada', async () => {
    await handlers['pagamento.confirmado'](pagamentoConfirmado(1));
    await handlers['pagamento.confirmado'](pagamentoConfirmado(2));
    await handlers['pagamento.confirmado'](pagamentoConfirmado(3));
    const urgente = await execucaoRepository.buscarPorOsId(3);
    await useCases.alterarPrioridade.execute(urgente.id, 1);

    expect((await useCases.consultar.fila()).map((e) => e.osId)).toEqual([3, 1, 2]);
  });

  it('outbox: reivindicação exclusiva, publicação e falha', async () => {
    await handlers['pagamento.confirmado'](pagamentoConfirmado(20));
    await handlers['pagamento.confirmado'](pagamentoConfirmado(21));

    const primeiro = await outboxRepository.reivindicarProximo(30000);
    const segundo = await outboxRepository.reivindicarProximo(30000);
    const terceiro = await outboxRepository.reivindicarProximo(30000);

    expect(primeiro.payload.payload.osId).toBe(20);
    expect(segundo.payload.payload.osId).toBe(21);
    expect(terceiro).toBeNull();

    await outboxRepository.marcarPublicado(primeiro._id);
    await outboxRepository.registrarFalha(segundo._id, 'broker fora');

    expect(await outboxRepository.contarPendentes()).toBe(1);
    const falhou = await OutboxEvent.findById(segundo._id).lean();
    expect(falhou).toMatchObject({ attempts: 1, lastError: 'broker fora', lockedUntil: null });
    expect((await outboxRepository.reivindicarProximo(30000))._id).toBe(segundo._id);
  });

  it('processed_events: chave única por eventId e eventId obrigatório', async () => {
    expect(await processedEventsRepository.registrar('evt-1', 'x')).toBe(true);
    expect(await processedEventsRepository.registrar('evt-1', 'x')).toBe(false);
    await expect(processedEventsRepository.registrar(undefined, 'x')).rejects.toThrow('eventId é obrigatório');
  });

  it('evento duplicado dentro de uma transação não aborta nem trava a transação', async () => {
    const e = pagamentoConfirmado(30);
    await handlers['pagamento.confirmado'](e);

    const inicio = Date.now();
    const resultado = await handlers['pagamento.confirmado'](e);

    expect(resultado.resultado).toBe('duplicado');
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it('health: conectado e ping', async () => {
    expect(database.isConectado()).toBe(true);
    await expect(database.ping()).resolves.toBeUndefined();
    await expect(database.conectar('')).rejects.toThrow('MONGO_URL');
    expect(mongoose.connection.name).toBe('execution_db');
  });

  it('unitOfWork devolve o resultado da transação', async () => {
    expect(await unitOfWork.run(async () => 'ok')).toBe('ok');
  });
});
