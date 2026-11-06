@echo off
cd /d "%~dp0"
title DataApp
set "DATAAPP_PYTHON=%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1104-1290-0_26.1104.1290.0_x64__3k8sg7r9htsxt\dependencies\python\python.exe"
if exist "%DATAAPP_PYTHON%" goto abrir
set "DATAAPP_PYTHON="
for /d %%D in ("%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.*") do if exist "%%~fD\dependencies\python\python.exe" set "DATAAPP_PYTHON=%%~fD\dependencies\python\python.exe"
if defined DATAAPP_PYTHON goto abrir
where python >nul 2>nul
if errorlevel 1 goto sin_python
set "DATAAPP_PYTHON=python"
:abrir
"%DATAAPP_PYTHON%" abrir_dataapp.py
if errorlevel 1 pause
exit /b
:sin_python
echo DataApp no encontro Python en esta computadora.
pause
