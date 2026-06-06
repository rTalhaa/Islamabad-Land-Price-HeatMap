from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class SearchSeed:
    key: str
    label: str
    url_template: str
    property_group: str
    source: str = "zameen"
    default_pages: int = 3
    enabled: bool = True
    requires_detail: bool = True


@dataclass(frozen=True)
class AppConfig:
    base_dir: Path
    raw_dir: Path
    search_cache_dir: Path
    detail_cache_dir: Path
    processed_dir: Path
    snapshot_dir: Path
    cache_dir: Path
    database_path: Path
    seeds: tuple[SearchSeed, ...] = field(default_factory=tuple)
    enabled_sources: tuple[str, ...] = ("zameen", "graana")
    disabled_sources: dict[str, str] = field(default_factory=dict)
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
    database_path = BASE_DIR / "data" / "atlas.db"

    marla_5 = "104.51592"
    marla_10 = "209.03184"
    kanal_1 = "418.06368"

    seeds = (
        SearchSeed(
            key="houses",
            label="Houses",
            url_template="https://www.zameen.com/Houses/Islamabad-3-{page}.html",
            property_group="house",
            default_pages=4,
        ),
        SearchSeed(
            key="houses-5-marla",
            label="Houses | 5 Marla",
            url_template=f"https://www.zameen.com/Houses/Islamabad-3-{{page}}.html?area_min={marla_5}&area_max={marla_5}",
            property_group="house",
            default_pages=2,
        ),
        SearchSeed(
            key="houses-10-marla",
            label="Houses | 10 Marla",
            url_template=f"https://www.zameen.com/Houses/Islamabad-3-{{page}}.html?area_min={marla_10}&area_max={marla_10}",
            property_group="house",
            default_pages=2,
        ),
        SearchSeed(
            key="houses-1-kanal",
            label="Houses | 1 Kanal",
            url_template=f"https://www.zameen.com/Houses/Islamabad-3-{{page}}.html?area_min={kanal_1}&area_max={kanal_1}",
            property_group="house",
            default_pages=2,
        ),
        SearchSeed(
            key="apartments",
            label="Flats & Apartments",
            url_template="https://www.zameen.com/Flats_Apartments/Islamabad-3-{page}.html",
            property_group="apartment",
            default_pages=4,
        ),
        SearchSeed(
            key="plots",
            label="Residential Plots",
            url_template="https://www.zameen.com/Residential_Plots/Islamabad-3-{page}.html",
            property_group="plot",
            default_pages=4,
        ),
        SearchSeed(
            key="plots-5-marla",
            label="Residential Plots | 5 Marla",
            url_template=f"https://www.zameen.com/Residential_Plots/Islamabad-3-{{page}}.html?area_min={marla_5}&area_max={marla_5}",
            property_group="plot",
            default_pages=2,
        ),
        SearchSeed(
            key="plots-10-marla",
            label="Residential Plots | 10 Marla",
            url_template=f"https://www.zameen.com/Residential_Plots/Islamabad-3-{{page}}.html?area_min={marla_10}&area_max={marla_10}",
            property_group="plot",
            default_pages=2,
        ),
        SearchSeed(
            key="plots-1-kanal",
            label="Residential Plots | 1 Kanal",
            url_template=f"https://www.zameen.com/Residential_Plots/Islamabad-3-{{page}}.html?area_min={kanal_1}&area_max={kanal_1}",
            property_group="plot",
            default_pages=2,
        ),
        SearchSeed(
            key="graana-houses",
            label="Graana Houses",
            url_template="https://www.graana.com/sale/house-sale-islamabad-{page}/",
            property_group="house",
            source="graana",
            default_pages=2,
            requires_detail=False,
        ),
        SearchSeed(
            key="graana-apartments",
            label="Graana Flats & Apartments",
            url_template="https://www.graana.com/sale/flat-sale-islamabad-{page}/",
            property_group="apartment",
            source="graana",
            default_pages=2,
            requires_detail=False,
        ),
        SearchSeed(
            key="graana-plots",
            label="Graana Residential Plots",
            url_template="https://www.graana.com/sale/plots-sale-islamabad-{page}/",
            property_group="plot",
            source="graana",
            default_pages=2,
            requires_detail=False,
        ),
        SearchSeed(
            key="olx-experimental",
            label="OLX Property For Sale",
            url_template="https://www.olx.com.pk/property-for-sale_c2/q-for-sale-islamabad?page={page}",
            property_group="mixed",
            source="olx",
            default_pages=1,
            enabled=False,
            requires_detail=False,
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
        database_path=database_path,
        seeds=seeds,
        disabled_sources={
            "olx": "Experimental source disabled by default until selector health and usage posture are reviewed.",
        },
    )
