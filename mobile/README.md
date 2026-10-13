# SimpleVlogEditor para Android

Projeto Android nativo em Java que incorpora o projeto Angular de `../web`
em uma WebView. O HTML, os scripts, as imagens e os modelos locais são
empacotados no APK; não é necessário executar um servidor web para abrir o app.

## Requisitos

- Android Studio com SDK Android 36 e Build Tools 35.0.0.
- JDK 17 ou superior compatível com Gradle 8.14.3; o JDK do Android Studio serve.
- Node.js compatível com o Angular 17 e as dependências do projeto web.
- Android 8.0 (API 26) ou superior no aparelho, com Android System WebView atualizado.

## Abrir e compilar

1. Instale as dependências do projeto web:

   ```powershell
   cd web
   npm ci --ignore-scripts
   ```

2. Abra a pasta `mobile` no Android Studio, aguarde a sincronização e execute
   o módulo `app` em um aparelho ou emulador.

O Gradle executa `scripts/prepare-web.mjs` antes de compilar: gera o Angular
com o target `build-mobile:production` e copia o resultado para os assets
gerados do aplicativo. Alterações em `web/src` são incorporadas no próximo build.
Essa configuração não gera SSR nem instaladores Electron, e exclui os downloads
para Windows do APK. O menu de download do desktop fica oculto no aplicativo.

Para gerar o APK pelo terminal, dentro de `mobile`:

```powershell
.\gradlew.bat assembleDebug
```

No Linux/macOS: `sh gradlew assembleDebug`. O resultado fica em
`app/build/outputs/apk/debug/app-debug.apk`.

Se o SDK não for localizado, configure `ANDROID_HOME` ou crie `local.properties`
com `sdk.dir=C:/caminho/para/Android/Sdk`. Configure `JAVA_HOME` para o JDK.
Se o Node não estiver no PATH, use `-PnodeBinary=C:/caminho/para/node.exe`.

Para preparar somente os assets:

```powershell
node scripts/prepare-web.mjs
```

Para copiar um build mobile já gerado: `node scripts/prepare-web.mjs --skip-build`.
Os builds e assets gerados não são versionados. Para distribuição, configure
a assinatura de release no Android Studio e gere um APK/AAB assinado.

## Integração com o aparelho

- Conteúdo servido em `https://appassets.androidplatform.net/` por
  [WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content),
  preservando URLs absolutas, contexto HTTPS e rotas Angular.
- JavaScript, armazenamento local, WebAssembly e reprodução de mídia habilitados.
- Seleção de um ou vários arquivos pelo seletor Android, sem permissão ampla de armazenamento.
- Exportações `Blob`, `data:` e links com `download` salvos pelo seletor de destino
  do Android. Transferência em blocos de 192 KiB, com confirmação de cada bloco.
- Ponte de salvamento restrita à origem local e ao frame principal.
- Microfone sujeito à permissão Android; câmera e captura de tela não são implementadas.
- Botão Voltar percorre o histórico; vídeos podem ocupar a tela; links externos
  abrem no navegador. O conteúdo respeita barras do sistema e teclado.
- Inspeção da WebView habilitada apenas em builds de debug.

## Limites do ambiente Android

A interface e os recursos locais abrem sem servidor. Fontes externas e modelos
obtidos sob demanda da internet ainda precisam de conexão. A disponibilidade de
WebCodecs, codecs de vídeo, WebGPU, memória e execução de modelos depende do
aparelho e da versão da WebView. A captura de reuniões por `getDisplayMedia` não
é implementada neste wrapper; importe a gravação como arquivo.

Os headers COOP/COEP acompanham os assets locais, mas o suporte a isolamento de
origem e `SharedArrayBuffer` depende da WebView. O app não inclui o backend,
as APIs de filesystem do Electron nem o servidor MCP do desktop.

## Verificação da ponte

```powershell
node --test tests/mobile-bridge.test.mjs
```

Em um aparelho, verifique abertura da home e das ferramentas, seleção de mídias,
exportação de um vídeo e de uma legenda, cancelamento do seletor, reprodução,
rotação, botão Voltar e abertura de links externos. Use um arquivo pequeno primeiro
para confirmar os codecs disponíveis naquela WebView.

Validação inicial realizada: build Angular, `assembleDebug`, `lintDebug` sem
erros e seis testes da ponte aprovados. Em emulador Android API 36.1, a home
carregou, a origem foi reconhecida como HTTPS seguro, uma rota Angular retornou
HTML e assets inexistentes retornaram 404. Uma exportação de texto foi salva
pelo seletor Android e seu conteúdo foi conferido. Nesse emulador `VideoEncoder`
estava disponível e `SharedArrayBuffer` não estava. Renderização completa de
vídeo e seleção de mídia ainda devem ser verificadas no aparelho de destino.
