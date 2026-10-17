# TechChallengerFiap-Execution — Execution Service

Microsserviço do **chão de fábrica** da oficina: fila de execução dos mecânicos, diagnóstico, reparo e finalização. Faz parte da saga coreografada com o OS Service e o Billing (RabbitMQ). É o serviço com **banco NoSQL** do sistema.

| | |
|---|---|
| Banco | MongoDB (Atlas M0, database `execution_db`), só deste serviço |
| Mensageria | RabbitMQ: consome `pagamento.confirmado`; publica `execucao.status_atualizado`, `execucao.finalizada` e `execucao.falhou` |
| Stack | Node 20, Express 5, mongoose, amqplib, pino, New Relic, Jest + mongodb-memory-server |

## Por que MongoDB aqui

A execução é um documento com o **timeline embutido**: cada etapa registra quem fez, quando e a observação. O serviço sempre lê e grava a execução inteira, não precisa de joins, e as métricas (tempo por etapa e tempo médio por serviço) saem direto do timeline. O modelo de documentos combina com isso.

## Responsabilidades

1. **Fila:** ao receber `pagamento.confirmado`, cria a execução NA_FILA com os serviços e peças. A fila é ordenada por prioridade (1 = mais urgente) e ordem de chegada.
2. **Andamento:** diagnóstico (EM_DIAGNOSTICO) → reparo (EM_REPARO) → finalização (FINALIZADA). Cada etapa publica um evento, que move a OS no OS Service.
3. **Falha:** `PATCH /execucoes/:id/falha` publica `execucao.falhou`. Isso dispara o estorno no Billing e o cancelamento da OS, com devolução de estoque.
4. **Métricas:** tempo médio por etapa e por serviço.

Os contratos completos dos eventos estão em [docs/eventos.md](docs/eventos.md).

## Endpoints (JWT)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/execucoes/fila?status=` | Fila (padrão: NA_FILA, EM_DIAGNOSTICO e EM_REPARO) |
| GET | `/execucoes/:id` · `/execucoes/os/:osId` | Execução com tempo por etapa |
| PATCH | `/execucoes/:id/diagnostico` | NA_FILA → EM_DIAGNOSTICO (`{ tecnico, observacao }`) |
| PATCH | `/execucoes/:id/reparo` | EM_DIAGNOSTICO → EM_REPARO |
| PATCH | `/execucoes/:id/finalizar` | EM_REPARO → FINALIZADA |
| PATCH | `/execucoes/:id/falha` | → FALHOU (`{ motivo }` obrigatório) |
| PATCH | `/execucoes/:id/prioridade` | `{ prioridade: 1..5 }` |
| GET | `/execucoes/metricas` | Tempo médio por etapa e por serviço |
| GET | `/health` · `/health/live` · `/api-docs` | Readiness, liveness e Swagger |

## Arquitetura

```text
src/
├── domain/            Execucao (estados, transições, tempos e métricas), erros
├── application/       casos de uso (execucao.service), handlers da saga, eventos
├── infrastructure/
│   ├── database/      mongoose (connection, models) + unitOfWork (transação de sessão)
│   ├── repositories/  execucoes, outbox, processed_events
│   └── messaging/     RabbitMQ: conexão, topologia (retry/DLQ), consumer, outbox publisher
└── interfaces/        rotas, controllers, middlewares (JWT, correlationId)
```

Garantias no MongoDB:

- **Outbox:** a collection `outbox` é gravada na mesma transação da execução. O publisher reserva cada evento com `findOneAndUpdate` (`lockedUntil`), então várias réplicas não publicam o mesmo evento.
- **Idempotência:** `processed_events` com `_id = eventId`. O registro usa upsert (`$setOnInsert`) porque um erro de chave duplicada dentro de uma transação do MongoDB aborta a transação.
- **Concorrência:** mudança de etapa com `findOneAndUpdate` filtrando pelo status atual. A segunda requisição simultânea recebe 409.
- As transações exigem replica set. O Atlas já é um; localmente, o docker-compose sobe o mongo com `--replSet rs0`.

