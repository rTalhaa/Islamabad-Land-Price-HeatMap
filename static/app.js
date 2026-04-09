const GROUPS = ["house", "apartment", "plot"];
const GROUP_COLORS = {
  house: [255, 176, 103],
  apartment: [76, 242, 177],
  plot: [22, 184, 255],
};
const STATIC_RUNTIME = window.__ATLAS_STATIC__ || null;
const DATA_WARNING_HOURS = 18;
const DATA_STALE_HOURS = 36;
const DEFAULT_FILTER_STATE = {
  layer: "heatmap",
  metric: "pricePerSqft",
  propertyGroup: "all",
  priceBand: "all",
  bedrooms: "all",
  search: "",
  freshOnly: false,
  selectedNeighborhood: null,
};

const state = { ...DEFAULT_FILTER_STATE };
const context = {
  summary: null,
  listings: [],
  neighborhoods: [],
  history: [],
  filteredListings: [],
  filteredMappedListings: [],
  visibleNeighborhoods: [],
  selectedNeighborhoodData: null,
  map: null,
  overlay: null,
  mapReady: false,
  hasInitialMapView: false,
  pulseValue: 0,
  pulseTimer: null,
  deliveryMode: STATIC_RUNTIME?.deliveryMode || "Live API",
};

const $ = (id) => document.getElementById(id);
const els = {
  lastRunPill: $("lastRunPill"),
  dataStatusPill: $("dataStatusPill"),
  coveragePill: $("coveragePill"),
  deliveryPill: $("deliveryPill"),
  trackedListings: $("trackedListings"),
  medianPrice: $("medianPrice"),
  medianPpsf: $("medianPpsf"),
  activeMetricBadge: $("activeMetricBadge"),
  activeLayerBadge: $("activeLayerBadge"),
  visibleCount: $("visibleCount"),
  visibleNeighborhoods: $("visibleNeighborhoods"),
  selectionPill: $("selectionPill"),
  legendText: $("legendText"),
  emptyState: $("emptyState"),
  spotlightName: $("spotlightName"),
  spotlightTier: $("spotlightTier"),
  spotlightDominant: $("spotlightDominant"),
  spotlightEmpty: $("spotlightEmpty"),
  spotlightContent: $("spotlightContent"),
  spotlightSummary: $("spotlightSummary"),
  spotlightPpsf: $("spotlightPpsf"),
  spotlightTicket: $("spotlightTicket"),
  spotlightListings: $("spotlightListings"),
  spotlightFreshness: $("spotlightFreshness"),
  spotlightPpsfDelta: $("spotlightPpsfDelta"),
  spotlightTicketDelta: $("spotlightTicketDelta"),
  spotlightMix: $("spotlightMix"),
  sampleListings: $("sampleListings"),
  mixList: $("mixList"),
  hotspotList: $("hotspotList"),
  historySparkline: $("historySparkline"),
  historyCaption: $("historyCaption"),
  historySubcaption: $("historySubcaption"),
  layerSelect: $("layerSelect"),
  metricSelect: $("metricSelect"),
  groupSelect: $("groupSelect"),
  priceBandSelect: $("priceBandSelect"),
  bedroomsSelect: $("bedroomsSelect"),
  searchInput: $("searchInput"),
  freshToggle: $("freshToggle"),
  resetButton: $("resetButton"),
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function fetchJson(url, fallback = null) {
  const response = await fetch(url);
  if (!response.ok) {
    if (fallback !== null) return fallback;
    throw new Error(`Failed to load ${url}`);
  }
  return response.json();
}

function buildStaticDatasetUrl(name) {
  if (!STATIC_RUNTIME?.dataRoot) return null;
  const root = STATIC_RUNTIME.dataRoot.replace(/\/+$/, "");
  return `${root}/${name}.json`;
}

async function fetchDataset(name, fallback = null) {
  const candidates = [];
  if (!STATIC_RUNTIME?.forceStatic) candidates.push(`/api/${name}`);
  const staticUrl = buildStaticDatasetUrl(name);
  if (staticUrl) candidates.push(staticUrl);
  if (!candidates.length) candidates.push(`/api/${name}`);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: "no-store" });
      if (!response.ok) {
        lastError = new Error(`Failed to load ${candidate}`);
        continue;
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }

  if (fallback !== null) return fallback;
  throw lastError || new Error(`Failed to load dataset ${name}`);
}

