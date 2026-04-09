from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

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


def parse_search_page(html: str, seed: SearchSeed, page_number: int) -> tuple[list[dict[str, Any]], int]:
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
                "seed": seed.key,
                "seedLabel": seed.label,
                "propertyGroup": seed.property_group,
                "page": page_number,
                "url": absolute_url(href),
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
