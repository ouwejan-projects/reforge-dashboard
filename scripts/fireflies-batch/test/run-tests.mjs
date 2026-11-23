// Testrunner: node scripts/fireflies-batch/test/run-tests.mjs
// Alles draait tegen een nep-server op 127.0.0.1; testbestanden staan in os.tmpdir().

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startNepServer, TEST_DATUM_MS } from "./nep-server.mjs";

const execFileP = promisify(execFile);
const HIER = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HIER, "..", "fireflies-batch.mjs");
const SLEUTEL = "ff-testsleutel-Zq8XkP2mV7";
const MIN_KB = "4";

const werkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-batch-test-"));
const nep = await startNepServer();
let alleUitvoer = ""; // alles wat de scripts printen + voortgangsbestanden, voor de sleutelcontrole

// ------------------------------------------------------------ testbestanden
async function maakSjabloon(naam, seconden) {
  const wav = path.join(werkRoot, `${naam}.wav`);
  const rate = 22050;
  const n = rate * seconden;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const ruis = (Math.random() - 0.5) * 6000;
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000 + ruis), i * 2);
  }
  const kop = Buffer.alloc(44);
  kop.write("RIFF", 0);
  kop.writeUInt32LE(36 + data.length, 4);
  kop.write("WAVEfmt ", 8);
  kop.writeUInt32LE(16, 16);
  kop.writeUInt16LE(1, 20);
  kop.writeUInt16LE(1, 22);
  kop.writeUInt32LE(rate, 24);
  kop.writeUInt32LE(rate * 2, 28);
  kop.writeUInt16LE(2, 32);
  kop.writeUInt16LE(16, 34);
  kop.write("data", 36);
  kop.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wav, Buffer.concat([kop, data]));
  const m4a = path.join(werkRoot, `${naam}.m4a.sjabloon`);
  await execFileP("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", wav, m4a]);
  return m4a;
}
const sjabloon3 = await maakSjabloon("kort", 3);
const sjabloon70 = await maakSjabloon("lang", 70);
assert.ok(fs.statSync(sjabloon3).size > 6 * 1024, "sjabloon moet groter zijn dan 6 KB");

let teller = 0;
function nieuweOmgeving() {
  const dir = path.join(werkRoot, `t${++teller}`);
  const bron = path.join(dir, "audio");
  const uit = path.join(dir, "transcripten");
  fs.mkdirSync(bron, { recursive: true });
  fs.mkdirSync(path.join(dir, "home"));
  return { dir, bron, uit, home: path.join(dir, "home") };
}
function voegToe(omg, naam, sjabloon = sjabloon3) {
  const p = path.join(omg.bron, naam);
  fs.copyFileSync(sjabloon, p);
  const d = new Date(TEST_DATUM_MS);
  fs.utimesSync(p, d, d);
}
function voegKleinToe(omg, naam) {
  fs.writeFileSync(path.join(omg.bron, naam), Buffer.alloc(1000, 7));
}

// ------------------------------------------------------------ script draaien
function draai(omg, args, { env = {}, zonderSleutel = false, metBronUit = true } = {}) {
  const volledig = [...args];
  if (metBronUit) volledig.push("--bron", omg.bron, "--uit", omg.uit);
  if (args[0] === "upload" || args[0] === "telling" || args[0] === "status") volledig.push("--min-kb", MIN_KB);
  const e = {
    PATH: process.env.PATH,
    HOME: omg.home,
    FIREFLIES_API_URL: `${nep.url}/graphql`,
    FIREFLIES_PAUZE_MS: "0",
    ...(zonderSleutel ? {} : { FIREFLIES_API_KEY: SLEUTEL }),
    ...env,
  };
  return new Promise((resolve) => {
    const kind = spawn(process.execPath, [SCRIPT, ...volledig], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (code) => {
      alleUitvoer += `\n--- ${args.join(" ")}\n${stdout}\n${stderr}`;
      const vp = path.join(omg.uit, "fireflies-voortgang.json");
      if (fs.existsSync(vp)) alleUitvoer += "\n" + fs.readFileSync(vp, "utf8");
      resolve({ code, stdout, stderr, alles: stdout + stderr });
    });
  });
}
const leesVp = (omg) => JSON.parse(fs.readFileSync(path.join(omg.uit, "fireflies-voortgang.json"), "utf8"));
const schrijfVp = (omg, d) => fs.writeFileSync(path.join(omg.uit, "fireflies-voortgang.json"), JSON.stringify(d));
const statussen = (omg) => Object.fromEntries(Object.entries(leesVp(omg).bestanden).map(([k, v]) => [k, v.status]));
const p2 = (n) => String(n).padStart(2, "0");