function roundValue(value, digits = 2) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

function median(values) {
  const filtered = values
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number)
    .sort((a, b) => a - b);
  if (!filtered.length) return null;
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatPkr(value) {
  if (value === null || value === undefined) return "--";
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
  return value === null || value === undefined ? "--" : `PKR ${formatCompactNumber(value)} / sqft`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

function formatSignedPct(value) {
  if (value === null || value === undefined) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatFreshness(hours) {
  if (hours === null || hours === undefined) return "Unknown";
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, "")}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 5 ? 1 : 0).replace(/\.0$/, "")}d`;
}

function computeDataHealth(timestamp) {
  if (!timestamp) {
    return {
      label: "Snapshot timing unavailable",
      tone: "pill--muted",
    };
  }

  const ageHours = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 3_600_000);
  if (ageHours <= DATA_WARNING_HOURS) {
    return {
      label: `Fresh snapshot | ${formatFreshness(ageHours)} old`,
      tone: "",
    };
  }
  if (ageHours <= DATA_STALE_HOURS) {
    return {
      label: `Aging snapshot | ${formatFreshness(ageHours)} old`,
      tone: "pill--warning",
    };
  }
  return {
    label: `Stale snapshot | ${formatFreshness(ageHours)} old`,
    tone: "pill--danger",
  };
}

function propertyGroupLabel(group) {
  return {
    house: "Houses",
    apartment: "Flats & Apartments",
    plot: "Residential Plots",
  }[group] || "Listings";
}

function getMetricValue(listing, metric) {
  return metric === "density" ? 1 : Number(listing[metric] || 0);
}

function buildPropertyMix(items) {
  const total = items.length || 1;
  return Object.fromEntries(
    GROUPS.map((group) => {
      const count = items.filter((item) => item.propertyGroup === group).length;
      return [group, { label: propertyGroupLabel(group), count, share: roundValue(count / total, 4) }];
    }),
  );
}

function computePriceTier(value, ordered) {
  if (value === null || !ordered.length) return "Value";
  const position = ordered.filter((item) => item <= value).length - 1;
  const percentile = (position + 1) / ordered.length;
  if (percentile >= 0.75) return "Ultra Prime";
  if (percentile >= 0.5) return "Premium";
  if (percentile >= 0.25) return "Mid-market";
  return "Value";
}

function buildNeighborhoodRecords(listings) {
  const grouped = new Map();
  for (const listing of listings) {
    if (!listing.neighborhood) continue;
    if (!grouped.has(listing.neighborhood)) grouped.set(listing.neighborhood, []);
    grouped.get(listing.neighborhood).push(listing);
  }
  const cityMedianPpsf = median(listings.map((item) => item.pricePerSqft));
  const cityMedianTicket = median(listings.map((item) => item.pricePkr));
  const records = [...grouped.entries()].map(([name, items]) => {
    const mapped = items.filter((item) => item.latitude !== null && item.longitude !== null);
    const propertyMix = buildPropertyMix(items);
    const dominantPropertyGroup = GROUPS
      .slice()
      .sort(
        (left, right) =>
          propertyMix[right].count - propertyMix[left].count ||
          propertyMix[right].share - propertyMix[left].share ||
          propertyGroupLabel(left).localeCompare(propertyGroupLabel(right)),
      )[0];
    const medianPricePerSqft = roundValue(median(items.map((item) => item.pricePerSqft)));
    const medianPricePkr = roundValue(median(items.map((item) => item.pricePkr)), 0);
    return {
      name,
      centroid: {
        latitude: mapped.length ? roundValue(mapped.reduce((sum, item) => sum + item.latitude, 0) / mapped.length, 6) : null,
        longitude: mapped.length ? roundValue(mapped.reduce((sum, item) => sum + item.longitude, 0) / mapped.length, 6) : null,
      },
      listingCount: items.length,
      mappedCount: mapped.length,
      medianPricePkr,
      medianPricePerSqft,
      medianAreaSqft: roundValue(median(items.map((item) => item.areaSqft))),
      medianFreshnessHours: roundValue(median(items.map((item) => item.freshnessHours))),
      minPricePkr: roundValue(Math.min(...items.map((item) => item.pricePkr).filter((value) => value !== null && value !== undefined)), 0),
      maxPricePkr: roundValue(Math.max(...items.map((item) => item.pricePkr).filter((value) => value !== null && value !== undefined)), 0),
      dominantPropertyGroup,
      propertyMix,
      cityMedianPpsfDeltaPct: cityMedianPpsf && medianPricePerSqft ? roundValue(((medianPricePerSqft - cityMedianPpsf) / cityMedianPpsf) * 100) : null,
      cityMedianTicketDeltaPct: cityMedianTicket && medianPricePkr ? roundValue(((medianPricePkr - cityMedianTicket) / cityMedianTicket) * 100) : null,
      priceTier: "Value",
      sampleListings: items
        .slice()
        .sort((a, b) => (b.pricePerSqft || 0) - (a.pricePerSqft || 0) || (b.pricePkr || 0) - (a.pricePkr || 0) || a.id - b.id)
        .slice(0, 3)
        .map((item) => ({
          id: item.id,
          title: item.title,
          pricePkr: item.pricePkr,
          pricePerSqft: item.pricePerSqft,
          beds: item.beds,
          areaSqft: item.areaSqft,
          imageUrl: item.imageUrl,
          url: item.url,
        })),
    };
  });
  const ordered = records.map((item) => item.medianPricePerSqft).filter((value) => value !== null).sort((a, b) => a - b);
  for (const record of records) record.priceTier = computePriceTier(record.medianPricePerSqft, ordered);
  return records.sort((a, b) => b.listingCount - a.listingCount || (b.medianPricePerSqft || 0) - (a.medianPricePerSqft || 0) || a.name.localeCompare(b.name));
}

function isDefaultFilterState() {
  return ["layer", "metric", "propertyGroup", "priceBand", "bedrooms", "search", "freshOnly"].every((key) => state[key] === DEFAULT_FILTER_STATE[key]);
}

function passesPriceBand(listing) {
  if (state.priceBand === "under2cr") return (listing.pricePkr || 0) < 20_000_000;
  if (state.priceBand === "2to8cr") return (listing.pricePkr || 0) >= 20_000_000 && (listing.pricePkr || 0) < 80_000_000;
  if (state.priceBand === "8crplus") return (listing.pricePkr || 0) >= 80_000_000;
  return true;
}

function getFilteredListings() {
  const search = state.search.trim().toLowerCase();
  return context.listings.filter((listing) => {
    if (state.propertyGroup !== "all" && listing.propertyGroup !== state.propertyGroup) return false;
    if (!passesPriceBand(listing)) return false;
    if (state.bedrooms === "3plus" && (listing.beds || 0) < 3) return false;
    if (state.bedrooms === "5plus" && (listing.beds || 0) < 5) return false;
    if (state.freshOnly && (!listing.freshnessHours || listing.freshnessHours > 72)) return false;
    if (search && !`${listing.title} ${listing.location} ${listing.neighborhood}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

