# Restart the dsh web profile on :3080 and verify the session-manager plugin.
# Written to run DETACHED: it waits 8s (letting the current agent turn flush its
# final message to the session log), kills the old web, boots a fresh one, and
# writes a verification report to restart-verify.json.
$ErrorActionPreference = "Continue"
$log = "C:\Users\qinlong\dsh-session-manager\web-restart.log"
$errLog = "C:\Users\qinlong\dsh-session-manager\web-restart.err.log"
$verify = "C:\Users\qinlong\dsh-session-manager\restart-verify.json"
$result = [ordered]@{ phase = "start"; ts = (Get-Date -Format o) }

Start-Sleep -Seconds 8

# 1. Kill whatever listens on 3080
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $oldPid = $conn.OwningProcess
    $result.oldPid = $oldPid
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# 2. Wait for the port to free (max 15s)
for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}
$result.portFreed = -not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)

# 3. Boot the fresh web (detached, same command as before)
$node = (Get-Command node).Source
$bin = "C:\Users\qinlong\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js"
try {
    $proc = Start-Process -FilePath $node -ArgumentList @($bin, "web") `
        -WorkingDirectory "C:\Users\qinlong\AppData\Local\npm-cache\_npx\1e7f6d9597241db0" `
        -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    $result.newPid = $proc.Id
} catch {
    $result.startError = $_.Exception.Message
}

# 4. Poll until the web answers (max 120s)
$up = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    if ($proc -and $proc.HasExited) { $result.newExited = $proc.ExitCode; break }
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3080/" -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $up = $true; $result.statusCode = $r.StatusCode; break }
    } catch {}
}
$result.up = $up

# 5. Verify the plugin surfaces
if ($up) {
    try {
        $html = (Invoke-WebRequest -Uri "http://127.0.0.1:3080/" -TimeoutSec 5 -UseBasicParsing).Content
        $result.manifestHasSessionManager = $html.Contains("dsh-session-manager")
        $result.manifestHasSuperInjector = $html.Contains("dsh-super-injector")
        # client bundle URL for the plugin
        $m = [regex]::Match($html, '"/plugins/@dsh-external/dsh-session-manager/client\.js[^"]*"')
        if ($m.Success) {
            $clientUrl = $m.Value.Trim('"')
            try {
                $c = Invoke-WebRequest -Uri ("http://127.0.0.1:3080" + $clientUrl) -TimeoutSec 5 -UseBasicParsing
                $result.clientBundleStatus = $c.StatusCode
            } catch { $result.clientBundleError = $_.Exception.Message }
        }
    } catch { $result.manifestError = $_.Exception.Message }

    # Host API smoke tests (fake ids — no real session is touched)
    try {
        $u = Invoke-RestMethod -Uri "http://127.0.0.1:3080/session-manager/api/unarchive" -Method Post `
            -ContentType "application/json" -Body '{"sessionId":"smoke-test-nonexistent"}' -TimeoutSec 10
        $result.unarchiveSmoke = $u
    } catch { $result.unarchiveSmokeError = $_.Exception.Message }
    try {
        $d = Invoke-RestMethod -Uri "http://127.0.0.1:3080/session-manager/api/delete" -Method Post `
            -ContentType "application/json" -Body '{"sessionId":"smoke-test-nonexistent"}' -TimeoutSec 10
        $result.deleteSmoke = $d
    } catch { $result.deleteSmokeError = $_.Exception.Message }
    try {
        $l = Invoke-RestMethod -Uri "http://127.0.0.1:3080/super-injector/api/list" -Method Get -TimeoutSec 10
        $result.injectorListCount = ($l.entries | Measure-Object).Count
        $result.injectorList = $l
    } catch { $result.injectorListError = $_.Exception.Message }
} else {
    if (Test-Path $log) { $result.logTail = (Get-Content $log -Tail 40) }
    if (Test-Path $errLog) { $result.errTail = (Get-Content $errLog -Tail 40) }
}

$result.phase = "done"
$result.ts = (Get-Date -Format o)
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $verify -Encoding UTF8
