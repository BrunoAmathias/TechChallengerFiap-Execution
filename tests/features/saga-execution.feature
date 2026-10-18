# language: pt
Funcionalidade: Fila e andamento da execução (Execution Service)
  Como mecânico
  Quero receber as ordens pagas numa fila e registrar cada etapa do reparo
  Para que a oficina acompanhe o trabalho e o cliente veja a OS avançar

  Contexto:
    Dado que o Billing publicou "pagamento.confirmado" para a OS 42 com o serviço "Troca de óleo"

  Cenário: Reparo concluído
    Então a execução entra na fila como "NA_FILA"
    E o evento "execucao.status_atualizado" é publicado com status "NA_FILA"
    Quando o mecânico "Ana" inicia o diagnóstico
    Então a execução fica "EM_DIAGNOSTICO"
    E o evento "execucao.status_atualizado" é publicado com status "EM_DIAGNOSTICO"
    Quando o mecânico inicia o reparo
    Então a execução fica "EM_REPARO"
    Quando o mecânico finaliza a execução
    Então a execução fica "FINALIZADA"
    E o evento "execucao.finalizada" é publicado
    E o timeline registra 4 etapas feitas por "Ana" a partir do diagnóstico

  Cenário: Falha no reparo dispara a compensação
    Quando o mecânico "Ana" inicia o diagnóstico
    E o mecânico registra a falha "Peça indisponível no fornecedor"
    Então a execução fica "FALHOU"
    E o evento "execucao.falhou" é publicado com o motivo "Peça indisponível no fornecedor"

  Cenário: Etapa fora de ordem é rejeitada
    Quando o mecânico tenta finalizar a execução que ainda está na fila
    Então a operação é rejeitada como transição inválida
    E a execução continua "NA_FILA"

  Cenário: Fila ordenada por prioridade
    Dado que o Billing também publicou "pagamento.confirmado" para a OS 43
    Quando a OS 43 recebe prioridade 1
    Então a fila mostra primeiro a OS 43 e depois a OS 42
