#!/usr/bin/env node
// Fireflies-batch: voicememo's (.m4a) één voor één laten transcriberen via de
// directe upload van de Fireflies-API. Alleen de Node-standaardbibliotheek.
// Zie LEESMIJ.md voor de handleiding.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------- constanten
const STANDAARD_ENDPOINT = "https://api.fireflies.ai/graphql";
const DAGLIMIET_MAX = 50; // upload-URL's per gebruiker per UTC-dag
const MIN_PAUZE_MS = 1100; // 60 verzoeken per minuut
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
// Na 10 min mag 'ophalen' op titel zoeken als het id niet werkt (veilig: vóór de upload is al
// gecontroleerd dat er nog geen transcript met deze titel was).
const FALLBACK_NA_MS = 10 * 60 * 1000;
// Na 24 uur nog niets te vinden (id én titel) → 'controleren', zodat het niet stil blijft hangen.
const HANGT_NA_MS = 24 * 60 * 60 * 1000;
const MAX_OPEENVOLGEND_MISLUKT = 3;
const MAAND_MINUTEN_GRATIS = 3000;
const SCRIPT_CMD = "node scripts/fireflies-batch/fireflies-batch.mjs";

// ---------------------------------------------------------------- foutklassen
class Gebruikersfout extends Error {}
class StopRun extends Error {
  constructor(bericht, exitCode = 0) {
    super(bericht);
    this.exitCode = exitCode;
  }
}
class SlotTekort extends Error {}
class FFFout extends Error {
  constructor({ soort, code, status, bericht, retryAfter }) {
    super(bericht);
    this.soort = soort; // "netwerk" | "http" | "api"
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
  get tijdelijk() {
    return (
      this.soort === "netwerk" ||
      this.code === "service_unavailable" ||
      (this.status >= 500 && this.status < 600)
    );
  }
}

// ---------------------------------------------------------------- uitvoer
let GEHEIM = null; // de API-sleutel; wordt nooit geprint
function veilig(tekst) {
  let t = String(tekst);
  if (GEHEIM) t = t.split(GEHEIM).join("***");
  return t;
}
const log = (...a) => console.log(veilig(a.join(" ")));
const waarschuw = (...a) => console.error(veilig(a.join(" ")));
const kort = (s, n = 300) => veilig(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, n);

// ---------------------------------------------------------------- hulpfuncties
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
const nuIso = () => new Date().toISOString();
const utcDag = (d = new Date()) => d.toISOString().slice(0, 10);
const utcMaand = (d = new Date()) => d.toISOString().slice(0, 7);

function fmtLokaal(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1).replace(".", ",") + " MB";
}
function fmtMinSec(sec) {
  if (sec == null) return "?";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
function fmtUrenMin(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)} uur ${m % 60} min`;
}
function fmtGetal(n, dec = 0) {
  return n.toLocaleString("nl-NL", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const titelVan = (naam) => naam.replace(/\.m4a$/i, "").normalize("NFC");
const normTitel = (s) => String(s ?? "").normalize("NFC").trim().toLowerCase();
const collator = new Intl.Collator("nl", { numeric: true, sensitivity: "base" });
const natuurlijk = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

function meetingDatum(mtimeMs) {
  const max = Date.now() - 60 * 1000; // nooit in de toekomst
  return new Date(Math.min(mtimeMs, max)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dagLimiet() {
  const v = process.env.FIREFLIES_DAGLIMIET;
  if (v === undefined || v === "") return DAGLIMIET_MAX;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new Gebruikersfout("FIREFLIES_DAGLIMIET moet een geheel getal van 1 t/m 49 zijn.");
  }
  return Math.min(n, DAGLIMIET_MAX);
}

// ---------------------------------------------------------------- argumenten
function leesArgs(argv) {
  const metWaarde = new Set(["bron", "uit", "min-kb", "max", "alleen", "maand-limiet"]);
  const vlaggen = new Set(["zonder-duur", "help"]);
  const opties = {};
  const los = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      los.push(a);
      continue;
    }
    let k = a.slice(2);
    let v;
    const eq = k.indexOf("=");
    if (eq >= 0) {
      v = k.slice(eq + 1);
      k = k.slice(0, eq);
    }
    if (vlaggen.has(k)) {
      opties[k] = true;
    } else if (metWaarde.has(k)) {
      if (v === undefined) v = argv[++i];
      if (v === undefined) throw new Gebruikersfout(`Optie --${k} heeft een waarde nodig.`);
      opties[k] = v;
    } else {
      throw new Gebruikersfout(`Onbekende optie: --${k}`);
    }
  }
  const getal = (k, def, { min = 0, geheel = true } = {}) => {
    if (opties[k] === undefined) return def;
    const n = Number(opties[k]);
    if (!Number.isFinite(n) || n < min || (geheel && !Number.isInteger(n))) {
      throw new Gebruikersfout(`Ongeldige waarde voor --${k}: "${opties[k]}"`);
    }
    return n;
  };
  return {
    los,
    bron: opties.bron,
    uit: opties.uit,
    minKb: getal("min-kb", 100, { min: 0, geheel: false }),
    max: getal("max", DAGLIMIET_MAX, { min: 1 }),
    alleen: opties.alleen,
    maandLimiet: getal("maand-limiet", MAAND_MINUTEN_GRATIS, { min: 0, geheel: false }),
    zonderDuur: !!opties["zonder-duur"],
    help: !!opties.help,
  };
}

// ---------------------------------------------------------------- mappen
function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
async function isMap(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function vindBron(opts) {
  if (opts.bron) {
    const p = path.resolve(expandHome(opts.bron));
    if (!(await isMap(p))) throw new Gebruikersfout(`Bronmap bestaat niet: ${p}`);
    return p;
  }
  const root = path.join(os.homedir(), "Library", "CloudStorage");
  let namen = [];
  try {
    namen = await fsp.readdir(root);
  } catch {
    /* geen CloudStorage */
  }
  const kandidaten = [];
  for (const n of namen) {
    if (!n.startsWith("OneDrive")) continue;
    const p = path.join(root, n, "AI Config Oud", "Dictafoon", "audio");
    if (await isMap(p)) kandidaten.push(p);
  }
  if (kandidaten.length === 1) return kandidaten[0];
  if (kandidaten.length === 0) {
    throw new Gebruikersfout(
      "Ik vind de audiomap niet automatisch. Geef hem zelf mee met --bron \"<map>\"."
    );
  }
  throw new Gebruikersfout(
    "Er zijn meerdere mogelijke audiomappen. Kies er één met --bron \"<map>\":\n  " +
      kandidaten.join("\n  ")
  );
}
async function bepaalUit(opts) {
  if (opts.uit) return path.resolve(expandHome(opts.uit));
  const bron = await vindBron(opts);
  return path.resolve(bron, "..", "transcripten");
}

async function lijstBestanden(bron) {
  const items = await fsp.readdir(bron, { withFileTypes: true });
  const out = [];
  for (const it of items) {
    if (it.name.startsWith(".") || !/\.m4a$/i.test(it.name)) continue;
    if (!it.isFile() && !it.isSymbolicLink()) continue;
    const pad = path.join(bron, it.name);
    let st;
    try {
      st = await fsp.stat(pad);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ naam: it.name, pad, size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => natuurlijk(a.naam, b.naam));
  return out;
}

function zoekNamen(namen, invoer) {
  const n = normTitel(invoer.replace(/\.m4a$/i, ""));
  return namen.filter((x) => normTitel(x.replace(/\.m4a$/i, "")) === n);
}

async function duurSeconden(pad) {
  try {
    const { stdout } = await execFileP("/usr/bin/afinfo", [pad], {
      timeout: 60000,
      maxBuffer: 1 << 20,
    });
    const m = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/i);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- endpoint
function bepaalEndpoint() {
  const raw = process.env.FIREFLIES_API_URL;
  if (!raw) return { url: STANDAARD_ENDPOINT, test: false };
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Gebruikersfout("FIREFLIES_API_URL is geen geldige URL. Ik stop.");
  }
  const echt =
    u.protocol === "https:" && u.hostname === "api.fireflies.ai" && (u.port === "" || u.port === "443");
  const lokaal =
    u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port !== "";
  if (u.username || u.password || (!echt && !lokaal)) {
    throw new Gebruikersfout(
      "FIREFLIES_API_URL wordt geweigerd: alleen https://api.fireflies.ai/... of http://127.0.0.1:<poort> (test) is toegestaan. Je sleutel is niet verstuurd."
    );
  }
  return { url: u.href, test: lokaal };
}
function controleerUploadUrl(raw, test) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return !!test && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
}

// ---------------------------------------------------------------- sleutel
async function vraagSleutel() {
  let sleutel = process.env.FIREFLIES_API_KEY?.trim();
  if (!sleutel) {
    if (!process.stdin.isTTY) {
      throw new Gebruikersfout(
        "Geen API-sleutel. Zet FIREFLIES_API_KEY of start het commando in Terminal, dan vraag ik erom."
      );
    }
    process.stdout.write("Plak je Fireflies API-sleutel (je ziet niets verschijnen) en druk op Enter: ");
    sleutel = (
      await new Promise((resolve) => {
        const stdin = process.stdin;
        let buf = "";
        const klaar = (waarde) => {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(waarde);
        };
        const onData = (chunk) => {
          for (const ch of String(chunk)) {
            if (ch === "\r" || ch === "\n") return klaar(buf);
            if (ch === "\u0003") {
              klaar("");
              process.exit(130);
            }
            if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
            else if (ch >= " ") buf += ch;
          }
        };
        stdin.setRawMode(true);
        stdin.setEncoding("utf8");
        stdin.resume();
        stdin.on("data", onData);
      })
    ).trim();
  }
  if (!sleutel) throw new Gebruikersfout("Geen sleutel ingevoerd.");
  if (!/^[\x21-\x7e]+$/.test(sleutel)) {
    throw new Gebruikersfout("De sleutel bevat spaties of vreemde tekens. Plak hem opnieuw, zonder extra tekst.");
  }
  GEHEIM = sleutel;
  return sleutel;
}

function vraagJaNee(vraag) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(vraag, (a) => {
      rl.close();
      resolve(/^\s*(j|ja|y|yes)\s*$/i.test(a));
    });
  });
}

// ---------------------------------------------------------------- GraphQL
let laatsteAanroep = 0;
async function gql(ctx, query, variables) {
  const wacht = ctx.pauzeMs - (Date.now() - laatsteAanroep);
  if (wacht > 0) await sleep(wacht);
  laatsteAanroep = Date.now();

  let res, tekst;
  try {
    res = await fetch(ctx.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.sleutel}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60000),
    });
    tekst = await res.text();
  } catch (e) {
    throw new FFFout({
      soort: "netwerk",
      code: "netwerk",
      bericht: `netwerkfout (${e?.cause?.code ?? e?.name ?? "onbekend"})`,
    });
  }
  let json = null;
  try {
    json = JSON.parse(tekst);
  } catch {
    /* geen JSON */
  }
  const fouten = json?.errors;
  if (Array.isArray(fouten) && fouten.length) {
    const e0 = fouten[0] ?? {};
    const code = String(e0.code ?? e0.extensions?.code ?? (res.status === 401 ? "unauthorized" : "onbekend")).toLowerCase();
    const retryAfter = Number(e0.extensions?.metadata?.retryAfter ?? e0.metadata?.retryAfter) || null;
    const fout = new FFFout({
      soort: "api",
      code,
      status: res.status,
      bericht: kort(e0.message ?? code),
      retryAfter,
    });
    leidFataalAf(fout);
    throw fout;
  }
  if (!res.ok) {
    const fout = new FFFout({
      soort: "http",
      code: `http_${res.status}`,
      status: res.status,
      bericht: `HTTP ${res.status}`,
    });
    leidFataalAf(fout);
    throw fout;
  }
  if (!json || json.data === undefined) {
    throw new FFFout({ soort: "http", code: "ongeldig_antwoord", status: res.status, bericht: "onverwacht antwoord van Fireflies" });
  }
  return json.data;
}

function leidFataalAf(f) {
  if (f.code === "too_many_requests" || f.status === 429) {
    const vanaf = f.retryAfter ? ` Probeer het opnieuw vanaf ${fmtLokaal(f.retryAfter)} (lokale tijd).` : " Probeer het over een uur opnieuw.";
    throw new StopRun(`Fireflies zegt: te veel verzoeken (daglimiet of tempo).${vanaf} De voortgang is bewaard.`, 0);
  }
  if (f.code === "paid_required") {
    throw new StopRun(
      "Fireflies weigert uploads: dit abonnement (Free) mag niet uploaden. Neem een betaald abonnement of gebruik een andere sleutel. Niets is aangepast.",
      1
    );
  }
  if (f.code === "feature_disabled") {
    throw new StopRun(
      "Fireflies weigert uploads: een beheerder van het team heeft uploaden uitgezet. Vraag de beheerder het aan te zetten.",
      1
    );
  }
  if (f.status === 401 || /auth|unauthor|invalid_token|invalid_api_key/.test(f.code)) {
    throw new StopRun("Fireflies accepteert de API-sleutel niet. Controleer de sleutel en probeer opnieuw.", 1);
  }
  if (f.code === "invalid_language_code") {
    throw new StopRun("Fireflies kent de taalcode \"nl\" niet voor uploads. Dit is een fout in het script; er is niets aangepast.", 1);
  }
}

const Q_CREATE = `mutation($input: CreateUploadUrlInput!) { createUploadUrl(input: $input) { upload_url upload_method upload_fields { name value } meeting_id expires_at } }`;
const Q_CONFIRM = `mutation confirmUpload($input: ConfirmUploadInput!) { confirmUpload(input: $input) { success meeting_id message url } }`;
const Q_TRANSCRIPT = `query($id: String!) { transcript(id: $id) { id title date duration transcript_url sentences { speaker_name text start_time } } }`;
// Docs: scope is lowercase (title | sentences | all). Of het type String of een enum is, is
// niet zeker; daarom twee varianten, de tweede met een letterlijke enum-waarde.
const Q_ZOEK = [
  {
    q: `query($keyword: String, $scope: String, $limit: Int, $skip: Int) { transcripts(keyword: $keyword, scope: $scope, limit: $limit, skip: $skip) { id title } }`,
    v: (keyword, skip) => ({ keyword, scope: "title", limit: 50, skip }),
  },
  {
    q: `query($keyword: String, $limit: Int, $skip: Int) { transcripts(keyword: $keyword, scope: title, limit: $limit, skip: $skip) { id title } }`,
    v: (keyword, skip) => ({ keyword, limit: 50, skip }),
  },
];

// ---------------------------------------------------------------- voortgang + lock
class Voortgang {
  constructor(pad) {
    this.pad = pad;
    this.data = { versie: 1, bestanden: {}, dag: { datum: null, aantal: 0 } };
  }
  laad() {
    let tekst;
    try {
      tekst = fs.readFileSync(this.pad, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    let d;
    try {
      d = JSON.parse(tekst);
    } catch {
      d = null;
    }
    if (!d || typeof d !== "object" || typeof d.bestanden !== "object" || d.bestanden === null) {
      throw new Gebruikersfout(
        `Het voortgangsbestand is beschadigd: ${this.pad}\nIk heb niets overschreven. Haal een eerdere kopie terug of verwijder het bestand bewust.`
      );
    }
    d.dag ??= { datum: null, aantal: 0 };
    this.data = d;
    return true;
  }
  opslaan() {
    const tmp = `${this.pad}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.pad);
    try {
      const dfd = fs.openSync(path.dirname(this.pad), "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {
      /* best effort */
    }
  }
  entry(naam) {
    return this.data.bestanden[naam];
  }
  zet(naam, patch, opslaan = true) {
    const e = this.data.bestanden[naam] ?? {};
    Object.assign(e, patch, { gewijzigd: nuIso() });
    this.data.bestanden[naam] = e;
    if (opslaan) this.opslaan();
    return e;
  }
  verwijder(naam) {
    delete this.data.bestanden[naam];
    this.opslaan();
  }
  dagAantal() {
    return this.data.dag?.datum === utcDag() ? this.data.dag.aantal : 0;
  }
  verhoogDag() {
    this.data.dag = { datum: utcDag(), aantal: this.dagAantal() + 1 };
  }
  maandMinuten() {
    const m = utcMaand();
    let som = 0;
    for (const e of Object.values(this.data.bestanden)) {
      if (e.geupload_op && e.geupload_op.slice(0, 7) === m) som += e.duur_min ?? 0;
    }
    return som;
  }
  namen() {
    return Object.keys(this.data.bestanden).sort(natuurlijk);
  }
}

