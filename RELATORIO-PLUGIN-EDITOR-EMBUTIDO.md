# Relatório — plugins com e sem o editor embutido, descoberta do editor e skill de edição de vlog

> **Atualização:** o plugin do Codex com o editor embutido foi descontinuado. Hoje só existem os plugins sem editor (Claude Code e Codex), que usam o SimpleVlogEditor instalado no computador. O conteúdo abaixo é histórico.

Data: 21/09/2026. Tudo abaixo foi implementado no repositório e testado; os testes de ponta a ponta
rodaram no Windows x64 real, a partir dos ZIPs extraídos em pastas com espaços e acentos.

## 1. Arquivos criados

| Arquivo | Para quê |
|---|---|
| `electron/src/mcp-stdio-entry.js` | Modo `SimpleVlogEditor.exe --mcp-stdio`: sem janela, sem lock de instância única; reinicia o próprio executável como Node no `mcp-host.js` com stdio herdado |
| `electron/src/mcp-packaging.test.js` | 8 testes: comando de abertura da janela empacotada, pipe por usuário, negação da pasta do runtime, FFprobe, flags do `--mcp-stdio`, stdout puro do host real e saída ao fechar stdin |
| `electron/vendor/ffprobe/README.md`, `electron/vendor/ffprobe/win32-x64/.gitkeep` | Ponto opcional para embutir um `ffprobe.exe` (ver pendências) |
| `ai-client/build-plugins.mjs` | Pipeline dos plugins com editor embutido (staging, runtime, testes, doctor, ZIP, teste isolado, publicação, relatório de tamanho) |
| `ai-client/package.json` | `npm test`, `npm run test:e2e`, `npm run build:plugins` |
| `ai-client/tests/launcher.test.mjs` | 14 testes do launcher com runtime falso (Node copiado como executável) |
| `ai-client/tests/e2e-runtime.test.mjs` | Teste real: handshake, janela, recuperação, `restart_editor`, `close_editor`, processos órfãos |
| `ai-client/tests/fixtures/fake-mcp-host.cjs` | Host MCP falso usado pelos testes do launcher |
| `…/scripts/plugin-info.mjs` | Identifica o cliente (Claude/Codex) e a variante (com/sem runtime) pela própria pasta |
| `…/scripts/runtime-location.mjs` | Resolve `runtime/<plataforma>-<arch>/`, valida executável, `app.asar` e `realpath` dentro do plugin |
| `…/scripts/binary-inspect.mjs` | Lê o índice do `app.asar` e o cabeçalho PE (arquitetura) sem executar nada |
| `…/scripts/editor-discovery.mjs` | Procura o editor instalado/portátil/embutido/checkout (variante sem editor) |
| `…/scripts/mcp-proxy.mjs` | Proxy stdio transparente + ciclo de vida (stdin, sinais, disconnect, saída do filho, EPIPE) |
| `…/scripts/setup-server.mjs` | Modo "editor não encontrado": ferramenta `locate_editor` (seletor de arquivo nativo ou caminho informado na conversa) e troca a quente para o host real |
| `…/scripts/launcher-core.mjs` | Decide o que iniciar (`bundled` / `installed` / `dev`) |
| `…/scripts/mcp-probe.mjs` | Cliente MCP mínimo usado pelo doctor e pelos testes |
| `…/skills/edit-vlog/SKILL.md` | **Nova skill** de edição autônoma de vlog (as 39 fases do documento, mapeadas para as tools reais) |
| `…/skills/edit-vlog/references/push-in-after-silence.md` | Exemplo numérico do push-in após silêncio removido |
| `RELATORIO-PLUGIN-EDITOR-EMBUTIDO.md` | Este relatório |

`…` = `ai-client/claude/plugins/simple-vlog-editor` **e** `ai-client/codex/plugins/simple-vlog-editor`
(scripts e skills idênticos nos dois; há um teste que garante isso).

## 2. Arquivos modificados

