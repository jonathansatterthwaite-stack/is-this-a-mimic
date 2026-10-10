@echo off
rem Double-click to host an Is This A Mimic(s)? party on your local network.
cd /d "%~dp0"
python server.py %*
pause
