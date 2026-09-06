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

# The first zstd frame contains the header. Node's one-shot decoder is enough
# here because we intentionally inspect only that first frame.
$nodeScript = "const fs = require('node:fs');" +
    "const zlib = require('node:zlib');" +
    "const file = process.argv[1];" +
    "const bytes = fs.readFileSync(file);" +
    "const text = zlib.zstdDecompressSync(bytes).toString('utf8');" +
    "process.stdout.write(text.split('\\n', 1)[0]);"

Get-ChildItem -LiteralPath $sessionsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $dir = $_.FullName
        $v2 = Join-Path $dir 'session.v2.jsonl.zstd'
        $v0 = Join-Path $dir 'session.jsonl.zstd'

        if (-not (Test-Path -LiteralPath $v2 -PathType Leaf)) { return }
        if (Test-Path -LiteralPath $v0 -PathType Leaf) {
            $skipped++
            return
        }

        try {
            $headerJson = & node -e $nodeScript $v2
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($headerJson -join ''))) {
                throw 'Node zstd decoder failed'
            }
            $header = ($headerJson -join '') | ConvertFrom-Json -ErrorAction Stop
            if ($header.version -ne 0) {
                $skipped++
                return
            }

            Move-Item -LiteralPath $v2 -Destination $v0 -ErrorAction Stop
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
Write-Host 'Skipped (v0 sibling already exists, or header is not version 0):' $skipped
Write-Host "Errors: $errors"
