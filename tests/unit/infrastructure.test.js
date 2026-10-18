const { runWithCorrelationId, getCorrelationId } = require("../../src/infrastructure/logger");
const logger = require("../../src/infrastructure/logger");
const correlationIdMiddleware = require("../../src/interfaces/middlewares/correlationId.middleware");

describe('logger', () => {
  it('propaga o correlationId no contexto assíncrono', async () => {
    expect(getCorrelationId()).toBeUndefined();

    await runWithCorrelationId(42, async () => {
      await Promise.resolve();
      expect(getCorrelationId()).toBe('42');
    });

    expect(getCorrelationId()).toBeUndefined();
  });

  it('inclui o correlationId nas linhas de log', () => {
    const lines = [];
    const child = require('pino')(
      { mixin: () => ({ correlationId: getCorrelationId() }) },
      { write: (l) => lines.push(JSON.parse(l)) }
    );

    runWithCorrelationId('abc', () => child.info('teste'));

    expect(lines[0].correlationId).toBe('abc');
    expect(typeof logger.info).toBe('function');
  });
});

describe('correlationIdMiddleware', () => {
  function makeReqRes(headerValue) {
    const req = { get: jest.fn().mockReturnValue(headerValue) };
    const res = { set: jest.fn() };
    return { req, res };
  }

  it('reaproveita o header x-correlation-id recebido', () => {
    const { req, res } = makeReqRes('corr-1');
    let idNoContexto;

    correlationIdMiddleware(req, res, () => { idNoContexto = getCorrelationId(); });

    expect(req.correlationId).toBe('corr-1');
    expect(res.set).toHaveBeenCalledWith('x-correlation-id', 'corr-1');
    expect(idNoContexto).toBe('corr-1');
  });

  it('gera um UUID quando o header não vem', () => {
    const { req, res } = makeReqRes(undefined);

    correlationIdMiddleware(req, res, () => {});

    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
