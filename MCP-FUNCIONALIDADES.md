# SimpleVlogEditor — Funcionalidades expostas via MCP

Levantamento completo da superfície MCP do editor, extraído do código-fonte:

- `electron/src/mcp-server.js` — lista de tools e schemas JSON expostos ao cliente
- `electron/src/main.js` — comandos resolvidos no processo principal (host)
- `web/src/app/ferramentas/editor-de-video/editor-agent-api.ts` — contrato de dados
- `web/src/app/ferramentas/editor-de-video/editor-agent-capabilities.ts` — catálogo devolvido por `get_editor_capabilities`
- `web/src/app/ferramentas/editor-de-video/editor-de-video.component.ts` — implementação no renderer

Servidor: `simple-vlog-editor`, versão `2.1.0`, API do editor `apiVersion: 2`.
Protocolos MCP suportados: `2025-06-18`, `2025-03-26`, `2024-11-05`.
Capacidade anunciada: `tools` (sem `listChanged`). Sem resources, sem prompts.

---

## 1. Visão geral

O servidor MCP é um adaptador stdio em Node (`mcp-host.js`) que conversa com um
processo Electron único por usuário através de um named pipe estável. Toda
mutação MCP passa pela mesma timeline Angular que os botões da tela usam — não
existe caminho paralelo. O renderer permanece em sandbox, sem Node; leituras de
arquivo e escrita em disco acontecem no processo principal, limitadas às raízes
permitidas.

**Não existe** tool de execução de JavaScript arbitrário nem tool genérica de
sistema de arquivos.

### 1.1 Faixas de execução (lanes)

Comandos que tocam o renderer compartilham uma fila ordenada, para que
`get_project` nunca observe metade de um batch atômico e para que vários
decodificadores não esgotem a janela.

Um conjunto estreito de comandos usa a **faixa prioritária** e continua
respondendo durante um render ou transcrição longa:

`health_check`, `get_operation_status`, `cancel_operation`, `get_import_status`,
`cancel_import`, `get_diagnostics`, `get_recovery_state`, `close_editor`,
`restart_editor`.

Os mesmos, mais `get_editor_capabilities`, são atendidos mesmo antes de o projeto
terminar de montar (gate de inicialização com teto de 30 s).

### 1.2 Espaços de tempo

| Conceito | Onde é medido |
|---|---|
| **Tempo de origem** (source) | No arquivo original. Todos os campos `start`, `end`, `duration`, `startSeconds`, `durationSeconds`, `sourceTime`, `inPoint`, `outPoint` de **todas** as operações e respostas. |
| **Tempo de saída** (output) | Na timeline montada. Somente `outputStart` / `outputDuration` em `get_timeline` e `outputTime` em frames compostos. |

O painel do editor pode exibir qualquer um dos dois relógios; isso **não muda
nada** pelo MCP.

### 1.3 Raízes de arquivo (permissões)

Precedência, do mais forte ao mais fraco:

1. `SVE_MCP_ROOTS` (separador `;` no Windows, `:` em macOS/Linux)
2. Raízes da sessão do cliente MCP (`roots/list`, se o cliente anunciar a
   capacidade `roots`; o servidor também acompanha `notifications/roots/list_changed`)
3. Pastas autorizadas pelo usuário (escolher/arrastar arquivo, ou aceitar o
   pedido nativo de pasta). Persistidas em `%LOCALAPPDATA%\SimpleVlogEditor\roots.json`
4. Padrões: Vídeos, Imagens, Música, Downloads, Área de Trabalho, Documentos +
   a pasta do próprio projeto

Acima de tudo há uma **lista de negação** que nenhuma camada sobrepõe: Windows,
Program Files, ProgramData, dados de outros aplicativos e raízes de unidade. Os
dados do próprio editor são readmitidos explicitamente.

O diretório de trabalho nunca é consultado.

### 1.4 Idempotência e revisão

- Toda mutação de projeto exige `requestId` não vazio: `add_media`,
  `queue_media_import`, `open_project`, `set_project_soundtrack`,
  `analyze_silence`, `analyze_noise`, `suppress_noise`, `apply_edit_batch`
  (commit), `undo`, `redo`.
- Repetir o mesmo `requestId` com a **mesma** carga devolve o resultado original
  sem aplicar duas vezes (inclusive em retentativas concorrentes).
- Reusar o id com carga diferente → `idempotency_conflict`.
- Escopo do ledger: sessão do editor + projeto de recuperação. Após reinício do
  Electron, leia o projeto restaurado e gere ids novos.
- `expectedRevision` evita aplicar um plano velho depois de o usuário mexer na
  edição → `revision_conflict`, com `actualRevision`, `changedBy`, `changedAt` e
  `nextStep`.
- Todo batch mutante é atômico e vira **um** passo de undo.

### 1.5 Checkpoint automático de recuperação

