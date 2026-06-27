from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from pathlib import Path
from typing import Any

from .config import SearchSeed, get_config
from .database import write_database_bundle
from .parsers import (
    clean_text,
    extract_location_name,
    parse_area_to_sqft,
    parse_price_to_pkr,
    parse_relative_age_hours,
)
from .scraper import ScrapeError, ZameenScraper, parse_detail_page, parse_search_page
from .utils import compact_json, ensure_directories, get_logger, median_or_none, round_or_none, utc_now_iso, write_json


logger = get_logger("islamabad_market.pipeline")


class DegradedRunError(RuntimeError):
    """Raised when a pipeline run produces too little data to be trustworthy."""


PROPERTY_GROUP_LABELS = {
    "house": "Houses",
    "apartment": "Flats & Apartments",
    "plot": "Residential Plots",
    "mixed": "Mixed Property",
}

FBR_REFERENCE = {
    "label": "FBR Islamabad immovable property valuation",
    "url": "https://www.fbr.gov.pk/propertyValuation/17653",
    "documentUrl": "https://download1.fbr.gov.pk/SROs/2026416174174449SRO644.pdf",
    "note": "Official valuation reference. Numeric matching is shown only when an area table is mapped.",
}

ISLAMABAD_BOUNDS = {
    "min_latitude": 33.35,
    "max_latitude": 33.95,
    "min_longitude": 72.75,
    "max_longitude": 73.35,
}


