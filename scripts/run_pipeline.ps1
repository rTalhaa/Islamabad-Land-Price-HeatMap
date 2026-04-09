param(
  [int]$PagesPerSeed = 3,
  [switch]$FullScan,
  [switch]$RefreshCache,
  [int]$ListingLimit = 0
)

$ErrorActionPreference = "Stop"

$argsList = @("-m", "islamabad_market.pipeline", "--pages-per-seed", "$PagesPerSeed")

if ($FullScan) {
  $argsList += "--full-scan"
}

if ($RefreshCache) {
  $argsList += "--refresh-cache"
}

if ($ListingLimit -gt 0) {
  $argsList += @("--listing-limit", "$ListingLimit")
}

.\.venv\Scripts\python @argsList