O Electron grava um checkpoint atômico antes e depois de comandos mutantes, e
também a cada alteração manual (debounced) feita pelo usuário na timeline ou nas
configurações. Limpar a timeline limpa o checkpoint. Escritas manuais e MCP são
serializadas; uma revisão antiga que chegue depois de uma mais nova é ignorada.

---

## 2. Tools MCP

33 tools. Agrupadas por finalidade.

### 2.1 Descoberta e leitura

| Tool | Argumentos | Retorno (resumo) |
|---|---|---|
| `get_editor_capabilities` | — | Catálogo completo: comandos, tipos de operação, tags, transições, estilos de texto, efeitos, legendas, imagens, formatos, ruído, semântica. Ver §4. |
| `get_project` | — | `apiVersion`, `revision`, `duration`, `clipCount`, `project` (documento serializado completo). |
| `list_assets` | — | Lista de assets únicos: `id` (hash de nome+tamanho+mtime), `clips[]`, `available`, `file` (nome, caminho, tamanho, mtime + sumário de mídia). |
| `get_timeline` | — | `revision`, `duration`, `clips[]`. Ver §2.1.1. |

#### 2.1.1 Forma de cada clipe em `get_timeline`

Base (todos): `id`, `kind`, `index`, `outputStart`, `outputDuration`.

- **Clipe de transição**: + `settings`.
- **Clipe de texto**: + `draft`, `tag`, `edits`, `replacementAudio`, `background`.
- **Clipe de mídia**: + `assetId`, `source`, `sourceDuration`, `inPoint`,
  `outPoint`, `keepRanges`, `removedRanges`, `manualCuts`, `detectedSilences`,
  `speed`, `audioMode`, `edits`, `captions[]`, `tag`, `manualZooms[]`,
  `pushIns[]`, `noiseSuppression`, `videoEffect`, `videoEffects[]` (seções
  temporizadas), `images[]` (com caixa medida em pixels, `fitsInFrame` e
  `covers` — o que a imagem cobre), `noiseAnalysis`, `noisePreviewReady`,
  `replacementAudio`.

### 2.2 Importação de mídia (assíncrona, API v2)

`add_media` **não** espera mais o lote inteiro. Aceita apenas caminhos absolutos
locais e devolve `{ jobId, requestId, async: true }`. Clientes antigos que
esperavam um array `added` imediato precisam passar a consultar
`get_import_status`.

| Tool | Argumentos | Observações |
|---|---|---|
| `queue_media_import` | `paths[]` (1–100, obrigatório), `atIndex`, `skipDuplicates`, `maxConcurrency` (1–2), `requestId` (obrigatório), `expectedRevision` | Preferida para clientes novos. |
| `add_media` | idênticos | Entrada de compatibilidade, mesmo comportamento. |
| `get_import_status` | `jobId` | Progresso estruturado + resultado por arquivo. |
| `cancel_import` | `jobId` | Cancela o que está na fila / sendo sondado; não remove assets já commitados. |
| `resume_import` | `jobId` | Retoma a parte cancelada ou interrompida. |

Resultado por arquivo: `imported`, `already_present`, `unsupported`, `missing`,
`failed`, `cancelled`.

Garantias: só descritor, tamanho, timestamps, metadados e URLs de faixa privadas
cruzam o IPC — nenhum `ArrayBuffer` de vídeo. FFprobe roda em subprocessos
isolados, no máximo dois arquivos sondados por vez; o commit preserva a ordem de
entrada e cada asset válido é inserido atomicamente. O renderer lê faixas de
bytes do disco apenas quando preview/análise/exportação pedem.

### 2.3 Controle, saúde e diagnóstico

| Tool | Argumentos | Retorno |
|---|---|---|
| `health_check` | — | `state` (`starting` / `ready` / `processing`), `connectionStatus`, `electronPid`, `sessionId`, raízes permitidas, `queue`, `operations` (contagem + até 20 ativas). |
| `get_operation_status` | `operationId` | Estado, `stage`, `percent`, `elapsedMs`, `projectRevision`, `error`, `terminal`. |
| `cancel_operation` | `operationId` | Marca `canceling` / `cancellation-requested` e confirma `cancellationRequested`. |
| `get_diagnostics` | — | `editorVersion`, `apiVersion`, `protocolVersion`, PIDs de MCP e Electron, plataforma, `versions`, `windowCount`, `rendererReady`, raízes + `rootSource` (`env`/`cwd`/`project`/`none`) + `rootNotice`, `clientHealth`, `imports`, últimas 20 operações com erros terminais, `idempotency`, `connection`, `memory`, `externalTools` (ffmpeg/ffprobe). Os mesmos campos aparecem sob `host` para o adaptador stdio. |
| `get_recovery_state` | — | Inspeciona o checkpoint automático: mídias referenciadas (nomes, caminhos absolutos, pastas) e quais faltam em disco. **Chamar antes da primeira edição da sessão.** |
| `checkpoint_project` | — | Salva imediatamente o projeto completo no JSON de recuperação. |
| `close_editor` | — | Salva checkpoint e fecha o processo Electron visível. |
| `restart_editor` | — | Salva, reinicia, reabre e foca a janela, restaurando o checkpoint quando necessário. |

