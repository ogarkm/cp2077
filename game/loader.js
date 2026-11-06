// Cloudflare loading screen driver (R2 copy of the page only; see scripts/make-r2-page.mjs).
// Loaded right AFTER cp2077.js and BEFORE the page's inline launcher. Wraps createCP2077 so the
// launcher's own config object (== emscripten Module) can be observed, and drives #cp-loader from
// REAL signals only:
//   Link     cp2077.js arrived (this script runs)
//   Engine   decoded bytes of cp2077.wasm (counting fetch body) + setStatus "Downloading data... (a/b)"
//   Compile  wasm stream finished -> WebAssembly.instantiateStreaming resolved
//   Archives game-files.json fetched -> "resource filesystem mounted" -> gsmState_Initialization active
//   Shaders  Module.cp2077PipelineCacheStats.entries (asymptotic, completes at session start)
//   World    "loading stage probe ... value=N" (N of 15) -> gsmState_SessionActive -> steady presented frames
// Asset MB/s = main-thread metrics + per-pthread counts from BroadcastChannel 'cp2077-loader-io'.
// READY (menu mode, the default): pre-game session + front-end UI up + steady frames (no io-calm rule).
// READY = session active (menu mode: pre-game session) AND >= 60 frames presented since then with
//         frame interval < 100 ms AND asset reads calm (< 4 MB/s, when metrics exist), held for 1 s.
// The bar never moves backwards and never reaches 100 % before READY.
(() => {
  'use strict';
  const C = globalThis.cp2077LoaderConfig || {};
  const $ = id => document.getElementById(id);
  const root = $('cp-loader');
  if (!root) return;
  if (typeof globalThis.createCP2077 !== 'function') {
    // Engine script missing (bad ?engine=, bundle not uploaded, blocked) -> error panel; but not on the
    // cross-origin page while it is waiting for an access code (CPB === null: the code panel is showing).
    const staticFail = msg => {
      if (globalThis.CP_UNSUPPORTED || (globalThis.CPB === null && !globalThis.CP_ENGINE_BLOCK)) return;   // capcheck panel / code panel own the screen
      root.classList.add('failed');
      const e = $('cp-err'), m = $('cp-err-msg'), s = $('cp-stage');
      if (m) m.textContent = String(msg).slice(0, 600); if (e) e.hidden = false; if (s) s.textContent = 'Link failed';
    };
    globalThis.cp2077LoaderFail = staticFail;
    staticFail(globalThis.cp2077LoaderPreError || 'The engine script failed to load. Reload the page; if it keeps happening the engine bundle is missing on the server.');
    return;
  }
  const q = new URLSearchParams(location.search);
  const sessionMode = q.get('start') === 'nomadfree' || q.get('start') === 'nomad' || q.get('start') === 'nomadquest' ||
    q.has('sandbox') || q.has('sandboxWorld') || q.has('sandboxGamedef') || q.has('skipStartScreen');
  const MB = 1e6, t0 = performance.now();
  let timer = 0;

  const STAGES = [
    {k: 'Link', label: 'Establishing link', w: 3},
    {k: 'Engine', label: 'Downloading engine', w: 40},
    {k: 'Compile', label: 'Compiling engine', w: 10},
    {k: 'Archives', label: 'Mounting archives', w: 7},
    {k: 'Shaders', label: 'Building shaders', w: 15},
    {k: 'World', label: sessionMode ? 'Streaming the Badlands' : 'Loading main menu', w: 25},
  ];
  const frac = STAGES.map(() => 0);
  const S = {wasmBytes: 0, dataLoaded: 0, dataTotal: 0, wasmDone: false, compiled: false, compileStart: 0,
    manifest: false, mounted: false, initActive: false, preGame: false, loadingValue: 0, sessionActive: false,
    activeAt: 0, framesAtActive: 0, steadySince: 0, ready: false, failed: false, lastLoadingText: '', binkFrames: 0,
    marks: {}};
  frac[0] = 1;
  // Boot timeline (ms since navigation start), for tuning: JSON.stringify(cp2077Loader.timeline())
  const mark = name => { if (S.marks[name] == null) S.marks[name] = Math.round(performance.now()); };
  mark('loaderStart');

  // ------------------------------------------------------------ engine download: count wasm body bytes
  // The engine gets the ORIGINAL Response (URL + HTTP-cache identity intact, so V8 can stream-compile it and
  // keep its wasm code cache for repeat visits); bytes are counted on a clone. A constructed Response would
  // have no URL and disable the code cache.
  // [gpupend] 2026-10-24: Android (Mali) sessions freeze in startup with every engine worker inside a resource job.
  // The engine waits synchronously on WebGPU promises (error scopes around each upload, mapAsync, pipelines); count the
  // ones still outstanding and their age so stall reports show whether the browser stopped answering one.
  const GP = new Map(); let gpSeq = 0;
  const gpWrap = (proto, name) => { const f = proto && proto[name]; if (typeof f !== 'function') return;
    proto[name] = function () { const p = f.apply(this, arguments); if (p && typeof p.then === 'function') { const k = ++gpSeq; GP.set(k, [name, performance.now()]); p.then(() => GP.delete(k), () => GP.delete(k)); } return p; }; };
  try {
    gpWrap(globalThis.GPUDevice?.prototype, 'popErrorScope'); gpWrap(globalThis.GPUDevice?.prototype, 'createComputePipelineAsync');
    gpWrap(globalThis.GPUDevice?.prototype, 'createRenderPipelineAsync'); gpWrap(globalThis.GPUQueue?.prototype, 'onSubmittedWorkDone');
    gpWrap(globalThis.GPUBuffer?.prototype, 'mapAsync');
  } catch {}
  // [scopetimeout] 2026-10-24 Android reports: 8 of 15 GatheredResources freezes had popErrorScope promises unanswered
  // for 7-63 s; the engine waits for those callbacks around every texture/buffer upload, so the whole load deadlocked.
  // After 5 s answer "no error" ourselves (a late real answer is ignored). ?scopeTimeout=0 = original wait.
  try {
    const P = globalThis.GPUDevice?.prototype, pop = P && P.popErrorScope;
    if (pop && !/[?&]scopeTimeout=0(&|$)/.test(location.search)) {
      let timedOut = 0;
      P.popErrorScope = function () {
        const real = pop.apply(this, arguments);
        let timer = 0;
        const guard = new Promise(res => { timer = setTimeout(() => { S.scopeTimeouts = timedOut + 1; if (++timedOut <= 3 || (timedOut & (timedOut - 1)) === 0)
          ringAdd('CP2077 WebGPU popErrorScope unanswered after 5 s, continuing (failed=timeout) count=' + timedOut); res(null); }, 5000); });
        real.then(() => clearTimeout(timer), () => clearTimeout(timer));
        return Promise.race([real, guard]);
      };
    }
  } catch {}
  const gpuPending = () => { const now = performance.now(), o = {}; for (const [n, t] of GP.values()) { const e = o[n] || (o[n] = [0, 0]); e[0]++; e[1] = Math.max(e[1], Math.round((now - t) / 1000)); } return o; };
  const origFetch = globalThis.fetch;
  globalThis.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const p = origFetch.apply(this, arguments);
    if (/\/cp2077\.wasm(\?|$)/.test(url)) {
      mark('wasmRequest'); S.wasmUrl = url;
      return p.then(r => {
        mark('wasmResponse');
        if (!r.ok || !r.body) return r;
        try {
          const reader = r.clone().body.getReader();
          (function pump() {
            reader.read().then(({done, value}) => {
              if (done) { S.wasmDone = true; S.compileStart = performance.now(); mark('wasmDownloaded'); return; }
              S.wasmBytes += value.byteLength; pump();
            }, () => {});
          })();
        } catch {}
        return r;
      });
    }
    if (/\/runtime\/game-files\.json/.test(url)) p.then(r => { if (r.ok) { S.manifest = true; mark('manifest'); } }, () => {});
    return p;
  };
  const origInstantiate = WebAssembly.instantiate;   // fallback path (ArrayBuffer) after a streaming failure
  // [wasmresume] 2026-10-24 probes: ~70 sessions/day died with "both async and sync fetching of the wasm failed" a few
  // MB into the 59 MB download (connection reset; Emscripten's fallback refetches the whole file once and fails too).
  // Only after a failed streaming compile: download the raw .wasm in 8 MB Range chunks (each retried with backoff)
  // and compile from memory. The normal path still hands V8 the original Response (code cache intact).
  async function resumableWasm(url) {
    const chunk = 8 << 20, sleep = ms => new Promise(r => setTimeout(r, ms));
    let total = 0, got = 0, parts = [];
    while (!total || got < total) {
      const end = total ? Math.min(total, got + chunk) - 1 : got + chunk - 1;
      for (let attempt = 0; ; ++attempt) {
        try {
          const r = await origFetch(url, {headers: {Range: `bytes=${got}-${end}`}, cache: 'no-store'});
          const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(r.headers.get('Content-Range') || '');
          if (r.status !== 206 || !m || +m[1] !== got) throw new Error('range status ' + r.status);
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length !== +m[2] - got + 1) throw new Error('short range');
          total = +m[3]; parts.push(b); got += b.length; S.wasmBytes = Math.max(S.wasmBytes, got); break;
        } catch (e) {
          if (attempt >= 5) throw e;
          ringAdd('wasm range retry ' + (attempt + 1) + ' at ' + got + ': ' + e);
          await sleep(1000 << attempt);
        }
      }
    }
    const all = new Uint8Array(total); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
    return all;
  }
  const origStreaming = WebAssembly.instantiateStreaming;
  if (origStreaming) WebAssembly.instantiateStreaming = function(source, imports) {
    mark('compileStart');
    const done = v => { S.wasmDone = true; S.compiled = true; mark('compiled'); return v; };
    return origStreaming.call(this, source, imports).then(done, async err => {
      if (!S.wasmUrl || !/fetch|network|failed|abort|terminat|reset|incomplete|length/i.test(String(err && err.message || err))) throw err;
      ringAdd('wasm stream failed, resuming by range: ' + err);
      $('cp-stage').textContent = 'Connection dropped · resuming';
      const bytes = await resumableWasm(S.wasmUrl);
      mark('wasmDownloaded');
      return origInstantiate.call(WebAssembly, bytes, imports).then(done);
    });
  };
  WebAssembly.instantiate = function(src) {
    const r = origInstantiate.apply(this, arguments);
    if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) r.then(() => { S.wasmDone = true; S.compiled = true; }, () => {});
    return r;
  };

  // ------------------------------------------------------------ engine messages
  function onMessage(msg) {
    if (typeof msg !== 'string' || !msg.startsWith('CP2077 ')) return;
    let m;
    if ((m = /^CP2077 game state probe: phase=active class=(\w+)/.exec(msg))) {
      mark(m[1].replace('gsmState_', 'state:'));
      if (m[1] === 'gsmState_Initialization') S.initActive = true;
      if (m[1] === 'gsmState_PreGameSession') { S.initActive = true; S.preGame = true; if (!sessionMode) markActive(); }
      if (m[1] === 'gsmState_SessionActive') { S.initActive = true; markActive(); }
    } else if ((m = /^CP2077 loading stage probe: phase=enter stage=(.+?) value=(\d+)/.exec(msg))) {
      S.loadingValue = Math.max(S.loadingValue, Number(m[2]));
      S.lastLoadingText = m[1].replace(/\.$/, '');
      if (/WaitingForUpdateBehindLoadingScreen/.test(m[1])) S.menuUi = true;   // same marker cp2077-jump.js uses
    } else if ((m = /^CP2077 session menu gate probe: .*?targetUI=(\d+) activeUI=(\d+)/.exec(msg))) {
      if (Number(m[2]) > 0 && m[1] === m[2]) S.menuUi = true;     // main menu UI is up
    } else if (/^CP2077 loading UI probe: controller=initialLoadingScreenLogicController/.test(msg)) S.menuUi = true;   // "press to continue" start screen
    else if (/resource filesystem mounted/.test(msg)) { S.mounted = true; mark('mounted'); }
    else if (/^CP2077 WebGPU: device lost/.test(msg) && gpuLiteRetry(msg)) {}
    else if (/^CP2077 WebGPU(: device lost| not available)/.test(msg)) fail(msg.replace(/^CP2077 /, ''));
  }
  // [gpulite] 2026-10-27 probes: 165 Chrome sessions/day lost the GPU device (GPU process crash on Mali, Intel gen-8,
  // AMD GCN-4 ...), mostly during startup. Once per tab: reload with the lightest settings (engine-select.js reads the
  // flag: potato=3, texDrop=2) instead of failing. A second loss shows the error.
  function gpuLiteRetry(msg) {
    try {
      if (S.failed || S.gpuLiteReload || sessionStorage.getItem("cp2077_gpulite")) return false;
      sessionStorage.setItem("cp2077_gpulite", "1"); S.gpuLiteReload = true;
      stallReport(0, msg.slice(0, 120), "gpulite");
      $('cp-stage').textContent = "Graphics reset · retrying with lighter settings";
      setTimeout(() => location.reload(), 800);
      return true;
    } catch { return false; }
  }
  function markActive() {
    if (S.sessionActive) return;
    S.sessionActive = true; S.activeAt = performance.now();
    S.framesAtActive = mod()?.cp2077PresentationStats?.validatedFrames || 0;
  }
  // [stall-diag] last notable engine/console lines for the stall report (user 2026-10-22: PC Brave stuck on assets)
  // [progress-ring] 2026-10-23: RING only keeps error-looking lines, so a stall report could not tell where startup stopped
  // (low-end GPUs freeze after the shader cache). PRING keeps the last engine startup milestones for stall/fail reports.
  const PRING = [], PROG = /native (state enter|initializer begin|startup|init job)|game state probe: phase=active|WebGPU: (adapter|device)|opt switches|whitewall switches|io lookahead|static shader cache|render shader map|async compute pipelines \((all|waited)|lazycs|lazygfx|mapped buffer created: id=([0-9]|1[0-9]) /;
  const RING = [], ringAdd = t => { try { t = String(t); if (PROG.test(t)) { PRING.push(Math.round(performance.now() / 1000) + "s " + t.slice(0, 160)); if (PRING.length > 40) PRING.shift(); } if (/fail|error|exception|abort|timeout|denied|quota|io helper|persist|range|stall|lost|NETFAIL|refused/i.test(t)) { RING.push(Math.round(performance.now() / 1000) + "s " + t.slice(0, 220)); if (RING.length > 40) RING.shift(); fatalLine(t); } } catch {} };
  // [player-fix] 2026-10-22 player reports (Worker /__probe): lines that mean this load can never finish.
  // - Firefox / some mobile GPUs: no storage binding for rg11b10ufloat / r8unorm (texture-formats-tier1) -> core render
  //   targets fail and the load sits at 57 % forever. Say so at once instead of letting players wait.
  // - "Oodle decode failed" / Kraken error = corrupt cached block (OPFS) -> wipe the block cache and reload once.
  let fatalSeen = false;
  function fatalLine(t) {
    if (fatalSeen || S.failed || S.ready) return;
    if (/STORAGE_BINDING\) are not allowed on a texture/.test(t)) {
      fatalSeen = true;
      setTimeout(() => fail("Your browser's WebGPU is missing a feature this game needs (storage textures). Use the latest Chrome or Edge on a desktop PC (Firefox is not supported yet)."), 0);
    } else if (/Oodle decode failed|Kraken decompression error/.test(t)) {
      let tried = 0; try { tried = +(sessionStorage.getItem("cp2077_block_repair") || 0); } catch {}
      if (tried >= 1) return;
      fatalSeen = true;
      try { sessionStorage.setItem("cp2077_block_repair", "1"); } catch {}
      setTimeout(() => {
        const st = $("cp-stage"); if (st) st.textContent = "Repairing downloaded data";
        S.failed = true;   // stop the stall/fail paths; the page reloads
        const reload = () => setTimeout(() => location.reload(), 500);
        (navigator.storage?.getDirectory ? navigator.storage.getDirectory().then(r => r.removeEntry("cp2077-blocks-v1", {recursive: true})) : Promise.resolve())
          .catch(e => ringAdd("wipe " + e)).then(reload, reload);
      }, 0);
    }
  }
  addEventListener("error", e => ringAdd("onerror " + (e.message || e.target?.src || "")), true);
  addEventListener("unhandledrejection", e => ringAdd("rejection " + (e.reason?.message || e.reason)));
  // [gs-repair] user 2026-10-22 (PC Brave): "native initializer failed: GameServices" = LoadBrowserProfile() rejected an
  // unreadable /userdata/browser-profile.bin (it never overwrites a corrupt one) and the engine shut down at 57 %.
  // Delete just that file from the IDBFS store (db "/userdata", store FILE_DATA) and reload once; the engine makes a new one.
  let gsRepairing = false;
  function gsRepair() {
    if (gsRepairing) return; gsRepairing = true;
    let tried = 0; try { tried = +(sessionStorage.getItem("cp2077_gs_repair") || 0); } catch {}
    if (tried >= 1) { fail("The game could not start its local profile in this browser. Clear this site's data (lock icon > Site settings > Delete data), then reload."); return; }
    try { sessionStorage.setItem("cp2077_gs_repair", "1"); } catch {}
    const st = $("cp-stage"); if (st) st.textContent = "Repairing local profile";
    const reload = () => setTimeout(() => location.reload(), 500);
    try {
      const rq = indexedDB.open("/userdata");
      rq.onsuccess = () => { try { const db = rq.result; const tx = db.transaction("FILE_DATA", "readwrite");
        tx.objectStore("FILE_DATA").delete("/userdata/browser-profile.bin"); tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); reload(); }; } catch (e) { reload(); } };
      rq.onerror = reload; rq.onblocked = reload;
    } catch (e) { reload(); }
  }
  const origLog = console.log, origErr = console.error;
  console.log = function(...a) {
    try {
      const s0 = String(a[0]); ringAdd(s0);
      if (/resource filesystem mounted/.test(s0)) { S.mounted = true; mark('mounted'); }
      else if (/^CP2077 io helper: warm /.test(s0)) mark('warm:' + s0.slice(25, 60));     // io6 helper warm progress lines
      else if (/^CP2077 io helper: persistent store/.test(s0)) mark('persistStore');
    } catch {}
    return origLog.apply(this, a);
  };
  console.error = function(...a) {
    try {
      const s = String(a[0]); ringAdd(s);
      if (/warmup session phase:/.test(s)) S.warmSessionPhase = true;
      if (/native initializer failed: GameServices/.test(s)) gsRepair();
      if (/^CP2077 native engine launch failed/.test(s)) fail(String(a[1]?.message || a[1] || s));
    } catch {}
    return origErr.apply(this, a);
  };

  // ------------------------------------------------------------ wrap createCP2077 (keeps the launcher untouched)
  let cfgRef = null;
  const mod = () => globalThis.cp2077EngineModule || cfgRef;
  const origCreate = globalThis.createCP2077;
  globalThis.createCP2077 = function(cfg = {}) {
    cfgRef = cfg;
    const pe = cfg.printErr, pr = cfg.print, ss = cfg.setStatus, oa = cfg.onAbort;
    cfg.printErr = function(msg) { try { onMessage(msg); ringAdd(msg); if (/warmup session phase:/.test(String(msg))) S.warmSessionPhase = true; if (/native initializer failed: GameServices/.test(String(msg))) gsRepair(); } catch {} return pe ? pe.apply(this, arguments) : origErr(msg); };
    cfg.print = function(msg) { try { onMessage(msg); ringAdd(msg); } catch {} return pr ? pr.apply(this, arguments) : origLog(msg); };
    cfg.setStatus = function(text) {
      const m = /Downloading data\.\.\. \((\d+)\/(\d+)\)/.exec(String(text || ''));
      if (m) { S.dataLoaded = Number(m[1]); S.dataTotal = Number(m[2]); }
      return ss ? ss.apply(this, arguments) : undefined;
    };
    cfg.onAbort = function(what) { fail('The engine stopped: ' + String(what || 'abort')); return oa ? oa.apply(this, arguments) : undefined; };
    const p = origCreate.apply(this, arguments);
    p.then(() => { S.wasmDone = true; S.compiled = true; }, e => fail(String(e?.message || e)));
    return p;
  };
  addEventListener('unhandledrejection', e => { if (/Aborted\(|RuntimeError/.test(String(e.reason))) fail(String(e.reason?.message || e.reason)); });
  addEventListener('error', e => { if (/Aborted\(|RuntimeError: /.test(String(e.message))) fail(String(e.message)); });

  // ------------------------------------------------------------ UI
  const total = STAGES.reduce((a, s) => a + s.w, 0);
  $('cp-steps').innerHTML = STAGES.map((s, i) => `<b data-i="${i}">${String(i + 1).padStart(2, '0')} ${s.k}</b>`).join('');
  let shown = 0, ioLast = 0, ioLastAt = performance.now(), ioRate = 0, ioSamples = [];
  // Archive reads run in pthread workers (their own XHR + LRU), invisible to cp2077ResourceFileMetrics on the
  // main thread. cp2077.js?loaderio=1 (served by the Cloudflare Worker) makes each worker publish its byte count.
  const workerIo = new Map();
  let workerIoSeen = false;
  try {
    const bc = new BroadcastChannel('cp2077-loader-io');
    bc.onmessage = e => { const d = e.data; if (d && typeof d.id === 'string' && Number.isFinite(d.bytes)) { workerIo.set(d.id, d.bytes); workerIoSeen = true; } };
    S.closeIo = () => bc.close();
  } catch {}
  const assetBytes = m => { let b = Number(m?.cp2077ResourceFileMetrics?.bytesFetched) || 0; for (const v of workerIo.values()) b += v; return b; };
  const gzTotal = (C.wasmGz || 0) + (C.dataGz || 0) + (C.jsGz || 0);
  function engineDownloaded() {   // in transferred (gzip) MB: decoded fraction x gzip size
    const w = C.wasmSize ? Math.min(1, S.wasmBytes / C.wasmSize) : 0;
    const d = S.dataTotal ? S.dataLoaded / S.dataTotal : (S.compiled ? 1 : 0);
    return {w, d, mb: ((C.jsGz || 0) + w * (C.wasmGz || 0) + d * (C.dataGz || 0)) / MB};
  }
  function update() {
    if (S.failed || S.ready) return;
    const now = performance.now(), m = mod();
    // Start screen / intro video: the engine plays Bink movies there. Count decoded frames (main-thread request API).
    if (m && typeof m.cp2077BinkRequest === 'function' && !m.cp2077BinkRequest.__cpLoader) {
      const orig = m.cp2077BinkRequest;
      const wrapped = function(packet) {
        const p = orig.apply(this, arguments);
        if (packet && packet.type === 'frame') p.then(() => {
          S.binkFrames++; mark('firstBinkFrame');
          if (S.binkFrames >= 15 && S.preGame) { if (!S.menuUi) mark('menuUi:bink'); S.menuUi = true; }
        }, () => {});
        return p;
      };
      wrapped.__cpLoader = true;
      m.cp2077BinkRequest = wrapped;
    }
    if (S.menuUi) mark('menuUi');
    if (S.sessionActive) mark('sessionActive');
    const eng = engineDownloaded();
    frac[1] = Math.max(frac[1], S.compiled ? 1 : Math.min(0.99, 0.97 * eng.w + 0.03 * eng.d));
    if (S.compiled) frac[2] = 1;
    else if (S.wasmDone) frac[2] = Math.max(frac[2], Math.min(0.9, 1 - Math.exp(-(now - S.compileStart) / 8000)));
    frac[3] = Math.max(frac[3], S.initActive ? 1 : S.mounted ? 0.7 : S.manifest ? 0.35 : S.compiled ? 0.1 : 0);
    const pipes = m?.cp2077PipelineCacheStats?.entries || 0;
    frac[4] = Math.max(frac[4], S.sessionActive ? 1 : Math.min(0.95, 1 - Math.exp(-pipes / 400)));
    // World: loading stages 1..15 -> 0..0.8, session active 0.85, then steady frames up to 0.99.
    const p = m?.cp2077PresentationStats || {}, frames = p.validatedFrames || 0;
    let w = Math.min(0.8, (S.loadingValue / 15) * 0.8);
    if (S.preGame && !sessionMode) w = Math.max(w, 0.6);
    // [warm-gate] user 2026-10-22: new players froze right after the loader because the render-pipeline warmup
    // (Module.cp2077PipelineWarmup, ~500 pipelines, 60-90 s cold) was still running. Keep the loader up until it has
    // finished (cap: 4 min after the session went active), and show its progress.
    const pw = m?.cp2077PipelineWarmup;
    // [warm-gate v2] only the pre-session pipelines gate READY: the "#session" phase (~54 gameplay pipelines, ~1 s each)
    // starts at session active and keeps warming while the player is in the menus / character creation.
    // idle = everything issued so far has finished and nothing is in flight for 2 s: the warm thread is waiting for the
    // game session (it starts only after the intro / "press to continue"), so the loader must not cover that screen.
    const warmBusy = pw && (pw.inFlight > 0 || pw.done + pw.failed < pw.started || !pw.started);
    if (warmBusy) S.warmBusyAt = now;
    const warmIdle = pw && pw.started > 0 && now - (S.warmBusyAt || now) > 2000;
    // [warmgate-opt] default since 2026-10-22 (fresh-user test: loader 43 s -> 37 s, 0 hitches, start screen complete): READY no longer waits for the pre-session warmup (asyncPso skips unready draws, psoWarmK=12 finishes it during the intro). ?warmGate=1 = old gate.
    const warmPending = q.get('warmGate') === '1' && !!(pw && pw.total > 0 && !pw.finished && !warmIdle && !S.warmSessionPhase && S.sessionActive && now - S.activeAt < 240000);
    const warmFrac = pw && pw.total > 0 ? Math.min(1, (pw.done + pw.failed + pw.skipped) / pw.total) : 1;
    if (S.sessionActive) w = Math.max(w, 0.85 + 0.14 * Math.min(Math.min(1, (frames - S.framesAtActive) / 60), warmFrac));
    frac[5] = Math.max(frac[5], Math.min(0.99, w));

    const asset = m?.cp2077ResourceFileMetrics || (workerIoSeen ? {} : null), totalAsset = assetBytes(m);
    if (asset && now - ioLastAt >= 1000) {
      ioRate = (totalAsset - ioLast) / ((now - ioLastAt) / 1000); ioLast = totalAsset; ioLastAt = now;
      ioSamples.push(ioRate); if (ioSamples.length > 2) ioSamples.shift();
    }
    // READY check
    // Front end (no start/sandbox args): READY when the pre-game session (start screen / main menu) is active,
    // its UI is actually showing (start screen: initialLoadingScreenLogicController loading-UI probe; main menu:
    // session menu gate probe activeUI == targetUI > 0; or stage WaitingForUpdateBehindLoadingScreen) and frames
    // present steadily. Asset reads are NOT required to calm (the menu streams its background video).
    // Fallback: 60 s after the pre-game state.
    const menuReady = !warmPending && !sessionMode && S.sessionActive && S.menuUi &&
      frames - S.framesAtActive >= 30 && Number(p.lastIntervalMs) > 0 && p.lastIntervalMs < 150;
    // [streamin] 2026-10-24: in-world starts no longer wait for asset reads to calm (< 4 MB/s): that held the loading
    // screen ~6.5 s after the session was active while textures/models kept streaming in (they stream in over time
    // in the world now). 20 steady frames held 0.4 s (readyt.mjs: active -> ready was 3.0 s with 30 / 0.6 s). ?ioCalm=1 = old rule (60 frames + calm, 1 s).
    const ioCalmRule = q.get('ioCalm') === '1';
    const steady = menuReady || !warmPending && sessionMode && S.sessionActive && frames - S.framesAtActive >= (ioCalmRule ? 60 : 20) && Number(p.lastIntervalMs) > 0 && p.lastIntervalMs < 100 &&
      (!ioCalmRule || !asset || ioSamples.every(r => r < 4 * MB));
    const forced = !warmPending && S.sessionActive && frames - S.framesAtActive >= 30 && now - S.activeAt > (sessionMode ? 45000 : 60000);   // never trap a playable game
    if (steady || forced) { if (!S.steadySince) S.steadySince = now; } else S.steadySince = 0;
    if ((S.steadySince && now - S.steadySince >= (menuReady ? 600 : !ioCalmRule ? 400 : 1000)) || forced) return finish();

    const done = STAGES.reduce((a, s, i) => a + s.w * frac[i], 0);
    shown = Math.max(shown, Math.min(99, done / total * 100));
    $('cp-fill').style.width = shown.toFixed(2) + '%';
    $('cp-pct').textContent = Math.floor(shown);
    let cur = frac.findIndex(f => f < 1);
    if (cur === 4 && S.loadingValue > 0) cur = 5;   // world streaming has started; shaders keep building alongside
    root.querySelectorAll('#cp-steps b').forEach(b => { const i = +b.dataset.i; b.className = i < cur || cur < 0 ? 'done' : i === cur ? 'now' : ''; });
    const st = STAGES[cur < 0 ? 5 : cur];
    let label = st.label;
    if (st.k === 'Engine') label += ` · ${eng.mb.toFixed(1)} / ${(gzTotal / MB).toFixed(1)} MB`;
    if (st.k === 'Shaders' && pipes) label += ` · ${pipes} pipelines`;
    // [player-fix] players read a minute of "Mounting archives" as frozen: after the mount the engine is starting up
    // (systems init, first data reads, shader warmup); say that and show the shader count when there is one.
    if (st.k === 'Archives' && S.mounted) label = pipes ? `Starting engine · ${pipes} shaders ready` : 'Starting engine';
    if (st.k === 'World' && S.lastLoadingText && !S.sessionActive) label += ` · ${S.lastLoadingText}`;
    if (st.k === 'World' && S.sessionActive) label = sessionMode ? 'Warming up' : 'Starting up';
    if (st.k === 'World' && warmPending) label = `Preparing shaders · ${pw.done + pw.failed + pw.skipped} / ${pw.total}`;
    $('cp-stage').textContent = label;
    const secs = (now - t0) / 1000;
    const assetMb = totalAsset / MB;
    $('cp-meta').textContent = S.compiled
      ? `assets ${assetMb.toFixed(1)} MB · ${(Math.max(0, ioRate) / MB).toFixed(1)} MB/s`
      : `${eng.mb.toFixed(1)} / ${(gzTotal / MB).toFixed(1)} MB · ${(eng.mb / Math.max(secs, 0.1)).toFixed(1)} MB/s`;
    if (secs > 600) $('cp-slow').hidden = false;
    // [stall] user 2026-10-22: PC load sat at 57 % with 0.0 MB/s. No bar or asset progress for 75 s while the tab
    // is visible -> reload (the OPFS block cache keeps what was downloaded); at most 2 auto-reloads per tab session.
    const sig = Math.floor(shown * 10) + ":" + Math.floor(totalAsset / 65536) + ":" + (S.loadingValue || 0);
    if (sig !== S.stallSig || document.hidden) { S.stallSig = sig; S.stallAt = now; }
    // the bar itself frozen for 3 min (assets may still trickle, e.g. re-reading) counts as a stall too
    const pctSig = Math.floor(shown) + ":" + (S.loadingValue || 0);
    // [player-fix] 2026-10-22 reports: slow connections (1-3 MB/s) sat at 68 % for > 3 min while still downloading and got
    // reloaded (twice, then "Loading stopped making progress"). Real download progress (16 MB) restarts this timer too.
    if (pctSig !== S.pctSig || document.hidden || totalAsset - (S.pctAssets || 0) > 16 * MB) { S.pctSig = pctSig; S.pctAt = now; S.pctAssets = totalAsset; }
    // [stall-alive] 2026-10-23: a slow CPU loading a world from cached data presents loading-screen frames for minutes
    // with no bar/byte change; that is work, not a stall. While frames keep coming the limits stretch to 4 / 6 min.
    if (frames !== S.stallFrames) { S.stallFrames = frames; S.framesMovedAt = now; }
    // [jobbeat] 2026-10-24 probes: slow PCs spend 49-201 s in the engine's "GatheredResources" startup step, which
    // shows no bar/byte/frame change, so the 75 s rule reloaded PCs that were still working. (The Android hang in the
    // same step was a real deadlock: BC textures, fixed in the engine [nobc]; its job slots stay frozen.) The engine's
    // per-worker job slots change whenever a job starts or ends: a change within 30 s means busy, not hung.
    let jobSig = ''; try { jobSig = (m?.cp2077NativeJobSnapshot?.() || []).map(r => r.worker + ':' + r.beganAt).join(','); } catch {}
    if (jobSig && jobSig !== S.jobSig) { S.jobSig = jobSig; S.jobsMovedAt = now; }
    const jobsAlive = S.jobsMovedAt && now - S.jobsMovedAt < 30000;
    const engineAlive = S.framesMovedAt && now - S.framesMovedAt < 5000;
    if (jobsAlive && !engineAlive && secs > 60 && S.mounted && !S.sessionActive) { const sl = $('cp-slow'); if (sl.hidden) { sl.textContent = 'Starting the engine takes a few minutes on phones and slower PCs. Keep this tab open.'; sl.hidden = false; } }
    const stallMs = engineAlive ? 240000 : jobsAlive ? 300000 : 75000, pctMs = engineAlive ? 360000 : jobsAlive ? 600000 : 180000;
    if (S.compiled && !S.stallFired && ((now - S.stallAt > stallMs) || (now - S.pctAt > pctMs))) {
      S.stallFired = true;
      let n = 0; try { n = +(sessionStorage.getItem("cp2077_stall_reloads") || 0); } catch {}
      stallReport(n, sig);
      // 1st stall: plain reload. 2nd: also wipe the OPFS block cache (old/corrupt cached game data), then reload.
      const wipe = n === 1 && navigator.storage?.getDirectory ? navigator.storage.getDirectory().then(r => r.removeEntry("cp2077-blocks-v1", {recursive: true})).catch(e => ringAdd("wipe " + e)) : Promise.resolve();
      if (n < 2) { try { sessionStorage.setItem("cp2077_stall_reloads", String(n + 1)); } catch {} $('cp-stage').textContent = n === 1 ? "Stalled · clearing cache" : "Stalled · reconnecting"; wipe.then(() => setTimeout(() => location.reload(), 800)); }
      else fail("Loading stopped making progress. Close other tabs of this game, then reload the page.");
    }
  }
  function stallReport(n, sig, kind) {
    try {
      const m = mod(), io = m?.cp2077ResourceFileMetrics;
      const res = performance.getEntriesByType("resource"), slow = res.filter(e => !e.responseEnd).length;
      const body = JSON.stringify({v: 1, kind: kind || "stall", ready: !!S.ready, failed: !!S.failed, err: $("cp-err-msg")?.textContent || null, ua: navigator.userAgent, t: Date.now(), n, sig, shown: Math.floor(shown),
        stage: $("cp-stage")?.textContent, meta: $("cp-meta")?.textContent, marks: S.marks, upSec: Math.round(performance.now() / 1000),
        engine: String(globalThis.CP_ENGINE || "").slice(0, 12), gpu: S.gpuInfo || null, heapMB: (() => { try { const m = mod(); const d = m && Object.getOwnPropertyDescriptor(m, "HEAP8"); /* [heap8] never call Emscripten's unexported-symbol getter: it abort()s the engine */ return d && "value" in d && d.value ? Math.round(d.value.buffer.byteLength / 1048576) : null; } catch { return null; } })(), coi: !!globalThis.crossOriginIsolated, mem: navigator.deviceMemory, cores: navigator.hardwareConcurrency,
        io: io ? JSON.parse(JSON.stringify(io, (k, v) => typeof v === "bigint" ? Number(v) : v)) : null, resources: res.length, pendingRes: slow,
        tabs: (() => { try { return localStorage.getItem("cp2077_link_key") ? "key" : "pub"; } catch { return "?"; } })(), ring: RING.slice(-40), progress: PRING.slice(-40), scopeTimeouts: S.scopeTimeouts || 0, gpuPending: (() => { try { return gpuPending(); } catch { return null; } })(), jobsAgoS: S.jobsMovedAt ? Math.round((performance.now() - S.jobsMovedAt) / 1000) : null, jobs: (() => { try { return (m?.cp2077NativeJobSnapshot?.() || []).map(r => r.worker + ":" + String(r.label).slice(0, 40) + ":" + Math.round(r.ageMs / 1000)); } catch { return null; } })()}).slice(0, 60000);
      // fetch keepalive, not sendBeacon (Brave Shields drop cross-site beacons)
      fetch("https://cp2077-port.fn-web-worker.workers.dev/__probe?id=" + (kind ? RID : "stall" + Math.random().toString(36).slice(2, 9)),
        {method: "POST", mode: "no-cors", keepalive: body.length < 60000, headers: {"Content-Type": "text/plain"}, body}).catch(() => {});
    } catch {}
  }
  function finish() {
    S.ready = true;
    mark('ready');
    // [warmflood] remember how much game data this browser now keeps; engine-select.js picks floodKeep=1 (faster world
    // loads from local data) on the next visit when it is large, floodKeep=2 (needed while downloading) otherwise.
    try { navigator.storage?.estimate?.().then(e => { try { localStorage.setItem("cp2077.cacheMB", String(Math.round((e.usage || 0) / 1048576))); } catch {} }, () => {}); } catch {}
    try { S.closeIo?.(); } catch {}
    $('cp-fill').style.width = '100%'; $('cp-pct').textContent = '100';
    $('cp-stage').textContent = 'Ready · Wake up, Samurai';
    root.classList.add('ready');
    clearInterval(timer);
    setTimeout(() => {
      root.classList.add('out');
      setTimeout(() => {
        root.remove();
        document.documentElement.classList.remove('cp-loading');
        const c = document.getElementById('cp2077-canvas');
        if (c) c.focus();
      }, 650);
    }, 400);
  }
  function fail(text) {
    if (S.failed || S.ready || globalThis.CP_UNSUPPORTED) return;   // capcheck.js panel owns the screen
    // [player-fix] the engine .wasm download dropped (slow / flaky connection): reload once before showing an error
    if (/fetching of the wasm failed|Failed to fetch|NetworkError/i.test(String(text))) {
      let tried = 0; try { tried = +(sessionStorage.getItem("cp2077_wasm_retry") || 0); } catch {}
      if (tried < 1) {
        try { sessionStorage.setItem("cp2077_wasm_retry", "1"); } catch {}
        S.failed = true; $('cp-stage').textContent = "Connection dropped · retrying";
        setTimeout(() => stallReport(-3, String(text).slice(0, 300), "fail"), 0);
        setTimeout(() => location.reload(), 1500);
        return;
      }
    }
    S.failed = true;
    clearInterval(timer);
    root.classList.add('failed');
    $('cp-err-msg').textContent = String(text).slice(0, 600);
    $('cp-err').hidden = false;
    $('cp-stage').textContent = 'Link failed';
    setTimeout(() => stallReport(-2, String(text).slice(0, 300), "fail"), 0);   // [fail-report] every visible failure reaches the Worker
  }
  globalThis.cp2077LoaderFail = fail;
  // [report] ?report=1: live load report every 10 s to the Worker (one object per page load, overwritten), until 2 min after READY
  const RID = "rep" + Math.random().toString(36).slice(2, 9);
  if (/[?&]report=1(&|$)/.test(location.search)) {
    let readyAt = 0;
    const rep = setInterval(() => { if (S.ready && !readyAt) readyAt = performance.now(); stallReport(-1, S.stallSig, "report");
      if (readyAt && performance.now() - readyAt > 120000) clearInterval(rep); }, 10000);
  }
  // [alive] 2026-10-24 (user: "gets to 100% and refreshes, on phone"): 64-bit sessions sent nothing after READY, so a tab
  // the phone killed later was invisible. Android: after READY, one small object per page load (id RID, overwritten)
  // every 30 s for 10 min; "leave" on pagehide. Last kind "alive" without "leave" = the tab died.
  if (/Android/.test(navigator.userAgent) && !/[?&]report=1(&|$)/.test(location.search)) {
    let readyAt = 0, beats = 0;
    const beat = kind => { try {
      const m = mod(), p = m?.cp2077PresentationStats || {};
      const body = JSON.stringify({v: 1, kind, ua: navigator.userAgent, t: Date.now(), engine: String(globalThis.CP_ENGINE || "").slice(0, 12),
        mem: navigator.deviceMemory, upSec: Math.round(performance.now() / 1000), sinceReady: readyAt ? Math.round((performance.now() - readyAt) / 1000) : null,
        frames: p.validatedFrames || 0, lastIntervalMs: p.lastIntervalMs || null, gpuPending: gpuPending(), ring: RING.slice(-12), q: location.search.replace(/key=[^&]*/, "")});
      fetch("https://cp2077-port.fn-web-worker.workers.dev/__probe?id=" + RID, {method: "POST", mode: "no-cors", keepalive: true, headers: {"Content-Type": "text/plain"}, body}).catch(() => {});
    } catch {} };
    const hb = setInterval(() => { if (!S.ready) return; if (!readyAt) readyAt = performance.now(); beat("alive"); if (++beats >= 20) clearInterval(hb); }, 30000);
    addEventListener("pagehide", () => { if (readyAt) beat("leave"); });
  }
  // [gputhrow] a WebGPU call that THROWS inside the engine's main-thread proxy leaves the worker waiting forever (the
  // 2026-10-24 BC hang) and shows as zero pending GPU promises. Log every such throw (with "failed" for the ring).
  try {
    const wrapThrow = (proto, names) => { if (!proto) return; for (const n of names) { const f = proto[n]; if (typeof f !== 'function') continue;
      proto[n] = function () { try { return f.apply(this, arguments); } catch (e) { ringAdd('CP2077 WebGPU ' + n + ' threw (failed): ' + (e && e.message || e)); throw e; } }; } };
    wrapThrow(globalThis.GPUDevice?.prototype, ['createTexture', 'createBuffer', 'createSampler', 'createBindGroupLayout', 'createBindGroup', 'createPipelineLayout',
      'createRenderPipeline', 'createComputePipeline', 'createShaderModule', 'createQuerySet']);
    wrapThrow(globalThis.GPUTexture?.prototype, ['createView']);
    wrapThrow(globalThis.GPUQueue?.prototype, ['writeTexture', 'writeBuffer', 'submit']);
    wrapThrow(globalThis.GPUCommandEncoder?.prototype, ['copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'copyBufferToBuffer', 'beginRenderPass', 'beginComputePass']);
  } catch {}
  if (globalThis.cp2077LoaderPreError) fail(globalThis.cp2077LoaderPreError);
  if (!navigator.gpu) fail('WebGPU required: use Chrome, Edge or Brave on desktop.');
  else navigator.gpu.requestAdapter().then(a => { try { const i = a && a.info; if (i) S.gpuInfo = {vendor: i.vendor, arch: i.architecture, desc: i.description, fallback: a.isFallbackAdapter ?? i.isFallbackAdapter}; } catch {} if (!a) fail('WebGPU required: no compatible GPU adapter. Use Chrome, Edge or Brave on desktop with hardware acceleration on.'); }, () => {});
  if (!globalThis.crossOriginIsolated) fail('This page must be cross-origin isolated (reload it from the original link).');
  timer = setInterval(update, 200);
  update();
  globalThis.cp2077Loader = {state: S, frac, ring: RING, get shown() { return shown; },
    // ms since navigation start + engine resource timings (transfer size 0 = served from HTTP cache)
    timeline() {
      const res = performance.getEntriesByType('resource').filter(e => /cp2077\.(wasm|data|js)|game-files\.json|\/warm\//.test(e.name))
        .map(e => ({name: e.name.replace(/^.*?\/runtime\//, 'runtime/').replace(/engine-versions\/([0-9a-f]{8})[0-9a-f]+/, 'ev/$1').slice(0, 80),
          start: Math.round(e.startTime), end: Math.round(e.responseEnd), transferKB: Math.round((e.transferSize || 0) / 1024),
          encodedKB: Math.round((e.encodedBodySize || 0) / 1024)}));
      return {marks: S.marks, binkFrames: S.binkFrames, frames: mod()?.cp2077PresentationStats?.validatedFrames || 0, resources: res};
    }};
})();
