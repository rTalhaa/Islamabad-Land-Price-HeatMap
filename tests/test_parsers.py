import json
import unittest

from islamabad_market.config import SearchSeed
from islamabad_market.parsers import parse_area_to_sqft, parse_price_to_pkr, parse_relative_age_hours
from islamabad_market.scraper import parse_graana_search_page, parse_search_page


class ParserTests(unittest.TestCase):
    def test_price_parser_handles_pk_units(self):
        self.assertEqual(parse_price_to_pkr("PKR 3.5 Crore"), 35_000_000)
        self.assertEqual(parse_price_to_pkr("1.25 crore"), 12_500_000)
        self.assertEqual(parse_price_to_pkr("85 Lakh"), 8_500_000)

    def test_area_parser_handles_local_units(self):
        self.assertEqual(parse_area_to_sqft("5 Marla"), 1125.0)
        self.assertEqual(parse_area_to_sqft("1 Kanal"), 4500.0)
        self.assertEqual(parse_area_to_sqft("1,250 sqft"), 1250.0)

    def test_relative_age_parser(self):
        self.assertEqual(parse_relative_age_hours("Added: 2 days ago"), 48.0)
        self.assertEqual(parse_relative_age_hours("Updated: 3 hours ago"), 3.0)

    def test_malformed_search_page_returns_empty(self):
        seed = SearchSeed(key="bad", label="Bad", url_template="https://example.test/{page}", property_group="house")
        listings, page_count = parse_search_page("<html></html>", seed, 1)
        self.assertEqual(listings, [])
        self.assertEqual(page_count, 1)

    def test_graana_next_data_is_normalized(self):
        seed = SearchSeed(
            key="graana-houses",
            label="Graana Houses",
            url_template="https://www.graana.com/sale/house-sale-islamabad-{page}/",
            property_group="house",
            source="graana",
            requires_detail=False,
        )
        payload = {
            "props": {
                "pageProps": {
                    "properties": [
                        {
                            "id": 123,
                            "subtype": "flat",
                            "price": "12500000",
                            "size": 1100,
                            "sizeUnit": "sqft",
                            "bed": 2,
                            "bath": 2,
                            "customTitle": "Flat for Sale",
                            "createdAt": "2026-06-04T11:11:44.867Z",
                            "area": {"name": "E-11"},
                            "city": {"name": "Islamabad"},
                            "propertyImages": [{"url": "/images/original/test"}],
                        }
                    ]
                }
            }
        }
        html = f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(payload)}</script>'
        listings, page_count = parse_graana_search_page(html, seed, 1)
        self.assertEqual(page_count, 1)
        self.assertEqual(len(listings), 1)
        self.assertEqual(listings[0]["source"], "Graana")
        self.assertEqual(listings[0]["propertyGroup"], "apartment")
        self.assertEqual(listings[0]["pricePkr"], 12_500_000)
        self.assertEqual(listings[0]["location"], "E-11, Islamabad")


if __name__ == "__main__":
    unittest.main()
