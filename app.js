// ParkPath SG Core HUD Controller (app.js)

// 1. Projection Definitions (SVY21 to WGS84 mapping coordinates)
proj4.defs('EPSG:3414', '+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 +k=1 +x_0=28001.642 +y_0=38744.572 +ellps=WGS84 +units=m +no_defs');

function svy21ToWgs84(x, y) {
  const [lon, lat] = proj4('EPSG:3414', 'EPSG:4326', [x, y]);
  return { lat, lon };
}

// 2. State Variables
let map = null;
let carparksDb = []; // Static HDB database
let activeMarkers = []; // Leaflet markers layer
let activeWalkingLine = null; // Polyline showing walk route
let activeDestination = null; // { lat, lon, name }
let activeDestinationMarker = null; // Red pin for destination
let selectedCarpark = null; // Currently clicked carpark
let currentFilter = 'score'; // 'score' | 'lots' | 'distance'
let searchDebounceTimer = null;

// 3. Page Lifecycle Initialization
document.addEventListener('DOMContentLoaded', () => {
  initLiveClock();
  initMap();
  loadCarparkDatabase();
  setupUIEventListeners();
});

// HUD Clock Tick
function initLiveClock() {
  const clockEl = document.getElementById('live-clock');
  setInterval(() => {
    const now = new Date();
    clockEl.textContent = now.toTimeString().split(' ')[0];
  }, 1000);
}

// Leaflet Map Handshake with OneMap SG Night theme tiles
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    maxZoom: 19,
    minZoom: 11
  }).setView([1.3521, 103.8198], 12); // Center of Singapore

  L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Night/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: 'Map data &copy; <a href="https://www.onemap.gov.sg/" target="_blank">OneMap Singapore</a> | SLA'
  }).addTo(map);
}

// Load HDB dataset and pre-convert coordinates
async function loadCarparkDatabase() {
  try {
    const listEl = document.getElementById('carparks-list');
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚡</span>
        <p style="color:var(--accent-cyan)">Syncing HDB coordinates database...</p>
      </div>
    `;

    const response = await fetch('carparks_db.json');
    const data = await response.json();

    // Map and pre-convert SVY21 coordinate points to WGS84 for zero lag at runtime
    carparksDb = data.map(cp => {
      const coords = svy21ToWgs84(cp.x, cp.y);
      return {
        ...cp,
        lat: coords.lat,
        lon: coords.lon
      };
    });

    console.log(`📦 Loaded and geocoded ${carparksDb.length} local HDB carparks successfully!`);
    resetRecommendationsList();

  } catch (err) {
    console.error("Failed to load static HDB database:", err);
    document.getElementById('carparks-list').innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">❌</span>
        <p style="color:var(--accent-red)">Database initialization failed. Please reload.</p>
      </div>
    `;
  }
}

