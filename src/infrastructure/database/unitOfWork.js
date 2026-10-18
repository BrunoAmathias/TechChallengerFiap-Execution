const mongoose = require("mongoose");

/**
 * Executa `fn(session)` dentro de uma transação do MongoDB. A execução, o
 * outbox e os eventos processados gravados com essa sessão são confirmados
 * juntos. withTransaction repete `fn` em erros transitórios, então `fn` não
 * deve ter efeitos fora do banco.
 */
class UnitOfWork {
  constructor(conexao = mongoose) {
    this.conexao = conexao;
  }

  async run(fn) {
    const session = await this.conexao.startSession();
    try {
      let resultado;
      await session.withTransaction(async () => {
        resultado = await fn(session);
      });
      return resultado;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = new UnitOfWork();
module.exports.UnitOfWork = UnitOfWork;
