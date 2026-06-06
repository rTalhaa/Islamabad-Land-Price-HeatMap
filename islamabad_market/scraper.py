from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from .config import AppConfig, SearchSeed
from .parsers import (
    absolute_url,
    clean_text,
    extract_data_layer_payload,
    parse_listing_id,
)
from .utils import ensure_directory, safe_float, safe_int


class ZameenScraper:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self._client = httpx.AsyncClient(
            headers={"User-Agent": config.user_agent},
            timeout=config.request_timeout_seconds,
            follow_redirects=True,
        )
        self._semaphore = asyncio.Semaphore(config.detail_concurrency)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_html(self, url: str, cache_path: Path, refresh: bool = False) -> str:
        ensure_directory(cache_path.parent)
        if cache_path.exists() and not refresh:
            return cache_path.read_text(encoding="utf-8")

        async with self._semaphore:
            response = await self._client.get(url)
            response.raise_for_status()
            html = response.text
            cache_path.write_text(html, encoding="utf-8")
            await asyncio.sleep(self.config.delay_between_requests_seconds)
            return html


NEXT_DATA_PATTERN = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)


def source_display_name(source: str) -> str:
    return {
        "zameen": "Zameen",
        "graana": "Graana",
        "olx": "OLX",
    }.get(source, source.title())


def normalize_graana_group(subtype: str | None, fallback: str) -> str:
    value = clean_text(subtype or "").lower()
    if value in {"flat", "apartment", "penthouse"}:
        return "apartment"
    if "plot" in value or value in {"land"}:
        return "plot"
    if value in {"house", "farmhouse", "upper portion", "lower portion"}:
        return "house"
    return fallback if fallback != "mixed" else "house"


def parse_iso_age_hours(value: str | None) -> float | None:
    if not value:
        return None
    from datetime import UTC, datetime

    try:
        created = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0.0, (datetime.now(UTC) - created.astimezone(UTC)).total_seconds() / 3600)


def parse_search_page(html: str, seed: SearchSeed, page_number: int) -> tuple[list[dict[str, Any]], int]:
    if seed.source == "graana":
        return parse_graana_search_page(html, seed, page_number)
    if seed.source == "olx":
        return [], page_number
    return parse_zameen_search_page(html, seed, page_number)


def parse_zameen_search_page(html: str, seed: SearchSeed, page_number: int) -> tuple[list[dict[str, Any]], int]:
    soup = BeautifulSoup(html, "html.parser")
    payload = extract_data_layer_payload(html)
    page_count = safe_int(payload.get("pageCount")) or page_number

    listings: list[dict[str, Any]] = []
    for article in soup.select("li[role='article'] article"):
        link = article.select_one("a[aria-label='Listing link']")
        href = link.get("href") if link else None
        listing_id = parse_listing_id(href)
        if listing_id is None:
            continue

        title_node = article.select_one("h2[aria-label='Title']")
        location_node = article.select_one("[aria-label='Location']")
        price_node = article.select_one("[aria-label='Price']")
        beds_node = article.select_one("[aria-label='Beds']")
        baths_node = article.select_one("[aria-label='Baths']")
        area_node = article.select_one("[aria-label='Area']")
        added_node = article.select_one("[aria-label='Listing creation date']")
        updated_node = article.select_one("[aria-label='Listing updated date']")

        listings.append(
            {
                "id": listing_id,
                "source": "Zameen",
                "sourceKey": seed.source,
                "sourceListingId": str(listing_id),
                "seed": seed.key,
                "seedLabel": seed.label,
                "propertyGroup": seed.property_group,
                "page": page_number,
                "url": absolute_url(href),
                "detailUrl": absolute_url(href),
                "title": clean_text(title_node.get_text(" ", strip=True) if title_node else link.get("title", "")),
                "location": clean_text(location_node.get_text(" ", strip=True) if location_node else ""),
                "priceText": clean_text(price_node.get_text(" ", strip=True) if price_node else ""),
                "beds": safe_int(clean_text(beds_node.get_text(" ", strip=True) if beds_node else "")),
                "baths": safe_int(clean_text(baths_node.get_text(" ", strip=True) if baths_node else "")),
                "areaText": clean_text(area_node.get_text(" ", strip=True) if area_node else ""),
                "addedText": clean_text(added_node.get_text(" ", strip=True) if added_node else ""),
                "updatedText": clean_text(updated_node.get_text(" ", strip=True) if updated_node else ""),
            }
        )

    return listings, page_count


