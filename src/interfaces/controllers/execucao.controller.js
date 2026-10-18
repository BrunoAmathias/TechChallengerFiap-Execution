const { useCases } = require("../../container");
const { STATUS_EXECUCAO } = require("../../domain/execucao");
const { responderErro } = require("../httpErrors");

class ExecucaoController {
  async fila(req, res) {
    try {
      return res.status(200).json(await useCases.consultar.fila(req.query.status));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async metricas(req, res) {
    try {
      return res.status(200).json(await useCases.consultar.metricas());
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async buscarPorId(req, res) {
    try {
      return res.status(200).json(await useCases.consultar.porId(req.params.id));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async buscarPorOs(req, res) {
    try {
      return res.status(200).json(await useCases.consultar.porOs(req.params.osId));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  async alterarPrioridade(req, res) {
    try {
      return res.status(200).json(await useCases.alterarPrioridade.execute(req.params.id, req.body?.prioridade));
    } catch (err) {
      return responderErro(res, err);
    }
  }

  /** Fábrica dos endpoints de etapa: diagnostico, reparo, finalizar e falha. */
  avancarPara(status) {
    return async (req, res) => {
      try {
        const { tecnico, observacao, motivo } = req.body || {};
        const execucao = await useCases.avancarExecucao.execute(req.params.id, status, {
          tecnico,
          observacao,
          motivo,
          usuario: req.usuarioId
        });
        return res.status(200).json(execucao);
      } catch (err) {
        return responderErro(res, err);
      }
    };
  }
}

const controller = new ExecucaoController();
controller.diagnostico = controller.avancarPara(STATUS_EXECUCAO.EM_DIAGNOSTICO);
controller.reparo = controller.avancarPara(STATUS_EXECUCAO.EM_REPARO);
controller.finalizar = controller.avancarPara(STATUS_EXECUCAO.FINALIZADA);
controller.falha = controller.avancarPara(STATUS_EXECUCAO.FALHOU);

module.exports = controller;
