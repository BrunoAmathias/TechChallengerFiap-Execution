const mongoose = require("mongoose");
const logger = require("../logger");

/**
 * Conexão com o MongoDB (Atlas M0 em produção). Transações exigem replica set:
 * o Atlas já é um; localmente o docker-compose sobe o mongo com --replSet.
 */
async function conectar(url = process.env.MONGO_URL) {
  if (!url) throw new Error("MONGO_URL não configurado");

  mongoose.connection.on("disconnected", () => logger.warn("MongoDB desconectado"));
  mongoose.connection.on("reconnected", () => logger.info("MongoDB reconectado"));

  await mongoose.connect(url, { serverSelectionTimeoutMS: 10000 });
  logger.info("MongoDB conectado");
  return mongoose.connection;
}

async function desconectar() {
  await mongoose.disconnect();
}

function isConectado() {
  return mongoose.connection.readyState === 1;
}

async function ping() {
  await mongoose.connection.db.admin().ping();
}

module.exports = { conectar, desconectar, isConectado, ping, mongoose };
