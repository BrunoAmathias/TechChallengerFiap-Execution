const { Execucao } = require("../database/models");

function mapear(doc) {
  if (!doc) return null;
  const { _id, ...resto } = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return { id: String(_id), ...resto };
}

class ExecucaoRepository {
  async criar(dados, session = null) {
    const [doc] = await Execucao.create([dados], { session });
    return mapear(doc);
  }

  async buscarPorId(id, session = null) {
    return mapear(await Execucao.findById(id).session(session).lean());
  }

  async buscarPorOsId(osId, session = null) {
    return mapear(await Execucao.findOne({ osId: Number(osId) }).session(session).lean());
  }

  async listarFila(statuses) {
    const docs = await Execucao.find({ status: { $in: statuses } })
      .sort({ prioridade: 1, createdAt: 1 })
      .lean();
    return docs.map(mapear);
  }

  async listarFinalizadas() {
    const docs = await Execucao.find({ status: "FINALIZADA" }, { servicos: 1, timeline: 1, status: 1 }).lean();
    return docs.map(mapear);
  }

  /**
   * Muda de etapa só se o status ainda for `de` (controle de concorrência
   * otimista) e acrescenta a entrada no timeline. Retorna null se outra
   * requisição mudou a execução antes.
   */
  async transicionar(id, de, { status, entradaTimeline, campos = {} }, session = null) {
    const doc = await Execucao.findOneAndUpdate(
      { _id: id, status: de },
      { $set: { status, ...campos }, $push: { timeline: entradaTimeline } },
      { new: true, session }
    ).lean();
    return mapear(doc);
  }

  async atualizarPrioridade(id, prioridade) {
    return mapear(await Execucao.findByIdAndUpdate(id, { $set: { prioridade } }, { new: true }).lean());
  }
}

module.exports = new ExecucaoRepository();
module.exports.mapear = mapear;
