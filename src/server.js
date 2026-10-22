require('newrelic');
require('dotenv').config({ quiet: true });
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./swagger.config');
const logger = require('./infrastructure/logger');
const correlationIdMiddleware = require('./interfaces/middlewares/correlationId.middleware');

const app = express();
app.disable("x-powered-by"); // não expõe a tecnologia do servidor no header X-Powered-By

app.use(correlationIdMiddleware);
app.use(express.json());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

app.use(require('./interfaces/routes/health.routes'));
app.use(require('./interfaces/routes/execucao.routes'));

module.exports = app;

if (require.main === module) {
  const faltando = ['MONGO_URL', 'JWT_SECRET'].filter((nome) => !process.env[nome]);
  if (faltando.length > 0) {
    logger.fatal({ faltando }, 'Configuração obrigatória ausente');
    process.exit(1);
  }

  const database = require('./infrastructure/database/connection');
  const { iniciarMensageria } = require('./infrastructure/messaging');
  const { handlers, repositories } = require('./container');

  database
    .conectar()
    .then(() => {
      if (process.env.RABBITMQ_URL) {
        app.locals.mensageria = iniciarMensageria({
          url: process.env.RABBITMQ_URL,
          handlers,
          outboxRepository: repositories.outboxRepository
        });
      } else {
        logger.warn('RABBITMQ_URL não definido: mensageria desabilitada (eventos ficam no outbox)');
      }

      const port = Number(process.env.PORT) || 3000;
      const server = app.listen(port, () => {
        logger.info({ port }, `Execution Service rodando na porta ${port} (Swagger em /api-docs)`);
      });

      const encerrar = async (signal) => {
        logger.info({ signal }, 'Encerrando o Execution Service');
        server.close();
        await app.locals.mensageria?.stop();
        await database.desconectar().catch(() => {});
        process.exit(0);
      };

      process.on('SIGTERM', encerrar);
      process.on('SIGINT', encerrar);
    })
    .catch((err) => {
      logger.fatal({ err }, 'Não foi possível conectar ao MongoDB');
      process.exit(1);
    });
}
