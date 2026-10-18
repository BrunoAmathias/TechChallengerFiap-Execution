const mongoose = require("mongoose");
const { STATUS_EXECUCAO } = require("../../domain/execucao");

const { Schema } = mongoose;

/**
 * Documento da execução com o timeline embutido: cada mudança de etapa vira
 * uma entrada (quem fez, quando), e as métricas saem direto daí.
 */
const timelineSchema = new Schema(
  {
    status: { type: String, enum: Object.values(STATUS_EXECUCAO), required: true },
    em: { type: Date, required: true },
    por: { type: String, default: "sistema" },
    observacao: { type: String, default: null }
  },
  { _id: false }
);

const itemSchema = new Schema(
  {
    servicoId: Number,
    pecaId: Number,
    nome: String,
    quantidade: { type: Number, default: 1 }
  },
  { _id: false }
);

const execucaoSchema = new Schema(
  {
    osId: { type: Number, required: true, unique: true },
    orcamentoId: Number,
    pagamentoId: Number,
    prioridade: { type: Number, min: 1, max: 5, default: 3 },
    status: { type: String, enum: Object.values(STATUS_EXECUCAO), required: true },
    tecnico: { type: String, default: null },
    motivoFalha: { type: String, default: null },
    servicos: [itemSchema],
    pecas: [itemSchema],
    timeline: [timelineSchema]
  },
  { collection: "execucoes", timestamps: true, versionKey: false }
);

// Fila: ativos por prioridade (1 = mais urgente) e ordem de chegada
execucaoSchema.index({ status: 1, prioridade: 1, createdAt: 1 });

const outboxSchema = new Schema(
  {
    _id: { type: String },
    aggregateId: { type: String, required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    publishedAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null }
  },
  { collection: "outbox", timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

outboxSchema.index({ publishedAt: 1, createdAt: 1 });

const processedEventSchema = new Schema(
  {
    _id: { type: String },
    type: { type: String, required: true },
    processedAt: { type: Date, default: Date.now }
  },
  { collection: "processed_events", versionKey: false }
);

const Execucao = mongoose.models.Execucao || mongoose.model("Execucao", execucaoSchema);
const OutboxEvent = mongoose.models.OutboxEvent || mongoose.model("OutboxEvent", outboxSchema);
const ProcessedEvent = mongoose.models.ProcessedEvent || mongoose.model("ProcessedEvent", processedEventSchema);

module.exports = { Execucao, OutboxEvent, ProcessedEvent };
