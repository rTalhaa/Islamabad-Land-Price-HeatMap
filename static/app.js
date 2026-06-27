const STATIC_RUNTIME = window.__ATLAS_STATIC__ || null;
const SOURCE_COLORS = {
  Zameen: "#009b8e",
  Graana: "#f08a32",
  OLX: "#2d6fa7",
  Unknown: "#87949d",
};
const GROUP_COLORS = {
  house: [0, 155, 142],
  apartment: [45, 111, 167],
  plot: [240, 138, 50],
};
// Shared low -> high price color ramps, tuned to glow on a dark basemap.
const HEAT_COLOR_RANGE = [
  [0, 0, 0, 0],
  [22, 120, 132, 110],
  [34, 179, 135, 165],
  [124, 199, 96, 200],
  [248, 198, 76, 225],
  [244, 95, 70, 240],
];
const HEX_COLOR_RANGE = [
  [38, 130, 142],
  [40, 179, 138],
  [140, 200, 96],
  [248, 198, 76],
  [240, 138, 50],
  [240, 88, 66],
];
const PRICE_SCALE_LABELS = ["Lower", "Median", "Premium", "Ultra prime"];
const TIER_COLORS = {
  Value: "#2a9d8f",
  "Mid-market": "#4faa55",
  Premium: "#d79433",
  "Ultra Prime": "#c2472f",
};
function tierColor(tier) {
  return TIER_COLORS[tier] || "#2a9d8f";
}
function priceTierFor(ppsf, sortedValues) {
  if (ppsf === null || ppsf === undefined || !sortedValues.length) return "Value";
  const below = sortedValues.filter((value) => value <= ppsf).length;
  const pct = below / sortedValues.length;
  if (pct >= 0.85) return "Ultra Prime";
  if (pct >= 0.6) return "Premium";
  if (pct >= 0.3) return "Mid-market";
  return "Value";
}
const DEFAULT_STATE = {
  layer: "heatmap",
  propertyGroup: "all",
  source: "all",
  budget: "all",
  sizeBand: "all",
  recency: "all",
  confidence: 70,
  hideOutliers: true,
  showPriceHeat: true,
  showClusters: true,
  showListingDots: true,
  selectedNeighborhood: null,
  inspectorTab: "overview",
};

const state = { ...DEFAULT_STATE };
const context = {
  summary: null,
  listings: [],
  neighborhoods: [],
  history: [],
  sourceHealth: null,
  qualityReport: null,
  filteredListings: [],
  visibleNeighborhoods: [],
  selectedNeighborhood: null,
  map: null,
  overlay: null,
  mapReady: false,
  showAllNeighborhoods: false,
  backendSavedStateAvailable: false,
  watchedNames: new Set(),
  savedSearches: [],
};

const $ = (id) => document.getElementById(id);
const els = {
  lastRefresh: $("lastRefresh"),
  nextRefresh: $("nextRefresh"),
  groupSelect: $("groupSelect"),
  sourceSelect: $("sourceSelect"),
  budgetSelect: $("budgetSelect"),
  sizeSelect: $("sizeSelect"),
  recencySelect: $("recencySelect"),
  confidenceSelect: $("confidenceSelect"),
  resetButton: $("resetButton"),
  applyButton: $("applyButton"),
  saveSearchButton: $("saveSearchButton"),
  hideOutliersToggle: $("hideOutliersToggle"),
  priceHeatToggle: $("priceHeatToggle"),
  clusterToggle: $("clusterToggle"),
  listingDotsToggle: $("listingDotsToggle"),
  roadsToggle: $("roadsToggle"),
  amenitiesToggle: $("amenitiesToggle"),
  watchButton: $("watchButton"),
  viewListingsButton: $("viewListingsButton"),
  viewNeighborhoodsButton: $("viewNeighborhoodsButton"),
  dataConfidence: $("dataConfidence"),
  dataConfidenceBar: $("dataConfidenceBar"),
  confidenceCaption: $("confidenceCaption"),
  sourceCoverage: $("sourceCoverage"),
  medianPrice: $("medianPrice"),
  medianCaption: $("medianCaption"),
  medianPpsf: $("medianPpsf"),
  medianMarla: $("medianMarla"),
  outlierCount: $("outlierCount"),
  outlierCaption: $("outlierCaption"),
  emptyState: $("emptyState"),
  spotlightName: $("spotlightName"),
  spotlightSubtitle: $("spotlightSubtitle"),
  spotlightTicket: $("spotlightTicket"),
  spotlightPpsf: $("spotlightPpsf"),
  spotlightMarla: $("spotlightMarla"),
  spotlightPpsfDelta: $("spotlightPpsfDelta"),
  spotlightTicketDelta: $("spotlightTicketDelta"),
  spotlightConfidence: $("spotlightConfidence"),
  spotlightOutliers: $("spotlightOutliers"),
  outlierBar: $("outlierBar"),
  spotlightSourceMix: $("spotlightSourceMix"),
  sourceMixCaption: $("sourceMixCaption"),
  fbrLink: $("fbrLink"),
  benchmarkCaption: $("benchmarkCaption"),
  sampleListings: $("sampleListings"),
  neighborhoodTable: $("neighborhoodTable"),
  historySparkline: $("historySparkline"),
  qualityList: $("qualityList"),
  savedState: $("savedState"),
};

const LOCAL_WATCH_KEY = "atlasWatchedNeighborhoods";
const LOCAL_SEARCH_KEY = "atlasSavedSearches";

function apiAvailable() {
  return !STATIC_RUNTIME?.forceStatic;
}