// Bind UI action listeners
function setupUIEventListeners() {
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  const closeDrawerBtn = document.getElementById('close-drawer-btn');
  const navigateBtn = document.getElementById('navigate-btn');
  const filterBtns = document.querySelectorAll('.results-filters .filter-btn');

  // Search input typing suggest triggers
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchDebounceTimer);

    if (query.length < 3) {
      hideSuggestions();
      return;
    }

    searchDebounceTimer = setTimeout(() => {
      fetchAddressSuggestions(query);
    }, 300);
  });

  // Clear search bar
  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    hideSuggestions();
    searchInput.focus();
  });

  // Hide suggestions if clicking outside search box
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-section')) {
      hideSuggestions();
    }
  });

  // Recommendations sorting filter buttons
  filterBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      filterBtns.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentFilter = e.target.getAttribute('data-filter');
      
      if (activeDestination) {
        processAndRenderParkingAvailability(activeDestination.lat, activeDestination.lon);
      }
    });
  });

  // Selected details drawer close
  closeDrawerBtn.addEventListener('click', () => {
    document.getElementById('detail-drawer').style.display = 'none';
    selectedCarpark = null;
    clearWalkingLine();
    
    // De-select active classes on recommendations list
    document.querySelectorAll('.carpark-card').forEach(card => card.classList.remove('selected'));
  });

  // Big Navigation driver handover trigger
  navigateBtn.addEventListener('click', () => {
    if (!selectedCarpark) return;
    
    // Hand over coordinates directly to native Google Maps
    const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${selectedCarpark.lat},${selectedCarpark.lon}&travelmode=driving`;
    window.open(navUrl, '_blank');
  });
}

// Fetch address coordinates search suggestions from OneMap SG API
async function fetchAddressSuggestions(query) {
  try {
    const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    const res = await fetch(url);
    const data = await res.json();
    
    const results = data.results || [];
    renderSuggestions(results);

  } catch (err) {
    console.error("OneMap Autocomplete search failed:", err);
  }
}

// Render search autocomplete options list
function renderSuggestions(results) {
  const dropdown = document.getElementById('suggest-list');
  dropdown.innerHTML = '';

  if (results.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  results.slice(0, 5).forEach(item => {
    const row = document.createElement('div');
    row.className = 'suggest-item';
    
    // Highlight first word or match
    const bName = item.BUILDING || item.ROAD || "Singapore Location";
    const bAddr = item.ADDRESS || "";

    row.innerHTML = `
      <span class="suggest-name">${bName}</span>
      <span class="suggest-address">${bAddr}</span>
    `;

    // Dropdown selection click
    row.addEventListener('click', () => {
      document.getElementById('search-input').value = bName;
      hideSuggestions();
      selectLocationDestination(parseFloat(item.LATITUDE), parseFloat(item.LONGITUDE), bName);
    });

    dropdown.appendChild(row);
  });

  dropdown.style.display = 'block';
}

function hideSuggestions() {
  document.getElementById('suggest-list').style.display = 'none';
}

// Route map viewport to destination coordinates
function selectLocationDestination(lat, lon, name) {
  activeDestination = { lat, lon, name };
  document.getElementById('detail-drawer').style.display = 'none';
  selectedCarpark = null;
  clearWalkingLine();

  // Draw custom pulsing neon destination marker on the map
  if (activeDestinationMarker) {
    map.removeLayer(activeDestinationMarker);
  }

  const destIcon = L.divIcon({
    className: 'destination-marker-icon',
    html: '<div class="pulse-ring"></div><div class="pin-dot">📍</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  activeDestinationMarker = L.marker([lat, lon], { icon: destIcon }).addTo(map);
  
  // Slide viewport and zoom
  map.setView([lat, lon], 16);

  // Scan for surrounding car parks
  processAndRenderParkingAvailability(lat, lon);
}

// Scan database, query live HDB lot feeds, sort, and plot
async function processAndRenderParkingAvailability(lat, lon) {
  const listEl = document.getElementById('carparks-list');
  listEl.innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">📡</span>
      <p style="color:var(--accent-cyan)">Querying live parking availability...</p>
    </div>
  `;

  // 1. Calculate walking distance to all ~2,265 carparks and filter within 400m radius
  const nearby = carparksDb.map(cp => {
    const dist = calculateHaversineDistance(lat, lon, cp.lat, cp.lon);
    return {
      ...cp,
      distance: Math.round(dist) // in meters
    };
  }).filter(cp => cp.distance <= 400);

  if (nearby.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📭</span>
        <p>No HDB EPS carparks detected within 400m. Expand search or try another location!</p>
      </div>
    `;
    clearActiveCarparkMarkers();
    return;
  }

  // 2. Fetch live lot availability from data.gov.sg API
  let liveLotsLookup = {};
  try {
    const response = await fetch('https://api.data.gov.sg/v1/transport/carpark-availability');
    const data = await response.json();
    
    const carparkData = data.items[0]?.carpark_data || [];
    carparkData.forEach(item => {
      const info = item.carpark_info[0] || {};
      liveLotsLookup[item.carpark_number] = {
        available: parseInt(info.lots_available) || 0,
        total: parseInt(info.total_lots) || 0
      };
    });
  } catch (err) {
    console.warn("Real-time lot availability API failed, falling back to static database:", err);
  }

  // 3. Join live lots data and calculate recommendation scores
  nearby.forEach(cp => {
    const live = liveLotsLookup[cp.no];
    if (live) {
      cp.lotsAvailable = live.available;
      cp.lotsTotal = live.total;
    } else {
      cp.lotsAvailable = 0; // Default if not found in live feed
      cp.lotsTotal = 100;
    }

    // Smart Score Calculation
    // Distance Weight (40%): Linear drop up to 400m
    const distanceScore = 1.0 - (cp.distance / 400);
    // Availability Weight (40%): Ideal lot count is 25+ vacant spots
    const availabilityScore = Math.min(1.0, cp.lotsAvailable / 25);
    // Free Parking Weight (20%): Bonus if not NO
    const freeParkingBonus = cp.free.toUpperCase() !== 'NO' ? 1.0 : 0.0;

    cp.score = (distanceScore * 0.4) + (availabilityScore * 0.4) + (freeParkingBonus * 0.2);
  });

  // 4. Sort based on active HUD filter tab
  if (currentFilter === 'score') {
    nearby.sort((a, b) => b.score - a.score);
  } else if (currentFilter === 'lots') {
    nearby.sort((a, b) => b.lotsAvailable - a.lotsAvailable);
  } else if (currentFilter === 'distance') {
    nearby.sort((a, b) => a.distance - b.distance);
  }

  // 5. Render side HUD list
  renderCarparksList(nearby);

  // 6. Plot dynamic map pins
  plotCarparkMarkersOnMap(nearby);
}

// Render recommendations side card cards
function renderCarparksList(carparks) {
  const listEl = document.getElementById('carparks-list');
  listEl.innerHTML = '';

  carparks.forEach(cp => {
    const card = document.createElement('div');
    card.className = `carpark-card ${selectedCarpark && selectedCarpark.no === cp.no ? 'selected' : ''}`;
    card.setAttribute('data-no', cp.no);

    // Color-code availability
    let statusClass = 'plenty';
    if (cp.lotsAvailable === 0) statusClass = 'full';
    else if (cp.lotsAvailable < 8) statusClass = 'tight';

    // Format free parking pill
    const hasFree = cp.free.toUpperCase() !== 'NO';
    const freeTextHtml = hasFree ? `<span class="cp-meta-item free-parking">🎁 Free Parking</span>` : '';

    card.innerHTML = `
      <div class="cp-left">
        <div class="cp-title-row">
          <span class="cp-no">${cp.no}</span>
          <span class="cp-address" title="${cp.addr}">${cp.addr}</span>
        </div>
        <div class="cp-meta-row">
          <span class="cp-meta-item">🚶 ${cp.distance}m</span>
          <span class="cp-meta-item">📏 ${cp.h}m limit</span>
          ${freeTextHtml}
        </div>
      </div>
      <div class="cp-badge ${statusClass}">
        <span class="lots-num">${cp.lotsAvailable}</span>
        <span class="lots-label">LOTS LEFT</span>
      </div>
    `;

    // Recommendations click handler
    card.addEventListener('click', () => {
      highlightAndSelectCarpark(cp);
    });

    listEl.appendChild(card);
  });
}

// Plot custom live lot maps pins
function plotCarparkMarkersOnMap(carparks) {
  clearActiveCarparkMarkers();

  carparks.forEach(cp => {
    // Custom color-coded lot badge markers
    let statusClass = 'plenty';
    if (cp.lotsAvailable === 0) statusClass = 'full';
    else if (cp.lotsAvailable < 8) statusClass = 'tight';

    const customMarkerIcon = L.divIcon({
      className: `custom-lot-icon ${statusClass}`,
      html: `<span>${cp.lotsAvailable}</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const marker = L.marker([cp.lat, cp.lon], { icon: customMarkerIcon }).addTo(map);
    
    // Popup descriptions
    marker.bindPopup(`
      <h4>${cp.addr}</h4>
      <p>
        <strong>Carpark No:</strong> ${cp.no}<br>
        <strong>Lots Available:</strong> ${cp.lotsAvailable} / ${cp.lotsTotal}<br>
        <strong>Free Parking:</strong> ${cp.free}<br>
        <strong>Walking distance:</strong> ${cp.distance}m
      </p>
    `);

    // Click marker opens drawer and draws walk line
    marker.on('click', () => {
      highlightAndSelectCarpark(cp);
    });

    activeMarkers.push(marker);
  });
}