def merge_summary(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in incoming.items():
        if merged.get(key) in (None, "", []) and value not in (None, "", []):
            merged[key] = value
    return merged


def canonical_text(value: Any) -> str:
    return clean_text(str(value or "")).lower().replace(" ", "-")


def build_canonical_key(record: dict[str, Any]) -> str:
    price_bucket = round((record.get("pricePkr") or 0) / 100_000) if record.get("pricePkr") else 0
    area_bucket = round((record.get("areaSqft") or 0) / 25) if record.get("areaSqft") else 0
    return "|".join(
        [
            canonical_text(record.get("propertyGroup")),
            canonical_text(record.get("neighborhood")),
            str(price_bucket),
            str(area_bucket),
            canonical_text(record.get("beds")),
        ]
    )


def confidence_band(score: float | int | None) -> str:
    value = float(score or 0)
    if value >= 85:
        return "High"
    if value >= 70:
        return "Medium"
    return "Low"


def size_band(area_sqft: float | None) -> str:
    if area_sqft is None:
        return "Unknown"
    if area_sqft <= 1125:
        return "Compact"
    if area_sqft <= 2250:
        return "Mid-size"
    if area_sqft <= 4500:
        return "Large"
    return "Estate"


def recency_bucket(freshness_hours: float | None) -> str:
    if freshness_hours is None:
        return "Unknown"
    if freshness_hours <= 72:
        return "Fresh"
    if freshness_hours <= 24 * 30:
        return "Recent"
    return "Stale"


def compute_parse_warnings(record: dict[str, Any]) -> list[str]:
    warnings = []
    for key in ("pricePkr", "areaSqft", "pricePerSqft", "neighborhood"):
        if record.get(key) in (None, ""):
            warnings.append(f"missing:{key}")
    if record.get("latitude") is None or record.get("longitude") is None:
        warnings.append("missing:coordinates")
    ppsf = record.get("pricePerSqft")
    if ppsf is not None and (ppsf < 500 or ppsf > 150_000):
        warnings.append("suspicious:pricePerSqft")
    if not record.get("imageUrl"):
        warnings.append("missing:image")
    return warnings


def compute_confidence_score(record: dict[str, Any]) -> int:
    score = 100
    penalties = {
        "missing:pricePkr": 24,
        "missing:areaSqft": 22,
        "missing:pricePerSqft": 26,
        "missing:neighborhood": 18,
        "missing:coordinates": 16,
        "missing:image": 4,
        "suspicious:pricePerSqft": 20,
    }
    for warning in record.get("parseWarnings", []):
        score -= penalties.get(warning, 8)
    if record.get("coordinateSource") == "neighborhood-centroid":
        score -= 8
    if record.get("source") == "Graana":
        # Graana search pages do not expose coordinates, so centroid mapping is less precise.
        score -= 4
    return max(0, min(100, score))


def within_islamabad_bounds(latitude: float | None, longitude: float | None) -> bool:
    if latitude is None or longitude is None:
        return False
    return (
        ISLAMABAD_BOUNDS["min_latitude"] <= latitude <= ISLAMABAD_BOUNDS["max_latitude"]
        and ISLAMABAD_BOUNDS["min_longitude"] <= longitude <= ISLAMABAD_BOUNDS["max_longitude"]
    )


def normalize_coordinates(latitude: float | None, longitude: float | None) -> tuple[float | None, float | None, str]:
    if within_islamabad_bounds(latitude, longitude):
        return latitude, longitude, "listing-detail"
    if within_islamabad_bounds(longitude, latitude):
        return longitude, latitude, "listing-detail-swapped"
    return None, None, "invalid-or-missing"


def seed_lookup() -> dict[str, SearchSeed]:
    config = get_config()
    return {seed.key: seed for seed in config.seeds}


def limit_summaries_balanced(summaries: list[dict[str, Any]], listing_limit: int | None) -> list[dict[str, Any]]:
    if listing_limit is None or listing_limit >= len(summaries):
        return summaries

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for summary in summaries:
        grouped[summary["seed"]].append(summary)

    ordered_seeds = sorted(grouped)
    selected: list[dict[str, Any]] = []
    index = 0
    while len(selected) < listing_limit:
        progressed = False
        for seed in ordered_seeds:
            bucket = grouped[seed]
            if index < len(bucket):
                selected.append(bucket[index])
                progressed = True
                if len(selected) >= listing_limit:
                    break
        if not progressed:
            break
        index += 1

    return selected


async def collect_seed_pages(
    scraper: ZameenScraper,
    seed: SearchSeed,
    pages_per_seed: int | None,
    full_scan: bool,
    refresh_cache: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    first_cache = scraper.config.search_cache_dir / seed.source / f"{seed.key}-page-0001.html"
    first_cached = first_cache.exists() and not refresh_cache
    try:
        first_html = await scraper.fetch_html(seed.url_template.format(page=1), first_cache, refresh=refresh_cache)
    except ScrapeError as error:
        logger.error("seed %s: first page fetch failed, skipping seed: %s", seed.key, error)
        stats = {
            "source": seed.source,
            "seed": seed.key,
            "label": seed.label,
            "propertyGroup": seed.property_group,
            "enabled": seed.enabled,
            "pagesScraped": 0,
            "pageCountDiscovered": 0,
            "listingCardsCollected": 0,
            "cacheHits": 0,
            "httpFailures": 1,
        }
        return [], stats

    first_page_listings, page_count = parse_search_page(first_html, seed, page_number=1)

    target_pages = page_count if full_scan else min(page_count, pages_per_seed or seed.default_pages)
    target_pages = max(1, target_pages)

    results = list(first_page_listings)
    cache_hits = 1 if first_cached else 0
    http_failures = 0
    if target_pages > 1:
        tasks = []
        for page_number in range(2, target_pages + 1):
            page_cache = scraper.config.search_cache_dir / seed.source / f"{seed.key}-page-{page_number:04d}.html"
            if page_cache.exists() and not refresh_cache:
                cache_hits += 1
            tasks.append(scraper.fetch_html(seed.url_template.format(page=page_number), page_cache, refresh=refresh_cache))

        pages = await asyncio.gather(*tasks, return_exceptions=True)
        for offset, html in enumerate(pages, start=2):
            if isinstance(html, Exception):
                http_failures += 1
                continue
            listings, _ = parse_search_page(html, seed, page_number=offset)
            results.extend(listings)

    stats = {
        "source": seed.source,
        "seed": seed.key,
        "label": seed.label,
        "propertyGroup": seed.property_group,
        "enabled": seed.enabled,
        "pagesScraped": target_pages,
        "pageCountDiscovered": page_count,
        "listingCardsCollected": len(results),
        "cacheHits": cache_hits,
        "httpFailures": http_failures,
    }
    logger.info(
        "seed %s: %d cards from %d/%d pages (cacheHits=%d, httpFailures=%d)",
        seed.key, len(results), target_pages, page_count, cache_hits, http_failures,
    )
    return results, stats


async def enrich_listing(
    scraper: ZameenScraper,
    summary: dict[str, Any],
    refresh_cache: bool,
) -> dict[str, Any]:
    if not summary.get("url"):
        return {}
    cache_path = scraper.config.detail_cache_dir / f"{summary['id']}.html"
    html = await scraper.fetch_html(summary["url"], cache_path, refresh=refresh_cache)
    return parse_detail_page(html)


def build_listing_record(summary: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
    payload = detail.get("payload", {})
    location = clean_text(summary.get("location") or detail.get("locationPath") or "")
    neighborhood = extract_location_name(payload, fallback=location)
    area_text = summary.get("areaText") or ""
    area_sqft = parse_area_to_sqft(area_text)
    price_pkr = detail.get("pricePkr") or summary.get("pricePkr") or parse_price_to_pkr(summary.get("priceText"))
    price_per_sqft = round(price_pkr / area_sqft, 2) if price_pkr and area_sqft else None
    price_per_marla = round(price_pkr / (area_sqft / 225.0), 2) if price_pkr and area_sqft else None
    source = summary.get("source") or "Zameen"
    source_id = str(summary.get("sourceListingId") or summary.get("id"))
    raw_latitude = detail.get("latitude") if detail.get("latitude") is not None else summary.get("latitude")
    raw_longitude = detail.get("longitude") if detail.get("longitude") is not None else summary.get("longitude")
    latitude, longitude, coordinate_source = normalize_coordinates(raw_latitude, raw_longitude)
    record = {
        "id": f"{canonical_text(source)}-{source_id}",
        "source": source,
        "sourceKey": summary.get("sourceKey") or canonical_text(source),
        "sourceListingId": source_id,
        "canonicalKey": "",
        "detailUrl": summary.get("detailUrl") or summary.get("url"),
        "benchmark": {
            "label": "FBR benchmark",
            "status": "unmatched",
            "referenceUrl": FBR_REFERENCE["url"],
            "documentUrl": FBR_REFERENCE["documentUrl"],
            "deltaPct": None,
        },
        "isOutlier": False,
        "outlierReasons": [],
        "confidenceBand": "Low",
        "sizeBand": size_band(area_sqft),
        "recencyBucket": recency_bucket(summary.get("freshnessHours") or parse_relative_age_hours(summary.get("updatedText") or summary.get("addedText"))),
        "sourceFetchedAt": None,
        "parseWarnings": [],
    }

    record.update(
        {
        "url": summary.get("url"),
        "title": clean_text(summary.get("title")),
        "priceText": clean_text(summary.get("priceText")),
        "pricePkr": price_pkr,
        "areaText": clean_text(area_text),
        "areaSqft": area_sqft,
        "pricePerSqft": price_per_sqft,
        "pricePerMarla": price_per_marla,
        "beds": detail.get("beds") or summary.get("beds"),
        "baths": detail.get("baths") or summary.get("baths"),
        "propertyGroup": summary.get("propertyGroup"),
        "propertyGroupLabel": summary.get("seedLabel"),
        "seed": summary.get("seed"),
        "location": location,
        "neighborhood": neighborhood,
        "city": detail.get("city") or summary.get("city") or "Islamabad",
        "latitude": latitude,
        "longitude": longitude,
        "coordinateSource": coordinate_source,
        "listingState": detail.get("listingState") or "active",
        "referenceId": detail.get("referenceId"),
        "agency": detail.get("agency") or summary.get("agency"),
        "imageUrl": detail.get("imageUrl") or summary.get("imageUrl"),
        "addedText": clean_text(summary.get("addedText")),
        "updatedText": clean_text(summary.get("updatedText")),
        "freshnessHours": summary.get("freshnessHours") or parse_relative_age_hours(summary.get("updatedText") or summary.get("addedText")),
        }
    )
    record["canonicalKey"] = build_canonical_key(record)
    record["parseWarnings"] = compute_parse_warnings(record)
    record["confidenceScore"] = compute_confidence_score(record)
    record["confidenceBand"] = confidence_band(record["confidenceScore"])
    record["recencyBucket"] = recency_bucket(record.get("freshnessHours"))
    return record


def impute_missing_coordinates(listings: list[dict[str, Any]]) -> None:
    coordinate_index: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for listing in listings:
        lat = listing.get("latitude")
        lon = listing.get("longitude")
        neighborhood = clean_text(listing.get("neighborhood"))
        if lat is not None and lon is not None and neighborhood:
            coordinate_index[neighborhood].append((lat, lon))

    for listing in listings:
        if listing.get("latitude") is not None and listing.get("longitude") is not None:
            continue
        neighborhood = clean_text(listing.get("neighborhood"))
        matches = coordinate_index.get(neighborhood, [])
        if not matches:
            continue
        lat = sum(item[0] for item in matches) / len(matches)
        lon = sum(item[1] for item in matches) / len(matches)
        listing["latitude"] = round(lat, 6)
        listing["longitude"] = round(lon, 6)
        listing["coordinateSource"] = "neighborhood-centroid"


def refresh_record_quality(listings: list[dict[str, Any]]) -> None:
    for listing in listings:
        listing["parseWarnings"] = compute_parse_warnings(listing)
        listing["confidenceScore"] = compute_confidence_score(listing)
        listing["confidenceBand"] = confidence_band(listing["confidenceScore"])
        listing["sizeBand"] = size_band(listing.get("areaSqft"))
        listing["recencyBucket"] = recency_bucket(listing.get("freshnessHours"))


def mark_outliers(listings: list[dict[str, Any]]) -> None:
    grouped: dict[tuple[str, str], list[float]] = defaultdict(list)
    for listing in listings:
        ppsf = listing.get("pricePerSqft")
        if ppsf is None:
            continue
        grouped[(listing.get("propertyGroup") or "", listing.get("neighborhood") or "")].append(float(ppsf))

    medians = {key: median_or_none(values) for key, values in grouped.items()}
    city_median = median_or_none(item.get("pricePerSqft") for item in listings)

    for listing in listings:
        ppsf = listing.get("pricePerSqft")
        reasons: list[str] = []
        if ppsf is None:
            reasons.append("missing ppsf")
        elif ppsf < 500 or ppsf > 150_000:
            reasons.append("outside plausible ppsf range")

        local_median = medians.get((listing.get("propertyGroup") or "", listing.get("neighborhood") or "")) or city_median
        if ppsf is not None and local_median:
            ratio = ppsf / local_median
            if ratio >= 4.5:
                reasons.append("far above comparable median")
            elif ratio <= 0.22:
                reasons.append("far below comparable median")

        listing["isOutlier"] = bool(reasons)
        listing["outlierReasons"] = reasons


def build_geojson(listings: list[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for listing in listings:
        lat = listing.get("latitude")
        lon = listing.get("longitude")
        if lat is None or lon is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": listing["id"],
                    "source": listing["source"],
                    "confidenceScore": listing["confidenceScore"],
                    "confidenceBand": listing["confidenceBand"],
                    "isOutlier": listing["isOutlier"],
                    "title": listing["title"],
                    "propertyGroup": listing["propertyGroup"],
                    "location": listing["location"],
                    "neighborhood": listing["neighborhood"],
                    "pricePkr": listing["pricePkr"],
                    "pricePerSqft": listing["pricePerSqft"],
                    "pricePerMarla": listing["pricePerMarla"],
                    "areaSqft": listing["areaSqft"],
                    "beds": listing["beds"],
                    "baths": listing["baths"],
                    "url": listing["url"],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_property_group_summary(listings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for listing in listings:
        grouped[listing["propertyGroup"]].append(listing)

    rows = []
    for group, items in grouped.items():
        median_items = [item for item in items if not item.get("isOutlier")]
        rows.append(
            {
                "propertyGroup": group,
                "label": items[0].get("propertyGroupLabel", group.title()),
                "listingCount": len(items),
                "mappedCount": sum(1 for item in items if item.get("latitude") is not None and item.get("longitude") is not None),
                "outlierCount": sum(1 for item in items if item.get("isOutlier")),
                "medianPricePkr": round_or_none(median_or_none(item.get("pricePkr") for item in median_items), 0),
                "medianPricePerSqft": round_or_none(median_or_none(item.get("pricePerSqft") for item in median_items), 2),
            }
        )
    rows.sort(key=lambda item: item["listingCount"], reverse=True)
    return rows


def build_neighborhood_summary(listings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for listing in listings:
        neighborhood = clean_text(listing.get("neighborhood"))
        if neighborhood:
            grouped[neighborhood].append(listing)

    rows = []
    for neighborhood, items in grouped.items():
        median_items = [item for item in items if not item.get("isOutlier")]
        rows.append(
            {
                "neighborhood": neighborhood,
                "listingCount": len(items),
                "mappedCount": sum(1 for item in items if item.get("latitude") is not None and item.get("longitude") is not None),
                "outlierCount": sum(1 for item in items if item.get("isOutlier")),
                "medianPricePkr": round_or_none(median_or_none(item.get("pricePkr") for item in median_items), 0),
                "medianPricePerSqft": round_or_none(median_or_none(item.get("pricePerSqft") for item in median_items), 2),
                "medianPricePerMarla": round_or_none(median_or_none(item.get("pricePerMarla") for item in median_items), 2),
            }
        )

    rows.sort(
        key=lambda item: (
            item["medianPricePerSqft"] is None,
            -(item["medianPricePerSqft"] or 0),
            -item["listingCount"],
        )
    )
    return rows


def compute_price_tier(median_price_per_sqft: float | None, ordered_values: list[float]) -> str:
    if median_price_per_sqft is None or not ordered_values:
        return "Value"

    position = sum(1 for value in ordered_values if value <= median_price_per_sqft) - 1
    percentile = (position + 1) / len(ordered_values)
    if percentile >= 0.75:
        return "Ultra Prime"
    if percentile >= 0.5:
        return "Premium"
    if percentile >= 0.25:
        return "Mid-market"
    return "Value"


def build_property_mix(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    total = len(items) or 1
    mix: dict[str, dict[str, Any]] = {}
    for group in ("house", "apartment", "plot"):
        count = sum(1 for item in items if item.get("propertyGroup") == group)
        mix[group] = {
            "label": PROPERTY_GROUP_LABELS[group],
            "count": count,
            "share": round(count / total, 4),
        }
    return mix


def build_source_mix(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    total = len(items) or 1
    sources = sorted({item.get("source") or "Unknown" for item in items})
    return {
        source: {
            "label": source,
            "count": sum(1 for item in items if (item.get("source") or "Unknown") == source),
            "share": round(sum(1 for item in items if (item.get("source") or "Unknown") == source) / total, 4),
        }
        for source in sources
    }


def build_neighborhood_intelligence(listings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for listing in listings:
        neighborhood = clean_text(listing.get("neighborhood"))
        if neighborhood:
            grouped[neighborhood].append(listing)

    baseline_listings = [item for item in listings if not item.get("isOutlier")]
    city_median_ppsf = median_or_none(item.get("pricePerSqft") for item in baseline_listings)
    city_median_ticket = median_or_none(item.get("pricePkr") for item in baseline_listings)
    rows = []

    for neighborhood, items in grouped.items():
        mapped_items = [item for item in items if item.get("latitude") is not None and item.get("longitude") is not None]
        latitudes = [item["latitude"] for item in mapped_items]
        longitudes = [item["longitude"] for item in mapped_items]
        median_items = [item for item in items if not item.get("isOutlier")]
        median_price_per_sqft = median_or_none(item.get("pricePerSqft") for item in median_items)
        median_price_pkr = median_or_none(item.get("pricePkr") for item in median_items)
        property_mix = build_property_mix(items)
        source_mix = build_source_mix(items)
        dominant_property_group = max(
            property_mix,
            key=lambda group: (property_mix[group]["count"], property_mix[group]["share"], PROPERTY_GROUP_LABELS[group]),
        )

        sample_listings = sorted(
            items,
            key=lambda item: (
                item.get("pricePerSqft") is None,
                -(item.get("pricePerSqft") or 0),
                -(item.get("pricePkr") or 0),
                item["id"],
            ),
        )[:3]

        rows.append(
            {
                "name": neighborhood,
                "centroid": {
                    "latitude": round(sum(latitudes) / len(latitudes), 6) if latitudes else None,
                    "longitude": round(sum(longitudes) / len(longitudes), 6) if longitudes else None,
                },
                "listingCount": len(items),
                "mappedCount": len(mapped_items),
                "outlierCount": sum(1 for item in items if item.get("isOutlier")),
                "confidenceMedian": round_or_none(median_or_none(item.get("confidenceScore") for item in items), 0),
                "medianPricePkr": round_or_none(median_price_pkr, 0),
                "medianPricePerSqft": round_or_none(median_price_per_sqft, 2),
                "medianPricePerMarla": round_or_none(median_or_none(item.get("pricePerMarla") for item in median_items), 2),
                "medianAreaSqft": round_or_none(median_or_none(item.get("areaSqft") for item in median_items), 2),
                "medianFreshnessHours": round_or_none(median_or_none(item.get("freshnessHours") for item in items), 2),
                "minPricePkr": round_or_none(min((item.get("pricePkr") for item in items if item.get("pricePkr") is not None), default=None), 0),
                "maxPricePkr": round_or_none(max((item.get("pricePkr") for item in items if item.get("pricePkr") is not None), default=None), 0),
                "dominantPropertyGroup": dominant_property_group,
                "propertyMix": property_mix,
                "sourceMix": source_mix,
                "benchmark": {
                    "label": "FBR benchmark",
                    "status": "unmatched",
                    "referenceUrl": FBR_REFERENCE["url"],
                    "documentUrl": FBR_REFERENCE["documentUrl"],
                    "deltaPct": None,
                },
                "cityMedianPpsfDeltaPct": round_or_none(
                    (((median_price_per_sqft or 0) - city_median_ppsf) / city_median_ppsf) * 100 if city_median_ppsf and median_price_per_sqft else None,
                    2,
                ),
                "cityMedianTicketDeltaPct": round_or_none(
                    (((median_price_pkr or 0) - city_median_ticket) / city_median_ticket) * 100 if city_median_ticket and median_price_pkr else None,
                    2,
                ),
                "priceTier": "Value",
                "sampleListings": [
                    {
                        "id": listing["id"],
                        "source": listing["source"],
                        "confidenceScore": listing["confidenceScore"],
                        "isOutlier": listing["isOutlier"],
                        "title": listing["title"],
                        "pricePkr": listing["pricePkr"],
                        "pricePerSqft": listing["pricePerSqft"],
                        "pricePerMarla": listing["pricePerMarla"],
                        "beds": listing["beds"],
                        "areaSqft": listing["areaSqft"],
                        "imageUrl": listing["imageUrl"],
                        "url": listing["url"],
                    }
                    for listing in sample_listings
                ],
            }
        )

    valid_ppsf = sorted(
        [item["medianPricePerSqft"] for item in rows if item.get("medianPricePerSqft") is not None]
    )
    for row in rows:
        row["priceTier"] = compute_price_tier(row.get("medianPricePerSqft"), valid_ppsf)

    rows.sort(
        key=lambda item: (
            -item["listingCount"],
            -(item.get("medianPricePerSqft") or 0),
            item["name"],
        )
    )
    return rows


def build_summary(
    listings: list[dict[str, Any]],
    seed_stats: list[dict[str, Any]],
    generated_at: str,
) -> dict[str, Any]:
    mapped = [item for item in listings if item.get("latitude") is not None and item.get("longitude") is not None]
    baseline_listings = [item for item in listings if not item.get("isOutlier")]
    neighborhood_summary = build_neighborhood_summary(listings)
    property_group_summary = build_property_group_summary(listings)

    freshness_values = [item.get("freshnessHours") for item in listings if item.get("freshnessHours") is not None]
    confidence_values = [item.get("confidenceScore") for item in listings if item.get("confidenceScore") is not None]
    return {
        "generatedAt": generated_at,
        "city": "Islamabad",
        "trackedListings": len(listings),
        "mappedListings": len(mapped),
        "outlierCount": sum(1 for item in listings if item.get("isOutlier")),
        "neighborhoodCount": len({clean_text(item.get("neighborhood")) for item in listings if clean_text(item.get("neighborhood"))}),
        "medianPricePkr": round_or_none(median_or_none(item.get("pricePkr") for item in baseline_listings), 0),
        "medianPricePerSqft": round_or_none(median_or_none(item.get("pricePerSqft") for item in baseline_listings), 2),
        "medianPricePerMarla": round_or_none(median_or_none(item.get("pricePerMarla") for item in baseline_listings), 2),
        "medianFreshnessHours": round_or_none(median_or_none(freshness_values), 1),
        "medianConfidenceScore": round_or_none(median_or_none(confidence_values), 0),
        "confidenceBands": {
            band: sum(1 for item in listings if item.get("confidenceBand") == band)
            for band in ("High", "Medium", "Low")
        },
        "sourceMix": build_source_mix(listings),
        "propertyGroups": property_group_summary,
        "topNeighborhoods": neighborhood_summary[:8],
        "seedStats": seed_stats,
        "fbrReference": FBR_REFERENCE,
    }


def build_history_entry(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": summary["generatedAt"],
        "trackedListings": summary["trackedListings"],
        "mappedListings": summary["mappedListings"],
        "outlierCount": summary.get("outlierCount"),
        "medianConfidenceScore": summary.get("medianConfidenceScore"),
        "medianPricePkr": summary["medianPricePkr"],
        "medianPricePerSqft": summary["medianPricePerSqft"],
    }


def missing_rate(items: list[dict[str, Any]], key: str) -> float:
    if not items:
        return 0.0
    return round(sum(1 for item in items if item.get(key) in (None, "")) / len(items), 4)


def build_source_health_report(
    listings: list[dict[str, Any]],
    seed_stats: list[dict[str, Any]],
    disabled_sources: dict[str, str],
    generated_at: str,
) -> dict[str, Any]:
    by_source: dict[str, dict[str, Any]] = {}
    all_sources = sorted({stat["source"] for stat in seed_stats} | set(disabled_sources))
    duplicate_keys = defaultdict(int)
    for listing in listings:
        duplicate_keys[listing.get("canonicalKey")] += 1

    for source in all_sources:
        source_listings = [item for item in listings if item.get("sourceKey") == source]
        stats = [item for item in seed_stats if item.get("source") == source]
        by_source[source] = {
            "label": {"zameen": "Zameen", "graana": "Graana", "olx": "OLX"}.get(source, source.title()),
            "enabled": source not in disabled_sources,
            "disabledReason": disabled_sources.get(source),
            "attemptedPages": sum(item.get("pagesScraped", 0) for item in stats),
            "fetchedPages": sum(max(0, item.get("pagesScraped", 0) - item.get("httpFailures", 0)) for item in stats),
            "parsedCards": sum(item.get("listingCardsCollected", 0) for item in stats),
            "exportedListings": len(source_listings),
            "detailSuccess": sum(1 for item in source_listings if item.get("coordinateSource") == "listing-detail"),
            "cacheHitRate": round(
                sum(item.get("cacheHits", 0) for item in stats) / max(1, sum(item.get("pagesScraped", 0) for item in stats)),
                4,
            ),
            "httpFailures": sum(item.get("httpFailures", 0) for item in stats),
            "duplicateRate": round(
                sum(1 for item in source_listings if duplicate_keys.get(item.get("canonicalKey"), 0) > 1) / max(1, len(source_listings)),
                4,
            ),
            "missingFieldRates": {
                "pricePkr": missing_rate(source_listings, "pricePkr"),
                "areaSqft": missing_rate(source_listings, "areaSqft"),
                "coordinates": round(
                    sum(1 for item in source_listings if item.get("latitude") is None or item.get("longitude") is None) / max(1, len(source_listings)),
                    4,
                ),
                "imageUrl": missing_rate(source_listings, "imageUrl"),
            },
            "seedStats": stats,
        }

    return {
        "generatedAt": generated_at,
        "sources": by_source,
        "disabledSources": disabled_sources,
    }


def build_quality_report(listings: list[dict[str, Any]], generated_at: str) -> dict[str, Any]:
    mapped = [item for item in listings if item.get("latitude") is not None and item.get("longitude") is not None]
    ppsf_values = [item.get("pricePerSqft") for item in listings if item.get("pricePerSqft") is not None]
    confidence_values = [item.get("confidenceScore") for item in listings if item.get("confidenceScore") is not None]
    duplicate_keys = defaultdict(int)
    for listing in listings:
        duplicate_keys[listing.get("canonicalKey")] += 1

    return {
        "generatedAt": generated_at,
        "listingCount": len(listings),
        "geocodingAccuracy": round(len(mapped) / max(1, len(listings)), 4),
        "priceParsingSuccess": round(1 - missing_rate(listings, "pricePkr"), 4),
        "areaParsingSuccess": round(1 - missing_rate(listings, "areaSqft"), 4),
        "freshnessWithin30Days": round(
            sum(1 for item in listings if item.get("freshnessHours") is not None and item["freshnessHours"] <= 24 * 30) / max(1, len(listings)),
            4,
        ),
        "duplicateRate": round(sum(1 for item in listings if duplicate_keys.get(item.get("canonicalKey"), 0) > 1) / max(1, len(listings)), 4),
        "outlierCount": sum(1 for item in listings if item.get("isOutlier")),
        "suspiciousPpsfCount": sum(1 for item in listings if "suspicious:pricePerSqft" in item.get("parseWarnings", [])),
        "confidenceMedian": round_or_none(median_or_none(confidence_values), 0),
        "confidenceBands": {
            band: sum(1 for item in listings if item.get("confidenceBand") == band)
            for band in ("High", "Medium", "Low")
        },
        "ppsfRange": {
            "min": round_or_none(min(ppsf_values, default=None), 2),
            "max": round_or_none(max(ppsf_values, default=None), 2),
            "median": round_or_none(median_or_none(ppsf_values), 2),
        },
        "topOutliers": [
            {
                "id": item["id"],
                "source": item["source"],
                "title": item["title"],
                "neighborhood": item["neighborhood"],
                "pricePerSqft": item["pricePerSqft"],
                "reasons": item["outlierReasons"],
                "url": item["url"],
            }
            for item in sorted(
                [item for item in listings if item.get("isOutlier")],
                key=lambda item: (-(item.get("pricePerSqft") or 0), item["id"]),
            )[:20]
        ],
        "fbrReference": FBR_REFERENCE,
    }


def update_history(history_path: Path, entry: dict[str, Any]) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    if history_path.exists():
        import json

        history = json.loads(history_path.read_text(encoding="utf-8"))

    if not history or history[-1].get("timestamp") != entry["timestamp"]:
        history.append(entry)
    return history[-120:]


def write_snapshot_bundle(
    snapshot_root: Path,
    timestamp: str,
    listings: list[dict[str, Any]],
    neighborhoods: list[dict[str, Any]],
    summary: dict[str, Any],
    geojson: dict[str, Any],
    report: dict[str, Any],
    source_health: dict[str, Any],
    quality_report: dict[str, Any],
) -> None:
    slug = timestamp.replace(":", "-")
    bundle_dir = snapshot_root / slug
    ensure_directories([bundle_dir])
    write_json(bundle_dir / "listings.json", listings)
    write_json(bundle_dir / "neighborhoods.json", neighborhoods)
    write_json(bundle_dir / "summary.json", summary)
    write_json(bundle_dir / "map_points.geojson", geojson)
    write_json(bundle_dir / "report.json", report)
    write_json(bundle_dir / "source_health.json", source_health)
    write_json(bundle_dir / "quality_report.json", quality_report)


async def run_pipeline(
    pages_per_seed: int | None,
    full_scan: bool,
    refresh_cache: bool,
    selected_seeds: list[str] | None,
    listing_limit: int | None,
    min_listings: int | None = None,
) -> dict[str, Any]:
    config = get_config()
    ensure_directories(
        [
            config.search_cache_dir,
            config.detail_cache_dir,
            config.processed_dir,
            config.snapshot_dir,
            config.cache_dir,
        ]
    )

    active_seeds = [
        seed
        for seed in config.seeds
        if seed.enabled
        and seed.source in config.enabled_sources
        and (not selected_seeds or seed.key in selected_seeds)
    ]
    active_seed_by_key = {seed.key: seed for seed in active_seeds}
    scraper = ZameenScraper(config)
    try:
        all_summaries: list[dict[str, Any]] = []
        seed_stats: list[dict[str, Any]] = []
        for seed in active_seeds:
            listings, stats = await collect_seed_pages(
                scraper=scraper,
                seed=seed,
                pages_per_seed=pages_per_seed,
                full_scan=full_scan,
                refresh_cache=refresh_cache,
            )
            all_summaries.extend(listings)
            seed_stats.append(stats)

        deduped: dict[Any, dict[str, Any]] = {}
        for summary in all_summaries:
            listing_id = summary["id"]
            if listing_id in deduped:
                deduped[listing_id] = merge_summary(deduped[listing_id], summary)
            else:
                deduped[listing_id] = summary

        summary_list = list(deduped.values())
        summary_list = limit_summaries_balanced(summary_list, listing_limit)

        detail_tasks = []
        for summary in summary_list:
            seed = active_seed_by_key.get(summary.get("seed"))
            if seed and seed.requires_detail:
                detail_tasks.append(enrich_listing(scraper, summary, refresh_cache=refresh_cache))
            else:
                detail_tasks.append(asyncio.sleep(0, result={}))

        details = await asyncio.gather(*detail_tasks, return_exceptions=True)
        detail_failures = sum(1 for detail in details if not isinstance(detail, dict))
        if detail_failures:
            logger.warning("detail enrichment failed for %d/%d listings", detail_failures, len(details))
        normalized_details = [detail if isinstance(detail, dict) else {} for detail in details]

        listings = [build_listing_record(summary, detail) for summary, detail in zip(summary_list, normalized_details, strict=True)]
        impute_missing_coordinates(listings)
        generated_at = utc_now_iso()
        for listing in listings:
            listing["sourceFetchedAt"] = generated_at
        refresh_record_quality(listings)
        mark_outliers(listings)
        listings.sort(key=lambda item: ((item.get("pricePerSqft") is None), item.get("isOutlier", False), -(item.get("pricePerSqft") or 0), str(item["id"])))

        geojson = build_geojson(listings)
        neighborhoods = build_neighborhood_intelligence(listings)
        source_health = build_source_health_report(
            listings,
            seed_stats=seed_stats,
            disabled_sources=config.disabled_sources,
            generated_at=generated_at,
        )
        quality_report = build_quality_report(listings, generated_at=generated_at)
        report = {
            "generatedAt": generated_at,
            "searchCardCount": len(all_summaries),
            "uniqueListingCount": len(deduped),
            "exportedListingCount": len(listings),
            "seedStats": seed_stats,
            "sourceHealth": source_health,
            "quality": quality_report,
        }
        summary = build_summary(listings, seed_stats=seed_stats, generated_at=generated_at)

        # Fail-loud guard: refuse to overwrite good data with a degraded scrape
        # (e.g. site layout change or a wide block produced almost no listings).
        threshold = config.min_expected_listings if min_listings is None else min_listings
        total_failures = sum(stat.get("httpFailures", 0) for stat in seed_stats)
        logger.info(
            "pipeline built %d listings across %d neighborhoods (cards=%d, httpFailures=%d)",
            len(listings), summary["neighborhoodCount"], len(all_summaries), total_failures,
        )
        if threshold and len(listings) < threshold:
            raise DegradedRunError(
                f"exported {len(listings)} listings, below minimum of {threshold}; "
                "refusing to overwrite existing dataset (use --min-listings 0 to override)."
            )

        history_path = config.processed_dir / "history.json"
        history = update_history(history_path, build_history_entry(summary))

        write_json(config.processed_dir / "listings.json", listings)
        write_json(config.processed_dir / "neighborhoods.json", neighborhoods)
        compact_json(config.processed_dir / "map_points.geojson", geojson)
        write_json(config.processed_dir / "summary.json", summary)
        write_json(history_path, history)
        write_json(config.processed_dir / "report.json", report)
        write_json(config.processed_dir / "source_health.json", source_health)
        write_json(config.processed_dir / "quality_report.json", quality_report)
        write_database_bundle(
            config.database_path,
            listings=listings,
            neighborhoods=neighborhoods,
            summary=summary,
            history=history,
            geojson=geojson,
            report=report,
            source_health=source_health,
            quality_report=quality_report,
        )
        write_snapshot_bundle(config.snapshot_dir, generated_at, listings, neighborhoods, summary, geojson, report, source_health, quality_report)

        return {
            "neighborhoods": neighborhoods,
            "summary": summary,
            "history": history,
            "report": report,
            "sourceHealth": source_health,
            "qualityReport": quality_report,
        }
    finally:
        await scraper.aclose()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build the Islamabad property price atlas dataset.")
    parser.add_argument("--pages-per-seed", type=int, default=None, help="Override the default page count per source seed.")
    parser.add_argument("--full-scan", action="store_true", help="Scrape every discovered search results page for each active seed.")
    parser.add_argument("--refresh-cache", action="store_true", help="Re-fetch search and detail pages even if cached HTML exists.")
    parser.add_argument("--seed", action="append", dest="selected_seeds", choices=sorted(seed_lookup()), help="Limit the run to one or more specific seeds.")
    parser.add_argument("--listing-limit", type=int, default=None, help="Trim the enriched listing count for quick local verification runs.")
    parser.add_argument(
        "--min-listings",
        type=int,
        default=None,
        help="Fail the run (non-zero exit, no data overwrite) if fewer listings are exported. "
        "Defaults to the configured guard; pass 0 to disable.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = asyncio.run(
            run_pipeline(
                pages_per_seed=args.pages_per_seed,
                full_scan=args.full_scan,
                refresh_cache=args.refresh_cache,
                selected_seeds=args.selected_seeds,
                listing_limit=args.listing_limit,
                min_listings=args.min_listings,
            )
        )
    except DegradedRunError as error:
        logger.error("degraded run aborted: %s", error)
        raise SystemExit(2) from error
    summary = result["summary"]
    print(
        f"Built Islamabad dataset at {summary['generatedAt']} with "
        f"{summary['trackedListings']} listings across {summary['neighborhoodCount']} neighborhoods."
    )


if __name__ == "__main__":
    main()