function readLocalWatchedNeighborhoods() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LOCAL_WATCH_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveLocalWatchedNeighborhoods(values) {
  try {
    localStorage.setItem(LOCAL_WATCH_KEY, JSON.stringify([...values].sort()));
  } catch {
    // Browser storage can be unavailable in hardened or embedded contexts.
  }
}

function readLocalSavedSearches() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_SEARCH_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLocalSavedSearches(values) {
  try {
    localStorage.setItem(LOCAL_SEARCH_KEY, JSON.stringify(values));
  } catch {
    // Browser storage can be unavailable in hardened or embedded contexts.
  }
}

function watchedNeighborhoods() {
  return new Set(context.watchedNames);
}

function renderSavedState() {
  if (!els.savedState) return;
  const watchedCount = context.watchedNames.size;
  const searchCount = context.savedSearches.length;
  const storage = context.backendSavedStateAvailable ? "SQLite" : "local";
  els.savedState.textContent = `${watchedCount} watched - ${searchCount} searches - ${storage}`;
}

async function loadSavedState() {
  if (apiAvailable()) {
    try {
      const [watchResponse, searchesResponse] = await Promise.all([
        fetch("/api/watchlist", { cache: "no-store" }),
        fetch("/api/saved-searches", { cache: "no-store" }),
      ]);
      if (!watchResponse.ok || !searchesResponse.ok) throw new Error("Saved state API unavailable");
      const watched = await watchResponse.json();
      const searches = await searchesResponse.json();
      context.watchedNames = new Set(watched.map((item) => item.neighborhood).filter(Boolean));
      context.savedSearches = Array.isArray(searches) ? searches : [];
      context.backendSavedStateAvailable = true;
      renderSavedState();
      return;
    } catch (error) {
      console.warn("Saved state API unavailable; using local storage.", error);
    }
  }
  context.watchedNames = readLocalWatchedNeighborhoods();
  context.savedSearches = readLocalSavedSearches();
  context.backendSavedStateAvailable = false;
  renderSavedState();
}

async function persistWatchedNeighborhood(name, shouldWatch) {
  if (!name) return;
  const watched = watchedNeighborhoods();

  if (context.backendSavedStateAvailable) {
    try {
      const response = await fetch(shouldWatch ? "/api/watchlist" : `/api/watchlist?neighborhood=${encodeURIComponent(name)}`, {
        method: shouldWatch ? "POST" : "DELETE",
        headers: shouldWatch ? { "Content-Type": "application/json" } : undefined,
        body: shouldWatch ? JSON.stringify({ neighborhood: name }) : undefined,
      });
      if (!response.ok) throw new Error("Watchlist write failed");
    } catch (error) {
      console.warn("Watchlist API write failed; using local storage.", error);
      context.backendSavedStateAvailable = false;
    }
  }

  if (shouldWatch) watched.add(name);
  else watched.delete(name);
  context.watchedNames = watched;
  if (!context.backendSavedStateAvailable) saveLocalWatchedNeighborhoods(watched);
  renderSavedState();
}

function selectedOptionText(select) {
  return select?.selectedOptions?.[0]?.textContent?.trim() || "Any";
}

function currentSearchSnapshot() {
  return {
    propertyGroup: state.propertyGroup,
    source: state.source,
    budget: state.budget,
    sizeBand: state.sizeBand,
    recency: state.recency,
    confidence: state.confidence,
    hideOutliers: state.hideOutliers,
    generatedAt: context.summary?.generatedAt || null,
  };
}

function currentSearchName() {
  const group = selectedOptionText(els.groupSelect);
  const source = selectedOptionText(els.sourceSelect);
  const budget = selectedOptionText(els.budgetSelect);
  return `${group} - ${source} - ${budget}`;
}

async function persistSavedSearch() {
  const payload = { name: currentSearchName(), filters: currentSearchSnapshot() };
  let saved = null;

  if (context.backendSavedStateAvailable) {
    try {
      const response = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Saved search write failed");
      saved = await response.json();
    } catch (error) {
      console.warn("Saved search API write failed; using local storage.", error);
      context.backendSavedStateAvailable = false;
    }
  }

  if (!saved) {
    saved = { ...payload, id: Date.now(), createdAt: new Date().toISOString() };
    saveLocalSavedSearches([saved, ...readLocalSavedSearches()]);
  }

  context.savedSearches = [saved, ...context.savedSearches];
  renderSavedState();
}

function scrollToTarget(target) {
  const targetMap = {
    map: "#mapPanel",
    neighborhoods: "#neighborhoodTable",
    listings: "#sampleListings",
    analytics: "#analyticsPanel",
    "price-index": "#analyticsPanel",
    quality: "#qualityPanel",
    sources: "#sources",
  };
  const selector = targetMap[target] || "#mapPanel";
  document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setActiveNav(target) {
  document.querySelectorAll("[data-nav-target]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.navTarget === target);
  });
}

