@echo off
setlocal enabledelayedexpansion

rem ===========================================================================
rem  SimpleVlogEditor - build completo (site + instalador Windows)
rem
rem  Um comando so. O build do site chama o empacotamento do desktop no final,
rem  e o instalador recem-gerado volta para dentro do site - entao ao terminar
rem  as duas metades estao atualizadas e "web\dist\browser" ja pode subir.
rem
rem  Uso:  build.bat          site + instalador
rem        build.bat site     apenas o site (sem esperar o empacotamento)
rem ===========================================================================

cd /d "%~dp0"

set "MODO=%~1"
if /i "%MODO%"=="site" (set "ALVO=build:site") else (set "ALVO=build")

echo.
echo ===============================================
echo   SimpleVlogEditor
if /i "%MODO%"=="site" (echo   site apenas) else (echo   site + instalador Windows)
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

if /i not "%MODO%"=="site" echo   Saida bruta:      %~dp0electron\release
echo.
pause
exit /b 0

:fim_erro
echo.
echo ===============================================
echo   O build falhou. Nada foi publicado.
echo ===============================================
echo.
pause
exit /b 1