// Draait het script in een echte pseudo-terminal (python3 -I), zodat TTY-gedrag testbaar is.
const PTY_PY = `
import os, pty, sys, time, select
invoer = sys.argv[1]
cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
uit = b""
verstuurd = False
start = time.time()
while True:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            d = os.read(fd, 4096)
        except OSError:
            break
        if not d:
            break
        uit += d
    if not verstuurd and time.time() - start > 0.8:
        os.write(fd, (invoer + "\\n").encode())
        verstuurd = True
    if time.time() - start > 60:
        break
os.waitpid(pid, 0)
sys.stdout.write(uit.decode("utf8", "replace"))
`;
function viaPty(invoer, args, env) {
  return new Promise((resolve) => {
    const kind = spawn("/usr/bin/python3", ["-I", "-c", PTY_PY, invoer, process.execPath, SCRIPT, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let uit = "";
    kind.stdout.on("data", (d) => (uit += d));
    kind.stderr.on("data", (d) => (uit += d));
    kind.on("close", () => resolve(uit));
  });
}
const heeftPty = fs.existsSync("/usr/bin/python3");

// ------------------------------------------------------------ tests
const tests = [];
const test = (naam, fn) => tests.push({ naam, fn });
const DRIE = ["Nieuwe opname 10.m4a", "Nieuwe opname 2.m4a", "Nieuwe opname 9.m4a"];

test("1. happy path: 3 bestanden, 3 txt's met juiste indeling", async () => {
  const omg = nieuweOmgeving();
  for (const n of DRIE) voegToe(omg, n);
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.deepEqual(nep.uploads.map((u) => u.titel), ["Nieuwe opname 2", "Nieuwe opname 9", "Nieuwe opname 10"], "natuurlijke volgorde");
  assert.equal(nep.uploadAuthSchendingen, 0, "Authorization op upload-pad");
  for (const u of nep.uploads) {
    assert.deepEqual(u.velden, ["key", "policy", "file"]);
    assert.equal(u.contentType, "multipart/form-data");
    assert.ok(u.bytes > 6 * 1024);
  }
  assert.ok(nep.createInputs.every((i) => i.meeting_date === "2026-03-12T14:05:00Z" && i.file_size > 6 * 1024));
  assert.ok(Object.values(statussen(omg)).every((s) => s === "bevestigd"));
  assert.equal(nep.telOps("transcripts"), 3, "eerst op titel gezocht");

  const r2 = await draai(omg, ["ophalen"]);
  assert.equal(r2.code, 0, r2.alles);
  const bestanden = fs.readdirSync(omg.uit).filter((f) => f.endsWith(".txt")).sort();
  assert.deepEqual(bestanden, ["Nieuwe opname 10.txt", "Nieuwe opname 2.txt", "Nieuwe opname 9.txt"]);
  const d = new Date(TEST_DATUM_MS);
  const datum = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const m = [...nep.meetings.values()].find((x) => x.title === "Nieuwe opname 9");
  const verwacht = [
    "Titel: Nieuwe opname 9",
    `Datum: ${datum}`,
    "Duur: 12.5 min",
    `Fireflies: https://app.fireflies.ai/view/${m.id}`,
    "Bron: Nieuwe opname 9.m4a",
    "",
    "[00:00] Frank: Hallo wereld",
    "[01:05] Zonder spreker",
    "[1:02:05] Anna: Na een uur",
    "",
  ].join("\n");
  assert.equal(fs.readFileSync(path.join(omg.uit, "Nieuwe opname 9.txt"), "utf8"), verwacht);
  assert.ok(Object.values(statussen(omg)).every((s) => s === "klaar"));
  assert.ok(!fs.readdirSync(omg.uit).some((f) => f.includes(".tmp-")), "geen tmp-resten");
  assert.ok(!fs.existsSync(path.join(omg.uit, "fireflies-voortgang.lock")), "lock vrijgegeven");

  // opnieuw ophalen doet niets meer
  const r3 = await draai(omg, ["ophalen"]);
  assert.match(r3.stdout, /0 bevestigde/);
  const s = await draai(omg, ["status"]);
  assert.match(s.stdout, /3 klaar/);
  assert.match(s.stdout, /Alles is klaar/);
});

test("2. bestand kleiner dan min-kb wordt overgeslagen", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Groot.m4a");
  voegKleinToe(omg, "Klein.m4a");
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.deepEqual(nep.uploads.map((u) => u.titel), ["Groot"]);
  assert.deepEqual(statussen(omg), { "Groot.m4a": "bevestigd", "Klein.m4a": "overgeslagen" });
  const s = await draai(omg, ["status"]);
  assert.match(s.stdout, /Klein\.m4a/);
});

test("3a. upload mislukt na createUploadUrl: hervatten geeft maar een verwerkte upload", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Memo A.m4a");
  nep.opts.dropUpload = true;
  const r1 = await draai(omg, ["upload"]);
  assert.equal(statussen(omg)["Memo A.m4a"], "url");
  assert.equal(nep.uploads.length, 0);
  const vp = fs.readFileSync(path.join(omg.uit, "fireflies-voortgang.json"), "utf8");
  assert.ok(!vp.includes("upload/") && !vp.includes("geheim-beleid"), "geen upload-URL of velden in voortgang");
  nep.opts.dropUpload = false;
  const r2 = await draai(omg, ["upload"]);
  assert.equal(r2.code, 0, r2.alles);
  assert.equal(nep.uploads.length, 1);
  assert.equal(nep.aantalUrls, 2, "tweede URL pas na object_not_found + titelcheck");
  assert.equal(statussen(omg)["Memo A.m4a"], "bevestigd");
  const r3 = await draai(omg, ["upload"]);
  assert.equal(nep.uploads.length, 1, "derde run uploadt niets meer");
  assert.equal(nep.aantalUrls, 2);
  void r1;
});

