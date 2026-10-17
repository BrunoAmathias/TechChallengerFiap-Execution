class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Transição de etapa não permitida ou dado inválido (HTTP 409). */
class TransicaoInvalidaError extends DomainError {}

/** Recurso inexistente (HTTP 404). */
class NaoEncontradoError extends DomainError {}

/** Outra requisição alterou a execução ao mesmo tempo (HTTP 409). */
class ConflitoError extends DomainError {}

module.exports = { DomainError, TransicaoInvalidaError, NaoEncontradoError, ConflitoError };
