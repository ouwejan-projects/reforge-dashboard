/* Zegveld, module "verkeer": rendert in #mod-verkeer. Drie delen: een eigen tegelkaart (PDOK BRT-achtergrondkaart,
   geen bibliotheek), rijomstandigheden voor de komende 12 uur (Open-Meteo, geen sleutel, CORS *) en links naar live verkeersinfo.
   Het iframe heeft een opaque origin: dus geen localStorage/cookies/klembord; alles blijft in het geheugen.
   Opbouw: eerst zuivere functies (geen DOM; testbaar in node via module.exports), dan de DOM-laag. */
(function () {
  'use strict';

  var TILE_URL = 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png';
  var TILE = 256;                          // tegelgrootte in pixels (Web Mercator)
  var ZOOM_MIN = 10;
  var ZOOM_MAX = 18;
  var ZOOM_START = 12;
  var HOME = { lat: 52.117, lon: 4.838 };  // midden Zegveld
  var PAN_KEY_PX = 100;                    // pijltjestoets = zoveel pixels schuiven
  var WHEEL_STEP = 40;                     // opgetelde wieldelta die één zoomniveau waard is
  var WHEEL_PAUSE_MS = 300;                // na een zoomstap even niets: één pinch = één niveau
  var WHEEL_GAP_MS = 200;                  // langere stilte = nieuwe beweging, teller opnieuw

  var API_URL = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=52.117&longitude=4.838&timezone=Europe%2FAmsterdam&forecast_days=2&wind_speed_unit=kmh' +
    '&current=temperature_2m' +
    '&hourly=temperature_2m,precipitation,weather_code,wind_gusts_10m,visibility';
  var REFRESH_MS = 15 * 60 * 1000;
  var TIMEOUT_MS = 10 * 1000;
  var HOURS = 12;                          // venster: het huidige uur + 11 uren erna
  var HOURLY_VARS = ['temperature_2m', 'precipitation', 'weather_code', 'wind_gusts_10m', 'visibility'];

  // Links naar buiten. Elke regel: naam (link) + korte omschrijving.
  var LINKS = [
    { name: 'ANWB Verkeersinfo', desc: 'files, flitsers en werkzaamheden', url: 'https://www.anwb.nl/verkeer' },
    { name: 'Waze live-kaart', desc: 'meldingen rond Zegveld', url: 'https://www.waze.com/live-map/?ll=52.117,4.838&zoom=13' },
    { name: 'Google Maps', desc: 'verkeersdrukte rond Zegveld', url: 'https://www.google.com/maps/@52.117,4.838,13z/data=!5m1!1e1' },
    { name: 'Melvin (NDW)', desc: 'wegwerkzaamheden en evenementen', url: 'https://melvin.ndw.nu/public' },
    { name: 'Rijkswaterstaat', desc: 'verkeersinformatie en werkzaamheden', url: 'https://www.rijkswaterstaat.nl/wegen/verkeersinformatie-en-werkzaamheden' }
  ];

  var MAX_LAT = 85.0511287798;             // grens van Web Mercator

  /* ================= Zuivere hulpfuncties: kaart ================= */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function worldSize(z) { return TILE * Math.pow(2, z); }

  // lon/lat (graden) -> wereldpixels bij zoomniveau z. (0,0) = linksboven (noordwest), x naar rechts, y naar beneden.
  function lonLatToWorld(lon, lat, z) {
    var size = worldSize(z);
    var s = Math.sin(clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180);
    return {
      x: (lon + 180) / 360 * size,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size
    };
  }

  // Wereldpixels bij zoomniveau z -> lon/lat (graden); het omgekeerde van lonLatToWorld.
  function worldToLonLat(x, y, z) {
    var size = worldSize(z);
    var n = Math.PI * (1 - 2 * y / size);
    return {
      lon: x / size * 360 - 180,
      lat: Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI
    };
  }

  // Middelpunt (wereldpixels) binnen de wereld houden: geen kaart voorbij de rand.
  function clampCenter(cx, cy, z) {
    var size = worldSize(z);
    return { x: clamp(cx, 0, size), y: clamp(cy, 0, size) };
  }

  // Wereldpixel van de linkerbovenhoek van een viewport w×h rond (cx, cy). Afgerond, zodat alle tegels
  // op hele pixels staan (geen naden) en de markering dezelfde oorsprong gebruikt.
  function viewOrigin(cx, cy, w, h) {
    return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2) };
  }

  // Tegels voor een viewport w×h rond middelpunt (cx, cy) in wereldpixels bij zoom z. margin = extra tegels rondom
  // (0 = alleen wat zichtbaar is). Elke tegel: { z, x, y, left, top, visible }; left/top = pixels vanaf de linkerbovenhoek
  // van de viewport, visible = raakt de viewport echt. Gesorteerd van midden naar rand (midden laadt eerst).
  function tilesForViewport(cx, cy, z, w, h, margin) {
    var out = [];
    if (!(w > 0) || !(h > 0)) return out;
    margin = margin || 0;
    var n = Math.pow(2, z);
    var o = viewOrigin(cx, cy, w, h);
    var x0 = Math.floor(o.x / TILE) - margin, x1 = Math.floor((o.x + w - 1) / TILE) + margin;
    var y0 = Math.floor(o.y / TILE) - margin, y1 = Math.floor((o.y + h - 1) / TILE) + margin;
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (tx < 0 || tx >= n || ty < 0 || ty >= n) continue;   // buiten de wereld: geen tegel
        var left = tx * TILE - o.x, top = ty * TILE - o.y;
        out.push({
          z: z, x: tx, y: ty, left: left, top: top,
          visible: left < w && left + TILE > 0 && top < h && top + TILE > 0
        });
      }
    }
    function dist(t) {
      var dx = t.left + TILE / 2 - w / 2, dy = t.top + TILE / 2 - h / 2;
      return dx * dx + dy * dy;
    }
    out.sort(function (a, b) { return dist(a) - dist(b); });
    return out;
  }

  // Nieuw middelpunt (wereldpixels bij newZ) als we van zoom z naar newZ gaan en het punt onder (px, py)
  // (pixels in de viewport w×h) op zijn plek moeten blijven.
  function zoomCenter(cx, cy, z, newZ, px, py, w, h) {
    var f = Math.pow(2, newZ - z);
    var wx = cx - w / 2 + px, wy = cy - h / 2 + py;
    return { x: wx * f - px + w / 2, y: wy * f - py + h / 2 };
  }

  // Scrollwiel/pinch -> zoomstappen. Geeft een functie (deltaY, nowMs) -> +1 (inzoomen), -1 (uitzoomen) of 0.
  // Telt delta's op tot een drempel en wacht na elke stap even, zodat één pinch niet meerdere niveaus springt.
  function makeWheelStepper() {
    var acc = 0, lastEvent = -Infinity, lastStep = -Infinity;
    return function (dy, now) {
      if (now - lastEvent > WHEEL_GAP_MS) acc = 0;
      lastEvent = now;
      if (now - lastStep < WHEEL_PAUSE_MS) return 0;
      if (acc * dy < 0) acc = 0;               // andere richting: opnieuw tellen
      acc += dy;
      if (Math.abs(acc) < WHEEL_STEP) return 0;
      var dir = acc < 0 ? 1 : -1;              // omhoog scrollen/uit elkaar knijpen = inzoomen
      acc = 0;
      lastStep = now;
      return dir;
    };
  }

  function tileUrl(z, x, y) {
    return TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  /* ================= Zuivere hulpfuncties: rijomstandigheden ================= */

  // Volgorde van de regels in de uitvoer.
  var CAT_ORDER = ['ijzel', 'sneeuw', 'glad', 'onweer', 'mist', 'wind', 'regen', 'vorst'];
  var ICONS = {
    ijzel: '🧊', sneeuw: '🌨️', glad: '⚠️', onweer: '⛈️', mist: '🌫️', wind: '💨', regen: '🌧️', vorst: '❄️', geen: '✅'
  };
  var CODES_IJZEL = [56, 57, 66, 67];
  var CODES_SNEEUW = [71, 73, 75, 77, 85, 86];
  var CODES_MIST = [45, 48];
  var CODES_ONWEER = [95, 96, 99];
  var CODES_ZWARE_REGEN = [65, 82];
  var NO_NEWS = 'Geen bijzonderheden verwacht';

  var RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // Open-Meteo-tijden zijn lokale tijd zonder offset ("2026-10-29T15:00"): nooit via Date parsen.
  var RE_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function at(arr, i) { return Array.isArray(arr) && i >= 0 && i < arr.length ? arr[i] : null; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function num(v) { return isNum(v) ? v : null; }
  function nonNeg(v) { return isNum(v) && v >= 0 ? v : null; }   // neerslag, windstoten en zicht kunnen niet negatief zijn
  function inList(list, v) { return isNum(v) && list.indexOf(v) >= 0; }

  // Fouten met een soort, zodat de UI er een passende Nederlandse tekst bij kan zetten.
  function fail(kind, message) {
    var e = new Error(message || kind);
    e.kind = kind;
    return e;
  }

  // "YYYY-MM-DD" -> kalenderdatum (via UTC-rekenen, dus onafhankelijk van tijdzone/zomertijd). null bij ongeldig.
  function parseDate(s) {
    var m = typeof s === 'string' ? RE_DATE.exec(s) : null;
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d, ms: t.getTime() };
  }

  function addDays(dateStr, n) {
    var p = parseDate(dateStr);
    if (!p) return null;
    var t = new Date(p.ms + n * 86400000);
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }

  // "2026-10-29T15:00" -> { date, hh, mm, key } (key = vergelijkbaar als string); null bij ongeldig.
  function parseLocal(s) {
    var m = typeof s === 'string' ? RE_LOCAL.exec(s) : null;
    if (!m || !parseDate(m[1]) || +m[2] > 23 || +m[3] > 59) return null;
    return { date: m[1], hh: +m[2], mm: +m[3], key: m[1] + 'T' + m[2] + ':' + m[3] };
  }

  function fmtDecimal(v) { return String(Math.round(v * 10) / 10).replace('.', ','); }

  // Bijgewerkt-tijd (HH:MM) in Nederlandse tijd, ook als de browser in een andere tijdzone staat.
  function fmtClock(date) {
    try {
      return new Intl.DateTimeFormat('nl-NL', {
        timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).format(date);
    } catch (e) {
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }
  }

  // Regels voor één uur. Invoer: { temp (°C), precip (mm), code (WMO), gusts (km/u), vis (m) }; null/ongeldig telt niet mee.
  // Uitvoer: lijst { cat, rank, text, value } in vaste volgorde. rank = ernst binnen een categorie (hoogste tekst wint);
  // value = getal voor de "(tot …)"-toelichting (windstoot, neerslag) of null.
  function hourConditions(u) {
    u = u || {};
    var t = num(u.temp), p = nonNeg(u.precip), v = nonNeg(u.vis);
    var c = num(u.code);
    var g = nonNeg(u.gusts);
    if (g !== null) g = Math.round(g);   // eerst afronden: getoonde km/u en de drempel spreken elkaar nooit tegen
    var out = [];

    var ijzel = inList(CODES_IJZEL, c);
    var sneeuw = inList(CODES_SNEEUW, c);
    var glad = !ijzel && !sneeuw && t !== null && p !== null && t <= 1 && p > 0;
    var onweer = inList(CODES_ONWEER, c);
    var vorst = !ijzel && !sneeuw && !glad && t !== null && t <= 0;

    if (ijzel) out.push({ cat: 'ijzel', rank: 1, text: 'IJzel', value: null });
    if (sneeuw) out.push({ cat: 'sneeuw', rank: 1, text: 'Sneeuw', value: null });
    if (glad) out.push({ cat: 'glad', rank: 1, text: 'Kans op gladheid', value: null });
    if (onweer) out.push({ cat: 'onweer', rank: 1, text: 'Onweer', value: null });
    if ((v !== null && v < 1000) || inList(CODES_MIST, c)) {
      var dicht = v !== null && v < 200;
      out.push({ cat: 'mist', rank: dicht ? 2 : 1, text: dicht ? 'Dichte mist' : 'Mist', value: null });
    }
    if (g !== null && g >= 60) {
      var zwaar = g >= 75;
      out.push({ cat: 'wind', rank: zwaar ? 2 : 1, text: zwaar ? 'Zware windstoten' : 'Harde windstoten', value: g });
    }
    if (!onweer && ((p !== null && p >= 4) || inList(CODES_ZWARE_REGEN, c))) {
      out.push({ cat: 'regen', rank: 1, text: 'Zware regen', value: p });
    }
    if (vorst) out.push({ cat: 'vorst', rank: 1, text: 'Vorst: kans op gladheid door opvriezing', value: null });
    return out;
  }

  // Periode in woorden: eerste t/m laatste slot (index in slots). Eindtijd = laatste uur + 1 (werkt over middernacht).
  function periodText(slots, first, last) {
    var n = slots.length;
    if (first === 0 && last === n - 1 && n === HOURS) return 'de komende ' + HOURS + ' uur';
    var end = pad2((slots[last].hh + 1) % 24) + ':00';
    if (first === 0) return 'nu tot ' + end;
    return 'tussen ' + pad2(slots[first].hh) + ':00 en ' + end;
  }

  function detailText(cat, max) {
    if (max === null) return '';
    if (cat === 'wind') return '(tot ' + Math.round(max) + ' km/u)';
    if (cat === 'regen' && max > 0) return '(tot ' + fmtDecimal(max) + ' mm/u)';
    return '';
  }

  // Uurslots [{ hh, cond }] -> regels, één per categorie met periode van eerste t/m laatste uur waarin die geldt.
  // Geen enkele regel actief: één regel "Geen bijzonderheden verwacht".
  function summarize(slots) {
    var lines = [];
    CAT_ORDER.forEach(function (cat) {
      var first = -1, last = -1, best = null, max = null;
      slots.forEach(function (s, i) {
        s.cond.forEach(function (c) {
          if (c.cat !== cat) return;
          if (first < 0) first = i;
          last = i;
          if (!best || c.rank > best.rank) best = c;
          if (c.value !== null && (max === null || c.value > max)) max = c.value;
        });
      });
      if (first < 0) return;
      var detail = detailText(cat, max);
      var period = periodText(slots, first, last);
      lines.push({
        cat: cat, icon: ICONS[cat], text: best.text, detail: detail, period: period,
        line: best.text + (detail ? ' ' + detail : '') + ' ' + period
      });
    });
    if (lines.length === 0) {
      lines.push({ cat: 'geen', icon: ICONS.geen, text: NO_NEWS, detail: '', period: '', line: NO_NEWS });
    }
    return lines;
  }

  // Open-Meteo-respons -> { slots, lines }. Gooit een fout (kind 'data') bij een onbruikbare respons.
  function buildModel(json) {
    if (!isObj(json) || !isObj(json.current) || !isObj(json.hourly)) throw fail('data', 'ontbrekende velden');
    var hr = json.hourly;
    var nowP = parseLocal(json.current.time);
    if (!nowP) throw fail('data', 'ontbrekende velden (current)');
    if (!Array.isArray(hr.time) || !HOURLY_VARS.some(function (k) { return Array.isArray(hr[k]); })) {
      throw fail('data', 'ontbrekende velden (hourly)');
    }

    // Venster begint bij het uur waarin de meting valt (hh:00) en loopt door tot 12 opeenvolgende uren.
    var startKey = nowP.date + 'T' + pad2(nowP.hh) + ':00';
    var i0 = -1;
    for (var i = 0; i < hr.time.length && i0 < 0; i++) {
      var p = parseLocal(hr.time[i]);
      if (p && p.key === startKey) i0 = i;
    }
    if (i0 < 0) throw fail('data', 'huidig uur ontbreekt');

    var slots = [];
    for (var k = 0; k < HOURS; k++) {
      var q = parseLocal(at(hr.time, i0 + k));
      var abs = nowP.hh + k;
      var expect = addDays(nowP.date, Math.floor(abs / 24)) + 'T' + pad2(abs % 24) + ':00';
      if (!q || q.key !== expect) break;   // gat of rommel in de uren: liever korter venster dan verkeerde tijden
      slots.push({
        hh: q.hh,
        cond: hourConditions({
          temp: at(hr.temperature_2m, i0 + k),
          precip: at(hr.precipitation, i0 + k),
          code: at(hr.weather_code, i0 + k),
          gusts: at(hr.wind_gusts_10m, i0 + k),
          vis: at(hr.visibility, i0 + k)
        })
      });
    }
    return { slots: slots.length, lines: summarize(slots) };
  }

  // Fout -> Nederlandse tekst voor de gebruiker.
  function describeError(e, timedOut) {
    if (timedOut || (e && e.name === 'AbortError')) return 'De weerdienst reageert niet. Probeer het zo nog eens.';
    if (e && e.kind === 'http') return 'De weerdienst gaf een foutmelding (' + e.message + ').';
    if (e && (e.kind === 'data' || e.name === 'SyntaxError')) return 'De weerdienst gaf een onverwacht antwoord.';
    return 'Geen verbinding met de weerdienst. Controleer de internetverbinding.';
  }

  /* ================= Zuivere hulpfuncties: links ================= */

  function isApplePlatform(platform, userAgent) {
    return /Mac|iPhone|iPad/.test(platform || '') || /Mac|iPhone|iPad/.test(userAgent || '');
  }

  function hintText(apple) {
    return 'Openen: ' + (apple ? '⌘-klik' : 'Ctrl-klik') + ', of rechtsklik → Link openen in nieuw tabblad. ' +
      'Een gewone klik werkt hier niet: deze sites draaien niet in het afgeschermde Maatwerk-venster.';
  }

  /* ================= DOM-laag ================= */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- Kaart ----

  function buildKaart() {
    var el = h('div', 'kaart');
    el.tabIndex = 0;
    el.setAttribute('role', 'application');
    el.setAttribute('aria-label', 'Kaart rond Zegveld');
    var uitleg = h('span', 'sr-only', 'Pijltjestoetsen verschuiven de kaart, plus en min zoomen, nul gaat terug naar Zegveld.');
    uitleg.id = 'mod-verkeer-kaart-uitleg';
    el.setAttribute('aria-describedby', uitleg.id);

    // De filter (donker thema) staat op deze laag, niet op elke tegel: één gefilterd vlak is goedkoper dan dertig.
    var laag = h('div', 'kaart-tegels');

    var punt = h('div', 'kaart-punt');
    punt.setAttribute('aria-hidden', 'true');
    punt.appendChild(h('span', 'kaart-punt-stip'));
    punt.appendChild(h('span', 'kaart-punt-label', 'Zegveld'));

    // Fout: geen enkele zichtbare tegel laadt.
    var fout = h('div', 'kaart-fout');
    fout.setAttribute('role', 'status');
    fout.hidden = true;
    fout.appendChild(h('p', null, 'Kaart kon niet laden'));
    var opnieuw = h('button', 'btn', 'Opnieuw');
    opnieuw.type = 'button';
    fout.appendChild(opnieuw);

    function knop(tekst, label, cls) {
      var b = h('button', 'kaart-knop' + (cls ? ' ' + cls : ''), tekst);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      return b;
    }
    var knoppen = h('div', 'kaart-knoppen');
    var plus = knop('+', 'Inzoomen', 'kaart-knop--symbool');
    var min = knop('−', 'Uitzoomen', 'kaart-knop--symbool');
    var thuis = knop('Zegveld', 'Terug naar Zegveld');
    knoppen.appendChild(plus);
    knoppen.appendChild(min);
    knoppen.appendChild(thuis);

    var bron = h('div', 'kaart-bron', '© Kadaster / PDOK');

    [uitleg, laag, punt, fout, bron, knoppen].forEach(function (n) { el.appendChild(n); });

    var view = { z: ZOOM_START, x: 0, y: 0 };   // middelpunt in wereldpixels bij zoom view.z
    var tegels = {};                              // 'z/x/y' -> { img, status: 'laden' | 'ok' | 'fout', visible }
    var frame = 0;
    var stepper = makeWheelStepper();

    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(function () { frame = 0; render(); });
    }
    function setCenter(x, y) {
      var c = clampCenter(x, y, view.z);
      view.x = c.x;
      view.y = c.y;
      schedule();
    }
    function goHome() {
      var c = lonLatToWorld(HOME.lon, HOME.lat, ZOOM_START);
      view.z = ZOOM_START;
      setCenter(c.x, c.y);
    }
    // Zoom naar een heel niveau; het punt onder (px, py) blijft onder de cursor.
    function zoomAt(px, py, newZ) {
      newZ = clamp(newZ, ZOOM_MIN, ZOOM_MAX);
      if (newZ === view.z) return;
      var c = zoomCenter(view.x, view.y, view.z, newZ, px, py, el.clientWidth, el.clientHeight);
      view.z = newZ;
      setCenter(c.x, c.y);
    }
    function zoomMidden(delta) { zoomAt(el.clientWidth / 2, el.clientHeight / 2, view.z + delta); }
    // Pixelpositie van een muisgebeurtenis binnen de kaart (zonder rand).
    function lokaal(e) {
      var r = el.getBoundingClientRect();
      return { x: e.clientX - r.left - el.clientLeft, y: e.clientY - r.top - el.clientTop };
    }

    function maakTegel(key, t) {
      var img = document.createElement('img');
      var rec = { img: img, status: 'laden', visible: false };
      img.className = 'tegel';
      img.alt = '';
      img.draggable = false;
      img.width = img.height = TILE;
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.onload = function () {
        if (tegels[key] !== rec) return;
        rec.status = 'ok';
        img.classList.add('is-geladen');
        controleerFout();
      };
      img.onerror = function () {
        if (tegels[key] !== rec) return;
        rec.status = 'fout';
        img.classList.add('is-fout');   // losse tegel: verbergen, de achtergrond (--cell) schemert door
        controleerFout();
      };
      img.src = tileUrl(t.z, t.x, t.y);
      laag.appendChild(img);
      return rec;
    }

    // Foutmelding tonen als er zichtbare tegels zijn en geen enkele is geladen of nog onderweg.
    function controleerFout() {
      var zichtbaar = 0, ok = 0, laden = 0;
      Object.keys(tegels).forEach(function (k) {
        var r = tegels[k];
        if (!r.visible) return;
        zichtbaar++;
        if (r.status === 'ok') ok++;
        else if (r.status === 'laden') laden++;
      });
      fout.hidden = !(zichtbaar > 0 && ok === 0 && laden === 0);
    }

    function zetKnop(b, uit) {
      if (uit && !b.disabled && document.activeElement === b) el.focus();   // focus niet kwijtraken in het niets
      b.disabled = uit;
    }

    function render() {
      var w = el.clientWidth, hh = el.clientHeight;
      if (!w || !hh) return;   // nog niet zichtbaar; ResizeObserver roept ons opnieuw aan
      var want = tilesForViewport(view.x, view.y, view.z, w, hh, 1);
      var keep = {};
      want.forEach(function (t) {
        var key = t.z + '/' + t.x + '/' + t.y;
        keep[key] = true;
        var rec = tegels[key];
        if (!rec) rec = tegels[key] = maakTegel(key, t);
        rec.visible = t.visible;
        rec.img.style.transform = 'translate(' + t.left + 'px,' + t.top + 'px)';
      });
      Object.keys(tegels).forEach(function (key) {
        if (keep[key]) return;
        laag.removeChild(tegels[key].img);
        delete tegels[key];
      });

      var o = viewOrigin(view.x, view.y, w, hh);
      var hw = lonLatToWorld(HOME.lon, HOME.lat, view.z);
      punt.style.transform = 'translate(' + Math.round(hw.x - o.x) + 'px,' + Math.round(hw.y - o.y) + 'px)';

      zetKnop(plus, view.z >= ZOOM_MAX);
      zetKnop(min, view.z <= ZOOM_MIN);
      controleerFout();
    }

    // Alle tegels weggooien en opnieuw opvragen (knop Opnieuw).
    function opnieuwLaden() {
      Object.keys(tegels).forEach(function (key) {
        laag.removeChild(tegels[key].img);
        delete tegels[key];
      });
      fout.hidden = true;
      schedule();
    }

    // Slepen (muis, aanraking, pen) met pointer events.
    var drag = null;
    el.addEventListener('pointerdown', function (e) {
      if (drag || e.target.tagName === 'BUTTON') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: view.x, cy: view.y };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer bestaat niet meer */ }
      el.classList.add('is-slepen');
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      setCenter(drag.cx - (e.clientX - drag.x), drag.cy - (e.clientY - drag.y));
    });
    function eindeDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.classList.remove('is-slepen');
    }
    el.addEventListener('pointerup', eindeDrag);
    el.addEventListener('pointercancel', eindeDrag);
    el.addEventListener('lostpointercapture', eindeDrag);

    // Dubbelklik: inzoomen rond dat punt.
    el.addEventListener('dblclick', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      var p = lokaal(e);
      zoomAt(p.x, p.y, view.z + 1);
    });

    // ⌘/Ctrl + wiel (ook trackpad-pinch, die geeft ctrlKey): zoomen rond de cursor. Zonder toets scrollt de pagina gewoon.
    el.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      var stap = stepper(dy, Date.now());
      if (stap) {
        var p = lokaal(e);
        zoomAt(p.x, p.y, view.z + stap);
      }
    }, { passive: false });

    // Toetsenbord (alleen als de kaart zelf focus heeft): pijltjes = 100 px schuiven, +/- = zoom, 0 = terug naar Zegveld.
    el.addEventListener('keydown', function (e) {
      if (e.target !== el || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowLeft': setCenter(view.x - PAN_KEY_PX, view.y); break;
        case 'ArrowRight': setCenter(view.x + PAN_KEY_PX, view.y); break;
        case 'ArrowUp': setCenter(view.x, view.y - PAN_KEY_PX); break;
        case 'ArrowDown': setCenter(view.x, view.y + PAN_KEY_PX); break;
        case '+': case '=': zoomMidden(1); break;
        case '-': case '_': zoomMidden(-1); break;
        case '0': goHome(); break;
        default: return;
      }
      e.preventDefault();
    });

    plus.addEventListener('click', function () { zoomMidden(1); });
    min.addEventListener('click', function () { zoomMidden(-1); });
    thuis.addEventListener('click', goHome);
    opnieuw.addEventListener('click', opnieuwLaden);

    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(el);
    else window.addEventListener('resize', schedule);

    goHome();
    return el;
  }

  // ---- Links naar buiten ----

  // Link in het afgeschermde Maatwerk-venster. Een gewone klik opent een tabblad dat de afscherming erft (kapotte
  // site) of laat dit venster zelf wegnavigeren; ⌘/Ctrl/Shift-klik en middenklik openen wel een normaal tabblad.
  // Dus: bij een gewone klik (ook Enter) niets openen maar de hint laten opvallen; de rest laten we aan de browser.
  function externalLink(url, text, cls, onPlainClick) {
    var a = h('a', cls, text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      onPlainClick();
    });
    return a;
  }

  // Hint onder de lijst: altijd zichtbaar; bij een gewone klik even gemarkeerd en opnieuw voorgelezen.
  function buildHint() {
    var apple = typeof navigator !== 'undefined' && isApplePlatform(navigator.platform, navigator.userAgent);
    var tekst = hintText(apple);
    var el = h('p', 'hint', tekst);
    var melding = h('span', 'sr-only');   // schermlezer: leeg maken en weer vullen, zodat het opnieuw wordt voorgelezen
    melding.setAttribute('role', 'status');
    melding.setAttribute('aria-live', 'polite');
    var uit = 0;
    function laatOpvallen() {
      el.classList.add('is-opvallend');
      clearTimeout(uit);
      uit = setTimeout(function () { el.classList.remove('is-opvallend'); }, 3000);
      melding.textContent = '';
      setTimeout(function () { melding.textContent = tekst; }, 50);
    }
    return { el: el, melding: melding, laatOpvallen: laatOpvallen };
  }

  // ---- Rijomstandigheden ----

  function renderRijden(box, m) {
    clear(box);
    var lijst = h('ul', 'rijregels');
    m.lines.forEach(function (l) {
      var li = h('li', 'rijregel' + (l.cat === 'geen' ? ' rijregel--geen' : ''));
      var icon = h('span', 'rijregel-icon', l.icon);
      icon.setAttribute('aria-hidden', 'true');
      var tekst = h('span', 'rijregel-tekst');
      tekst.appendChild(h('strong', null, l.text));
      if (l.detail) tekst.appendChild(document.createTextNode(' ' + l.detail));
      if (l.period) {
        tekst.appendChild(document.createTextNode(' '));
        tekst.appendChild(h('span', 'rijregel-tijd', l.period));
      }
      li.appendChild(icon);
      li.appendChild(tekst);
      lijst.appendChild(li);
    });
    box.appendChild(lijst);
    box.appendChild(h('p', 'noot', 'Indicatie uit de weersverwachting, geen officiële waarschuwing.'));
  }

  function init() {
    var root = document.getElementById('mod-verkeer');
    if (!root) return;
    clear(root);
    root.setAttribute('aria-labelledby', 'mod-verkeer-titel');

    // Kop
    var kop = h('header', 'module-head');
    var titel = h('h2', 'module-title', 'Verkeer');
    titel.id = 'mod-verkeer-titel';
    var badge = h('span', 'badge', 'verouderd');
    badge.hidden = true;
    kop.appendChild(titel);
    kop.appendChild(badge);

    var inhoud = h('div', 'verkeer');

    // 1. Kaart
    inhoud.appendChild(buildKaart());

    // 2. Rijomstandigheden: eigen laad-/foutstatus, zodat de kaart er nooit van afhangt
    var sectieR = h('div', 'sectie');
    sectieR.appendChild(h('h3', 'section-title', 'Rijomstandigheden komende ' + HOURS + ' uur'));
    var status = h('div', 'status status--compact');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var statusTekst = h('p', null, 'Weersverwachting ophalen…');
    var spinner = h('div', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    var opnieuw = h('button', 'btn', 'Opnieuw');
    opnieuw.type = 'button';
    status.appendChild(spinner);
    status.appendChild(statusTekst);
    status.appendChild(opnieuw);
    var rijden = h('div', 'rijden');
    rijden.hidden = true;
    sectieR.appendChild(status);
    sectieR.appendChild(rijden);
    inhoud.appendChild(sectieR);

    // 3. Live verkeersinfo (links naar buiten)
    var hint = buildHint();
    var sectieL = h('div', 'sectie');
    sectieL.appendChild(h('h3', 'section-title', 'Live verkeersinfo'));
    var links = h('ul', 'links');
    LINKS.forEach(function (l) {
      var li = h('li', 'link-rij');
      li.appendChild(externalLink(l.url, l.name, 'link-naam', hint.laatOpvallen));
      li.appendChild(h('span', 'link-omschr', l.desc));
      links.appendChild(li);
    });
    sectieL.appendChild(links);
    sectieL.appendChild(hint.el);
    sectieL.appendChild(hint.melding);
    inhoud.appendChild(sectieL);

    // Voet: "Bijgewerkt HH:MM (Europe/Amsterdam) · Bronnen: Kadaster/PDOK, Open-Meteo" (bij een mislukte verversing:
    // "verouderd" + knop). Het tijdstip gaat over de weersverwachting; de kaart heeft er geen.
    var voet = h('footer', 'module-foot');
    var bijgewerkt = h('span', 'updated');
    var tijd = h('span', 'updated-tijd');
    var verouderd = h('span', 'stale', ' – verouderd');
    bijgewerkt.appendChild(tijd);
    bijgewerkt.appendChild(verouderd);
    var scheiding = h('span', 'sep', '·');
    scheiding.setAttribute('aria-hidden', 'true');
    var bronnen = h('span', 'bron');
    bronnen.appendChild(document.createTextNode('Bronnen: '));
    bronnen.appendChild(externalLink('https://www.pdok.nl', 'Kadaster/PDOK', null, hint.laatOpvallen));
    bronnen.appendChild(document.createTextNode(', '));
    bronnen.appendChild(externalLink('https://open-meteo.com', 'Open-Meteo', null, hint.laatOpvallen));
    var voetOpnieuw = h('button', 'btn btn--small', 'Opnieuw');
    voetOpnieuw.type = 'button';
    [bijgewerkt, scheiding, bronnen, voetOpnieuw].forEach(function (n) { voet.appendChild(n); });
    bijgewerkt.hidden = scheiding.hidden = verouderd.hidden = voetOpnieuw.hidden = true;

    root.appendChild(kop);
    root.appendChild(inhoud);
    root.appendChild(voet);

    var busy = false;      // er loopt al een request
    var hasData = false;   // er is minstens één keer succesvol data getoond

    function syncBusy() {
      opnieuw.disabled = voetOpnieuw.disabled = busy;
      sectieR.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function showLoading() {
      statusTekst.textContent = 'Weersverwachting ophalen…';
      spinner.hidden = false;
      opnieuw.hidden = true;
      status.hidden = false;
      rijden.hidden = true;
    }
    function showError(text) {
      statusTekst.textContent = text;
      spinner.hidden = true;
      opnieuw.hidden = false;
      status.hidden = false;
      rijden.hidden = true;
    }
    function setStale(isStale, reason) {
      badge.hidden = verouderd.hidden = voetOpnieuw.hidden = !isStale;
      voet.classList.toggle('is-stale', isStale);
      var tip = isStale ? 'Verversen is mislukt; dit zijn de laatst opgehaalde gegevens. ' + (reason || '') : '';
      badge.title = verouderd.title = tip;
    }

    async function load() {
      if (busy) return;
      busy = true;
      syncBusy();
      if (!hasData) showLoading();
      var ctrl = new AbortController();
      var timedOut = false;
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
      try {
        var res = await fetch(API_URL, { signal: ctrl.signal });
        if (!res.ok) throw fail('http', 'HTTP ' + res.status);
        var model = buildModel(await res.json());
        renderRijden(rijden, model);
        hasData = true;
        tijd.textContent = 'Bijgewerkt ' + fmtClock(new Date()) + ' (Europe/Amsterdam)';
        bijgewerkt.hidden = scheiding.hidden = false;
        status.hidden = true;
        rijden.hidden = false;
        setStale(false);
      } catch (e) {
        var text = describeError(e, timedOut);
        if (hasData) setStale(true, text);   // oude data blijft staan
        else showError(text);
      } finally {
        clearTimeout(timer);
        busy = false;
        syncBusy();
      }
    }

    opnieuw.addEventListener('click', load);
    voetOpnieuw.addEventListener('click', load);
    syncBusy();
    load();
    setInterval(load, REFRESH_MS);
  }

  /* ================= Start ================= */

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  // Alleen voor tests in node; in de browser bestaat `module` niet, dus er komt geen global bij.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      API_URL: API_URL, TILE_URL: TILE_URL, LINKS: LINKS, HOME: HOME, ZOOM_MIN: ZOOM_MIN, ZOOM_MAX: ZOOM_MAX,
      lonLatToWorld: lonLatToWorld, worldToLonLat: worldToLonLat, clampCenter: clampCenter, viewOrigin: viewOrigin,
      tilesForViewport: tilesForViewport, zoomCenter: zoomCenter, makeWheelStepper: makeWheelStepper, tileUrl: tileUrl,
      hourConditions: hourConditions, summarize: summarize, buildModel: buildModel, describeError: describeError,
      fmtClock: fmtClock, isApplePlatform: isApplePlatform, hintText: hintText
    };
  }
})();
