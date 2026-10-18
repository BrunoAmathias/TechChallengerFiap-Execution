const defaultLogger = require("../logger");
const { EXCHANGE_EVENTS } = require("./topology");
const { cabecalhosDoEvento } = require("../observability/tracing");

/**
 * Transactional Outbox (MongoDB): faz polling da collection outbox, reserva
 * cada evento pendente e publica na exchange oficina.events com publisher
 * confirms. Só marca como publicado depois do ack do broker.
 */
class OutboxPublisher {
  constructor({ outboxRepository, getChannel, intervalMs = 1000, batchSize = 50, lockMs = 30000, logger = defaultLogger }) {
    this.outboxRepository = outboxRepository;
    this.getChannel = getChannel;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.lockMs = lockMs;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.publicarPendentes().catch((err) => this.logger.error({ err }, "Erro no polling do outbox"));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async publicarPendentes() {
    const channel = this.getChannel();
    if (!channel || this.running) return 0;

    this.running = true;
    let publicados = 0;
    try {
      while (publicados < this.batchSize) {
        const evento = await this.outboxRepository.reivindicarProximo(this.lockMs);
        if (!evento) break;

        try {
          await this.publicar(channel, evento.payload);
          await this.outboxRepository.marcarPublicado(evento._id);
          publicados += 1;
        } catch (err) {
          await this.outboxRepository.registrarFalha(evento._id, err.message);
          this.logger.error({ err, eventId: evento._id, eventType: evento.type }, "Falha ao publicar evento do outbox");
          break;
        }
      }
      return publicados;
    } finally {
      this.running = false;
    }
  }

  publicar(channel, evento) {
    return new Promise((resolve, reject) => {
      channel.publish(
        EXCHANGE_EVENTS,
        evento.type,
        Buffer.from(JSON.stringify(evento)),
        {
          persistent: true,
          contentType: "application/json",
          messageId: evento.eventId,
          correlationId: String(evento.correlationId),
          type: evento.type,
          timestamp: Math.floor(Date.parse(evento.occurredAt) / 1000),
          // contexto do trace de quem gerou o evento: o consumidor continua o mesmo trace
          headers: { source: evento.source, version: evento.version, ...cabecalhosDoEvento(evento) }
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }
}

module.exports = OutboxPublisher;