// Triggers selected state HUD updates and polyline walk path overlays
function highlightAndSelectCarpark(cp) {
  selectedCarpark = cp;

  // 1. Highlight clicked card in recommendations list
  document.querySelectorAll('.carpark-card').forEach(card => {
    card.classList.remove('selected');
    if (card.getAttribute('data-no') === cp.no) {
      card.classList.add('selected');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  // 2. Center map between carpark and destination
  if (activeDestination) {
    const bounds = L.latLngBounds(
      [activeDestination.lat, activeDestination.lon],
      [cp.lat, cp.lon]
    );
    map.fitBounds(bounds, { padding: [60, 60] });

    // Draw high-contrast dotted walk path overlay
    clearWalkingLine();
    activeWalkingLine = L.polyline([[cp.lat, cp.lon], [activeDestination.lat, activeDestination.lon]], {
      color: '#00f2fe',
      dashArray: '4, 10',
      weight: 3,
      opacity: 0.85
    }).addTo(map);
  }

  // 3. Open selected drawer details
  const drawer = document.getElementById('detail-drawer');
  document.getElementById('drawer-no').textContent = cp.no;
  document.getElementById('drawer-address').textContent = cp.addr;
  document.getElementById('drawer-lots').textContent = `${cp.lotsAvailable} / ${cp.lotsTotal}`;
  document.getElementById('drawer-distance').textContent = `${cp.distance}m`;
  document.getElementById('drawer-system').textContent = cp.sys;
  document.getElementById('drawer-height').textContent = `${cp.h}m`;
  document.getElementById('drawer-free').textContent = cp.free;

  // Visual lot capacity badge details
  const lotsBox = document.getElementById('drawer-lots');
  lotsBox.style.color = 'var(--accent-green)';
  if (cp.lotsAvailable === 0) lotsBox.style.color = 'var(--accent-red)';
  else if (cp.lotsAvailable < 8) lotsBox.style.color = 'var(--accent-amber)';

  drawer.style.display = 'block';
}

// Reset recommendation list to helper placeholder
function resetRecommendationsList() {
  const listEl = document.getElementById('carparks-list');
  listEl.innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">🗺️</span>
      <p>Type a location to search for nearby parking and live availability.</p>
    </div>
  `;
}

// Helpers
function clearActiveCarparkMarkers() {
  activeMarkers.forEach(m => map.removeLayer(m));
  activeMarkers = [];
}

function clearWalkingLine() {
  if (activeWalkingLine) {
    map.removeLayer(activeWalkingLine);
    activeWalkingLine = null;
  }
}

// Haversine Formula for distance calculations in meters
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
            
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
