(() => {
  'use strict';

  /* ================================
     Paths & dataset config
     ================================ */
  const DATA_PATH = '/assets/data/';
  const FILES = {
    // Background silhouette (kept as-is)
    countriesSilhouette: DATA_PATH + 'world-countries.json',

    // Level-specific sources
    nuts3Geo:   DATA_PATH + 'nuts3-copy.geojson',
    nuts3Csv:   DATA_PATH + 'nuts3-data.csv',
    countryGeo: DATA_PATH + 'country.geojson',
    countryCsv: DATA_PATH + 'country-data.csv'
  };

  // --- Vendor loader: make map.js self-sufficient ---
  const VENDOR_URLS = {
    leaflet: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    papa:    'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js'
  };

  function loadScriptOnce(url, onload) {
    // already in DOM?
    const exists = Array.from(document.getElementsByTagName('script')).some(s => s.src === url);
    if (exists) { onload && onload(); return; }

    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => onload && onload();
    s.onerror = () => console.error('[map] failed to load', url);
    document.head.appendChild(s);
  }

  function ensureVendors(cb) {
    const needLeaflet = !window.L;
    const needPapa    = !window.Papa;

    if (!needLeaflet && !needPapa) { cb(); return; }

    let readyLeaflet = !needLeaflet;
    let readyPapa    = !needPapa;

    if (needLeaflet) loadScriptOnce(VENDOR_URLS.leaflet, () => { readyLeaflet = true; maybeGo(); });
    if (needPapa)    loadScriptOnce(VENDOR_URLS.papa,    () => { readyPapa    = true; maybeGo(); });

    function maybeGo() {
      if (readyLeaflet && readyPapa) cb();
    }
  }

  // Describe how to read IDs/names per level
  const LEVELS = {
    // Finer view
    '3': {
      label: 'NUTS3',
      geo:   FILES.nuts3Geo,
      csv:   FILES.nuts3Csv,
      // Prefer NUTS3 fields, then fall back to older NUTS fields
      idProps:    ['NUTS3_ID', 'NUTS_ID'],
      nameProps:  ['NUTS3_NAME', 'NUTS_NAME'],
      csvId:      ['NUTS3_ID', 'NUTS_ID', 'nuts3_id', 'nuts_id'],
      countryFld: ['CNTR_NAME', 'country', 'Country', 'CNTR NAME']
    },
    // Country view
    '0': {
      label: 'Country',
      geo:   FILES.countryGeo,
      csv:   FILES.countryCsv,
      // Try common codes, then fall back to name
      idProps:    ['CNTR_CODE', 'CNTR_ID', 'ISO_A3', 'ISO3', 'COUNTRY_ID', 'ID', 'CNTR_NAME'],
      nameProps:  ['CNTR_NAME', 'NAME_EN', 'NAME'],
      csvId:      ['CNTR_CODE', 'CNTR_ID', 'ISO_A3', 'COUNTRY_ID', 'ID', 'CNTR_NAME'],
      countryFld: ['CNTR_NAME', 'NAME_EN', 'NAME']
    }
  };

  /* ================================
     Palette & measure labels
     ================================ */
  const palette = ['#cde2e2', '#82b6b6', '#307c7b', '#004141'];
  const measureNames = {
    forgottenVoters: 'Forgotten Voters Share',
    willingnessPay:  'Willingness to Pay for Climate Action',
    renewableSupport:'Renewable Energy Support'
  };

  // Global, fixed means per level (NUTS3 = '3', Country = '0')
  const globalMeans = {
    '3': Object.create(null),
    '0': Object.create(null),
  };

  /* ================================
     Global state (per level stores)
     ================================ */
  let currentLevel   = '3';        // '3' (NUTS3) or '0' (Country)
  let currentMeasure = 'forgottenVoters';
  let currentCountry = '__all__';  // CNTR_NAME, or __all__
  let map, geojsonLayer = null, initialBounds = null;
  let controlsWired = false;
  let searchInput = null;  // #region-search
  let ac = null;           // #region-ac (autocomplete container)   
  

  // --- URL <-> state helpers (keep URL as source of truth) ---
  // --- indicator id ↔ short code mapping + URL parser ---
  const MEASURE_TO_PARAM = {
    forgottenVoters:  'sfv',
    willingnessPay:   'wtp',
    renewableSupport: 'renewables',
  };

  // accept BOTH short codes and full ids (any case)
  const SHORT_TO_MEASURE = {
    sfv:        'forgottenVoters',
    wtp:        'willingnessPay',
    renewables: 'renewableSupport',
  };
  const FULL_TO_MEASURE = {
    forgottenvoters:  'forgottenVoters',
    willingnesspay:   'willingnessPay',
    renewablesupport: 'renewableSupport',
  };

  function applyUrlToState() {
    const p   = new URLSearchParams(window.location.search);
    const raw = (p.get('indicator') || '').trim();
    const key = raw.toLowerCase();

    currentMeasure = SHORT_TO_MEASURE[key] || FULL_TO_MEASURE[key] || 'forgottenVoters';
    currentCountry = (p.get('country') || '').trim() || '__all__';
  }

  console.debug('[init] measure=', currentMeasure, 'country=', currentCountry, 'qs=', window.location.search);

  // Write current state back to URL
  // Always include ?indicator=... even if it's the default (sfv)
  function syncUrl(push = false) {
    const p = new URLSearchParams(window.location.search);
    p.set('indicator', (MEASURE_TO_PARAM[currentMeasure] || 'sfv'));

    if (!currentCountry || currentCountry === '__all__') p.delete('country');
    else p.set('country', currentCountry);

    const qs = p.toString();
    const newUrl = `${location.pathname}${qs ? `?${qs}` : ''}`;
    (push ? history.pushState : history.replaceState).call(history, null, '', newUrl);
  }

  // --- Accept initial measure/country from the Home map (if provided) ---
  const DASH_INIT = (typeof window !== 'undefined' && window.__DASH_INIT__) || null;
  /**
   * IMPORTANT:
   * - indicator should be one of: 'forgottenVoters' | 'willingnessPay' | 'renewableSupport'
   * - country should be CNTR_NAME (e.g., 'Germany'), not ISO code. If you only have ISO, pass CNTR_NAME instead.
   */
  if (DASH_INIT && typeof DASH_INIT === 'object') {
    if (DASH_INIT.indicator &&
        ['forgottenVoters','willingnessPay','renewableSupport'].includes(DASH_INIT.indicator)) {
      currentMeasure = DASH_INIT.indicator;
    }
    if (DASH_INIT.country && String(DASH_INIT.country).trim()) {
      // We'll apply this to the <select> once options are populated (see step 2)
      currentCountry = String(DASH_INIT.country).trim();
    }
  }

  // Per-level stores
  const store = {
    '3': { dataById: Object.create(null), countryIndex: Object.create(null), geoData: null, loaded: false },
    '0': { dataById: Object.create(null), countryIndex: Object.create(null), geoData: null, loaded: false },
  };

  // Shared UI state
  const regionLayerMap = Object.create(null); // label -> Leaflet layer
  let allRegionNames = []; 
  let scaleMin = null, scaleMax = null, scaleMean = null;
  let plotMin = 0, plotMax = 100; // fixed for the dot plot

  /* ================================
     Small helpers
     ================================ */
  function num(v) { const x = parseFloat(v); return isFinite(x) ? x : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function debounce(fn, ms = 120) {
    let t; return function () { clearTimeout(t); const args = arguments; t = setTimeout(() => fn.apply(null, args), ms); };
  }
  function normId(v) { return v == null ? '' : String(v).trim().toUpperCase().replace(/\s+/g,''); }

  function idFromProps(p, level) {
    p = p || {};
    const props = LEVELS[level].idProps;
    for (let i=0;i<props.length;i++) {
      const val = p[props[i]];
      if (val != null && String(val).trim() !== '') return normId(val);
    }
    return '';
  }
  function nameFromProps(p, level) {
    p = p || {};
    const props = LEVELS[level].nameProps;
    for (let i=0;i<props.length;i++) {
      const val = p[props[i]];
      if (val != null && String(val).trim() !== '') return String(val);
    }
    // Fall back to ID or CNTR_NAME
    return p.CNTR_NAME || idFromProps(p, level) || '—';
  }
  function idFromCsvRow(row, level) {
    const candidates = LEVELS[level].csvId;
    for (let i=0;i<candidates.length;i++) {
      const val = row[candidates[i]];
      if (val != null && String(val).trim() !== '') return normId(val);
    }
    return '';
  }
  function countryFromCsvRow(row, level) {
    const candidates = LEVELS[level].countryFld;
    for (let i=0;i<candidates.length;i++) {
      const val = row[candidates[i]];
      if (val != null && String(val).trim() !== '') return String(val).trim();
    }
    return '';
  }

  // ---- bootstrap: ensure vendors, then init (re-init if container changed) ----
(function bootstrap(){
  if (typeof window === 'undefined') return;

  applyUrlToState();

  // Only run on the dashboard page when the map container is present
  const mapEl = document.getElementById('map');
  if (!mapEl) { setTimeout(bootstrap, 0); return; }

  ensureVendors(async () => {
  // If we’re coming in with a country, try to prefit to it
  let prefit = null;
  if (currentCountry && currentCountry !== '__all__') {
    try {
      const gj = await fetch(FILES.countryGeo).then(r => r.json());
      const feat = (gj.features || []).find(f =>
        (f.properties?.CNTR_NAME || '').trim() === currentCountry
      );
      if (feat && window.L) {
        const tmp = L.geoJson(feat);
        const b = tmp.getBounds();
        if (b && b.isValid && b.isValid()) prefit = b.pad(0.06);
        try { tmp.remove(); } catch {}
      }
    } catch (e) {
      console.warn('[bootstrap] prefit failed', e);
    }
  }

  try {
    initMap(prefit); // ⬅️ pass the precomputed bounds
  } catch (e) {
    console.error('[bootstrap] init failed', e);
    setTimeout(bootstrap, 16);
  }
});

})();


  function initMap(prefitBounds) {
    // Clean up any existing map first
    if (map) {
      try {
        map.remove();
      } catch (e) {
        console.warn('[initMap] Error removing old map:', e);
      }
      map = null;
      geojsonLayer = null;
      initialBounds = null;
      controlsWired = false;
    }

map = L.map('map', {
  minZoom: 3,
  maxZoom: 10,
  attributionControl: false,
  zoomControl: false,
  preferCanvas: true,
  scrollWheelZoom: false,   // disable trackpad/mouse-wheel zoom
});

// Disable all “scroll-like” zoom inputs after the map exists
map.scrollWheelZoom.disable();  // mouse wheel / two-finger scroll
map.touchZoom.disable();        // pinch zoom on trackpads / touch
// Optional if you also want to stop double-click zoom:
// map.doubleClickZoom.disable();


(function() {
  var __settle = function() { try { map && map.invalidateSize(true); } catch(e) {} };
  setTimeout(__settle, 0); // post-layout
  if (typeof window !== 'undefined') {
    window.addEventListener('load', __settle);
    window.addEventListener('resize', __settle);
  }
})();

// Use prefit bounds if provided, else fall back to EU default
if (prefitBounds) {
  map.fitBounds(prefitBounds, { animate: false });
  window.__DASH_DID_PREFIT__ = true;
} else {
  map.setView([52, 10], 4);
  window.__DASH_DID_PREFIT__ = false;
}


    // Store reference globally for cleanup detection
    window.__DASH_MAP_INSTANCE__ = map;

    // Kill Chrome's focus ring (and any browser focus on the map container)
    const el = map.getContainer();
    el.style.visibility = 'visible';
    el.removeAttribute('tabindex');             // stops the container from being focusable
    el.addEventListener('mousedown', () => el.blur()); // belt & suspenders

    addCountriesSilhouette();
    addZoomHomeButtons();   // use the custom control only
    wireControls();

    // --- Enhanced teardown for better navigation handling ---
    setupTeardown();
  }

  function setupTeardown() {
    // Multiple cleanup strategies to handle different navigation scenarios
    
    // 1. Browser back/forward navigation
    window.addEventListener('pagehide', handlePageHide, { once: true });
    
    // 2. Client-side route changes (DOM removal)
    const mapEl = document.getElementById('map');
    if (mapEl) {
      const observer = new MutationObserver(handleDOMChange);
      observer.observe(document.body, { childList: true, subtree: true });
      
      // Store observer for cleanup
      if (map) map._domObserver = observer;
    }
    
    // 3. Visibility change (tab switching, etc.)
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  function handlePageHide() {
    console.debug('[teardown] Page hiding, cleaning up map');
    cleanup();
  }

  function handleDOMChange(mutations) {
    const mapEl = document.getElementById('map');
    if (!mapEl || !document.body.contains(mapEl)) {
      console.debug('[teardown] Map container removed from DOM, cleaning up');
      cleanup();
      
      // Disconnect observer
      if (map && map._domObserver) {
        map._domObserver.disconnect();
        map._domObserver = null;
      }
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) return;
    
    // When page becomes visible again, check if map is still valid
    const mapEl = document.getElementById('map');
    if (mapEl && (!map || !map._container || !document.body.contains(map._container))) {
      console.debug('[teardown] Page visible but map invalid, allowing re-init');
      cleanup();
    }
  }

function cleanup() {
  try {
    if (map) {
      // stop & detach observers bound to this map
      if (map._domObserver) {
        map._domObserver.disconnect();
        map._domObserver = null;
      }
      map.remove(); // tears Leaflet down and clears el._leaflet_id
    }
  } catch (e) {
    console.warn('[cleanup] Error during map cleanup:', e);
  }

  // ---- reset all globals/state ----
  map = null;
  geojsonLayer = null;
  initialBounds = null;
  controlsWired = false;
  window.__DASH_MAP_INSTANCE__ = null;

  // UI element handles (so next mount re-queries fresh nodes)
  searchInput = null;   // <= add this if you haven’t declared it: let searchInput = null;
  ac = null;            // <= add this if you haven’t declared it: let ac = null;

  // clear region mappings / caches
  for (const k in regionLayerMap) {
    if (Object.prototype.hasOwnProperty.call(regionLayerMap, k)) delete regionLayerMap[k];
  }
  allRegionNames = [];

  // global listeners tied to this page
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}


  function addCountriesSilhouette() {
    const pane = 'countriesPane';
    if (!map.getPane(pane)) map.createPane(pane);
    const p = map.getPane(pane);
    p.style.zIndex = 300;
    p.style.pointerEvents = 'none';

    fetch(FILES.countriesSilhouette)
      .then(res => { if (!res.ok) throw new Error('countries fetch failed: ' + res.status); return res.json(); })
      .then(world => {
        if (!map) return; // Map might have been cleaned up during fetch
        L.geoJson(world, {
          pane,
          interactive: false,
          style: { fillColor: '#361F38', fillOpacity: 1, color: '#361F38', weight: 0, opacity: 1 }
        }).addTo(map);
      })
      .catch(err => console.error('Countries silhouette failed:', err));
  }

  // Search wiring
  if (searchInput && ac) {
    const filterAC = debounce(function (term) {
      const t = term.trim().toLowerCase();
      if (!t) { ac.style.display = 'none'; resetAllHighlights(); return; }
      const matches = allRegionNames.filter(n => n.toLowerCase().includes(t)).slice(0, 50);
      showAC(matches);
      // Soft highlight
      for (let name in regionLayerMap) {
        const layer = regionLayerMap[name];
        if (!layer) continue;
        if (matches.indexOf(name) !== -1) highlightLayer(layer);
        else layer.setStyle({ weight: 0.5, color: '#555', fillOpacity: 0.2 });
      }
    }, 80);

    searchInput.addEventListener('input', function () { filterAC(this.value); });
    ac.addEventListener('mousedown', function (e) {
      const item = e.target.closest('[data-i]');
      if (!item) return;
      chooseACByName(item.textContent);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (ac.style.display !== 'block') return;
      const items = Array.from(ac.children);
      if (e.key === 'Enter') {
        e.preventDefault();
        if (items.length) chooseACByName(items[0].textContent);
      } else if (e.key === 'Escape') {
        ac.style.display = 'none'; resetAllHighlights();
      }
    });
    window.addEventListener('resize', function(){ if (ac.style.display === 'block') positionDropdown(searchInput, ac); });
    window.addEventListener('scroll', function(){ if (ac.style.display === 'block') positionDropdown(searchInput, ac); }, { passive: true });
  }

  function wireControls() {
  if (controlsWired) return;
  controlsWired = true;

  // Always query the *current* DOM
  const measureSelect = document.getElementById('measure-select');
  const countrySelect = document.getElementById('country-select');
  const levelSelect   = document.getElementById('level-select');
  // assign to globals so other functions/handlers can safely use them
  searchInput = document.getElementById('region-search');
  ac = document.getElementById('region-ac');

  // Enhance custom selects present in DOM
  document.querySelectorAll('select.js-map-select').forEach(enhanceSelect);

  // Attach listeners to the *current* elements
  if (measureSelect) {
    measureSelect.addEventListener('change', () => {
      currentMeasure = measureSelect.value;
      rebuildLayer();
      updateHoverInfo();
      syncUrl(true);
    });
  }

  if (countrySelect) {
    countrySelect.addEventListener('change', () => {
      currentCountry = countrySelect.value || '__all__';
      rebuildLayer();
      updateHoverInfo();
      zoomToCurrentFilter();
      syncWrappedSelectLabel(countrySelect);  // refresh the visible button text
      syncUrl(true);
    });
  }

  if (levelSelect) {
    levelSelect.addEventListener('change', () => {
      const next = levelSelect.value === '0' ? '0' : '3';
      if (next === currentLevel) return;

      const prevCenter = map.getCenter();
      const prevZoom   = map.getZoom();
      const desiredCountry = currentCountry;

      currentLevel = next;
      if (searchInput) searchInput.value = '';
      if (ac) { ac.innerHTML = ''; ac.style.display = 'none'; }

      ensureLevelLoaded(currentLevel, () => {
        populateCountrySelectFromStore(currentLevel);
        const S = store[currentLevel];
        const hasCountry = desiredCountry && desiredCountry !== '__all__' && !!S.countryIndex[desiredCountry];

        if (countrySelect) {
          countrySelect.value = hasCountry ? desiredCountry : '__all__';
          syncWrappedSelectLabel(countrySelect);
        }
        rebuildLayer();
        map.setView(prevCenter, prevZoom, { animate: false });
        updateHoverInfo();
      });
    });
  }

  // Load both levels. First paint = NUTS3.
  loadLevel('3', () => {
    if (currentLevel !== '3') return;
    populateCountrySelectFromStore('3');
    applyUrlToState();

    // reflect selects (no dispatch)
    if (measureSelect) measureSelect.value = currentMeasure;
    if (countrySelect) {
      const S = store['3'];
      const exists = !!(currentCountry && currentCountry !== '__all__' && S.countryIndex[currentCountry]);
      countrySelect.value = exists ? currentCountry : '__all__';
      if (!exists) currentCountry = '__all__';
      if (typeof syncWrappedSelectLabel === 'function') syncWrappedSelectLabel(countrySelect);
    }

    // build & fit once (no animation)
    rebuildLayer();
    zoomToCurrentFilter();

    // write canonical URL (keeps ?indicator=...)
    syncUrl(false);
  });
}

  /* ================================
     Level loading (CSV + GeoJSON)
     ================================ */
  function loadLevel(level, onReady) {
    if (!LEVELS[level]) return;
    const LCFG = LEVELS[level];
    const S = store[level];

    // If already loaded, just callback
    if (S.loaded && S.geoData && Object.keys(S.dataById).length) {
      if (typeof onReady === 'function') onReady();
      return;
    }

    // Step 1: CSV
    Papa.parse(LCFG.csv, {
      download: true,
      header: true,
      error: function (err) {
        console.error('CSV parse failed (' + level + '):', err);
        alert('Failed to load data (' + LEVELS[level].label + ').');
      },
      complete: function (results) {
        try {
          const rows = results.data || [];
          const countryNames = new Set();

          for (let i=0;i<rows.length;i++) {
            const row = rows[i]; if (!row) continue;
            const id = idFromCsvRow(row, level); if (!id) continue;

            const cn = countryFromCsvRow(row, level);
            if (cn) {
              countryNames.add(cn);
              if (!S.countryIndex[cn]) S.countryIndex[cn] = new Set();
              S.countryIndex[cn].add(id);
            }

            S.dataById[id] = {
              forgottenVoters: num(row.forgottenVoters),
              willingnessPay:  num(row.willingnessPay),
              renewableSupport:num(row.renewableSupport),
              CNTR_NAME: cn || null
            };
          }

          // --- Compute global means for THIS level from the full CSV ---
          (function computeGlobalMeansForLevel() {
            const means = Object.create(null);
            const measures = Object.keys(measureNames); // ['forgottenVoters', 'willingnessPay', 'renewableSupport']

            for (const m of measures) {
              let sum = 0, count = 0;
              for (const id in S.dataById) {
                const v = S.dataById[id][m];
                if (v != null && isFinite(v)) { sum += v; count++; }
              }
              means[m] = count ? (sum / count) : null;
            }

            globalMeans[level] = means;   // store per-level global means
            // console.log('[globalMeans]['+level+']', globalMeans[level]); // (optional) sanity check
          })();

          // Step 2: GeoJSON
          fetch(LCFG.geo)
            .then(r => { if (!r.ok) throw new Error('fetch geo ' + level + ' failed: ' + r.status); return r.json(); })
            .then(gj => {
              // Light aliasing for NUTS3 so code can be uniform
              if (level === '3' && gj && gj.features && gj.features.length) {
                for (let k=0;k<gj.features.length;k++) {
                  const f = gj.features[k], p = (f && f.properties) ? f.properties : {};
                  if (p && p.NUTS3_ID && !p.NUTS_ID)   p.NUTS_ID = p.NUTS3_ID;
                  if (p && p.NUTS3_NAME && !p.NUTS_NAME) p.NUTS_NAME = p.NUTS3_NAME;
                }
              }
              S.geoData = gj;
              S.loaded = true;
              if (typeof onReady === 'function') onReady();
            })
            .catch(err => {
              console.error('GeoJSON failed (' + level + '):', err);
              alert('Failed to load map regions (' + LEVELS[level].label + ').');
            });

        } catch (e) {
          console.error('CSV processing error (' + level + '):', e);
        }
      }
    });
  }

  function ensureLevelLoaded(level, cb) {
    const S = store[level];
    if (S && S.loaded && S.geoData && Object.keys(S.dataById).length) {
      if (typeof cb === 'function') cb();
      return;
    }
    loadLevel(level, cb);
  }

  /* ================================
     Country select (based on current level store)
     ================================ */
  function populateCountrySelectFromStore(level) {
    const countrySelect = document.getElementById('country-select'); 
    if (!countrySelect) return;
    const S = store[level];

    // Build option list
    const names = Object.keys(S.countryIndex).sort((a, b) => a.localeCompare(b));
    const options = ['<option value="__all__">All countries</option>']
      .concat(names.map(n => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'))
      .join('');
    countrySelect.innerHTML = options;

    // Keep the user's current selection if possible
    const desired = currentCountry;
    const hasDesired = !!(desired && desired !== '__all__' && S.countryIndex[desired]);
    countrySelect.value = hasDesired ? desired : '__all__';

    // Ensure wrapper exists (enhance if needed)
    let wrapper = document.querySelector('.map-select[data-for="' + (countrySelect.id || '') + '"]');
    if (!wrapper) {
      enhanceSelect(countrySelect);   // ⬅️ added safeguard
      wrapper = document.querySelector('.map-select[data-for="' + (countrySelect.id || '') + '"]');
    }

    // If wrapper exists, rebuild menu + sync label
    if (wrapper) {
      const menu = wrapper.querySelector('.map-select__menu');
      if (menu) {
        menu.innerHTML = '';
        Array.prototype.forEach.call(countrySelect.options, function (opt) {
          const item = document.createElement('div');
          item.className = 'map-select__option';
          item.setAttribute('role', 'option');
          item.dataset.value = opt.value;
          item.textContent = opt.text;

          if (opt.value === countrySelect.value) item.setAttribute('aria-selected', 'true');

          item.addEventListener('mousedown', function (e) {
            e.preventDefault();
            Array.prototype.forEach.call(menu.children, el => el.removeAttribute('aria-selected'));
            item.setAttribute('aria-selected', 'true');

            countrySelect.value = opt.value;
            countrySelect.dispatchEvent(new Event('change', { bubbles: true }));

            wrapper.classList.remove('open');
          });

          menu.appendChild(item);
        });
      }

      // ⬅️ New: update the visible toggle text + aria-selected states
      syncWrappedSelectLabel(countrySelect);
    }
  }

  /* ================================
     Rebuild choropleth layer
     ================================ */
  function rebuildLayer() {
    const S = store[currentLevel];
    if (!S || !S.geoData || !map) return;

    // Filter by country (CNTR_NAME) using per-level index
    let feats = (S.geoData.features || []);
    if (currentCountry && currentCountry !== '__all__') {
      const ids = S.countryIndex[currentCountry] || new Set();
      const out = [];
      for (let i=0;i<feats.length;i++) {
        const f = feats[i]; const id = idFromProps(f.properties, currentLevel);
        if (ids.has(id)) out.push(f);
      }
      feats = out;
    }

    // Reset indices & names
    for (let k in regionLayerMap) { if (Object.prototype.hasOwnProperty.call(regionLayerMap, k)) delete regionLayerMap[k]; }
    allRegionNames = feats.map(f => nameFromProps(f.properties, currentLevel)).filter(Boolean);

    // Dynamic scale from visible features
    computeScaleFromFeatures(feats, S.dataById);
    updateLegend();

    // Replace layer
    if (geojsonLayer) { map.removeLayer(geojsonLayer); geojsonLayer = null; }
    geojsonLayer = L.geoJson({ type: 'FeatureCollection', features: feats }, { style, onEachFeature }).addTo(map);
    // First real layer is on → reveal the map once
    if (!window.__DASH_FIRST_LAYER_READY__) {
    window.__DASH_FIRST_LAYER_READY__ = true;
    try { map.getContainer().style.visibility = 'visible'; } catch {}
    }

    // Save full-bounds once (EU view)
    if (!initialBounds) {
      const b0 = getLayerBounds(geojsonLayer);
      if (b0 && b0.isValid && b0.isValid()) initialBounds = L.latLngBounds(b0.getSouthWest(), b0.getNorthEast());
    }
  }

  function style(feature) {
    const S = store[currentLevel];
    const id = idFromProps(feature.properties, currentLevel);
    const row = S.dataById[id];
    const val = row ? row[currentMeasure] : null;
    return {
      fillColor: getColor(val),
      weight: 0.7,
      opacity: 1,
      color: '#2A192C',
      fillOpacity: 0.9
    };
  }

  function onEachFeature(feature, layer) {
    const p = feature.properties || {};
    const name = nameFromProps(p, currentLevel);
    if (name) regionLayerMap[name] = layer;

    layer.on({
      mouseover: function () {
        setPageCursorClass('cursor-hover'); // show custom hover cursor
        highlightLayer(layer);
        updateHoverInfo(p);
      },
      mouseout: function () {
        setPageCursorClass(null); // revert to default grab/grabbing
        resetAllHighlights();
        updateHoverInfo();
      },
      mousedown: function () {
        setPageCursorClass('cursor-click'); // pressed state
        const up = () => { setPageCursorClass(null); map.off('mouseup', up); map.off('dragend', up); };
        map.on('mouseup', up);
        map.on('dragend', up);
      },
      click: function () {
        const b = layer.getBounds && layer.getBounds();
        if (b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.5));
      }
    });

    // Remove any old tooltip (paranoia in case of rebuilds)
    if (layer.getTooltip && layer.getTooltip()) {
      layer.unbindTooltip();
    }

    // Bind a sticky tooltip
    layer.bindTooltip(tooltipHtml(p), {
      sticky: true,
      direction: 'top',
      opacity: 1,
      className: 'map-tip',
      offset: [0, -6]
    });

    layer.on({
      mouseover: function (e) {
        // Refresh content in case measure/level changed
        if (layer.getTooltip) {
          const tt = layer.getTooltip();
          if (tt) tt.setContent(tooltipHtml(p));
        } else if (layer.setTooltipContent) {
          // some Leaflet builds expose this on layers
          layer.setTooltipContent(tooltipHtml(p));
        }
        if (layer.openTooltip) layer.openTooltip();

        highlightLayer(e.target);
        updateHoverInfo(p);
      },
      mouseout: function () {
        if (layer.closeTooltip) layer.closeTooltip();
        resetAllHighlights();
        updateHoverInfo();
      },
      click: function () {
        if (layer.getBounds) {
          const b = layer.getBounds();
          if (b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.5));
        }
      }
    });
  }

  /* ================================
     Color scale & legend
     ================================ */
  function getColor(value) {
    if (value === undefined || value === null || isNaN(value)) return '#444';
    const min = (scaleMin != null && isFinite(scaleMin)) ? scaleMin : 20;
    const max = (scaleMax != null && isFinite(scaleMax)) ? scaleMax : 90;
    if (max <= min) return palette[palette.length - 1];
    const v = Math.min(Math.max(value, min), max);
    const step = (max - min) / palette.length;
    const idx = Math.min(Math.floor((v - min) / step), palette.length - 1);
    return palette[idx];
  }

  function computeScaleFromFeatures(features, dataById) {
    let min = +Infinity, max = -Infinity;
    const m = currentMeasure;

    // compute min/max from VISIBLE features (legend stays dynamic)
    for (let i = 0; i < (features || []).length; i++) {
      const f = features[i], p = f.properties || {};
      const id = idFromProps(p, currentLevel);
      const row = dataById[id];
      const val = row ? row[m] : null;
      if (val != null && isFinite(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }

    if (min === +Infinity || max === -Infinity) {
      scaleMin = null; 
      scaleMax = null; 
    } else {
      scaleMin = min; 
      scaleMax = max; 
    }

    // ⬅️ Use the precomputed GLOBAL mean for the current level/measure
    scaleMean = (globalMeans[3] || {})[m] ?? null; // always use NUTS3 as reference, other wise scaleMean = (globalMeans[currentLevel] || {})[m] ?? null;
    console.log('[mean]', currentLevel, m, scaleMean); // check mean value in dev tools

    // keep plot range fixed for the dot plot
    plotMin = 0;
    plotMax = 100;
  }

  function fmtValue(v) { return (v == null || !isFinite(v)) ? 'N/A' : (v.toFixed(1) + '%'); }

  function dotPlotSVG({ min, max, mean, value, width = 140, height = 20, pad = 8, aria = 'Value vs average' }) {
    if (min == null || max == null || !isFinite(min) || !isFinite(max) || max <= min) return '';

    const clamp = (v) => Math.max(min, Math.min(max, v));
    const x = (v) => pad + ((clamp(v) - min) / (max - min)) * (width - pad * 2);
    const cy = Math.round(height / 2);

    const meanOk = mean != null && isFinite(mean);
    const valOk  = value != null && isFinite(value);

    let out = '';
    out += `<svg class="tip-spark" width="${width}" height="${height}" role="img" aria-label="${aria}">`;
    out += `<title>${aria}</title>`;

    // Track (thin line, your color)
    out += `<line x1="${pad}" y1="${cy}" x2="${width - pad}" y2="${cy}" 
               stroke="#5B4F5D" stroke-width="2" stroke-linecap="round"></line>`;

    // Mean dot
    if (meanOk) {
      out += `<circle cx="${x(mean)}" cy="${cy}" r="6" fill="#c5c5c5ff" opacity="0.9">
                <title>Average: ${fmtValue(mean)}</title>
              </circle>`;
    }

    // Value dot
    if (valOk) {
      out += `<circle cx="${x(value)}" cy="${cy}" r="6" fill="#A1FCC2">
                <title>Selected: ${fmtValue(value)}</title>
              </circle>`;
    }

    out += `</svg>`;
    return out;
  }

  // Build a sentence showing the difference vs the global mean
  function deltaLine({ value, mean, epsilon = 0.5 }) {
    if (value == null || !isFinite(value) || mean == null || !isFinite(mean)) return '';

    const diff = value - mean;
    const abs = Math.abs(diff);

    // Small tolerance so "equal" isn't flickery
    if (abs <= epsilon) {
      return `<div class="tip-delta neutral">= EU average</div>`;
    }

    const sign = diff > 0 ? '+' : '-';
    const txt = `${sign}${fmtValue(abs)} EU average`;
    const cls = diff > 0 ? 'positive' : 'negative';
    return `<div class="tip-delta ${cls}">${txt}</div>`;
  }

  // Build HTML for the on-map tooltip
  function tooltipHtml(props) {
    const name  = escapeHtml(nameFromProps(props, currentLevel));
    const label = measureNames[currentMeasure] || currentMeasure;
    const id    = idFromProps(props, currentLevel);
    const row   = (store[currentLevel] && store[currentLevel].dataById[id]) || {};
    const val   = row ? row[currentMeasure] : null;

    const spark = dotPlotSVG({
      min: plotMin, // updated for fixed dot plot range
      max: plotMax, // updated for fixed dot plot range
      mean: scaleMean,
      value: val,
      width: 140,
      height: 20,
      aria: 'Average vs selected value'
    });

    // Tooltip difference sentence
    const delta = deltaLine({ value: val, mean: scaleMean, epsilon: 0.5 });

    return (
      '<div class="tip-title">' + name + '</div>' +
      '<div class="tip-row">' +
        '<span class="tip-m">' + escapeHtml(label) + '</span>' +
        '<span class="tip-v">' + fmtValue(val) + '</span>' +
      '</div>' +
      spark +
      delta
    );
  }

  /* --- Cursor: flip a class on <body> so it wins everywhere --- */
  function setPageCursorClass(cls) {
    document.body.classList.remove('cursor-hover', 'cursor-click');
    if (cls) document.body.classList.add(cls);
  }

  /* Cursor class toggler */
  function setMapCursorClass(cls) {
    const el = map && (map.getContainer ? map.getContainer() : map && map._container);
    if (!el) return;
    el.classList.remove('cursor-hover', 'cursor-click');
    if (cls) el.classList.add(cls);
  }

  function updateLegend() {
    const el = document.getElementById('legend'); if (!el) return;
    const swatches = palette.map(c => '<div class="legend__swatch" style="background:' + c + '"></div>').join('');
    el.innerHTML =
      '<div class="legend__title">' + (measureNames[currentMeasure] || currentMeasure) + '</div>' +
      '<div class="legend__row">' +
        '<span class="legend__value">' + fmtValue(scaleMin) + '</span>' +
        '<div class="legend__scale">' + swatches + '</div>' +
        '<span class="legend__value">' + fmtValue(scaleMax) + '</span>' +
      '</div>';
  }

  /* ================================
     Hover panel
     ================================ */
  function updateHoverInfo(props) {
    // Look up the element every time to avoid Temporal Dead Zone issues
    const hoverInfoEl = document.getElementById('hover-info');
    if (!hoverInfoEl) return;

    if (!props) {
      hoverInfoEl.textContent = 'Hover over a region';
      return;
    }

    const S = store[currentLevel];
    const id = idFromProps(props, currentLevel);
    const row = S.dataById[id];
    const label = nameFromProps(props, currentLevel);

    const fv  = row ? row.forgottenVoters  : null;
    const wtp = row ? row.willingnessPay   : null;
    const res = row ? row.renewableSupport : null;

    hoverInfoEl.innerHTML =
      '<strong class="region-name">' + escapeHtml(label) + '</strong><br/>' +
      measureNames.forgottenVoters + ': ' + fmtValue(fv)  + '<br/>' +
      measureNames.willingnessPay  + ': ' + fmtValue(wtp) + '<br/>' +
      measureNames.renewableSupport+ ': ' + fmtValue(res);
  }

  /* ================================
     Search helpers
     ================================ */
  // Replace the whole function with this:
  function positionDropdown(inputEl, dropdownEl, opts) {
    opts = opts || {};
    const gap = opts.gap || 6, maxHeight = opts.maxHeight || 240;
    const r = inputEl.getBoundingClientRect();

    // For fixed positioning, left/top are already viewport-relative.
    dropdownEl.style.position = 'fixed';
    dropdownEl.style.width = r.width + 'px';
    dropdownEl.style.left  = r.left + 'px';
    dropdownEl.style.display = 'block';

    const spaceAbove = r.top;
    const spaceBelow = window.innerHeight - r.bottom;
    const placeBelow = spaceBelow >= spaceAbove;

    if (placeBelow) {
      dropdownEl.style.top    = (r.bottom + gap) + 'px';
      dropdownEl.style.bottom = '';
      dropdownEl.style.maxHeight = Math.min(maxHeight, spaceBelow - gap) + 'px';
    } else {
      dropdownEl.style.top    = '';
      dropdownEl.style.bottom = (window.innerHeight - r.top + gap) + 'px';
      dropdownEl.style.maxHeight = Math.min(maxHeight, spaceAbove - gap) + 'px';
    }
  }

  function showAC(items) {
    if (!ac) return;
    if (!items.length) { ac.style.display = 'none'; return; }
    ac.innerHTML = items.map(function(n,i){ return '<div role="option" data-i="' + i + '">' + escapeHtml(n) + '</div>'; }).join('');
    ac.style.display = 'block';
    positionDropdown(searchInput, ac, { gap: 8, maxHeight: 240 });
  }

  function chooseACByName(name) {
    if (searchInput) searchInput.value = name;
    if (ac) ac.style.display = 'none';
    resetAllHighlights();     // Clear any soft highlights from the autocomplete filtering
    const layer = regionLayerMap[name];
    if (!layer) return;
    if (layer.getBounds) {
      const b = layer.getBounds();
      if (b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.6));
    }
    highlightLayer(layer); // Now highlight only the chosen layer
    const props = layer.feature && layer.feature.properties ? layer.feature.properties : {};
    updateHoverInfo(props);
    // Soft reset on next interaction
    layer.once && layer.once('mouseout', function () { if (geojsonLayer) geojsonLayer.resetStyle(layer); updateHoverInfo(); });
    map.once && map.once('click', function () { if (geojsonLayer) geojsonLayer.resetStyle(layer); updateHoverInfo(); });
  }

  /* ================================
     Select enhancer (kept)
     ================================ */
  function enhanceSelect(select) {
    select.style.position = 'absolute';
    select.style.opacity = '0';
    select.style.pointerEvents = 'none';
    select.style.height = '0';
    select.style.width = '0';

    const wrapper = document.createElement('div');
    wrapper.className = 'map-select';
    wrapper.setAttribute('data-for', select.id || '');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'map-select__toggle';
    toggle.textContent = (select.options[select.selectedIndex] && select.options[select.selectedIndex].text) || 'Select';

    const chevron = document.createElement('span');
    chevron.className = 'map-select__chevron';
    chevron.innerHTML = '&#9662;';

    const menu = document.createElement('div');
    menu.className = 'map-select__menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', select.getAttribute('aria-label') || 'Options');

    function rebuildMenu() {
      menu.innerHTML = '';
      Array.prototype.forEach.call(select.options, function (opt, i) {
        const item = document.createElement('div');
        item.className = 'map-select__option';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.textContent = opt.text;
        if (i === select.selectedIndex) item.setAttribute('aria-selected', 'true');
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          Array.prototype.forEach.call(menu.children, function (el) { el.removeAttribute('aria-selected'); });
          item.setAttribute('aria-selected', 'true');
          toggle.textContent = opt.text;
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          wrapper.classList.remove('open');
        });
        menu.appendChild(item);
      });
    }
    rebuildMenu();

    toggle.addEventListener('click', function () { wrapper.classList.toggle('open'); });
    document.addEventListener('click', function (e) { if (!wrapper.contains(e.target)) wrapper.classList.remove('open'); });

    let idx = select.selectedIndex;
    toggle.addEventListener('keydown', function (e) {
      const items = Array.prototype.slice.call(menu.children);
      if (e.key === 'ArrowDown') {
        e.preventDefault(); wrapper.classList.add('open');
        idx = Math.min(idx + 1, items.length - 1);
        items.forEach(function(el){ el.removeAttribute('aria-selected'); });
        items[idx].setAttribute('aria-selected', 'true');
        items[idx].scrollIntoView && items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); wrapper.classList.add('open');
        idx = Math.max(idx - 1, 0);
        items.forEach(function(el){ el.removeAttribute('aria-selected'); });
        items[idx].setAttribute('aria-selected', 'true');
        items[idx].scrollIntoView && items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (wrapper.classList.contains('open')) {
          items[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        } else {
          wrapper.classList.add('open');
        }
      } else if (e.key === 'Escape') {
        wrapper.classList.remove('open');
      }
    });

    select.parentNode.insertBefore(wrapper, select.nextSibling);
    wrapper.appendChild(toggle);
    wrapper.appendChild(chevron);
    wrapper.appendChild(menu);

    return { wrapper: wrapper, toggle: toggle, menu: menu, rebuildMenu: rebuildMenu };
  }

  /* ================================
     Zoom + Home controls (kept)
     ================================ */
  function addZoomHomeButtons() {
    const ZoomHome = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control zoom-home');
        function mkBtn(html, title, cls, onClick) {
          const a = L.DomUtil.create('a', cls, container);
          a.href = '#'; a.title = title; a.innerHTML = html;
          L.DomEvent.on(a, 'click', L.DomEvent.stop)
                    .on(a, 'click', onClick, this)
                    .on(a, 'dblclick', L.DomEvent.stop);
          return a;
        }
        mkBtn('+', 'Zoom in', 'zoom-in-btn', function(){ map.zoomIn(); });
        mkBtn('−', 'Zoom out', 'zoom-out-btn', function(){ map.zoomOut(); });
        mkBtn(
          '<img src="assets/icons/Homeicon.svg" alt="" class="zh-icon" />',
          'Reset view',
          'leaflet-control-zoom-home',
          () => {
            if (!initialBounds || !initialBounds.isValid || !initialBounds.isValid()) return;
            map.fitBounds(initialBounds.pad(0.04), { animate: false });
          }
        );
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        return container;
      }
    });
    map.addControl(new ZoomHome());
  }

  /* ================================
     Bounds helpers & zoom to selection
     ================================ */
  function getLayerBounds(layer) {
    if (!layer) return null;
    let agg = null;
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer(function (l) {
        if (l && typeof l.getBounds === 'function') {
          const b = l.getBounds();
          if (b && b.isValid && b.isValid()) {
            if (!agg) agg = L.latLngBounds(b.getSouthWest(), b.getNorthEast());
            else agg.extend(b);
          }
        }
      });
    }
    if (!agg && layer && typeof layer.getBounds === 'function') {
      const b = layer.getBounds();
      if (b && b.isValid && b.isValid()) agg = L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    }
    return agg;
  }

  function zoomToCurrentFilter() {
    if (!map) return;
    if (window.__DASH_DID_PREFIT__){
    window.__DASH_DID_PREFIT__ = false;
    return;
    }
    const target = (currentCountry === '__all__') ? initialBounds : getLayerBounds(geojsonLayer);
    if (!target || !target.isValid || !target.isValid()) return;
    const padded = target.pad(currentCountry === '__all__' ? 0.04 : 0.06);
    map.invalidateSize();
    map.fitBounds(padded, { padding: [28, 28], animate: false });
  }

  /* ================================
     Highlight helpers
     ================================ */
  function highlightLayer(layer) {
    layer.setStyle({ weight: 0.7, color: '#A1FCC2', fillOpacity: 1 });
    layer.bringToFront && layer.bringToFront();
  }

  function resetAllHighlights() {
    if (!geojsonLayer) return;
    geojsonLayer.eachLayer(function (lyr) {
      if (typeof style === 'function') {
        lyr.setStyle(style(lyr.feature));
      } else {
        // fallback close to your defaults
        lyr.setStyle({ weight: 0.7, color: '#2A192C', fillOpacity: 0.9 });
      }
    });
  }

  /* ================================
     Misc
     ================================ */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function syncWrappedSelectLabel(select) {
    const wrapper = document.querySelector('.map-select[data-for="' + (select.id || '') + '"]');
    if (!wrapper) return;
    const toggle = wrapper.querySelector('.map-select__toggle');
    const menu   = wrapper.querySelector('.map-select__menu');
    const text = (select.options[select.selectedIndex] || {}).text || '';
    if (toggle) toggle.textContent = text;
    if (menu) {
      Array.prototype.forEach.call(menu.children, el => el.removeAttribute('aria-selected'));
      const active = Array.prototype.find.call(menu.children, el => el.dataset.value === select.value);
      if (active) active.setAttribute('aria-selected', 'true');
    }
  }
})();