Logs estruturados vão para stderr; `SVE_MCP_LOG_FILE` ativa um JSONL rotativo de
5 MB. Toda operação também aparece no console **MCP editing activity** dentro do
editor, e batches commitados cedem entre passos para a timeline avançar à vista.

### 2.4 Projeto, trilha e sessão

| Tool | Argumentos | Retorno |
|---|---|---|
| `open_project` | `path`, `requestId` (obrig.), `expectedRevision` | `kind` (`project` ou `settings`), `path`, `revision`, `restoredFromRevision`, `awaitingFiles`, `awaitingSounds`, `recoveryReport` (religação de caminhos). |
| `save_project` | `path` (obrig.), `kind` (`project` \| `settings`), `name` | `path`, `kind`, `bytes`, `savedProjectRevision`. Escrito em arquivo temporário irmão e publicado só após sucesso. |
| `set_project_soundtrack` | `path`, `requestId` (obrig.), `skipLeadingSilence`, `expectedRevision` | Resultado do batch + `target: 'project'`, `path`, `appliesTo`, `soundtrack`. Preferir isto a áudio por clipe, salvo pedido explícito por trecho. |
| `finish_editing` | `summary`, `requestId` | Mostra ao usuário o modal de conclusão: `{ shown: true, choices: ['preview','render'], projectRevision, checkpoint }`. |
| `preview` | `action` (`open`/`play`/`pause`/`seek`/`close`, obrig.), `time` | `{ open, playing, time, duration }`. Controla o mesmo preview da tela. |

### 2.5 Análise de áudio

| Tool | Argumentos | Retorno |
|---|---|---|
| `analyze_silence` | `requestId` (obrig.), `clipId`, `includeWaveform`, `waveformOffset`, `waveformLimit` (1–1000, padrão 250), `timeoutMs` | Array por clipe: `clipId`, `sourceDuration`, `silenceRanges`, `waveform` (`duration`, `secondsPerBucket`, `bucketCount`, `paginated: true` e, se pedido, uma página de valores), `revisionBefore`, `projectRevision`, `mutatesProject`. Sem `clipId`, analisa a timeline inteira. |
| `get_waveform_page` | `clipId` (obrig.), `offset`, `limit` (1–1000) | `clipId`, `duration`, `secondsPerBucket`, `offset`, `limit`, `returned`, `total`, `nextOffset`, e os arrays `min`, `max`, `rms`. |
| `analyze_noise` | `requestId` (obrig.), `clipId`, `content` (`speech` \| `speech-music`), `sensitivity` (`low`/`balanced`/`high`), `timeoutMs` | `{ clips[], analyzed, note }`. Usa VAD + DNSMOS; devolve status, níveis medidos, janelas de qualidade, evidências e avisos. Sem `clipId`, analisa todos os clipes audíveis. |
| `suppress_noise` | `clipId` + `requestId` (obrig.), `engine` (`gtcrn` \| `rnnoise`), `strength` (`gentle`/`balanced`/`maximum`), `preserveHighs`, `expectedRevision`, `timeoutMs` | `{ clipId, source, settings, previewReady, quietRegionChangeDb, scheduledForExport: true }`. |

> **Consentimento.** `analyze_noise` é somente-leitura quanto ao som e **nunca**
> habilita nem aplica supressão. Só chame `suppress_noise` ou
> `set_noise_suppression` quando o usuário pedir explicitamente para remover
> ruído. Não existe configuração de ruído no nível do projeto — é por clipe.

### 2.6 Transcrição

`transcribe` — `clipId` (obrigatório), `model` (`tiny`, `base`, `small`/`quality`
(padrão), `turbo`/`large`), `language` (nome Whisper, alias ISO como `pt`,
`pt-BR`, `en`, ou `auto`), `denoise`, `noiseEngine` (padrão `gtcrn`),
`noiseStrength`, `requestId`, `timeoutMs`, `stageTimeoutMs` (watchdog que
reinicia a cada avanço de estágio: decodificação, denoise, carga do modelo,
reconhecimento).

Retorno: `clipId`, `assetId`, `timeSpace: 'source'`, `language`, `model`,
`words[]` (palavra a palavra, tempo de origem), `outputWords` (filtradas e
retemporizadas pela edição atual), agrupamento por frases, e `quality`
(`wordCount`, `wordsPerMinute`, `reviewRecommended`, `fallbackModel`).

Erros próprios: `transcription_timeout`, `transcription_stage_timeout`.

### 2.7 Visão / frames

