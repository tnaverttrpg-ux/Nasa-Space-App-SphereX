@echo off
rem SPHERE TRACK launcher: first run installs dependencies, then starts backend + frontend and opens the browser.
cd /d "%~dp0"

if not exist "backend\.venv\Scripts\python.exe" (
  echo Creating Python environment...
  python -m venv backend\.venv || (echo Python 3.11+ is required. & pause & exit /b 1)
  backend\.venv\Scripts\python -m pip install -r backend\requirements.txt || (echo pip install failed. & pause & exit /b 1)
)

if not exist "frontend\node_modules" (
  echo Installing frontend packages...
  pushd frontend
  call npm install || (echo npm install failed. Node 20+ is required. & popd & pause & exit /b 1)
  popd
)

start "SPHERE TRACK backend" /d "%~dp0backend" cmd /k ".venv\Scripts\python -m uvicorn app.main:app --port 8000"
start "SPHERE TRACK frontend" /d "%~dp0frontend" cmd /k "npm run dev"

echo Waiting for servers...
timeout /t 6 /nobreak >nul
start "" http://localhost:5180
echo SPHERE TRACK is running. Close the two server windows to stop it.