| Arquivo | Alteração |
|---|---|
| `electron/src/main.js` | `--mcp-stdio` tratado antes de tudo; `SVE_USER_DATA_DIR` (perfil isolado, inclusive `roots.json` e `editor-location.json`); pasta do executável negada como mídia; FFprobe via resolvedor |
| `electron/src/mcp-host.js` | `console.log/info/debug` → stderr; EPIPE no stdout encerra em silêncio; `--controller`; sai 1,5 s após stdin fechar (antes podia ficar até 30 min órfão) e em `disconnect` |
| `electron/src/editor-process-manager.js` | `require('electron')` virou preguiçoso; janela aberta pelo próprio `.exe` (`--mcp-open`) quando o host roda empacotado; detecção de janela que morre antes de responder (`editor_start_failed`); `launchMode` nos diagnósticos |
| `electron/src/ipc-endpoint.js` | Pipe **por usuário** (não mais por pasta de instalação) → um host de qualquer cópia encontra a janela aberta por outra; `SVE_EDITOR_ENDPOINT` para isolamento |
| `electron/src/mcp-roots.js` | Opção `denied`: a pasta do programa nunca é mídia, mesmo dentro de Downloads/Documentos |
| `electron/src/media-import-service.js` | `ffprobeExecutable()`: `SVE_FFPROBE` → `resources/bin/ffprobe.exe` → PATH |
| `electron/package.json` | testes novos; `pack:dir`, `mcp:stdio`, `build:plugin:win-x64`, `build:plugin:win-x64:reuse`; testes fora do `app.asar`; `vendor/ffprobe` como extraResource |
| `electron/scripts/publish-installer.js` | preserva a chave `plugins` do `installer.json` |
| `electron/MCP.md` | seção "Packaged MCP host (`--mcp-stdio`)" |
| `web/scripts/build-desktop.js` | depois do instalador, chama `build-plugins.mjs --skip-electron` |
| `web/src/app/shared/desktop/download.service.ts` | caminhos dos 2 novos ZIPs e tipo `plugins` no manifesto |
| `web/src/app/app.component.html` | menu de download: grupo "AI plugin with the editor included" com Codex + editor e Claude Code + editor (com tamanho) |
| `web/src/app/shared/ui/help-panel.component.ts` | as duas variantes na ajuda |
| `build.bat` | nova ordem documentada, modo `build.bat plugins`, resumo com os 4 plugins |
| `…/scripts/mcp-launcher.mjs`, `doctor.mjs`, `version-check.mjs` | reescritos (launcher = proxy; doctor testa o pacote embutido, `--runtime-only`, `--no-launch`, `--close-editor`, `--register`, `--platform`) |
| `…/skills/edit-video/SKILL.md`, `references/mcp-operations.md` | modo setup (`locate_editor`) e ponte para `edit-vlog` |
| `…/README.md`, `ai-client/claude/README.md`, `ai-client/claude/install.ps1` | variantes, "Bundled editor runtime", tamanho, descoberta; instalação dev usa `doctor --register` |
| `.claude-plugin/plugin.json` 1.6.0 → **1.7.0**; `.codex-plugin/plugin.json` 2.6.0 → **2.7.0**; `marketplace.json` | versão, palavras-chave, prompt padrão de edição autônoma |
| `ai-client/codex/src/client.test.mjs` | teste de localização migrado para `editor-discovery.mjs` |
| `web/src/assets/download/simple-vlog-editor-{claude,codex}.zip` | reempacotados com os novos scripts e a nova skill |

## 3. Arquivos removidos

`scripts/editor-location.mjs` (nos dois plugins) deixou de ter função e foi substituído por
`editor-discovery.mjs`. Como esta sessão não tem permissão de apagar, ele foi **movido** para
`_to_delete/` — junto com o `app.asar` antigo do `win-unpacked`, um `.git/index.lock` vazio que
um `git status` meu deixou, o script e o log do teste no Windows. Pode apagar a pasta `_to_delete` inteira.

## 4. Arquitetura escolhida

