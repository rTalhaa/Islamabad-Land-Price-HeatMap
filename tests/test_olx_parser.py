from __future__ import annotations

import json
import unittest

from islamabad_market.config import SearchSeed
from islamabad_market.scraper import parse_olx_search_page


def _build_html(ads: list[dict]) -> str:
    payload = {"props": {"pageProps": {"data": ads}}}
    return f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(payload)}</script>'


SEED = SearchSeed(
    key="olx-experimental",
    label="OLX Property For Sale",
    url_template="https://www.olx.com.pk/q?page={page}",
    property_group="mixed",
    source="olx",
)


class OlxParserTests(unittest.TestCase):
    def test_parses_islamabad_ad_with_coordinates(self):
        ad = {
            "id": 12345,
            "title": "5 Marla House for sale in Bahria Town",
            "url": "/item/5-marla-house-iid-12345",
            "price": {"value": {"raw": 25000000, "display": "Rs 2,50,00,000"}},
            "locations_resolved": {
                "ADMIN_LEVEL_3_name": "Islamabad",
                "SUBLOCALITY_LEVEL_1_name": "Bahria Town",
            },
            "map_lat": 33.52,
            "map_lon": 73.10,
            "created_at": "2026-06-01T10:00:00Z",
            "images": [{"url": "https://img.olx/1.jpg"}],
            "parameters": [
                {"key": "area", "value": "5"},
                {"key": "area_unit", "value": "Marla"},
                {"key": "bedrooms", "value": "3"},
                {"key": "type", "value_name": "Houses"},
            ],
        }
        listings, page_count = parse_olx_search_page(_build_html([ad]), SEED, page_number=1)
        self.assertEqual(len(listings), 1)
        row = listings[0]
        self.assertEqual(row["id"], "olx-12345")
        self.assertEqual(row["source"], "OLX")
        self.assertEqual(row["pricePkr"], 25000000)
        self.assertEqual(row["propertyGroup"], "house")
        self.assertEqual(row["latitude"], 33.52)
        self.assertEqual(row["beds"], 3)
        self.assertEqual(row["areaText"], "5 Marla")
        self.assertEqual(page_count, 1)

    def test_skips_non_islamabad_and_dedupes(self):
        karachi = {
            "id": 1,
            "title": "Plot in Karachi",
            "price": {"value": {"raw": 100}},
            "locations_resolved": {"ADMIN_LEVEL_3_name": "Karachi"},
        }
        isb = {
            "id": 2,
            "title": "Plot in Islamabad",
            "price": {"value": {"raw": 100}},
            "locations_resolved": {"ADMIN_LEVEL_3_name": "Islamabad"},
        }
        listings, _ = parse_olx_search_page(_build_html([karachi, isb, isb]), SEED, page_number=1)
        self.assertEqual([row["id"] for row in listings], ["olx-2"])

    def test_handles_missing_next_data(self):
        listings, page_count = parse_olx_search_page("<html>no data</html>", SEED, page_number=2)
        self.assertEqual(listings, [])
        self.assertEqual(page_count, 2)


if __name__ == "__main__":
    unittest.main()
