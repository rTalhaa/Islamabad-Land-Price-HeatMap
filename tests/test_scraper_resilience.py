from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from islamabad_market.config import get_config
from islamabad_market.scraper import ScrapeError, ZameenScraper, _retry_after_seconds


def _build_scraper(handler, **overrides) -> ZameenScraper:
    config = replace(get_config(), max_retries=2, retry_backoff_seconds=0.0, **overrides)
    scraper = ZameenScraper(config)
    scraper._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return scraper


class RetryAfterTests(unittest.TestCase):
    def test_prefers_header_when_larger(self):
        response = httpx.Response(429, headers={"Retry-After": "5"})
        self.assertEqual(_retry_after_seconds(response, 1.0), 5.0)

    def test_falls_back_on_missing_or_bad_header(self):
        self.assertEqual(_retry_after_seconds(httpx.Response(429), 2.0), 2.0)
        self.assertEqual(_retry_after_seconds(httpx.Response(429, headers={"Retry-After": "soon"}), 2.0), 2.0)


class FetchWithRetriesTests(unittest.TestCase):
    def test_retries_then_succeeds_on_transient_status(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] < 3:
                return httpx.Response(503)
            return httpx.Response(200, text="<html>ok</html>")

        async def run() -> str:
            scraper = _build_scraper(handler)
            try:
                with TemporaryDirectory() as tmp:
                    return await scraper.fetch_html("https://example.test/p", Path(tmp) / "p.html")
            finally:
                await scraper.aclose()

        html = asyncio.run(run())
        self.assertEqual(html, "<html>ok</html>")
        self.assertEqual(calls["n"], 3)

    def test_fails_fast_on_non_retryable_status(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(403)

        async def run() -> None:
            scraper = _build_scraper(handler)
            try:
                with TemporaryDirectory() as tmp:
                    await scraper.fetch_html("https://example.test/p", Path(tmp) / "p.html")
            finally:
                await scraper.aclose()

        with self.assertRaises(ScrapeError):
            asyncio.run(run())
        self.assertEqual(calls["n"], 1)

    def test_raises_after_exhausting_retries(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503)

        async def run() -> None:
            scraper = _build_scraper(handler)
            try:
                with TemporaryDirectory() as tmp:
                    await scraper.fetch_html("https://example.test/p", Path(tmp) / "p.html")
            finally:
                await scraper.aclose()

        with self.assertRaises(ScrapeError):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
