# Efeitos de vídeo por trecho — SimpleVlogEditor

## DIRETÓRIO DO PROJETO

`C:\Users\joaor\ferramentas\simplevlogeditor`

- `web` — editor e processamento audiovisual (Angular 17)
- `electron` — aplicativo desktop e servidor MCP
- `ai-client` — cliente e plugin de IA (Codex)

## OBJETIVO

Hoje um efeito de vídeo vale para o **clipe inteiro**: `MediaClip.videoEffect` é um único `{ id, intensity }`. Quero poder aplicar efeitos **em trechos diferentes do mesmo vídeo**: adicionar um efeito, indicar quando começa e quando termina, ter vários no mesmo clipe, e excluir qualquer um deles — exatamente como já funciona com as legendas.

Não quero apenas análise ou plano: implemente, teste e documente. Antes de alterar o código, confirme no repositório que o que está descrito abaixo continua verdadeiro — as âncoras de arquivo e linha foram levantadas numa sessão anterior e podem ter se deslocado.

## DECISÕES JÁ TOMADAS

Não as reabra sem um motivo técnico concreto.

1. **Espelhar legendas.** O modelo, a conversão para o plano e a resolução por instante seguem o mesmo desenho de `ClipCaption` / `CaptionSegment` / `captionAt`. Não invente uma estrutura paralela.
2. **Relógio da fonte.** `startSeconds` e `durationSeconds` são medidos no arquivo original, como nas legendas, e são traduzidos para o relógio de saída na construção do plano.
3. **Sem sobreposição.** Dois efeitos não podem ocupar o mesmo instante, a mesma regra que as legendas já seguem ("They cannot overlap"). O editor impede ao criar e ao editar as bordas.
4. **Entrega em duas etapas.** A etapa 1 é núcleo + testes, sem UI e sem MCP. A etapa 2 só começa depois que a etapa 1 compilar e a suíte passar.

## REGRAS OBRIGATÓRIAS

1. Inspecione as instruções do repositório e o estado atual dos arquivos antes de editar.
2. **Projetos salvos têm de continuar abrindo.** `videoEffect` permanece sendo lido e vira um trecho que cobre o clipe inteiro. Continue escrevendo `videoEffect` quando o clipe tiver exatamente um trecho de clipe inteiro, para que um projeto simples salvo pela versão nova ainda abra na versão antiga.
3. Não remova presets, controles, animações, ferramentas MCP ou recursos existentes.
4. Video Effects continuam **exclusivos de cada container**: sem configuração global, sem herança de `ProjectSettings`, sem herança via `ClipEdits`.
5. Preserve cortes, velocidades, push-ins, transições, tags, captions, áudio, checkpoints, recuperação, duplicação e desfazer/refazer. Duplicar ou dividir um clipe copia seus trechos de efeito de forma independente.
6. Processamento de IA continua local. Nenhum frame sai da máquina.
7. Não altere projetos pessoais durante os testes. Use fixtures e projetos temporários.
8. Não esconda falhas com mensagens de sucesso nem com exportações visualmente diferentes do solicitado.
9. Mensagens de interface e logs em inglês, conforme o padrão atual do projeto.

---

# ETAPA 1 — núcleo e testes

Sem UI e sem MCP. Ao final desta etapa o recurso existe no modelo, no plano, na composição e na serialização, e é exercitado por testes unitários.

## 1.1 Modelo

Em `web/src/app/ferramentas/editor-de-video/video-editor.models.ts`:

- Crie `ClipVideoEffect` espelhando `ClipCaption` (~linha 70): `id?: string`, `effectId: string`, `intensity: number`, `startSeconds?: number`, `durationSeconds?: number`. Omitir início e duração significa "o clipe inteiro", como nas legendas antigas.
- Em `MediaClip` (~linha 384, onde está `videoEffect?: VideoEffect`), acrescente `videoEffects?: ClipVideoEffect[]` e **mantenha** `videoEffect?: VideoEffect` com um comentário dizendo que ele existe apenas para abrir projetos antigos — o mesmo par que `captions` / `caption` já formam em ~linha 397.
- Crie `VideoEffectSegment { start: number; end: number; effect: VideoEffect }` ao lado de `CaptionSegment` (~linha 564).
- Acrescente `videoEffects: VideoEffectSegment[]` a `ProjectPlan`, ao lado de `captions` (~linha 691).

## 1.2 Construção do plano

Em `video-editor-timeline.ts`:

