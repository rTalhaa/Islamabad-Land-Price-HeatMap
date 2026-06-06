import tempfile
import unittest
from pathlib import Path

from islamabad_market.database import database_status, load_document, query_listings, write_database_bundle


class DatabaseTests(unittest.TestCase):
    def sample_listing(self):
        return {
            "id": "zameen-1",
            "source": "Zameen",
            "sourceKey": "zameen",
            "sourceListingId": "1",
            "canonicalKey": "house|f-10|10|20|5",
            "detailUrl": "https://example.test/1",
            "url": "https://example.test/1",
            "title": "House for sale",
            "propertyGroup": "house",
            "neighborhood": "F-10",
            "location": "F-10, Islamabad",
            "city": "Islamabad",
            "pricePkr": 30_000_000,
            "areaSqft": 2250,
            "pricePerSqft": 13_333.33,
            "pricePerMarla": 3_000_000,
            "beds": 5,
            "baths": 5,
            "latitude": 33.69,
            "longitude": 73.01,
            "coordinateSource": "listing-detail",
            "confidenceScore": 96,
            "confidenceBand": "High",
            "sizeBand": "Mid-size",
            "recencyBucket": "Fresh",
            "freshnessHours": 2,
            "isOutlier": False,
            "sourceFetchedAt": "2026-06-06T00:00:00+00:00",
        }

    def test_write_and_query_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "atlas.db"
            listing = self.sample_listing()
            summary = {"generatedAt": "2026-06-06T00:00:00+00:00", "trackedListings": 1}
            write_database_bundle(
                db_path,
                listings=[listing],
                neighborhoods=[{"name": "F-10", "listingCount": 1, "mappedCount": 1}],
                summary=summary,
                history=[],
                geojson={"type": "FeatureCollection", "features": []},
                report={},
                source_health={},
                quality_report={},
            )

            self.assertEqual(load_document(db_path, "summary.json")["trackedListings"], 1)
            self.assertEqual(database_status(db_path)["listingCount"], 1)
            rows = query_listings(db_path, source="Zameen", property_group="house", min_confidence=90)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["neighborhood"], "F-10")


if __name__ == "__main__":
    unittest.main()
