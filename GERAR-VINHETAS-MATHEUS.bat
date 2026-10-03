@echo off
title Gerar vinhetas - Matheus Goncalves
cd /d "%~dp0"
echo.
echo WEB RADIO VEM COMIGO DEUS
echo Gerador de vinhetas do locutor oficial: Matheus Goncalves
echo.
if "%GEMINI_API_KEY%"=="" (
  echo GEMINI_API_KEY nao esta definida neste Windows.
  echo.
  echo Abra o Prompt de Comando e configure a chave localmente.
  echo Nao envie a chave pelo chat.
  echo.
  pause
  exit /b 1
)
call npm install
node src\gerar-vinhetas-matheus.mjs
echo.
pause