function leeft(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
let lockPad = null;
function neemLock(pad) {
  for (let poging = 0; poging < 3; poging++) {
    try {
      const fd = fs.openSync(pad, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockPad = pad;
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = NaN;
      let jong = false;
      try {
        pid = parseInt(fs.readFileSync(pad, "utf8"), 10);
        jong = Date.now() - fs.statSync(pad).mtimeMs < 5000;
      } catch {
        continue;
      }
      if ((Number.isInteger(pid) && pid > 0 && leeft(pid)) || (!Number.isInteger(pid) && jong)) {
        throw new Gebruikersfout(
          `Er draait al een ander proces met deze voortgang (pid ${Number.isInteger(pid) ? pid : "onbekend"}). Wacht tot het klaar is of stop het eerst.`
        );
      }
      try {
        fs.unlinkSync(pad); // dood proces: lock overnemen
      } catch {
        /* iemand anders was sneller; volgende poging beslist */
      }
    }
  }
  throw new Gebruikersfout("Kon het lockbestand niet nemen; probeer het opnieuw.");
}
function geefLockVrij() {
  if (!lockPad) return;
  try {
    if (parseInt(fs.readFileSync(lockPad, "utf8"), 10) === process.pid) fs.unlinkSync(lockPad);
  } catch {
    /* al weg */
  }
  lockPad = null;
}
process.on("exit", geefLockVrij);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    waarschuw("\nGestopt. De voortgang is bewaard; start hetzelfde commando opnieuw om verder te gaan.");
    process.exit(130);
  });
}

