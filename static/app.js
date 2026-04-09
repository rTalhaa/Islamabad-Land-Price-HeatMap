const state = {
  layer: "heatmap",
  metric: "pricePerSqft",
  propertyGroup: "all",
  priceBand: "all",
  bedrooms: "all",
  search: "",
  freshOnly: false,
};

const context = {
  listings: [],
  summary: null,
  history: [],
  map: null,
  overlay: null,
};

const groupColors = {
  house: [255, 154, 87],
  apartment: [76, 242, 177],
  plot: [22, 184, 255],
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}`);
  }
  return response.json();
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatPkr(value) {
  if (!value && value !== 0) return "--";
  if (value >= 10_000_000) {
    const amount = value / 10_000_000;
    return `PKR ${amount.toFixed(amount >= 10 ? 1 : 2).replace(/\.0$/, "")} Cr`;
  }
  if (value >= 100_000) {
    const amount = value / 100_000;
    return `PKR ${amount.toFixed(amount >= 10 ? 1 : 2).replace(/\.0$/, "")} Lakh`;
  }
  return `PKR ${formatCompactNumber(value)}`;
}

function formatPpsf(value) {
  if (!value && value !== 0) return "--";
  return `PKR ${new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 }).format(value)} / sqft`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

function getMetricValue(listing, metric) {
  if (metric === "density") return 1;
  return Number(listing[metric] || 0);
}

function passesPriceBand(listing) {
  const price = listing.pricePkr || 0;
  switch (state.priceBand) {
    case "under2cr":
      return price < 20_000_000;
    case "2to8cr":
      return price >= 20_000_000 && price < 80_000_000;
    case "8crplus":
      return price >= 80_000_000;
    default:
      return true;
  }
}

function passesBedroomFilter(listing) {
  const beds = listing.beds || 0;
  switch (state.bedrooms) {
    case "3plus":
      return beds >= 3;
    case "5plus":
      return beds >= 5;
    default:
      return true;
  }
}

function getFilteredListings() {
  return context.listings.filter((listing) => {
    if (state.propertyGroup !== "all" && listing.propertyGroup !== state.propertyGroup) return false;
    if (!passesPriceBand(listing)) return false;
    if (!passesBedroomFilter(listing)) return false;
    if (
      state.search &&
      !`${listing.location} ${listing.neighborhood} ${listing.title}`.toLowerCase().includes(state.search.toLowerCase())
    ) {
      return false;
    }
    if (state.freshOnly && (!listing.freshnessHours || listing.freshnessHours > 72)) return false;
    return true;
  });
}

function median(values) {
  const filtered = values.filter((value) => value || value === 0).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
}

function buildNeighborhoodStats(listings) {
  const grouped = new Map();
  for (const listing of listings) {
    const key = listing.neighborhood || listing.location;
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(listing);
  }

  return Array.from(grouped.entries())
    .map(([neighborhood, rows]) => ({
      neighborhood,
      listingCount: rows.length,
      medianPricePkr: median(rows.map((row) => row.pricePkr)),
      medianPricePerSqft: median(rows.map((row) => row.pricePerSqft)),
      center: rows.find((row) => row.longitude && row.latitude),
    }))
    .sort((a, b) => (b.medianPricePerSqft || 0) - (a.medianPricePerSqft || 0));
}

function updateTopLevelStats(filtered) {
  const visibleNeighborhoods = new Set(filtered.map((item) => item.neighborhood).filter(Boolean));
  document.querySelector("#trackedListings").textContent = formatCompactNumber(filtered.length);
  document.querySelector("#medianPrice").textContent = formatPkr(median(filtered.map((item) => item.pricePkr)));
  document.querySelector("#medianPpsf").textContent = formatPpsf(median(filtered.map((item) => item.pricePerSqft)));
  document.querySelector("#visibleCount").textContent = formatCompactNumber(filtered.length);
  document.querySelector("#visibleNeighborhoods").textContent = formatCompactNumber(visibleNeighborhoods.size);
}

function renderMix(filtered) {
  const mixList = document.querySelector("#mixList");
  const grouped = {};
  for (const listing of filtered) {
    grouped[listing.propertyGroup] = grouped[listing.propertyGroup] || [];
    grouped[listing.propertyGroup].push(listing);
  }

  const total = filtered.length || 1;
  mixList.innerHTML = Object.entries(grouped)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([group, rows]) => {
      const share = (rows.length / total) * 100;
      return `
        <article class="mix-row">
          <div class="mix-row__head">
            <strong>${rows[0].propertyGroupLabel}</strong>
            <span>${formatCompactNumber(rows.length)} listings</span>
          </div>
          <p>${formatPpsf(median(rows.map((row) => row.pricePerSqft)))} median spatial value.</p>
          <div class="mix-row__bar"><div class="mix-row__fill" style="width:${share.toFixed(1)}%"></div></div>
        </article>
      `;
    })
    .join("");
}

function renderHotspots(filtered) {
  const hotspotList = document.querySelector("#hotspotList");
  const neighborhoods = buildNeighborhoodStats(filtered).slice(0, 7);

  hotspotList.innerHTML = neighborhoods
    .map(
      (item) => `
        <article class="hotspot-row" data-neighborhood="${item.neighborhood}">
          <div class="hotspot-row__head">
            <strong>${item.neighborhood}</strong>
            <span>${formatCompactNumber(item.listingCount)} listings</span>
          </div>
          <p>${formatPpsf(item.medianPricePerSqft)} median • ${formatPkr(item.medianPricePkr)} typical ticket</p>
        </article>
      `
    )
    .join("");

  hotspotList.querySelectorAll(".hotspot-row").forEach((row) => {
    row.addEventListener("click", () => {
      const target = neighborhoods.find((item) => item.neighborhood === row.dataset.neighborhood);
      if (target?.center && context.map) {
        context.map.flyTo({
          center: [target.center.longitude, target.center.latitude],
          zoom: 12.8,
          speed: 0.75,
        });
      }
    });
  });
}

function renderHistory() {
  const svg = document.querySelector("#historySparkline");
  const caption = document.querySelector("#historyCaption");
  const subcaption = document.querySelector("#historySubcaption");
  const history = context.history || [];

  if (history.length < 2) {
    svg.innerHTML = `<rect x="1" y="1" width="318" height="108" rx="18" fill="rgba(8,23,34,0.35)" stroke="rgba(157,211,255,0.12)"/>
      <text x="20" y="56" fill="#8eaec0" font-size="12">Run the pipeline a few more times to see trend movement.</text>`;
    caption.textContent = "Need more runs for a stronger market pulse.";
    subcaption.textContent = "Each scheduled refresh appends a new historical datapoint.";
    return;
  }

  const values = history.map((item) => item.medianPricePerSqft || 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const width = 320;
  const height = 110;
  const xStep = width / Math.max(values.length - 1, 1);
  const normalise = (value) => {
    if (max === min) return height / 2;
    return 90 - ((value - min) / (max - min)) * 60;
  };
  const points = values.map((value, index) => `${index * xStep},${normalise(value)}`);
  const area = `0,110 ${points.join(" ")} ${width},110`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkStroke" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#33f1b6"/>
        <stop offset="100%" stop-color="#ff9350"/>
      </linearGradient>
      <linearGradient id="sparkFill" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="rgba(51,241,182,0.32)"/>
        <stop offset="100%" stop-color="rgba(51,241,182,0.02)"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="318" height="108" rx="18" fill="rgba(8,23,34,0.35)" stroke="rgba(157,211,255,0.12)"/>
    <polygon points="${area}" fill="url(#sparkFill)" stroke="none"></polygon>
    <polyline points="${points.join(" ")}" fill="none" stroke="url(#sparkStroke)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <circle cx="${(values.length - 1) * xStep}" cy="${normalise(values.at(-1))}" r="5" fill="#fff" stroke="#33f1b6" stroke-width="3"></circle>
  `;

  const delta = values.at(-1) - values.at(0);
  caption.textContent = `${delta >= 0 ? "Upward" : "Downward"} drift of ${Math.abs(delta).toFixed(0)} PKR / sqft across saved runs.`;
  subcaption.textContent = `First run ${formatDate(history[0].timestamp)} • Latest run ${formatDate(history.at(-1).timestamp)}`;
}

