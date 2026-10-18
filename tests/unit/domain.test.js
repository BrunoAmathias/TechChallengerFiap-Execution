const Execucao = require('../../src/domain/execucao');
const { TransicaoInvalidaError } = require('../../src/domain/errors');

const t = (minutos) => new Date(Date.UTC(2026, 9, 14, 8, 0) + minutos * 60000);

describe('Execucao - máquina de estados', () => {
  it('segue NA_FILA → EM_DIAGNOSTICO → EM_REPARO → FINALIZADA', () => {
    expect(Execucao.podeTransicionar('NA_FILA', 'EM_DIAGNOSTICO')).toBe(true);
    expect(Execucao.podeTransicionar('EM_DIAGNOSTICO', 'EM_REPARO')).toBe(true);
    expect(Execucao.podeTransicionar('EM_REPARO', 'FINALIZADA')).toBe(true);
    expect(Execucao.podeTransicionar('NA_FILA', 'EM_REPARO')).toBe(false);
    expect(Execucao.podeTransicionar('NA_FILA', 'FINALIZADA')).toBe(false);
  });

  it('permite FALHOU em qualquer etapa ativa e nada depois de encerrada', () => {
    Execucao.STATUS_ATIVOS.forEach((s) => expect(Execucao.podeTransicionar(s, 'FALHOU')).toBe(true));
    expect(Execucao.podeTransicionar('FINALIZADA', 'FALHOU')).toBe(false);
    expect(Execucao.podeTransicionar('FALHOU', 'EM_REPARO')).toBe(false);
    expect(Execucao.podeTransicionar('INEXISTENTE', 'EM_REPARO')).toBe(false);
    expect(() => Execucao.assertTransicao('FINALIZADA', 'EM_REPARO')).toThrow(TransicaoInvalidaError);
  });

  it('valida a prioridade (1 a 5)', () => {
    expect(Execucao.validarPrioridade('2')).toBe(2);
    [0, 6, 2.5, 'alta', undefined].forEach((p) => expect(() => Execucao.validarPrioridade(p)).toThrow(TransicaoInvalidaError));
    expect(Execucao.STATUS.NA_FILA).toBe('NA_FILA');
  });
});

describe('Execucao - tempos a partir do timeline', () => {
  const timeline = [
    { status: 'NA_FILA', em: t(0) },
    { status: 'EM_DIAGNOSTICO', em: t(10) },
    { status: 'EM_REPARO', em: t(40) },
    { status: 'FINALIZADA', em: t(100) }
  ];

  it('calcula minutos por etapa (fora de ordem também)', () => {
    expect(Execucao.tempoPorEtapa([...timeline].reverse())).toEqual({ NA_FILA: 10, EM_DIAGNOSTICO: 30, EM_REPARO: 60 });
  });

  it('conta a etapa atual até agora', () => {
    expect(Execucao.tempoPorEtapa(timeline.slice(0, 2), t(25))).toEqual({ NA_FILA: 10, EM_DIAGNOSTICO: 15 });
    expect(Execucao.tempoPorEtapa()).toEqual({});
  });

  it('tempo de trabalho vai do diagnóstico à finalização', () => {
    expect(Execucao.tempoDeTrabalho(timeline)).toBe(90);
    expect(Execucao.tempoDeTrabalho(timeline.slice(0, 3))).toBeNull();
    expect(Execucao.tempoDeTrabalho()).toBeNull();
  });

  it('métricas: média por etapa e por serviço só das finalizadas', () => {
    const outra = [
      { status: 'NA_FILA', em: t(0) },
      { status: 'EM_DIAGNOSTICO', em: t(20) },
      { status: 'EM_REPARO', em: t(30) },
      { status: 'FINALIZADA', em: t(60) }
    ];
    const metricas = Execucao.calcularMetricas([
      { status: 'FINALIZADA', timeline, servicos: [{ servicoId: 1, nome: 'Troca de óleo' }, { servicoId: 2, nome: 'Alinhamento' }] },
      { status: 'FINALIZADA', timeline: outra, servicos: [{ servicoId: 1, nome: 'Troca de óleo' }] },
      { status: 'FINALIZADA', timeline: [{ status: 'NA_FILA', em: t(0) }, { status: 'FINALIZADA', em: t(5) }], servicos: [{ nome: 'Sem diagnóstico' }] },
      { status: 'EM_REPARO', timeline, servicos: [{ servicoId: 9, nome: 'Ainda em andamento' }] }
    ]);

    expect(metricas.totalFinalizadas).toBe(3);
    expect(metricas.tempoMedioPorEtapaMinutos).toEqual({ NA_FILA: 11.67, EM_DIAGNOSTICO: 13.33, EM_REPARO: 30 });
    expect(metricas.tempoMedioPorServico).toEqual([
      { servicoId: 1, nome: 'Troca de óleo', execucoes: 2, tempoMedioMinutos: 65 },
      { servicoId: 2, nome: 'Alinhamento', execucoes: 1, tempoMedioMinutos: 90 }
    ]);
  });

  it('métricas vazias sem execuções finalizadas', () => {
    expect(Execucao.calcularMetricas([])).toEqual({ totalFinalizadas: 0, tempoMedioPorEtapaMinutos: {}, tempoMedioPorServico: [] });
  });
});
