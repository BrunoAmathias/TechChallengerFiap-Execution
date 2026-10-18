const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const ExecucaoController = require("../controllers/execucao.controller");

/**
 * @swagger
 * tags:
 *   - name: Execuções
 *     description: Fila de trabalho dos mecânicos e andamento do reparo
 */

/**
 * @swagger
 * /execucoes/fila:
 *   get:
 *     summary: Fila de execução ordenada por prioridade (1 = mais urgente) e chegada
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         description: Filtra por status (padrão NA_FILA, EM_DIAGNOSTICO e EM_REPARO)
 *         schema: { type: string, enum: [NA_FILA, EM_DIAGNOSTICO, EM_REPARO, FINALIZADA, FALHOU] }
 *     responses:
 *       200:
 *         description: Execuções
 *         content:
 *           application/json:
 *             schema: { type: array, items: { $ref: '#/components/schemas/Execucao' } }
 */
router.get("/execucoes/fila", authMiddleware, (req, res) => ExecucaoController.fila(req, res));

/**
 * @swagger
 * /execucoes/metricas:
 *   get:
 *     summary: Tempo médio por etapa e por serviço (execuções finalizadas)
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Métricas calculadas a partir do timeline
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Metricas' }
 */
router.get("/execucoes/metricas", authMiddleware, (req, res) => ExecucaoController.metricas(req, res));

/**
 * @swagger
 * /execucoes/os/{osId}:
 *   get:
 *     summary: Execução de uma ordem de serviço
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: osId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Execução, content: { application/json: { schema: { $ref: '#/components/schemas/Execucao' } } } }
 *       404: { description: Nenhuma execução para a OS }
 */
router.get("/execucoes/os/:osId", authMiddleware, (req, res) => ExecucaoController.buscarPorOs(req, res));

/**
 * @swagger
 * /execucoes/{id}:
 *   get:
 *     summary: Busca uma execução (com tempo por etapa)
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Execução, content: { application/json: { schema: { $ref: '#/components/schemas/Execucao' } } } }
 *       404: { description: Execução não encontrada }
 */
router.get("/execucoes/:id", authMiddleware, (req, res) => ExecucaoController.buscarPorId(req, res));

/**
 * @swagger
 * components:
 *   requestBodies:
 *     Etapa:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tecnico: { type: string, example: Ana }
 *               observacao: { type: string }
 * /execucoes/{id}/diagnostico:
 *   patch:
 *     summary: Inicia o diagnóstico (NA_FILA → EM_DIAGNOSTICO)
 *     description: Publica execucao.status_atualizado; a OS vai para "Em diagnóstico".
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody: { $ref: '#/components/requestBodies/Etapa' }
 *     responses:
 *       200: { description: Execução atualizada }
 *       404: { description: Execução não encontrada }
 *       409: { description: Etapa inválida para o status atual }
 * /execucoes/{id}/reparo:
 *   patch:
 *     summary: Inicia o reparo (EM_DIAGNOSTICO → EM_REPARO)
 *     description: Publica execucao.status_atualizado; a OS vai para "Em execução".
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody: { $ref: '#/components/requestBodies/Etapa' }
 *     responses:
 *       200: { description: Execução atualizada }
 *       409: { description: Etapa inválida para o status atual }
 * /execucoes/{id}/finalizar:
 *   patch:
 *     summary: Finaliza o reparo (EM_REPARO → FINALIZADA)
 *     description: Publica execucao.finalizada; a OS vai para "Finalizada".
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody: { $ref: '#/components/requestBodies/Etapa' }
 *     responses:
 *       200: { description: Execução finalizada }
 *       409: { description: Etapa inválida para o status atual }
 */
router.patch("/execucoes/:id/diagnostico", authMiddleware, ExecucaoController.diagnostico);
router.patch("/execucoes/:id/reparo", authMiddleware, ExecucaoController.reparo);
router.patch("/execucoes/:id/finalizar", authMiddleware, ExecucaoController.finalizar);

/**
 * @swagger
 * /execucoes/{id}/falha:
 *   patch:
 *     summary: Registra falha na execução (ex. falta de peça, reparo inviável)
 *     description: Publica execucao.falhou. O Billing estorna o pagamento e o OS Service cancela a OS e devolve o estoque.
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [motivo]
 *             properties:
 *               motivo: { type: string, example: Peça indisponível no fornecedor }
 *               tecnico: { type: string }
 *     responses:
 *       200: { description: Falha registrada }
 *       409: { description: Motivo ausente ou execução já encerrada }
 */
router.patch("/execucoes/:id/falha", authMiddleware, ExecucaoController.falha);

/**
 * @swagger
 * /execucoes/{id}/prioridade:
 *   patch:
 *     summary: Altera a prioridade na fila (1 = mais urgente, 5 = menos)
 *     tags: [Execuções]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prioridade: { type: integer, minimum: 1, maximum: 5 }
 *     responses:
 *       200: { description: Prioridade alterada }
 *       409: { description: Prioridade inválida ou execução encerrada }
 */
router.patch("/execucoes/:id/prioridade", authMiddleware, (req, res) => ExecucaoController.alterarPrioridade(req, res));

module.exports = router;