| Tool | Argumentos | Retorno |
|---|---|---|
| `get_contact_sheet` | `clipId` (obrig.), `start`, `end`, `interval` (≥0.25), `width`, `requestId` | Até **49** frames amostrados uniformemente. Cobertura visual ampla. |
| `get_frames` | `clipId` + `timestamps[]` (1–**64**, obrig.), `width` (96–1280), `quality` (0.25–0.95), `composited`, `requestId` | Frames em timestamps exatos. |

Ambos devolvem os frames como **blocos de imagem MCP nativos**, com os
timestamps de origem exatos no resultado estruturado. Ambos reportam progresso e
aceitam `cancel_operation` via o `requestId` informado.

`composited: true` passa pelo mesmo `composeFrame` do preview e do encoder, na
proporção do projeto, e devolve também `frame`, `outputTime` de cada frame, o
relatório `images` do container e `subjectLayerRendered`. Um
`subjectLayerRendered` falso significa que o modelo de segmentação não rodou
naquele frame: posição e tamanho são legíveis, oclusão não — e o cliente deve
dizer isso em vez de afirmar que a camada intermediária foi verificada.

Limite deliberado: mandar todo frame de uma gravação de uma hora seriam 100 mil
imagens. O padrão é varredura grosseira com `get_contact_sheet` e densificação
pontual com `get_frames`.

### 2.8 Edição

| Tool | Argumentos | Retorno |
|---|---|---|
| `apply_edit_batch` | `operations[]` (1–**500**) + `requestId` (obrig.), `expectedRevision`, `label`, `dryRun` | Ver abaixo. |
| `undo` | `requestId` (obrig.) | Desfaz o último grupo de edição (do usuário ou do agente). |
| `redo` | `requestId` (obrig.) | Refaz o último grupo desfeito. |

**Dry run**: `{ dryRun: true, terminalState: 'validated', operationCount, created[], durationBefore, durationAfter, removedSeconds }`.

**Commit**: `{ committed: true, terminalState: 'applied', label, operationCount, created[], durationBefore, durationAfter, removedSeconds }`.

`created[]` traz uma entrada por operação, **na ordem**, nomeando o que aquela
operação criou — `captionId`, `imageId`, `videoEffectId`, `zoomId`/`pushInId`,
`clipId`. Leia isso em vez de adivinhar ids; o dry run atribui exatamente os
mesmos ids que o commit atribuirá, então dá para planejar em cima dele.

Falha: rollback completo, `batch_rolled_back` com `terminalState: 'failed'`,
`rolledBack: true` e `restoredRevision`.

### 2.9 Exportação

`export` — `path` (obrigatório), `kind` (`video` \| `audio`), `requestId`.

Retorno: `{ path, kind, duration, partial }`. Escreve em arquivo temporário
irmão protegido e publica só depois do sucesso; o cancelamento remove o parcial
preservando qualquer destino anterior. Consulte `get_operation_status` para
progresso.

---

## 3. Operações de `apply_edit_batch`

42 tipos. Todos os tempos em **segundos de origem**.

### 3.1 Estrutura da timeline

| Operação | Campos |
|---|---|
| `remove_clip` | `clipId` |
| `move_clip` | `clipId`, `toIndex` |
| `duplicate_clip` | `clipId` |
| `split_clip` | `clipId`, `sourceTime` |
| `trim_clip` | `clipId`, `inPoint?`, `outPoint?` |
| `clear_trim` | `clipId` |
| `set_image_duration` | `clipId`, `durationSeconds` (0.1–3600) |

### 3.2 Cortes por faixa de origem

| Operação | Campos |
|---|---|
| `delete_source_range` | `clipId`, `start`, `end`, `reason?` |
| `restore_source_ranges` | `clipId` |
| `set_detected_range` | `clipId`, `rangeIndex` (≥0), `enabled` — liga/desliga um silêncio detectado |

### 3.3 Áudio

| Operação | Campos |
|---|---|
| `set_volume` | `clipId`, `volumePercent` |
| `set_audio_mode` | `clipId`, `mode`: `original` \| `replace` \| `continue` \| `mute` |
| `attach_audio` | `path` (obrig.), `clipId?` (**omita** para trilha padrão do projeto), `skipLeadingSilence?` |
| `detach_audio` | `clipId?` (omita para a trilha do projeto) |
| `set_noise_suppression` | `clipId`, `enabled` (obrig.), `engine?`, `strength?`, `preserveHighs?` — agenda para a exportação, **não** processa na hora |

> Pedido genérico de música vira sempre a trilha padrão do projeto. `clipId` só
> quando o usuário nomear um trecho específico.

### 3.4 Velocidade e ajustes por clipe

| Operação | Campos |
|---|---|
| `set_speed` | `clipId`, `speed` |
| `set_clip_edits` | `clipId`, `edits` — `cutSilence`, `fades`, `speed`, `volumePercent`, `audioMode` e sub-objetos de silêncio/autoZoom |
| `clear_clip_overrides` | `clipId` |

### 3.5 Cartões de texto e transições