function getVisibleNeighborhoods(filteredListings) {
  if (isDefaultFilterState() && context.neighborhoods.length && filteredListings.length === context.listings.length) return context.neighborhoods;
  return buildNeighborhoodRecords(filteredListings);
}

function chooseDefaultNeighborhood(records) {
  return records.slice().sort((a, b) => b.listingCount - a.listingCount || (b.medianPricePerSqft || 0) - (a.medianPricePerSqft || 0) || a.name.localeCompare(b.name))[0] || null;
}

function resolveSelectedNeighborhood(records) {
  return records.find((item) => item.name === state.selectedNeighborhood) || chooseDefaultNeighborhood(records);
}

function applyDeltaTone(element, value) {
  element.classList.remove("delta-positive", "delta-negative", "delta-neutral");
  element.classList.add(value > 0 ? "delta-positive" : value < 0 ? "delta-negative" : "delta-neutral");
}

function renderSpotlight(record) {
  els.spotlightName.textContent = record ? record.name : "Waiting for selection";
  els.spotlightTier.textContent = record ? record.priceTier : "Tier";
  els.spotlightDominant.textContent = record ? propertyGroupLabel(record.dominantPropertyGroup) : "Dominant mix";
  els.spotlightEmpty.classList.toggle("hidden", Boolean(record));
  els.spotlightContent.classList.toggle("hidden", !record);
  if (!record) return;
  els.spotlightSummary.textContent = `${formatCompactNumber(record.listingCount)} listings | ${record.medianAreaSqft ? `${formatCompactNumber(record.medianAreaSqft)} sqft median area` : "Area mixed"} | ${formatPkr(record.minPricePkr)} to ${formatPkr(record.maxPricePkr)}`;
  els.spotlightPpsf.textContent = formatPpsf(record.medianPricePerSqft);
  els.spotlightTicket.textContent = formatPkr(record.medianPricePkr);
  els.spotlightListings.textContent = formatCompactNumber(record.listingCount);
  els.spotlightFreshness.textContent = formatFreshness(record.medianFreshnessHours);
  els.spotlightPpsfDelta.textContent = formatSignedPct(record.cityMedianPpsfDeltaPct);
  els.spotlightTicketDelta.textContent = formatSignedPct(record.cityMedianTicketDeltaPct);
  applyDeltaTone(els.spotlightPpsfDelta, record.cityMedianPpsfDeltaPct || 0);
  applyDeltaTone(els.spotlightTicketDelta, record.cityMedianTicketDeltaPct || 0);
  els.spotlightMix.innerHTML = GROUPS.map((group) => `<div class="mix-chip"><strong>${formatCompactNumber(record.propertyMix[group].count)}</strong><span>${escapeHtml(propertyGroupLabel(group))} | ${Math.round((record.propertyMix[group].share || 0) * 100)}%</span></div>`).join("");
  els.sampleListings.innerHTML = record.sampleListings.length
    ? record.sampleListings
        .map((item) => {
          const image = item.imageUrl ? ` style="background-image: linear-gradient(140deg, rgba(76, 242, 177, 0.22), rgba(28, 82, 136, 0.22)), url('${item.imageUrl.replace(/'/g, "%27")}');"` : "";
          const beds = item.beds ? `${item.beds} bed` : "Open layout";
          const area = item.areaSqft ? `${formatCompactNumber(item.areaSqft)} sqft` : "Area on request";
          return `<a class="sample-card" href="${item.url}" target="_blank" rel="noreferrer"><div class="sample-card__image"${image}></div><div class="sample-card__body"><strong>${escapeHtml(item.title)}</strong><div class="sample-card__meta">${formatPkr(item.pricePkr)} | ${formatPpsf(item.pricePerSqft)}</div><div class="sample-card__detail">${beds} | ${area}</div></div></a>`;
        })
        .join("")
    : `<div class="mix-row"><strong>No sample listings available</strong><p>This neighborhood is still valid, but the current filter set does not expose showcase cards.</p></div>`;
}