// ---------------------------------------------------------------- Fireflies: zoeken op titel
async function zoekTitel(ctx, titel) {
  // Geeft { soort: "geen" | "een" | "meer" | "onbekend", id?, ids?, bericht? }
  const gezocht = new Set([normTitel(titel), normTitel(titel + ".m4a")]);
  const treffers = new Map();
  try {
    for (let skip = 0, pagina = 0; pagina < 20; pagina++, skip += 50) {
      let lijst;
      for (;;) {
        const v = Q_ZOEK[ctx.zoekVariant];
        try {
          const data = await gql(ctx, v.q, v.v(titel.slice(0, 255), skip));
          lijst = data?.transcripts ?? [];
          break;
        } catch (e) {
          const validatie =
            e instanceof FFFout &&
            e.soort === "api" &&
            (["onbekend", "graphql_validation_failed", "bad_user_input"].includes(e.code) || /scope/i.test(e.message));
          if (validatie && ctx.zoekVariant < Q_ZOEK.length - 1) {
            ctx.zoekVariant++;
            continue;
          }
          throw e;
        }
      }
      for (const t of lijst) if (t && gezocht.has(normTitel(t.title))) treffers.set(t.id, t);
      if (lijst.length < 50) break;
    }
  } catch (e) {
    if (e instanceof FFFout) return { soort: "onbekend", bericht: e.message };
    throw e;
  }
  const ids = [...treffers.keys()];
  if (ids.length === 0) return { soort: "geen" };
  if (ids.length === 1) return { soort: "een", id: ids[0] };
  return { soort: "meer", ids };
}

// ---------------------------------------------------------------- Fireflies: bevestigen
async function confirmCall(ctx, meetingId) {
  try {
    const data = await gql(ctx, Q_CONFIRM, { input: { meeting_id: meetingId } });
    const c = data?.confirmUpload;
    if (c?.success) return { uitslag: "ok", url: c.url };
    return { uitslag: "later", bericht: kort(c?.message ?? "bevestigen niet gelukt") };
  } catch (e) {
    if (!(e instanceof FFFout)) throw e;
    if (e.code === "invalid_arguments") return { uitslag: "al" };
    if (e.code === "object_not_found") return { uitslag: "niet_gevonden" };
    return { uitslag: "later", bericht: e.message };
  }
}