test("3b. crash na upload, status 'url': confirm met opgeslagen meeting_id, geen nieuwe URL", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Memo B.m4a");
  const st = fs.statSync(path.join(omg.bron, "Memo B.m4a"));
  nep.meetings.set("mtg_x", { id: "mtg_x", title: "Memo B", velden: [], received: true, confirmed: false, polls: 0, transcriptId: null });
  fs.mkdirSync(omg.uit, { recursive: true });
  schrijfVp(omg, {
    versie: 1,
    dag: { datum: new Date().toISOString().slice(0, 10), aantal: 1 },
    bestanden: { "Memo B.m4a": { status: "url", size: st.size, mtimeMs: st.mtimeMs, meeting_id: "mtg_x" } },
  });
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.equal(nep.telOps("createUploadUrl"), 0);
  assert.equal(nep.uploads.length, 0);
  assert.equal(statussen(omg)["Memo B.m4a"], "bevestigd");
});

test("3c. 'bevestigen' + object_not_found + geen titeltreffer: controleren, niet opnieuw uploaden", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Memo C.m4a");
  const st = fs.statSync(path.join(omg.bron, "Memo C.m4a"));
  fs.mkdirSync(omg.uit, { recursive: true });
  schrijfVp(omg, {
    versie: 1,
    dag: { datum: null, aantal: 0 },
    bestanden: { "Memo C.m4a": { status: "bevestigen", size: st.size, mtimeMs: st.mtimeMs, meeting_id: "mtg_weg" } },
  });
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.equal(statussen(omg)["Memo C.m4a"], "controleren");
  assert.equal(nep.telOps("createUploadUrl"), 0);
  const s = await draai(omg, ["status"]);
  assert.match(s.stdout, /controleren\] Memo C\.m4a/);
  assert.match(s.stdout, /opnieuw/);
  // en met een titeltreffer wordt het wel bevestigd
  const omg2 = nieuweOmgeving();
  voegToe(omg2, "Memo D.m4a");
  const st2 = fs.statSync(path.join(omg2.bron, "Memo D.m4a"));
  nep.bestaand.push({ id: "tr_d", title: "Memo D" });
  fs.mkdirSync(omg2.uit, { recursive: true });
  schrijfVp(omg2, { versie: 1, dag: { datum: null, aantal: 0 }, bestanden: { "Memo D.m4a": { status: "geupload", size: st2.size, mtimeMs: st2.mtimeMs, meeting_id: "mtg_weg2" } } });
  await draai(omg2, ["upload"]);
  assert.equal(leesVp(omg2).bestanden["Memo D.m4a"].status, "bevestigd");
  assert.equal(leesVp(omg2).bestanden["Memo D.m4a"].transcript_id, "tr_d");
});

