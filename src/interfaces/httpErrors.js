const { NaoEncontradoError, TransicaoInvalidaError, ConflitoError } = require("../domain/errors");
const logger = require("../infrastructure/logger");

function statusDoErro(err) {
  if (err instanceof NaoEncontradoError) return 404;
  if (err instanceof TransicaoInvalidaError || err instanceof ConflitoError) return 409;
  if (err?.name === "CastError") return 400; // id inválido para o MongoDB
  return 500;
}

function responderErro(res, err) {
  const status = statusDoErro(err);
  if (status >= 500) logger.error({ err }, "Erro ao processar requisição");
  return res.status(status).json({ error: status === 400 ? "Identificador inválido" : err.message });
}

module.exports = { statusDoErro, responderErro };
