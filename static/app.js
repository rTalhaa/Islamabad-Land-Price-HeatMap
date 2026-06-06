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
  els.neighborhoodTable.innerHTML = records
    .slice(0, context.showAllNeighborhoods ? records.length : 6)
    .map(
      (record, index) => `<div class="rank-row">
        <span>${index + 1}</span>
        <button type="button" data-neighborhood="${escapeHtml(record.name)}">${escapeHtml(record.name)}<small>${formatCompact(record.listingCount)} listings - ${Math.round(record.confidenceMedian || 0)}% confidence</small></button>
        <strong>${formatPpsf(record.medianPricePerSqft)}</strong>
        <span>${formatSignedPct(record.cityMedianPpsfDeltaPct)}</span>
      </div>`,
    )
    .join("");
  els.neighborhoodTable.querySelectorAll("button[data-neighborhood]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedNeighborhood = button.dataset.neighborhood;
      renderAll({ flyToSelection: true });
    });
  });
}

function renderHistory() {
  const history = context.history || [];
  if (history.length < 2) {
    els.historySparkline.innerHTML = '<line x1="20" y1="100" x2="500" y2="100" stroke="#c8d7d2" stroke-width="2" stroke-dasharray="5 7"></line>';
    return;
  }
  const values = history.map((item) => item.medianPricePerSqft || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, index) => {
    const x = 24 + (472 * index) / (values.length - 1 || 1);
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    return `${x},${156 - ratio * 120}`;
  });
  els.historySparkline.innerHTML = `<polyline fill="none" stroke="#039b8e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points.join(" ")}"></polyline>${points
    .map((point, index) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="${index === points.length - 1 ? 5 : 3}" fill="${index === points.length - 1 ? "#f08a32" : "#039b8e"}"></circle>`)
    .join("")}`;
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

function tooltipFor(info) {
  if (!info.object) return null;
  if (info.object.points) {
    return { html: `<strong>${formatCompact(info.object.points.length)} listings</strong>` };
  }
  return { html: `<strong>${escapeHtml(info.object.title)}</strong><div>${escapeHtml(info.object.neighborhood)} - ${formatPkr(info.object.pricePkr)}</div><div>${formatPpsf(info.object.pricePerSqft)} / sqft - ${escapeHtml(info.object.source)}</div>` };
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
          radiusPixels: 58,
          intensity: 0.9,
          threshold: 0.05,
          colorRange: [
            [255, 255, 255, 0],
            [89, 183, 190, 120],
            [63, 188, 135, 170],
            [246, 195, 91, 205],
            [240, 95, 67, 240],
          ],
        })
      : null,
    state.layer === "hexagon" && state.showClusters
      ? new deck.HexagonLayer({
          id: "hexagon",
          data,
          pickable: true,
          extruded: true,
          radius: 750,
          coverage: 0.9,
          elevationScale: 10,
          getPosition: (item) => [item.longitude, item.latitude],
          getColorWeight: (item) => item.pricePerSqft || 1,
          colorAggregation: "MEAN",
          getElevationWeight: () => 1,
          elevationAggregation: "SUM",
          colorRange: [
            [89, 183, 190],
            [63, 188, 135],
            [246, 195, 91],
            [240, 138, 50],
            [240, 95, 67],
          ],
        })
      : null,
    state.showListingDots
      ? new deck.ScatterplotLayer({
      id: "listings",
      data,
      pickable: true,
      radiusUnits: "meters",
      stroked: true,
      getPosition: (item) => [item.longitude, item.latitude],
      getRadius: (item) => (selectedName === item.neighborhood ? 145 : state.layer === "scatter" ? 96 : 58),
      getFillColor: (item) => [...(GROUP_COLORS[item.propertyGroup] || [45, 111, 167]), selectedName && selectedName !== item.neighborhood ? 80 : 210],
      getLineColor: (item) => (item.isOutlier ? [240, 95, 67, 240] : [255, 255, 255, 230]),
      lineWidthUnits: "pixels",
      getLineWidth: (item) => (selectedName === item.neighborhood ? 2 : 1),
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
    context.map.easeTo({ center: [context.selectedNeighborhood.centroid.longitude, context.selectedNeighborhood.centroid.latitude], zoom: Math.max(context.map.getZoom(), 11.6), duration: 900 });
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
  renderQuality();
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
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [73.0479, 33.6844],
    zoom: 10.5,
    pitch: 0,
    bearing: 0,
    attributionControl: true,
  });
  context.map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  context.overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], getTooltip: tooltipFor });
  context.map.addControl(context.overlay);
  context.map.on("load", () => {
    context.mapReady = true;
    renderAll();
  });
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
