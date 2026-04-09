from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from pathlib import Path
from typing import Any

from .config import SearchSeed, get_config
from .parsers import (
    clean_text,
    extract_location_name,
    parse_area_to_sqft,
    parse_price_to_pkr,
    parse_relative_age_hours,
)
from .scraper import ZameenScraper, parse_detail_page, parse_search_page
from .utils import compact_json, ensure_directories, median_or_none, round_or_none, utc_now_iso, write_json


def merge_summary(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in incoming.items():
        if merged.get(key) in (None, "", []) and value not in (None, "", []):
            merged[key] = value
    return merged


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
    first_cache = scraper.config.search_cache_dir / f"{seed.key}-page-0001.html"
    first_html = await scraper.fetch_html(seed.url_template.format(page=1), first_cache, refresh=refresh_cache)
    first_page_listings, page_count = parse_search_page(first_html, seed, page_number=1)

    target_pages = page_count if full_scan else min(page_count, pages_per_seed or seed.default_pages)
    target_pages = max(1, target_pages)

    results = list(first_page_listings)
    if target_pages > 1:
        tasks = []
        for page_number in range(2, target_pages + 1):
            page_cache = scraper.config.search_cache_dir / f"{seed.key}-page-{page_number:04d}.html"
            tasks.append(scraper.fetch_html(seed.url_template.format(page=page_number), page_cache, refresh=refresh_cache))

        pages = await asyncio.gather(*tasks)
        for offset, html in enumerate(pages, start=2):
            listings, _ = parse_search_page(html, seed, page_number=offset)
            results.extend(listings)

    stats = {
        "seed": seed.key,
        "label": seed.label,
        "propertyGroup": seed.property_group,
        "pagesScraped": target_pages,
        "pageCountDiscovered": page_count,
        "listingCardsCollected": len(results),
    }
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
    price_pkr = detail.get("pricePkr") or parse_price_to_pkr(summary.get("priceText"))
    price_per_sqft = round(price_pkr / area_sqft, 2) if price_pkr and area_sqft else None
    price_per_marla = round(price_pkr / (area_sqft / 225.0), 2) if price_pkr and area_sqft else None

    return {
        "id": summary["id"],
        "source": "Zameen.com",
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
        "city": detail.get("city") or "Islamabad",
        "latitude": detail.get("latitude"),
        "longitude": detail.get("longitude"),
        "coordinateSource": "listing-detail" if detail.get("latitude") and detail.get("longitude") else "unknown",
        "listingState": detail.get("listingState") or "active",
        "referenceId": detail.get("referenceId"),
        "agency": detail.get("agency"),
        "imageUrl": detail.get("imageUrl"),
        "addedText": clean_text(summary.get("addedText")),
        "updatedText": clean_text(summary.get("updatedText")),
        "freshnessHours": parse_relative_age_hours(summary.get("updatedText") or summary.get("addedText")),
    }


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
        rows.append(
            {
                "propertyGroup": group,
                "label": items[0].get("propertyGroupLabel", group.title()),
                "listingCount": len(items),
                "mappedCount": sum(1 for item in items if item.get("latitude") is not None and item.get("longitude") is not None),
                "medianPricePkr": round_or_none(median_or_none(item.get("pricePkr") for item in items), 0),
                "medianPricePerSqft": round_or_none(median_or_none(item.get("pricePerSqft") for item in items), 2),
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
        rows.append(
            {
                "neighborhood": neighborhood,
                "listingCount": len(items),
                "mappedCount": sum(1 for item in items if item.get("latitude") is not None and item.get("longitude") is not None),
                "medianPricePkr": round_or_none(median_or_none(item.get("pricePkr") for item in items), 0),
                "medianPricePerSqft": round_or_none(median_or_none(item.get("pricePerSqft") for item in items), 2),
                "medianPricePerMarla": round_or_none(median_or_none(item.get("pricePerMarla") for item in items), 2),
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


def build_summary(
    listings: list[dict[str, Any]],
    seed_stats: list[dict[str, Any]],
    generated_at: str,
) -> dict[str, Any]:
    mapped = [item for item in listings if item.get("latitude") is not None and item.get("longitude") is not None]
    neighborhood_summary = build_neighborhood_summary(listings)
    property_group_summary = build_property_group_summary(listings)

    freshness_values = [item.get("freshnessHours") for item in listings if item.get("freshnessHours") is not None]
    return {
        "generatedAt": generated_at,
        "city": "Islamabad",
        "trackedListings": len(listings),
        "mappedListings": len(mapped),
        "neighborhoodCount": len({clean_text(item.get("neighborhood")) for item in listings if clean_text(item.get("neighborhood"))}),
        "medianPricePkr": round_or_none(median_or_none(item.get("pricePkr") for item in listings), 0),
        "medianPricePerSqft": round_or_none(median_or_none(item.get("pricePerSqft") for item in listings), 2),
        "medianFreshnessHours": round_or_none(median_or_none(freshness_values), 1),
        "propertyGroups": property_group_summary,
        "topNeighborhoods": neighborhood_summary[:8],
        "seedStats": seed_stats,
    }


def build_history_entry(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": summary["generatedAt"],
        "trackedListings": summary["trackedListings"],
        "mappedListings": summary["mappedListings"],
        "medianPricePkr": summary["medianPricePkr"],
        "medianPricePerSqft": summary["medianPricePerSqft"],
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
    summary: dict[str, Any],
    geojson: dict[str, Any],
    report: dict[str, Any],
) -> None:
    slug = timestamp.replace(":", "-")
    bundle_dir = snapshot_root / slug
    ensure_directories([bundle_dir])
    write_json(bundle_dir / "listings.json", listings)
    write_json(bundle_dir / "summary.json", summary)
    write_json(bundle_dir / "map_points.geojson", geojson)
    write_json(bundle_dir / "report.json", report)


async def run_pipeline(
    pages_per_seed: int | None,
    full_scan: bool,
    refresh_cache: bool,
    selected_seeds: list[str] | None,
    listing_limit: int | None,
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

    active_seeds = [seed for seed in config.seeds if not selected_seeds or seed.key in selected_seeds]
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

        deduped: dict[int, dict[str, Any]] = {}
        for summary in all_summaries:
            listing_id = summary["id"]
            if listing_id in deduped:
                deduped[listing_id] = merge_summary(deduped[listing_id], summary)
            else:
                deduped[listing_id] = summary

        summary_list = list(deduped.values())
        summary_list = limit_summaries_balanced(summary_list, listing_limit)

        details = await asyncio.gather(
            *(enrich_listing(scraper, summary, refresh_cache=refresh_cache) for summary in summary_list)
        )

        listings = [build_listing_record(summary, detail) for summary, detail in zip(summary_list, details, strict=True)]
        impute_missing_coordinates(listings)
        listings.sort(key=lambda item: ((item.get("pricePerSqft") is None), -(item.get("pricePerSqft") or 0), item["id"]))

        generated_at = utc_now_iso()
        geojson = build_geojson(listings)
        report = {
            "generatedAt": generated_at,
            "searchCardCount": len(all_summaries),
            "uniqueListingCount": len(deduped),
            "exportedListingCount": len(listings),
            "seedStats": seed_stats,
        }
        summary = build_summary(listings, seed_stats=seed_stats, generated_at=generated_at)

        history_path = config.processed_dir / "history.json"
        history = update_history(history_path, build_history_entry(summary))

        write_json(config.processed_dir / "listings.json", listings)
        compact_json(config.processed_dir / "map_points.geojson", geojson)
        write_json(config.processed_dir / "summary.json", summary)
        write_json(history_path, history)
        write_json(config.processed_dir / "report.json", report)
        write_snapshot_bundle(config.snapshot_dir, generated_at, listings, summary, geojson, report)

        return {
            "summary": summary,
            "history": history,
            "report": report,
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
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    result = asyncio.run(
        run_pipeline(
            pages_per_seed=args.pages_per_seed,
            full_scan=args.full_scan,
            refresh_cache=args.refresh_cache,
            selected_seeds=args.selected_seeds,
            listing_limit=args.listing_limit,
        )
    )
    summary = result["summary"]
    print(
        f"Built Islamabad dataset at {summary['generatedAt']} with "
        f"{summary['trackedListings']} listings across {summary['neighborhoodCount']} neighborhoods."
    )


if __name__ == "__main__":
    main()
