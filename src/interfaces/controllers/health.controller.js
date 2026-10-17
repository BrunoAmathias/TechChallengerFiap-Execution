const database = require("../../infrastructure/database/connection");

class HealthController {
  /** Liveness: o processo está de pé (não depende de banco nem broker). */
  async live(req, res) {
    return res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
  }

  /** Readiness: MongoDB obrigatório (503 se fora); broker fora = DEGRADED. */
  async checkHealth(req, res) {
    const checks = { database: "UP", broker: "DISABLED" };

    try {
      await database.ping();
    } catch {
      checks.database = "DOWN";
    }

    const mensageria = req.app.locals.mensageria;
    if (mensageria) {
      checks.broker = mensageria.isConnected() ? "UP" : "DOWN";
    }

    let status = "OK";
    if (checks.database === "DOWN") status = "DOWN";
    else if (checks.broker === "DOWN") status = "DEGRADED";

    return res.status(status === "DOWN" ? 503 : 200).json({ status, checks, timestamp: new Date().toISOString() });
  }
}

module.exports = new HealthController();
