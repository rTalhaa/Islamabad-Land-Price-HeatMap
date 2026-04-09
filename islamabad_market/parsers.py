from __future__ import annotations

import json
import re
from html import unescape
from typing import Any
from urllib.parse import urljoin


LISTING_ID_PATTERN = re.compile(r"-(\d+)-\d+-\d+\.html$")
DATA_LAYER_PATTERN = re.compile(r"window\['dataLayer'\].*?push\((\{.*?\})\);</script>", re.S)

PRICE_UNIT_MULTIPLIERS = {
    "thousand": 1_000,
    "lakh": 100_000,
    "lac": 100_000,
    "crore": 10_000_000,
    "arab": 1_000_000_000,
    "million": 1_000_000,
    "billion": 1_000_000_000,
}

AREA_UNIT_TO_SQFT = {
    "kanal": 4500.0,
    "marla": 225.0,
    "sqft": 1.0,
    "sq ft": 1.0,
    "sq. ft": 1.0,
    "square feet": 1.0,
    "square foot": 1.0,
    "sqyd": 9.0,
    "sq yd": 9.0,
    "sq. yd": 9.0,
    "square yard": 9.0,
    "square yards": 9.0,
    "sqm": 10.7639,
    "sq m": 10.7639,
    "sq. m": 10.7639,
    "square meter": 10.7639,
    "square meters": 10.7639,
}


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", unescape(value)).strip()


def parse_listing_id(href: str | None) -> int | None:
    if not href:
        return None
    match = LISTING_ID_PATTERN.search(href)
    if not match:
        return None
    return int(match.group(1))


def absolute_url(href: str | None) -> str | None:
    if not href:
        return None
    return urljoin("https://www.zameen.com", href)


def parse_price_to_pkr(price_text: str | None) -> int | None:
    if not price_text:
        return None

    text = clean_text(price_text).lower()
    text = text.replace("pkr", "").replace("rs", "").replace("/-", "")
    parts = re.findall(r"([\d,.]+)\s*([a-z.]+)?", text)
    if not parts:
        return None

    total = 0.0
    saw_unit = False
    for raw_number, raw_unit in parts:
        number = float(raw_number.replace(",", ""))
        unit = raw_unit.strip(". ") if raw_unit else ""
        if unit in PRICE_UNIT_MULTIPLIERS:
            total += number * PRICE_UNIT_MULTIPLIERS[unit]
            saw_unit = True
        elif unit == "":
            total += number
        elif unit.isalpha():
            # Ignore tokens like "pkr" that may still slip through.
            continue

    if total == 0:
        return None

    if saw_unit:
        return int(total)

    first_number = float(parts[0][0].replace(",", ""))
    return int(first_number)


def normalize_area_unit(raw_unit: str | None) -> str | None:
    if not raw_unit:
        return None
    unit = clean_text(raw_unit).lower()
    unit = unit.replace("sq. feet", "square feet")
    unit = unit.replace("sq.feet", "square feet")
    unit = unit.replace("sq.yds", "square yards")
    return unit


def parse_area_to_sqft(area_text: str | None) -> float | None:
    if not area_text:
        return None

    text = clean_text(area_text).lower()
    matches = re.findall(r"([\d,.]+)\s*([a-z.\s]+)", text)
    if not matches:
        return None

    total = 0.0
    for raw_number, raw_unit in matches:
        number = float(raw_number.replace(",", ""))
        unit = normalize_area_unit(raw_unit)
        if not unit:
            continue

        direct = AREA_UNIT_TO_SQFT.get(unit)
        if direct is not None:
            total += number * direct
            continue

        # Try a forgiving lookup by removing repeated whitespace.
        unit = re.sub(r"\s+", " ", unit)
        direct = AREA_UNIT_TO_SQFT.get(unit)
        if direct is not None:
            total += number * direct

    if total == 0:
        return None
    return round(total, 2)


def extract_data_layer_payload(html: str) -> dict[str, Any]:
    match = DATA_LAYER_PATTERN.search(html)
    if not match:
        return {}

    payload = match.group(1)
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {}


def extract_location_name(payload: dict[str, Any], fallback: str = "") -> str:
    for key in ("loc_name", "loc_4_name", "loc_3_name", "loc_2_name"):
        value = clean_text(str(payload.get(key, ""))).strip("; ")
        if value:
            return value
    if fallback:
        return clean_text(fallback.split(",")[0])
    return ""


def parse_relative_age_hours(text: str | None) -> float | None:
    if not text:
        return None
    cleaned = clean_text(text).lower()
    match = re.search(r"(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)", cleaned)
    if not match:
        return None
    value = int(match.group(1))
    unit = match.group(2)
    if "minute" in unit:
        return value / 60
    if "hour" in unit:
        return float(value)
    if "day" in unit:
        return float(value * 24)
    if "week" in unit:
        return float(value * 24 * 7)
    if "month" in unit:
        return float(value * 24 * 30)
    if "year" in unit:
        return float(value * 24 * 365)
    return None
