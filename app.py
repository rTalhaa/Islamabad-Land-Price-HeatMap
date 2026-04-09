from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from islamabad_market.config import get_config


config = get_config()
app = FastAPI(title="Islamabad Price Atlas", version="1.0.0")
app.mount("/static", StaticFiles(directory=config.base_dir / "static"), name="static")


def _load_processed_file(filename: str) -> Any:
    path = config.processed_dir / filename
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Processed dataset not found yet. Run `python -m islamabad_market.pipeline` first.",
        )
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.base_dir / "static" / "index.html")
