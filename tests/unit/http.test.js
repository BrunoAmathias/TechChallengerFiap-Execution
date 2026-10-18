process.env.JWT_SECRET = 'jwt-teste';

jest.mock('../../src/container', () => ({
  useCases: {
    consultar: { fila: jest.fn(), metricas: jest.fn(), porId: jest.fn(), porOs: jest.fn() },
    avancarExecucao: { execute: jest.fn() },
    alterarPrioridade: { execute: jest.fn() }
  }
}));
jest.mock('../../src/infrastructure/database/connection', () => ({ ping: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/server');
const { useCases } = require('../../src/container');
const database = require('../../src/infrastructure/database/connection');
const { TransicaoInvalidaError, NaoEncontradoError, ConflitoError } = require('../../src/domain/errors');

const auth = { Authorization: `Bearer ${jwt.sign({ id: 5 }, 'jwt-teste')}` };

beforeEach(() => jest.clearAllMocks());

describe('Execuções (HTTP)', () => {
  it('exige JWT', async () => {
    expect((await request(app).get('/execucoes/fila')).status).toBe(401);
  });

  it('GET /execucoes/fila repassa o filtro de status', async () => {
    useCases.consultar.fila.mockResolvedValue([{ id: 'a', osId: 1 }]);

    const res = await request(app).get('/execucoes/fila?status=NA_FILA').set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(useCases.consultar.fila).toHaveBeenCalledWith('NA_FILA');
  });

  it('GET /execucoes/metricas, /:id e /os/:osId', async () => {
    useCases.consultar.metricas.mockResolvedValue({ totalFinalizadas: 2 });
    useCases.consultar.porId.mockResolvedValue({ id: 'a' });
    useCases.consultar.porOs.mockResolvedValue({ id: 'b' });

    expect((await request(app).get('/execucoes/metricas').set(auth)).body.totalFinalizadas).toBe(2);
    expect((await request(app).get('/execucoes/a').set(auth)).body.id).toBe('a');
    expect((await request(app).get('/execucoes/os/42').set(auth)).body.id).toBe('b');
    expect(useCases.consultar.porOs).toHaveBeenCalledWith('42');
  });

  it.each([
    ['diagnostico', 'EM_DIAGNOSTICO'],
    ['reparo', 'EM_REPARO'],
    ['finalizar', 'FINALIZADA'],
    ['falha', 'FALHOU']
  ])('PATCH /execucoes/:id/%s avança para %s', async (rota, status) => {
    useCases.avancarExecucao.execute.mockResolvedValue({ id: 'a', status });

    const res = await request(app).patch(`/execucoes/a/${rota}`).set(auth).send({ tecnico: 'Ana', motivo: 'm', observacao: 'o' });

    expect(res.status).toBe(200);
    expect(useCases.avancarExecucao.execute).toHaveBeenCalledWith('a', status, { tecnico: 'Ana', motivo: 'm', observacao: 'o', usuario: 5 });
  });

  it('PATCH /execucoes/:id/prioridade', async () => {
    useCases.alterarPrioridade.execute.mockResolvedValue({ id: 'a', prioridade: 1 });

    const res = await request(app).patch('/execucoes/a/prioridade').set(auth).send({ prioridade: 1 });

    expect(res.status).toBe(200);
    expect(useCases.alterarPrioridade.execute).toHaveBeenCalledWith('a', 1);
  });

  it.each([
    [new NaoEncontradoError('x'), 404],
    [new TransicaoInvalidaError('x'), 409],
    [new ConflitoError('x'), 409],
    [Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' }), 400],
    [new Error('inesperado'), 500]
  ])('mapeia %p para HTTP %i', async (erro, status) => {
    useCases.avancarExecucao.execute.mockRejectedValue(erro);
    useCases.consultar.porId.mockRejectedValue(erro);
    useCases.consultar.fila.mockRejectedValue(erro);
    useCases.consultar.metricas.mockRejectedValue(erro);
    useCases.consultar.porOs.mockRejectedValue(erro);
    useCases.alterarPrioridade.execute.mockRejectedValue(erro);

    expect((await request(app).patch('/execucoes/a/reparo').set(auth)).status).toBe(status);
    expect((await request(app).get('/execucoes/a').set(auth)).status).toBe(status);
    expect((await request(app).get('/execucoes/fila').set(auth)).status).toBe(status);
    expect((await request(app).get('/execucoes/metricas').set(auth)).status).toBe(status);
    expect((await request(app).get('/execucoes/os/1').set(auth)).status).toBe(status);
    expect((await request(app).patch('/execucoes/a/prioridade').set(auth)).status).toBe(status);
  });
});

describe('Health', () => {
  it('live, OK, DEGRADED e DOWN', async () => {
    expect((await request(app).get('/health/live')).status).toBe(200);

    database.ping.mockResolvedValue();
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'OK', checks: { database: 'UP', broker: 'DISABLED' } });

    app.locals.mensageria = { isConnected: () => false };
    expect((await request(app).get('/health')).body.status).toBe('DEGRADED');

    app.locals.mensageria = { isConnected: () => true };
    expect((await request(app).get('/health')).body.checks.broker).toBe('UP');

    database.ping.mockRejectedValue(new Error('down'));
    const down = await request(app).get('/health');
    expect(down.status).toBe(503);
    expect(down.body.status).toBe('DOWN');
    delete app.locals.mensageria;
  });
});
