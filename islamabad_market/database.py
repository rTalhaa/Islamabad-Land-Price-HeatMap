from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .utils import ensure_directory


DOCUMENT_NAMES = {
    "history.json": "history",
    "listings.json": "listings",
    "map_points.geojson": "map_points",
    "neighborhoods.json": "neighborhoods",
    "quality_report.json": "quality_report",
    "report.json": "report",
    "source_health.json": "source_health",
    "summary.json": "summary",
}


def connect(database_path: Path) -> sqlite3.Connection:
    ensure_directory(database_path.parent)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS dataset_documents (
            name TEXT PRIMARY KEY,
            generated_at TEXT,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS listings (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            source_key TEXT,
            source_listing_id TEXT,
            canonical_key TEXT,
            detail_url TEXT,
            url TEXT,
            title TEXT,
            property_group TEXT,
            neighborhood TEXT,
            location TEXT,
            city TEXT,
            price_pkr REAL,
            area_sqft REAL,
            price_per_sqft REAL,
            price_per_marla REAL,
            beds INTEGER,
            baths INTEGER,
            latitude REAL,
            longitude REAL,
            coordinate_source TEXT,
            confidence_score REAL,
            confidence_band TEXT,
            size_band TEXT,
            recency_bucket TEXT,
            freshness_hours REAL,
            is_outlier INTEGER NOT NULL DEFAULT 0,
            source_fetched_at TEXT,
            payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source);
        CREATE INDEX IF NOT EXISTS idx_listings_property_group ON listings(property_group);
        CREATE INDEX IF NOT EXISTS idx_listings_neighborhood ON listings(neighborhood);
        CREATE INDEX IF NOT EXISTS idx_listings_price_per_sqft ON listings(price_per_sqft);
        CREATE INDEX IF NOT EXISTS idx_listings_confidence ON listings(confidence_score);

        CREATE TABLE IF NOT EXISTS neighborhoods (
            name TEXT PRIMARY KEY,
            listing_count INTEGER,
            mapped_count INTEGER,
            median_price_pkr REAL,
            median_price_per_sqft REAL,
            median_price_per_marla REAL,
            confidence_median REAL,
            payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS watched_neighborhoods (
            neighborhood TEXT PRIMARY KEY,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS saved_searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filters_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    connection.commit()


def write_document(connection: sqlite3.Connection, name: str, payload: Any, generated_at: str | None) -> None:
    connection.execute(
        """
        INSERT INTO dataset_documents(name, generated_at, payload_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
            generated_at = excluded.generated_at,
            payload_json = excluded.payload_json,
            updated_at = CURRENT_TIMESTAMP
        """,
        (name, generated_at, json.dumps(payload, ensure_ascii=True)),
    )


def write_listings(connection: sqlite3.Connection, listings: list[dict[str, Any]]) -> None:
    connection.execute("DELETE FROM listings")
    rows = []
    for listing in listings:
        rows.append(
            (
                listing.get("id"),
                listing.get("source"),
                listing.get("sourceKey"),
                listing.get("sourceListingId"),
                listing.get("canonicalKey"),
                listing.get("detailUrl"),
                listing.get("url"),
                listing.get("title"),
                listing.get("propertyGroup"),
                listing.get("neighborhood"),
                listing.get("location"),
                listing.get("city"),
                listing.get("pricePkr"),
                listing.get("areaSqft"),
                listing.get("pricePerSqft"),
                listing.get("pricePerMarla"),
                listing.get("beds"),
                listing.get("baths"),
                listing.get("latitude"),
                listing.get("longitude"),
                listing.get("coordinateSource"),
                listing.get("confidenceScore"),
                listing.get("confidenceBand"),
                listing.get("sizeBand"),
                listing.get("recencyBucket"),
                listing.get("freshnessHours"),
                1 if listing.get("isOutlier") else 0,
                listing.get("sourceFetchedAt"),
                json.dumps(listing, ensure_ascii=True),
            )
        )
    connection.executemany(
        """
        INSERT INTO listings(
            id, source, source_key, source_listing_id, canonical_key, detail_url, url, title,
            property_group, neighborhood, location, city, price_pkr, area_sqft, price_per_sqft,
            price_per_marla, beds, baths, latitude, longitude, coordinate_source, confidence_score,
            confidence_band, size_band, recency_bucket, freshness_hours, is_outlier,
            source_fetched_at, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def write_neighborhoods(connection: sqlite3.Connection, neighborhoods: list[dict[str, Any]]) -> None:
    connection.execute("DELETE FROM neighborhoods")
    connection.executemany(
        """
        INSERT INTO neighborhoods(
            name, listing_count, mapped_count, median_price_pkr, median_price_per_sqft,
            median_price_per_marla, confidence_median, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                item.get("name"),
                item.get("listingCount"),
                item.get("mappedCount"),
                item.get("medianPricePkr"),
                item.get("medianPricePerSqft"),
                item.get("medianPricePerMarla"),
                item.get("confidenceMedian"),
                json.dumps(item, ensure_ascii=True),
            )
            for item in neighborhoods
        ],
    )


def write_database_bundle(
    database_path: Path,
    *,
    listings: list[dict[str, Any]],
    neighborhoods: list[dict[str, Any]],
    summary: dict[str, Any],
    history: list[dict[str, Any]],
    geojson: dict[str, Any],
    report: dict[str, Any],
    source_health: dict[str, Any],
    quality_report: dict[str, Any],
) -> None:
    generated_at = summary.get("generatedAt")
    documents = {
        "history.json": history,
        "listings.json": listings,
        "map_points.geojson": geojson,
        "neighborhoods.json": neighborhoods,
        "quality_report.json": quality_report,
        "report.json": report,
        "source_health.json": source_health,
        "summary.json": summary,
    }
    connection = connect(database_path)
    try:
        initialize_database(connection)
        write_listings(connection, listings)
        write_neighborhoods(connection, neighborhoods)
        for name, payload in documents.items():
            write_document(connection, name, payload, generated_at)
        connection.commit()
    finally:
        connection.close()


def load_document(database_path: Path, filename: str) -> Any | None:
    if not database_path.exists():
        return None
    connection = connect(database_path)
    try:
        initialize_database(connection)
        row = connection.execute(
            "SELECT payload_json FROM dataset_documents WHERE name = ?",
            (filename,),
        ).fetchone()
        if not row:
            return None
        return json.loads(row["payload_json"])
    finally:
        connection.close()


def list_watched_neighborhoods(database_path: Path) -> list[dict[str, Any]]:
    connection = connect(database_path)
    try:
        initialize_database(connection)
        rows = connection.execute(
            """
            SELECT neighborhood, note, created_at
            FROM watched_neighborhoods
            ORDER BY neighborhood COLLATE NOCASE
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def set_watched_neighborhood(database_path: Path, neighborhood: str, note: str | None = None) -> dict[str, Any]:
    name = neighborhood.strip()
    if not name:
        raise ValueError("neighborhood is required")

    connection = connect(database_path)
    try:
        initialize_database(connection)
        connection.execute(
            """
            INSERT INTO watched_neighborhoods(neighborhood, note)
            VALUES (?, ?)
            ON CONFLICT(neighborhood) DO UPDATE SET
                note = excluded.note
            """,
            (name, note),
        )
        connection.commit()
        row = connection.execute(
            """
            SELECT neighborhood, note, created_at
            FROM watched_neighborhoods
            WHERE neighborhood = ?
            """,
            (name,),
        ).fetchone()
        return dict(row)
    finally:
        connection.close()


def delete_watched_neighborhood(database_path: Path, neighborhood: str) -> bool:
    name = neighborhood.strip()
    if not name:
        return False

    connection = connect(database_path)
    try:
        initialize_database(connection)
        cursor = connection.execute("DELETE FROM watched_neighborhoods WHERE neighborhood = ?", (name,))
        connection.commit()
        return cursor.rowcount > 0
    finally:
        connection.close()


def list_saved_searches(database_path: Path) -> list[dict[str, Any]]:
    connection = connect(database_path)
    try:
        initialize_database(connection)
        rows = connection.execute(
            """
            SELECT id, name, filters_json, created_at
            FROM saved_searches
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "filters": json.loads(row["filters_json"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    finally:
        connection.close()


def create_saved_search(database_path: Path, name: str, filters: dict[str, Any]) -> dict[str, Any]:
    cleaned_name = name.strip()
    if not cleaned_name:
        raise ValueError("name is required")
    if not isinstance(filters, dict):
        raise ValueError("filters must be an object")

    connection = connect(database_path)
    try:
        initialize_database(connection)
        cursor = connection.execute(
            """
            INSERT INTO saved_searches(name, filters_json)
            VALUES (?, ?)
            """,
            (cleaned_name, json.dumps(filters, ensure_ascii=True, sort_keys=True)),
        )
        connection.commit()
        row = connection.execute(
            """
            SELECT id, name, filters_json, created_at
            FROM saved_searches
            WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
        return {
            "id": row["id"],
            "name": row["name"],
            "filters": json.loads(row["filters_json"]),
            "created_at": row["created_at"],
        }
    finally:
        connection.close()


def delete_saved_search(database_path: Path, search_id: int) -> bool:
    connection = connect(database_path)
    try:
        initialize_database(connection)
        cursor = connection.execute("DELETE FROM saved_searches WHERE id = ?", (search_id,))
        connection.commit()
        return cursor.rowcount > 0
    finally:
        connection.close()


def database_status(database_path: Path) -> dict[str, Any]:
    if not database_path.exists():
        return {"enabled": False, "path": str(database_path), "reason": "database file not found"}
    connection = connect(database_path)
    try:
        initialize_database(connection)
        row = connection.execute(
            "SELECT payload_json FROM dataset_documents WHERE name = ?",
            ("summary.json",),
        ).fetchone()
        summary = json.loads(row["payload_json"]) if row else {}
        return {
            "enabled": True,
            "path": str(database_path),
            "generatedAt": summary.get("generatedAt"),
            "listingCount": connection.execute("SELECT COUNT(*) AS count FROM listings").fetchone()["count"],
            "neighborhoodCount": connection.execute("SELECT COUNT(*) AS count FROM neighborhoods").fetchone()["count"],
            "documentCount": connection.execute("SELECT COUNT(*) AS count FROM dataset_documents").fetchone()["count"],
            "watchedNeighborhoodCount": connection.execute("SELECT COUNT(*) AS count FROM watched_neighborhoods").fetchone()["count"],
            "savedSearchCount": connection.execute("SELECT COUNT(*) AS count FROM saved_searches").fetchone()["count"],
        }
    finally:
        connection.close()


def query_listings(
    database_path: Path,
    *,
    source: str | None = None,
    property_group: str | None = None,
    neighborhood: str | None = None,
    min_confidence: float | None = None,
    include_outliers: bool = False,
    limit: int = 200,
) -> list[dict[str, Any]]:
    if not database_path.exists():
        return []
    clauses = []
    values: list[Any] = []
    if source:
        clauses.append("source = ?")
        values.append(source)
    if property_group:
        clauses.append("property_group = ?")
        values.append(property_group)
    if neighborhood:
        clauses.append("neighborhood = ?")
        values.append(neighborhood)
    if min_confidence is not None:
        clauses.append("confidence_score >= ?")
        values.append(min_confidence)
    if not include_outliers:
        clauses.append("is_outlier = 0")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(max(1, min(limit, 1000)))
    connection = connect(database_path)
    try:
        initialize_database(connection)
        rows = connection.execute(
            f"""
            SELECT payload_json
            FROM listings
            {where}
            ORDER BY confidence_score DESC, price_per_sqft DESC
            LIMIT ?
            """,
            values,
        ).fetchall()
    finally:
        connection.close()
    return [json.loads(row["payload_json"]) for row in rows]
