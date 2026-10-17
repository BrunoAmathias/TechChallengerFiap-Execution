const { ProcessedEvent } = require("../database/models");

class ProcessedEventsRepository {
  /**
   * Registra o eventId (chave única = _id). Retorna false se ele já foi
   * processado (mensagem duplicada).
   *
   * Usa upsert com $setOnInsert em vez de insert + captura do erro 11000:
   * no MongoDB, um erro de chave duplicada aborta a transação inteira, e o
   * withTransaction ficaria repetindo o callback por até 120 s.
   */
  async registrar(eventId, type, session = null) {
    if (!eventId) throw new Error("eventId é obrigatório para registrar o evento processado");

    const resultado = await ProcessedEvent.updateOne(
      { _id: eventId },
      { $setOnInsert: { type, processedAt: new Date() } },
      { upsert: true, session }
    );
    return resultado.upsertedCount === 1;
  }
}

module.exports = new ProcessedEventsRepository();
