# This script sets up Telegraf to auto-start via Windows Task Scheduler
# Run this as Administrator: Right-click, "Run with PowerShell"

$TelegrafPath = 'C:\Users\Tania Mahata\AppData\Local\Microsoft\WinGet\Packages\InfluxData.Telegraf_Microsoft.Winget.Source_8wekyb3d8bbwe\telegraf-1.36.3\telegraf.exe'
$ConfigPath = 'c:\Users\Tania Mahata\Desktop\Learning_connection\telegraf\telegraf.conf'
$TaskName = "Telegraf Auto-Start"

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "ERROR: Please run this script as Administrator!" -ForegroundColor Red
    Write-Host "Right-click the script and select 'Run with PowerShell'" -ForegroundColor Yellow
    exit
}

# Create task action
$action = New-ScheduledTaskAction -Execute $TelegrafPath -Argument "--config `"$ConfigPath`""

# Create task trigger (on system startup)
$trigger = New-ScheduledTaskTrigger -AtStartup

# Create task settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunWithoutNetwork

# Register the task
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Auto-start Telegraf on system boot" -Force
    Write-Host "SUCCESS: Telegraf auto-start configured!" -ForegroundColor Green
    Write-Host "Telegraf will now start automatically when you boot your computer." -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to create scheduled task" -ForegroundColor Red
    Write-Host $_.Exception.Message
}

pause