def parse_graana_search_page(html: str, seed: SearchSeed, page_number: int) -> tuple[list[dict[str, Any]], int]:
    match = NEXT_DATA_PATTERN.search(html)
    if not match:
        return [], page_number

    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return [], page_number

    page_props = payload.get("props", {}).get("pageProps", {})
    raw_properties = page_props.get("properties")
    if raw_properties is None:
        raw_properties = []
        for city_bucket in page_props.get("data", []):
            if clean_text(str(city_bucket.get("name", ""))).lower() == "islamabad":
                raw_properties.extend(city_bucket.get("properties", []))

    listings: list[dict[str, Any]] = []
    for item in raw_properties or []:
        city = item.get("city") or {}
        city_name = clean_text(str(city.get("name") or "Islamabad"))
        if city_name.lower() != "islamabad":
            continue

        source_id = str(item.get("id") or "")
        if not source_id:
            continue

        area = item.get("area") or {}
        area_name = clean_text(str(area.get("name") or ""))
        title = clean_text(str(item.get("customTitle") or item.get("title") or f"{area_name} property for sale"))
        size = item.get("size")
        unit = clean_text(str(item.get("sizeUnit") or ""))
        area_text = f"{size} {unit}".strip() if size is not None and unit else ""
        property_group = normalize_graana_group(item.get("subtype"), seed.property_group)
        image_url = ""
        images = item.get("propertyImages") or []
        if images:
            image_url = urljoin("https://www.graana.com", clean_text(str(images[0].get("url") or "")))

        listings.append(
            {
                "id": f"graana-{source_id}",
                "source": "Graana",
                "sourceKey": seed.source,
                "sourceListingId": source_id,
                "seed": seed.key,
                "seedLabel": seed.label,
                "propertyGroup": property_group,
                "page": page_number,
                "url": f"https://www.graana.com/property/{source_id}",
                "detailUrl": f"https://www.graana.com/property/{source_id}",
                "title": title,
                "location": ", ".join(part for part in [area_name, city_name] if part),
                "priceText": str(item.get("price") or ""),
                "pricePkr": safe_int(item.get("price")),
                "beds": safe_int(item.get("bed")),
                "baths": safe_int(item.get("bath")),
                "areaText": area_text,
                "addedText": clean_text(str(item.get("createdAt") or "")),
                "updatedText": clean_text(str(item.get("updatedAt") or item.get("createdAt") or "")),
                "freshnessHours": parse_iso_age_hours(item.get("updatedAt") or item.get("createdAt")),
                "city": city_name,
                "locName": area_name,
                "locationPath": ", ".join(part for part in [area_name, city_name] if part),
                "imageUrl": image_url,
                "agency": clean_text(str((item.get("agency") or {}).get("name") or item.get("name") or "")),
            }
        )

    # Graana currently returns 30 records per page on these public listing routes.
    page_count = max(page_number, page_number + 1 if len(listings) >= 30 else page_number)
    return listings, page_count


def parse_detail_page(html: str) -> dict[str, Any]:
    payload = extract_data_layer_payload(html)
    if not payload:
        return {}

    loc_name = clean_text(str(payload.get("loc_name", ""))).strip("; ")
    loc_3_name = clean_text(str(payload.get("loc_3_name", ""))).strip("; ")
    loc_2_name = clean_text(str(payload.get("loc_2_name", ""))).strip("; ")
    city = clean_text(str(payload.get("city_name", ""))).strip("; ") or loc_2_name

    return {
        "payload": payload,
        "pricePkr": safe_int(payload.get("property_price") or payload.get("price")),
        "latitude": safe_float(payload.get("latitude")),
        "longitude": safe_float(payload.get("longitude")),
        "beds": safe_int(payload.get("property_beds")),
        "baths": safe_int(payload.get("property_baths_list", [None])[0] if payload.get("property_baths_list") else None),
        "referenceId": clean_text(str(payload.get("reference_id", ""))),
        "listingState": clean_text(str(payload.get("listing_state", ""))),
        "categoryName": clean_text(str(payload.get("category_2_name", ""))).replace("_", " "),
        "locName": loc_name or loc_3_name,
        "city": city,
        "locationPath": ", ".join(part for part in [loc_name or loc_3_name, city] if part),
        "imageUrl": clean_text(str(payload.get("property_image_url", ""))),
        "agency": clean_text(str(payload.get("marketed_by", ""))),
    }
