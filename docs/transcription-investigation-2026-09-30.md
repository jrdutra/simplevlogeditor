# Investigação da transcrição — 30/09/2026

Correção implementada no código do editor, ponte Electron/MCP e instruções dos clients Codex/Claude. Validada com chamadas reais `tools/call` do host MCP local e a versão compilada deste checkout. O transporte do plugin desta conversa respondeu `Transport closed`; o host stdio local permitiu investigar e executar a integração real. O executável instalado em Program Files não foi substituído, nem foi publicado um instalador novo.

## Causa e evidências

**Causa confirmada do progresso congelado:** `reportTranscript()` atualizava apenas o painel do renderer. Não encaminhava as etapas da transcrição para `desktop.reportAgentProgress()`. O processo principal registrava somente `started / 0` e o resultado final. Assim, decodificação, carregamento do modelo e reconhecimento em andamento pareciam parados no MCP.

**Causa confirmada da repetição após reiniciar:** `self-healing.js` classificava `transcribe` como leitura automaticamente repetível. O registro original `mcp-runtime.log`, linha 822, mostra `self_heal_retry`, `request: transcribe`, `attempt: 1`, `code: editor_reconnecting` em `2026-09-30T11:42:47.715Z`. As linhas 834–835 registram cancelamentos às `11:45:59.787Z` e `11:49:52.348Z`.

Os registros antigos não capturavam as etapas internas e não provam um deadlock específico do Whisper ou uma falha de download. As duas tentativas registradas terminaram por cancelamento. Depois da correção, Small transcreveu o arquivo original completo em 265.928 ms, demonstrando que esse processamento pode levar vários minutos nesta máquina. Large V3 Turbo também concluiu uma transcrição real.

**Riscos de bloqueio confirmados no fluxo:** chamadas de metadados e `iterator.next()` do decodificador não tinham limite próprio. O cancelamento era observado apenas depois desses `await`; um terceiro componente que não resolvesse a promessa podia impedir a liberação da fila. Erros de transcrição eram recuperáveis por padrão, permitindo novas tentativas automáticas. Limites curtos solicitados eram elevados a pelo menos dez minutos. O controle anterior de etapa também não distinguia adequadamente avanço dentro da mesma etapa.

## Correção

- As etapas agora atravessam renderer → preload/IPC → processo principal → estado MCP: preparação, decodificador, faixa de áudio, codec, duração, frequência, leitura, reamostragem, criação do worker, download, inicialização do modelo e reconhecimento. Downloads informam arquivo e bytes; operações informam clipe/arquivo/detalhe. Etapas de progresso indeterminado usam percentual nulo.
- Leitura de áudio usa a duração da faixa de áudio e leituras por intervalo; não consulta desnecessariamente a duração da imagem do MOV grande. Metadados, amostras e reamostragem têm espera limitada de 60 segundos e liberação do input. Amostras recebidas após cancelamento são fechadas.
- Cancelamento rejeita a espera independentemente da resposta do decodificador/worker. O worker é encerrado; resultados tardios não alimentam progresso nem cache. A fila pode continuar mesmo se uma dependência ignorar o sinal de cancelamento.
- Limites: 30 minutos para a operação inteira, cinco minutos sem avanço, 60 segundos para inicialização do worker/esperas do decodificador. `timeoutMs` e `stageTimeoutMs` explícitos são respeitados, com mínimo de um segundo e máximo de uma hora no MCP. Prazos de transporte incluem margem para devolver o erro preciso do renderer.
- Falhas preservam etapa, causa e detalhes. Códigos incluem `audio_decode_failed`, `worker_startup_failed`, `worker_failed`, `worker_message_error`, `transcription_stalled`, `transcription_stage_timeout`, `transcription_timeout` e `cancelled`. Notificações idênticas não renovam indefinidamente o prazo sem avanço.
- `transcribe` nunca é repetido automaticamente, inclusive quando um renderer antigo marca o erro como recuperável. Interrupção por reinício/desconexão retorna `transcription_interrupted`; o client deve conferir saúde/projeto e solicitar explicitamente outra operação com novo `requestId`.
- As skills de edição de Codex e Claude documentam as etapas, limites e a exceção de transcrição às tentativas automáticas de leituras leves. Os pacotes ZIP dos clients foram atualizados.

