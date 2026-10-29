/* Zegveld, module "weer": rendert in #mod-weer. Bron: Open-Meteo (geen sleutel, CORS *).
   Het iframe heeft een opaque origin: dus geen localStorage/cookies; alles blijft in het geheugen.
   Opbouw: eerst zuivere functies (geen DOM; testbaar in node via module.exports), dan de DOM-laag. */
(function () {
  'use strict';

  var API_URL = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=52.117&longitude=4.838&timezone=Europe%2FAmsterdam&forecast_days=5&wind_speed_unit=kmh' +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day' +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset';
  var REFRESH_MS = 15 * 60 * 1000;
  var TIMEOUT_MS = 10 * 1000;
  var HOURS_SHOWN = 12;
  var DAYS_SHOWN = 5;
  var DASH = '–';

  /* ================= Zuivere hulpfuncties ================= */

  var UNKNOWN = ['Onbekend', '❔', '❔'];

  // WMO-code -> [omschrijving, icoon overdag, icoon 's nachts]
  var WMO = {
    0:  ['Onbewolkt',                   '☀️', '🌙'],
    1:  ['Overwegend helder',           '🌤️', '🌙'],
    2:  ['Half bewolkt',                '⛅', '☁️'],
    3:  ['Bewolkt',                     '☁️', '☁️'],
    45: ['Mist',                        '🌫️', '🌫️'],
    48: ['Rijpende mist',               '🌫️', '🌫️'],
    51: ['Lichte motregen',             '🌦️', '🌧️'],
    53: ['Motregen',                    '🌦️', '🌧️'],
    55: ['Dichte motregen',             '🌦️', '🌧️'],
    56: ['Lichte ijzelmotregen',        '🌧️', '🌧️'],
    57: ['IJzelmotregen',               '🌧️', '🌧️'],
    61: ['Lichte regen',                '🌧️', '🌧️'],
    63: ['Matige regen',                '🌧️', '🌧️'],
    65: ['Zware regen',                 '🌧️', '🌧️'],
    66: ['Lichte ijzel',                '🌧️', '🌧️'],
    67: ['Zware ijzel',                 '🌧️', '🌧️'],
    71: ['Lichte sneeuw',               '🌨️', '🌨️'],
    73: ['Sneeuw',                      '🌨️', '🌨️'],
    75: ['Zware sneeuw',                '🌨️', '🌨️'],
    77: ['Sneeuwkorrels',               '❄️', '❄️'],
    80: ['Lichte regenbuien',           '🌦️', '🌧️'],
    81: ['Regenbuien',                  '🌦️', '🌧️'],
    82: ['Zware regenbuien',            '🌦️', '🌧️'],
    85: ['Lichte sneeuwbuien',          '🌨️', '🌨️'],
    86: ['Zware sneeuwbuien',           '🌨️', '🌨️'],
    95: ['Onweer',                      '⛈️', '⛈️'],
    96: ['Onweer met lichte hagel',     '⛈️', '⛈️'],
    99: ['Onweer met zware hagel',      '⛈️', '⛈️']
  };

  // 16 windstreken, Nederlandse afkortingen (Oost = O, West = W). Richting = waar de wind vandaan komt.
  var COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OZO', 'ZO', 'ZZO', 'Z', 'ZZW', 'ZW', 'WZW', 'W', 'WNW', 'NW', 'NNW'];

  // Beaufort: bovengrenzen (km/u, exclusief) van klasse 0..11; daarboven 12.
  var BF_LIMITS = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];

  var DAYS_LONG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  var DAYS_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  var MONTHS_LONG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  var MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

  var RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // Open-Meteo-tijden zijn lokale tijd zonder offset ("2026-10-29T15:00"): nooit via Date parsen.
  var RE_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function at(arr, i) { return Array.isArray(arr) && i >= 0 && i < arr.length ? arr[i] : null; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Fouten met een soort, zodat de UI er een passende Nederlandse tekst bij kan zetten.
  function fail(kind, message) {
    var e = new Error(message || kind);
    e.kind = kind;
    return e;
  }

  function wmo(code) {
    return isNum(code) && Object.prototype.hasOwnProperty.call(WMO, code) ? WMO[code] : UNKNOWN;
  }
  function weatherText(code) { return wmo(code)[0]; }
  function weatherIcon(code, isDay) { return wmo(code)[isDay === 0 || isDay === false ? 2 : 1]; }

  // Windkracht uit km/u. Eerst afronden op hele km/u, zodat Bf en getoonde km/u nooit tegenspreken.
  function beaufort(kmh) {
    if (!isNum(kmh)) return null;
    var r = Math.round(kmh);
    for (var i = 0; i < BF_LIMITS.length; i++) {
      if (r < BF_LIMITS[i]) return i;
    }
    return 12;
  }

  // Graden -> windstreek ("NNW"); null bij ongeldige invoer.
  function compass(deg) {
    if (!isNum(deg)) return null;
    var d = ((deg % 360) + 360) % 360;
    return COMPASS[Math.floor((d + 11.25) / 22.5) % 16];
  }

  // "YYYY-MM-DD" -> kalenderdatum (via UTC-rekenen, dus onafhankelijk van tijdzone/zomertijd). null bij ongeldig.
  function parseDate(s) {
    var m = typeof s === 'string' ? RE_DATE.exec(s) : null;
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d, dow: t.getUTCDay(), ms: t.getTime() };
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

  function clock(p) { return p ? pad2(p.hh) + ':' + pad2(p.mm) : DASH; }

  // Dagnaam bij een datum: Vandaag, Morgen, daarna "za 31 okt". title = volledige datum.
  function dayLabel(dateStr, todayStr) {
    var p = parseDate(dateStr);
    if (!p) return null;
    var name = DAYS_SHORT[p.dow] + ' ' + p.d + ' ' + MONTHS_SHORT[p.m - 1];
    return {
      label: dateStr === todayStr ? 'Vandaag' : dateStr === addDays(todayStr, 1) ? 'Morgen' : name,
      title: DAYS_LONG[p.dow] + ' ' + p.d + ' ' + MONTHS_LONG[p.m - 1],
      short: DAYS_SHORT[p.dow]
    };
  }

  function fmtTemp(v) { return isNum(v) ? Math.round(v) + '°' : DASH; }
  function fmtKmh(v) { return isNum(v) ? Math.round(v) + ' km/u' : DASH; }
  function fmtPct(v) { return isNum(v) ? Math.round(v) + '%' : DASH; }
  function fmtMm(v) { return isNum(v) ? String(Math.round(v * 10) / 10).replace('.', ',') + ' mm' : DASH; }
  function fmtWind(kmh, deg) {
    var bf = beaufort(kmh);
    if (bf === null) return DASH;
    var dir = compass(deg);
    return bf + ' Bf' + (dir ? ' ' + dir : '') + ' · ' + Math.round(kmh) + ' km/u';
  }

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

  // Dag of nacht op een lokaal uur, bepaald met zonsopkomst/-ondergang van die dag (midden van het uur).
  function hourIsDay(p, daily) {
    var idx = Array.isArray(daily.time) ? daily.time.indexOf(p.date) : -1;
    var rise = idx >= 0 ? parseLocal(at(daily.sunrise, idx)) : null;
    var set = idx >= 0 ? parseLocal(at(daily.sunset, idx)) : null;
    var mid = p.hh * 60 + 30;
    if (rise && set) return mid >= rise.hh * 60 + rise.mm && mid < set.hh * 60 + set.mm ? 1 : 0;
    return p.hh >= 7 && p.hh < 20 ? 1 : 0;   // geen zonnetijden: grove schatting
  }

  // Open-Meteo-respons -> weergavemodel met kant-en-klare tekst. Gooit een fout (kind 'data') bij een onbruikbare respons.
  function buildModel(json) {
    if (!isObj(json) || !isObj(json.current) || !isObj(json.daily) || !isObj(json.hourly)) {
      throw fail('data', 'ontbrekende velden');
    }
    var c = json.current, d = json.daily, hr = json.hourly;
    var nowP = parseLocal(c.time);
    if (!nowP || !isNum(c.temperature_2m)) throw fail('data', 'ontbrekende velden (current)');
    if (!Array.isArray(d.time) || !Array.isArray(d.weather_code) ||
        !Array.isArray(d.temperature_2m_max) || !Array.isArray(d.temperature_2m_min)) {
      throw fail('data', 'ontbrekende velden (daily)');
    }
    if (!Array.isArray(hr.time) || !Array.isArray(hr.temperature_2m) || !Array.isArray(hr.weather_code)) {
      throw fail('data', 'ontbrekende velden (hourly)');
    }
    var today = nowP.date;

    // Komende uren: vanaf het eerstvolgende hele uur NA het tijdstip van de meting (lokale tijd, stringvergelijking).
    var hours = [];
    for (var i = 0; i < hr.time.length && hours.length < HOURS_SHOWN; i++) {
      var p = parseLocal(hr.time[i]);
      if (!p || p.key <= nowP.key) continue;
      var code = at(hr.weather_code, i);
      var dl = dayLabel(p.date, today);
      var newDay = p.hh === 0 && p.date !== today;   // middernacht na de meting: dagmarkering
      hours.push({
        label: (newDay && dl ? dl.short + ' ' : '') + clock(p),
        newDay: newDay,
        icon: weatherIcon(code, hourIsDay(p, d)),
        text: weatherText(code),
        temp: fmtTemp(at(hr.temperature_2m, i)),
        pop: fmtPct(at(hr.precipitation_probability, i))
      });
    }

    // Dagen: vanaf vandaag, maximaal DAYS_SHOWN.
    var days = [];
    var todayIdx = -1;
    for (var j = 0; j < d.time.length && days.length < DAYS_SHOWN; j++) {
      if (!parseDate(d.time[j])) throw fail('data', 'ongeldige datum');
      if (d.time[j] < today) continue;
      if (todayIdx < 0) todayIdx = j;
      var dcode = at(d.weather_code, j);
      var lbl = dayLabel(d.time[j], today);
      days.push({
        label: lbl.label,
        title: lbl.title,
        icon: weatherIcon(dcode, 1),
        text: weatherText(dcode),
        max: fmtTemp(at(d.temperature_2m_max, j)),
        min: fmtTemp(at(d.temperature_2m_min, j)),
        mm: fmtMm(at(d.precipitation_sum, j)),
        pop: fmtPct(at(d.precipitation_probability_max, j))
      });
    }
    if (days.length === 0) throw fail('data', 'geen dagen');

    return {
      observed: clock(nowP),
      now: {
        icon: weatherIcon(c.weather_code, c.is_day),
        text: weatherText(c.weather_code),
        temp: fmtTemp(c.temperature_2m),
        feels: fmtTemp(c.apparent_temperature),
        wind: fmtWind(c.wind_speed_10m, c.wind_direction_10m),
        gusts: fmtKmh(c.wind_gusts_10m),
        humidity: fmtPct(c.relative_humidity_2m),
        precip: fmtMm(c.precipitation)
      },
      sun: { rise: clock(parseLocal(at(d.sunrise, todayIdx))), set: clock(parseLocal(at(d.sunset, todayIdx))) },
      hours: hours,
      days: days
    };
  }

  // Fout -> Nederlandse tekst voor de gebruiker.
  function describeError(e, timedOut) {
    if (timedOut || (e && e.name === 'AbortError')) return 'De weerdienst reageert niet. Probeer het zo nog eens.';
    if (e && e.kind === 'http') return 'De weerdienst gaf een foutmelding (' + e.message + ').';
    if (e && (e.kind === 'data' || e.name === 'SyntaxError')) return 'De weerdienst gaf een onverwacht antwoord.';
    return 'Geen verbinding met de weerdienst. Controleer de internetverbinding.';
  }

  /* ================= DOM-laag ================= */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function emoji(cls, glyph, label) {
    var e = h('span', cls, glyph);
    e.setAttribute('role', 'img');
    e.setAttribute('aria-label', label);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function renderContent(box, m) {
    clear(box);

    // Nu
    var hoofd = h('div', 'nu-hoofd');
    hoofd.appendChild(emoji('nu-icon', m.now.icon, m.now.text));
    var tekst = h('div', 'nu-tekst');
    tekst.appendChild(h('div', 'nu-temp', m.now.temp));
    tekst.appendChild(h('div', 'nu-omschr', m.now.text));
    hoofd.appendChild(tekst);
    box.appendChild(hoofd);

    var feiten = h('dl', 'feiten');
    [
      ['Voelt als', m.now.feels],
      ['Wind', m.now.wind],
      ['Windstoten', m.now.gusts],
      ['Luchtvochtigheid', m.now.humidity],
      ['Neerslag', m.now.precip],
      ['Zon op / onder', m.sun.rise + ' / ' + m.sun.set]
    ].forEach(function (kv) {
      var rij = h('div', 'feit');
      rij.appendChild(h('dt', null, kv[0]));
      rij.appendChild(h('dd', null, kv[1]));
      feiten.appendChild(rij);
    });
    box.appendChild(feiten);

    // Komende uren
    if (m.hours.length > 0) {
      var sectieU = h('div', 'sectie');
      sectieU.appendChild(h('h3', 'section-title', 'Komende ' + m.hours.length + ' uur'));
      var scroll = h('div', 'uren-scroll');
      scroll.tabIndex = 0;   // toetsenbord: met de pijltjestoetsen zijwaarts scrollen
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', 'Uurverwachting (zijwaarts scrollen)');
      var lijst = h('ol', 'uren');
      m.hours.forEach(function (u) {
        var li = h('li', 'uur' + (u.newDay ? ' uur--nieuwe-dag' : ''));
        li.title = u.text;
        li.appendChild(h('span', 'uur-tijd', u.label));
        li.appendChild(emoji('uur-icon', u.icon, u.text));
        li.appendChild(h('span', 'uur-temp', u.temp));
        var pop = h('span', 'uur-pop', u.pop);
        pop.title = 'Kans op neerslag';
        li.appendChild(pop);
        lijst.appendChild(li);
      });
      scroll.appendChild(lijst);
      sectieU.appendChild(scroll);
      box.appendChild(sectieU);
    }

    // Verwachting per dag
    var sectieD = h('div', 'sectie');
    sectieD.appendChild(h('h3', 'section-title', m.days.length + '-daagse verwachting'));
    var tabel = h('table', 'table');
    var kop = h('tr');
    [['Dag', ''], ['Weer', ''], ['Max / min', 'num'], ['Neerslag', 'num']].forEach(function (c) {
      var th = h('th', c[1], c[0]);
      th.scope = 'col';
      kop.appendChild(th);
    });
    tabel.appendChild(h('thead')).appendChild(kop);
    var tbody = h('tbody');
    m.days.forEach(function (dag) {
      var tr = h('tr');
      var naam = h('td', 'dag-naam', dag.label);
      naam.title = dag.title;
      tr.appendChild(naam);
      var weer = h('td');
      var wrap = h('div', 'dag-weer');
      wrap.appendChild(emoji('dag-icon', dag.icon, dag.text));
      wrap.appendChild(h('span', 'dag-omschr', dag.text));
      weer.appendChild(wrap);
      tr.appendChild(weer);
      var temp = h('td', 'num dag-temp');
      temp.appendChild(h('strong', null, dag.max));
      temp.appendChild(h('span', 'muted', ' / ' + dag.min));
      tr.appendChild(temp);
      var regen = h('td', 'num dag-regen');
      regen.appendChild(document.createTextNode(dag.mm + ' · '));
      var kans = h('span', 'muted', dag.pop);
      kans.title = 'Kans op neerslag';
      regen.appendChild(kans);
      tr.appendChild(regen);
      tbody.appendChild(tr);
    });
    tabel.appendChild(tbody);
    sectieD.appendChild(tabel);
    box.appendChild(sectieD);
  }

  function init() {
    var root = document.getElementById('mod-weer');
    if (!root) return;
    clear(root);
    root.setAttribute('aria-labelledby', 'mod-weer-titel');

    // Kop
    var kop = h('header', 'module-head');
    var titel = h('h2', 'module-title', 'Weer');
    titel.id = 'mod-weer-titel';
    var badge = h('span', 'badge', 'verouderd');
    badge.hidden = true;
    kop.appendChild(titel);
    kop.appendChild(badge);

    // Status (laden/fout) en inhoud
    var status = h('div', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var statusTekst = h('p', null, 'Weer ophalen…');
    var spinner = h('div', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    var opnieuw = h('button', 'btn', 'Opnieuw');
    opnieuw.type = 'button';
    status.appendChild(spinner);
    status.appendChild(statusTekst);
    status.appendChild(opnieuw);
    var inhoud = h('div', 'weer');
    inhoud.hidden = true;

    // Voet: "Bijgewerkt HH:MM · Bron: Open-Meteo" (bij een mislukte verversing: "(verouderd)" + knop)
    var voet = h('footer', 'module-foot');
    var bijgewerkt = h('span', 'updated');
    var tijd = h('span', 'updated-tijd');
    var verouderd = h('span', 'stale', ' (verouderd)');
    bijgewerkt.appendChild(tijd);
    bijgewerkt.appendChild(verouderd);
    var scheiding = h('span', 'sep', '·');
    scheiding.setAttribute('aria-hidden', 'true');
    var bron = h('span', 'bron');
    bron.appendChild(document.createTextNode('Bron: '));
    var link = h('a', null, 'Open-Meteo');
    link.href = 'https://open-meteo.com';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    bron.appendChild(link);
    var voetOpnieuw = h('button', 'btn btn--small', 'Opnieuw');
    voetOpnieuw.type = 'button';
    [bijgewerkt, scheiding, bron, voetOpnieuw].forEach(function (n) { voet.appendChild(n); });
    bijgewerkt.hidden = scheiding.hidden = verouderd.hidden = voetOpnieuw.hidden = true;

    root.appendChild(kop);
    root.appendChild(status);
    root.appendChild(inhoud);
    root.appendChild(voet);

    var busy = false;      // er loopt al een request
    var hasData = false;   // er is minstens één keer succesvol data getoond
    var lastOk = null;     // Date van de laatste geslaagde verversing

    function syncBusy() {
      opnieuw.disabled = voetOpnieuw.disabled = busy;
      root.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function showLoading() {
      statusTekst.textContent = 'Weer ophalen…';
      spinner.hidden = false;
      opnieuw.hidden = true;
      status.hidden = false;
      inhoud.hidden = true;
    }
    function showError(text) {
      statusTekst.textContent = text;
      spinner.hidden = true;
      opnieuw.hidden = false;
      status.hidden = false;
      inhoud.hidden = true;
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
        renderContent(inhoud, model);
        hasData = true;
        lastOk = new Date();
        tijd.textContent = 'Bijgewerkt ' + fmtClock(lastOk);
        bijgewerkt.hidden = scheiding.hidden = false;
        status.hidden = true;
        inhoud.hidden = false;
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
      API_URL: API_URL, buildModel: buildModel, describeError: describeError, fmtClock: fmtClock,
      beaufort: beaufort, compass: compass, dayLabel: dayLabel, addDays: addDays, wmo: wmo
    };
  }
})();