## Como rodar

```bash
cp .env.example .env
docker compose up -d mongo rabbitmq
npm install
npm run dev                   # http://localhost:3002/api-docs
```

### Testes

```bash
npm run test:unit             # só unitários (rápido)
npm run test:coverage         # todos os testes + cobertura mínima de 80% (o mesmo do CI)
npm run test:integration      # MongoDB real em memória (replica set, mongodb-memory-server)
```

## CI/CD e qualidade

| Workflow | Quando roda | O que faz |
|---|---|---|
| `.github/workflows/ci.yml` | PR para `Dev`, `Homolog` e `main`; push em `Dev` e `Homolog` | `npm ci`, lint, testes com cobertura (integração com MongoDB em memória, sem serviço externo), SonarCloud + Quality Gate, `docker build` |
| `.github/workflows/cd.yml` | push na `main` (merge do PR) ou manual | roda o CI inteiro; build e push da imagem no ECR (`execution-service:<sha>`); cria o Secret `execution-secret` a partir dos GitHub Secrets; `kubectl kustomize` com a imagem nova; rollout e smoke test do `/health` |

**Qualidade exigida no CI** (o job `ci` falha se qualquer item falhar):
- ESLint (`npm run lint`);
- testes unitários, BDD e de integração (MongoDB replica set em memória) com **cobertura mínima de 80%** em linhas, branches, funções e statements (`coverageThreshold` do `jest.config.js`);
- cenários **BDD** em português (`tests/features/*.feature`, jest-cucumber), rodados junto com os demais testes;
- **SonarCloud** (projeto `BrunoAmathias_TechChallengerFiap-Execution`) com `sonar.qualitygate.wait=true`, **só na `main`** (dentro do CD, antes do deploy): o plano da organização no SonarCloud não libera resultados nem Quality Gate de outras branches. Quality Gate reprovado **impede o deploy**.

```bash
npm run lint
npm run test:bdd
npm run test:coverage   # todos os testes, inclusive integração com MongoDB em memória
```

### Secrets e variáveis do repositório (GitHub → Settings → Secrets and variables → Actions)

| Nome | Tipo | Uso |
|---|---|---|
| `MONGO_URL`, `JWT_SECRET`, `NEW_RELIC_LICENSE_KEY` | secret | conteúdo do `execution-secret` (`MONGO_URL` = output `execution_mongo_url` do repo DB) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | secret | push no ECR e deploy no EKS |
| `SONAR_TOKEN` | secret | análise no SonarCloud (sem ele, o CI só avisa e segue) |
| `ECR_REPOSITORY` | variable (opcional) | padrão `execution-service` |

O namespace `execution` e os Secrets `rabbitmq` são criados pelo Terraform do repo `TechChallengerFiap-K8s`; o CD só confere que existem.

### Proteção da branch main

PR obrigatório com 1 aprovação, check `ci` obrigatório (lint, testes e cobertura mínima de 80%; o Quality Gate do Sonar é verificado no CD, antes do deploy), sem push direto, sem force push. Configuração pela API do GitHub com o script do repo Application:

```bash
export GH_TOKEN=<token com permissão de administração do repositório>
./scripts/proteger-branch-main.sh BrunoAmathias/TechChallengerFiap-Execution
```

O check `ci` só aparece para seleção depois da primeira execução do workflow (abra um PR antes).

## Deploy

Os manifests ficam em `k8s/` (Kustomize, namespace `execution`): Deployment, Service, HPA, ConfigMap e Ingress no ALB compartilhado (`group.name: oficina`; path `/execucoes`).

| Secret no cluster | Origem |
|---|---|
| `execution-secret` (`MONGO_URL`, `JWT_SECRET`, `NEW_RELIC_LICENSE_KEY`) | gerado pelo CD a partir dos GitHub Secrets (`MONGO_URL` = output `execution_mongo_url` do repo DB) |
| `rabbitmq` (`RABBITMQ_URL`) | Terraform do repo `TechChallengerFiap-K8s` |
