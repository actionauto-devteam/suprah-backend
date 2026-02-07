@echo off
echo ==========================================
echo 🐳 ActionAuto Docker Build & Push Script
echo ==========================================
echo.

echo 1. Building API Image (jolo0/actionauto-api:latest)...
docker build -t jolo0/actionauto-api:latest -f Dockerfile .
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo 2. Building FTP Image (jolo0/actionauto-ftp:latest)...
docker build -t jolo0/actionauto-ftp:latest -f Dockerfile.ftp .
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo 3. Pushing API Image to Docker Hub...
docker push jolo0/actionauto-api:latest
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo 4. Pushing FTP Image to Docker Hub...
docker push jolo0/actionauto-ftp:latest
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo ==========================================
echo ✅ Build and Push Complete!
echo ==========================================
echo Now you can run 'docker compose pull' on your VPS.
pause