| Operação | Campos |
|---|---|
| `add_text_clip` | `text` (obrig.), `atIndex?`, `durationSeconds?`, `draft?` (fonte, escala, peso, cores, alinhamento, animação, timing) |
| `update_text_clip` | `clipId` (obrig.), `text?`, `durationSeconds?`, `draft?` |
| `set_text_background` | `clipId`, `path` (string ou `null` para remover) |
| `add_transition` | `atIndex` (obrig.), `settings?` (`kind`, `seconds`, cor) |
| `update_transition` | `clipId`, `settings` |

`atIndex` é a posição de inserção no array devolvido por `get_timeline`.

### 3.6 Legendas

| Operação | Campos |
|---|---|
| `add_caption` | `clipId`, `start`, `text` (obrig.), `duration?`, `caption?` (objeto de estilo) |
| `update_caption` | `clipId`, `captionId`, `caption` |
| `remove_caption` | `clipId`, `captionId` |

Aplique o estilo **na mesma operação** que cria a legenda — o id só é conhecido
depois, e quem o nomeia é o `created[]` do batch.

Legendas ficam encostadas uma na outra no container: se as existentes chegam ao
fim dele, `add_caption` falha com **`no_room`** — atualize a que está lá em vez
de adicionar outra.

Limites de estilo (`CAPTION_LIMITS`): `fontScale` 0.02–0.4; `bottomMargin`
0–0.3; `outlinePercent` 0–30; `fadeSeconds` 0.1–5; `positionX` 0.08–0.92;
`positionY` 0.15–0.85; `rotationDegrees` −20…20; `shadowBlurPercent` 10–120;
`shadowOpacity` 0–1. Pesos: 400–900.

Legendas de fundo (grupo `background`) são texto grande e fixo composto **atrás**
de uma pessoa segmentada localmente; `fontScale` costuma ficar entre 0.20 e 0.40.
`positionX`/`positionY` são coordenadas normalizadas do quadro. Sem pessoa
detectável, o estilo é preservado e o texto é desenhado sem oclusão.

### 3.7 Tags (selos, Inscreva-se, QR Code)

| Operação | Campos |
|---|---|
| `set_tag` | `clipId`, `tag` (parcial: `text`, `shape`, `position`, `startSeconds`, `qrText`…) |
| `remove_tag` | `clipId` |

`shape: 'social-subscribe'` é o selo de inscrição; formas QR exigem `qrText` com
a URL.

### 3.8 Push-in dinâmico (zoom de ênfase)

| Operação | Campos |
|---|---|
| `add_push_in` | `clipId`, `start`, `end` (obrig.), `scalePercent?` (2–80, padrão 15), `rampSeconds?` (0–5, padrão 0.6), `easeOut?` |
| `update_push_in` | `clipId`, `pushInId`, `pushIn` (qualquer um dos campos acima) |
| `remove_push_in` | `clipId`, `pushInId` |

Aliases legados mantidos: `add_zoom`, `update_zoom` (`zoomId`, `zoom`),
`remove_zoom`.

Tempos no relógio de origem, então dá para posicionar a partir dos timestamps de
palavra da transcrição. É traduzido através dos cortes e da velocidade para a
timeline final, e o mesmo plano de zoom alimenta preview e exportação.
`easeOut: true` volta suavemente a 1x antes do `end`; `false` segura o
enquadramento fechado pelo intervalo inteiro. Vários push-ins por clipe são
permitidos. Duração: 0.2–600 s (padrão 3 s).

### 3.9 Efeitos de vídeo

| Operação | Campos |
|---|---|
| `set_video_effect` | `clipId`, `effectId` (obrig.), `intensity?` (0–1) — o container **inteiro**; `none` volta ao Original |
| `add_video_effect` | `clipId`, `start`, `effectId` (obrig.), `intensity?`, `duration?` (≥0.1), `fadeSeconds?` (0–10) — **seção temporizada** |
| `update_video_effect` | `clipId`, `videoEffectId`, `videoEffect` (`effectId`, `intensity`, `startSeconds`, `durationSeconds`, `fadeSeconds`) |
| `remove_video_effect` | `clipId`, `videoEffectId` |

Escopo: exclusivo de containers de mídia visual, nunca herdado de padrões do
projeto. Seções podem se **encostar** mas não se **sobrepor**: uma requisição
sobreposta falha com **`video_effect_overlap`**, cujo `details` traz
`maximumDuration`, `clipBounds` e cada faixa `occupied` com seu `videoEffectId`.

Para remover uma seção use `remove_video_effect`, não `effectId: 'none'` (que é
recusado, pois deixaria uma seção que não faz nada).

`fadeSeconds` 0 é corte seco; acima de 0 entra e sai suavemente, limitado a
metade da seção. Preview e exportação compartilham o mesmo motor GPU, aplicado
antes de legendas/tags, e processam os dois lados de uma transição de forma
independente.