/* ================================
   Responsive: bottom sheet + scope to map section
   ================================ */
(function wireResponsiveShell(){
  const app    = document.querySelector('.map-app');
  const btn    = document.getElementById('panel-toggle');
  const panel  = document.getElementById('side-panel');
  // Use the grid section if present; otherwise the map container; otherwise the app
  const target = document.querySelector('.dash-grid') || document.querySelector('.map-wrap') || app;

  // Local debounce so we don't depend on anything else
  function debounce(fn, wait){
    let t; 
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  }

  function safeInvalidate(){
    // 'map' is defined earlier in your file
    if (typeof map !== 'undefined' && map && map.invalidateSize) map.invalidateSize();
  }

  // Toggle the bottom sheet on small screens
  if (btn && app) {
    btn.addEventListener('click', () => {
      const open = !app.classList.contains('panel-open');
      app.classList.toggle('panel-open', open);
      btn.setAttribute('aria-expanded', String(open));
      if (panel) {
        panel.addEventListener('transitionend', safeInvalidate, { once: true });
      } else {
        setTimeout(safeInvalidate, 260);
      }
    });
  }

  // Maintain crisp tiles on viewport changes
  window.addEventListener('resize', debounce(safeInvalidate, 150), { passive: true });

  // --- Keep .in-view accurate (IO + scroll/resize fallback) ---
  function computeInView(){
    if (!target || !app) return;
    const r = target.getBoundingClientRect();
    // visible if at least ~15% of the map section is on screen
    const visible = (r.bottom > window.innerHeight * 0.15) && (r.top < window.innerHeight * 0.85);
    app.classList.toggle('in-view', !!visible);
    if (!visible && app.classList.contains('panel-open')) {
      app.classList.remove('panel-open');
      btn && btn.setAttribute('aria-expanded', 'false');
      safeInvalidate();
    }
  }

  // Try IntersectionObserver first
  if (target && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => {
      const visible = entry && entry.isIntersecting;
      app && app.classList.toggle('in-view', !!visible);
      if (!visible && app && app.classList.contains('panel-open')) {
        app.classList.remove('panel-open');
        btn && btn.setAttribute('aria-expanded', 'false');
        safeInvalidate();
      }
    }, { threshold: 0.15 });
    io.observe(target);
  }

  // Always run the fallback too (covers edge cases and older browsers)
  computeInView();
  window.addEventListener('scroll', debounce(computeInView, 100), { passive: true });
  window.addEventListener('resize', debounce(computeInView, 100), { passive: true });
})();