## Validação real pelo MCP

| Fonte/modelo | Resultado | Tempo |
|---|---|---|
| Fala humana de 11 s, WAV PCM estéreo 44,1 kHz / Small | 22 palavras com timestamps válidos | 6.137 ms |
| Mesma fala convertida para AAC/M4A / Small | 22 palavras | 5.672 ms |
| AAC/M4A / Large V3 Turbo | 22 palavras | 15.317 ms |
| `Gravado-Viagem a Recife Parte 2.mov`, 16.896.043.786 bytes, H.264 + PCM estéreo 48 kHz, 595,4949 s / Small | 1.149 palavras; concluído em 100% | 265.928 ms |
| WAV / Small, após reiniciar com a build final | 22 palavras | 5.754 ms |

Durante o vlog completo, `get_operation_status` mostrou `listening` em 28,21%, 48,36% e 96,73%, antes de `completed / 100`. `health_check` permaneceu responsivo. O resultado também forneceu dois blocos semânticos, ambos menores que cinco minutos.

O áudio público de teste veio de `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav`. Os modelos puderam usar o cache existente; não se apagaram modelos nem dados para forçar um download limpo. Interrupção de download e notificações repetidas foram verificadas por testes controlados do worker.

### Cancelamento, prazo e reinício

- Transcrição real Base do vlog com prazo de um segundo: retornou `transcription_timeout`; em seguida a saúde mostrou zero operações ativas.
- Cancelamento durante reconhecimento Base do vlog: retornou `cancelled`; `get_frames` extraiu um JPEG do vídeo imediatamente na sequência e a saúde voltou a zero operações ativas.
- Reinício durante reconhecimento Base do vlog: retornou `transcription_interrupted`, sem replay. O editor reabriu com zero operações ativas. Comparação das configurações, IDs, clipes, cortes e dados de edição antes/depois foi idêntica, excluindo somente miniaturas, revisão e horário de salvamento. Uma nova transcrição Small concluiu depois do reinício.

### Verificação automatizada

- Suíte completa do navegador: 574 aprovados, um ignorado. Após os ajustes finais, os 12 testes focados em transcrição passaram novamente.
- Suíte Electron/MCP: 134 aprovados. O teste adicional de renderer antigo/replay passou na suíte focada de dez testes.
- Contrato das skills dos clients: cinco aprovados.
- Compilação TypeScript da aplicação e testes: sem erros. Build de produção concluída; permanece o aviso anterior de orçamento do CSS do editor.

Os testes cobrem ausência de progresso do worker, criação de worker com erro, notificações idênticas de download, cancelamento de download, timestamps/resultado parcial, metadados que nunca respondem, fechamento de amostras tardias, cancelamento antes de iniciar, liberação da fila e deadline de um segundo com dependência que ignora abort.

## Preservação e limites

Não foram cortados nem regravados vídeos ou projetos existentes. O projeto ativo estava vazio e não havia checkpoint de recuperação ao iniciar. Antes de importar as fontes de teste, foi salvo pelo MCP um snapshot dessa sessão. Depois da validação, o snapshot foi reaberto pelo MCP e confirmado com zero clipes; o checkpoint temporário foi removido pelo próprio editor, restaurando o estado de recuperação inicial. O projeto salvo `Recife-parte-2-silencios.sve.json` não foi aberto nem alterado.

Evidências compactas das respostas MCP, progresso, contagens, códigos e comparação dos projetos estão em `transcription-validation-2026-09-30.json`. As fontes públicas e arquivos temporários de investigação foram removidos após a restauração. Para distribuir esta correção fora do checkout é necessário gerar uma nova versão do aplicativo; o instalador existente não contém essas mudanças.