// Zet de uitkomst van confirmCall om in een statuswissel.
// Geeft "bevestigd" | "later" | "controleren" | "geen_treffer" terug.
async function bevestigStap(ctx, naam) {
  const vp = ctx.vp;
  const e = vp.entry(naam);
  const r = await confirmCall(ctx, e.meeting_id);
  switch (r.uitslag) {
    case "ok":
      vp.zet(naam, { status: "bevestigd", url: r.url, confirmed_at: nuIso(), melding: undefined });
      return "bevestigd";
    case "al":
      vp.zet(naam, { status: "bevestigd", confirmed_at: e.confirmed_at ?? nuIso(), notitie: "Fireflies meldde: al bevestigd", melding: undefined });
      return "bevestigd";
    case "later":
      vp.zet(naam, { melding: r.bericht });
      return "later";
    default: {
      const t = await zoekTitel(ctx, titelVan(naam));
      if (t.soort === "een") {
        vp.zet(naam, { status: "bevestigd", transcript_id: t.id, confirmed_at: e.confirmed_at ?? nuIso(), notitie: "Gevonden in Fireflies op titel", melding: undefined });
        return "bevestigd";
      }
      if (t.soort === "meer") {
        vp.zet(naam, {
          status: "controleren",
          melding: `Er staan ${t.ids.length} transcripten met deze titel in Fireflies. Kijk na welke klopt.`,
        });
        return "controleren";
      }
      if (t.soort === "onbekend") {
        vp.zet(naam, { melding: `titelcontrole mislukt: ${t.bericht}` });
        return "later";
      }
      return "geen_treffer";
    }
  }
}

// ---------------------------------------------------------------- upload: één bestand
async function maandCheck(ctx, f) {
  if (f.duurMin === undefined) {
    const sec = await duurSeconden(f.pad);
    f.duurMin = sec != null ? sec / 60 : f.size / (16 * 1024 * 60); // schatting ~16 KB/s als afinfo ontbreekt
  }
  if (!ctx.maandLimiet) return null;
  const huidig = ctx.vp.maandMinuten();
  if (huidig + f.duurMin > ctx.maandLimiet) {
    const volgende = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    throw new SlotTekort(
      `Maandlimiet bereikt: deze maand (UTC) al ${fmtGetal(huidig, 1)} min geüpload; "${f.naam}" (${fmtGetal(f.duurMin, 1)} min) zou boven de ${fmtGetal(ctx.maandLimiet)} min komen. ` +
        `Verder vanaf ${fmtLokaal(volgende)} (lokale tijd), of start met --maand-limiet 0 als je de meerkosten accepteert.`
    );
  }
  return null;
}

function slotCheck(ctx) {
  if (ctx.vp.dagAantal() >= ctx.dagLimiet) {
    const morgen = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
    throw new SlotTekort(
      `Daglimiet bereikt: vandaag (UTC-dag) zijn al ${ctx.vp.dagAantal()} van de ${ctx.dagLimiet} upload-URL's gemaakt. Verder vanaf ${fmtLokaal(morgen)} (lokale tijd).`
    );
  }
  if (ctx.runUrls >= ctx.maxUrls) {
    throw new SlotTekort(`Maximum van ${ctx.maxUrls} nieuwe uploads voor deze run bereikt (--max).`);
  }
}