function updateSelectionCard(payload) {
  const target = document.querySelector("#selectionCard");
  if (!payload) {
    target.textContent = "Hover a listing or a bin on the map to inspect the local market signal.";
    return;
  }

  if (payload.object?.title) {
    const listing = payload.object;
    target.innerHTML = `
      <strong>${listing.title}</strong>
      <p>${listing.location}</p>
      <p>${formatPkr(listing.pricePkr)} • ${formatPpsf(listing.pricePerSqft)}</p>
      <p>${listing.beds ? `${listing.beds} beds` : "Plot or unspecified beds"}${listing.baths ? ` • ${listing.baths} baths` : ""}</p>
    `;
    return;
  }

  if (payload.object?.points?.length) {
    const pointCount = payload.object.points.length;
    const first = payload.object.points[0].source;
    target.innerHTML = `
      <strong>${pointCount} listings in this bin</strong>
      <p>${first.neighborhood || first.location}</p>
      <p>${formatPpsf(median(payload.object.points.map((point) => point.source.pricePerSqft)))}</p>
    `;
  }
}

function tooltipFor(info) {
  if (!info.object) return null;
  if (info.object.title) {
    return {
      html: `
        <div style="font-family: Space Grotesk, sans-serif; max-width: 280px;">
          <strong>${info.object.title}</strong><br />
          <span>${info.object.location}</span><br />
          <span>${formatPkr(info.object.pricePkr)} • ${formatPpsf(info.object.pricePerSqft)}</span>
        </div>
      `,
      style: {
        backgroundColor: "rgba(8, 23, 34, 0.92)",
        color: "#eef5fa",
        border: "1px solid rgba(157, 211, 255, 0.18)",
        borderRadius: "14px",
      },
    };
  }
  if (info.object.points?.length) {
    const rows = info.object.points.map((point) => point.source);
    return {
      html: `
        <div style="font-family: Space Grotesk, sans-serif;">
          <strong>${rows.length} listings in view</strong><br />
          <span>${rows[0].neighborhood || rows[0].location}</span><br />
          <span>${formatPpsf(median(rows.map((row) => row.pricePerSqft)))}</span>
        </div>
      `,
      style: {
        backgroundColor: "rgba(8, 23, 34, 0.92)",
        color: "#eef5fa",
        border: "1px solid rgba(157, 211, 255, 0.18)",
        borderRadius: "14px",
      },
    };
  }
  return null;
}

