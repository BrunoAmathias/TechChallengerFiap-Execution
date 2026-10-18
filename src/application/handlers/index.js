const EventTypes = require("../events/eventTypes");

/**
 * Eventos consumidos pelo Execution Service (routing keys da fila
 * execution-service.events).
 */
function criarHandlers({ criarExecucao }) {
  return {
    [EventTypes.PAGAMENTO_CONFIRMADO]: (evento) => criarExecucao.execute(evento)
  };
}

module.exports = { criarHandlers };
