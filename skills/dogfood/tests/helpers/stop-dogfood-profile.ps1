param([Parameter(Mandatory = $true)][string]$ProfileDir)

# Test-only fallback that stays independent of the production Cleanup under test.
# Match the full --user-data-dir argument so a similar or real user profile is never stopped.
$Escaped = [Regex]::Escape($ProfileDir)
$Pattern = '(?:^|\s)--user-data-dir=(?:"' + $Escaped + '"|' + $Escaped + ')(?:\s|$)'

for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
    $Processes = @(
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $Pattern }
    )
    if ($Processes.Count -eq 0) {
        exit 0
    }
    foreach ($Process in $Processes) {
        Stop-Process -Id ([int]$Process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 100
}

Write-Output "Chrome did not exit for profile '$ProfileDir' (PIDs: $(($Processes | ForEach-Object ProcessId) -join ', '))."
exit 1