test("4. confirm geeft invalid_arguments: status bevestigd", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Memo E.m4a");
  nep.opts.confirmFail = { code: "invalid_arguments", times: 1 };
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.equal(statussen(omg)["Memo E.m4a"], "bevestigd");
  assert.equal(nep.uploads.length, 1);
});

test("5. service_unavailable: blijft 'bevestigen', volgende run lost op", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Memo F.m4a");
  voegToe(omg, "Memo G.m4a");
  nep.opts.confirmFail = { code: "service_unavailable", times: 1, echoKey: true };
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.deepEqual(statussen(omg), { "Memo F.m4a": "bevestigen", "Memo G.m4a": "bevestigd" });
  assert.ok(!leesVp(omg).bestanden["Memo F.m4a"].melding.includes(SLEUTEL), "sleutel niet in melding");
  const r2 = await draai(omg, ["upload"]);
  assert.equal(r2.code, 0, r2.alles);
  assert.equal(statussen(omg)["Memo F.m4a"], "bevestigd");
  assert.equal(nep.uploads.length, 2, "niet dubbel geüpload");
  assert.equal(nep.aantalUrls, 2);
});

test("6. too_many_requests: nette stop, voortgang intact; paid_required stopt direct", async () => {
  const omg = nieuweOmgeving();
  for (const n of ["M1.m4a", "M2.m4a", "M3.m4a"]) voegToe(omg, n);
  nep.opts.tooManyAfter = 1;
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.match(r.alles, /vanaf \d{4}-\d\d-\d\d \d\d:\d\d \(lokale tijd\)/);
  assert.deepEqual(statussen(omg), { "M1.m4a": "bevestigd" });
  assert.equal(nep.uploads.length, 1);
  nep.opts.tooManyAfter = null;
  const r2 = await draai(omg, ["upload"]);
  assert.equal(r2.code, 0, r2.alles);
  assert.deepEqual(Object.values(statussen(omg)), ["bevestigd", "bevestigd", "bevestigd"]);
  assert.equal(nep.uploads.length, 3);

  const omg2 = nieuweOmgeving();
  voegToe(omg2, "P1.m4a");
  nep.opts.paidRequired = true;
  const r3 = await draai(omg2, ["upload"]);
  assert.equal(r3.code, 1);
  assert.match(r3.alles, /abonnement/i);
  assert.deepEqual(statussen(omg2), {});
});