- `appendCaption` (~linha 1224) é o molde exato. Escreva `appendVideoEffect` com a mesma assinatura e a mesma aritmética: `clipBounds`, `cutTimeOf(keepRanges, sourceTime) / speed`, recorte contra `start + duration`, descarte de segmentos menores que `EPSILON`.
- O fallback do campo legado é idêntico ao das legendas: se `clip.videoEffects` estiver vazio e `clip.videoEffect` tiver um efeito diferente de `none`, trate como um trecho cobrindo `bounds.start`..`bounds.end`.
- Declare o acumulador junto de `const captions: CaptionSegment[] = []` (~linha 293), chame `appendVideoEffect` onde `appendCaption` é chamado (~linha 554), ordene com `byStart` (~linha 574) e inclua no objeto do plano (~linha 603).
- Escreva `videoEffectAt(segments, time): VideoEffect | null` espelhando `captionAt` (~linha 1312). Sem fade e sem progress: um instante tem um efeito ou nenhum.
- `slicePlan` (~linha 1435 e ~1455) precisa deslocar `videoEffects` como já faz com `captions`, **incluindo** o retorno antecipado do plano vazio.
- Escreva um utilitário de validação de sobreposição reutilizável pela UI da etapa 2 — algo como `videoEffectSlotFor(clip, startSeconds)` devolvendo a maior duração livre a partir de um instante, espelhando `captionMaximumDuration` / `captionMinimumStart` que o componente já usa.

## 1.3 Composição

Em `frame-compositor.ts`:

- `effectedSource` hoje lê `clip.clip.videoEffect`. Passe a resolver pelo plano: `videoEffectAt(plan.videoEffects, time)`.
- O relógio do efeito continua sendo o tempo local do clipe (`time - clip.outputStart`), que é o que prévia e exportação já compartilham. **Não** troque para tempo relativo ao trecho sem antes decidir conscientemente: mudar isso muda a fase de VHS, Glitch e Light Leak. Documente a escolha.
- `needsCompositing` precisa considerar que existe efeito naquele instante, não que o clipe tem um efeito.
- O caminho da transição compõe cada lado com o efeito do seu próprio clipe; mantenha isso, resolvendo o efeito de cada lado no instante da transição.

Em `video-effect-engine.ts`:

- O engine guarda `this.last` e superfícies reutilizáveis. Confirme que trocar de preset entre um quadro e o seguinte, dentro do mesmo clipe, não vaza estado: `render` relê `settings` a cada quadro, mas `occlusionMask` depende de `this.last`, e o `VideoEffectShader` é criado uma vez por lane.
- A fronteira entre dois trechos é um corte visual. Decida e documente se há transição entre eles (recomendo: não há, é um corte seco, como uma legenda que troca).

## 1.4 Serialização

Em `video-editor-project.store.ts`:

- `StoredMediaClip` (~linha 113) ganha `videoEffects?`, mantendo `videoEffect?`.
- Na escrita (~linha 286) e na leitura (~linha 391), siga o padrão condicional que o arquivo já usa (`...(clip.x ? { x } : {})`), para que o documento de um projeto sem efeitos por trecho continue byte a byte o que sempre foi.
- Normalize cada trecho com `normalizeVideoEffect` na leitura, descartando trechos com `effectId` desconhecido ou duração não finita.
- **Cuidado com o tamanho do documento.** `thumbUrl` já é serializado e o checkpoint de recuperação é reescrito a cada edição; não acrescente nada volumoso por trecho.

## 1.5 Testes da etapa 1

Em `video-editor-timeline.spec.ts` e `video-effects.spec.ts`:

1. Um clipe com dois trechos produz dois `VideoEffectSegment` em tempo de saída, nas posições certas.
2. `videoEffectAt` devolve o efeito certo dentro de cada trecho e `null` na lacuna entre eles.
3. Trechos respeitam cortes: um trecho que atravessa uma faixa deletada encolhe do jeito que uma legenda encolheria.
4. Velocidade 2× divide por dois a duração do trecho na saída.
5. Trim que remove o início do clipe desloca os trechos.
6. `slicePlan` desloca os trechos junto com as legendas.
7. Projeto antigo com `videoEffect` abre como um trecho cobrindo o clipe inteiro; a composição desse projeto é idêntica à de antes.
8. Round-trip de serialização preserva trechos, e um clipe com um único trecho de clipe inteiro ainda escreve `videoEffect`.
9. Duplicar um clipe copia os trechos sem compartilhar referência.
10. `needsCompositing` é falso num instante sem efeito e verdadeiro dentro de um trecho.
11. Sobreposição é rejeitada pelo utilitário de validação.
12. Desfazer e refazer restauram a lista de trechos.

**Critério para encerrar a etapa 1:** `npm run build:site` passa e `npm test -- --watch=false --browsers=ChromeHeadless` está verde.

---

# ETAPA 2 — interface e MCP

