from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class SearchSeed:
    key: str
    label: str
    url_template: str
    property_group: str
    default_pages: int = 3


@dataclass(frozen=True)
class AppConfig:
    base_dir: Path
    raw_dir: Path
    search_cache_dir: Path
    detail_cache_dir: Path
    processed_dir: Path
    snapshot_dir: Path
    cache_dir: Path
    seeds: tuple[SearchSeed, ...] = field(default_factory=tuple)
    city_name: str = "Islamabad"
    country_name: str = "Pakistan"
    user_agent: str = (
        "IslamabadPriceAtlas/1.0 (+https://example.invalid/contact; "
        "research dashboard for public market pages)"
    )
    request_timeout_seconds: float = 30.0
    detail_concurrency: int = 8
    delay_between_requests_seconds: float = 0.35


BASE_DIR = Path(__file__).resolve().parent.parent


def get_config() -> AppConfig:
    raw_dir = BASE_DIR / "data" / "raw"
    search_cache_dir = raw_dir / "search_pages"
    detail_cache_dir = raw_dir / "detail_pages"
    processed_dir = BASE_DIR / "data" / "processed"
    snapshot_dir = BASE_DIR / "data" / "snapshots"
    cache_dir = BASE_DIR / "cache"

    seeds = (
        SearchSeed(
            key="houses",
            label="Houses",
            url_template="https://www.zameen.com/Houses/Islamabad-3-{page}.html",
            property_group="house",
            default_pages=3,
        ),
        SearchSeed(
            key="apartments",
            label="Flats & Apartments",
            url_template="https://www.zameen.com/Flats_Apartments/Islamabad-3-{page}.html",
            property_group="apartment",
            default_pages=3,
        ),
        SearchSeed(
            key="plots",
            label="Residential Plots",
            url_template="https://www.zameen.com/Residential_Plots/Islamabad-3-{page}.html",
            property_group="plot",
            default_pages=3,
        ),
    )

    return AppConfig(
        base_dir=BASE_DIR,
        raw_dir=raw_dir,
        search_cache_dir=search_cache_dir,
        detail_cache_dir=detail_cache_dir,
        processed_dir=processed_dir,
        snapshot_dir=snapshot_dir,
        cache_dir=cache_dir,
        seeds=seeds,
    )