test("7. daglimiet blijft gelden over runs heen", async () => {
  const omg = nieuweOmgeving();
  for (const n of ["D1.m4a", "D2.m4a", "D3.m4a"]) voegToe(omg, n);
  const env = { FIREFLIES_DAGLIMIET: "2" };
  const r1 = await draai(omg, ["upload"], { env });
  assert.equal(nep.uploads.length, 2, r1.alles);
  assert.match(r1.alles, /Daglimiet bereikt/);
  const r2 = await draai(omg, ["upload"], { env });
  assert.equal(nep.uploads.length, 2, r2.alles);
  assert.equal(nep.aantalUrls, 2);
  assert.match(r2.alles, /Daglimiet bereikt/);
  const vp = leesVp(omg);
  vp.dag.datum = "2000-01-01"; // alsof het gisteren was
  schrijfVp(omg, vp);
  const r3 = await draai(omg, ["upload"], { env });
  assert.equal(r3.code, 0, r3.alles);
  assert.equal(nep.uploads.length, 3);
  // limiet > 50 wordt 50
  const omg2 = nieuweOmgeving();
  voegToe(omg2, "X.m4a");
  const r4 = await draai(omg2, ["upload"], { env: { FIREFLIES_DAGLIMIET: "99" } });
  assert.match(r4.stdout, /nog 50 upload-URL's vrij/);
  // --max begrenst per run
  const omg3 = nieuweOmgeving();
  for (const n of ["Y1.m4a", "Y2.m4a"]) voegToe(omg3, n);
  const before = nep.uploads.length;
  await draai(omg3, ["upload", "--max", "1"]);
  assert.equal(nep.uploads.length - before, 1);
});

test("8. titel bestaat al in Fireflies: niet geüpload (ook paginering, hoofdletters, .m4a)", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Memo 1.m4a");
  voegToe(omg, "Nieuwe opname 9.m4a");
  voegToe(omg, "Nieuw.m4a");
  for (let i = 10; i < 70; i++) nep.bestaand.push({ id: `tr_x${i}`, title: `Memo ${i}` }); // 60 deelstring-treffers
  nep.bestaand.push({ id: "tr_memo1", title: "  memo 1.M4A " });
  nep.bestaand.push({ id: "tr_9", title: "nieuwe OPNAME 9" });
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.deepEqual(nep.uploads.map((u) => u.titel), ["Nieuw"]);
  const vp = leesVp(omg).bestanden;
  assert.equal(vp["Memo 1.m4a"].status, "bevestigd");
  assert.equal(vp["Memo 1.m4a"].transcript_id, "tr_memo1");
  assert.match(vp["Memo 1.m4a"].notitie, /bestond al/);
  assert.equal(vp["Nieuwe opname 9.m4a"].transcript_id, "tr_9");
  const o = await draai(omg, ["ophalen"]);
  assert.equal(o.code, 0, o.alles);
  assert.match(fs.readFileSync(path.join(omg.uit, "Memo 1.txt"), "utf8"), /view\/tr_memo1/);
});

test("8b. zoeken: scope als enum (variant-terugval)", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Enum.m4a");
  nep.opts.scopeEnum = true;
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 0, r.alles);
  assert.equal(nep.uploads.length, 1);
  assert.equal(nep.telOps("transcripts"), 2, "eerste poging geweigerd, tweede variant werkt");
});

test("9a. transcript nog niet klaar: blijft 'bevestigd', later 'klaar'", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "T1.m4a");
  voegToe(omg, "T2.m4a");
  await draai(omg, ["upload"]);
  nep.opts.notReadyPolls = 1;
  const r1 = await draai(omg, ["ophalen"]);
  assert.match(r1.stdout, /nog niet klaar/);
  assert.deepEqual(Object.values(statussen(omg)), ["bevestigd", "bevestigd"]);
  assert.deepEqual(fs.readdirSync(omg.uit).filter((f) => f.endsWith(".txt")), []);
  const r2 = await draai(omg, ["ophalen"]);
  assert.equal(r2.code, 0, r2.alles);
  assert.deepEqual(Object.values(statussen(omg)), ["klaar", "klaar"]);
  // null-variant
  const omg2 = nieuweOmgeving();
  voegToe(omg2, "T3.m4a");
  await draai(omg2, ["upload"]);
  nep.opts.notReadyPolls = 1;
  nep.opts.notReadyMode = "null";
  const polls = 0;
  await draai(omg2, ["ophalen"]);
  assert.equal(statussen(omg2)["T3.m4a"], "bevestigd");
  void polls;
});

test("9b. fallback op titel als id niet werkt en bevestiging > 10 min geleden", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "F1.m4a");
  nep.opts.transcriptIdDiffers = true;
  await draai(omg, ["upload"]);
  const zoekVoor = nep.telOps("transcripts");
  const r1 = await draai(omg, ["ophalen"]);
  assert.match(r1.stdout, /nog niet klaar/);
  assert.equal(nep.telOps("transcripts"), zoekVoor, "binnen 10 min nog niet zoeken");
  const vp = leesVp(omg);
  vp.bestanden["F1.m4a"].confirmed_at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  schrijfVp(omg, vp);
  const r2 = await draai(omg, ["ophalen"]);
  assert.equal(r2.code, 0, r2.alles);
  const na = leesVp(omg).bestanden["F1.m4a"];
  assert.equal(na.status, "klaar");
  assert.match(na.transcript_id, /^tr_mtg_/);
  assert.ok(fs.existsSync(path.join(omg.uit, "F1.txt")));
});

