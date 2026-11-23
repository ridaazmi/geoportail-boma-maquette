/* Géoportail de Boma — maquette de démonstration
 * Front-end autonome (MapLibre GL JS). En production, les données et calculs
 * proviennent de l'API (Django/PostGIS) et des services OGC (GeoServer).
 */
(() => {
  'use strict';
  const D = window.BOMA;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const fmt = (v, d = 0) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };

  /* ------------------------------------------------------------------ données */
  const cells = D.grille.features;
  const LAT0 = (D.meta.bbox[1] + D.meta.bbox[3]) / 2;
  const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
  cells.forEach(c => {
    const r = c.geometry.coordinates[0];
    c.properties.cx = r.slice(0, 6).reduce((s, p) => s + p[0], 0) / 6;
    c.properties.cy = r.slice(0, 6).reduce((s, p) => s + p[1], 0) / 6;
  });
  const nearestCell = ll => {
    let best = null, bd = Infinity;
    for (const c of cells) {
      const d = dist(ll, [c.properties.cx, c.properties.cy]);
      if (d < bd) { bd = d; best = c; }
    }
    return { cell: best, d: bd };
  };
  const SECTORS = [...new Set(cells.map(c => c.properties.secteur))].sort((a, b) => a.localeCompare(b, 'fr'));

  // longueur + secteur des tronçons de voirie
  const lineLen = cs => cs.slice(1).reduce((s, p, i) => s + dist(cs[i], p), 0);
  D.voirie.features.forEach(f => {
    const cs = f.geometry.coordinates;
    f.properties.len_m = Math.round(lineLen(cs));
    const mid = cs[Math.floor(cs.length / 2)];
    f.properties.secteur = nearestCell(mid).cell.properties.secteur;
  });
  D.equipements.features.forEach(f => { f.properties.secteur = nearestCell(f.geometry.coordinates).cell.properties.secteur; });
  const PAVED = ['asphalt', 'paved', 'concrete', 'paving_stones', 'sett', 'cobblestone'];
  const UNPAVED = ['unpaved', 'ground', 'dirt', 'gravel', 'sand', 'earth', 'compacted', 'mud', 'fine_gravel'];
  const surfaceLabel = s => PAVED.includes(s) ? 'Revêtue' : UNPAVED.includes(s) ? 'Non revêtue' : 'Non renseigné';

  // état local (saisies, mises à jour, journal, scénarios)
  let saisies = LS.get('boma_saisies', []);
  let roadUpdates = LS.get('boma_voirie_maj', {});
  let journal = LS.get('boma_journal', []);
  let savedScenarios = LS.get('boma_scenarios', []);

  /* ------------------------------------------------------------------ profils */
  const ROLE_LABEL = { admin: 'Admin. Mairie', 'admin-anat': 'Admin. ANAT', reader: 'Partenaire' };
  let role = 'admin';
  const isAdmin = () => role !== 'reader';
  $('#role').addEventListener('change', e => {
    role = e.target.value;
    document.body.dataset.role = isAdmin() ? 'admin' : 'reader';
    popup.remove();
    setTimeout(() => map.resize(), 50);
    toast(isAdmin() ? `Connecté : ${ROLE_LABEL[role]} — édition autorisée` : 'Connecté : partenaire — lecture seule');
  });

  /* ------------------------------------------------------------------ carte */
  const BASEMAPS = {
    carto: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'], attribution: 'Fond © Esri, HERE, Garmin, © OpenStreetMap', maxzoom: 16 },
    osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© contributeurs OpenStreetMap' },
    sat: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics' },
  };
  const style = { version: 8, sources: {}, layers: [] };
  for (const [k, b] of Object.entries(BASEMAPS)) {
    style.sources['bm-' + k] = { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom || 19 };
    style.layers.push({ id: 'bm-' + k, type: 'raster', source: 'bm-' + k, layout: { visibility: k === 'carto' ? 'visible' : 'none' } });
  }
  const map = new maplibregl.Map({
    container: 'map', style, bounds: [[D.meta.bbox[0], D.meta.bbox[1]], [D.meta.bbox[2], D.meta.bbox[3]]],
    fitBoundsOptions: { padding: 20 }, preserveDrawingBuffer: true, attributionControl: { compact: true }, maxZoom: 19,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  const popup = new maplibregl.Popup({ maxWidth: '320px' });
  window.__map = map; // accès console (débogage)

  $$('#basemaps button').forEach(b => b.addEventListener('click', () => {
    $$('#basemaps button').forEach(x => x.classList.toggle('on', x === b));
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty('bm-' + k, 'visibility', k === b.dataset.bm ? 'visible' : 'none');
  }));

  /* ------------------------------------------------------------------ AMC */
  const P95 = (() => { const v = cells.map(c => c.properties.bati).sort((a, b) => a - b); return v[Math.floor(v.length * 0.95)] || 1; })();
  const CRITERIA = [
    { k: 'densite', label: 'Densité de population', cat: 'Social', tip: 'Nombre de bâtiments par maille de 4 ha (proxy de la population bénéficiaire ou exposée).', f: p => clamp(p.bati / P95) },
    { k: 'sante', label: 'Éloignement des soins', cat: 'Social · services', tip: 'Distance au centre de santé le plus proche (GRID3). 0 m → 0 ; 3 km et plus → 1.', f: p => clamp(p.d_sante / 3000) },
    { k: 'ecole', label: 'Éloignement des écoles', cat: 'Social · services', warn: true, tip: 'Données scolaires très incomplètes dans les sources ouvertes (4 écoles). Critère neutralisé par défaut : inventaire prévu en phase 2.', f: p => clamp(p.d_ecole / 3000) },
    { k: 'voirie', label: 'Enclavement', cat: 'Mobilité', tip: 'Distance à la voirie principale ou secondaire. 1 km et plus → zone enclavée (score 1).', f: p => clamp(p.d_voirie / 1000) },
    { k: 'inond', label: "Susceptibilité d'inondation", cat: 'Climat · risques', tip: "Proxy : altitude basse, proximité des cours d'eau, faible pente. Sera remplacé par la modélisation hydrologique du PDU.", f: p => p.inond },
    { k: 'erosion', label: "Risque d'érosion (pente)", cat: 'Environnement', tip: 'Pente moyenne de la maille (MNT SRTM). 3° → 0 ; 18° et plus → 1.', f: p => clamp((p.pente - 3) / 15) },
    { k: 'inclusion', label: 'Isolement piéton', cat: 'Genre · inclusion', tip: "Proxy : temps de marche vers les soins combiné à l'éloignement des axes desservis. Femmes, enfants, personnes âgées ou handicapées dépendent davantage de la marche. À affiner avec les enquêtes ménages désagrégées par sexe.", f: p => Math.sqrt(clamp(p.d_sante * 1.3 / 66.7 / 45) * clamp(p.d_voirie / 600)) },
  ];
  const SCENARIOS = {
    equip: { name: 'Équipements sociaux de proximité', desc: 'Où implanter en priorité de nouveaux centres de santé et équipements de proximité ?', w: { densite: 4, sante: 5, ecole: 0, voirie: 2, inond: 0, erosion: 0, inclusion: 4 }, slope: true, flood: true },
    assain: { name: 'Assainissement et drainage pluvial', desc: 'Quels quartiers densément bâtis sont les plus exposés au ruissellement et aux inondations ?', w: { densite: 4, sante: 0, ecole: 0, voirie: 1, inond: 5, erosion: 3, inclusion: 1 } },
    voirie: { name: 'Désenclavement et voirie', desc: 'Quelles zones habitées sont les plus éloignées du réseau structurant ?', w: { densite: 4, sante: 1, ecole: 0, voirie: 5, inond: 1, erosion: 2, inclusion: 3 } },
    dechets: { name: 'Gestion des déchets solides (SDGDS)', desc: 'Où placer en priorité des points de regroupement et de collecte des déchets ?', w: { densite: 5, sante: 0, ecole: 0, voirie: 3, inond: 3, erosion: 1, inclusion: 1 } },
    custom: { name: 'Scénario personnalisé', desc: 'Pondérations définies par l’utilisateur.', w: null },
  };
  let weights = { ...SCENARIOS.equip.w };
  let currentScn = 'equip';
  const RAMP = ['#fff1e0', '#fdc58f', '#f88d3f', '#d4520f', '#7f2704'];

  const scnSel = $('#scenario');
  scnSel.innerHTML = Object.entries(SCENARIOS).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join('');
  $('#criteria').innerHTML = CRITERIA.map(c => `
    <div class="crit">
      <div class="crit-head">${esc(c.label)} <i class="tip" data-tip="${esc(c.tip)}">i</i>
        ${c.warn ? '<span class="badge-warn" data-tip="Couverture de données insuffisante">données lacunaires</span>' : ''}
        <span class="w" id="w-${c.k}">0</span></div>
      <div class="crit-cat">${esc(c.cat)}</div>
      <input type="range" min="0" max="5" step="1" id="r-${c.k}" aria-label="Poids ${esc(c.label)}">
    </div>`).join('');

  function applyScenario(k) {
    currentScn = k;
    const s = SCENARIOS[k];
    if (s.w) weights = { ...s.w };
    $('#constraint-slope').checked = !!s.slope;
    $('#constraint-flood').checked = !!s.flood;
    $('#scenario-desc').textContent = s.desc;
    CRITERIA.forEach(c => { $('#r-' + c.k).value = weights[c.k]; $('#w-' + c.k).textContent = weights[c.k]; });
    computeAMC();
  }
  scnSel.addEventListener('change', () => applyScenario(scnSel.value));
  CRITERIA.forEach(c => $('#r-' + c.k).addEventListener('input', e => {
    weights[c.k] = +e.target.value;
    $('#w-' + c.k).textContent = weights[c.k];
    if (currentScn !== 'custom') { currentScn = 'custom'; scnSel.value = 'custom'; $('#scenario-desc').textContent = SCENARIOS.custom.desc; }
    computeAMC();
  }));
  ['#constraint-slope', '#constraint-flood'].forEach(s => $(s).addEventListener('change', computeAMC));

  let sectorScores = [];
  function computeAMC() {
    const tot = CRITERIA.reduce((s, c) => s + weights[c.k], 0) || 1;
    const exSlope = $('#constraint-slope').checked, exFlood = $('#constraint-flood').checked;
    const scores = [];
    for (const c of cells) {
      const p = c.properties;
      const excluded = (exSlope && p.pente > 15) || (exFlood && p.inond > 0.7);
      if (excluded) { p.score = -1; continue; }
      p.score = Math.round(CRITERIA.reduce((s, cr) => s + weights[cr.k] * cr.f(p), 0) / tot * 100);
      scores.push(p.score);
    }
    scores.sort((a, b) => a - b);
    const q = [0.2, 0.4, 0.6, 0.8].map(t => scores[Math.floor(t * (scores.length - 1))] ?? 0);
    for (const c of cells) {
      const s = c.properties.score;
      c.properties.cls = s < 0 ? 0 : 1 + q.filter(v => s > v).length;
    }
    // classement des secteurs : score moyen pondéré par la population (bâti)
    const agg = {};
    for (const c of cells) {
      const p = c.properties; if (p.score < 0) continue;
      const w = Math.max(p.bati, 1);
      (agg[p.secteur] ||= { s: 0, w: 0, n: 0 }); agg[p.secteur].s += p.score * w; agg[p.secteur].w += w; agg[p.secteur].n++;
    }
    sectorScores = Object.entries(agg).map(([k, v]) => ({ secteur: k, score: Math.round(v.s / v.w), mailles: v.n })).sort((a, b) => b.score - a.score);
    const max = sectorScores[0]?.score || 1;
    $('#ranking').innerHTML = sectorScores.slice(0, 8).map(s => `
      <li data-sector="${esc(s.secteur)}" title="Zoomer sur le secteur"><span class="name">${esc(s.secteur)}</span>
      <span class="bar"><span style="width:${s.score / max * 100}%"></span></span><span class="val">${s.score}</span></li>`).join('');
    $$('#ranking li').forEach(li => li.addEventListener('click', () => zoomSector(li.dataset.sector)));
    $('#amc-legend').innerHTML = `<div class="ramp">${RAMP.map(c => `<span style="background:${c}"></span>`).join('')}</div>
      <div class="ramp-labels"><span>Priorité faible</span><span>Priorité forte</span></div>`;
    if (map.getSource('grille')) map.getSource('grille').setData(D.grille);
    if (activeGrid === 'amc') renderMapLegend();
  }

  /* ------------------------------------------------------------------ couches */
  const GRID_LAYERS = {
    amc: {
      label: 'Priorité AMC (scénario courant)',
      paint: { 'fill-color': ['match', ['get', 'cls'], 0, '#9aa5a9', 1, RAMP[0], 2, RAMP[1], 3, RAMP[2], 4, RAMP[3], 5, RAMP[4], '#ccc'], 'fill-opacity': ['case', ['==', ['get', 'cls'], 0], 0.35, 0.72] },
      legend: () => legendRamp('Priorité AMC', RAMP, ['Faible', 'Forte'], '<div style="margin-top:4px"><span class="swatch" style="display:inline-block;background:#9aa5a9;vertical-align:-2px"></span> Exclue (contrainte)</div>'),
    },
    densite: {
      label: 'Densité du bâti (bâtiments / 4 ha)',
      paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'bati'], 0, '#f7fbff', 10, '#c6dbef', 40, '#6baed6', 90, '#2171b5', 160, '#08306b'], 'fill-opacity': 0.72 },
      legend: () => legendRamp('Bâtiments par maille', ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'], ['0', '160 +']),
    },
    inond: {
      label: "Susceptibilité d'inondation (proxy)",
      paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'inond'], 0, '#f1f7fb', 0.4, '#9ecae1', 0.6, '#4292c6', 0.8, '#08519c', 1, '#08306b'], 'fill-opacity': 0.7 },
      legend: () => legendRamp("Susceptibilité d'inondation", ['#f1f7fb', '#9ecae1', '#4292c6', '#08519c', '#08306b'], ['Faible', 'Forte']),
    },
    pente: {
      label: 'Pentes moyennes (érosion)',
      paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'pente'], 0, '#ffffe5', 5, '#d9f0a3', 10, '#fec44f', 15, '#ec7014', 22, '#8c2d04'], 'fill-opacity': 0.7 },
      legend: () => legendRamp('Pente moyenne', ['#ffffe5', '#d9f0a3', '#fec44f', '#ec7014', '#8c2d04'], ['0°', '22° +']),
    },
  };
  let activeGrid = null;
  const ROAD_COLORS = { 'Voirie principale': '#c8553d', 'Voirie secondaire': '#e9a23b', "Voie d'accès": '#7d8b91', Piste: '#a68a64' };
  /* ---- catalogue des données collectées en phase 1 (7 catégories) ---- */
  const CAT = window.BOMA_CAT;
  const PT_COLORS = { transport: '#1d4e89', administration: '#6a4c93', police: '#3d348b', ecoles: '#3a5ba0', sante: '#c8553d',
    sport: '#2a9d8f', culture: '#8e5572', tourisme: '#e09f3e', marches: '#d4520f', commerces: '#7a6c5d' };
  const nPts = c => CAT.points.features.filter(f => f.properties.couche === c).length;
  // pictogrammes dessinés pour la maquette (24 × 24, blanc sur pastille de couleur)
  const PICTO = {
    transport: '<path fill-rule="evenodd" d="M6 3h12a2 2 0 0 1 2 2v11a2 2 0 0 1-1 1.7V20h-3v-2H8v2H5v-2.3A2 2 0 0 1 4 16V5a2 2 0 0 1 2-2zm0 3v5h12V6H6zm1.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
    administration: '<path d="M12 2 2 7v2h20V7L12 2zM4 11h3v7H4zm6.5 0h3v7h-3zM17 11h3v7h-3zM2 20h20v2H2z"/>',
    police: '<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3z"/><path fill="COLOR" d="m12 7 1.4 2.9 3.1.4-2.3 2.2.6 3.1L12 14.1l-2.8 1.5.6-3.1-2.3-2.2 3.1-.4z"/>',
    ecoles: '<path d="M12 3 1 8l11 5 9-4.1V15h2V8L12 3zm-6 9.2V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.8l-6 2.7-6-2.7z"/>',
    sante: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
    sport: '<circle cx="12" cy="12" r="8.3" fill="none" stroke="#fff" stroke-width="2.2"/><path d="m12 7.6 3.4 2.5-1.3 4h-4.2l-1.3-4z"/>',
    culture: '<path d="M12 2 9 5v3H5l-2 3v11h7v-5a2 2 0 0 1 4 0v5h7V11l-2-3h-4V5z"/>',
    tourisme: '<path fill-rule="evenodd" d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>',
    marches: '<path d="M3 8h18v2H3zM5 11h14l-1.4 8.4a2 2 0 0 1-2 1.6H8.4a2 2 0 0 1-2-1.6zM7.6 7 11 2.6h2L9.6 7zm6.8 0L11 2.6h2L16.4 7z"/>',
    commerces: '<path fill-rule="evenodd" d="M6 7h12l1 14H5L6 7zm3 0V6a3 3 0 0 1 6 0v1h-2V6a1 1 0 0 0-2 0v1H9z"/>',
  };
  const iconSvg = (c, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <circle cx="32" cy="33" r="27" fill="#0b2a33" opacity=".22"/><circle cx="32" cy="31" r="27" fill="${color}" stroke="#fff" stroke-width="4"/>
    <g transform="translate(16 15) scale(1.333)" fill="#fff">${PICTO[c].replace('COLOR', color)}</g></svg>`;
  const iconUri = c => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(c, PT_COLORS[c]));
  const pt = (couche, label, extra = {}) => ({ id: 'cat-' + couche, label, type: 'Point', sw: 'dot', icon: couche, color: PT_COLORS[couche], count: nPts(couche), ...extra });
  const CATALOGUE = [
    { cat: '01. Limites administratives', items: [
      { id: 'limite', label: 'Limite de la ville de Boma', type: 'Polygone', sw: 'line', color: '#0f4c5c', on: true, count: D.limite.features.length, src: 'OpenStreetMap' },
      { label: 'Limites des communes', type: 'Polygone' },
      { id: 'quartiers', label: 'Limites des quartiers', type: 'Polygone', sw: 'line', color: '#5a6b72', count: CAT.quartiers.features.length, src: 'GRID3 (localités), limites approchées' },
    ], extra: [{ id: 'secteurs', label: 'Secteurs (aires de santé)', sw: 'line', color: '#1a6b7f', on: true, count: D.secteurs.features.length }] },
    { cat: '02. Infrastructures de transport', items: [
      { id: 'voirie', label: 'Voirie', type: 'Ligne', sw: 'line', color: '#c8553d', on: true, count: D.voirie.features.length, src: 'OpenStreetMap' },
      pt('transport', 'Gares et arrêts de transport', { on: true, src: 'OpenStreetMap, Overture Maps' }),
    ] },
    { cat: '03. Équipements administratifs et sécuritaires', items: [
      pt('administration', 'Équipements administratifs', { src: 'OpenStreetMap' }),
      pt('police', 'Postes de police', { src: 'OpenStreetMap' }),
    ] },
    { cat: '04. Équipements et services collectifs', items: [
      pt('ecoles', 'Équipements scolaires', { warn: true, src: 'OpenStreetMap, Overture Maps' }),
      pt('sante', 'Équipements de santé', { on: true, src: 'GRID3 RDC v9.0' }),
      pt('sport', 'Équipements sportifs', { src: 'OpenStreetMap' }),
      pt('culture', 'Équipements culturels', { src: 'OpenStreetMap, Overture Maps' }),
      pt('tourisme', 'Équipements touristiques', { src: 'OpenStreetMap, Overture Maps' }),
    ] },
    { cat: '05. Activités économiques', items: [
      pt('marches', 'Marchés', { src: 'OpenStreetMap' }),
      pt('commerces', 'Commerces et services', { src: 'OpenStreetMap, Overture Maps' }),
    ] },
    { cat: '06. Environnement et occupation du sol', items: [
      { id: 'verts', label: 'Espaces verts', type: 'Polygone', sw: '', color: '#6a994e', count: CAT.verts.features.length, src: 'Overture Maps (ESA WorldCover)' },
      { label: 'Cimetières', type: 'Point' },
      { id: 'erosion', label: "Zones d'érosion", type: 'Polygone', sw: '', color: '#9c6644', count: CAT.erosion.features.length, src: 'Dérivé du MNT (pente > 12°), indicatif' },
    ], extra: [
      { id: 'occupation', label: 'Occupation urbaine (habitat, activités)', sw: '', color: '#b8a9c9', count: CAT.occupation.features.length },
      { id: 'hydro', label: "Cours d'eau", sw: 'line', color: '#3a86c8', on: true, count: D.hydro.features.length },
    ] },
    { cat: '07. Fonds cartographiques', items: [
      { label: 'Imagerie satellite', type: 'Raster / service web', basemap: true, src: 'Esri World Imagery (fond « Satellite »)' },
      { label: 'Relevé drone', type: 'Raster / service web' },
      { id: 'mnt', label: 'MNT (relief ombré)', type: 'Raster / service web', sw: '', color: '#7d8b91', count: 1, src: 'SRTM 30 m' },
    ] },
  ];
  const TREE = [
    ...CATALOGUE.map(g => ({ name: g.cat, layers: [...g.items, ...(g.extra || [])] })),
    { name: 'Analyses dérivées', layers: [
      { id: 'densite', label: GRID_LAYERS.densite.label, grid: true, color: '#2171b5' },
      { id: 'inond', label: GRID_LAYERS.inond.label, grid: true, color: '#4292c6' },
      { id: 'pente', label: GRID_LAYERS.pente.label, grid: true, color: '#ec7014' }] },
    { name: 'Aide à la décision', layers: [{ id: 'amc', label: GRID_LAYERS.amc.label, grid: true, color: '#d4520f', on: true }] },
    { name: 'Saisies terrain', layers: [{ id: 'saisies', label: 'Saisies des agents', on: true, sw: 'dot', color: '#2a9d8f', count: () => saisies.length }] },
  ];
  const COMPOSITE = { voirie: ['voirie-casing', 'voirie'], 'cat-transport': ['aeroport-fill', 'aeroport-line', 'cat-transport'],
    quartiers: ['quartiers-fill', 'quartiers-line'], erosion: ['erosion-fill', 'erosion-line'] };
  const CAT_POINT_IDS = Object.keys(PT_COLORS).map(c => 'cat-' + c);
  const isTodo = l => !l.basemap && (!l.id || (l.count !== undefined && typeof l.count !== 'function' && l.count === 0));

  function renderTree() {
    $('#layer-tree').innerHTML = TREE.map((g, gi) => `
      <div class="group" data-g="${gi}">
        <div class="group-head">${esc(g.name)}<span class="chev">▾</span></div>
        <div class="group-body">${g.layers.map(l => l.basemap ? `
          <div class="layer todo"><span class="swatch" style="background:#7d8b91"></span><span>${esc(l.label)}</span>
            <span class="badge-todo" data-tip="Affichée avec le fond de carte « Satellite ». L'imagerie collectée (Google, drone) sera ajoutée en phase 1.">fond Satellite</span></div>` : isTodo(l) ? `
          <div class="layer todo">${l.icon ? `<img class="swatch-ico off" src="${iconUri(l.icon)}" alt="">` : `<span class="swatch ${l.sw || ''}" style="background:#c9d1d3"></span>`}<span>${esc(l.label)}</span>
            <span class="badge-todo" data-tip="Absente des sources ouvertes : couche fournie par la collecte de phase 1 (Urban Analyse).">à intégrer · phase 1</span></div>` : `
          <label class="layer">
            <input type="checkbox" data-layer="${l.id}" ${isOn(l.id) ? 'checked' : ''}>
            ${l.icon ? `<img class="swatch-ico" src="${iconUri(l.icon)}" alt="">` : `<span class="swatch ${l.sw || ''}" style="background:${l.color}"></span>`}
            <span>${esc(l.label)}</span>
            ${l.warn ? '<span class="badge-warn" data-tip="Très peu d’écoles dans les sources ouvertes : la collecte de phase 1 complétera cette couche.">lacunaire</span>' : ''}
            ${l.count !== undefined ? `<span class="count">${typeof l.count === 'function' ? l.count() : l.count}</span>` : ''}
          </label>`).join('')}</div>
      </div>`).join('');
    $$('.group-head').forEach(h => h.addEventListener('click', () => h.parentElement.classList.toggle('closed')));
    $$('#layer-tree input').forEach(i => i.addEventListener('change', () => setLayer(i.dataset.layer, i.checked)));
  }
  const visible = {};
  const isOn = id => visible[id] ?? !!TREE.flatMap(g => g.layers).find(l => l.id === id)?.on;

  function setLayer(id, on) {
    if (GRID_LAYERS[id]) {
      if (on) {
        for (const g of Object.keys(GRID_LAYERS)) {
          visible[g] = g === id;
          map.setLayoutProperty('grid-' + g, 'visibility', g === id ? 'visible' : 'none');
        }
        activeGrid = id;
      } else {
        visible[id] = false; map.setLayoutProperty('grid-' + id, 'visibility', 'none');
        if (activeGrid === id) activeGrid = null;
      }
      $$('#layer-tree input').forEach(i => { if (GRID_LAYERS[i.dataset.layer]) i.checked = !!visible[i.dataset.layer]; });
      renderMapLegend();
      return;
    }
    visible[id] = on;
    const ids = COMPOSITE[id] || [id];
    ids.forEach(l => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'));
    if (id === 'secteurs') sectorMarkers.forEach(m => m.getElement().style.display = on ? '' : 'none');
  }

  function legendRamp(title, colors, ends, extra = '') {
    return `<div class="t">${esc(title)}</div><div class="ramp">${colors.map(c => `<span style="background:${c}"></span>`).join('')}</div>
      <div class="ramp-labels"><span>${ends[0]}</span><span>${ends[1]}</span></div>${extra}`;
  }
  function renderMapLegend() {
    let h = activeGrid ? GRID_LAYERS[activeGrid].legend() : '';
    if (isOn('voirie')) h += `<div class="t" style="margin-top:${h ? 8 : 0}px">Voirie</div>` + Object.entries(ROAD_COLORS).map(([k, c]) =>
      `<div><span class="swatch line" style="display:inline-block;width:18px;background:${c};vertical-align:middle"></span> ${esc(k)}</div>`).join('');
    $('#map-legend').innerHTML = h;
  }

  let sectorMarkers = [];
  map.on('error', e => console.error('Carte :', e.error?.message || e));
  map.on('load', () => {
    map.resize();
    map.fitBounds([[D.meta.bbox[0], D.meta.bbox[1]], [D.meta.bbox[2], D.meta.bbox[3]]], { padding: 20, duration: 0 });
    computeAMC();
    const vis = id => (isOn(id) ? 'visible' : 'none');
    map.addSource('mnt', { type: 'image', url: CAT.mnt.url, coordinates: CAT.mnt.coordinates });
    map.addLayer({ id: 'mnt', type: 'raster', source: 'mnt', paint: { 'raster-opacity': 0.85 }, layout: { visibility: vis('mnt') } });
    map.addSource('verts', { type: 'geojson', data: CAT.verts });
    map.addLayer({ id: 'verts', type: 'fill', source: 'verts', layout: { visibility: vis('verts') },
      paint: { 'fill-color': ['match', ['get', 'type'], 'Forêt', '#386641', 'Végétation arbustive', '#6a994e', 'Prairie / herbacée', '#a7c957', 'Zone humide', '#4d908e', 'Cultures', '#dda15e', '#6a994e'], 'fill-opacity': 0.55 } });
    map.addSource('occupation', { type: 'geojson', data: CAT.occupation });
    map.addLayer({ id: 'occupation', type: 'fill', source: 'occupation', layout: { visibility: vis('occupation') },
      paint: { 'fill-color': ['match', ['get', 'type'], 'Habitat', '#e5989b', '#9d8189'], 'fill-opacity': 0.45, 'fill-outline-color': '#6d597a' } });
    map.addSource('grille', { type: 'geojson', data: D.grille });
    for (const [k, g] of Object.entries(GRID_LAYERS)) {
      map.addLayer({ id: 'grid-' + k, type: 'fill', source: 'grille', paint: { ...g.paint, 'fill-outline-color': 'rgba(255,255,255,0.5)' }, layout: { visibility: k === 'amc' ? 'visible' : 'none' } });
    }
    activeGrid = 'amc'; visible.amc = true;
    map.addSource('erosion', { type: 'geojson', data: CAT.erosion });
    map.addLayer({ id: 'erosion-fill', type: 'fill', source: 'erosion', layout: { visibility: vis('erosion') }, paint: { 'fill-color': '#9c6644', 'fill-opacity': 0.4 } });
    map.addLayer({ id: 'erosion-line', type: 'line', source: 'erosion', layout: { visibility: vis('erosion') }, paint: { 'line-color': '#7f4f24', 'line-width': 1.2 } });
    map.addSource('quartiers', { type: 'geojson', data: CAT.quartiers });
    map.addLayer({ id: 'quartiers-fill', type: 'fill', source: 'quartiers', layout: { visibility: vis('quartiers') }, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.01 } });
    map.addLayer({ id: 'quartiers-line', type: 'line', source: 'quartiers', layout: { visibility: vis('quartiers') }, paint: { 'line-color': '#5a6b72', 'line-width': 0.8, 'line-dasharray': [2, 2] } });
    map.addSource('secteurs', { type: 'geojson', data: D.secteurs });
    map.addLayer({ id: 'secteurs', type: 'line', source: 'secteurs', paint: { 'line-color': '#0f4c5c', 'line-width': 1.6, 'line-opacity': 0.7 } });
    map.addSource('limite', { type: 'geojson', data: D.limite });
    map.addLayer({ id: 'limite', type: 'line', source: 'limite', paint: { 'line-color': '#0f4c5c', 'line-width': 2.5, 'line-dasharray': [3, 2] } });
    map.addSource('hydro', { type: 'geojson', data: D.hydro });
    map.addLayer({ id: 'hydro', type: 'line', source: 'hydro', paint: { 'line-color': '#3a86c8', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, 3] } });
    map.addSource('voirie', { type: 'geojson', data: D.voirie });
    const rw = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, a, 17, b];
    map.addLayer({ id: 'voirie-casing', type: 'line', source: 'voirie', filter: ['in', ['get', 'classe'], ['literal', ['Voirie principale', 'Voirie secondaire']]], paint: { 'line-color': '#fff', 'line-width': rw(3.5, 11) }, layout: { 'line-cap': 'round' } });
    map.addLayer({
      id: 'voirie', type: 'line', source: 'voirie', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'classe'], ...Object.entries(ROAD_COLORS).flat(), '#999'],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          12, ['match', ['get', 'classe'], 'Voirie principale', 2.2, 'Voirie secondaire', 1.6, 0.6],
          17, ['match', ['get', 'classe'], 'Voirie principale', 8, 'Voirie secondaire', 6, 3]],
      },
    });
    map.addSource('aeroport', { type: 'geojson', data: CAT.aeroport });
    map.addLayer({ id: 'aeroport-fill', type: 'fill', source: 'aeroport', layout: { visibility: vis('cat-transport') }, paint: { 'fill-color': '#1d4e89', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'aeroport-line', type: 'line', source: 'aeroport', layout: { visibility: vis('cat-transport') }, paint: { 'line-color': '#1d4e89', 'line-width': 1.5 } });
    map.addSource('cat-points', { type: 'geojson', data: CAT.points });
    for (const c of Object.keys(PT_COLORS)) {
      const img = new Image(64, 64);
      img.onload = () => {
        if (!map.hasImage('ico-' + c)) map.addImage('ico-' + c, img, { pixelRatio: 2 });
        map.triggerRepaint();
      };
      img.src = iconUri(c);
      map.addLayer({
        id: 'cat-' + c, type: 'symbol', source: 'cat-points', filter: ['==', ['get', 'couche'], c],
        layout: { visibility: vis('cat-' + c), 'icon-image': 'ico-' + c, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 14, 0.75, 17, 1.05] },
      });
    }
    map.on('styleimagemissing', () => {}); // les icônes se chargent juste après la couche
    map.addSource('saisies', { type: 'geojson', data: saisiesFC() });
    map.addLayer({ id: 'saisies', type: 'circle', source: 'saisies', paint: { 'circle-color': '#2a9d8f', 'circle-radius': 8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'saisies-dot', type: 'circle', source: 'saisies', paint: { 'circle-color': '#fff', 'circle-radius': 2.5 } });

    // étiquettes de secteurs (HTML, sans dépendance à un serveur de polices)
    for (const s of SECTORS) {
      const cs = cells.filter(c => c.properties.secteur === s);
      const ll = [cs.reduce((a, c) => a + c.properties.cx, 0) / cs.length, cs.reduce((a, c) => a + c.properties.cy, 0) / cs.length];
      const el = document.createElement('div'); el.className = 'sector-label'; el.textContent = s;
      sectorMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map));
    }
    renderTree();
    renderMapLegend();
    ['voirie', 'saisies', 'aeroport-fill', 'erosion-fill', 'verts', 'occupation', 'quartiers-fill', ...CAT_POINT_IDS, ...Object.keys(GRID_LAYERS).map(k => 'grid-' + k)].forEach(l => {
      map.on('mouseenter', l, () => { if (!picking) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { if (!picking) map.getCanvas().style.cursor = ''; });
    });
    if (!LS.get('boma_tour_done', false)) setTimeout(startTour, 700);
  });

  const saisiesFC = () => ({ type: 'FeatureCollection', features: saisies });

  /* ------------------------------------------------------------------ fiches (popups) */
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`;
  map.on('click', e => {
    if (picking) return onPick(e.lngLat);
    const order = ['saisies', ...CAT_POINT_IDS, 'voirie', 'aeroport-fill', 'erosion-fill', 'grid-amc', 'grid-densite', 'grid-inond', 'grid-pente', 'quartiers-fill', 'verts', 'occupation'];
    const layers = order.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
    const pad = 4, bb = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const feats = map.queryRenderedFeatures(bb, { layers });
    if (!feats.length) return;
    feats.sort((a, b) => order.indexOf(a.layer.id) - order.indexOf(b.layer.id));
    const f = feats[0];
    let html = '';
    if (f.layer.id === 'saisies') html = popSaisie(f);
    else if (f.layer.id.startsWith('cat-')) html = popCatPoint(f.properties, e.lngLat);
    else if (f.layer.id === 'voirie') html = popRoad(f.properties);
    else if (['aeroport-fill', 'erosion-fill', 'quartiers-fill', 'verts', 'occupation'].includes(f.layer.id)) html = popPoly(f.layer.id, f.properties);
    else html = popCell(cells.find(c => c.properties.id === f.properties.id).properties);
    popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    const btn = $('.maplibregl-popup [data-act]');
    if (btn) btn.addEventListener('click', () => {
      const act = btn.dataset.act, id = btn.dataset.id;
      popup.remove();
      if (act === 'edit-road') editRoad(+id);
      if (act === 'del-saisie') deleteSaisie(id);
    });
  });

  const COUCHE_LABEL = Object.fromEntries(CATALOGUE.flatMap(g => g.items.filter(i => i.id && i.id.startsWith('cat-')).map(i => [i.id.slice(4), [i.label, g.cat]])));
  function popCatPoint(p, lngLat) {
    const [lab, cat] = COUCHE_LABEL[p.couche] || [p.couche, ''];
    return `<div class="pop"><h5>${esc(p.nom || p.type)}</h5><div class="sub">${esc(p.type)} · ${esc(lab)}</div><table>
      ${row('Catégorie', esc(cat))}${row('Secteur', esc(nearestCell([lngLat.lng, lngLat.lat]).cell.properties.secteur))}${row('Source', esc(p.source))}</table></div>`;
  }
  function popPoly(id, p) {
    const T = { 'aeroport-fill': 'Aérodrome', 'erosion-fill': "Zone d'érosion (indicative)", 'quartiers-fill': 'Quartier (limite approchée)', verts: 'Espace vert / naturel', occupation: 'Occupation urbaine' };
    return `<div class="pop"><h5>${esc(p.nom || T[id])}</h5><div class="sub">${esc(T[id])}</div><table>
      ${p.type ? row('Type', esc(p.type)) : ''}${row('Source', esc(p.source || 'OpenStreetMap'))}</table>
      ${id === 'quartiers-fill' ? '<p style="font-size:12px;margin:6px 0 0">Limite approchée à partir des localités GRID3 : elle sera remplacée par les limites de quartiers collectées en phase 1.</p>' : ''}</div>`;
  }
  function popEquip(p) {
    return `<div class="pop"><h5>${esc(p.nom || p.type)}</h5><div class="sub">${esc(p.type)} · ${esc(p.theme)}</div><table>
      ${p.aire ? row('Aire de santé', esc(p.aire)) : ''}${p.zone ? row('Zone de santé', esc(p.zone)) : ''}
      ${row('Secteur', esc(p.secteur))}${row('Source', esc(p.source))}</table></div>`;
  }
  function popRoad(p) {
    const u = roadUpdates[p.id];
    return `<div class="pop"><h5>${esc(p.nom || 'Voie sans nom')}</h5><div class="sub">${esc(p.classe)}</div><table>
      ${row('Longueur', fmt(p.len_m) + ' m')}${row('Revêtement', esc(u?.revetement || surfaceLabel(p.revetement)))}
      ${row('État', u ? `<b>${esc(u.etat)}</b>` : '<i>non renseigné</i>')}${u ? row('Drainage', esc(u.drainage)) : ''}
      ${row('Secteur', esc(p.secteur))}${u ? row('Mise à jour', `${esc(u.by)}, ${new Date(u.at).toLocaleDateString('fr-FR')}`) : ''}
      </table>${isAdmin() ? `<button class="btn primary" data-act="edit-road" data-id="${p.id}">Mettre à jour la fiche</button>` : ''}</div>`;
  }
  function popCell(p) {
    let h = `<div class="pop"><h5>Maille n° ${p.id}</h5><div class="sub">Secteur ${esc(p.secteur)}</div><table>
      ${row('Bâtiments', p.bati)}${row('Centre de santé', fmt(p.d_sante) + ' m')}${row('Voirie structurante', fmt(p.d_voirie) + ' m')}
      ${row('Altitude / pente', `${fmt(p.alt)} m · ${fmt(p.pente, 1)}°`)}${row('Inondation (proxy)', fmt(p.inond, 2))}</table>`;
    if (activeGrid === 'amc') {
      if (p.score < 0) h += `<p style="margin:8px 0 0;font-size:12px"><b>Exclue</b> par une contrainte du scénario.</p>`;
      else {
        const tot = CRITERIA.reduce((s, c) => s + weights[c.k], 0) || 1;
        h += `<div style="margin:8px 0 4px;font-weight:700">Score de priorité : ${p.score} / 100</div>` +
          CRITERIA.filter(c => weights[c.k] > 0).map(c => {
            const v = weights[c.k] * c.f(p) / tot * 100;
            return `<div class="contrib"><span class="lbl">${esc(c.label)}</span><span class="bar"><span style="width:${v}%"></span></span><span>${fmt(v)}</span></div>`;
          }).join('');
      }
    }
    return h + '</div>';
  }
  function popSaisie(f) {
    const p = f.properties, t = TYPES[p.type];
    return `<div class="pop"><h5>${esc(t?.label || p.type)}</h5><div class="sub">Saisie du ${new Date(p.at).toLocaleString('fr-FR')} · ${esc(p.by)}</div><table>
      ${Object.entries(p.values || {}).map(([k, v]) => row(t?.fields.find(x => x.k === k)?.label || k, esc(v))).join('')}
      ${row('Secteur', esc(p.secteur))}${row('Voie proche', esc(p.voie))}</table>
      ${isAdmin() ? `<button class="btn" data-act="del-saisie" data-id="${esc(f.properties.uid)}">Supprimer la saisie</button>` : ''}</div>`;
  }

  /* ------------------------------------------------------------------ modale & toast */
  const modal = $('#modal');
  function openModal(title, body, foot = '', wide = false) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    $('#modal-foot').innerHTML = foot;
    $('.modal-card').classList.toggle('wide', wide);
    modal.hidden = false;
  }
  const closeModal = () => { modal.hidden = true; };
  $('#modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); if (picking) stopPick(); } });
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800); }

  function log(action) {
    journal.unshift({ who: ROLE_LABEL[role], what: action, at: Date.now() });
    journal = journal.slice(0, 50);
    LS.set('boma_journal', journal);
    renderJournal();
  }
  function renderJournal() {
    $('#journal').innerHTML = journal.length ? journal.map(j => `<li><span class="who">${esc(j.who)}</span> — ${esc(j.what)}<br><span class="when">${new Date(j.at).toLocaleString('fr-FR')}</span></li>`).join('')
      : '<li class="when">Aucune modification pour le moment.</li>';
  }

  /* ------------------------------------------------------------------ mise à jour de la voirie */
  function editRoad(id) {
    const f = D.voirie.features.find(x => x.properties.id === id);
    const p = f.properties, u = roadUpdates[id] || {};
    const opt = (arr, v) => arr.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('');
    openModal(`Fiche voirie — ${p.nom || 'voie sans nom'}`, `
      <div class="prefill">Informations préremplies : <b>${esc(p.classe)}</b> · ${fmt(p.len_m)} m · secteur <b>${esc(p.secteur)}</b> · revêtement OSM : ${esc(surfaceLabel(p.revetement))}</div>
      <div class="field"><label class="req">État général</label><select id="f-etat"><option value="">— choisir —</option>${opt(['Bon', 'Moyen', 'Mauvais', 'Impraticable'], u.etat)}</select><div class="err">Champ obligatoire</div></div>
      <div class="field"><label>Revêtement</label><select id="f-rev">${opt(['Revêtue', 'Non revêtue', 'Non renseigné'], u.revetement || surfaceLabel(p.revetement))}</select></div>
      <div class="field"><label>Drainage</label><select id="f-drain">${opt(['Caniveaux fonctionnels', 'Caniveaux obstrués', 'Absent'], u.drainage)}</select></div>
      <div class="field"><label>Observation</label><textarea id="f-obs" rows="2" placeholder="Ex. : ravinement en bordure, nids-de-poule…">${esc(u.obs || '')}</textarea></div>`,
      `<button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-ok">Enregistrer</button>`);
    $('#m-cancel').onclick = closeModal;
    $('#m-ok').onclick = () => {
      const etat = $('#f-etat');
      if (!etat.value) { etat.classList.add('invalid'); return; }
      roadUpdates[id] = { etat: etat.value, revetement: $('#f-rev').value, drainage: $('#f-drain').value, obs: $('#f-obs').value, by: ROLE_LABEL[role], at: Date.now() };
      LS.set('boma_voirie_maj', roadUpdates);
      log(`Mise à jour de la voie « ${p.nom || 'sans nom'} » (${etat.value})`);
      closeModal(); toast('Fiche voirie enregistrée'); updateKPIs();
    };
  }

  /* ------------------------------------------------------------------ saisie guidée */
  const TYPES = {
    dechets: { label: 'Dépôt sauvage de déchets', desc: 'Signaler un dépôt non contrôlé (SDGDS)', fields: [
      { k: 'volume', label: 'Volume estimé', req: true, opts: ['Petit (< 1 m³)', 'Moyen (1 à 5 m³)', 'Important (> 5 m³)'] },
      { k: 'nature', label: 'Nature dominante', req: true, opts: ['Ordures ménagères', 'Plastiques', 'Gravats', 'Mixte'] },
      { k: 'caniveau', label: 'Obstrue un caniveau ?', opts: ['Non', 'Oui'] },
      { k: 'obs', label: 'Observation', text: true }] },
    eau: { label: "Point d'eau", desc: 'Borne-fontaine, puits, forage, source', fields: [
      { k: 'type', label: 'Type', req: true, opts: ['Borne-fontaine', 'Puits', 'Forage', 'Source aménagée'] },
      { k: 'etat', label: 'Fonctionnement', req: true, opts: ['Fonctionnel', 'En panne', 'Saisonnier'] },
      { k: 'gestion', label: 'Gestionnaire', opts: ['REGIDESO', 'Comité de quartier', 'Privé', 'Inconnu'] },
      { k: 'obs', label: 'Observation', text: true }] },
    equipement: { label: 'Équipement collectif', desc: 'École, centre de santé, marché…', fields: [
      { k: 'categorie', label: 'Catégorie', req: true, opts: ['École primaire', 'École secondaire', 'Centre de santé', 'Marché', 'Terrain de sport', 'Administration'] },
      { k: 'nom', label: 'Nom', req: true, text: true },
      { k: 'etat', label: 'État du bâtiment', opts: ['Bon', 'Moyen', 'Dégradé'] },
      { k: 'obs', label: 'Observation', text: true }] },
    voirie: { label: 'Dégradation de voirie', desc: 'Nid-de-poule, ravinement, zone inondée', fields: [
      { k: 'type', label: 'Type de dégradation', req: true, opts: ['Nids-de-poule', 'Ravinement / érosion', 'Inondation récurrente', 'Effondrement'] },
      { k: 'gravite', label: 'Gravité', req: true, opts: ['1 — Faible', '2 — Moyenne', '3 — Forte (circulation coupée)'] },
      { k: 'obs', label: 'Observation', text: true }] },
  };
  let wiz = null, picking = false;
  const steps = n => `<div class="steps">${[1, 2, 3, 4].map(i => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div>`;

  $('#btn-add').addEventListener('click', () => { wiz = {}; wizStep1(); });
  function wizStep1() {
    openModal('Nouvelle saisie — 1/4 : type d’objet', steps(1) + `<div class="choice-grid">${Object.entries(TYPES).map(([k, t]) =>
      `<button class="choice" data-k="${k}"><b>${esc(t.label)}</b><small>${esc(t.desc)}</small></button>`).join('')}</div>`);
    $$('.choice').forEach(b => b.addEventListener('click', () => { wiz.type = b.dataset.k; startPick(); }));
  }
  function startPick() { closeModal(); picking = true; document.body.classList.add('picking'); }
  function stopPick() { picking = false; document.body.classList.remove('picking'); map.getCanvas().style.cursor = ''; }
  $('#pick-cancel').addEventListener('click', e => { e.preventDefault(); stopPick(); });
  function onPick(ll) { stopPick(); wiz.ll = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]; wizStep3(); }

  function nearestRoad(ll) {
    let best = null, bd = Infinity;
    for (const f of D.voirie.features) for (const c of f.geometry.coordinates) {
      const d = dist(ll, c); if (d < bd) { bd = d; best = f; }
    }
    return best ? `${best.properties.nom || 'voie sans nom'} (${best.properties.classe}, ${fmt(bd)} m)` : '—';
  }
  function wizStep3() {
    const t = TYPES[wiz.type];
    const nc = nearestCell(wiz.ll).cell.properties;
    wiz.secteur = nc.secteur; wiz.voie = nearestRoad(wiz.ll);
    const v = wiz.values || {};
    openModal(`Nouvelle saisie — 3/4 : fiche « ${t.label} »`, steps(3) + `
      <div class="prefill">Champs préremplis automatiquement — Date : <b>${new Date().toLocaleDateString('fr-FR')}</b> · Agent : <b>${ROLE_LABEL[role]}</b><br>
      Position : <b>${wiz.ll[1].toFixed(5)}, ${wiz.ll[0].toFixed(5)}</b> · Secteur : <b>${esc(wiz.secteur)}</b><br>Voie la plus proche : <b>${esc(wiz.voie)}</b> · Altitude ≈ <b>${fmt(nc.alt)} m</b></div>
      ${t.fields.map(f => `<div class="field"><label class="${f.req ? 'req' : ''}">${esc(f.label)}</label>
        ${f.opts ? `<select data-k="${f.k}"><option value="">— choisir —</option>${f.opts.map(o => `<option ${v[f.k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : f.k === 'obs' ? `<textarea data-k="${f.k}" rows="2">${esc(v[f.k] || '')}</textarea>` : `<input type="text" data-k="${f.k}" value="${esc(v[f.k] || '')}">`}
        ${f.req ? '<div class="err">Champ obligatoire</div>' : ''}</div>`).join('')}
      <div class="field"><label>Photo (optionnel)</label><input type="file" accept="image/*" capture="environment"></div>`,
      `<button class="btn ghost" id="m-back">Repositionner</button><button class="btn primary" id="m-next">Vérifier</button>`);
    $('#m-back').onclick = startPick;
    $('#m-next').onclick = () => {
      let ok = true; wiz.values = {};
      $$('#modal-body [data-k]').forEach(el => {
        const f = t.fields.find(x => x.k === el.dataset.k);
        el.classList.remove('invalid');
        if (f.req && !el.value.trim()) { el.classList.add('invalid'); ok = false; }
        if (el.value.trim()) wiz.values[f.k] = el.value.trim();
      });
      if (ok) wizStep4(); else toast('Merci de compléter les champs obligatoires');
    };
  }
  function wizStep4() {
    const t = TYPES[wiz.type];
    openModal('Nouvelle saisie — 4/4 : vérification', steps(4) + `<table class="cmp-table">
      ${row('Type', esc(t.label))}${Object.entries(wiz.values).map(([k, v]) => row(t.fields.find(f => f.k === k).label, esc(v))).join('')}
      ${row('Secteur', esc(wiz.secteur))}${row('Voie proche', esc(wiz.voie))}${row('Saisi par', ROLE_LABEL[role])}</table>`,
      `<button class="btn ghost" id="m-edit">Modifier</button><button class="btn primary" id="m-save">Enregistrer</button>`);
    $('#m-edit').onclick = wizStep3;
    $('#m-save').onclick = () => {
      saisies.push({ type: 'Feature', geometry: { type: 'Point', coordinates: wiz.ll }, properties: {
        uid: 'S' + Date.now().toString(36), type: wiz.type, values: wiz.values, secteur: wiz.secteur, voie: wiz.voie, by: ROLE_LABEL[role], at: Date.now() } });
      LS.set('boma_saisies', saisies);
      map.getSource('saisies').setData(saisiesFC());
      log(`Nouvelle saisie : ${t.label} (secteur ${wiz.secteur})`);
      closeModal(); toast('Saisie enregistrée et visible sur la carte'); renderTree(); updateKPIs();
    };
  }
  function deleteSaisie(uid) {
    const s = saisies.find(x => x.properties.uid === uid); if (!s) return;
    saisies = saisies.filter(x => x !== s);
    LS.set('boma_saisies', saisies);
    map.getSource('saisies').setData(saisiesFC());
    log(`Suppression d'une saisie : ${TYPES[s.properties.type]?.label}`);
    renderTree(); updateKPIs(); toast('Saisie supprimée');
  }

  /* ------------------------------------------------------------------ scénarios enregistrés */
  $('#btn-save-scn').addEventListener('click', () => {
    openModal('Enregistrer le scénario', `<div class="field"><label class="req">Nom du scénario</label><input type="text" id="scn-name" value="${esc(SCENARIOS[currentScn].name)} — ${new Date().toLocaleDateString('fr-FR')}"></div>
      <p class="note">Le scénario conserve les pondérations, les contraintes et le classement obtenu. Il pourra être comparé à d'autres scénarios et cité dans les rapports.</p>`,
      `<button class="btn primary" id="m-ok">Enregistrer</button>`);
    $('#m-ok').onclick = () => {
      const name = $('#scn-name').value.trim(); if (!name) return $('#scn-name').classList.add('invalid');
      savedScenarios.push({ id: Date.now(), name, w: { ...weights }, slope: $('#constraint-slope').checked, flood: $('#constraint-flood').checked, top: sectorScores.slice(0, 5).map(s => s.secteur), by: ROLE_LABEL[role], at: Date.now() });
      savedScenarios = savedScenarios.slice(-6);
      LS.set('boma_scenarios', savedScenarios); renderSaved(); log(`Scénario enregistré : ${name}`); closeModal(); toast('Scénario enregistré');
    };
  });
  function renderSaved() {
    $('#saved-scn').innerHTML = savedScenarios.length ? `<div class="saved">${savedScenarios.map(s => `<div class="saved-item"><span>${esc(s.name)}</span>
      <button class="btn ghost" data-load="${s.id}">Charger</button></div>`).join('')}</div>` : '';
    $$('[data-load]').forEach(b => b.addEventListener('click', () => {
      const s = savedScenarios.find(x => x.id === +b.dataset.load);
      currentScn = 'custom'; scnSel.value = 'custom'; weights = { ...s.w };
      SCENARIOS.custom.slope = s.slope; SCENARIOS.custom.flood = s.flood; SCENARIOS.custom.w = null;
      applyScenario('custom'); toast(`Scénario « ${s.name} » chargé`);
    }));
  }
  $('#btn-compare').addEventListener('click', () => {
    const list = [...savedScenarios.slice(-3), { name: 'Scénario courant', w: weights, top: sectorScores.slice(0, 5).map(s => s.secteur) }];
    if (list.length < 2) return toast('Enregistrez au moins un scénario pour comparer');
    openModal('Comparaison des scénarios', `<table class="cmp-table"><tr><th>Rang</th>${list.map(s => `<th>${esc(s.name)}</th>`).join('')}</tr>
      ${[0, 1, 2, 3, 4].map(i => `<tr><td>${i + 1}</td>${list.map(s => `<td>${esc(s.top[i] || '—')}</td>`).join('')}</tr>`).join('')}
      <tr><th colspan="${list.length + 1}">Pondérations</th></tr>
      ${CRITERIA.map(c => `<tr><td>${esc(c.label)}</td>${list.map(s => `<td>${s.w[c.k]}</td>`).join('')}</tr>`).join('')}</table>
      <p class="note">Les secteurs présents en tête dans plusieurs scénarios sont des priorités robustes pour le plan d'investissement.</p>`, '', true);
  });

  /* ------------------------------------------------------------------ indicateurs */
  const charts = {};
  function sectorAccess() {
    const a = {};
    for (const c of cells) { const p = c.properties, w = Math.max(p.bati, 1); (a[p.secteur] ||= { s: 0, w: 0 }); a[p.secteur].s += p.d_sante * w; a[p.secteur].w += w; }
    return Object.entries(a).map(([k, v]) => ({ secteur: k, d: v.s / v.w })).sort((x, y) => y.d - x.d);
  }
  function stats(sector) {
    const cs = sector ? cells.filter(c => c.properties.secteur === sector) : cells;
    const bati = cs.reduce((s, c) => s + c.properties.bati, 0) || 1;
    const share = fn => cs.filter(c => fn(c.properties)).reduce((s, c) => s + c.properties.bati, 0) / bati * 100;
    const roads = D.voirie.features.filter(f => !sector || f.properties.secteur === sector);
    const km = {}; roads.forEach(f => { km[f.properties.classe] = (km[f.properties.classe] || 0) + f.properties.len_m / 1000; });
    const surf = {}; roads.forEach(f => { const s = roadUpdates[f.properties.id]?.revetement || surfaceLabel(f.properties.revetement); surf[s] = (surf[s] || 0) + f.properties.len_m / 1000; });
    const etat = {}; roads.forEach(f => { const s = roadUpdates[f.properties.id]?.etat || 'Non renseigné'; etat[s] = (etat[s] || 0) + f.properties.len_m / 1000; });
    return {
      cs, bati, roads, km, surf, etat,
      sante: D.equipements.features.filter(f => f.properties.theme === 'Santé' && (!sector || f.properties.secteur === sector)),
      far2km: share(p => p.d_sante > 2000), far1km: share(p => p.d_sante > 1000),
      flood: share(p => p.inond > 0.6), steep: share(p => p.pente > 15), enclave: share(p => p.d_voirie > 500),
      kmTot: Object.values(km).reduce((a, b) => a + b, 0),
    };
  }
  function updateKPIs() {
    const s = stats();
    $('#kpis').innerHTML = [
      [fmt(s.bati), 'bâtiments recensés (OSM)'], [s.sante.length, 'établissements de santé (GRID3)'],
      [fmt(s.far1km, 0) + ' %', 'du bâti à plus de 1 km d’un centre de santé'], [fmt(s.flood, 0) + ' %', 'du bâti en zone de forte susceptibilité d’inondation'],
      [fmt(s.kmTot, 0) + ' km', 'de voirie cartographiée'], [fmt((s.surf['Revêtue'] || 0) / s.kmTot * 100, 0) + ' %', 'du linéaire déclaré revêtu'],
      [fmt(s.steep, 0) + ' %', 'du bâti sur pente > 15°'], [saisies.length + Object.keys(roadUpdates).length, 'mises à jour par les agents'],
    ].map(([v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    if (!$('#panel-kpi').classList.contains('active')) return;
    const order = Object.keys(ROAD_COLORS);
    charts.roads?.destroy();
    charts.roads = new Chart($('#chart-roads'), {
      type: 'bar', data: { labels: order, datasets: [{ data: order.map(k => +(s.km[k] || 0).toFixed(1)), backgroundColor: order.map(k => ROAD_COLORS[k]), borderRadius: 4 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#eef2f3' } }, y: { grid: { display: false } } } },
    });
    const acc = sectorAccess();
    charts.health?.destroy();
    charts.health = new Chart($('#chart-health'), {
      type: 'bar', data: { labels: acc.map(a => a.secteur), datasets: [{ label: 'Distance moyenne au centre de santé (m)', data: acc.map(a => Math.round(a.d)), backgroundColor: acc.map(a => a.d > 1000 ? '#c8553d' : '#1a6b7f'), borderRadius: 4 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${fmt(c.raw)} m (moyenne pondérée par le bâti)` } } }, scales: { x: { grid: { color: '#eef2f3' }, title: { display: true, text: 'mètres (à vol d’oiseau)' } }, y: { grid: { display: false } } } },
    });
  }

  /* ------------------------------------------------------------------ onglets */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + t.dataset.tab));
    if (t.dataset.tab === 'kpi') updateKPIs();
    if (t.dataset.tab === 'amc' && activeGrid !== 'amc') setLayer('amc', true);
  }));
  $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));

  function zoomSector(name) {
    const cs = cells.filter(c => c.properties.secteur === name);
    const xs = cs.flatMap(c => c.geometry.coordinates[0].map(p => p[0])), ys = cs.flatMap(c => c.geometry.coordinates[0].map(p => p[1]));
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, duration: 800 });
  }

  /* ------------------------------------------------------------------ rapports */
  $('#rep-sector').innerHTML = `<option value="">Ville de Boma (ensemble)</option>` + SECTORS.map(s => `<option>${esc(s)}</option>`).join('');
  $('#btn-report').addEventListener('click', () => generateReport().catch(err => { console.error(err); toast('Erreur lors de la génération du rapport'); }));

  function snapshot(sector) {
    return new Promise(resolve => {
      if (sector) zoomSectorInstant(sector);
      else map.fitBounds([[D.meta.bbox[0], D.meta.bbox[1]], [D.meta.bbox[2], D.meta.bbox[3]]], { padding: 20, duration: 0 });
      let done = false;
      const grab = () => { if (done) return; done = true; resolve(map.getCanvas().toDataURL('image/jpeg', 0.85)); };
      map.once('idle', grab);
      setTimeout(grab, 3000); // tuiles lentes : on capture quand même
      map.triggerRepaint();
    });
  }
  function zoomSectorInstant(name) {
    const cs = cells.filter(c => c.properties.secteur === name);
    const xs = cs.flatMap(c => c.geometry.coordinates[0].map(p => p[0])), ys = cs.flatMap(c => c.geometry.coordinates[0].map(p => p[1]));
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 30, duration: 0 });
  }
  function chartImage(cfg) {
    const cv = document.createElement('canvas'); cv.width = 760; cv.height = 300;
    cv.style.cssText = 'position:fixed;left:-2000px;top:0;width:760px;height:300px';
    document.body.appendChild(cv);
    const ch = new Chart(cv, { ...cfg, options: { ...cfg.options, animation: false, responsive: false, devicePixelRatio: 2 } });
    const url = cv.toDataURL('image/png'); ch.destroy(); cv.remove(); return url;
  }
  const table = (head, rows) => `<table><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

  async function generateReport() {
    const type = $('#rep-type').value, sector = $('#rep-sector').value;
    const perim = sector ? `Secteur ${sector}` : 'Ville de Boma';
    const layerFor = { amc: 'amc', reseaux: null, equip: null, risques: 'inond' }[type];
    const prevGrid = activeGrid, prevView = { center: map.getCenter(), zoom: map.getZoom() };
    if (layerFor) setLayer(layerFor, true); else if (activeGrid) setLayer(activeGrid, false);
    toast('Génération du rapport…');
    const img = await snapshot(sector);
    if (prevGrid) setLayer(prevGrid, true); else if (activeGrid) setLayer(activeGrid, false);
    map.jumpTo(prevView);
    const s = stats(sector);
    const titles = { amc: 'Priorisation des investissements publics', reseaux: 'État des réseaux de voirie', equip: 'Équipements et accessibilité aux services', risques: 'Risques et contraintes' };
    let body = '';
    if (type === 'amc') {
      const list = sector ? sectorScores.filter(x => x.secteur === sector) : sectorScores;
      body = `<h2>1. Paramètres du scénario</h2><p><b>${esc(SCENARIOS[currentScn].name)}</b> — ${esc(SCENARIOS[currentScn].desc)}</p>
        ${table(['Critère', 'Dimension', 'Poids'], CRITERIA.map(c => [esc(c.label), esc(c.cat), weights[c.k]]))}
        <p>Contraintes : ${$('#constraint-slope').checked ? 'pentes > 15° exclues' : 'aucune contrainte de pente'} ; ${$('#constraint-flood').checked ? 'zones de forte susceptibilité d’inondation exclues' : 'zones inondables conservées'}.</p>
        <h2>2. Carte de priorisation</h2><img src="${img}" alt="Carte de priorisation">
        <h2>3. Classement des secteurs</h2>${table(['Rang', 'Secteur', 'Score (0–100)', 'Mailles évaluées'], list.map(x => [sectorScores.indexOf(x) + 1, esc(x.secteur), x.score, x.mailles]))}
        <img src="${chartImage({ type: 'bar', data: { labels: sectorScores.map(x => x.secteur), datasets: [{ data: sectorScores.map(x => x.score), backgroundColor: sectorScores.map(x => x.secteur === sector ? '#e36414' : '#1a6b7f') }] }, options: { plugins: { legend: { display: false } } } })}" alt="">
        <h2>4. Lecture</h2><p>Les secteurs ${sectorScores.slice(0, 3).map(x => `<b>${esc(x.secteur)}</b>`).join(', ')} présentent les besoins les plus élevés au regard des pondérations retenues. Ce classement est un appui à la décision : il doit être confronté aux diagnostics de terrain et aux arbitrages du comité de pilotage.</p>`;
    } else if (type === 'reseaux') {
      const cl = Object.keys(ROAD_COLORS);
      body = `<h2>1. Carte du réseau</h2><img src="${img}" alt="Carte du réseau">
        <h2>2. Linéaire par hiérarchie</h2>${table(['Classe', 'Linéaire (km)', 'Part'], cl.map(k => [k, fmt(s.km[k] || 0, 1), fmt((s.km[k] || 0) / s.kmTot * 100, 0) + ' %']))}
        <img src="${chartImage({ type: 'bar', data: { labels: cl, datasets: [{ data: cl.map(k => s.km[k] || 0), backgroundColor: cl.map(k => ROAD_COLORS[k]) }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } })}" alt="">
        <h2>3. Revêtement et état</h2>${table(['Revêtement', 'km'], Object.entries(s.surf).map(([k, v]) => [k, fmt(v, 1)]))}
        ${table(['État renseigné par les agents', 'km'], Object.entries(s.etat).map(([k, v]) => [k, fmt(v, 1)]))}
        <h2>4. Observations automatiques</h2><ul>
        <li>${fmt((s.surf['Non renseigné'] || 0) / s.kmTot * 100, 0)} % du linéaire n'a pas d'information de revêtement : l'inventaire de terrain de la phase 2 est prioritaire.</li>
        <li>${fmt(s.enclave, 0)} % du bâti est situé à plus de 500 m d'une voie principale ou secondaire.</li></ul>`;
    } else if (type === 'equip') {
      const types = {}; s.sante.forEach(f => { types[f.properties.type] = (types[f.properties.type] || 0) + 1; });
      const acc = sectorAccess().filter(a => !sector || a.secteur === sector);
      body = `<h2>1. Localisation des équipements</h2><img src="${img}" alt="Carte des équipements">
        <h2>2. Offre de soins</h2>${table(['Type d’établissement', 'Nombre'], Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(k), v]))}
        <h2>3. Accessibilité</h2><p>${fmt(s.far1km, 0)} % du bâti est à plus de 1 km d'un établissement de santé et ${fmt(s.far2km, 0)} % à plus de 2 km (distance à vol d'oiseau ; en production, distance sur le réseau via pgRouting).</p>
        ${table(['Secteur', 'Distance moyenne (m)'], acc.map(a => [esc(a.secteur), fmt(a.d)]))}
        <h2>4. Limites des données</h2><p>Les sources ouvertes ne recensent que ${D.equipements.features.filter(f => f.properties.theme === 'Éducation').length} établissements scolaires : l'inventaire exhaustif des équipements est prévu dans la phase de collecte.</p>`;
    } else {
      const rows = (sector ? [sector] : SECTORS).map(sc => { const x = stats(sc); return [esc(sc), fmt(x.bati), fmt(x.flood, 0) + ' %', fmt(x.steep, 0) + ' %']; });
      body = `<h2>1. Carte de susceptibilité aux inondations</h2><img src="${img}" alt="Carte des risques">
        <h2>2. Exposition du bâti</h2><p>${fmt(s.flood, 0)} % du bâti est en zone de forte susceptibilité d'inondation (proxy) et ${fmt(s.steep, 0)} % sur des pentes de plus de 15°, exposées à l'érosion et au ravinement.</p>
        ${table(['Secteur', 'Bâtiments', 'Bâti en zone inondable', 'Bâti sur forte pente'], rows)}
        <h2>3. Recommandations pour la planification</h2><ul><li>Intégrer ces zones comme contraintes dans le zonage réglementaire du PLAT.</li><li>Prioriser le drainage pluvial dans les secteurs cumulant forte densité et forte susceptibilité.</li><li>Remplacer le proxy par la modélisation hydrologique des études (bassins versants, temps de retour).</li></ul>`;
    }
    const html = `<div class="report" id="report"><h1>${titles[type]}</h1><div class="meta">${esc(perim)} · Généré le ${new Date().toLocaleString('fr-FR')} par ${ROLE_LABEL[role]} · Géoportail de Boma</div>
      ${body}<div class="disclaimer">Rapport généré automatiquement à partir des données du géoportail. Sources : OpenStreetMap (ODbL), GRID3 RDC v9.0 (CC BY 4.0), SRTM. Maquette de démonstration : les indicateurs « proxy » seront remplacés par les données des études (PDU, PLAT, SDGDS).</div></div>`;
    openModal('Rapport — ' + titles[type], html, `<button class="btn ghost" id="r-doc">Télécharger (Word)</button><button class="btn primary" id="r-print">Imprimer / PDF</button>`, true);
    $('#r-print').onclick = () => window.print();
    $('#r-doc').onclick = () => {
      const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">
        <style>body{font-family:Calibri,Arial;font-size:11pt}h1{color:#0f4c5c}h2{color:#0f4c5c;border-bottom:2px solid #e36414}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:3px 6px}th{background:#eef2f3}img{width:16cm}</style></head><body>${$('#report').innerHTML}</body></html>`;
      download(new Blob(['﻿' + doc], { type: 'application/msword' }), `rapport_${type}_${(sector || 'boma').replace(/\s+/g, '_')}.doc`);
    };
    log(`Rapport généré : ${titles[type]} (${perim})`);
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ------------------------------------------------------------------ À propos et catalogue */
  function catalogueTable() {
    return `<table class="cat-table"><tr><th>Catégorie</th><th>Couche de données</th><th>Type SIG</th><th>Dans la maquette (sources ouvertes)</th></tr>
      ${CATALOGUE.map(g => g.items.map((i, k) => `<tr>${k === 0 ? `<td class="cat" rowspan="${g.items.length}">${esc(g.cat)}</td>` : ''}
        <td>${esc(i.label)}</td><td>${esc(i.type)}</td>
        <td>${i.basemap ? `<span class="st-ok">Aperçu</span> : ${esc(i.src)}` : isTodo(i) ? '<span class="st-todo">À intégrer depuis la collecte de phase 1</span>'
          : `<span class="st-ok">Aperçu, ${i.id === 'mnt' ? '1 raster' : i.count + (i.count > 1 ? ' objets' : ' objet')}</span> : ${esc(i.src)}`}</td></tr>`).join('')).join('')}</table>`;
  }
  function openAbout(toCatalogue) {
    openModal('À propos du Géoportail de Boma', `<div class="about">
      <div class="about-logos"><img src="img/logo-mairie-boma.jpg" alt="Mairie de Boma"><img src="img/logo-anat.png" alt="ANAT"><img src="img/logo-expertise-france.png" alt="Expertise France, Groupe AFD"></div>
      <h4>Le géoportail</h4>
      <p>Le Géoportail de Boma centralise les données géographiques des études urbaines de la ville (PDU, PLAT, SDGDS) et en fait un outil d'aide à la décision : consultation par thème, mise à jour guidée par les agents, analyse multicritère pour prioriser les investissements publics et rapports automatiques.</p>
      <p>Il s'adresse aux services techniques de la Mairie de Boma et de l'ANAT, qui disposent d'un accès administrateur, et aux partenaires (bailleurs, ONG, services techniques), en consultation.</p>
      <h4>Qui sommes-nous</h4>
      <p>La solution est propulsée par <b>Urban Analyse</b>, bureau d'études titulaire de la mission. Elle est conçue en logiciels libres (PostgreSQL/PostGIS, QGIS, services OGC) pour que la Mairie et l'ANAT en gardent la pleine maîtrise.</p>
      <p>Contact : <a href="mailto:ridaazmi@gmail.com">ridaazmi@gmail.com</a></p>
      <h4 id="about-catalogue">Catalogue des données collectées en phase 1</h4>
      <p>Les couches ci-dessous ont été collectées lors de la phase 1. Elles seront structurées dans la base de données et publiées dans le géoportail. Dans cette maquette, chaque couche est illustrée, quand c'est possible, par des données ouvertes (OpenStreetMap, Overture Maps, GRID3, SRTM).</p>
      ${catalogueTable()}
      <p class="note">Maquette de démonstration non officielle, réalisée à partir de données ouvertes. Les informations affichées ne remplacent pas les données de la collecte ni les documents officiels.</p>
    </div>`, '', true);
    if (toCatalogue) setTimeout(() => $('#about-catalogue')?.scrollIntoView({ behavior: 'smooth' }), 60);
  }
  $('#btn-about').addEventListener('click', () => openAbout(false));
  $('#foot-about').addEventListener('click', e => { e.preventDefault(); openAbout(false); });
  $('#foot-catalogue').addEventListener('click', e => { e.preventDefault(); openAbout(true); });
  $('#link-catalogue').addEventListener('click', e => { e.preventDefault(); openAbout(true); });

  /* ------------------------------------------------------------------ OGC / QGIS */
  $('#btn-ogc').addEventListener('click', () => {
    const base = 'https://geoportail-boma.example/geoserver/ows';
    const LAYERS = { voirie: D.voirie, equipements: D.equipements, hydrographie: D.hydro, secteurs: D.secteurs, grille_criteres: D.grille, saisies: saisiesFC() };
    openModal('Services OGC et interopérabilité QGIS', `
      <p>En production, toutes les couches sont publiées par GeoServer selon les standards OGC. Elles s'ouvrent directement dans QGIS, ArcGIS ou tout autre logiciel compatible.</p>
      <b>WMS (cartes)</b><div class="code">${base}?service=WMS&amp;request=GetCapabilities</div>
      <b>WFS (données vecteur)</b><div class="code">${base}?service=WFS&amp;version=2.0.0&amp;request=GetCapabilities</div>
      <b>WCS (rasters : MNT, orthophotos)</b><div class="code">${base}?service=WCS&amp;version=2.0.1&amp;request=GetCapabilities</div>
      <p><b>Dans QGIS :</b> Couche › Ajouter une couche › Ajouter une couche WMS/WFS › Nouvelle connexion › coller l'adresse. Les administrateurs se connectent aussi directement à la base PostGIS (VPN).</p>
      <h4>Exporter les données (GeoJSON, EPSG:4326)</h4>
      <div class="row gap" style="flex-wrap:wrap">${Object.keys(LAYERS).map(k => `<button class="btn" data-dl="${k}">${k}</button>`).join('')}</div>
      <p class="note">Les adresses ci-dessus sont illustratives (serveur de production à déployer). Les exports fonctionnent dès maintenant.</p>`);
    $$('[data-dl]').forEach(b => b.addEventListener('click', () => {
      download(new Blob([JSON.stringify(LAYERS[b.dataset.dl])], { type: 'application/geo+json' }), `boma_${b.dataset.dl}.geojson`);
      log(`Export GeoJSON : ${b.dataset.dl}`);
    }));
  });

  /* ------------------------------------------------------------------ visite guidée */
  function startTour() {
    const drv = window.driver.js.driver({
      showProgress: true, nextBtnText: 'Suivant', prevBtnText: 'Précédent', doneBtnText: 'Terminer', progressText: '{{current}} / {{total}}',
      onDestroyed: () => LS.set('boma_tour_done', true),
      steps: [
        { popover: { title: 'Bienvenue sur le Géoportail de Boma', description: "Cette maquette montre les fonctions clés de l'outil d'aide à la décision : consultation, mise à jour guidée, analyse multicritère et rapports automatiques." } },
        { element: '#role', popover: { title: "Profils d'accès", description: 'Administrateurs (Mairie, ANAT) : édition complète. Partenaires : consultation en lecture seule.' } },
        { element: '#tab-layers', popover: { title: 'Couches thématiques', description: 'Mobilité, équipements, habitat, risques, déchets… Cliquez sur un objet de la carte pour ouvrir sa fiche.' } },
        { element: '#tab-amc', popover: { title: 'Analyse multicritère', description: 'Choisissez un scénario ou ajustez les poids des critères (sociaux, environnementaux, climatiques, genre et inclusion). La carte et le classement des secteurs se mettent à jour instantanément.' } },
        { element: '#btn-add', popover: { title: 'Saisie guidée', description: 'Formulaire pas à pas avec des champs préremplis (date, secteur, voie la plus proche) pour mettre à jour les données.' } },
        { element: '#tab-reports', popover: { title: 'Rapports automatiques', description: 'Rapports thématiques prêts à imprimer ou à modifier sous Word, par secteur ou pour toute la ville.' } },
        { element: '#btn-about', popover: { title: 'À propos', description: 'Présentation du géoportail, des partenaires et du catalogue des données collectées en phase 1.' } },
        { element: '#btn-ogc', popover: { title: 'Interopérabilité', description: 'Services WMS / WFS / WCS pour QGIS et les logiciels tiers, et export des données.' } },
      ],
    });
    drv.drive();
  }
  $('#btn-tour').addEventListener('click', startTour);

  /* ------------------------------------------------------------------ init */
  applyScenario('equip');
  renderSaved();
  renderJournal();
  updateKPIs();
})();