function updateLegend() {
  const legendText = document.querySelector("#legendText");
  const layerName =
    state.layer === "heatmap" ? "Heatmap" : state.layer === "hexagon" ? "Hex bins" : "Listing dots";
  const metricName =
    state.metric === "pricePerSqft"
      ? "PKR per square foot"
      : state.metric === "pricePkr"
        ? "listing price"
        : "listing density";

  document.querySelector("#activeMetricBadge").textContent = `Metric: ${
    state.metric === "pricePerSqft"
      ? "Price / sqft"
      : state.metric === "pricePkr"
        ? "Listing price"
        : "Density"
  }`;
  document.querySelector("#activeLayerBadge").textContent = `Layer: ${layerName}`;

  legendText.textContent =
    state.layer === "heatmap"
      ? `Heatmap weights each point by ${metricName}, so clusters glow according to market intensity rather than simple count.`
      : state.layer === "hexagon"
        ? `Hex bins aggregate nearby listings and expose how ${metricName} is concentrating across Islamabad's active inventory.`
        : `Listing dots reveal sampled coordinates, colored by property type and sized by ${metricName}.`;
}

function updateCoverage(summary) {
  document.querySelector("#lastRunPill").textContent = `Last pipeline run ${formatDate(summary.generatedAt)}`;
  document.querySelector("#coveragePill").textContent = `${formatCompactNumber(summary.neighborhoodCount)} neighborhoods • ${formatCompactNumber(summary.mappedListings)} mapped points`;
}

function updateEmptyState(filtered) {
  document.querySelector("#emptyState").classList.toggle("hidden", filtered.length > 0);
}

