from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from islamabad_market.config import get_config
from islamabad_market.database import database_status, load_document, query_listings


config = get_config()
app = FastAPI(title="Islamabad Price Atlas", version="1.0.0")
app.mount("/static", StaticFiles(directory=config.base_dir / "static"), name="static")


def _load_processed_file(filename: str) -> Any:
    database_payload = load_document(config.database_path, filename)
    if database_payload is not None:
        return database_payload

    path = config.processed_dir / filename
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Processed dataset not found yet. Run `python -m islamabad_market.pipeline` first.",
        )
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> dict[str, str]:
    status = database_status(config.database_path)
    return {
        "status": "ok",
        "storage": "sqlite" if status.get("enabled") else "json",
        "generatedAt": status.get("generatedAt"),
    }


@app.get("/api/db/status")
def db_status() -> dict[str, Any]:
    return database_status(config.database_path)


@app.get("/api/db/listings")
def db_listings(
    source: str | None = None,
    property_group: str | None = Query(default=None, alias="propertyGroup"),
    neighborhood: str | None = None,
    min_confidence: float | None = Query(default=None, alias="minConfidence"),
    include_outliers: bool = Query(default=False, alias="includeOutliers"),
    limit: int = 200,
) -> list[dict[str, Any]]:
    rows = query_listings(
        config.database_path,
        source=source,
        property_group=property_group,
        neighborhood=neighborhood,
        min_confidence=min_confidence,
        include_outliers=include_outliers,
        limit=limit,
    )
    if not rows and not config.database_path.exists():
        raise HTTPException(status_code=404, detail="SQLite database not found. Run the pipeline first.")
    return rows


@app.get("/api/summary")
def summary() -> Any:
    return _load_processed_file("summary.json")


@app.get("/api/listings")
def listings() -> Any:
    return _load_processed_file("listings.json")


@app.get("/api/history")
def history() -> Any:
    return _load_processed_file("history.json")


@app.get("/api/neighborhoods")
def neighborhoods() -> Any:
    return _load_processed_file("neighborhoods.json")


@app.get("/api/map-points")
def map_points() -> Any:
    return _load_processed_file("map_points.geojson")


@app.get("/api/report")
def report() -> Any:
    return _load_processed_file("report.json")


@app.get("/api/source-health")
def source_health() -> Any:
    return _load_processed_file("source_health.json")


@app.get("/api/quality-report")
def quality_report() -> Any:
    return _load_processed_file("quality_report.json")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.base_dir / "static" / "index.html")
