# Revisão do desktop, Web e clients de IA — 30/09/2026

Revisão dos fluxos de edição, transcrição, importação, recuperação, comunicação MCP, distribuição Web e instruções de Codex/Claude. As alterações anteriores do projeto foram preservadas. A revisão combina leitura do código e contratos com testes das áreas afetadas; não constitui uma garantia de ausência de defeitos em todos os formatos, navegadores e equipamentos.

## Problemas corrigidos

| Área | Problema e consequência | Correção |
|---|---|---|
| Desktop + editor | Uma importação assíncrona podia continuar depois que outro projeto fosse aberto. Atualizar ou remover a verificação de revisão não distinguia edição normal de troca de documento. | O editor fornece `projectInstanceId`, que muda ao abrir/limpar um projeto. A fila conserva esse identificador e o editor verifica antes e depois da análise assíncrona. Troca de documento interrompe o job com `project_changed`; `resume_import` passa a significar retomada explícita no documento atual. |
| Desktop | Arquivos com estado `probing` persistido não eram recolocados na fila após reiniciar. Arquivos antes ausentes também não eram tentados novamente ao retomar. | Restauração normaliza operações interrompidas; retomada inclui arquivos pendentes, cancelados, falhos e antes ausentes, preservando os já importados. |
| Desktop | Salvamentos concorrentes dos jobs escreviam no mesmo temporário, podendo disputar escrita/renomeação. Uma gravação iniciada antes de limpar podia recriar o estado depois da limpeza. | Escritas e remoção do estado usam uma fila única. A limpeza aguarda as gravações anteriores; trabalho tardio não recria o arquivo quando não há jobs. |
| Desktop | Cancelamento durante a espera por uma revisão nova podia ser seguido de outra tentativa de adicionar o arquivo. Cancelar um processo que nem chegou a iniciar podia produzir `kill EINVAL`. | O cancelamento é verificado em cada tentativa de commit. A sondagem já cancelada nem inicia; erros ao encerrar o processo não substituem o diagnóstico de cancelamento/timeout. A leitura do resultado do FFprobe aguarda o fechamento de suas saídas. |
| MCP | O limite do histórico de requisições podia expulsar uma operação ainda em execução, permitindo executá-la novamente. A fila também aceitava reutilizar um ID para outra lista de arquivos. | Somente registros concluídos podem ser removidos do histórico. Reutilização do ID com conteúdo diferente retorna `idempotency_conflict`. |
| Editor Web/desktop | Abrir outro projeto mantinha os históricos de desfazer/refazer e a transcrição do anterior. | A troca de documento reinicia os históricos e limpa o cache de transcrição antes de iniciar o novo histórico. |
| Transcrição/packaging | `transcriptReady` verificava apenas o ID do clipe: uma transcrição parcial, outro arquivo com o mesmo ID ou outro modelo podiam ser anunciados como prontos. Mudanças de configuração durante a decodificação também podiam divergir da chave de cache. | O cache verifica arquivo, caminho, modelo, idioma, tratamento de áudio e cobertura do trecho. Uma transcrição completa pode atender um trecho menor. As opções de uma transcrição em andamento ficam fixadas na chamada. |
| Servidor Web | Arquivos ausentes, inclusive modelos/worker/WASM, podiam cair na renderização HTML e retornar sucesso. Downloads com nomes fixos recebiam cache de um ano. IPv6 local com porta era interpretado incorretamente. | Arquivos ausentes retornam HTTP 404; downloads e outros arquivos sem hash são revalidados; bundles com hash mantêm cache imutável. IPv6 local é reconhecido corretamente. |
| Skills e descrições MCP | Recuperação automática irrestrita no fluxo de vlog contradizia as regras de transcrição. Setup confundia editor desatualizado com ausente; havia instrução de importar uma pasta onde a API exige arquivos, nome incorreto de comando e `expectedRevision` indicado para comandos que não o aceitam. | Instruções sincronizadas nos dois clients, recuperação limitada, diagnóstico pelo motivo real, importação por caminhos explícitos, uso de `get_editor_capabilities` e argumentos de acordo com o schema. Atualizações deixam de exigir desinstalação/reinício do computador sem indicação do instalador. |

As quatro skills de cada client continuam documentando o servidor MCP embutido no SimpleVlogEditor local. As orientações anteriores sobre inspeção audiovisual de cortes, blocos de até cinco minutos, leitura de textos e fidelidade das capas foram mantidas.

## Validação

| Verificação | Resultado |
|---|---|
| Suíte completa do navegador, incluindo novos casos de troca de projeto/importação/cache | 580 aprovados; um ignorado |
| Suíte completa Electron/MCP | 142 aprovados |
| Clients de IA: inicialização, comunicação, leitura de mídia e contratos | 23 aprovados; um ignorado por depender de sinais POSIX |
| Contratos das skills, revalidados após os ajustes finais | Cinco aprovados |
| Editor de shorts | Cinco aprovados; teste opcional de exportação com mídia real ignorado |
| Fluxo editorial, análise de áudio e correção de cores | 14 aprovados |
| Pastas de packaging e integração nativa | Sete aprovados |
| Leitura de mídia e cancelamento do decodificador | Seis aprovados, incluindo leitura real de PCM sintético |
| Servidor HTTP Web | Dois aprovados, com servidor real em loopback e verificações de status/cache |
| TypeScript e build de produção com SSR | Aprovados; nove rotas pré-renderizadas |

O build precisou executar fora do isolamento porque o compilador não conseguia ler diretórios ancestrais. A compilação autorizada concluiu. Permanece o aviso anterior de orçamento do CSS do editor (45,21 kB ante aviso em 40 kB); não houve erro de build.

Os testes de regressão novos reproduzem os casos de importação/restauração/cancelamento, salvamento concorrente, troca de projeto durante a análise, pressão no histórico MCP e cache de transcrição incompatível. Os pacotes ZIP de Codex e Claude foram regenerados e verificados contra os arquivos de origem.

## Entrega e limites

Correções presentes no código e na build local. Esta rodada não substituiu o executável instalado, publicou o site ou gerou um novo instalador. Nenhum vídeo ou projeto do usuário foi aberto, cortado ou regravado durante esta revisão. Não foi executada uma nova exportação completa de vlog nesta rodada; a validação real de transcrição do vídeo de Recife permanece documentada no relatório anterior.