function renderMix(listings) {
  const mix = buildPropertyMix(listings);
  els.mixList.innerHTML = GROUPS.map((group) => {
    const item = mix[group];
    return `<article class="mix-row"><div class="mix-row__head"><strong>${escapeHtml(item.label)}</strong><span>${formatCompactNumber(item.count)}</span></div><p>${Math.round(item.share * 100)}% of visible inventory</p><div class="mix-row__bar"><div class="mix-row__fill" style="width:${Math.max(item.share * 100, item.count ? 8 : 0)}%"></div></div></article>`;
  }).join("");
}

function renderHotspots(records) {
  const rows = records.slice(0, 8);
  els.hotspotList.innerHTML = rows.length
    ? rows
        .map(
          (record) =>
            `<article class="hotspot-row${record.name === state.selectedNeighborhood ? " is-selected" : ""}" data-neighborhood="${escapeHtml(record.name)}"><div class="hotspot-row__head"><strong>${escapeHtml(record.name)}</strong><span>${escapeHtml(record.priceTier)}</span></div><p>${formatCompactNumber(record.listingCount)} listings | ${formatPpsf(record.medianPricePerSqft)}</p></article>`,
        )
        .join("")
    : `<article class="mix-row"><strong>No visible neighborhoods</strong><p>Adjust the active filters to bring back neighborhood rankings.</p></article>`;
  [...els.hotspotList.querySelectorAll(".hotspot-row")].forEach((node) => {
    node.addEventListener("click", () => setSelectedNeighborhood(node.dataset.neighborhood, { flyToSelection: true }));
  });
}