### 3.10 Imagens posicionadas

| Operação | Campos |
|---|---|
| `add_image` | `clipId`, `path`, `start` (obrig.), `duration?` (≥0.2, padrão 4 s ou o que sobrar), `style?`, `positionX?`, `positionY?`, `scale?`, `rotationDegrees?`, `opacity?`, `fadeSeconds?` |
| `update_image` | `clipId`, `imageId`, `image` (parcial; inclui `path` para trocar a figura sem redeclarar a colocação) |
| `remove_image` | `clipId`, `imageId` |

- `path`: absoluto, dentro das raízes permitidas. Decodificada no renderer —
  nenhum byte de imagem sai da máquina. O projeto guarda só o suficiente para
  reconhecer o arquivo; uma imagem movida é reportada como ausente e a
  exportação recusa em vez de omitir silenciosamente.
- `style`: `overlay` (por cima de tudo) ou `behind-subject` (camada do meio: na
  frente do cenário, atrás de quem fala). Sem pessoa detectada, permanece
  visível.
- `positionX`/`positionY`: **centro** da imagem, em frações do quadro (0–1).
- `scale`: largura como fração da largura do quadro (0.02–2, padrão 0.35). A
  proporção é sempre mantida — este é o único controle de tamanho.
- `rotationDegrees`: −180…180; clientes de IA devem ficar em ±20 salvo pedido.
- `opacity`: 0.05–1 (padrão 1). `fadeSeconds`: 0–10 (padrão 0.3), limitado a
  metade da colocação.
- Formatos aceitos: PNG, JPEG, WebP, GIF, BMP, AVIF.
- Colocações são por container, nunca herdadas, e **podem se sobrepor**
  livremente entre si.
- Numa transição, colocações `overlay` dos dois containers continuam desenhando;
  a camada do meio se retira pela duração da junção (duas cenas = duas máscaras).
- Verificação: `get_frames` com `composited: true` é o único jeito de conferir
  que a imagem cai inteira e no lugar certo.

### 3.11 Configurações de projeto

`set_project_settings` — `settings` com: `aspect`, `reframe`, `resolution`,
`videoFormatId`, `audioFormatId`, `timelapseTargetSeconds`,
`silentCutReplacementThreshold`, `soundFade` (`fadeIn`, `fadeOut`, `seconds`),
`loudness`, `edits` (padrões de clipe), `defaultTransition`, `defaultTag`.

---

## 4. Catálogos devolvidos por `get_editor_capabilities`

O objeto é quase puro dado. Chaves de topo: `timeSpace`, `commands`,
`hostCommands`, `control`, `operationTypes`, `pushIn`, `tagShapes`,
`transitions`, `textCards`, `videoEffects`, `images`, `captions`, `project`,
`audio`, `noiseSuppression`, `semantics`.

### 4.1 `control`

`visibleWindow`, `activityModal`, `automaticCheckpoint` (caminho do JSON de
recuperação), `manualEditCheckpoint`, `mutationIdempotency`,
`orderedRendererLane`, `priorityCommands[]`.

### 4.2 Transições (25)

`dissolve`, `fade-through-black`, `fade-through-colour`, `blur-dissolve`,
`zoom-in`, `zoom-out`, `blur`, `whip-pan`, `slide-left`, `slide-right`,
`slide-up`, `slide-down`, `push-left`, `push-up`, `wipe-left`, `wipe-up`,
`clock-wipe`, `iris`, `ink-brush-down`, `ink-sweep-across`, `ink-scribble`,
`ink-spiral`, `ink-blot`, `ink-cross`, `ink-reveal-brush`.

### 4.3 Tags

**Formas simples (13):** `pill`, `rounded`, `rect`, `cut`, `pricetag`, `ribbon`,
`arrow`, `hexagon`, `bookmark`, `ticket`, `slant`, `bubble`, `circle`.

**Especiais animadas, por família:**

| Família | IDs |
|---|---|
| Layered | `bars-primary`, `bars-pink`, `bars-blue`, `bars-amber`, `bars-wine`, `bars-curved`, `square-pink`, `square-red`, `round-pink`, `round-red` |
| Petals | `petals-blob`, `petals-wind` |
| Social | `social-photo`, `social-subscribe` |
| Broadcast | `news-plate` |
| Paper | `paper-tear` |
| QR Code | `qr-photo`, `qr-subscribe`, `qr-market-yellow`, `qr-shop-orange` |

**Acabamentos (13):** `flat`, `bevel`, `emboss`, `deboss`, `cylinder`, `gloss`,
`glass`, `metal`, `neon`, `sticker`, `hollow`, `hatched`, `double`.

**Animações de entrada:** `fade`, `rise`, `slide`, `zoom`, `pop`, `drop`,
`unroll`, `unblur`, entre outras.

### 4.4 Cartões de texto (`textCards`)

