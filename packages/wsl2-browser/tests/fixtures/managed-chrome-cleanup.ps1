param([string]$ScriptPath, [string]$Scenario)

# respawn: stopping the browser leaves a child that appeared after the first query.
# slow: stopped processes take 3 seconds of polling to disappear, beyond the old
#   2-second budget and within the current one.
# stuck: processes never exit.
$global:Alive = New-Object 'Collections.Generic.List[int]'
$global:Alive.Add(100)
$global:StopRequestedAt = @{}
$global:ElapsedMs = 0
$global:Removed = $false

function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter, [string]$Namespace)
    if ($Scenario -eq 'slow') {
        foreach ($Id in @($global:StopRequestedAt.Keys)) {
            if ($global:ElapsedMs - $global:StopRequestedAt[$Id] -ge 3000) { [void]$global:Alive.Remove($Id) }
        }
    }
    foreach ($Id in $global:Alive) {
        @{ ProcessId = $Id; CommandLine = "chrome.exe --user-data-dir=C:\test-profile --type=renderer" }
    }
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    if ($Scenario -eq 'respawn') {
        [void]$global:Alive.Remove($Id)
        if ($Id -eq 100) { $global:Alive.Add(101) }
    }
    elseif ($Scenario -eq 'slow' -and -not $global:StopRequestedAt.ContainsKey($Id)) {
        $global:StopRequestedAt[$Id] = $global:ElapsedMs
    }
}
function Start-Sleep {
    param([int]$Milliseconds)
    $global:ElapsedMs += $Milliseconds
}
function Test-Path { return $true }
function Remove-Item { $global:Removed = $true }

try {
    & $ScriptPath -Action Cleanup -RunId cleanup-test -ProfileDir 'C:\test-profile'
    Write-Output "result:ok removed:$global:Removed"
}
catch {
    Write-Output "result:failed removed:$global:Removed $($_.Exception.Message)"
}
