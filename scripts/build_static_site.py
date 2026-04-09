from __future__ import annotations

import shutil
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
PROCESSED_DIR = BASE_DIR / "data" / "processed"
OUTPUT_DIR = BASE_DIR / "site"


def rewrite_index_html(source: str) -> str:
    static_bootstrap = """
    <script>
      window.__ATLAS_STATIC__ = {
        dataRoot: "./data/processed",
        deliveryMode: "GitHub Pages snapshot",
        forceStatic: true
      };
    </script>
""".strip()

    return (
        source.replace('href="/static/styles.css"', 'href="./static/styles.css"')
        .replace(
            '<script src="/static/app.js"></script>',
            f"{static_bootstrap}\n    <script src=\"./static/app.js\"></script>",
        )
    )


def build_site() -> None:
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)

    (OUTPUT_DIR / "static").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "data" / "processed").mkdir(parents=True, exist_ok=True)

    index_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    (OUTPUT_DIR / "index.html").write_text(rewrite_index_html(index_html), encoding="utf-8")
    (OUTPUT_DIR / "404.html").write_text(rewrite_index_html(index_html), encoding="utf-8")
    (OUTPUT_DIR / ".nojekyll").write_text("", encoding="utf-8")

    for asset_name in ("app.js", "styles.css"):
        shutil.copy2(STATIC_DIR / asset_name, OUTPUT_DIR / "static" / asset_name)

    for data_name in (
        "history.json",
        "listings.json",
        "map_points.geojson",
        "neighborhoods.json",
        "report.json",
        "summary.json",
    ):
        shutil.copy2(PROCESSED_DIR / data_name, OUTPUT_DIR / "data" / "processed" / data_name)


if __name__ == "__main__":
    build_site()
    print(f"Built static atlas site at {OUTPUT_DIR}")
