(function () {
  "use strict";

  var frame = document.getElementById("frame");
  var canvas = document.getElementById("gl");
  var spotsEl = document.getElementById("spots");
  var capN = document.getElementById("cap-n");
  var capName = document.getElementById("cap-name");
  var needle = document.getElementById("needle");
  var status = document.getElementById("status");
  var backBtn = document.getElementById("back");
  var homeBtn = document.getElementById("home");
  var missing = document.getElementById("missing");
  var missingFile = document.getElementById("missing-file");

  var gl = canvas.getContext("webgl", { alpha: false }) || canvas.getContext("experimental-webgl");
  if (!gl) {
    frame.innerHTML = '<p style="color:#EDF1F4;padding:24px">This viewer needs WebGL, which is disabled in this browser.</p>';
    return;
  }

  // Shortcut legend under the viewer (hidden on touch screens by the CSS)
  var legend = document.createElement("p");
  legend.className = "legend";
  legend.innerHTML = "<span><kbd>F</kbd> Full screen</span><span><kbd>H</kbd> Main view</span>";
  frame.parentNode.insertBefore(legend, frame.nextSibling);

  var FOV_ROOM = 96, FOV_CLOSE = 34;
  // Mouse direction: 1 = drag right turns right. Put -1 back for the
  // "grab the photo and pull it" feel.
  var DRAG_X = 1;
  window.SETTINGS = window.SETTINGS || {};
  if (SETTINGS.title) { document.title = SETTINGS.title; document.querySelector("h1").textContent = SETTINGS.title; }
  if (SETTINGS.intro) document.querySelector("header p").textContent = SETTINGS.intro;

  var editable = SETTINGS.editing === true ||
                 (SETTINGS.editing === "hash" && location.hash === "#edit");
  if (!editable) document.querySelector(".tools").style.display = "none";

  var view = { yaw: 0, pitch: -16, fov: FOV_ROOM };
  var target = null;
  var scene = 0, stack = [], closed = false;
  var localFiles = {};   // file name -> object URL, from the file picker

  /* ---------------- WebGL ---------------- */
  var VS = "attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p,0.0,1.0); }";
  var FS = [
    "precision highp float;",
    "varying vec2 v;",
    "uniform sampler2D tex;",
    "uniform float yaw, pitch, tanX, tanY;",
    "const float PI = 3.14159265359;",
    "void main(){",
    "  vec3 d = normalize(vec3(v.x*tanX, v.y*tanY, -1.0));",
    "  float cp = cos(pitch), sp = sin(pitch);",
    "  d = vec3(d.x, d.y*cp - d.z*sp, d.y*sp + d.z*cp);",
    "  float cy = cos(yaw), sy = sin(yaw);",
    "  d = vec3(d.x*cy + d.z*sy, d.y, -d.x*sy + d.z*cy);",
    "  float u = atan(d.x, -d.z)/(2.0*PI) + 0.5;",
    "  float w = acos(clamp(d.y,-1.0,1.0))/PI;",
    "  gl_FragColor = texture2D(tex, vec2(u,w));",
    "}"
  ].join("\n");

  var U = {};
  (function initGL() {
    function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    var ap = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
    ["yaw","pitch","tanX","tanY","tex"].forEach(function (k) { U[k] = gl.getUniformLocation(prog, k); });
    gl.uniform1i(U.tex, 0);
  })();

  /* Each photo becomes a GPU texture once. The resizing is handed to the
     browser (createImageBitmap) so it happens off the main thread and the
     view never stutters while the other panoramas are being prepared. */
  // "all": everything is decoded and sent to the graphics card before the
  // tour opens, behind a progress bar — afterwards nothing happens in the
  // background ever again. false: each panorama is prepared when opened.
  var PRELOAD_ALL = SETTINGS.preload !== false;
  var MAX_TEXTURES = 4;      // panoramas kept ready when preload is off
  var lru = [];
  var currentTex = null;

  function potCanvas(img, w) {
    var c = document.createElement("canvas");
    c.width = w; c.height = w / 2;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function evict(keepFile) {
    while (lru.length > MAX_TEXTURES) {
      var drop = null;
      for (var i = 0; i < lru.length; i++) {
        var f = lru[i];
        if (f === keepFile) continue;
        if (SCENES[0] && f === SCENES[0].file) continue;          // main view stays ready
        if (SCENES[scene] && f === SCENES[scene].file) continue;
        drop = i; break;
      }
      if (drop === null) break;
      var gone = lru.splice(drop, 1)[0];
      if (imgCache[gone] && imgCache[gone].tex) {
        gl.deleteTexture(imgCache[gone].tex);
        imgCache[gone].tex = null;
      }
    }
  }

  function newTexture(w, h) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
    return t;
  }

  function stripSource(img, w, h, sy, sh, dy, dh, cb) {
    if (window.createImageBitmap) {
      window.createImageBitmap(img, 0, sy, img.width, sh,
        { resizeWidth: w, resizeHeight: dh, resizeQuality: "medium" })
        .then(function (bm) { cb(bm); })
        .catch(function () { cb(null); });
      return;
    }
    cb(null);
  }

  /* progressive = spread over animation frames, for panoramas prepared in the
     background; otherwise done in one go, hidden behind the fade. */
  function buildTexture(file, cb, progressive) {
    var rec = imgCache[file];
    if (!rec || !rec.ok) { cb(false); return; }
    if (rec.tex) { cb(true); return; }
    if (rec.building) { rec.building.push(cb); return; }
    rec.building = [cb];

    var img = rec.img;
    var max = gl.getParameter(gl.MAX_TEXTURE_SIZE), w = 2048;
    while (w * 2 <= img.width && w * 2 <= max) w *= 2;
    var h = w / 2;

    var done = function (ok, t) {
      if (ok) { rec.tex = t; lru.push(file); evict(file); }
      else if (t) gl.deleteTexture(t);
      if (currentTex) gl.bindTexture(gl.TEXTURE_2D, currentTex);
      var waiting = rec.building; rec.building = null;
      waiting.forEach(function (f) { f(ok); });
    };

    if (!progressive) {
      var t = newTexture(w, h);
      var put = function (source) {
        try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, source); done(true, t); }
        catch (err) { done(false, t); }
      };
      if (window.createImageBitmap) {
        window.createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" })
          .then(function (bm) { gl.bindTexture(gl.TEXTURE_2D, t); put(bm); if (bm.close) bm.close(); })
          .catch(function () { gl.bindTexture(gl.TEXTURE_2D, t); put(potCanvas(img, w)); });
      } else {
        put(potCanvas(img, w));
      }
      return;
    }

    // one horizontal strip per frame: no single long freeze
    var STRIPS = 8;
    var tex = newTexture(w, h);
    var k = 0, failed = false;
    (function nextStrip() {
      if (failed) { done(false, tex); return; }
      if (k >= STRIPS) { done(true, tex); return; }
      if (drag || swapping) { setTimeout(nextStrip, 220); return; }   // hands off while the viewer moves
      var sy = Math.round(img.height * k / STRIPS);
      var sh = Math.round(img.height * (k + 1) / STRIPS) - sy;
      var dy = Math.round(h * k / STRIPS);
      var dh = Math.round(h * (k + 1) / STRIPS) - dy;
      stripSource(img, w, h, sy, sh, dy, dh, function (source) {
        if (!source) {                       // no createImageBitmap: one shot on a canvas
          var c = document.createElement("canvas");
          c.width = w; c.height = dh;
          try { c.getContext("2d").drawImage(img, 0, sy, img.width, sh, 0, 0, w, dh); }
          catch (e) { failed = true; }
          source = c;
        }
        try {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, dy, gl.RGB, gl.UNSIGNED_BYTE, source);
          if (source.close) source.close();
        } catch (err) { failed = true; }
        if (currentTex) gl.bindTexture(gl.TEXTURE_2D, currentTex);
        k++;
        window.requestAnimationFrame(function () { window.requestAnimationFrame(nextStrip); });
      });
    })();
  }

  function show(file, img) {
    var rec = imgCache[file];
    if (!rec || !rec.tex) { showMissing(true, file); return; }
    currentTex = rec.tex;
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    // keep it at the front of the queue
    var at = lru.indexOf(file);
    if (at >= 0) { lru.splice(at, 1); lru.push(file); }
    status.textContent = SCENES.length + " panorama" + (SCENES.length > 1 ? "s" : "") +
                         " · current: " + img.naturalWidth + " × " + img.naturalHeight + " px";
  }

  function showMissing(on, file) {
    missing.classList.toggle("on", on);
    if (on) missingFile.textContent = file ? ("“" + file + "” could not be loaded") : "This photo could not be loaded here";
  }

  /* Photos are decoded before anything is shown, so a panorama never
     appears at the wrong orientation. The veil covers the swap. */
  var imgCache = {};

  function getImage(file, cb) {
    var hit = imgCache[file];
    if (hit && hit.done) { cb(hit.ok ? hit.img : null); return; }
    if (hit) { hit.waiting.push(cb); return; }
    var rec = { done: false, ok: false, img: new Image(), waiting: [cb] };
    imgCache[file] = rec;
    rec.img.crossOrigin = "anonymous";
    rec.img.onload = function () {
      rec.done = true; rec.ok = true;
      rec.waiting.splice(0).forEach(function (f) { f(rec.img); });
    };
    rec.img.onerror = function () {
      rec.done = true; rec.ok = false;
      delete imgCache[file];              // let a later pick retry
      rec.waiting.splice(0).forEach(function (f) { f(null); });
    };
    // photosBase (in SETTINGS) can point to another server, e.g. an S3 bucket
    var base = SETTINGS.photosBase || "photos/";
    if (base.slice(-1) !== "/") base += "/";
    rec.img.src = localFiles[file] || (base + encodeURIComponent(file));
  }

  var loader = document.getElementById("loader");
  var loaderBar = document.getElementById("loader-bar");
  var loaderCount = document.getElementById("loader-count");
  var loaderTitle = document.getElementById("loader-title");

  function loaderShow(done, total) {
    loader.classList.add("on");
    loaderBar.style.width = (total ? Math.round(done / total * 100) : 0) + "%";
    loaderCount.textContent = "panorama " + Math.min(done + 1, total) + " of " + total;
  }
  function loaderHide() { loader.classList.remove("on"); }

  /* Everything is fetched and prepared once, before the tour opens.
     After this, switching panorama is instant and nothing runs in the
     background. */
  function bootLoad(cb) {
    if (!PRELOAD_ALL) { cb(); return; }
    var files = [];
    SCENES.forEach(function (sc) { if (files.indexOf(sc.file) < 0) files.push(sc.file); });
    if (!files.length) { cb(); return; }
    MAX_TEXTURES = Math.max(MAX_TEXTURES, files.length);   // keep them all resident
    var i = 0, failed = 0;
    loaderShow(0, files.length);
    (function next() {
      if (i >= files.length) {
        loaderHide();
        cb(failed < files.length);
        return;
      }
      var file = files[i];
      getImage(file, function (img) {
        var step = function () { i++; loaderShow(i, files.length); setTimeout(next, 0); };
        if (!img) { failed++; step(); return; }
        buildTexture(file, step, true);
      });
    })();
  }

  function pumpPreload() {}      // nothing runs in the background any more

  var veil = document.getElementById("veil");
  var swapping = false;

  function loadScene(i, keepView) {
    var s = SCENES[i];
    var sameScene = (i === scene) && keepView;
    if (swapping) return;

    var apply = function (img) {
      scene = i;
      if (!keepView) {
        var st = s.start || {};
        view.yaw = st.yaw === undefined ? 0 : st.yaw;
        view.pitch = st.pitch === undefined ? -16 : st.pitch;
        view.fov = st.fov === undefined ? FOV_ROOM : st.fov;
        target = null;
      }
      capN.textContent = String(i + 1).padStart(2, "0");
      capName.textContent = s.name || s.id;
      // "Back" only when it leads somewhere other than the main view
      // (otherwise it duplicates the "Main view" button)
      backBtn.classList.toggle("on", stack.length > 0 && stack[stack.length - 1] !== 0);
      homeBtn.classList.toggle("on", i !== 0);
      buildSpots();
      if (img && imgCache[s.file] && imgCache[s.file].tex) { show(s.file, img); showMissing(false); }
      else showMissing(true, s.file);
      renderEditor();
      // one frame drawn at the new orientation before the veil lifts
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          veil.classList.add("clear");
          swapping = false;
        });
      });
    };

    if (sameScene) { apply(imgCache[s.file] && imgCache[s.file].img); return; }

    swapping = true;
    veil.classList.remove("clear");
    var rec = imgCache[s.file];
    var cached = rec && rec.done && rec.ok && rec.tex;
    var ready = null, veiled = false;
    getImage(s.file, function (img) {
      if (!img) { ready = { img: null }; go(); return; }
      buildTexture(s.file, function () { ready = { img: img }; go(); });
    });
    setTimeout(function () { veiled = true; go(); }, cached ? 40 : 150);
    function go() { if (ready && veiled) apply(ready.img); }
  }

  function goTo(id) {
    var i = SCENES.findIndex(function (s) { return s.id === id; });
    if (i < 0) return;
    stack.push(scene);
    loadScene(i);
  }

  backBtn.addEventListener("click", function () {
    if (!stack.length) return;
    loadScene(stack.pop());
  });

  function goHome() {
    if (scene === 0) return;
    stack = [];
    loadScene(0);
  }
  homeBtn.addEventListener("click", goHome);

  /* ---------------- markers ---------------- */
  var els = [];

  function buildSpots() {
    els.forEach(function (e) { e.remove(); });
    els = [];
    if (scene < 0 || !SCENES[scene]) return;
    (SCENES[scene].spots || []).forEach(function (sp, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "spot" + (sp.to ? " link" : "") + (sp.kind === "behind" ? " behind" : "");
      b.setAttribute("aria-label", (sp.label || ("Point " + (i + 1))) + (sp.kind === "behind" ? " (behind the specimen)" : ""));
      b.innerHTML = '<span class="pulse"></span><span class="ring"></span>' +
                    (sp.to ? '<span class="glyph">→</span>' : (sp.kind === "behind" ? '<span class="glyph">◇</span>' : "")) +
                    '<span class="tip">' + (sp.label || "") + "</span>";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (editing) { selectSpot(i); return; }
        if (sp.to) goTo(sp.to);
        else { target = { yaw: sp.yaw, pitch: sp.pitch, fov: FOV_CLOSE }; }
      });
      spotsEl.appendChild(b);
      els.push(b);
    });
  }

  function place() {
    if (scene < 0 || !SCENES[scene]) return;
    var w = frame.clientWidth, h = frame.clientHeight;
    var tanY = Math.tan(view.fov * Math.PI / 360), tanX = tanY * (w / h);
    var cy = Math.cos(-view.yaw * Math.PI / 180), sy = Math.sin(-view.yaw * Math.PI / 180);
    var cp = Math.cos(-view.pitch * Math.PI / 180), sp2 = Math.sin(-view.pitch * Math.PI / 180);
    (SCENES[scene].spots || []).forEach(function (sp, i) {
      var ry = sp.yaw * Math.PI / 180, rp = sp.pitch * Math.PI / 180;
      var x = Math.cos(rp) * Math.sin(ry), y = Math.sin(rp), z = -Math.cos(rp) * Math.cos(ry);
      var x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      var y2 = y * cp - z1 * sp2, z2 = y * sp2 + z1 * cp;
      var el = els[i];
      if (!el) return;
      if (z2 >= -0.02) { el.style.display = "none"; return; }
      var sx = (x1 / -z2) / tanX, sv = (y2 / -z2) / tanY;
      if (Math.abs(sx) > 1.3 || Math.abs(sv) > 1.3) { el.style.display = "none"; return; }
      el.style.display = "block";
      el.style.left = ((sx * .5 + .5) * w) + "px";
      el.style.top = ((.5 - sv * .5) * h) + "px";
    });
  }

  function dirAt(px, py) {
    var w = frame.clientWidth, h = frame.clientHeight;
    var tanY = Math.tan(view.fov * Math.PI / 360), tanX = tanY * (w / h);
    var d = [((px / w) * 2 - 1) * tanX, (1 - (py / h) * 2) * tanY, -1];
    var n = Math.hypot(d[0], d[1], d[2]); d = [d[0]/n, d[1]/n, d[2]/n];
    var cp = Math.cos(view.pitch * Math.PI / 180), sp = Math.sin(view.pitch * Math.PI / 180);
    d = [d[0], d[1]*cp - d[2]*sp, d[1]*sp + d[2]*cp];
    var cy = Math.cos(view.yaw * Math.PI / 180), sy = Math.sin(view.yaw * Math.PI / 180);
    d = [d[0]*cy + d[2]*sy, d[1], -d[0]*sy + d[2]*cy];
    return {
      yaw: Math.round(Math.atan2(d[0], -d[2]) * 1800 / Math.PI) / 10,
      pitch: Math.round(Math.asin(Math.max(-1, Math.min(1, d[1]))) * 1800 / Math.PI) / 10
    };
  }

  /* ---------------- interaction ---------------- */
  var drag = null, moved = false;
  frame.addEventListener("pointerdown", function (e) {
    if (e.target.closest(".spot") || e.target.closest("button") ||
        e.target.closest(".missing")) return;
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
    moved = false; target = null;
    frame.classList.add("dragging");
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var k = view.fov / frame.clientHeight;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; frame.classList.add("moved"); }
    view.yaw = drag.yaw + DRAG_X * dx * k;
    view.pitch = Math.max(-88, Math.min(88, drag.pitch + dy * k));
  });
  frame.addEventListener("pointerup", function (e) {
    if (drag && !moved && editing && selSpot !== null) {
      var r = frame.getBoundingClientRect();
      var d = dirAt(e.clientX - r.left, e.clientY - r.top);
      var sp = SCENES[scene].spots[selSpot];
      sp.yaw = d.yaw; sp.pitch = d.pitch;
      renderEditor();
    }
    drag = null; frame.classList.remove("dragging");
  });
  frame.addEventListener("pointercancel", function () { drag = null; frame.classList.remove("dragging"); });
  frame.addEventListener("wheel", function (e) {
    e.preventDefault(); target = null;
    view.fov = Math.max(18, Math.min(100, view.fov + e.deltaY * .05));
  }, { passive: false });

  var fsBtn = document.getElementById("fs");
  fsBtn.addEventListener("click", function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (frame.requestFullscreen) frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  });
  document.addEventListener("fullscreenchange", function () { setTimeout(resize, 60); });
  document.addEventListener("webkitfullscreenchange", function () { setTimeout(resize, 60); });
  document.addEventListener("keydown", function (e) {
    if (/input|textarea|select/i.test(e.target.tagName || "")) return;
    var k = e.key.toLowerCase();
    if (k === "f") fsBtn.click();
    else if (k === "h" || k === "backspace" || k === "home") { e.preventDefault(); goHome(); }
    else if (k === "escape" && stack.length) backBtn.click();
  });

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var r = frame.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);

  /* ---------------- loading photos from the computer ---------------- */
  ["dragenter", "dragover"].forEach(function (t) {
    frame.addEventListener(t, function (e) { e.preventDefault(); });
  });
  frame.addEventListener("drop", function (e) {
    e.preventDefault();
    var imgs = Array.prototype.filter.call(e.dataTransfer.files || [], function (f) {
      return /\.(jpe?g|png|webp)$/i.test(f.name);
    });
    if (imgs.length) addFiles(imgs);
  });

  function addFiles(list) {
    var e = { target: { files: list } };
    onFiles(e);
  }
  ["pickdir", "pickfiles"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", function (ev) {
      var imgs = Array.prototype.filter.call(ev.target.files, function (f) { return /\.(jpe?g|png|webp)$/i.test(f.name); });
      addFiles(imgs);
    });
  });

  document.getElementById("files").addEventListener("change", onFiles);

  function onFiles(e) {
    var added = 0;
    Array.prototype.forEach.call(e.target.files, function (f) {
      localFiles[f.name] = URL.createObjectURL(f);
      var known = SCENES.some(function (s) { return s.file === f.name; });
      if (!known && editable) {
        SCENES.push({
          id: f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase(),
          name: f.name.replace(/\.[^.]+$/, ""),
          file: f.name,
          spots: []
        });
        added++;
      }
    });
    imgCache = {};
    lru = [];
    currentTex = null;
    var cur = scene < 0 ? 0 : scene;
    scene = -1;
    bootLoad(function () { loadScene(cur); renderEditor(); });
    if (added) status.textContent = added + " panorama" + (added > 1 ? "s" : "") + " added — place your points, then copy the block";
  }

  /* ---------------- editor ---------------- */
  var editing = false, selSpot = null;
  var editor = document.getElementById("editor");
  var spotlist = document.getElementById("spotlist");
  var scenelist = document.getElementById("scenelist");
  var code = document.getElementById("code");

  document.getElementById("toggle-edit").addEventListener("click", function () {
    editing = !editing;
    editor.classList.toggle("on", editing);
    frame.classList.toggle("editing", editing);
    this.textContent = editing ? "Done editing" : "Edit tour";
    selectSpot(null);
  });

  function selectSpot(i) {
    selSpot = i;
    els.forEach(function (e, k) { e.classList.toggle("sel", k === i); });
    renderEditor();
  }

  function renderEditor() {
    if (!editing) { code.value = ""; return; }
    document.getElementById("ed-scene").textContent = SCENES[scene].name || SCENES[scene].id;

    spotlist.innerHTML = "";
    (SCENES[scene].spots || []).forEach(function (sp, i) {
      var c = document.createElement("div");
      c.className = "card" + (i === selSpot ? " sel" : "");
      var idx = document.createElement("span"); idx.className = "i"; idx.textContent = String(i + 1).padStart(2, "0");
      var name = document.createElement("input");
      name.value = sp.label || "";
      name.placeholder = "label";
      name.addEventListener("input", function () { sp.label = name.value; buildTips(); dump(); });
      var sel = document.createElement("select");
      var none = document.createElement("option"); none.value = ""; none.textContent = "zoom in";
      sel.appendChild(none);
      SCENES.forEach(function (s2) {
        var o = document.createElement("option");
        o.value = s2.id; o.textContent = "→ " + (s2.name || s2.id);
        sel.appendChild(o);
      });
      sel.value = sp.to || "";
      sel.addEventListener("change", function () {
        if (sel.value) sp.to = sel.value; else delete sp.to;
        buildSpots(); dump();
      });
      var kind = document.createElement("select");
      [["", "visible"], ["behind", "behind the specimen"]].forEach(function (k) {
        var o = document.createElement("option"); o.value = k[0]; o.textContent = k[1]; kind.appendChild(o);
      });
      kind.value = sp.kind || "";
      kind.style.flex = "0 1 34%";
      kind.addEventListener("change", function () {
        if (kind.value) sp.kind = kind.value; else delete sp.kind;
        buildSpots(); dump();
      });
      var pos = document.createElement("span");
      pos.className = "pos"; pos.textContent = sp.yaw + "° / " + sp.pitch + "°";
      c.appendChild(idx); c.appendChild(name); c.appendChild(sel); c.appendChild(kind); c.appendChild(pos);
      c.addEventListener("click", function (e) { if (e.target === c || e.target === idx || e.target === pos) selectSpot(i); });
      spotlist.appendChild(c);
    });

    scenelist.innerHTML = "";
    SCENES.forEach(function (s, i) {
      var c = document.createElement("div");
      c.className = "card" + (i === scene ? " sel" : "");
      var idx = document.createElement("span"); idx.className = "i"; idx.textContent = String(i + 1).padStart(2, "0");
      var name = document.createElement("input");
      name.value = s.name || s.id;
      name.addEventListener("input", function () { s.name = name.value; dump(); });
      var file = document.createElement("span");
      file.className = "pos"; file.textContent = s.file;
      var open = document.createElement("button");
      open.type = "button"; open.textContent = "open";
      open.style.cssText = "font:500 12px/1 inherit;padding:5px 8px;border:1px solid var(--line);border-radius:3px;background:none;color:inherit;cursor:pointer";
      open.addEventListener("click", function () { stack = []; loadScene(i); });
      c.appendChild(idx); c.appendChild(name); c.appendChild(file); c.appendChild(open);
      scenelist.appendChild(c);
    });

    dump();
  }

  function buildTips() {
    (SCENES[scene].spots || []).forEach(function (sp, i) {
      var tip = els[i] && els[i].querySelector(".tip");
      if (tip) tip.textContent = sp.label || "";
    });
  }

  function dump() {
    var head = "var SETTINGS = {\n" +
      '  title: "' + String(SETTINGS.title || "Lab 360 Tour").replace(/"/g, '\\"') + '",\n' +
      '  intro: "' + String(SETTINGS.intro || "").replace(/"/g, '\\"') + '",\n' +
      "  editing: " + (typeof SETTINGS.editing === "string" ? '"' + SETTINGS.editing + '"' : SETTINGS.editing === false ? "false" : "true") + ",\n" +
      (SETTINGS.photosBase ? '  photosBase: "' + SETTINGS.photosBase + '",
' : "") +
      "  preload: " + (SETTINGS.preload === false ? "false" : "true") +
      "\n};\n\n";
    var out = head + "var SCENES = [\n" + SCENES.map(function (s) {
      var spots = (s.spots || []).map(function (sp) {
        return "      { yaw: " + sp.yaw + ", pitch: " + sp.pitch +
               ', label: "' + String(sp.label || "").replace(/"/g, '\\"') + '"' +
               (sp.to ? ', to: "' + sp.to + '"' : "") +
               (sp.kind ? ', kind: "' + sp.kind + '"' : "") + " }";
      }).join(",\n");
      var st = s.start ? "    start: { yaw: " + s.start.yaw + ", pitch: " + s.start.pitch + ", fov: " + s.start.fov + " },\n" : "";
      return '  {\n    id: "' + s.id + '",\n    name: "' + String(s.name || s.id).replace(/"/g, '\\"') +
             '",\n    file: "' + s.file + '",\n' + st + '    spots: [\n' + spots + "\n    ]\n  }";
    }).join(",\n") + "\n];";
    code.value = out;
  }

  document.getElementById("add-spot").addEventListener("click", function () {
    SCENES[scene].spots = SCENES[scene].spots || [];
    SCENES[scene].spots.push({
      yaw: Math.round(view.yaw * 10) / 10,
      pitch: Math.round(view.pitch * 10) / 10,
      label: "New point"
    });
    buildSpots();
    selectSpot(SCENES[scene].spots.length - 1);
  });
  document.getElementById("del-spot").addEventListener("click", function () {
    if (selSpot === null) return;
    SCENES[scene].spots.splice(selSpot, 1);
    buildSpots();
    selectSpot(null);
  });
  document.getElementById("set-start").addEventListener("click", function () {
    SCENES[scene].start = {
      yaw: Math.round(view.yaw * 10) / 10,
      pitch: Math.round(view.pitch * 10) / 10,
      fov: Math.round(view.fov)
    };
    var b = this;
    b.textContent = "Opening view saved";
    setTimeout(function () { b.textContent = "Open this panorama on the current view"; }, 1600);
    dump();
  });

  document.getElementById("copy").addEventListener("click", function () {
    code.select();
    var b = this;
    try { document.execCommand("copy"); b.textContent = "Copied"; }
    catch (e) { b.textContent = "Select the text and copy it"; }
    setTimeout(function () { b.textContent = "Copy the block"; }, 1600);
  });
  document.getElementById("download").addEventListener("click", function () {
    var blob = new Blob([code.value], { type: "text/plain" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tour-config.txt";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  });

  /* ---------------- loop ---------------- */
  function step() {
    if (target) {
      var k = .12, done = true;
      var dy = ((target.yaw - view.yaw + 540) % 360) - 180;
      if (Math.abs(dy) > .05) { view.yaw += dy * k; done = false; }
      if (Math.abs(target.pitch - view.pitch) > .05) { view.pitch += (target.pitch - view.pitch) * k; done = false; }
      if (Math.abs(target.fov - view.fov) > .05) { view.fov += (target.fov - view.fov) * k; done = false; }
      if (done) target = null;
    }
    if (currentTex) gl.bindTexture(gl.TEXTURE_2D, currentTex);
    var tanY = Math.tan(view.fov * Math.PI / 360);
    gl.uniform1f(U.yaw, view.yaw * Math.PI / 180);
    gl.uniform1f(U.pitch, view.pitch * Math.PI / 180);
    gl.uniform1f(U.tanY, tanY);
    gl.uniform1f(U.tanX, tanY * (canvas.width / canvas.height));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    place();
    needle.style.transform = "rotate(" + (-view.yaw) + "deg)";
    window.requestAnimationFrame(step);
  }

  resize();
  scene = -1;
  step();
  bootLoad(function (ok) {
    loadScene(0);
    if (!ok) showMissing(true, SCENES[0] && SCENES[0].file);
  });
})();