function setInspectorTab(tabName) {
  state.inspectorTab = tabName;
  document.querySelectorAll("[data-inspector-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.inspectorTab === tabName);
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== tabName && !(tabName === "overview" && panel.dataset.tabPanel === "stats"));
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function staticDatasetUrl(fileName) {
  if (!STATIC_RUNTIME?.dataRoot) return null;
  return `${STATIC_RUNTIME.dataRoot.replace(/\/+$/, "")}/${fileName}`;
}

async function fetchDataset(apiName, fileName = `${apiName}.json`, fallback = null) {
  const candidates = [];
  if (!STATIC_RUNTIME?.forceStatic) candidates.push(`/api/${apiName}`);
  const staticUrl = staticDatasetUrl(fileName);
  if (staticUrl) candidates.push(staticUrl);
  let lastError = null;
  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        lastError = new Error(`Failed ${url}`);
        continue;
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  if (fallback !== null) return fallback;
  throw lastError || new Error(`Failed to load ${apiName}`);
}

function formatCompact(value) {
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
  return `PKR ${formatCompact(value)}`;
}

function formatPpsf(value) {
  return value === null || value === undefined ? "--" : formatCompact(value);
}

function formatMarla(value) {
  if (value === null || value === undefined) return "--";
  if (value >= 10_000_000) return `${(value / 10_000_000).toFixed(2).replace(/\.0+$/, "")} Cr`;
  if (value >= 100_000) return `${(value / 100_000).toFixed(2).replace(/\.0+$/, "")} Lakh`;
  return formatCompact(value);
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" }).format(new Date(value));
}

function formatSignedPct(value) {
  if (value === null || value === undefined) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(1).replace(/\.0$/, "")}%`;
}

function median(values) {
  const filtered = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
}

function passesBudget(listing) {
  const price = listing.pricePkr || 0;
  if (state.budget === "under2cr") return price < 20_000_000;
  if (state.budget === "2to8cr") return price >= 20_000_000 && price < 80_000_000;
  if (state.budget === "8crplus") return price >= 80_000_000;
  return true;
}

function filteredListings() {
  return context.listings.filter((listing) => {
    if (state.propertyGroup !== "all" && listing.propertyGroup !== state.propertyGroup) return false;
    if (state.source !== "all" && listing.source !== state.source) return false;
    if (!passesBudget(listing)) return false;
    if (state.sizeBand !== "all" && listing.sizeBand !== state.sizeBand) return false;
    if (state.recency !== "all" && listing.recencyBucket !== state.recency) return false;
    if ((listing.confidenceScore || 0) < state.confidence) return false;
    if (state.hideOutliers && listing.isOutlier) return false;
    return true;
  });
}

function sourceMix(items) {
  const total = items.length || 1;
  const sources = [...new Set(items.map((item) => item.source || "Unknown"))].sort();
  return Object.fromEntries(
    sources.map((source) => {
      const count = items.filter((item) => (item.source || "Unknown") === source).length;
      return [source, { count, share: count / total }];
    }),
  );
}

function buildVisibleNeighborhoods(items) {
  if (
    state.propertyGroup === "all" &&
    state.source === "all" &&
    state.budget === "all" &&
    state.sizeBand === "all" &&
    state.recency === "all" &&
    state.confidence === 70 &&
    state.hideOutliers &&
    context.neighborhoods.length
  ) {
    return context.neighborhoods;
  }

  const grouped = new Map();
  for (const listing of items) {
    if (!listing.neighborhood) continue;
    if (!grouped.has(listing.neighborhood)) grouped.set(listing.neighborhood, []);
    grouped.get(listing.neighborhood).push(listing);
  }
  const cityMedianPpsf = median(items.map((item) => item.pricePerSqft));
  const cityMedianTicket = median(items.map((item) => item.pricePkr));
  return [...grouped.entries()]
    .map(([name, records]) => {
      const mapped = records.filter((item) => item.latitude !== null && item.longitude !== null);
      const medianPricePerSqft = median(records.map((item) => item.pricePerSqft));
      const medianPricePkr = median(records.map((item) => item.pricePkr));
      return {
        name,
        listingCount: records.length,
        mappedCount: mapped.length,
        outlierCount: records.filter((item) => item.isOutlier).length,
        confidenceMedian: median(records.map((item) => item.confidenceScore)),
        medianPricePkr,
        medianPricePerSqft,
        medianPricePerMarla: median(records.map((item) => item.pricePerMarla)),
        medianAreaSqft: median(records.map((item) => item.areaSqft)),
        medianFreshnessHours: median(records.map((item) => item.freshnessHours)),
        centroid: {
          latitude: mapped.length ? mapped.reduce((sum, item) => sum + item.latitude, 0) / mapped.length : null,
          longitude: mapped.length ? mapped.reduce((sum, item) => sum + item.longitude, 0) / mapped.length : null,
        },
        cityMedianPpsfDeltaPct: cityMedianPpsf && medianPricePerSqft ? ((medianPricePerSqft - cityMedianPpsf) / cityMedianPpsf) * 100 : null,
        cityMedianTicketDeltaPct: cityMedianTicket && medianPricePkr ? ((medianPricePkr - cityMedianTicket) / cityMedianTicket) * 100 : null,
        sourceMix: sourceMix(records),
        benchmark: context.summary?.fbrReference,
        sampleListings: records.slice().sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0) || (b.pricePerSqft || 0) - (a.pricePerSqft || 0)).slice(0, 3),
      };
    })
    .sort((a, b) => b.listingCount - a.listingCount || (b.medianPricePerSqft || 0) - (a.medianPricePerSqft || 0));
}

function chooseNeighborhood(records) {
  if (!records.length) return null;
  return records.find((item) => item.name === state.selectedNeighborhood) || records[0];
}

function renderSourceOptions() {
  const sources = [...new Set(context.listings.map((item) => item.source).filter(Boolean))].sort();
  els.sourceSelect.innerHTML = `<option value="all">All sources (${sources.length})</option>${sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}`;
}

function renderTopMetrics() {
  const listings = context.filteredListings;
  const confidence = median(listings.map((item) => item.confidenceScore)) ?? context.summary?.medianConfidenceScore ?? 0;
  els.lastRefresh.textContent = context.summary ? formatDate(context.summary.generatedAt) : "Unknown";
  els.nextRefresh.textContent = context.sourceHealth ? `${formatCompact(context.summary?.trackedListings)} listings - ${Object.keys(context.sourceHealth.sources || {}).length} sources tracked` : "Source health unavailable";
  els.dataConfidence.textContent = `${Math.round(confidence)}%`;
  els.dataConfidenceBar.style.width = `${Math.max(0, Math.min(100, confidence))}%`;
  els.confidenceCaption.textContent = `${formatCompact(listings.length)} visible listings after filters`;
  els.medianPrice.textContent = formatPkr(median(listings.map((item) => item.pricePkr)));
  els.medianCaption.textContent = `${formatCompact(context.visibleNeighborhoods.length)} neighborhoods visible`;
  els.medianPpsf.textContent = formatPpsf(median(listings.map((item) => item.pricePerSqft)));
  els.medianMarla.textContent = formatMarla(median(listings.map((item) => item.pricePerMarla)));
  const hiddenOutliers = context.listings.filter((item) => item.isOutlier).length;
  els.outlierCount.textContent = formatCompact(hiddenOutliers);
  els.outlierCaption.textContent = state.hideOutliers ? "Hidden from medians" : "Visible in map";

  const mix = context.summary?.sourceMix || sourceMix(context.listings);
  els.sourceCoverage.innerHTML = Object.entries(mix)
    .map(([source, item]) => {
      const share = item.share ?? item.count / Math.max(1, context.summary?.trackedListings || context.listings.length);
      const color = SOURCE_COLORS[source] || SOURCE_COLORS.Unknown;
      return `<div class="source-row"><strong>${escapeHtml(source)}</strong><div class="source-row__bar"><i style="width:${Math.round(share * 100)}%;background:${color}"></i></div><span>${Math.round(share * 100)}%</span></div>`;
    })
    .join("");
}

function renderInspector(record) {
  const inspector = document.querySelector(".inspector");
  if (inspector) inspector.scrollTop = 0;
  if (!record) {
    els.spotlightName.textContent = "No neighborhood";
    els.spotlightSubtitle.textContent = "No listings match the active filters";
    els.sampleListings.innerHTML = "";
    return;
  }
  const watched = watchedNeighborhoods();
  const isWatched = watched.has(record.name);
  els.spotlightName.textContent = record.name;
  els.spotlightSubtitle.textContent = `${formatCompact(record.listingCount)} listings - ${formatCompact(record.medianAreaSqft)} sqft median area`;
  els.spotlightTicket.textContent = formatPkr(record.medianPricePkr);
  els.spotlightPpsf.textContent = formatPpsf(record.medianPricePerSqft);
  els.spotlightMarla.textContent = formatMarla(record.medianPricePerMarla);
  els.spotlightPpsfDelta.textContent = formatSignedPct(record.cityMedianPpsfDeltaPct);
  els.spotlightTicketDelta.textContent = formatSignedPct(record.cityMedianTicketDeltaPct);
  els.spotlightConfidence.textContent = `${Math.round(record.confidenceMedian || 0)}%`;
  els.spotlightOutliers.textContent = `${formatCompact(record.outlierCount || 0)} / ${formatCompact(record.listingCount)}`;
  els.outlierBar.style.width = `${Math.min(100, ((record.outlierCount || 0) / Math.max(1, record.listingCount)) * 100)}%`;
  const mixEntries = Object.entries(record.sourceMix || {});
  els.sourceMixCaption.textContent = `${mixEntries.length} source${mixEntries.length === 1 ? "" : "s"}`;
  els.spotlightSourceMix.innerHTML = mixEntries
    .map(([source, item]) => `<i title="${escapeHtml(source)} ${Math.round(item.share * 100)}%" style="width:${Math.max(2, item.share * 100)}%;background:${SOURCE_COLORS[source] || SOURCE_COLORS.Unknown}"></i>`)
    .join("");
  const fbr = context.summary?.fbrReference || record.benchmark;
  els.fbrLink.href = fbr?.url || "#";
  els.benchmarkCaption.textContent = record.benchmark?.status === "matched" ? `Benchmark delta ${formatSignedPct(record.benchmark.deltaPct)}` : "Official valuation reference linked. Numeric matching appears where an area table is mapped.";
  els.watchButton.textContent = isWatched ? "Watching" : "Watch";
  els.watchButton.classList.toggle("is-active", isWatched);
  els.watchButton.setAttribute("aria-pressed", String(isWatched));

  els.sampleListings.innerHTML = (record.sampleListings || [])
    .map((item) => {
      const image = item.imageUrl ? `style="background-image:url('${String(item.imageUrl).replace(/'/g, "%27")}')"` : "";
      return `<a class="sample-card" href="${escapeHtml(item.url || item.detailUrl || "#")}" target="_blank" rel="noreferrer">
        <div class="sample-card__image" ${image}></div>
        <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.source)} - ${formatCompact(item.confidenceScore)}% confidence</span><small>${formatPpsf(item.pricePerSqft)} / sqft - ${formatCompact(item.areaSqft)} sqft</small></div>
        <div class="sample-card__price">${formatPkr(item.pricePkr)}</div>
      </a>`;
    })
    .join("");
  setInspectorTab(state.inspectorTab);
}

function renderNeighborhoodTable(records) {
  const rows = records.slice(0, context.showAllNeighborhoods ? records.length : 7);
  const sortedPpsf = records.map((r) => r.medianPricePerSqft).filter((v) => v != null).sort((a, b) => a - b);
  const maxPpsf = Math.max(1, ...rows.map((r) => r.medianPricePerSqft || 0));
  els.neighborhoodTable.innerHTML = rows
    .map((record, index) => {
      const ppsf = record.medianPricePerSqft || 0;
      const tier = record.priceTier || priceTierFor(ppsf, sortedPpsf);
      const width = Math.max(4, Math.round((ppsf / maxPpsf) * 100));
      const delta = record.cityMedianPpsfDeltaPct;
      const deltaClass = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
      const selected = record.name === state.selectedNeighborhood ? ' style="background:var(--surface-2)"' : "";
      return `<div class="rank-row"${selected}>
        <span>${String(index + 1).padStart(2, "0")}</span>
        <button type="button" data-neighborhood="${escapeHtml(record.name)}">${escapeHtml(record.name)}<small>${formatCompact(record.listingCount)} listings · ${escapeHtml(tier)}</small></button>
        <div class="rank-row__value">
          <strong>${formatPpsf(ppsf)}</strong>
          <div class="rank-bar"><i style="width:${width}%;background:${tierColor(tier)}"></i></div>
          <span class="rank-delta ${deltaClass}">${formatSignedPct(delta)} vs city</span>
        </div>
      </div>`;
    })
    .join("");
  els.neighborhoodTable.querySelectorAll("button[data-neighborhood]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedNeighborhood = button.dataset.neighborhood;
      renderAll({ flyToSelection: true });
    });
  });
}

// Price drift — area + line chart with gradient fill, axis baseline, latest marker.
function renderHistory() {
  const svg = els.historySparkline;
  const history = (context.history || []).filter((h) => h.medianPricePerSqft);
  const driftLatest = document.getElementById("driftLatest");
  const driftChange = document.getElementById("driftChange");
  if (history.length < 2) {
    svg.innerHTML = '<line x1="20" y1="120" x2="500" y2="120" stroke="rgba(17,33,31,0.18)" stroke-width="2" stroke-dasharray="4 7"></line>';
    if (driftLatest) driftLatest.textContent = "--";
    if (driftChange) driftChange.textContent = "--";
    return;
  }
  const values = history.map((h) => h.medianPricePerSqft);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const W = 520;
  const H = 200;
  const padX = 12;
  const top = 18;
  const bottom = 168;
  const x = (i) => padX + ((W - padX * 2) * i) / (values.length - 1);
  const y = (v) => (max === min ? (top + bottom) / 2 : bottom - ((v - min) / (max - min)) * (bottom - top));
  const linePts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const areaPath = `M${x(0).toFixed(1)},${bottom} L${linePts.join(" L")} L${x(values.length - 1).toFixed(1)},${bottom} Z`;
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);
  svg.innerHTML = `
    <defs>
      <linearGradient id="driftFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0b6e63" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#0b6e63" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="${padX}" y1="${bottom}" x2="${W - padX}" y2="${bottom}" stroke="rgba(17,33,31,0.12)" stroke-width="1"/>
    <path d="${areaPath}" fill="url(#driftFill)"/>
    <polyline points="${linePts.join(" ")}" fill="none" stroke="#0b6e63" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5" fill="#c77d2e" stroke="#fff" stroke-width="2"/>`;
  const first = values[0];
  const latest = values[values.length - 1];
  if (driftLatest) driftLatest.textContent = formatPpsf(Math.round(latest));
  if (driftChange) driftChange.textContent = formatSignedPct(first ? ((latest - first) / first) * 100 : null);
}

