const { OutboxEvent } = require("../database/models");

class OutboxRepository {
  /** Grava o evento (envelope completo) na mesma transação do negócio. */
  async adicionar(evento, session = null) {
    await OutboxEvent.create(
      [{ _id: evento.eventId, aggregateId: String(evento.correlationId), type: evento.type, payload: evento }],
      { session }
    );
  }

  /**
   * Reserva o próximo evento pendente por `lockMs` (findOneAndUpdate atômico),
   * para que réplicas diferentes não publiquem o mesmo evento ao mesmo tempo.
   */
  async reivindicarProximo(lockMs, agora = new Date()) {
    return OutboxEvent.findOneAndUpdate(
      {
        publishedAt: null,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: agora } }]
      },
      { $set: { lockedUntil: new Date(agora.getTime() + lockMs) } },
      { sort: { createdAt: 1 }, new: true }
    ).lean();
  }

  async marcarPublicado(id) {
    await OutboxEvent.updateOne({ _id: id }, { $set: { publishedAt: new Date(), lockedUntil: null } });
  }

  async registrarFalha(id, mensagem) {
    await OutboxEvent.updateOne(
      { _id: id },
      { $inc: { attempts: 1 }, $set: { lastError: String(mensagem).slice(0, 1000), lockedUntil: null } }
    );
  }

  async contarPendentes() {
    return OutboxEvent.countDocuments({ publishedAt: null });
  }
}

module.exports = new OutboxRepository();
