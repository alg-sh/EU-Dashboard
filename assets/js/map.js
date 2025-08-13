(() => {
  'use strict';

  /* ================================
     Constants & utils
     ================================ */
  const DATA_PATH = 'assets/data/';   // change in one place if folder moves
  const FILES = {
    countries: DATA_PATH + 'world-countries.json',
    geojson:   DATA_PATH + 'nuts3-copy.geojson',
    csv:       DATA_PATH + 'nuts3-data.csv'
  };

  // Small utility: parse floats or return null (avoids NaN everywhere)
  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : null;
  };

  // Debounce helper to avoid work on every keystroke
  const debounce = (fn, ms = 120) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  /* ================================
     Map init
     ================================ */
  const map = L.map('map', {
    center: [52, 10],
    zoom: 4,
    minZoom: 3,
    maxZoom: 10,
    attributionControl: false,
    zoomControl: false   // we mount our own zoom/home
  });

  /* ================================
     Countries silhouette background
     (defensive fetch with error messaging)
     ================================ */
  (async function addCountriesSilhouette() {
    try {
      const pane = 'countriesPane';
      if (!map.getPane(pane)) map.createPane(pane);
      const p = map.getPane(pane);
      p.style.zIndex = 300;             // below NUTS3 overlay (z=400)
      p.style.pointerEvents = 'none';   // non-interactive

      const res = await fetch(FILES.countries, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`countries fetch failed: ${res.status}`);
      const world = await res.json();

      L.geoJson(world, {
        pane,
        interactive: false,
        style: { fillColor: '#361F38', fillOpacity: 1, color: '#361F38', weight: 0, opacity: 1 }
      }).addTo(map);
    } catch (err) {
      console.error('Countries silhouette failed:', err);
      // Optional: show a non-blocking message; the app still works without it
    }
  })();

  /* ================================
     Choropleth config
     ================================ */
  const palette = ['#cde2e2', '#82b6b6', '#307c7b', '#004141'];
  const measureNames = {
    forgottenVoters: 'Forgotten Voters Share',
    willingnessPay:  'Willingness to Pay for Climate Action',
    renewableSupport:'Renewable Energy Support'
  };

  let currentMeasure = 'forgottenVoters';
  let geojsonLayer;
  const dummyData = Object.create(null);
  const regionLayerMap = Object.create(null);
  let allRegionNames = [];

  // Get choropleth color by value (clamped)
  function getColor(value) {
    if (value === undefined || value === null || isNaN(value)) return '#444';
    const min = 20, max = 90;
    const v = Math.min(Math.max(value, min), max);
    const step = (max - min) / palette.length;
    const idx = Math.min(Math.floor((v - min) / step), palette.length - 1);
    return palette[idx];
  }

  // Base style for regions (non-hover)
  function style(feature) {
    const nutsId = feature.properties.NUTS_ID;
    const val = dummyData[nutsId] ? dummyData[nutsId][currentMeasure] : undefined;
    return { fillColor: getColor(val), weight: 0.7, opacity: 1, color: '#2A192C', fillOpacity: 0.9 };
  }

  /* ================================
     Info box (top-right)
     - Adds ARIA so screen readers announce updates
     ================================ */
  const info = L.control({ position: 'topright' });
  info.onAdd = function () {
    this._div = L.DomUtil.create('div', 'info');
    // ARIA live region for dynamic content
    this._div.setAttribute('role', 'status');
    this._div.setAttribute('aria-live', 'polite');
    this.update();
    return this._div;
  };
  info.update = function (props) {
    if (props) {
      const nutsId = props.NUTS_ID;
      const val = dummyData[nutsId] ? dummyData[nutsId][currentMeasure] : undefined;
      this._div.innerHTML =
        `<strong class="region-name">${props.NUTS_NAME || props.NUTS_ID}</strong><br/>` +
        `${measureNames[currentMeasure]}: ${val !== undefined && val !== null ? val + '%' : 'N/A'}`;
    } else {
      this._div.textContent = 'Hover over a region';
    }
  };
  info.addTo(map);

  // Hover helpers
  function highlightLayer(layer) {
    layer.setStyle({ weight: 0.7, color: '#A1FCC2', fillOpacity: 1 });
    layer.bringToFront();
  }
  function dimLayer(layer) { layer.setStyle({ weight: 0.5, color: '#555', fillOpacity: 0.2 }); }
  function resetAllHighlights() { if (geojsonLayer) geojsonLayer.setStyle(style); }

  // Feature events
  function onEachFeature(feature, layer) {
    const name = feature.properties.NUTS_NAME;
    if (name) regionLayerMap[name] = layer;
    layer.on({
      mouseover: (e) => { highlightLayer(e.target); info.update(e.target.feature.properties); },
      mouseout:  () => { resetAllHighlights(); info.update(); }
    });
  }

  /* ================================
     Title: update dynamically from state
     ================================ 
  function updateMapTitle() {
   const el = document.getElementById('map-title');
    if (!el) return;
    const base = measureNames[currentMeasure] || '';
    el.textContent = base.endsWith('%)') ? base : `${base} (%)`;
  }
  */

  /* ================================
     Load CSV + GeoJSON (defensive)
     ================================ */
  // CSV first → build dummyData → then GeoJSON for shapes
  Papa.parse(FILES.csv, {
    download: true,
    header: true,
    error: (err) => {
      console.error('CSV parse failed:', err);
      alert('Failed to load data. Please try again later.');
    },
    complete: function (results) {
      try {
        results.data.forEach(row => {
          if (row && row.NUTS_ID) {
            dummyData[row.NUTS_ID] = {
              forgottenVoters: num(row.forgottenVoters),
              willingnessPay:  num(row.willingnessPay),
              renewableSupport:num(row.renewableSupport)
            };
          }
        });
      } catch (e) {
        console.error('CSV processing error:', e);
      }
      loadGeoJSON();
    }
  });

  function loadGeoJSON() {
    fetch(FILES.geojson, { credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error(`GeoJSON fetch failed: ${res.status}`);
        return res.json();
      })
      .then(data => {
        geojsonLayer = L.geoJson(data, { style, onEachFeature }).addTo(map);
        allRegionNames = data.features.map(f => f.properties.NUTS_NAME).filter(Boolean);
        // updateMapTitle(); // set title after data is ready
      })
      .catch(err => {
        console.error(err);
        alert('Failed to load map regions. Please try again later.');
      });
  }

  /* ================================
     Search autocomplete (custom)
     - debounced filtering
     - keyboard navigation
     ================================ */
  const searchInput = document.getElementById('region-search');
  const ac = document.getElementById('region-ac');
  let acIndex = -1;

  function showAC(items) {
    if (!items.length) { ac.style.display = 'none'; return; }
    ac.innerHTML = items.map((n,i)=>`<div role="option" data-i="${i}">${n}</div>`).join('');
    // Resize to match input width precisely (safer than fixed width)
    const r = searchInput.getBoundingClientRect();
    ac.style.width = r.width + 'px';
    ac.style.left  = r.left + window.scrollX + 'px';
    // Position above input (absolute in viewport)
    const inputBottom = r.top + window.scrollY + r.height;
    ac.style.bottom = (window.innerHeight - inputBottom + 10) + 'px';
    ac.style.display = 'block';
    acIndex = -1;
  }

  const filterAC = debounce((term) => {
    const t = term.trim().toLowerCase();
    if (!t) { ac.style.display = 'none'; resetAllHighlights(); return; }
    const matches = allRegionNames.filter(n => n.toLowerCase().includes(t)).slice(0, 50);
    showAC(matches);
    // Visual cue on the map
    allRegionNames.forEach(name => {
      const layer = regionLayerMap[name];
      if (!layer) return;
      if (matches.includes(name)) highlightLayer(layer); else dimLayer(layer);
    });
  }, 80);

  function chooseACByName(name) {
    searchInput.value = name;
    ac.style.display = 'none';
    const layer = regionLayerMap[name];
    if (layer) {
      map.fitBounds(layer.getBounds());
      highlightLayer(layer);
      layer.once('mouseout', () => { geojsonLayer.resetStyle(layer); info.update(); });
    }
  }

  searchInput.addEventListener('input', (e) => filterAC(e.target.value));
  ac.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-i]'); if (!item) return;
    chooseACByName(item.textContent);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (ac.style.display !== 'block') return;
    const items = Array.from(ac.children);
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); }
    else if (e.key === 'Enter') { if (acIndex >= 0) { e.preventDefault(); chooseACByName(items[acIndex].textContent); } return; }
    else if (e.key === 'Escape') { ac.style.display = 'none'; resetAllHighlights(); return; } else { return; }
    items.forEach((el, i) => el.setAttribute('aria-selected', i === acIndex ? 'true' : 'false'));
    if (items[acIndex]) items[acIndex].scrollIntoView({ block: 'nearest' });
  });
  // Hide when clicking away
  document.addEventListener('click', (e) => { if (!ac.contains(e.target) && e.target !== searchInput) ac.style.display = 'none'; });
  // Reposition on resize (keeps width aligned with input)
  window.addEventListener('resize', () => { if (ac.style.display === 'block') showAC(Array.from(ac.children).map(d => d.textContent)); });

  /* ================================
     Custom Select enhancer (consistent dropdown)
     ================================ */
  function enhanceSelect(select) {
    // Hide the native select visually but keep semantics (form, a11y)
    select.style.position = 'absolute';
    select.style.opacity = '0';
    select.style.pointerEvents = 'none';
    select.style.height = '0';
    select.style.width = '0';

    // Build custom UI
    const wrapper = document.createElement('div'); wrapper.className = 'map-select';
    wrapper.setAttribute('data-for', select.id || '');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'map-select__toggle';
    toggle.textContent = select.options[select.selectedIndex]?.text || 'Select';
    const chevron = document.createElement('span'); chevron.className = 'map-select__chevron'; chevron.innerHTML = '&#9662;';
    const menu = document.createElement('div'); menu.className = 'map-select__menu'; menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', select.getAttribute('aria-label') || 'Options');

    // Options → mirror native select
    Array.from(select.options).forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'map-select__option';
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      item.textContent = opt.text;
      if (i === select.selectedIndex) item.setAttribute('aria-selected', 'true');

      // mousedown selects before focus leaves button (feels snappier)
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Update custom UI
        Array.from(menu.children).forEach(el => el.removeAttribute('aria-selected'));
        item.setAttribute('aria-selected', 'true');
        toggle.textContent = opt.text;
        // Update native select value + fire change for app logic
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // Close
        wrapper.classList.remove('open');
      });
      menu.appendChild(item);
    });

    // Toggle open/close
    toggle.addEventListener('click', () => { wrapper.classList.toggle('open'); });
    // Close on outside click
    document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) wrapper.classList.remove('open'); });

    // Keyboard support (basic and predictable)
    let idx = select.selectedIndex;
    toggle.addEventListener('keydown', (e) => {
      const items = Array.from(menu.children);
      if (e.key === 'ArrowDown') {
        e.preventDefault(); wrapper.classList.add('open');
        idx = Math.min(idx + 1, items.length - 1);
        items.forEach(el => el.removeAttribute('aria-selected'));
        items[idx].setAttribute('aria-selected', 'true');
        items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); wrapper.classList.add('open');
        idx = Math.max(idx - 1, 0);
        items.forEach(el => el.removeAttribute('aria-selected'));
        items[idx].setAttribute('aria-selected', 'true');
        items[idx].scrollIntoView({ block: 'nearest' });
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

    // Insert after the select
    select.parentNode.insertBefore(wrapper, select.nextSibling);
    wrapper.appendChild(toggle);
    wrapper.appendChild(chevron);
    wrapper.appendChild(menu);

    return { wrapper, toggle, menu };
  }

  // Enhance all selects you flag
  document.querySelectorAll('select.js-map-select').forEach(enhanceSelect);

  /* ================================
     Measure selector behavior
     ================================ */
  document.getElementById('measure-select').addEventListener('change', (e) => {
    currentMeasure = e.target.value;
    if (geojsonLayer) geojsonLayer.setStyle(style);
    info.update();
    updateMapTitle();
  });

  // Initial title once ready
  updateMapTitle();

  /* ================================
     Combined Zoom + Home (bottom-right)
     ================================ */
  const ZoomHomeControl = L.Control.extend({
    options: { position: 'bottomright', homeView: { center: [52, 10], zoom: 4 } },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control zoom-home');
      const mkBtn = (html, title, className, onClick) => {
        const a = L.DomUtil.create('a', className, container);
        a.href = '#'; a.title = title; a.innerHTML = html;
        L.DomEvent.on(a, 'click', L.DomEvent.stop)
                  .on(a, 'click', onClick, this)
                  .on(a, 'dblclick', L.DomEvent.stop);
        return a;
      };
      mkBtn('+', 'Zoom in', 'zoom-in-btn', () => map.zoomIn());
      mkBtn('−', 'Zoom out', 'zoom-out-btn', () => map.zoomOut());
      mkBtn(
        '<span class="home" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="currentColor"/></svg></span>',
        'Reset map view',
        'home-btn',
        () => {
          map.setView(this.options.homeView.center, this.options.homeView.zoom);
          if (typeof resetAllHighlights === 'function') resetAllHighlights();
          if (typeof info?.update === 'function') info.update();
        }
      );
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    }
  });
  map.addControl(new ZoomHomeControl({ position: 'bottomright', homeView: { center: [52, 10], zoom: 4 } }));

})();