function updateMap(filtered) {
  if (!context.overlay) return;

  const { HeatmapLayer, HexagonLayer, ScatterplotLayer } = deck;
  const layers = [];

  if (state.layer === "heatmap") {
    layers.push(
      new HeatmapLayer({
        id: "isb-heat",
        data: filtered,
        getPosition: (d) => [d.longitude, d.latitude],
        getWeight: (d) => {
          const value = getMetricValue(d, state.metric);
          if (!value) return 0;
          if (state.metric === "density") return 1;
          return Math.max(1, Math.sqrt(value));
        },
        radiusPixels: 48,
        intensity: 1.2,
        threshold: 0.02,
      })
    );
  }

  if (state.layer === "hexagon") {
    layers.push(
      new HexagonLayer({
        id: "isb-hex",
        data: filtered,
        getPosition: (d) => [d.longitude, d.latitude],
        pickable: true,
        extruded: true,
        radius: 500,
        elevationScale: 20,
        colorRange: [
          [20, 34, 51],
          [12, 94, 126],
          [35, 160, 170],
          [255, 201, 92],
          [255, 111, 76],
          [255, 61, 102],
        ],
        getColorWeight: (d) => getMetricValue(d, state.metric),
        getElevationWeight: (d) => getMetricValue(d, state.metric),
        elevationAggregation: "MEAN",
        colorAggregation: state.metric === "density" ? "SUM" : "MEAN",
        material: { ambient: 0.24, diffuse: 0.6, shininess: 28, specularColor: [51, 51, 51] },
      })
    );
  }

  if (state.layer === "scatter") {
    layers.push(
      new ScatterplotLayer({
        id: "isb-scatter",
        data: filtered,
        pickable: true,
        stroked: true,
        filled: true,
        radiusScale: 1,
        radiusMinPixels: 6,
        radiusMaxPixels: 28,
        lineWidthMinPixels: 1,
        getPosition: (d) => [d.longitude, d.latitude],
        getRadius: (d) => {
          const value = getMetricValue(d, state.metric);
          if (state.metric === "density") return 70;
          return Math.max(90, Math.sqrt(value || 0) * 0.65);
        },
        getFillColor: (d) => [...(groupColors[d.propertyGroup] || [255, 255, 255]), 170],
        getLineColor: () => [255, 255, 255, 210],
        onClick: ({ object }) => {
          if (object?.url) {
            window.open(object.url, "_blank", "noopener");
          }
        },
      })
    );
  }

  context.overlay.setProps({
    layers,
    getTooltip: tooltipFor,
    onHover: (info) => updateSelectionCard(info),
  });
}

function renderAll() {
  if (!context.summary) return;
  const filtered = getFilteredListings();
  updateCoverage(context.summary);
  updateTopLevelStats(filtered);
  renderMix(filtered);
  renderHotspots(filtered);
  renderHistory();
  updateLegend();
  updateMap(filtered.filter((item) => item.longitude && item.latitude));
  updateEmptyState(filtered);
}

function bindControls() {
  document.querySelector("#layerSelect").addEventListener("change", (event) => {
    state.layer = event.target.value;
    renderAll();
  });

  document.querySelector("#metricSelect").addEventListener("change", (event) => {
    state.metric = event.target.value;
    renderAll();
  });

  document.querySelector("#groupSelect").addEventListener("change", (event) => {
    state.propertyGroup = event.target.value;
    renderAll();
  });

  document.querySelector("#priceBandSelect").addEventListener("change", (event) => {
    state.priceBand = event.target.value;
    renderAll();
  });

  document.querySelector("#bedroomsSelect").addEventListener("change", (event) => {
    state.bedrooms = event.target.value;
    renderAll();
  });

  document.querySelector("#searchInput").addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    renderAll();
  });

  document.querySelector("#freshToggle").addEventListener("change", (event) => {
    state.freshOnly = event.target.checked;
    renderAll();
  });

  document.querySelector("#resetButton").addEventListener("click", () => {
    Object.assign(state, {
      layer: "heatmap",
      metric: "pricePerSqft",
      propertyGroup: "all",
      priceBand: "all",
      bedrooms: "all",
      search: "",
      freshOnly: false,
    });

    document.querySelector("#layerSelect").value = state.layer;
    document.querySelector("#metricSelect").value = state.metric;
    document.querySelector("#groupSelect").value = state.propertyGroup;
    document.querySelector("#priceBandSelect").value = state.priceBand;
    document.querySelector("#bedroomsSelect").value = state.bedrooms;
    document.querySelector("#searchInput").value = state.search;
    document.querySelector("#freshToggle").checked = state.freshOnly;
    renderAll();
  });
}

function initMap() {
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [73.0479, 33.6844],
    zoom: 10.4,
    pitch: 42,
    bearing: -12,
    antialias: true,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("load", () => {
    context.overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(context.overlay);
    renderAll();
  });

  context.map = map;
}

async function init() {
  bindControls();
  initMap();

  try {
    const [summary, listings, history] = await Promise.all([
      fetchJson("/api/summary"),
      fetchJson("/api/listings"),
      fetchJson("/api/history"),
    ]);
    context.summary = summary;
    context.listings = listings;
    context.history = history;
    renderAll();
  } catch (error) {
    document.querySelector("#selectionCard").textContent =
      "The atlas could not load processed data yet. Run the pipeline first, then refresh the page.";
    console.error(error);
  }
}

window.addEventListener("DOMContentLoaded", init);
