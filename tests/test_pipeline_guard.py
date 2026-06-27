from __future__ import annotations

import asyncio
import unittest
from unittest import mock

from islamabad_market import pipeline
from islamabad_market.pipeline import DegradedRunError


class DegradedGuardTests(unittest.TestCase):
    def _run(self, listing_count: int, min_listings):
        """Drive run_pipeline with the network/seed collection stubbed out."""
        summaries = [
            {
                "id": f"zameen-{i}",
                "seed": "houses",
                "source": "Zameen",
                "sourceKey": "zameen",
                "url": f"https://example.test/{i}",
                "priceText": "1 Crore",
                "areaText": "5 Marla",
                "propertyGroup": "house",
                "location": "F-10, Islamabad",
            }
            for i in range(listing_count)
        ]
        stats = {"source": "zameen", "seed": "houses", "pagesScraped": 1, "httpFailures": 0, "cacheHits": 0, "listingCardsCollected": listing_count}

        async def fake_collect(*args, **kwargs):
            return summaries, stats

        async def fake_enrich(*args, **kwargs):
            return {}

        with mock.patch.object(pipeline, "collect_seed_pages", side_effect=fake_collect), \
                mock.patch.object(pipeline, "enrich_listing", side_effect=fake_enrich), \
                mock.patch.object(pipeline, "write_json"), \
                mock.patch.object(pipeline, "compact_json"), \
                mock.patch.object(pipeline, "write_database_bundle"), \
                mock.patch.object(pipeline, "write_snapshot_bundle"), \
                mock.patch.object(pipeline, "update_history", return_value=[]):
            return asyncio.run(
                pipeline.run_pipeline(
                    pages_per_seed=1,
                    full_scan=False,
                    refresh_cache=False,
                    selected_seeds=["houses"],
                    listing_limit=None,
                    min_listings=min_listings,
                )
            )

    def test_guard_raises_when_below_threshold(self):
        with self.assertRaises(DegradedRunError):
            self._run(listing_count=2, min_listings=10)

    def test_guard_disabled_with_zero(self):
        result = self._run(listing_count=2, min_listings=0)
        self.assertEqual(result["summary"]["trackedListings"], 2)


if __name__ == "__main__":
    unittest.main()