test("9c. fallback met meerdere titeltreffers: controleren, niet gokken", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "F2.m4a");
  nep.opts.transcriptIdDiffers = true;
  await draai(omg, ["upload"]);
  nep.bestaand.push({ id: "tr_andere", title: "F2" }); // nu twee met deze titel
  const vp = leesVp(omg);
  vp.bestanden["F2.m4a"].confirmed_at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  schrijfVp(omg, vp);
  const r = await draai(omg, ["ophalen"]);
  assert.equal(statussen(omg)["F2.m4a"], "controleren", r.alles);
  assert.ok(!fs.existsSync(path.join(omg.uit, "F2.txt")));
});

test("9d. bestaande .txt wordt niet overschreven", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Eigen.m4a");
  await draai(omg, ["upload"]);
  fs.writeFileSync(path.join(omg.uit, "Eigen.txt"), "mijn eigen notities");
  const r = await draai(omg, ["ophalen"]);
  assert.match(r.alles, /WAARSCHUWING/);
  assert.equal(fs.readFileSync(path.join(omg.uit, "Eigen.txt"), "utf8"), "mijn eigen notities");
  assert.equal(statussen(omg)["Eigen.m4a"], "bevestigd");
});

test("9e. na 24 uur nergens te vinden: 'controleren', daarvoor blijft het wachten", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Weg.m4a");
  await draai(omg, ["upload"]);
  nep.meetings.clear(); // Fireflies kent de upload niet (meer): id én titel leveren niets op
  const vp = leesVp(omg);
  vp.bestanden["Weg.m4a"].confirmed_at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  schrijfVp(omg, vp);
  const r1 = await draai(omg, ["ophalen"]);
  assert.match(r1.stdout, /nog niet klaar/, r1.alles);
  assert.equal(statussen(omg)["Weg.m4a"], "bevestigd");
  const vp2 = leesVp(omg);
  vp2.bestanden["Weg.m4a"].confirmed_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  schrijfVp(omg, vp2);
  const uploadsVoor = nep.uploads.length;
  const r2 = await draai(omg, ["ophalen"]);
  assert.equal(r2.code, 0, r2.alles);
  assert.equal(statussen(omg)["Weg.m4a"], "controleren");
  assert.match(leesVp(omg).bestanden["Weg.m4a"].melding, /24 uur/);
  assert.equal(nep.uploads.length, uploadsVoor, "nooit vanzelf opnieuw uploaden");
});

test("10. lock blokkeert tweede run; dood proces wordt overgenomen", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "L1.m4a");
  fs.mkdirSync(omg.uit, { recursive: true });
  const lock = path.join(omg.uit, "fireflies-voortgang.lock");
  fs.writeFileSync(lock, String(process.pid)); // levend proces
  const r = await draai(omg, ["upload"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /al een ander proces/);
  assert.equal(nep.ops.length, 0);
  assert.ok(fs.existsSync(lock), "lock van ander proces blijft staan");
  // dood proces
  const dood = spawn(process.execPath, ["-e", ""]);
  await new Promise((r2) => dood.on("close", r2));
  fs.writeFileSync(lock, String(dood.pid));
  const r2 = await draai(omg, ["upload"]);
  assert.equal(r2.code, 0, r2.alles);
  assert.equal(nep.uploads.length, 1);
  assert.ok(!fs.existsSync(lock), "lock vrijgegeven na afloop");
});

test("11. maandlimiet stopt netjes", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "Lang 1.m4a", sjabloon70);
  voegToe(omg, "Lang 2.m4a", sjabloon70);
  const r = await draai(omg, ["upload", "--maand-limiet", "2"]);
  assert.equal(r.code, 0, r.alles);
  assert.match(r.alles, /Maandlimiet bereikt/);
  assert.deepEqual(statussen(omg), { "Lang 1.m4a": "bevestigd" });
  assert.ok(leesVp(omg).bestanden["Lang 1.m4a"].duur_min > 1.1);
  const r2 = await draai(omg, ["upload", "--maand-limiet", "2"]);
  assert.match(r2.alles, /Maandlimiet bereikt/);
  assert.equal(nep.uploads.length, 1);
  const r3 = await draai(omg, ["upload", "--maand-limiet", "0"]);
  assert.equal(r3.code, 0, r3.alles);
  assert.equal(nep.uploads.length, 2);
});

