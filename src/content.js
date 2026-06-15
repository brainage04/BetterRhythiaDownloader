(() => {
  "use strict";

  const API_URL = "https://production.rhythia.com/api/getBeatmaps";
  const BUTTON_SELECTOR = "[data-brd-download-button]";
  const MAP_CARD_SELECTOR = [
    'a[href^="/maps/"]',
    'a[href^="https://www.rhythia.com/maps/"]',
    'a[href^="https://rhythia.com/maps/"]'
  ].join(",");

  const state = {
    abortController: null,
    cache: new Map(),
    mapsById: new Map(),
    scheduled: 0
  };

  const downloadIcon = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" x2="12" y1="15" y2="3"></line>
    </svg>
  `;

  function isMapsListing() {
    return window.location.pathname === "/maps";
  }

  function routeKey() {
    return window.location.pathname + window.location.search;
  }

  function numberParam(params, name, fallback) {
    const value = params.get(name);
    if (value === null || value.trim() === "") return fallback;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function stringParam(params, name, fallback) {
    const value = params.get(name);
    return value === null ? fallback : value;
  }

  function buildPayload() {
    const params = new URLSearchParams(window.location.search);
    const payload = {
      session: "",
      page: numberParam(params, "page", 1),
      textFilter: stringParam(params, "filter", ""),
      authorFilter: stringParam(params, "author", ""),
      tagsFilter: stringParam(params, "tags", ""),
      minStars: numberParam(params, "minStars", 0),
      maxStars: numberParam(params, "maxStars", 20),
      status: stringParam(params, "status", "RANKED"),
      sort: stringParam(params, "sort", "newest"),
      sortDirection: stringParam(params, "sortDirection", "desc")
    };

    for (const name of ["minLength", "maxLength", "creator"]) {
      if (params.has(name)) {
        payload[name] = numberParam(params, name, undefined);
      }
    }

    return payload;
  }

  function getMapIdFromHref(href) {
    try {
      const url = new URL(href, window.location.origin);
      const match = url.pathname.match(/^\/maps\/(\d+)$/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  function createDownloadButton(map) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "brd-download-button";
    button.dataset.brdDownloadButton = "true";
    button.innerHTML = downloadIcon;
    updateButton(button, map);

    button.addEventListener(
      "click",
      (event) => {
        // The whole card is already a link, so the button must stop that card navigation.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const downloadUrl = button.dataset.brdDownloadUrl;
        if (!downloadUrl) return;

        window.open(downloadUrl, "_blank", "noopener,noreferrer");
      },
      true
    );

    return button;
  }

  function updateButton(button, map) {
    button.setAttribute("aria-label", "Download");
    button.dataset.brdDownloadUrl = map.beatmapFile || "";
    button.toggleAttribute("data-brd-unavailable", !map.beatmapFile);
  }

  function decorateCards() {
    if (!isMapsListing() || state.mapsById.size === 0) return;

    for (const card of document.querySelectorAll(MAP_CARD_SELECTOR)) {
      const mapId = getMapIdFromHref(card.getAttribute("href"));
      if (!mapId) continue;

      const map = state.mapsById.get(mapId);
      if (!map) continue;

      const existing = card.querySelector(BUTTON_SELECTOR);
      if (existing) {
        updateButton(existing, map);
        continue;
      }

      card.append(createDownloadButton(map));
    }
  }

  async function loadMapsForCurrentRoute() {
    if (!isMapsListing()) {
      state.mapsById = new Map();
      return;
    }

    const key = routeKey();
    if (state.cache.has(key)) {
      state.mapsById = state.cache.get(key);
      decorateCards();
      return;
    }

    if (state.abortController) {
      state.abortController.abort();
    }

    state.abortController = new AbortController();

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(buildPayload()),
        signal: state.abortController.signal
      });

      if (!response.ok) {
        throw new Error(`Rhythia API returned ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error);
      }

      const mapsById = new Map();
      for (const map of data.beatmaps || []) {
        if (typeof map.id === "number") mapsById.set(map.id, map);
      }

      state.cache.set(key, mapsById);
      state.mapsById = mapsById;
      decorateCards();
    } catch (error) {
      if (error.name !== "AbortError") {
        console.warn("[Better Rhythia Downloader] Could not load map downloads.", error);
      }
    }
  }

  function scheduleLoad() {
    window.clearTimeout(state.scheduled);
    state.scheduled = window.setTimeout(loadMapsForCurrentRoute, 100);
  }

  function installNavigationHooks() {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        scheduleLoad();
        return result;
      };
    }

    window.addEventListener("popstate", scheduleLoad);
  }

  function start() {
    installNavigationHooks();

    const observer = new MutationObserver(decorateCards);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    scheduleLoad();
  }

  start();
})();
