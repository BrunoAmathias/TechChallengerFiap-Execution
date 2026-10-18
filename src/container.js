/**
 * Composition root do Execution Service.
 */
const execucaoRepository = require("./infrastructure/repositories/execucao.repository");
const outboxRepository = require("./infrastructure/repositories/outbox.repository");
const processedEventsRepository = require("./infrastructure/repositories/processedEvents.repository");
const unitOfWork = require("./infrastructure/database/unitOfWork");
const { CriarExecucao, AvancarExecucao, AlterarPrioridade, ConsultarExecucoes } = require("./application/execucao.service");
const { criarHandlers } = require("./application/handlers");

const deps = { execucaoRepository, outboxRepository, processedEventsRepository, unitOfWork };

const useCases = {
  criarExecucao: new CriarExecucao(deps),
  avancarExecucao: new AvancarExecucao(deps),
  alterarPrioridade: new AlterarPrioridade(deps),
  consultar: new ConsultarExecucoes(deps)
};

const handlers = criarHandlers(useCases);

module.exports = { useCases, handlers, repositories: { outboxRepository } };