async function postBestand(ctx, cu, blob, naam) {
  const form = new FormData();
  for (const veld of cu.upload_fields ?? []) form.append(veld.name, veld.value);
  form.append("file", blob, naam); // bestand als laatste veld; geen eigen Content-Type; geen Authorization
  let res;
  try {
    res = await fetch(cu.upload_url, { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`upload mislukt (${e?.cause?.code ?? e?.name ?? "netwerkfout"})`);
  }
  if (!res.ok) {
    const tekst = await res.text().catch(() => "");
    throw new Error(`upload geweigerd (HTTP ${res.status}) ${kort(tekst, 150)}`.trim());
  }
}

// Nieuwe URL maken, uploaden, bevestigen. Wijzigt de status stap voor stap.
async function startUpload(ctx, f) {
  const vp = ctx.vp;
  slotCheck(ctx);
  await maandCheck(ctx, f);

  let blob;
  try {
    blob = await fs.openAsBlob(f.pad, { type: "audio/mp4" });
  } catch (e) {
    vp.zet(f.naam, { status: "fout", size: f.size, mtimeMs: f.mtimeMs, melding: `bestand niet te openen (${e.code ?? "fout"})` });
    return "fout";
  }

  let cu;
  try {
    const data = await gql(ctx, Q_CREATE, {
      input: {
        content_type: "audio/mp4",
        file_size: blob.size,
        title: titelVan(f.naam),
        custom_language: "nl",
        meeting_date: meetingDatum(f.mtimeMs),
        upload_method: "POST",
      },
    });
    cu = data?.createUploadUrl;
  } catch (e) {
    if (!(e instanceof FFFout)) throw e;
    if (e.tijdelijk) return ctx.mislukt(f.naam, `tijdelijke fout bij upload-URL (${e.message}); later opnieuw`);
    vp.zet(f.naam, { status: "fout", size: f.size, mtimeMs: f.mtimeMs, melding: `createUploadUrl: ${e.code}: ${e.message}` });
    return ctx.mislukt(f.naam, `fout: ${e.code}: ${e.message}`, true);
  }
  if (!cu?.meeting_id || !cu?.upload_url) {
    vp.zet(f.naam, { status: "fout", size: f.size, mtimeMs: f.mtimeMs, melding: "Fireflies gaf geen upload-URL of meeting_id terug" });
    return ctx.mislukt(f.naam, "fout: onvolledig antwoord van Fireflies", true);
  }

  // Eerst vastleggen (URL zelf niet), daarna pas uploaden.
  ctx.runUrls++;
  vp.verhoogDag();
  vp.zet(f.naam, {
    status: "url",
    size: f.size,
    mtimeMs: f.mtimeMs,
    meeting_id: cu.meeting_id,
    expires_at: cu.expires_at,
    url_gemaakt_op: nuIso(),
    transcript_id: undefined,
    notitie: undefined,
    melding: undefined,
  });

  if (!controleerUploadUrl(cu.upload_url, ctx.test)) {
    vp.zet(f.naam, { status: "fout", melding: "upload_url is niet https of niet toegestaan; niets geüpload" });
    return ctx.mislukt(f.naam, "fout: upload-adres niet toegestaan", true);
  }

  try {
    await postBestand(ctx, cu, blob, f.naam);
  } catch (e) {
    vp.zet(f.naam, { melding: e.message });
    return ctx.mislukt(f.naam, `${e.message}; blijft op "url", volgende run controleert het`);
  }
  vp.zet(f.naam, { status: "geupload", geupload_op: nuIso(), duur_min: f.duurMin ?? undefined, melding: undefined });
  vp.zet(f.naam, { status: "bevestigen" });

  const r = await bevestigStap(ctx, f.naam);
  if (r === "bevestigd") {
    ctx.gelukt();
    return "geupload en bevestigd";
  }
  if (r === "geen_treffer") {
    vp.zet(f.naam, {
      status: "controleren",
      melding: "Bestand is geüpload, maar Fireflies kan het niet vinden. Kijk in Fireflies na; staat het er niet, gebruik dan 'opnieuw'.",
    });
    return "controleren (zie status)";
  }
  if (r === "controleren") return "controleren (zie status)";
  return ctx.mislukt(f.naam, `geüpload, bevestigen later opnieuw (${vp.entry(f.naam).melding ?? "onbekend"})`);
}

// Hervatten van een bestand dat halverwege was.
async function hervat(ctx, f, naam) {
  const vp = ctx.vp;
  const e = vp.entry(naam);
  if (e.status === "url") {
    const r = await bevestigStap(ctx, naam);
    if (r === "bevestigd") {
      ctx.gelukt();
      return "hervat: bevestigd";
    }
    if (r === "controleren") return "controleren (zie status)";
    if (r === "later") return ctx.mislukt(naam, `kon niet bevestigen (${vp.entry(naam).melding ?? "onbekend"}); blijft op "url"`);
    // geen treffer: de upload is niet aangekomen, opnieuw beginnen met een nieuwe URL
    if (!f) {
      vp.zet(naam, { status: "fout", melding: "bestand is niet meer in de bronmap; kan niet opnieuw uploaden" });
      return "fout (bestand ontbreekt)";
    }
    log(`  upload van vorige keer is niet aangekomen; opnieuw met een nieuwe URL`);
    return startUpload(ctx, f);
  }
  // geupload / bevestigen
  const r = await bevestigStap(ctx, naam);
  if (r === "bevestigd") {
    ctx.gelukt();
    return "hervat: bevestigd";
  }
  if (r === "geen_treffer") {
    vp.zet(naam, {
      status: "controleren",
      melding: "Fireflies kent deze upload niet meer en vindt geen transcript op titel. Mogelijk toch al in Fireflies: kijk na en gebruik 'opnieuw' als het er niet staat.",
    });
    return "controleren (zie status)";
  }
  if (r === "controleren") return "controleren (zie status)";
  return ctx.mislukt(naam, `bevestigen later opnieuw (${vp.entry(naam).melding ?? "onbekend"})`);
}

// Nieuw bestand: eerst op titel zoeken.
async function nieuwBestand(ctx, f) {
  const vp = ctx.vp;
  slotCheck(ctx); // voorkom nutteloze zoekopdracht als er toch geen slot is
  const t = await zoekTitel(ctx, titelVan(f.naam));
  if (t.soort === "een") {
    vp.zet(f.naam, {
      status: "bevestigd",
      size: f.size,
      mtimeMs: f.mtimeMs,
      transcript_id: t.id,
      confirmed_at: nuIso(),
      notitie: "bestond al in Fireflies",
    });
    ctx.gelukt();
    return "bestond al in Fireflies; niet geüpload";
  }
  if (t.soort === "meer") {
    vp.zet(f.naam, {
      status: "controleren",
      size: f.size,
      mtimeMs: f.mtimeMs,
      melding: `Er staan al ${t.ids.length} transcripten met deze titel in Fireflies. Kijk na en gebruik 'opnieuw' als dit bestand toch geüpload moet worden.`,
    });
    return "controleren: titel komt meerdere keren voor in Fireflies";
  }
  if (t.soort === "onbekend") {
    return ctx.mislukt(f.naam, `titelcontrole mislukt (${t.bericht}); niet geüpload, volgende run probeert opnieuw`);
  }
  return startUpload(ctx, f);
}

function maakCtx(basis) {
  const ctx = {
    ...basis,
    runUrls: 0,
    opeenvolgend: 0,
    zoekVariant: 0,
    slotReden: null,
    gelukt() {
      ctx.opeenvolgend = 0;
    },
    mislukt(naam, bericht, harde = false) {
      ctx.opeenvolgend++;
      if (ctx.opeenvolgend >= MAX_OPEENVOLGEND_MISLUKT) {
        throw new StopRun(
          `Gestopt: ${MAX_OPEENVOLGEND_MISLUKT} keer achter elkaar mislukt (laatste: ${naam}: ${bericht}). Controleer je internet en start opnieuw; de voortgang is bewaard.`,
          1
        );
      }
      return harde ? bericht : `overgeslagen: ${bericht}`;
    },
  };
  return ctx;
}

async function maakContext(opts, { metBron }) {
  const endpoint = bepaalEndpoint();
  const uit = await bepaalUit(opts);
  const bron = metBron ? await vindBron(opts) : null;
  let pauzeMs = MIN_PAUZE_MS;
  if (endpoint.test && process.env.FIREFLIES_PAUZE_MS !== undefined) {
    const n = Number(process.env.FIREFLIES_PAUZE_MS);
    if (Number.isFinite(n) && n >= 0) pauzeMs = n;
  }
  fs.mkdirSync(uit, { recursive: true });
  neemLock(path.join(uit, "fireflies-voortgang.lock"));
  const vp = new Voortgang(path.join(uit, "fireflies-voortgang.json"));
  vp.laad();
  const sleutel = await vraagSleutel();
  return maakCtx({
    endpoint: endpoint.url,
    test: endpoint.test,
    pauzeMs,
    uit,
    bron,
    vp,
    sleutel,
    dagLimiet: dagLimiet(),
    maxUrls: opts.max,
    maandLimiet: opts.maandLimiet,
    minKb: opts.minKb,
  });
}

// ---------------------------------------------------------------- commando: upload
async function cmdUpload(opts) {
  const ctx = await maakContext(opts, { metBron: true });
  const vp = ctx.vp;
  let bestanden = await lijstBestanden(ctx.bron);
  if (opts.alleen) {
    const gevonden = zoekNamen(bestanden.map((b) => b.naam), opts.alleen);
    if (!gevonden.length) throw new Gebruikersfout(`Bestand niet gevonden in de bronmap: ${opts.alleen}`);
    bestanden = bestanden.filter((b) => gevonden.includes(b.naam));
  }
  const perNaam = new Map(bestanden.map((b) => [b.naam, b]));
  const minBytes = ctx.minKb * 1024;

  // Synchroniseren: overgeslagen, gewijzigde bestanden
  let overgeslagen = 0;
  for (const f of bestanden) {
    const e = vp.entry(f.naam);
    if (f.size < minBytes) {
      overgeslagen++;
      if (!e) vp.zet(f.naam, { status: "overgeslagen", size: f.size, mtimeMs: f.mtimeMs, melding: `kleiner dan ${ctx.minKb} KB` }, false);
      continue;
    }
    if (e?.status === "overgeslagen") {
      delete vp.data.bestanden[f.naam];
      continue;
    }
    if (e && (e.status === "bevestigd" || e.status === "klaar") && (e.size !== f.size || e.mtimeMs !== f.mtimeMs)) {
      waarschuw(`Let op: "${f.naam}" is veranderd sinds de upload (grootte of datum). Ik upload hem niet opnieuw; gebruik 'opnieuw' als je dat wilt.`);
    }
  }
  vp.opslaan();

  const hervatNamen = vp
    .namen()
    .filter((n) => ["url", "geupload", "bevestigen"].includes(vp.entry(n).status))
    .filter((n) => !opts.alleen || perNaam.has(n));
  const nieuw = bestanden.filter((f) => f.size >= minBytes && !vp.entry(f.naam));
  const foutAantal = bestanden.filter((f) => vp.entry(f.naam)?.status === "fout").length;

  log(`Bron: ${ctx.bron}`);
  log(`Uit:  ${ctx.uit}`);
  log(`${bestanden.length} bestand(en); ${overgeslagen} te klein; ${hervatNamen.length} te hervatten; ${nieuw.length} nieuw.`);
  const rest = Math.max(0, ctx.dagLimiet - vp.dagAantal());
  log(`Vandaag (UTC-dag) nog ${rest} upload-URL's vrij; deze run maximaal ${Math.min(rest, ctx.maxUrls)}.`);

  const totaal = hervatNamen.length + nieuw.length;
  let i = 0;
  const tel = { bevestigd: 0, controleren: 0, overig: 0 };
  const verwerk = async (naam, fn) => {
    i++;
    process.stdout.write(veilig(`[${i}/${totaal}] ${naam} ... `));
    const uitkomst = await fn();
    console.log(veilig(uitkomst));
    if (/bevestigd|bestond al/.test(uitkomst)) tel.bevestigd++;
    else if (/controleren/.test(uitkomst)) tel.controleren++;
    else tel.overig++;
  };
  const eindmelding = (e) => {
    if (e instanceof SlotTekort) {
      ctx.slotReden = e.message;
      return true;
    }
    return false;
  };

  try {
    try {
      for (const naam of hervatNamen) {
        try {
          await verwerk(naam, () => hervat(ctx, perNaam.get(naam), naam));
        } catch (e) {
          if (e instanceof SlotTekort) {
            console.log(veilig("wacht op een vrij slot"));
            ctx.slotReden = e.message;
            if (/Maandlimiet/.test(e.message)) throw new StopRun(e.message, 0);
            continue;
          }
          throw e;
        }
      }
      for (const f of nieuw) {
        try {
          await verwerk(f.naam, () => nieuwBestand(ctx, f));
        } catch (e) {
          if (eindmelding(e)) {
            console.log("gestopt");
            break;
          }
          throw e;
        }
      }
    } catch (e) {
      if (!(e instanceof StopRun)) throw e;
      console.log("");
      waarschuw(e.message);
      afsluiting(ctx, tel, foutAantal, i, totaal);
      process.exitCode = e.exitCode;
      return;
    }
  } finally {
    vp.opslaan();
  }
  if (ctx.slotReden) log(`\n${ctx.slotReden}`);
  afsluiting(ctx, tel, foutAantal, i, totaal);
}

function afsluiting(ctx, tel, foutAantal, verwerkt, totaal) {
  const st = telPerStatus(ctx.vp);
  log(`\nKlaar met deze run: ${verwerkt} bestand(en) bekeken, ${tel.bevestigd} bevestigd.`);
  log(`Totaal nu: ${formatStatusTelling(st)}`);
  if ((st.fout ?? 0) + (st.controleren ?? 0) > 0) log(`Er zijn bestanden die aandacht nodig hebben. Kijk met: ${SCRIPT_CMD} status`);
}

// ---------------------------------------------------------------- commando: ophalen
function tijdstip(sec) {
  const s = Math.floor(Number(sec));
  if (!Number.isFinite(s) || s < 0) return "--:--";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}
function formatTranscript(naam, entry, t, id) {
  const datum = Number(t.date);
  const dMs = Number.isFinite(datum) && datum > 0 ? datum : entry.mtimeMs;
  const duur = Number(t.duration);
  const duurTekst = Number.isFinite(duur) && t.duration != null ? `${Math.round(duur * 10) / 10} min` : "onbekend";
  const regels = [
    `Titel: ${t.title || titelVan(naam)}`,
    `Datum: ${dMs ? fmtLokaal(dMs) : "onbekend"}`,
    `Duur: ${duurTekst}`,
    `Fireflies: ${t.transcript_url || `https://app.fireflies.ai/view/${id}`}`,
    `Bron: ${naam}`,
    "",
  ];
  for (const s of t.sentences) {
    const tekst = String(s?.text ?? "").trim();
    if (!tekst) continue;
    const spreker = String(s?.speaker_name ?? "").trim();
    regels.push(`[${tijdstip(s.start_time)}] ${spreker ? spreker + ": " : ""}${tekst}`);
  }
  return regels.join("\n") + "\n";
}

async function haalTranscript(ctx, id) {
  try {
    const data = await gql(ctx, Q_TRANSCRIPT, { id });
    const t = data?.transcript;
    if (!t) return { soort: "nietgevonden" };
    if (!Array.isArray(t.sentences) || t.sentences.length === 0) return { soort: "nietklaar" };
    return { soort: "klaar", t };
  } catch (e) {
    if (!(e instanceof FFFout)) throw e;
    if (e.code === "object_not_found" || e.code === "invalid_arguments") return { soort: "nietgevonden" };
    return { soort: "tijdelijk", bericht: e.message };
  }
}

function schrijfTxt(txtPad, inhoud) {
  const tmp = `${txtPad}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, inhoud);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.linkSync(tmp, txtPad); // faalt als het bestand intussen bestaat: nooit overschrijven
    } catch (e) {
      if (e.code === "EEXIST") throw e;
      if (fs.existsSync(txtPad)) throw Object.assign(new Error("bestaat"), { code: "EEXIST" });
      fs.renameSync(tmp, txtPad);
      return;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* al hernoemd */
    }
  }
}

async function cmdOphalen(opts) {
  const ctx = await maakContext(opts, { metBron: false });
  const vp = ctx.vp;
  let namen = vp.namen().filter((n) => vp.entry(n).status === "bevestigd");
  if (opts.alleen) {
    const g = zoekNamen(namen, opts.alleen);
    namen = namen.filter((n) => g.includes(n));
  }
  log(`${namen.length} bevestigde bestand(en) om te controleren.`);
  const tel = { klaar: 0, nietKlaar: 0, anders: 0 };
  let i = 0;
  try {
    for (const naam of namen) {
      i++;
      const e = vp.entry(naam);
      const txtPad = path.join(ctx.uit, titelVan(naam) + ".txt");
      process.stdout.write(veilig(`[${i}/${namen.length}] ${naam} ... `));

      if (fs.existsSync(txtPad)) {
        if (e.txt_schrijft) {
          vp.zet(naam, { status: "klaar", txt_schrijft: undefined, txt: path.basename(txtPad), klaar_op: nuIso() });
          console.log("klaar (tekstbestand stond er al van een eerdere run)");
          tel.klaar++;
        } else {
          vp.zet(naam, { notitie: "Er staat al een .txt met deze naam dat niet van dit script is; niet overschreven." });
          console.log(veilig(`WAARSCHUWING: ${path.basename(txtPad)} bestaat al en is niet door dit script gemaakt; niet overschreven. Hernoem of verplaats dat bestand en draai 'ophalen' opnieuw.`));
          tel.anders++;
        }
        continue;
      }

      let id = e.transcript_id ?? e.meeting_id;
      let r = await haalTranscript(ctx, id);
      let zoekUitslag = null;

      if (r.soort === "nietgevonden" && !e.transcript_id) {
        const bevestigdOp = Date.parse(e.confirmed_at ?? "") || 0;
        if (bevestigdOp && Date.now() - bevestigdOp > FALLBACK_NA_MS) {
          const z = await zoekTitel(ctx, titelVan(naam));
          zoekUitslag = z.soort;
          if (z.soort === "een") {
            vp.zet(naam, { transcript_id: z.id });
            id = z.id;
            r = await haalTranscript(ctx, id);
          } else if (z.soort === "meer") {
            vp.zet(naam, {
              status: "controleren",
              melding: `Het transcript is niet op id te vinden en er staan ${z.ids.length} transcripten met deze titel in Fireflies. Kijk na welke klopt.`,
            });
            console.log("controleren: meerdere transcripten met deze titel");
            tel.anders++;
            continue;
          }
        }
      }

      if (r.soort === "klaar") {
        vp.zet(naam, { txt_schrijft: true });
        try {
          schrijfTxt(txtPad, formatTranscript(naam, e, r.t, id));
        } catch (err) {
          vp.zet(naam, { txt_schrijft: undefined });
          if (err.code === "EEXIST") {
            console.log(veilig(`WAARSCHUWING: ${path.basename(txtPad)} bestaat al; niet overschreven.`));
          } else {
            console.log(veilig(`schrijven mislukt (${err.code ?? "fout"})`));
          }
          tel.anders++;
          continue;
        }
        vp.zet(naam, { status: "klaar", transcript_id: id, txt_schrijft: undefined, txt: path.basename(txtPad), klaar_op: nuIso(), melding: undefined });
        console.log("klaar");
        tel.klaar++;
        ctx.gelukt();
      } else if (r.soort === "tijdelijk") {
        console.log(veilig(`tijdelijke fout (${r.bericht}); later opnieuw`));
        tel.anders++;
        ctx.mislukt(naam, r.bericht);
      } else {
        const bevestigdOp = Date.parse(e.confirmed_at ?? "") || 0;
        if (r.soort === "nietgevonden" && zoekUitslag !== "onbekend" && bevestigdOp && Date.now() - bevestigdOp > HANGT_NA_MS) {
          vp.zet(naam, {
            status: "controleren",
            melding: "Fireflies heeft na 24 uur nog geen transcript (niet op id en niet op titel). Kijk in Fireflies na; staat het er niet, gebruik dan 'opnieuw'.",
          });
          console.log("controleren: na 24 uur nog geen transcript te vinden");
          tel.anders++;
          continue;
        }
        console.log("nog niet klaar bij Fireflies");
        tel.nietKlaar++;
      }
    }
  } catch (e) {
    if (!(e instanceof StopRun)) throw e;
    waarschuw(e.message);
    process.exitCode = e.exitCode;
  } finally {
    vp.opslaan();
  }
  log(`\n${tel.klaar} transcript(en) weggeschreven, ${tel.nietKlaar} nog niet klaar, ${tel.anders} met aandachtspunt.`);
  log(`Transcripten staan in: ${ctx.uit}`);
  if (tel.nietKlaar > 0) log("Wacht even en draai 'ophalen' later nog eens voor de rest.");
}

// ---------------------------------------------------------------- status / telling / opnieuw
const STATUS_VOLGORDE = ["nieuw", "overgeslagen", "url", "geupload", "bevestigen", "bevestigd", "klaar", "controleren", "fout"];
function telPerStatus(vp) {
  const t = {};
  for (const e of Object.values(vp.data.bestanden)) t[e.status] = (t[e.status] ?? 0) + 1;
  return t;
}
function formatStatusTelling(t) {
  const delen = STATUS_VOLGORDE.filter((s) => t[s]).map((s) => `${t[s]} ${s}`);
  return delen.length ? delen.join(", ") : "nog niets";
}

async function cmdStatus(opts) {
  const uit = await bepaalUit(opts);
  const vp = new Voortgang(path.join(uit, "fireflies-voortgang.json"));
  if (!vp.laad()) {
    log(`Nog geen voortgangsbestand in ${uit}.`);
    log(`Eerste stap: ${SCRIPT_CMD} telling`);
    return;
  }
  const t = telPerStatus(vp);
  let nieuw = null;
  try {
    const bron = await vindBron(opts);
    const lijst = await lijstBestanden(bron);
    nieuw = lijst.filter((f) => f.size >= opts.minKb * 1024 && !vp.entry(f.naam)).length;
    if (nieuw) t.nieuw = nieuw;
  } catch {
    /* bron onbekend: dan geen telling van nieuwe bestanden */
  }
  log(`Voortgang: ${vp.pad}`);
  log(`Per status: ${formatStatusTelling(t)}`);
  log(`Upload-URL's vandaag (UTC-dag): ${vp.dagAantal()} van ${dagLimiet()}.`);
  log(`Minuten geüpload in deze maand (UTC): ${fmtGetal(vp.maandMinuten(), 1)} van ${fmtGetal(MAAND_MINUTEN_GRATIS)}.`);
  const aandacht = vp.namen().filter((n) => ["fout", "controleren"].includes(vp.entry(n).status));
  if (aandacht.length) {
    log("\nAandacht nodig:");
    for (const n of aandacht) log(`  [${vp.entry(n).status}] ${n}: ${vp.entry(n).melding ?? ""}`);
  }
  const klein = vp.namen().filter((n) => vp.entry(n).status === "overgeslagen");
  if (klein.length) {
    log("\nOvergeslagen (te klein):");
    for (const n of klein) log(`  ${n} (${fmtGetal(vp.entry(n).size / 1024, 1)} KB)`);
  }
  const waarschuwingen = vp.namen().filter((n) => vp.entry(n).notitie?.includes("niet overschreven"));
  for (const n of waarschuwingen) log(`\nLet op: bij ${n} bestond de .txt al; niet overschreven.`);

  log("\nVolgende stap:");
  const stappen = [];
  if ((t.fout ?? 0) + (t.controleren ?? 0) > 0)
    stappen.push(`Kijk in Fireflies na wat er met de bestanden hierboven is. Staat een bestand er niet, zet het terug met: ${SCRIPT_CMD} opnieuw "<bestandsnaam>"`);
  if ((t.url ?? 0) + (t.geupload ?? 0) + (t.bevestigen ?? 0) > 0)
    stappen.push(`Er zijn onderbroken uploads. Hervat met: ${SCRIPT_CMD} upload`);
  if (t.nieuw) stappen.push(`Er zijn nog ${t.nieuw} nieuwe bestanden: ${SCRIPT_CMD} upload (maximaal 50 per dag).`);
  if ((t.bevestigd ?? 0) > 0) stappen.push(`Transcripten ophalen: ${SCRIPT_CMD} ophalen`);
  if (!stappen.length) stappen.push(t.klaar ? "Alles is klaar." : `Start met: ${SCRIPT_CMD} upload`);
  for (const s of stappen) log(`  - ${s}`);
}

async function cmdOpnieuw(opts) {
  const invoer = opts.los[0];
  if (!invoer) throw new Gebruikersfout(`Gebruik: ${SCRIPT_CMD} opnieuw "<bestandsnaam>"`);
  const uit = await bepaalUit(opts);
  const vpPad = path.join(uit, "fireflies-voortgang.json");
  if (!fs.existsSync(vpPad)) throw new Gebruikersfout(`Geen voortgangsbestand gevonden in ${uit}.`);
  if (!process.stdin.isTTY) throw new Gebruikersfout("Dit commando vraagt om bevestiging en moet in Terminal draaien.");
  neemLock(path.join(uit, "fireflies-voortgang.lock"));
  const vp = new Voortgang(vpPad);
  vp.laad();
  const gevonden = zoekNamen(vp.namen(), invoer);
  if (gevonden.length !== 1) {
    throw new Gebruikersfout(
      gevonden.length ? `Meerdere bestanden passen bij "${invoer}".` : `"${invoer}" staat niet in de voortgang. Zie: ${SCRIPT_CMD} status`
    );
  }
  const naam = gevonden[0];
  const e = vp.entry(naam);
  log(`${naam} staat nu op status "${e.status}"${e.melding ? ` (${e.melding})` : ""}.`);
  if (["bevestigd", "klaar", "geupload", "bevestigen", "controleren", "url"].includes(e.status)) {
    log("Let op: staat dit bestand al in Fireflies, dan komt er een dubbele. Kijk dat eerst na.");
  }
  if (!(await vraagJaNee("Terugzetten naar nieuw, zodat het opnieuw wordt geüpload? (j/n) "))) {
    log("Niets veranderd.");
    return;
  }
  vp.verwijder(naam);
  log(`Gedaan. ${naam} wordt bij de volgende 'upload' opnieuw meegenomen.`);
}

async function cmdTelling(opts) {
  const bron = await vindBron(opts);
  const alle = await lijstBestanden(bron);
  const minBytes = opts.minKb * 1024;
  const groot = alle.filter((f) => f.size >= minBytes);
  const klein = alle.filter((f) => f.size < minBytes);
  log(`Bron: ${bron}`);
  log(`Gevonden: ${alle.length} .m4a-bestand(en); ${groot.length} om te uploaden.`);

  let uitMap = null;
  let vp = null;
  try {
    uitMap = await bepaalUit(opts);
    const v = new Voortgang(path.join(uitMap, "fireflies-voortgang.json"));
    if (v.laad()) vp = v;
  } catch (e) {
    if (e instanceof Gebruikersfout && /beschadigd/.test(e.message)) waarschuw(e.message);
  }

  if (klein.length) {
    log(`\nOvergeslagen omdat ze kleiner zijn dan ${opts.minKb} KB:`);
    for (const f of klein) log(`  ${f.naam} (${fmtGetal(f.size / 1024, 1)} KB)`);
  }

  let totaalSec = 0;
  let metDuur = 0;
  log("\nBestanden (natuurlijke volgorde):");
  let totaalBytes = 0;
  for (const f of groot) {
    totaalBytes += f.size;
    let duurTekst = "-";
    if (!opts.zonderDuur) {
      f.sec = await duurSeconden(f.pad);
      if (f.sec != null) {
        totaalSec += f.sec;
        metDuur++;
      }
      duurTekst = fmtMinSec(f.sec);
    }
    const st = vp?.entry(f.naam)?.status;
    log(`  ${f.naam} | ${fmtMB(f.size)} | ${duurTekst} | meeting_date ${meetingDatum(f.mtimeMs)}${st ? ` | ${st}` : ""}`);
  }
  log(`\nTotale grootte: ${fmtMB(totaalBytes)}`);
  if (opts.zonderDuur) {
    log("Duur: niet berekend (--zonder-duur).");
  } else {
    const min = totaalSec / 60;
    log(`Totale duur: ${fmtUrenMin(min)} (${fmtGetal(min, 1)} min)${metDuur < groot.length ? ` — let op: bij ${groot.length - metDuur} bestand(en) kon de duur niet gelezen worden` : ""}`);
    const boven = Math.max(0, min - MAAND_MINUTEN_GRATIS);
    log(`Tegenover ${fmtGetal(MAAND_MINUTEN_GRATIS)} minuten per maand: ${min <= MAAND_MINUTEN_GRATIS ? "past binnen één maand" : `${fmtGetal(boven, 0)} minuten erboven`}.`);
    log(`Geschatte meerkosten als alles in één maand gaat: ongeveer $${fmtGetal(boven * 0.01, 2)} ($0,01 per minuut boven ${fmtGetal(MAAND_MINUTEN_GRATIS)}).`);
    if (min > MAAND_MINUTEN_GRATIS) log(`Verdeeld over ${Math.ceil(min / MAAND_MINUTEN_GRATIS)} maanden blijf je binnen de ${fmtGetal(MAAND_MINUTEN_GRATIS)} minuten per maand.`);
  }
  log(`Benodigde dagen (maximaal ${DAGLIMIET_MAX} uploads per dag): ${Math.ceil(groot.length / DAGLIMIET_MAX)}`);
  log("De datum bij elk bestand is de wijzigingsdatum van het bestand; die gebruik ik als vergaderdatum in Fireflies.");
  if (vp) {
    const t = telPerStatus(vp);
    log(`\nAl eerder gestart: ${formatStatusTelling(t)}. Daarvan klaar: ${t.klaar ?? 0}.`);
  }
}

// ---------------------------------------------------------------- main
const HULP = `Fireflies-batch: voicememo's laten transcriberen.

Gebruik: ${SCRIPT_CMD} <commando> [opties]

Commando's:
  telling              Toont wat er te doen is (geen netwerk, schrijft niets)
  upload               Uploadt bestanden (max 50 per dag) en bevestigt ze
  ophalen              Haalt klare transcripten op en schrijft .txt-bestanden
  status               Toont de voortgang (geen netwerk)
  opnieuw "<bestand>"  Zet één bestand terug naar nieuw

Opties: --bron <map>  --uit <map>  --min-kb <n>  --max <n>  --alleen "<bestand>"
        --maand-limiet <min>  --zonder-duur
Zie LEESMIJ.md voor uitleg.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    log(HULP);
    return;
  }
  const opts = leesArgs(rest);
  if (opts.help) {
    log(HULP);
    return;
  }
  switch (cmd) {
    case "telling":
      return cmdTelling(opts);
    case "upload":
      return cmdUpload(opts);
    case "ophalen":
      return cmdOphalen(opts);
    case "status":
      return cmdStatus(opts);
    case "opnieuw":
      return cmdOpnieuw(opts);
    default:
      throw new Gebruikersfout(`Onbekend commando: ${cmd}\n\n${HULP}`);
  }
}

main().catch((e) => {
  if (e instanceof StopRun) {
    waarschuw(e.message);
    process.exitCode = e.exitCode;
  } else if (e instanceof Gebruikersfout) {
    waarschuw(e.message);
    process.exitCode = 1;
  } else {
    waarschuw(`Onverwachte fout: ${kort(e?.message ?? e)}`);
    process.exitCode = 1;
  }
});
