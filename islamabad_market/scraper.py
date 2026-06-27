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
from .utils import ensure_directory, get_logger, safe_float, safe_int


logger = get_logger("islamabad_market.scraper")


class ScrapeError(RuntimeError):
    """Raised when a URL cannot be fetched after exhausting all retries."""


def _retry_after_seconds(response: httpx.Response, fallback: float) -> float:
    """Honor a server-provided Retry-After header (seconds form) when present."""
    raw = response.headers.get("Retry-After")
    if not raw:
        return fallback
    try:
        return max(fallback, float(raw))
    except (TypeError, ValueError):
        return fallback


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
            html = await self._fetch_with_retries(url)
            cache_path.write_text(html, encoding="utf-8")
            await asyncio.sleep(self.config.delay_between_requests_seconds)
            return html

    async def _fetch_with_retries(self, url: str) -> str:
        """Fetch a URL with exponential backoff over transient failures.

        Retries network errors and the configured retryable HTTP statuses (e.g.
        429/5xx). Non-retryable status errors (e.g. 403/404) fail fast. Raises
        ScrapeError once retries are exhausted so callers can count the failure.
        """
        attempts = self.config.max_retries + 1
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = await self._client.get(url)
            except httpx.RequestError as error:
                last_error = error
                if attempt == attempts:
                    break
                delay = self.config.retry_backoff_seconds * (2 ** (attempt - 1))
                logger.warning("request error for %s (attempt %d/%d): %s; retrying in %.1fs", url, attempt, attempts, error, delay)
                await asyncio.sleep(delay)
                continue

            status = response.status_code
            if status < 400:
                return response.text

            if status in self.config.retryable_statuses and attempt < attempts:
                base_delay = self.config.retry_backoff_seconds * (2 ** (attempt - 1))
                delay = _retry_after_seconds(response, base_delay)
                logger.warning("HTTP %d for %s (attempt %d/%d); retrying in %.1fs", status, url, attempt, attempts, delay)
                await asyncio.sleep(delay)
                last_error = httpx.HTTPStatusError(f"HTTP {status}", request=response.request, response=response)
                continue

            # Non-retryable status (e.g. 403 block, 404 gone) — fail fast.
            logger.error("HTTP %d for %s; not retrying", status, url)
            raise ScrapeError(f"HTTP {status} for {url}")

        logger.error("exhausted %d attempts for %s: %s", attempts, url, last_error)
        raise ScrapeError(f"failed to fetch {url} after {attempts} attempts: {last_error}")


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
        return parse_olx_search_page(html, seed, page_number)
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


def normalize_olx_group(category: str | None, title: str, fallback: str) -> str:
    text = clean_text(f"{category or ''} {title}").lower()
    if "plot" in text or "land" in text:
        return "plot"
    if any(token in text for token in ("flat", "apartment", "penthouse", "portion")):
        return "apartment"
    if "house" in text or "home" in text:
        return "house"
    return fallback if fallback != "mixed" else "house"


def _find_olx_ads(node: Any, found: list[dict[str, Any]]) -> None:
    """Recursively collect OLX ad dicts from the embedded __NEXT_DATA__ tree.

    OLX nests its result list under varying keys across page versions, so rather
    than hard-coding a path we walk the tree and keep dicts that look like ads
    (an id plus a title and a price block).
    """
    if isinstance(node, dict):
        has_price = "price" in node or "price_value" in node
        if node.get("id") is not None and node.get("title") and has_price:
            found.append(node)
            return
        for value in node.values():
            _find_olx_ads(value, found)
    elif isinstance(node, list):
        for value in node:
            _find_olx_ads(value, found)


def _olx_price_pkr(ad: dict[str, Any]) -> int | None:
    price = ad.get("price")
    if isinstance(price, dict):
        value = price.get("value")
        if isinstance(value, dict):
            return safe_int(value.get("raw"))
        return safe_int(value)
    return safe_int(ad.get("price_value") or price)


def _olx_param(ad: dict[str, Any], key: str) -> Any:
    """Read a value from OLX's parameters array (area, bedrooms, etc.)."""
    for param in ad.get("parameters") or []:
        if isinstance(param, dict) and param.get("key") == key:
            return param.get("value") or param.get("value_name")
    return None


def parse_olx_search_page(html: str, seed: SearchSeed, page_number: int) -> tuple[list[dict[str, Any]], int]:
    match = NEXT_DATA_PATTERN.search(html)
    if not match:
        return [], page_number

    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return [], page_number

    ads: list[dict[str, Any]] = []
    _find_olx_ads(payload.get("props", payload), ads)

    listings: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ad in ads:
        source_id = str(ad.get("id") or "")
        if not source_id or source_id in seen:
            continue

        resolved = ad.get("locations_resolved") or {}
        city_name = clean_text(str(resolved.get("ADMIN_LEVEL_3_name") or resolved.get("CITY_name") or "Islamabad"))
        if "islamabad" not in city_name.lower():
            continue
        seen.add(source_id)

        area_name = clean_text(
            str(resolved.get("SUBLOCALITY_LEVEL_1_name") or resolved.get("SUBLOCALITY_LEVEL_2_name") or "")
        )
        title = clean_text(str(ad.get("title") or ""))
        url = clean_text(str(ad.get("url") or "")) or f"https://www.olx.com.pk/item/{source_id}"
        if url.startswith("/"):
            url = urljoin("https://www.olx.com.pk", url)

        images = ad.get("images") or []
        image_url = ""
        if images and isinstance(images[0], dict):
            image_url = clean_text(str(images[0].get("url") or ""))

        area_value = _olx_param(ad, "area")
        unit = clean_text(str(_olx_param(ad, "area_unit") or "")) or "sqft"
        area_text = f"{area_value} {unit}".strip() if area_value else ""

        listings.append(
            {
                "id": f"olx-{source_id}",
                "source": "OLX",
                "sourceKey": seed.source,
                "sourceListingId": source_id,
                "seed": seed.key,
                "seedLabel": seed.label,
                "propertyGroup": normalize_olx_group(_olx_param(ad, "type"), title, seed.property_group),
                "page": page_number,
                "url": url,
                "detailUrl": url,
                "title": title,
                "location": ", ".join(part for part in [area_name, city_name] if part),
                "priceText": clean_text(str((ad.get("price") or {}).get("value", {}).get("display", "")))
                if isinstance(ad.get("price"), dict)
                else "",
                "pricePkr": _olx_price_pkr(ad),
                "beds": safe_int(_olx_param(ad, "bedrooms")),
                "baths": safe_int(_olx_param(ad, "bathrooms")),
                "areaText": area_text,
                "addedText": clean_text(str(ad.get("created_at_first") or ad.get("created_at") or "")),
                "updatedText": clean_text(str(ad.get("created_at") or "")),
                "freshnessHours": parse_iso_age_hours(ad.get("created_at")),
                "city": city_name,
                "locName": area_name,
                "locationPath": ", ".join(part for part in [area_name, city_name] if part),
                "latitude": safe_float(ad.get("map_lat")),
                "longitude": safe_float(ad.get("map_lon")),
                "imageUrl": image_url,
                "agency": "",
            }
        )

    # OLX paginates at 40 ads per page on these listing routes.
    page_count = page_number + 1 if len(listings) >= 40 else page_number
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