// Price by property type — horizontal bars, reactive to filters.
function renderPriceLadder() {
  const host = document.getElementById("priceLadder");
  if (!host) return;
  const groups = [
    { key: "house", label: "Houses", color: "#0b6e63" },
    { key: "apartment", label: "Flats & Apartments", color: "#2d6fa7" },
    { key: "plot", label: "Residential Plots", color: "#c77d2e" },
  ];
  const rows = groups.map((g) => {
    const items = context.filteredListings.filter((l) => l.propertyGroup === g.key && !l.isOutlier);
    return { ...g, ppsf: median(items.map((l) => l.pricePerSqft)) || 0, count: items.length };
  });
  const max = Math.max(1, ...rows.map((r) => r.ppsf));
  host.innerHTML = rows
    .map(
      (r) => `<div class="bar-row">
        <div class="bar-row__head"><strong>${r.label}</strong><span>${formatPpsf(Math.round(r.ppsf))}</span></div>
        <div class="bar-track"><i style="width:${Math.max(2, Math.round((r.ppsf / max) * 100))}%;background:${r.color}"></i></div>
        <small>${formatCompact(r.count)} listings</small>
      </div>`,
    )
    .join("");
}

// PPSF distribution histogram over the currently visible listings.
function renderPpsfHistogram() {
  const svg = document.getElementById("ppsfHistogram");
  const axis = document.getElementById("histAxis");
  if (!svg) return;
  const values = context.filteredListings.map((l) => l.pricePerSqft).filter((v) => v != null && v > 0);
  if (values.length < 4) {
    svg.innerHTML = '<line x1="12" y1="168" x2="508" y2="168" stroke="rgba(17,33,31,0.12)"/>';
    if (axis) axis.innerHTML = "";
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[Math.floor(sorted.length * 0.97)] || sorted[sorted.length - 1];
  const bins = 14;
  const span = Math.max(1, hi - lo);
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
    if (idx >= 0) counts[idx] += 1;
  }
  const maxCount = Math.max(1, ...counts);
  const cityMedian = median(values);
  const W = 520;
  const top = 14;
  const bottom = 168;
  const gap = 3;
  const bw = (W - 24) / bins;
  let bars = "";
  counts.forEach((c, i) => {
    const h = (c / maxCount) * (bottom - top);
    const bx = 12 + i * bw;
    const by = bottom - h;
    const binVal = lo + (i + 0.5) * (span / bins);
    const tier = priceTierFor(binVal, sorted);
    bars += `<rect x="${(bx + gap / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${tierColor(tier)}" opacity="0.9"></rect>`;
  });
  const medRatio = (cityMedian - lo) / span;
  const medX = 12 + Math.max(0, Math.min(1, medRatio)) * (W - 24);
  bars += `<line x1="${medX.toFixed(1)}" y1="${top}" x2="${medX.toFixed(1)}" y2="${bottom}" stroke="#11211f" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  bars += `<line x1="12" y1="${bottom}" x2="${W - 12}" y2="${bottom}" stroke="rgba(17,33,31,0.12)"/>`;
  svg.innerHTML = bars;
  if (axis) {
    axis.innerHTML = `<span>${formatPpsf(Math.round(lo))}</span><span>median ${formatPpsf(Math.round(cityMedian))}</span><span>${formatPpsf(Math.round(hi))}+</span>`;
  }
}

function renderQuality() {
  const report = context.qualityReport || {};
  const rows = [
    ["Geocoding accuracy", report.geocodingAccuracy],
    ["Price parsing success", report.priceParsingSuccess],
    ["Area parsing success", report.areaParsingSuccess],
    ["Freshness <= 30 days", report.freshnessWithin30Days],
    ["Duplicate rate", 1 - (report.duplicateRate || 0)],
  ];
  els.qualityList.innerHTML = rows
    .map(([label, value]) => `<div class="quality-row"><strong>${escapeHtml(label)}</strong><div class="quality-row__bar"><i style="width:${Math.round((value || 0) * 100)}%;background:${value > 0.9 ? "#15a15f" : value > 0.75 ? "#f08a32" : "#f05f43"}"></i></div><span>${Math.round((value || 0) * 100)}%</span></div>`)
    .join("");
}