O projeto **já** tinha um supervisor: `mcp-host.js` (Node) é dono do stdio e fala com a janela
Electron por named pipe; `restart_editor`/`close_editor` fecham e reabrem a janela sem derrubar
a sessão MCP. Por isso o Electron **não** pode ser o servidor stdio filho único. A solução
reaproveita esse host sem reescrevê-lo — só muda quem o executa:

```text
Claude / Codex
   │ MCP stdio
   ▼
node scripts/mcp-launcher.mjs          ← proxy transparente (pipe byte a byte), logs só em stderr
   │ spawn(exe, args, shell:false)
   ▼
SimpleVlogEditor.exe <runtime>/resources/app.asar/src/mcp-host.js --mcp-stdio --controller claude-code
   (ELECTRON_RUN_AS_NODE=1 → o próprio executável roda como Node, lendo o host de dentro do asar)
   │ named pipe por usuário
   ▼
SimpleVlogEditor.exe --mcp-open        ← janela real, destacada (sobrevive à sessão), aberta na 1ª tool
```

- Variante **com editor**: runtime em `runtime/win32-x64/`, localização determinística a partir de
  `import.meta.url`; nunca consulta `SVE_EDITOR_PROJECT_ROOT`, `editor-location.json` nem o repositório.
- Variante **sem editor**: procura em `SVE_EDITOR_EXECUTABLE`/`SVE_EDITOR_PROJECT_ROOT`, escolha anterior
  do usuário, último editor aberto, **registro de desinstalação do Windows (instalador)**, pastas padrão do
  instalador, **cópias portáteis** (Desktop, Downloads, Documentos, OneDrive, home), editor embutido de outro
  plugin instalado, checkout de desenvolvimento. **Se não achar, pergunta**: o servidor MCP sobe só com
  `locate_editor`, que abre um seletor de arquivo na tela do usuário ou aceita o caminho que ele disser na
  conversa; ao acertar, grava a escolha, inicia o host real na mesma sessão e envia `tools/list_changed`.
  Um editor instalado antigo demais é reconhecido (lendo o `app.asar`) e reportado como desatualizado.
- `SimpleVlogEditor.exe --mcp-stdio` também existe como porta de entrada manual; o plugin pula esse salto.
- Cenário B (editor já aberto): o pipe agora é por usuário, então o host conecta na janela já aberta
  (de qualquer cópia). Cenário C: fechar stdin encerra launcher e host; SIGINT/SIGTERM/disconnect são
  repassados; host que não sai é morto após 5 s; a janela fica aberta (é o editor do usuário).
- Dados do usuário continuam em `%APPDATA%`/`%LOCALAPPDATA%`; `SVE_MCP_ROOTS`, pastas padrão,
  consentimentos e negações preservados, e a pasta do runtime foi adicionada à lista de negação.
- Recursos (etapa 9): **A** executável, DLLs, `.pak`, `locales`, `app.asar`, `resources/site`;
  **B** modelos pequenos já no site (GTCRN, Silero VAD, DNSMOS ≈ 4 MB) e ONNX Runtime WASM (35 MB) — embutidos;
  **C** Whisper e MODNet — continuam baixados sob demanda e guardados no cache do perfil do editor, como antes;
  **D** FFprobe — externo (PATH) como sempre foi; agora pode ser embutido opcionalmente.

## 5. Processo de build

```powershell
build.bat                      # tudo: site + instalador + portátil + 4 plugins (com teste isolado)
build.bat plugins              # só os plugins com editor, reaproveitando electron\release\win-unpacked
cd electron; npm run build:plugin:win-x64          # pipeline completo só dos plugins (deps, site, pack dir, ...)
cd electron; npm run build:plugin:win-x64:reuse    # idem, reaproveitando o win-unpacked
```

`SVE_SKIP_PLUGIN_E2E=1` pula o teste isolado; `SVE_SKIP_EMBEDDED_PLUGINS=1` pula os plugins com editor.

## 6. Artefatos

