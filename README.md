# Islamabad Price Atlas

An Islamabad-only property intelligence dashboard with:

- automated scraping of public listing pages
- processed market snapshots and rolling history
- a FastAPI backend for serving artifacts
- a high-impact map UI with heatmap, hex bins, and listing dots

## What it does

The pipeline currently tracks three Islamabad inventory streams:

- Houses
- Flats and Apartments
- Residential Plots

Each run:

1. pulls paginated search pages
2. deduplicates listing cards across seeds
3. enriches each listing from its detail page
4. normalizes price, area, and coordinate fields
5. exports map-ready JSON and GeoJSON
6. appends a historical snapshot entry for the dashboard

## Quick start

```powershell
.\scripts\bootstrap.ps1 -PagesPerSeed 2
.\scripts\start_server.ps1
```

Open `http://127.0.0.1:8000`.

## Useful commands

Run a normal refresh:

```powershell
.\scripts\run_pipeline.ps1 -PagesPerSeed 3
```

Run a quick verification sample:

```powershell
.\.venv\Scripts\python -m islamabad_market.pipeline --pages-per-seed 1 --listing-limit 18
```

Force cache refresh:

```powershell
.\scripts\run_pipeline.ps1 -PagesPerSeed 3 -RefreshCache
```

## Output files

- `data/processed/listings.json`
- `data/processed/map_points.geojson`
- `data/processed/summary.json`
- `data/processed/history.json`
- `data/processed/report.json`

## Automation

Local automation:

- `scripts\run_pipeline.ps1` for repeatable refreshes
- `scripts\start_server.ps1` for the API and dashboard

Repository automation:

- `.github/workflows/refresh-market-data.yml`

The GitHub Actions workflow refreshes the processed dataset every 12 hours and commits updated `data/processed` artifacts back to the repository.

## Notes

- Raw HTML caches live in `data/raw` to keep repeat runs fast.
- The UI is tuned for Islamabad only and centers the map accordingly.
- For production use, review the source site terms, acceptable-use policies, and rate limits before increasing scan depth.

## Core stack

- Python 3.11
- [FastAPI](https://fastapi.tiangolo.com/)
- [MapLibre GL JS](https://maplibre.org/)
- [deck.gl](https://deck.gl/)
- [CARTO basemap styles](https://carto.com/)
