@echo off
setlocal

rem ===========================================================================
rem  SimpleVlogEditor - abrir a aplicacao desktop
rem
rem  Roda o que ja esta compilado, sem compilar nada. A janela abre e esta
rem  janela de console fecha - o Electron e iniciado solto, nao como filho
rem  deste batch.
rem
rem  Para gerar/atualizar o que ele mostra:  build.bat
rem ===========================================================================

cd /d "%~dp0"

set "ELECTRON=electron\node_modules\electron\dist\electron.exe"

rem --- o que precisa existir antes ------------------------------------------

if not exist "%ELECTRON%" (
  echo.
  echo [ERRO] O Electron nao esta instalado.
  echo.
  echo   Abra um terminal na pasta "electron" e rode:  npm install
  echo   Ou rode build.bat, que instala o que faltar.
  echo.
  goto :fim_erro
)

if not exist "web\dist\browser\index.html" (
  echo.
  echo [ERRO] O site ainda nao foi compilado.
  echo.
  echo   A aplicacao mostra o conteudo de web\dist\browser, que nao existe.
  echo   Rode build.bat primeiro.
  echo.
  goto :fim_erro
)

rem --- abrir ----------------------------------------------------------------

start "SimpleVlogEditor" "%ELECTRON%" "%~dp0electron"
exit /b 0

:fim_erro
pause
exit /b 1