- **Fontes:** `sans`, `serif`, `mono`, `condensed`, `rounded`
- **Animações:** `none`, `fade`, `typewriter`, `rise`, `blur-words`,
  `mask-zoom`, `scale-up`, `slide-lines`, `word-drop`, `tracking-in`,
  `line-reveal`, `glitch`
- **Legibilidade:** `none`, `shadow`, `outline`, `band`
- **Alinhamento:** `left`, `center`, `right` · **Vertical:** `top`, `middle`, `bottom`

### 4.5 Efeitos de vídeo (23 presets)

| Categoria | IDs |
|---|---|
| Classic | `none` (Original), `cinematic`, `dreamy`, `golden-hour`, `film`, `vintage`, `black-white`, `cinematic-warm`, `cinematic-cold`, `noir`, `vibrant` |
| Creator (usa máscara de pessoa) | `portrait-pop`, `background-blur`, `subject-glow`, `selective-color`, `background-darken`, `neon-outline` |
| Creative | `neon`, `cyberpunk`, `vhs`, `glitch`, `rgb-split`, `light-leak` |

Intensidade 0–1 (padrão dos presets: 0.75). Capacidades de visão anunciadas:
`subject` **disponível** (worker MODNet local compartilhado); `face`, `pose` e
`depth` são contrato de extensão e **não** estão disponíveis — modelos
indisponíveis nunca são anunciados como presets funcionais.

Fallback: sem pessoa → imagem original; falha de modelo/GPU → preview original
com aviso e **exportação para com erro explícito**.

### 4.6 Legendas — presets

**Grupo `classic` (11):** `classic`, `white-clean`, `yellow-shadow`,
`yellow-clean`, `black-white-shadow`, `black-white-clean`, `cyan`, `pink`,
`lime`, `editorial`, `mono`.

**Grupo `background` (Behind subject, 14):** `behind-subject` (= canto superior
central, ID legado), `behind-subject-upper-left`, `behind-subject-upper-right`,
`behind-subject-center`, `behind-subject-center-left`,
`behind-subject-center-right`, `behind-subject-zoom-in-display`,
`behind-subject-zoom-out-slab`, `behind-subject-scroll-left-geometric`,
`behind-subject-scroll-right-handwritten`, `behind-subject-scroll-up-mono`,
`behind-subject-scroll-down-serif`, `behind-subject-upper-left-display-zoom`,
`behind-subject-center-right-geometric-zoom`.

**Fontes de legenda (9):** `sans`, `rounded`, `serif`, `mono`, `impact`,
`display`, `geometric`, `slab`, `handwritten`.

**Animações de legenda (7):** `none`, `zoom-in`, `zoom-out`, `scroll-left`,
`scroll-right`, `scroll-up`, `scroll-down`. O movimento segue a duração da
própria legenda, idêntico em preview e exportação.

### 4.7 Projeto

- **Proporções:** `source` (como o material é), `9:16`, `1:1`
- **Reenquadramento:** `fill` (preenche e corta), `fit` (cabe inteiro, bordas pretas)
- **Resoluções:** `auto` (maior clipe), `3840x2160`, `1920x1080`, `1280x720`, `854x480`
- **Formatos de vídeo:** `mp4`, `webm`, `mkv`, `mov`
- **Formatos de áudio:** `m4a`, `mp3`, `ogg`, `wav`

### 4.8 Supressão de ruído

| Motor | Rótulo |
|---|---|
| `gtcrn` | Voice model (padrão) |
| `rnnoise` | Classic |

| Força | Atenuação | Nota |
|---|---|---|
| `gentle` | 12 dB | Abaixa o fundo e mantém a sala audível. |
| `balanced` | 24 dB | Padrão. Remove a maior parte do fundo sem a voz soar processada. |
| `maximum` | 40 dB | Quase silêncio entre palavras. Ouça o resultado. |

Status possíveis da análise: `Low background`, `Probable noise`,
`Relevant noise`, `Inconclusive`. Escopo: `media-clip-only`.

### 4.9 Semântica declarada

| Classe | Comandos |
|---|---|
| **Mutam o projeto** | `add_media`, `open_project`, `set_project_soundtrack`, `suppress_noise`, `apply_edit_batch`, `undo`, `redo` |
| **Estado derivado** | `analyze_silence`, `analyze_noise` |
| **Somente leitura** | `get_project`, `list_assets`, `get_timeline`, `get_waveform_page`, `transcribe`, `get_frames`, `get_contact_sheet` |

---

## 5. Códigos de erro

Erros voltam como `isError: true` com `structuredContent.error =
{ code, message, details }`.

### 5.1 Adaptador / host / caminhos

`editor_unavailable`, `editor_timeout`, `renderer_unresponsive`,
`invalid_envelope`, `invalid_arguments`, `request_id_required`,
`idempotency_conflict`, `job_not_found`, `operation_not_found`, `cancelled`,
`path_required`, `not_a_file`, `path_not_allowed`, `path_consent_denied`,
`path_consent_mismatch`, `path_consent_refused`, `checkpoint_too_large`,
`invalid_checkpoint`, `client_error`, `client_timeout`, `ffprobe_unavailable`,
`ffprobe_failed`, `ffprobe_timeout`, `ffprobe_invalid_output`.

