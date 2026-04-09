param(
  [int]$PagesPerSeed = 2,
  [switch]$RefreshCache
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
  python -m venv .venv
}

.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt

$argsList = @("-m", "islamabad_market.pipeline", "--pages-per-seed", "$PagesPerSeed")
if ($RefreshCache) {
  $argsList += "--refresh-cache"
}

.\.venv\Scripts\python @argsList

