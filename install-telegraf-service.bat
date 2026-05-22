@echo off
REM Run as Administrator to install Telegraf as a Windows service
REM This script will auto-start Telegraf on system boot

"C:\Users\Tania Mahata\AppData\Local\Microsoft\WinGet\Packages\InfluxData.Telegraf_Microsoft.Winget.Source_8wekyb3d8bbwe\telegraf-1.36.3\telegraf.exe" --config "c:\Users\Tania Mahata\Desktop\Learning_connection\telegraf\telegraf.conf" service install

echo Telegraf service installed successfully!
echo.
echo Starting Telegraf service...
net start Telegraf

echo.
echo Done! Telegraf will now auto-start on system boot.
pause