test("12. endpoint-override naar vreemde host wordt geweigerd", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "E1.m4a");
  for (const url of [
    "https://evil.example.com/graphql",
    "http://evil.example.com/graphql",
    "https://api.fireflies.ai.evil.com/graphql",
    "http://api.fireflies.ai/graphql",
    "https://api.fireflies.ai@evil.com/graphql",
    "http://127.0.0.1/graphql", // geen poort
    "https://127.0.0.1:1234/graphql",
    "geen-url",
  ]) {
    const r = await draai(omg, ["upload"], { env: { FIREFLIES_API_URL: url } });
    assert.equal(r.code, 1, `${url} had geweigerd moeten worden: ${r.alles}`);
    assert.match(r.stderr, /FIREFLIES_API_URL/);
    assert.ok(!r.alles.includes(SLEUTEL));
  }
  assert.equal(nep.ops.length, 0);
  assert.ok(!fs.existsSync(omg.uit) || fs.readdirSync(omg.uit).length === 0, "niets geschreven");
  // localhost met poort is wel toegestaan
  const r = await draai(omg, ["upload"], { env: { FIREFLIES_API_URL: `http://localhost:${nep.port}/graphql` } });
  assert.equal(r.code, 0, r.alles);
});

test("13. telling en status: geen netwerk, schrijven niets", async () => {
  const omg = nieuweOmgeving();
  for (const n of DRIE) voegToe(omg, n);
  voegKleinToe(omg, "Winzig.m4a");
  voegToe(omg, "negeer.txt");
  const lijst = (d) => fs.readdirSync(d).map((f) => [f, fs.statSync(path.join(d, f)).mtimeMs]);
  const voor = [lijst(omg.bron), lijst(omg.dir)];
  const r = await draai(omg, ["telling"], { zonderSleutel: true });
  assert.equal(r.code, 0, r.alles);
  assert.equal(nep.ops.length, 0);
  assert.ok(!fs.existsSync(omg.uit), "uit-map niet aangemaakt");
  assert.deepEqual([lijst(omg.bron), lijst(omg.dir)], voor);
  assert.match(r.stdout, /3 om te uploaden/);
  assert.match(r.stdout, /Winzig\.m4a \(1,0 KB\)/);
  assert.ok(r.stdout.indexOf("Nieuwe opname 9.m4a |") < r.stdout.indexOf("Nieuwe opname 10.m4a |"), "natuurlijke volgorde");
  assert.match(r.stdout, /Nieuwe opname 2\.m4a \| .* MB \| 0:03 \| meeting_date 2026-03-12T14:05:00Z/);
  assert.match(r.stdout, /Totale duur: 0 uur 0 min/);
  assert.match(r.stdout, /meerkosten.*\$0,00/);
  assert.match(r.stdout, /dagen.*: 1/);
  const z = await draai(omg, ["telling", "--zonder-duur"], { zonderSleutel: true });
  assert.match(z.stdout, /niet berekend/);
  // met bestaand voortgangsbestand
  fs.mkdirSync(omg.uit);
  schrijfVp(omg, { versie: 1, dag: { datum: null, aantal: 0 }, bestanden: { "Nieuwe opname 2.m4a": { status: "klaar" } } });
  const vpPad = path.join(omg.uit, "fireflies-voortgang.json");
  const vpVoor = fs.statSync(vpPad).mtimeMs;
  const t2 = await draai(omg, ["telling"], { zonderSleutel: true });
  assert.match(t2.stdout, /Daarvan klaar: 1/);
  const s = await draai(omg, ["status"], { zonderSleutel: true });
  assert.equal(s.code, 0, s.alles);
  assert.match(s.stdout, /1 klaar, 2 nieuw|2 nieuw, 1 klaar/);
  assert.equal(fs.statSync(vpPad).mtimeMs, vpVoor);
  assert.equal(nep.ops.length, 0);
  assert.deepEqual(fs.readdirSync(omg.uit), ["fireflies-voortgang.json"]);
});