function mappedListings() {
  return context.filteredListings.filter((item) => item.latitude !== null && item.longitude !== null);
}

const TOOLTIP_STYLE = {
  background: "rgba(12, 18, 27, 0.96)",
  color: "#eef4f3",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "12px",
  lineHeight: "1.5",
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.45)",
};

function tooltipFor(info) {
  if (!info.object) return null;
  if (info.object.points) {
    const count = info.object.points.length;
    const ppsf = info.object.colorValue ?? info.object.elevationValue;
    const detail = ppsf ? `<div class="tip-muted">~${formatPpsf(ppsf)} / sqft</div>` : "";
    return { html: `<strong>${formatCompact(count)} listings</strong>${detail}`, style: TOOLTIP_STYLE };
  }
  return {
    html: `<strong>${escapeHtml(info.object.title)}</strong><div class="tip-muted">${escapeHtml(info.object.neighborhood)} - ${formatPkr(info.object.pricePkr)}</div><div class="tip-muted">${formatPpsf(info.object.pricePerSqft)} / sqft - ${escapeHtml(info.object.source)}</div>`,
    style: TOOLTIP_STYLE,
  };
}

// Build the on-map price color legend; content adapts to the active layer.
function renderLegend() {
  const host = document.getElementById("mapLegend");
  if (!host) return;
  const usesPriceScale = state.layer === "heatmap" || state.layer === "hexagon";
  if (usesPriceScale) {
    const stops = HEAT_COLOR_RANGE.slice(1)
      .map((c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`)
      .join(", ");
    const ticks = PRICE_SCALE_LABELS.map((label) => `<span>${label}</span>`).join("");
    host.innerHTML = `
      <span class="map-legend__title">Price intensity (PKR / sqft)</span>
      <div class="map-legend__ramp" style="background: linear-gradient(90deg, ${stops})"></div>
      <div class="map-legend__ticks">${ticks}</div>`;
  } else {
    const swatches = Object.entries({ house: "Houses", apartment: "Apartments", plot: "Plots" })
      .map(([key, label]) => {
        const c = GROUP_COLORS[key];
        return `<span class="map-legend__item"><i style="background: rgb(${c[0]}, ${c[1]}, ${c[2]})"></i>${label}</span>`;
      })
      .join("");
    host.innerHTML = `<span class="map-legend__title">Property type</span><div class="map-legend__items">${swatches}</div>`;
  }
}

function updateMap(options = {}) {
  if (!context.overlay) return;
  const data = mappedListings();
  const selectedName = state.selectedNeighborhood;
  const layers = [
    state.layer === "heatmap" && state.showPriceHeat
      ? new deck.HeatmapLayer({
          id: "heatmap",
          data,
          getPosition: (item) => [item.longitude, item.latitude],
          getWeight: (item) => Math.max(1, item.pricePerSqft || 1),
          radiusPixels: 46,
          intensity: 1.1,
          threshold: 0.03,
          // Tuned for a dark basemap: fully transparent base that ramps into a
          // teal -> green -> amber -> coral glow so hot pockets pop.
          colorRange: HEAT_COLOR_RANGE,
        })
      : null,
    state.layer === "hexagon" && state.showClusters
      ? new deck.HexagonLayer({
          id: "hexagon",
          data,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 90],
          extruded: true,
          radius: 700,
          coverage: 0.88,
          elevationScale: 14,
          getPosition: (item) => [item.longitude, item.latitude],
          getColorWeight: (item) => item.pricePerSqft || 1,
          colorAggregation: "MEAN",
          getElevationWeight: () => 1,
          elevationAggregation: "SUM",
          material: { ambient: 0.7, diffuse: 0.6, shininess: 32, specularColor: [60, 64, 70] },
          transitions: { getElevationValue: 400 },
          colorRange: HEX_COLOR_RANGE,
        })
      : null,
    state.showListingDots
      ? new deck.ScatterplotLayer({
      id: "listings",
      data,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 120],
      radiusUnits: "meters",
      stroked: true,
      radiusMinPixels: 3,
      radiusMaxPixels: 26,
      getPosition: (item) => [item.longitude, item.latitude],
      getRadius: (item) => (selectedName === item.neighborhood ? 150 : state.layer === "scatter" ? 100 : 60),
      getFillColor: (item) => [...(GROUP_COLORS[item.propertyGroup] || [45, 111, 167]), selectedName && selectedName !== item.neighborhood ? 60 : 225],
      getLineColor: (item) => (item.isOutlier ? [255, 110, 84, 255] : [10, 16, 24, 200]),
      lineWidthUnits: "pixels",
      getLineWidth: (item) => (selectedName === item.neighborhood ? 2.5 : 1),
      updateTriggers: {
        getFillColor: [selectedName],
        getRadius: [selectedName, state.layer],
      },
      onClick: (info) => {
        if (info.object?.neighborhood) {
          state.selectedNeighborhood = info.object.neighborhood;
          renderAll({ flyToSelection: true });
        }
      },
    })
      : null,
  ].filter(Boolean);
  context.overlay.setProps({ layers, getTooltip: tooltipFor });
  if (!context.mapReady || !data.length) return;
  if (!context.hasFit) {
    const bounds = new maplibregl.LngLatBounds();
    data.forEach((item) => bounds.extend([item.longitude, item.latitude]));
    context.map.fitBounds(bounds, { padding: 64, duration: 0 });
    context.hasFit = true;
  } else if (options.flyToSelection && context.selectedNeighborhood?.centroid?.longitude) {
    context.map.easeTo({
      center: [context.selectedNeighborhood.centroid.longitude, context.selectedNeighborhood.centroid.latitude],
      zoom: Math.max(context.map.getZoom(), 11.6),
      pitch: state.layer === "hexagon" ? 48 : context.map.getPitch(),
      duration: 900,
      essential: true,
    });
  }
}

function setBaseMapLayerVisibility(kind, visible) {
  if (!context.map?.isStyleLoaded?.()) return;
  const matchers = {
    roads: ["road", "street", "transport"],
    amenities: ["poi", "place", "amenity", "label"],
  }[kind] || [];
  for (const layer of context.map.getStyle().layers || []) {
    const id = layer.id.toLowerCase();
    if (matchers.some((matcher) => id.includes(matcher))) {
      try {
        context.map.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
      } catch {
        // Some provider layers are not layout-toggleable; skip them.
      }
    }
  }
}

function renderAll(options = {}) {
  context.filteredListings = filteredListings();
  context.visibleNeighborhoods = buildVisibleNeighborhoods(context.filteredListings);
  context.selectedNeighborhood = chooseNeighborhood(context.visibleNeighborhoods);
  state.selectedNeighborhood = context.selectedNeighborhood?.name || null;
  els.emptyState.classList.toggle("hidden", context.filteredListings.length > 0);
  renderTopMetrics();
  renderInspector(context.selectedNeighborhood);
  renderNeighborhoodTable(context.visibleNeighborhoods);
  renderHistory();
  renderPriceLadder();
  renderPpsfHistogram();
  renderQuality();
  renderLegend();
  updateMap(options);
}

function bindControls() {
  els.groupSelect.addEventListener("change", (event) => {
    state.propertyGroup = event.target.value;
    renderAll();
  });
  els.sourceSelect.addEventListener("change", (event) => {
    state.source = event.target.value;
    renderAll();
  });
  els.budgetSelect.addEventListener("change", (event) => {
    state.budget = event.target.value;
    renderAll();
  });
  els.sizeSelect.addEventListener("change", (event) => {
    state.sizeBand = event.target.value;
    renderAll();
  });
  els.recencySelect.addEventListener("change", (event) => {
    state.recency = event.target.value;
    renderAll();
  });
  els.confidenceSelect.addEventListener("change", (event) => {
    state.confidence = Number(event.target.value);
    renderAll();
  });
  els.hideOutliersToggle.addEventListener("change", (event) => {
    state.hideOutliers = event.target.checked;
    renderAll();
  });
  els.priceHeatToggle.addEventListener("change", (event) => {
    state.showPriceHeat = event.target.checked;
    renderAll();
  });
  els.clusterToggle.addEventListener("change", (event) => {
    state.showClusters = event.target.checked;
    renderAll();
  });
  els.listingDotsToggle.addEventListener("change", (event) => {
    state.showListingDots = event.target.checked;
    renderAll();
  });
  els.roadsToggle.addEventListener("change", (event) => {
    setBaseMapLayerVisibility("roads", event.target.checked);
  });
  els.amenitiesToggle.addEventListener("change", (event) => {
    setBaseMapLayerVisibility("amenities", event.target.checked);
  });
  document.querySelectorAll("[data-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-layer]").forEach((node) => node.classList.toggle("is-active", node === button));
      state.layer = button.dataset.layer;
      renderLegend();
      applyViewForLayer();
      renderAll();
    });
  });
  document.querySelectorAll("[data-nav-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.navTarget;
      setActiveNav(target);
      if (target === "listings") setInspectorTab("listings");
      if (target === "price-index") setInspectorTab("price-index");
      if (target === "quality") document.querySelector("#qualityPanel")?.classList.add("is-expanded");
      scrollToTarget(target);
    });
  });
  document.querySelectorAll("[data-inspector-tab]").forEach((button) => {
    button.addEventListener("click", () => setInspectorTab(button.dataset.inspectorTab));
  });
  els.watchButton.addEventListener("click", async () => {
    if (!context.selectedNeighborhood?.name) return;
    const isWatched = watchedNeighborhoods().has(context.selectedNeighborhood.name);
    els.watchButton.disabled = true;
    try {
      await persistWatchedNeighborhood(context.selectedNeighborhood.name, !isWatched);
    } finally {
      els.watchButton.disabled = false;
    }
    renderInspector(context.selectedNeighborhood);
  });
  els.saveSearchButton?.addEventListener("click", async () => {
    const originalLabel = els.saveSearchButton.textContent;
    els.saveSearchButton.disabled = true;
    try {
      await persistSavedSearch();
      els.saveSearchButton.textContent = "Saved";
      window.setTimeout(() => {
        els.saveSearchButton.textContent = originalLabel;
        els.saveSearchButton.disabled = false;
      }, 900);
    } catch (error) {
      console.error(error);
      els.saveSearchButton.textContent = originalLabel;
      els.saveSearchButton.disabled = false;
    }
  });
  els.viewListingsButton.addEventListener("click", () => {
    setInspectorTab("listings");
    scrollToTarget("listings");
  });
  els.viewNeighborhoodsButton.addEventListener("click", () => {
    context.showAllNeighborhoods = !context.showAllNeighborhoods;
    document.querySelector("#neighborhoodTable")?.closest(".panel")?.classList.toggle("is-expanded");
    els.viewNeighborhoodsButton.textContent = context.showAllNeighborhoods ? "Show less" : "View all";
    renderNeighborhoodTable(context.visibleNeighborhoods);
    scrollToTarget("neighborhoods");
  });
  document.querySelector("#qualityLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    document.querySelector("#qualityPanel")?.classList.add("is-expanded");
    scrollToTarget("quality");
  });
  els.resetButton.addEventListener("click", () => {
    Object.assign(state, DEFAULT_STATE);
    els.groupSelect.value = state.propertyGroup;
    els.sourceSelect.value = state.source;
    els.budgetSelect.value = state.budget;
    els.sizeSelect.value = state.sizeBand;
    els.recencySelect.value = state.recency;
    els.confidenceSelect.value = String(state.confidence);
    els.hideOutliersToggle.checked = state.hideOutliers;
    els.priceHeatToggle.checked = state.showPriceHeat;
    els.clusterToggle.checked = state.showClusters;
    els.listingDotsToggle.checked = state.showListingDots;
    els.roadsToggle.checked = false;
    els.amenitiesToggle.checked = false;
    setInspectorTab("overview");
    renderAll();
  });
  els.applyButton.addEventListener("click", () => renderAll());
}

function initMap() {
  context.map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [73.0479, 33.6844],
    zoom: 10.5,
    pitch: 0,
    bearing: 0,
    maxPitch: 60,
    antialias: true,
    attributionControl: true,
  });
  context.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  context.overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], getTooltip: tooltipFor });
  context.map.addControl(context.overlay);
  context.map.on("load", () => {
    context.mapReady = true;
    renderLegend();
    renderAll();
  });
  const coordsEl = document.getElementById("mapCoords");
  if (coordsEl) {
    context.map.on("move", () => {
      const c = context.map.getCenter();
      const ns = c.lat >= 0 ? "N" : "S";
      const ew = c.lng >= 0 ? "E" : "W";
      coordsEl.textContent = `${Math.abs(c.lat).toFixed(4)} ${ns} · ${Math.abs(c.lng).toFixed(4)} ${ew}`;
    });
  }
}

// Ease the camera into a 3D tilt for the cluster view and back to flat otherwise.
function applyViewForLayer() {
  if (!context.map || !context.mapReady) return;
  const wants3d = state.layer === "hexagon";
  const targetPitch = wants3d ? 48 : 0;
  if (Math.round(context.map.getPitch()) !== targetPitch) {
    context.map.easeTo({ pitch: targetPitch, duration: 700 });
  }
}

async function init() {
  try {
    const [summary, listings, history, neighborhoods, sourceHealth, qualityReport] = await Promise.all([
      fetchDataset("summary"),
      fetchDataset("listings"),
      fetchDataset("history", "history.json", []),
      fetchDataset("neighborhoods", "neighborhoods.json", []),
      fetchDataset("source-health", "source_health.json", null),
      fetchDataset("quality-report", "quality_report.json", null),
    ]);
    context.summary = summary;
    context.listings = listings;
    context.history = history;
    context.neighborhoods = neighborhoods;
    context.sourceHealth = sourceHealth;
    context.qualityReport = qualityReport;
    await loadSavedState();
    renderSourceOptions();
    bindControls();
    initMap();
    renderAll();
  } catch (error) {
    console.error(error);
    els.emptyState.classList.remove("hidden");
    els.emptyState.innerHTML = "<strong>Unable to load the market intelligence dataset.</strong><span>Run the pipeline again, then refresh this page.</span>";
  }
}

init();
