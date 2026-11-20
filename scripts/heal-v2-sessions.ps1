# dsh-session-manager companion script: one-time repair of the DSH
# 0.1.1-rc.2 v2/v0 filename mismatch. It renames a
# session.v2.jsonl.zstd whose header says version 0 to session.jsonl.zstd.
#
# Run this BEFORE starting DSH. DSH initializes workspace/session state before
# user plugin apply() runs, so a plugin cannot reliably repair this particular
# boot-time mismatch after the fact.

param(
    [string]$DshHome = $(
        if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
            Join-Path $env:USERPROFILE '.dsh'
        } else {
            $env:DSH_HOME
        }
    )
)

if (-not (Test-Path -LiteralPath $DshHome -PathType Container)) {
    Write-Host "DSH home not found at $DshHome; nothing to do." -ForegroundColor Yellow
    exit 0
}

$sessionsRoot = Join-Path $DshHome 'sessions'
if (-not (Test-Path -LiteralPath $sessionsRoot -PathType Container)) {
    Write-Host "No sessions directory at $sessionsRoot; nothing to do." -ForegroundColor Yellow
    exit 0
}

$healed = 0
$skipped = 0
$errors = 0

# The header is the first JSONL line, including when its frame contains events.
$nodeScript = "const fs = require('node:fs');" +
    "const zlib = require('node:zlib');" +
    "const file = process.argv[1];" +
    "const bytes = fs.readFileSync(file);" +
    "const text = zlib.zstdDecompressSync(bytes).toString('utf8');" +
    "const nl = text.indexOf(String.fromCharCode(10));" +
    "if (nl < 0) throw Error('Incomplete header');" +
    "process.stdout.write(text.slice(0, nl));"

Get-ChildItem -LiteralPath $sessionsRoot -Directory -Attributes !ReparsePoint -ErrorAction Stop | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Directory -Attributes !ReparsePoint -ErrorAction Stop | ForEach-Object {
        $dir = $_.FullName
        $v2 = Join-Path $dir 'session.v2.jsonl.zstd'
        $v0 = Join-Path $dir 'session.jsonl.zstd'

        if (-not (Test-Path -LiteralPath $v2 -PathType Leaf)) { return }
        if (((Get-Item -LiteralPath $v2).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath $v0)) {
            $skipped++
            return
        }

        try {
            $headerJson = & node -e $nodeScript $v2
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($headerJson -join ''))) {
                throw 'Node zstd decoder failed'
            }
            $header = ($headerJson -join '') | ConvertFrom-Json -ErrorAction Stop
            if (($header.version -isnot [int] -and $header.version -isnot [long]) -or $header.version -ne 0) {
                $skipped++
                return
            }

            [IO.File]::Move($v2, $v0)
            $healed++
            Write-Host "healed: $v2 -> $v0" -ForegroundColor Green
        } catch {
            $errors++
            Write-Host "skipped (read or move failed): $v2 -- $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
}

Write-Host ''
Write-Host "Healed: $healed"
Write-Host 'Skipped (linked artifact, existing destination, or another header version):' $skipped
Write-Host "Errors: $errors"
if ($errors -gt 0) { exit 1 }