test("15. gewijzigd bestand en 'fout' worden niet opnieuw geüpload", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "W1.m4a");
  await draai(omg, ["upload"]);
  fs.appendFileSync(path.join(omg.bron, "W1.m4a"), "extra");
  const r = await draai(omg, ["upload"]);
  assert.match(r.stderr, /veranderd/);
  assert.equal(nep.uploads.length, 1);
  // fout
  const omg2 = nieuweOmgeving();
  voegToe(omg2, "Fout.m4a");
  nep.opts.createError = "payload_too_small";
  const r2 = await draai(omg2, ["upload"]);
  assert.equal(statussen(omg2)["Fout.m4a"], "fout", r2.alles);
  const n = nep.telOps("createUploadUrl");
  nep.opts.createError = null;
  await draai(omg2, ["upload"]);
  assert.equal(nep.telOps("createUploadUrl"), n, "fout wordt overgeslagen");
  assert.equal(nep.uploads.length, 1);
  const s = await draai(omg2, ["status"]);
  assert.match(s.stdout, /\[fout\] Fout\.m4a: .*payload_too_small/);
});

test("16. opnieuw: zonder TTY geweigerd; met TTY (via pty) terug naar nieuw", async () => {
  const omg = nieuweOmgeving();
  voegToe(omg, "R1.m4a");
  nep.opts.createError = "invalid_arguments";
  await draai(omg, ["upload"]);
  nep.opts.createError = null;
  assert.equal(statussen(omg)["R1.m4a"], "fout");
  const r = await draai(omg, ["opnieuw", "R1.m4a"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Terminal/);
  assert.equal(statussen(omg)["R1.m4a"], "fout");
  if (!heeftPty) return;
  const viaTty = (invoer) => viaPty(invoer, ["opnieuw", "r1", "--bron", omg.bron, "--uit", omg.uit], { HOME: omg.home, FIREFLIES_API_URL: `${nep.url}/graphql` });
  const nee = await viaTty("n");
  assert.equal(statussen(omg)["R1.m4a"], "fout", nee);
  const ja = await viaTty("j");
  assert.deepEqual(statussen(omg), {}, ja);
  const r2 = await draai(omg, ["upload"]);
  assert.equal(statussen(omg)["R1.m4a"], "bevestigd", r2.alles);
});

test("17. verborgen sleutelinvoer via TTY (pty)", async () => {
  if (!heeftPty) return;
  const omg = nieuweOmgeving();
  voegToe(omg, "K1.m4a");
  const uit = await viaPty(SLEUTEL, ["upload", "--bron", omg.bron, "--uit", omg.uit, "--min-kb", MIN_KB], {
    HOME: omg.home,
    FIREFLIES_API_URL: `${nep.url}/graphql`,
    FIREFLIES_PAUZE_MS: "0",
  });
  alleUitvoer += "\n--- tty\n" + uit;
  assert.ok(!uit.includes(SLEUTEL), "sleutel niet geechood: " + uit);
  assert.equal(nep.uploads.length, 1, uit);
  assert.ok(nep.sleutelsGezien.has(SLEUTEL));
});

// ------------------------------------------------------------ uitvoeren
let mislukt = 0;
let authSchendingen = 0;
for (const t of tests) {
  authSchendingen += nep.uploadAuthSchendingen;
  nep.reset();
  try {
    await t.fn();
    console.log(`OK    ${t.naam}`);
  } catch (e) {
    mislukt++;
    console.log(`FOUT  ${t.naam}\n${e.stack ?? e}\n`);
  }
}
authSchendingen += nep.uploadAuthSchendingen;
// 14. sleutel nergens in uitvoer of voortgang
try {
  assert.ok(alleUitvoer.length > 1000, "uitvoer verzameld");
  assert.ok(!alleUitvoer.includes(SLEUTEL), "API-sleutel staat in uitvoer of voortgangsbestand");
  assert.equal(authSchendingen, 0, "Authorization-header op upload-pad");
  console.log("OK    14. sleutel komt nergens voor in stdout/stderr of voortgangsbestanden");
} catch (e) {
  mislukt++;
  console.log(`FOUT  14. sleutelcontrole\n${e.stack ?? e}`);
}

await nep.close();
fs.rmSync(werkRoot, { recursive: true, force: true });
console.log(mislukt ? `\n${mislukt} test(s) mislukt` : `\nAlle tests geslaagd (${tests.length + 1})`);
process.exit(mislukt ? 1 : 0);
