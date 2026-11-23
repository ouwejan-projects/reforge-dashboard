// Nep-Fireflies-server voor de tests. Luistert alleen op 127.0.0.1.
// Biedt: createUploadUrl, confirmUpload, transcript(id), transcripts(keyword), en de upload zelf.
// Per test instelbaar via `nep.opts` (zie resetOpts) om fouten te injecteren.

import http from "node:http";

export const TEST_DATUM_MS = Date.UTC(2026, 2, 12, 14, 5, 0);

function nieuweOpts() {
  return {
    paidRequired: false,
    tooManyAfter: null, // na zoveel gemaakte URL's: too_many_requests
    createError: null, // bv. "invalid_arguments"
    confirmFail: null, // { code, times, echoKey }
    dropUpload: false, // upload geeft 500 en wordt niet opgeslagen
    notReadyPolls: 0, // eerste N keer transcript(id): nog niet klaar
    notReadyMode: "leeg", // "leeg" (lege sentences) | "null"
    transcriptIdDiffers: false, // transcript(meeting_id) bestaat niet; echte id wijkt af
    scopeEnum: false, // weiger $scope: String (alsof het een enum is)
  };
}

export async function startNepServer() {
  const nep = {
    opts: nieuweOpts(),
    meetings: new Map(), // id -> { id, title, size, received, confirmed, polls, transcriptId }
    bestaand: [], // [{ id, title }] al in Fireflies aanwezig
    ops: [], // namen van aanroepen
    createInputs: [],
    uploads: [], // { id, velden: [namen], bestandsnaam, bytes, titel }
    uploadAuthSchendingen: 0,
    sleutelsGezien: new Set(),
    volgendeId: 1,
    aantalUrls: 0,
  };
  nep.reset = () => {
    nep.opts = nieuweOpts();
    nep.meetings.clear();
    nep.bestaand = [];
    nep.ops = [];
    nep.createInputs = [];
    nep.uploads = [];
    nep.uploadAuthSchendingen = 0;
    nep.sleutelsGezien = new Set();
    nep.volgendeId = 1;
    nep.aantalUrls = 0;
  };
  nep.telOps = (naam) => nep.ops.filter((o) => o === naam).length;

  const transcriptVoor = (id, titel) => ({
    id,
    title: titel,
    date: TEST_DATUM_MS,
    duration: 12.5,
    transcript_url: `https://app.fireflies.ai/view/${id}`,
    sentences: [
      { speaker_name: "Frank", text: "Hallo wereld", start_time: 0.5 },
      { speaker_name: "", text: "Zonder spreker", start_time: 65.2 },
      { speaker_name: "Anna", text: "Na een uur", start_time: 3725 },
    ],
  });

  const alleZoekbaar = () => [
    ...nep.bestaand,
    ...[...nep.meetings.values()]
      .filter((m) => m.confirmed)
      .map((m) => ({ id: m.transcriptId ?? m.id, title: m.title })),
  ];

  function fout(res, status, code, message, extra = {}, plat = false) {
    const e = plat ? { message, code, ...extra } : { message, extensions: { code, ...extra } };
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [e] }));
  }
  const ok = (res, data) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
  };

  async function lees(req) {
    const delen = [];
    for await (const d of req) delen.push(d);
    return Buffer.concat(delen);
  }

  function parseMultipart(buf, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
    if (!m) return null;
    const grens = Buffer.from(`--${m[1] ?? m[2]}`);
    const velden = [];
    let pos = buf.indexOf(grens);
    while (pos !== -1) {
      const start = pos + grens.length;
      if (buf.slice(start, start + 2).toString() === "--") break;
      const kopEind = buf.indexOf("\r\n\r\n", start);
      const volgende = buf.indexOf(grens, kopEind);
      if (kopEind === -1 || volgende === -1) return null;
      const kop = buf.slice(start + 2, kopEind).toString("utf8");
      const body = buf.slice(kopEind + 4, volgende - 2);
      const naam = /name="([^"]*)"/.exec(kop)?.[1];
      const bestandsnaam = /filename="([^"]*)"/.exec(kop)?.[1];
      velden.push({ naam, bestandsnaam, body });
      pos = volgende;
    }
    return velden;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const body = await lees(req);
      if (req.url.startsWith("/upload/")) return await upload(req, res, body);
      if (req.url !== "/graphql" || req.method !== "POST") {
        res.writeHead(404);
        return res.end();
      }
      return await graphql(req, res, body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });

  async function upload(req, res, body) {
    if (req.headers.authorization) nep.uploadAuthSchendingen++;
    const id = req.url.slice("/upload/".length);
    const m = nep.meetings.get(id);
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    const velden = parseMultipart(body, req.headers["content-type"]);
    if (!velden || velden.length === 0 || velden.at(-1).naam !== "file") {
      res.writeHead(400);
      return res.end("bestand moet het laatste veld zijn");
    }
    const vast = velden.slice(0, -1);
    const klopt = m.velden.every((v, i) => vast[i]?.naam === v.name && vast[i].body.toString() === v.value) && vast.length === m.velden.length;
    if (!klopt) {
      res.writeHead(403);
      return res.end("velden kloppen niet");
    }
    if (nep.opts.dropUpload) {
      res.writeHead(500);
      return res.end("opslag kapot");
    }
    m.received = true;
    m.size = velden.at(-1).body.length;
    nep.uploads.push({
      id,
      velden: velden.map((v) => v.naam),
      bestandsnaam: velden.at(-1).bestandsnaam,
      bytes: m.size,
      titel: m.title,
      contentType: req.headers["content-type"]?.split(";")[0],
    });
    res.writeHead(204);
    res.end();
  }

  async function graphql(req, res, body) {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth.length < 12) return fout(res, 401, "unauthorized", "geen sleutel");
    nep.sleutelsGezien.add(auth.slice(7));
    const { query, variables = {} } = JSON.parse(body.toString("utf8"));
    const o = nep.opts;

    if (/createUploadUrl/.test(query)) {
      nep.ops.push("createUploadUrl");
      if (o.paidRequired) return fout(res, 403, "paid_required", "Free plan kan niet uploaden");
      if (o.tooManyAfter !== null && nep.aantalUrls >= o.tooManyAfter) {
        return fout(res, 429, "too_many_requests", "Te veel verzoeken", { metadata: { retryAfter: Date.now() + 3600 * 1000 } }, true);
      }
      if (o.createError) return fout(res, 400, o.createError, `createUploadUrl weigert: ${o.createError}`);
      const i = variables.input ?? {};
      nep.createInputs.push(i);
      const toekomst = Date.parse(i.meeting_date) > Date.now();
      if (
        i.content_type !== "audio/mp4" ||
        i.custom_language !== "nl" ||
        i.upload_method !== "POST" ||
        !i.title ||
        !(i.file_size > 0) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(i.meeting_date ?? "") ||
        toekomst
      ) {
        return fout(res, 400, "invalid_arguments", "ongeldige invoer");
      }
      const id = `mtg_${nep.volgendeId++}`;
      nep.aantalUrls++;
      const velden = [
        { name: "key", value: `uploads/${id}` },
        { name: "policy", value: "geheim-beleid" },
      ];
      nep.meetings.set(id, {
        id,
        title: i.title,
        velden,
        received: false,
        confirmed: false,
        polls: 0,
        transcriptId: o.transcriptIdDiffers ? `tr_${id}` : null,
      });
      return ok(res, {
        createUploadUrl: {
          upload_url: `http://127.0.0.1:${server.address().port}/upload/${id}`,
          upload_method: "POST",
          upload_fields: velden,
          meeting_id: id,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      });
    }

    if (/confirmUpload/.test(query)) {
      nep.ops.push("confirmUpload");
      const id = variables.input?.meeting_id;
      const cf = o.confirmFail;
      if (cf && cf.times > 0) {
        cf.times--;
        const extra = cf.echoKey ? ` (verzoek met ${auth})` : "";
        return fout(res, cf.code === "service_unavailable" ? 503 : 400, cf.code, `confirm mislukt${extra}`);
      }
      const m = nep.meetings.get(id);
      if (!m || !m.received) return fout(res, 404, "object_not_found", "Audio niet gevonden");
      if (m.confirmed) return fout(res, 400, "invalid_arguments", "al bevestigd");
      m.confirmed = true;
      return ok(res, { confirmUpload: { success: true, meeting_id: id, message: "ok", url: `https://app.fireflies.ai/view/${m.transcriptId ?? id}` } });
    }

    if (/transcripts\s*\(/.test(query)) {
      nep.ops.push("transcripts");
      if (o.scopeEnum && /\$scope:\s*String/.test(query)) {
        return fout(res, 400, "GRAPHQL_VALIDATION_FAILED", 'Variable "$scope" of type "String" used in position expecting type "TranscriptScope".');
      }
      if (variables.scope !== undefined && variables.scope !== "title") return fout(res, 400, "invalid_arguments", "scope");
      if (variables.scope === undefined && !/scope:\s*title/.test(query)) return fout(res, 400, "invalid_arguments", "scope");
      const kw = String(variables.keyword ?? "").toLowerCase();
      const limit = Math.min(variables.limit ?? 10, 50);
      const skip = variables.skip ?? 0;
      const treffers = alleZoekbaar().filter((t) => t.title.toLowerCase().includes(kw));
      return ok(res, { transcripts: treffers.slice(skip, skip + limit) });
    }

    if (/transcript\s*\(/.test(query)) {
      nep.ops.push("transcript");
      const id = variables.id;
      const bestaand = nep.bestaand.find((b) => b.id === id);
      if (bestaand) return ok(res, { transcript: transcriptVoor(id, bestaand.title) });
      const m = [...nep.meetings.values()].find((x) => (x.transcriptId ?? x.id) === id);
      if (!m || !m.confirmed) return fout(res, 404, "object_not_found", "transcript niet gevonden");
      m.polls++;
      if (m.polls <= o.notReadyPolls) {
        if (o.notReadyMode === "null") return ok(res, { transcript: null });
        return ok(res, { transcript: { ...transcriptVoor(id, m.title), sentences: [] } });
      }
      return ok(res, { transcript: transcriptVoor(id, m.title) });
    }

    return fout(res, 400, "invalid_arguments", "onbekende query");
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  nep.port = server.address().port;
  nep.url = `http://127.0.0.1:${nep.port}`;
  nep.close = () => new Promise((r) => server.close(r));
  return nep;
}
