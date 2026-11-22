@echo off
chcp 65001 >nul
:: Auto-elevate to Administrator so we can stop an elevated PhoneBoxAgent.exe
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo [1/3] Dang tat PhoneBoxAgent.exe cu...
taskkill /F /IM PhoneBoxAgent.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] Dang chep ban PhoneBoxAgent.exe moi (HD Art + FFT Beat Edge Lighting + Music Launch)...
copy /Y "%~dp0dist\agent\PhoneBoxAgent.exe" "%USERPROFILE%\Downloads\PhoneBoxAgent.exe"
if %errorlevel% neq 0 (
    echo LOI: Khong chep duoc file! Hay thoat PhoneBox o khay he thong roi thu lai.
    pause
    exit /b 1
)

echo [3/3] Dang khoi dong lai PhoneBoxAgent.exe...
start "" "%USERPROFILE%\Downloads\PhoneBoxAgent.exe"
timeout /t 2 /nobreak >nul
echo XONG! PhoneBoxAgent v3 da chay.
timeout /t 2 /nobreak >nul