- `dist/plugin/simple-vlog-editor-claude-win32-x64.zip`
- `dist/plugin/simple-vlog-editor-codex-win32-x64.zip`
- publicados como `web/src/assets/download/simple-vlog-editor-{claude,codex}-with-editor-win-x64.zip`
  (e em `web/dist/browser/assets/download`), com tamanhos em `installer.json`
- relatório de tamanho: `dist/plugin/build-report.json`

## 7. Tamanho

| Item | Tamanho |
|---|---|
| Plugin antigo (sem editor) | 26–27 KB |
| Runtime Electron (`win-unpacked`) | 416 MB |
| **Novo ZIP (cada cliente)** | **167,4 MB** |
| Maiores partes do runtime | `SimpleVlogEditor.exe` 234,7 MB · locales do Chromium 48,3 MB · DLLs GPU 39,6 MB · ONNX Runtime WASM 34,8 MB · `.pak/.dat/.bin` 25,2 MB · licenças 19,5 MB · interface 9,6 MB · modelos 3,9 MB |
| FFmpeg/modelos extras | 0 (FFprobe não embutido; modelos grandes continuam sob demanda) |

Sugestão, não aplicada (mudaria também o instalador): limitar `electronLanguages` a `en-US`/`pt-BR`
reduziria ~45 MB descompactados.

## 8. Testes executados

| Comando | Onde | Resultado |
|---|---|---|
| `npm run test:mcp` (electron) | Linux | 101/101 |
| `node --test ai-client/tests/launcher.test.mjs` | Linux | 14/14 |
| idem (dentro do build) | Windows | 12 ok, 2 pulados por plataforma (symlink, sinais POSIX) |
| `node --test ai-client/codex/src/client.test.mjs` | Linux | 8/8 |
| `ngc -p tsconfig.app.json --noEmit` (templates Angular) | Linux | ok |
| `doctor.mjs --runtime-only --no-launch --platform win32-x64` nos 2 plugins | Windows | ok |
| `build-plugins.mjs --skip-electron` completo | Windows | `EXITCODE=0` |

## 9. Teste isolado

Confirmado no Windows para **os dois** ZIPs: cada um foi extraído em
`%TEMP%\SVE Plugin Tést <cliente> …\Instalação do Plugin\simple-vlog-editor`, com
`SVE_EDITOR_PROJECT_ROOT` removido do ambiente, `SVE_RUNTIME_MODE=bundled`, diretório de trabalho fora do
repositório, perfil e pipe próprios. O doctor (`--runtime-only --close-editor`) e o teste e2e passaram:
handshake MCP, 33 tools, janela Electron criada pelo executável embutido (`launchMode: packaged`),
checkpoint de recuperação no perfil (fora do plugin), `restart_editor` com novo PID e o antigo encerrado,
`close_editor` sem zumbi, reabertura sob demanda, stdout só com MCP, launcher saindo com a sessão e nenhum
processo de janela sobrevivendo ao teste.

## 10. Pendências

- **FFprobe**: importar mídia via MCP continua exigindo FFprobe no PATH (como já exigia no instalador). Para o
  plugin ser 100 % autocontido nesse ponto, coloque um `ffprobe.exe` + licença em
  `electron/vendor/ffprobe/win32-x64/` — o build passa a embuti-lo. Não baixei binário por causa da licença (GPL/LGPL).
- O `win-unpacked` usado no teste foi o existente com o `app.asar` reempacotado a partir do código novo; o
  próximo `build.bat` completo regenera tudo com electron-builder.
- Duas janelas de teste do SimpleVlogEditor das duas primeiras execuções (que falharam antes de fechar) podem
  ter ficado abertas, rodando de `%TEMP%\SVE Plugin Tést claude …` — pode fechá-las. `dist/plugin/` ocupa ~1,2 GB
  (é saída de build, ignorada pelo git).
- `ai-client/claude/simple-vlog-editor.zip`, `.plugin` e `ai-client/codex/simple-vlog-editor.zip` são artefatos
  antigos feitos à mão, fora do pipeline; não foram mexidos.
- Só Windows x64 é empacotado; `runtime-location.mjs` já tem a tabela para win32-arm64, darwin e linux.