Só comece depois da etapa 1 compilando e verde.

## 2.1 Interface

O padrão a copiar é a seção de legendas em `editor-de-video.component.html` (~linha 2170 em diante) com o CSS em `editor-de-video.previa.css` (~linha 861 em diante, `.caption-lista`, `.caption-item`, `.caption-resumo`, `.caption-resumo-linha`, `.caption-topo`).

- Lista de trechos, cada um recolhido mostrando início, duração e o nome do preset, com um **X para excluir** na própria linha recolhida — note que a linha do resumo é um `<button>` largo, então o X vive ao lado dele dentro de `.caption-resumo-linha`, nunca aninhado.
- Trecho expandido mostra a galeria de efeitos (`app-video-effects-gallery`), o slider de intensidade, início e duração, e o X.
- Botão `Add effect at {{ formatTime(playhead) }}`, desabilitado quando não há espaço livre no instante atual, espelhando `canAddCaption`.
- A galeria hoje recebe `[effect]` e emite `(effectChange)` para o clipe. Passe a operar sobre o trecho aberto.
- Aviso quando o trecho for truncado pelo fim do clipe, como `captionOverflows` faz.
- Mantenha responsividade e acessibilidade no padrão do editor: `aria-label` em cada botão, `:focus-visible`, e o comportamento abaixo de 620px conferido.

## 2.2 MCP

- `editor-agent-api.ts`: acrescente `add_video_effect`, `update_video_effect` e `remove_video_effect` a `EditorAgentOperation`. **Mantenha `set_video_effect`** funcionando como "o clipe inteiro" — um cliente antigo não pode quebrar.
- `electron/src/mcp-server.js`: as entradas correspondentes em `EDIT_OPERATIONS`, com os mesmos limites e validações dos vizinhos.
- `editor-de-video.component.ts`: a lista de nomes de operação (~linha 9500), o rótulo legível de cada uma no console de atividade (~linha 10038) e a execução em `agentApplyOperation` (~linha 10315). Siga `add_caption` / `update_caption` / `remove_caption` como molde, incluindo revisão, idempotência, checkpoint e um passo de desfazer por lote.
- `get_timeline` passa a devolver os trechos de cada clipe. `get_editor_capabilities` deve anunciá-los.
- Erro claro e acionável quando um trecho pedido sobrepõe outro — nunca aceitar em silêncio e recortar.

## 2.3 Documentação

- `VIDEO_EFFECTS.md`: o modelo por trecho, o relógio, a regra de não sobreposição, a compatibilidade com projetos antigos e o que acontece na fronteira entre dois trechos.
- `electron/MCP.md`: as três operações novas na lista de `apply_edit_batch`, com um exemplo.
- `ai-client/codex/EDITOR_AGENT.md` e `ai-client/codex/plugins/simple-vlog-editor/skills/edit-video/SKILL.md`: quando usar um trecho em vez do clipe inteiro, e a regra de não sobreposição.
- Se o plugin mudar, rode `node .\plugins\simple-vlog-editor\scripts\doctor.mjs` e suba a versão em `plugin.json`.

## 2.4 Testes da etapa 2

13. Adicionar, editar e excluir um trecho pela interface.
14. Excluir pelo X da linha recolhida sem abrir o trecho.
15. Tentativa de sobreposição bloqueada na interface e recusada pelo MCP com erro estruturado.
16. `apply_edit_batch` com as três operações novas, em dry-run e comprometido, com `expectedRevision` e `requestId`.
17. Um lote é um passo de desfazer.
18. Reabrir o projeto preserva os trechos.
19. Recuperação do Electron após reinício preserva os trechos.

---

## ESTADO ATUAL DO REPOSITÓRIO — leia antes de começar

- `ng serve` estava compilando na última verificação.
- **A suíte de testes nunca foi executada por completo.** Vários specs recentes (anel de sombra no Background Blur, filtragem de regiões da matte, enquadramento de captions animados, latência adaptativa) foram escritos mas nunca rodados. Rode `npm test` **antes** de começar e conserte o que estiver vermelho, para não confundir falha pré-existente com regressão sua.
- Há bastante trabalho recente sem commit. Faça `git add -A && git commit` antes da primeira alteração.

## ENTREGA

Ao final de cada etapa, apresente:

- O que foi implementado e onde.
- Arquivos principais alterados.
- Testes executados e resultado real — não declare validação visual que não foi feita.
- Evidência de que projetos salvos antigos continuam abrindo idênticos.
- Limitações e pendências.
- Como testar no Web, no Electron e pelo MCP.

Compile os projetos afetados. Se gerar instalador, confirme que ele contém o Web atualizado.
