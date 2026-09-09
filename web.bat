@echo off
setlocal

rem ===========================================================================
rem  SimpleVlogEditor - servidor de desenvolvimento
rem
rem  Sobe o "ng serve" da pasta web em http://localhost:4200, com recompilacao
rem  a cada arquivo salvo. Ctrl+C encerra.
rem
rem  Uso:  dev.bat                    porta 4200
rem        dev.bat --port 4300        qualquer opcao do ng serve passa adiante
rem
rem  Nota: aqui nao ha COOP/COEP, entao o navegador nao entrega
rem  SharedArrayBuffer e o supressor de ruido roda em uma thread so - mais
rem  lento que em producao, e so aqui. Para medir velocidade, use build.bat e
rem  "npm start" na pasta web.
rem ===========================================================================

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERRO] npm nao encontrado no PATH. Instale o Node.js e abra um terminal novo.
  goto :fim_erro
)

if not exist "web\node_modules" (
  echo Instalando dependencias do site ^(so na primeira vez^)...
  echo.
  pushd web
  call npm install --ignore-scripts --no-audit --no-fund
  set "FALHA=%errorlevel%"
  popd
  if not "%FALHA%"=="0" goto :fim_erro
  echo.
)

echo.
echo ===============================================
echo   ng serve  -^>  http://localhost:4200
echo   Ctrl+C para encerrar.
echo ===============================================
echo.

pushd web
call npm run dev -- %*
set "FALHA=%errorlevel%"
popd

if not "%FALHA%"=="0" goto :fim_erro
exit /b 0

:fim_erro
echo.
echo [ERRO] O servidor nao subiu. Veja as mensagens acima.
echo.
pause
exit /b 1
