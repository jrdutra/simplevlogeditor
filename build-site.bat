@echo off
rem ===========================================================================
rem  SimpleVlogEditor - recompilar apenas o site (o que a janela mostra).
rem
rem  Atalho de um clique para "build.bat site": nao empacota o instalador, que
rem  e a parte demorada e nao muda nada do que a aplicacao ja instalada mostra.
rem  Depois que terminar, feche e abra a aplicacao (app.bat).
rem ===========================================================================
call "%~dp0build.bat" site