### 5.2 Editor

`revision_conflict`, `limit_exceeded`, `batch_rolled_back`, `invalid_project`,
`media_unavailable`, `analysis_failed`, `editor_error`, `no_room`,
`video_effect_overlap`, `transcription_timeout`, `transcription_stage_timeout`.

### 5.3 `subject_vision_failed`

A exportação **para** em vez de gravar um arquivo sem o visual pedido. Um modelo
que rodou e não achou pessoa **não** é falha: mantém o fallback (legenda comum,
imagem original) e a exportação conclui.

Falha técnica traz `details` com:

- `kind`: `model-unavailable` \| `inference-failed` \| `timeout` \| `cancelled`
- `surface`: `effect` \| `caption`
- `retryable`, `recoverable`, `terminalState: 'failed'`

A saída parcial é descartada, então uma exportação anterior naquele caminho
sobrevive e o checkpoint de recuperação fica intacto.

Um cliente que receba isso **não** pode relatar a edição como concluída. Com
`retryable: true`, repita a exportação com um `requestId` novo depois de dar ao
editor a chance de recarregar o modelo; com `false`, avise o usuário e ofereça um
preset Classic de legenda ou o efeito Original.

---

## 6. Fluxo de trabalho recomendado

1. `get_recovery_state` — antes da primeira edição da sessão.
2. `queue_media_import` com caminhos absolutos; consultar `get_import_status`
   até `completed`, `partial`, `failed` ou `cancelled`.
3. `list_assets` + `get_timeline` para inventariar. `get_editor_capabilities`
   antes de escolher tag, transição, animação de texto ou formato de saída.
4. `transcribe` para cada fonte distinta com áudio.
5. `get_contact_sheet` para cobertura ampla; `get_frames` nas fronteiras de fala,
   mudanças de cena e momentos duvidosos.
6. `analyze_silence` onde a evidência de forma de onda e pausa ajudar.
7. `analyze_noise` quando o usuário pedir diagnóstico (nunca altera o áudio).
8. `suppress_noise` **somente** com pedido explícito de remover ruído.
9. `apply_edit_batch` com `dryRun: true` e a revisão atual do projeto.
10. Aplicar o mesmo batch após inspecionar o diff de duração.
11. Reler a timeline, inspecionar frames ao redor dos cortes
    (`composited: true`), `export`.
12. `finish_editing` para oferecer preview ou renderização ao usuário.

---

## 7. Configuração do cliente MCP

```json
{
  "mcpServers": {
    "simple-vlog-editor": {
      "command": "node",
      "args": ["C:\\caminho\\para\\simplevlogeditor\\electron\\src\\mcp-host.js"],
      "env": { "SVE_MCP_ROOTS": "D:\\Videos;D:\\Exports" }
    }
  }
}
```

`env` é opcional e é uma **sobreposição avançada**. Sem configuração nenhuma, o
editor já permite as pastas de mídia do usuário.

**Variáveis de ambiente:** `SVE_MCP_ROOTS`, `SVE_MCP_LOG_FILE`,
`SVE_EDITOR_PROJECT_ROOT`, `SVE_FFMPEG`, `SVE_FFPROBE`.

**Comandos manuais (a partir de `electron/`):** `npm run mcp`, `npm run mcp:dev`
(servidor Angular vivo em `http://localhost:4200`).

Cada início do desktop registra o executável atual e, quando disponível, o host
MCP de origem em `%LOCALAPPDATA%\SimpleVlogEditor\editor-location.json`.

---

## 8. Limites numéricos (resumo)

| Item | Limite |
|---|---|
| Operações por batch | 500 |
| Caminhos por importação | 100 |
| Concorrência de importação | 1–2 |
| Frames por `get_frames` | 64 |
| Frames por `get_contact_sheet` | 49 |
| Largura de frame | 96–1280 px |
| Qualidade de frame | 0.25–0.95 |
| Página de waveform | 1–1000 buckets (padrão 250) |
| Push-in `scalePercent` | 2–80 |
| Push-in `rampSeconds` | 0–5 |
| Push-in duração | 0.2–600 s |
| Intensidade de efeito | 0–1 |
| `fadeSeconds` (efeito/imagem) | 0–10 |
| Duração de imagem estática | 0.1–3600 s |
| `scale` de imagem | 0.02–2 |
| `opacity` de imagem | 0.05–1 |
| Rotação de imagem | −180…180 (IA: ±20) |
| `timeoutMs` de operações | 1000–3 600 000 |
| Log JSONL rotativo | 5 MB |
| Gate de inicialização | 30 s |
| Timeout de `roots/list` | 10 s |
