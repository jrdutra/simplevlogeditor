@echo off
setlocal enabledelayedexpansion

rem ===========================================================================
rem  SimpleVlogEditor - build completo
rem
rem  Um comando so, nesta ordem:
rem    1. plugins do Claude Code e do Codex (zips pequenos, sem o editor
rem       embutido: procuram o editor instalado no computador)
rem    2. site (web\dist\browser)
rem    3. aplicativo desktop: instalador .exe + portatil .zip (electron-builder)
rem
rem  A pasta ai-client\simplevlogeditor-codex-plugin e a raiz do repositorio GitHub do plugin
rem  do Codex (marketplace + plugins\simple-vlog-editor): nao ha copia para
rem  atualizar, basta fazer commit dela depois do build.
rem
rem  Ao terminar, "web\dist\browser" ja pode subir com tudo dentro.
rem
rem  Uso:  build.bat          tudo (site + instalador + os 2 plugins)
rem        build.bat site     apenas o site (sem empacotar o desktop)
rem ===========================================================================

cd /d "%~dp0"

set "MODO=%~1"
if /i "%MODO%"=="site" (set "ALVO=build:site") else (set "ALVO=build")

echo.
echo ===============================================
echo   SimpleVlogEditor
if /i "%MODO%"=="site" (
  echo   site apenas
) else (
  echo   site + instalador + plugins
)
echo ===============================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERRO] npm nao encontrado no PATH. Instale o Node.js e abra um terminal novo.
  goto :fim_erro
)

rem --- dependencias -----------------------------------------------------------
rem  --ignore-scripts no site: @huggingface/transformers arrasta onnxruntime-node,
rem  cujo install baixa um binario nativo que nada aqui usa.

if not exist "web\node_modules" (
  echo [1/3] Instalando dependencias do site...
  pushd web
  call npm install --ignore-scripts --no-audit --no-fund
  set "FALHA=!errorlevel!"
  popd
  if not "!FALHA!"=="0" goto :fim_erro
  echo.
)

if /i not "%MODO%"=="site" (
  if not exist "electron\node_modules" (
    echo [2/3] Instalando dependencias do desktop...
    pushd electron
    call npm install --no-audit --no-fund
    set "FALHA=!errorlevel!"
    popd
    if not "!FALHA!"=="0" goto :fim_erro
    echo.
  )
)

rem --- build ------------------------------------------------------------------

echo [3/3] Compilando ^(isso demora alguns minutos^)...
echo.
pushd web
call npm run %ALVO%
set "FALHA=!errorlevel!"
popd
if not "!FALHA!"=="0" goto :fim_erro

set "CODEX_VER="
for /f tokens^=2^ delims^=:^,^"^  %%V in ('findstr /c:version "ai-client\simplevlogeditor-codex-plugin\plugins\simple-vlog-editor\.codex-plugin\plugin.json"') do if not defined CODEX_VER set "CODEX_VER=%%V"
if not defined CODEX_VER set "CODEX_VER=?"

rem --- resumo -----------------------------------------------------------------

echo.
echo ===============================================
echo   Pronto.
echo ===============================================
echo.
echo   Site para subir:  %~dp0web\dist\browser
echo.

set "PASTA=web\dist\browser\assets\download"
set "EXE=%PASTA%\SimpleVlogEditor-Setup.exe"
set "ZIP=%PASTA%\SimpleVlogEditor-Portable.zip"

if exist "%EXE%" (
  for %%F in ("%EXE%") do set "BYTES=%%~zF"
  set /a MB=!BYTES!/1048576
  echo   Instalador:       !MB! MB  ^(SimpleVlogEditor-Setup.exe^)
) else (
  if /i "%MODO%"=="site" (
    echo   Instalador:       nao refeito ^(build so do site^).
  ) else (
    echo   [AVISO] O instalador nao foi gerado. Veja as mensagens acima.
  )
)

if exist "%ZIP%" (
  for %%F in ("%ZIP%") do set "BYTESZ=%%~zF"
  set /a MBZ=!BYTESZ!/1048576
  echo   Portatil:         !MBZ! MB  ^(SimpleVlogEditor-Portable.zip^)
)

echo.
echo   Plugins de IA:
call :tamanho "%PASTA%\simple-vlog-editor-claude.zip" "Claude Code  "
call :tamanho "%PASTA%\simple-vlog-editor-codex.zip" "Codex        "
echo.
echo   GitHub ^(Codex^):   %~dp0ai-client\simplevlogeditor-codex-plugin  ^(plugin !CODEX_VER!^)

if /i not "%MODO%"=="site" (
  echo.
  echo   Saida bruta:      %~dp0electron\release
)
echo.
pause
exit /b 0

:tamanho
if exist "%~1" (
  for %%F in ("%~1") do set "BYTESP=%%~zF"
  set /a KBP=!BYTESP!/1024
  if !KBP! GEQ 1024 (
    set /a MBP=!KBP!/1024
    echo     %~2 !MBP! MB  ^(%~nx1^)
  ) else (
    echo     %~2 !KBP! KB  ^(%~nx1^)
  )
) else (
  echo     %~2 nao gerado  ^(%~nx1^)
)
exit /b 0

:fim_erro
echo.
echo ===============================================
echo   O build falhou. Nada foi publicado.
echo ===============================================
echo.
pause
exit /b 1
