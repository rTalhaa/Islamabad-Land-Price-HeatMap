import unittest

from islamabad_market.pipeline import (
    build_quality_report,
    build_source_health_report,
    confidence_band,
    mark_outliers,
    refresh_record_quality,
)


class PipelineQualityTests(unittest.TestCase):
    def listing(self, **overrides):
        base = {
            "id": "zameen-1",
            "source": "Zameen",
            "sourceKey": "zameen",
            "canonicalKey": "house|f-10|100|90|5",
            "title": "House for sale",
            "neighborhood": "F-10",
            "propertyGroup": "house",
            "pricePkr": 45_000_000,
            "areaSqft": 2250,
            "pricePerSqft": 20_000,
            "pricePerMarla": 4_500_000,
            "latitude": 33.68,
            "longitude": 73.04,
            "coordinateSource": "listing-detail",
            "imageUrl": "https://example.test/image.jpg",
            "freshnessHours": 12,
            "url": "https://example.test",
            "parseWarnings": [],
            "confidenceScore": 100,
            "confidenceBand": "High",
            "isOutlier": False,
            "outlierReasons": [],
        }
        base.update(overrides)
        return base

    def test_confidence_band_thresholds(self):
        self.assertEqual(confidence_band(90), "High")
        self.assertEqual(confidence_band(70), "Medium")
        self.assertEqual(confidence_band(20), "Low")

    def test_quality_refresh_penalizes_missing_coordinates(self):
        rows = [self.listing(latitude=None, longitude=None, coordinateSource="unknown")]
        refresh_record_quality(rows)
        self.assertIn("missing:coordinates", rows[0]["parseWarnings"])
        self.assertLess(rows[0]["confidenceScore"], 100)

    def test_outlier_detection_marks_far_comparable(self):
        rows = [
            self.listing(id="zameen-1", pricePerSqft=20_000),
            self.listing(id="zameen-2", pricePerSqft=21_000, canonicalKey="house|f-10|101|90|5"),
            self.listing(id="zameen-3", pricePerSqft=140_000, canonicalKey="house|f-10|900|90|5"),
        ]
        mark_outliers(rows)
        self.assertFalse(rows[0]["isOutlier"])
        self.assertTrue(rows[2]["isOutlier"])

    def test_reports_include_source_and_quality_metrics(self):
        rows = [self.listing(), self.listing(id="graana-1", source="Graana", sourceKey="graana", canonicalKey="house|f-10|100|90|5")]
        quality = build_quality_report(rows, "2026-06-05T00:00:00+00:00")
        health = build_source_health_report(
            rows,
            seed_stats=[
                {"source": "zameen", "pagesScraped": 1, "httpFailures": 0, "cacheHits": 0, "listingCardsCollected": 1},
                {"source": "graana", "pagesScraped": 1, "httpFailures": 0, "cacheHits": 0, "listingCardsCollected": 1},
            ],
            disabled_sources={"olx": "disabled"},
            generated_at="2026-06-05T00:00:00+00:00",
        )
        self.assertEqual(quality["listingCount"], 2)
        self.assertIn("zameen", health["sources"])
        self.assertFalse(health["sources"]["olx"]["enabled"])


if __name__ == "__main__":
    unittest.main()