function renderHistory() {
  const history = context.history;
  if (history.length < 2) {
    els.historySparkline.innerHTML = '<line x1="18" y1="58" x2="302" y2="58" stroke="rgba(140, 201, 255, 0.22)" stroke-width="2" stroke-dasharray="5 7"></line>';
    els.historyCaption.textContent = "Need more runs for a stronger market pulse.";
    els.historySubcaption.textContent = "Each scheduled refresh appends a new snapshot.";
    return;
  }
  const values = history.map((item) => item.medianPricePerSqft || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, index) => {
    const x = 18 + (284 * index) / (values.length - 1 || 1);
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    const y = 90 - ratio * 60;
    return `${x},${y}`;
  });
  els.historySparkline.innerHTML = `<polyline fill="none" stroke="rgba(76, 242, 177, 0.95)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points.join(" ")}"></polyline>${points.map((point, index) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="${index === points.length - 1 ? 5 : 3}" fill="${index === points.length - 1 ? "#ffb067" : "#4cf2b1"}"></circle>`).join("")}`;
  const first = values[0];
  const last = values[values.length - 1];
  els.historyCaption.textContent = `Median PKR / sqft moved ${formatSignedPct(first ? ((last - first) / first) * 100 : 0)} across ${formatCompactNumber(history.length)} tracked runs.`;
  els.historySubcaption.textContent = `Latest snapshot ${formatDate(history[history.length - 1].timestamp)}`;
}

function updateLegend() {
  const layerLabel = { heatmap: "Heatmap", hexagon: "Hex bins", scatter: "Listing dots" }[state.layer];
  const metricLabel = { pricePerSqft: "Price / sqft", pricePkr: "Listing price", density: "Density" }[state.metric];
  els.activeLayerBadge.textContent = `Layer: ${layerLabel}`;
  els.activeMetricBadge.textContent = `Metric: ${metricLabel}`;
  els.legendText.textContent =
    state.layer === "heatmap"
      ? `${metricLabel} weights each listing so the brightest clusters reveal premium pressure, not just raw count.`
      : state.layer === "hexagon"
        ? `${metricLabel} is aggregated by neighborhood-scale bins, while elevation shows where inventory is stacking up.`
        : `Every dot is a live listing. The active neighborhood stays bright while the rest of the city softens into context.`;
}

function updateTopLevelStats() {
  const listings = context.filteredListings;
  const selected = context.selectedNeighborhoodData;
  const health = computeDataHealth(context.summary?.generatedAt);
  els.lastRunPill.textContent = context.summary ? `Last run ${formatDate(context.summary.generatedAt)}` : "Waiting for dataset";
  els.dataStatusPill.textContent = health.label;
  els.dataStatusPill.className = `pill ${health.tone}`.trim();
  els.coveragePill.textContent = context.summary ? `${formatCompactNumber(context.summary.mappedListings)} mapped | ${formatCompactNumber(context.summary.neighborhoodCount)} neighborhoods` : "Coverage loading...";
  els.deliveryPill.textContent = `Delivery: ${context.deliveryMode}`;
  els.deliveryPill.className = STATIC_RUNTIME ? "pill pill--accent" : "pill pill--muted";
  els.trackedListings.textContent = formatCompactNumber(listings.length);
  els.medianPrice.textContent = formatPkr(median(listings.map((item) => item.pricePkr)));
  els.medianPpsf.textContent = formatPpsf(median(listings.map((item) => item.pricePerSqft)));
  els.visibleCount.textContent = formatCompactNumber(listings.length);
  els.visibleNeighborhoods.textContent = formatCompactNumber(context.visibleNeighborhoods.length);
  els.selectionPill.textContent = selected ? selected.name : "No selection";
}

function updateEmptyState() {
  els.emptyState.classList.toggle("hidden", context.filteredListings.length > 0);
}

function getSelectionFromHexBin(object) {
  if (!object?.points?.length) return null;
  const ranked = new Map();
  for (const item of object.points) {
    const existing = ranked.get(item.neighborhood) || { count: 0, pricePerSqft: 0 };
    existing.count += 1;
    existing.pricePerSqft = Math.max(existing.pricePerSqft, item.pricePerSqft || 0);
    ranked.set(item.neighborhood, existing);
  }
  return [...ranked.entries()].sort((a, b) => b[1].count - a[1].count || b[1].pricePerSqft - a[1].pricePerSqft)[0]?.[0] || null;
}

function tooltipFor(info) {
  if (!info.object) return null;
  if (info.object.points) {
    const name = getSelectionFromHexBin(info.object);
    return { html: `<strong>${escapeHtml(name || "Mixed cluster")}</strong><div>${formatCompactNumber(info.object.points.length)} listings in bin</div>` };
  }
  return {
    html: `<strong>${escapeHtml(info.object.title)}</strong><div>${escapeHtml(info.object.neighborhood)} | ${formatPkr(info.object.pricePkr)}</div><div>${formatPpsf(info.object.pricePerSqft)}</div>`,
  };
}

function fitMapToListings(listings) {
  if (!context.map || !listings.length) return;
  const bounds = new maplibregl.LngLatBounds();
  listings.forEach((item) => bounds.extend([item.longitude, item.latitude]));
  context.map.fitBounds(bounds, { padding: 70, duration: 0, pitch: 48, bearing: -12 });
}

function flyToNeighborhood(record) {
  if (!context.map || !record?.centroid?.latitude || !record?.centroid?.longitude) return;
  context.map.easeTo({ center: [record.centroid.longitude, record.centroid.latitude], zoom: Math.max(context.map.getZoom(), 11.8), duration: 1100 });
}

function updateMap(mappedListings) {
  if (!context.overlay) return;
  const selectedName = state.selectedNeighborhood;
  const selectedListings = selectedName ? mappedListings.filter((item) => item.neighborhood === selectedName) : [];
  const pulseRadius = 155 + (context.pulseValue % 5) * 28;
  const weightFor = (item) => {
    const base = Math.max(getMetricValue(item, state.metric), 1);
    return selectedName && item.neighborhood !== selectedName ? base * 0.26 : base;
  };
  const clickToSelect = (info) => info?.object?.neighborhood && setSelectedNeighborhood(info.object.neighborhood, { flyToSelection: true });
  const layers = [
    state.layer === "heatmap"
      ? new deck.HeatmapLayer({
          id: "market-heat",
          data: mappedListings,
          getPosition: (item) => [item.longitude, item.latitude],
          getWeight: weightFor,
          colorRange: [[13, 22, 33, 0], [22, 184, 255, 120], [76, 242, 177, 180], [255, 176, 103, 210], [255, 98, 115, 255]],
          radiusPixels: 54,
          intensity: 0.95,
          threshold: 0.05,
        })
      : null,
    state.layer === "heatmap"
      ? new deck.ScatterplotLayer({
          id: "heat-hits",
          data: mappedListings,
          pickable: true,
          radiusUnits: "meters",
          getPosition: (item) => [item.longitude, item.latitude],
          getRadius: 85,
          getFillColor: (item) => (selectedName === item.neighborhood ? [255, 255, 255, 18] : [0, 0, 0, 0]),
          onClick: clickToSelect,
        })
      : null,
    state.layer === "hexagon"
      ? new deck.HexagonLayer({
          id: "market-hex",
          data: mappedListings,
          pickable: true,
          extruded: true,
          radius: 800,
          coverage: 0.92,
          elevationScale: 14,
          getPosition: (item) => [item.longitude, item.latitude],
          getColorWeight: weightFor,
          colorAggregation: "MEAN",
          getElevationWeight: () => 1,
          elevationAggregation: "SUM",
          colorRange: [[14, 28, 42], [22, 184, 255], [76, 242, 177], [255, 176, 103], [255, 98, 115]],
          material: false,
          onClick: (info) => {
            const name = getSelectionFromHexBin(info.object);
            if (name) setSelectedNeighborhood(name, { flyToSelection: true });
          },
        })
      : null,
    state.layer === "scatter"
      ? new deck.ScatterplotLayer({
          id: "market-scatter",
          data: mappedListings,
          pickable: true,
          radiusUnits: "meters",
          stroked: true,
          getPosition: (item) => [item.longitude, item.latitude],
          getRadius: (item) => (state.metric === "density" ? 95 : Math.max(95, Math.min(240, Math.sqrt(getMetricValue(item, state.metric)) * 1.2))),
          getFillColor: (item) => [...(GROUP_COLORS[item.propertyGroup] || [255, 255, 255]), selectedName && item.neighborhood !== selectedName ? 54 : 210],
          getLineColor: (item) => (selectedName === item.neighborhood ? [255, 255, 255, 235] : [13, 22, 33, 150]),
          lineWidthUnits: "pixels",
          getLineWidth: (item) => (selectedName === item.neighborhood ? 2 : 1),
          onClick: clickToSelect,
        })
      : null,
    selectedListings.length
      ? new deck.ScatterplotLayer({
          id: "selection-glow",
          data: selectedListings,
          pickable: true,
          radiusUnits: "meters",
          getPosition: (item) => [item.longitude, item.latitude],
          getRadius: pulseRadius,
          getFillColor: [76, 242, 177, 55],
          onClick: clickToSelect,
        })
      : null,
    selectedListings.length
      ? new deck.ScatterplotLayer({
          id: "selection-core",
          data: selectedListings,
          pickable: true,
          radiusUnits: "meters",
          stroked: true,
          getPosition: (item) => [item.longitude, item.latitude],
          getRadius: 92,
          getFillColor: [255, 176, 103, 155],
          getLineColor: [255, 255, 255, 230],
          lineWidthUnits: "pixels",
          getLineWidth: 2,
          onClick: clickToSelect,
        })
      : null,
  ].filter(Boolean);
  context.overlay.setProps({ layers, getTooltip: tooltipFor });
}

function renderAll(options = {}) {
  context.filteredListings = getFilteredListings();
  context.filteredMappedListings = context.filteredListings.filter((item) => item.latitude !== null && item.longitude !== null);
  context.visibleNeighborhoods = getVisibleNeighborhoods(context.filteredListings);
  context.selectedNeighborhoodData = resolveSelectedNeighborhood(context.visibleNeighborhoods);
  state.selectedNeighborhood = context.selectedNeighborhoodData?.name || null;
  updateTopLevelStats();
  updateLegend();
  updateEmptyState();
  renderSpotlight(context.selectedNeighborhoodData);
  renderMix(context.filteredListings);
  renderHotspots(context.visibleNeighborhoods);
  renderHistory();
  if (context.mapReady) {
    updateMap(context.filteredMappedListings);
    if (!context.hasInitialMapView && context.filteredMappedListings.length) {
      fitMapToListings(context.filteredMappedListings);
      context.hasInitialMapView = true;
    } else if (options.flyToSelection && context.selectedNeighborhoodData) {
      flyToNeighborhood(context.selectedNeighborhoodData);
    }
  }
}

function setSelectedNeighborhood(name, options = {}) {
  state.selectedNeighborhood = name || null;
  renderAll(options);
}

function bindControls() {
  els.layerSelect.addEventListener("change", (event) => {
    state.layer = event.target.value;
    renderAll();
  });
  els.metricSelect.addEventListener("change", (event) => {
    state.metric = event.target.value;
    renderAll();
  });
  els.groupSelect.addEventListener("change", (event) => {
    state.propertyGroup = event.target.value;
    renderAll();
  });
  els.priceBandSelect.addEventListener("change", (event) => {
    state.priceBand = event.target.value;
    renderAll();
  });
  els.bedroomsSelect.addEventListener("change", (event) => {
    state.bedrooms = event.target.value;
    renderAll();
  });
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderAll();
  });
  els.freshToggle.addEventListener("change", (event) => {
    state.freshOnly = event.target.checked;
    renderAll();
  });
  els.resetButton.addEventListener("click", () => {
    Object.assign(state, DEFAULT_FILTER_STATE);
    els.layerSelect.value = state.layer;
    els.metricSelect.value = state.metric;
    els.groupSelect.value = state.propertyGroup;
    els.priceBandSelect.value = state.priceBand;
    els.bedroomsSelect.value = state.bedrooms;
    els.searchInput.value = state.search;
    els.freshToggle.checked = state.freshOnly;
    renderAll();
  });
}

function startPulseLoop() {
  context.pulseTimer = window.setInterval(() => {
    context.pulseValue = (context.pulseValue + 1) % 5;
    if (context.mapReady && state.selectedNeighborhood) updateMap(context.filteredMappedListings);
  }, 1100);
}

function initMap() {
  context.map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [73.0479, 33.6844],
    zoom: 10.8,
    pitch: 48,
    bearing: -12,
    attributionControl: false,
  });
  context.map.addControl(new maplibregl.NavigationControl(), "top-right");
  context.overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], getTooltip: tooltipFor });
  context.map.addControl(context.overlay);
  context.map.on("load", () => {
    context.mapReady = true;
    renderAll();
  });
}

async function init() {
  try {
    const [summary, listings, history, neighborhoods] = await Promise.all([
      fetchDataset("summary"),
      fetchDataset("listings"),
      fetchDataset("history", []),
      fetchDataset("neighborhoods", []),
    ]);
    context.summary = summary;
    context.listings = listings;
    context.history = history;
    context.neighborhoods = neighborhoods;
    bindControls();
    initMap();
    startPulseLoop();
    renderAll();
  } catch (error) {
    console.error(error);
    els.emptyState.classList.remove("hidden");
    els.emptyState.innerHTML = STATIC_RUNTIME
      ? "<strong>Unable to load the published snapshot.</strong><span>Wait for the next Pages deployment or inspect the deployment workflow.</span>"
      : "<strong>Unable to load the market dataset.</strong><span>Run the pipeline again and refresh this page.</span>";
  }
}

init();
