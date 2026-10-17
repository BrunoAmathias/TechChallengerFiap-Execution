const swaggerJSDoc = require('swagger-jsdoc');
const { STATUS_EXECUCAO } = require('./domain/execucao');

const status = Object.values(STATUS_EXECUCAO);

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Tech Challenger FIAP - Execution Service',
      version: '1.0.0',
      description: 'Fila de execução, diagnóstico e reparo da oficina (MongoDB). Participa da saga coreografada via RabbitMQ.',
    },
    servers: [{ url: 'http://localhost:3002', description: 'Servidor de desenvolvimento' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Execucao: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '670d2c4f9b1e8a0012345678' },
            osId: { type: 'integer' },
            orcamentoId: { type: 'integer' },
            pagamentoId: { type: 'integer' },
            prioridade: { type: 'integer', minimum: 1, maximum: 5 },
            status: { type: 'string', enum: status },
            tecnico: { type: 'string', nullable: true },
            motivoFalha: { type: 'string', nullable: true },
            servicos: { type: 'array', items: { type: 'object', properties: { servicoId: { type: 'integer' }, nome: { type: 'string' }, quantidade: { type: 'integer' } } } },
            pecas: { type: 'array', items: { type: 'object', properties: { pecaId: { type: 'integer' }, nome: { type: 'string' }, quantidade: { type: 'integer' } } } },
            timeline: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: status },
                  em: { type: 'string', format: 'date-time' },
                  por: { type: 'string' },
                  observacao: { type: 'string', nullable: true },
                },
              },
            },
            tempoPorEtapaMinutos: { type: 'object', additionalProperties: { type: 'number' }, example: { NA_FILA: 12.5, EM_DIAGNOSTICO: 30 } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Metricas: {
          type: 'object',
          properties: {
            totalFinalizadas: { type: 'integer' },
            tempoMedioPorEtapaMinutos: { type: 'object', additionalProperties: { type: 'number' } },
            tempoMedioPorServico: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  servicoId: { type: 'integer' },
                  nome: { type: 'string' },
                  execucoes: { type: 'integer' },
                  tempoMedioMinutos: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: ['./src/interfaces/routes/*.js'],
};

module.exports = swaggerJSDoc(options);
