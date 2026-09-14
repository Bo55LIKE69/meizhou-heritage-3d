/* 梅州市非遗 · 三维地形原型
 * 沿用 cesium-3d-terrain 套路：自建 Primitive + 自定义 Appearance（GLSL 300 ES）
 * 关键点：appearance.uniforms 必须构造后手动赋值；必须带 batchId 属性。
 */
(function () {
  "use strict";

  var D = window.DEM_DATA;
  var COUNTIES = window.MZ_COUNTIES || [];
  var POINTS = window.MZ_POINTS || [];

  var errEl = document.getElementById("err");
  function fatal(msg) {
    errEl.style.display = "block";
    errEl.textContent = "出错了：\n" + msg;
    var l = document.getElementById("loading");
    if (l) l.style.display = "none";
  }

  if (!D) { fatal("未加载到 dem_terrain_data.js"); return; }

  // ---------------- 解码 ----------------
  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var W = D.width, H = D.height, N = W * H;
  var heights = new Uint16Array(b64ToBytes(D.heights).buffer);
  var maskBits = b64ToBytes(D.mask);
  var mask = new Uint8Array(N);
  for (var i = 0; i < N; i++) mask[i] = (maskBits[i >> 3] >> (i & 7)) & 1;

  // 高程采样
  function hAt(lon, lat) {
    var fi = (lon - D.west) / (D.east - D.west) * (W - 1);
    var fj = (D.north - lat) / (D.north - D.south) * (H - 1);
    var i0 = Math.min(W - 1, Math.max(0, Math.round(fi)));
    var j0 = Math.min(H - 1, Math.max(0, Math.round(fj)));
    var k = j0 * W + i0;
    if (!mask[k]) return null;
    return D.minH + heights[k] * D.scale;
  }
  // 与着色器一致的抬升后高度
  function surfaceH(lon, lat, exag) {
    var h = hAt(lon, lat);
    if (h === null) return 0;
    return h + (h - D.minH) * (exag - 1);
  }

  // ---------------- WGS84 → ECEF ----------------
  var A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F);
  function ecef(lon, lat, h, out) {
    var lam = lon * Math.PI / 180, phi = lat * Math.PI / 180;
    var sp = Math.sin(phi), cp = Math.cos(phi);
    var sl = Math.sin(lam), cl = Math.cos(lam);
    var nn = A / Math.sqrt(1 - E2 * sp * sp);
    out[0] = (nn + h) * cp * cl;
    out[1] = (nn + h) * cp * sl;
    out[2] = (nn * (1 - E2) + h) * sp;
    return out;
  }

  // ---------------- Viewer ----------------
  var viewer = new Cesium.Viewer("cesiumContainer", {
    baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false,
    animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false,
    globe: false, skyBox: false, skyAtmosphere: false,
    scene3DOnly: true,
    backgroundColor: Cesium.Color.fromCssColorString("#14100c"),
    creditContainer: document.getElementById("creditSink")
  });
  var scene = viewer.scene;
  // 注意：backgroundColor 不是 Viewer 的构造选项，必须在创建后显式赋给 scene，
  // 否则保持默认纯黑 (0,0,0)，页面看起来就像没渲染。
  scene.backgroundColor = Cesium.Color.fromCssColorString("#14100c");
  try { viewer.cesiumWidget.creditDisplay.container.style.display = "none"; } catch (e) {}
  scene.renderError.addEventListener(function (s, err) {
    var msg = (err && err.message) ? err.message : String(err);
    var stack = (err && err.stack) ? err.stack : "(no stack)";
    try { console.error("RENDER_ERROR: " + msg); console.error(stack); } catch (e) {}
    fatal("渲染错误: " + msg + "\n\n[STACK]\n" + stack);
  });

  var uniforms = {
    uHill: null,
    uMinH: D.minH, uMaxH: D.maxH,
    uExag: 2.5, uContour: 200.0,
    uHillOn: 1.0, uContourOn: 1.0,
    uFlipV: 0.0,
    uFogNear: 60000.0, uFogFar: 260000.0, uFogAmt: 0.55,
    uFogColor: new Cesium.Cartesian3(0.078, 0.063, 0.047)   // #14100c 暖矿石底色
  };

  // ---------------- 着色器 ----------------
  var VS = [
    "in vec3 position;",
    "in vec2 st;",
    "in float hgt;",
    "in float batchId;",
    "out vec2 vSt;",
    "out float vH;",
    "out vec3 vWC;",
    "uniform float uMinH;",
    "uniform float uExag;",
    "void main(){",
    "  vec3 pw = vec3(position);",
    "  vec3 up = normalize(pw);",
    "  vec3 p = pw + up * (hgt - uMinH) * (uExag - 1.0);",
    "  vSt = st;",
    "  vH = hgt;",
    "  vWC = (czm_model * vec4(p, 1.0)).xyz;",
    "  gl_Position = czm_modelViewProjection * vec4(p, 1.0);",
    "}"
  ].join("\n");

  var FS = [
    "in vec2 vSt;",
    "in float vH;",
    "in vec3 vWC;",
    "uniform sampler2D uHill;",
    "uniform float uMinH;",
    "uniform float uMaxH;",
    "uniform float uContour;",
    "uniform float uHillOn;",
    "uniform float uContourOn;",
    "uniform float uFlipV;",
    "uniform float uFogNear;",
    "uniform float uFogFar;",
    "uniform float uFogAmt;",
    "uniform vec3 uFogColor;",
    // 赣州稀土项目同款矿石暖色系：谷地苔绿 → 矿脉金 → 陶土红 → 山脊米白
    "vec3 ramp(float t){",
    "  vec3 c=vec3(0.290,0.388,0.286);",                     // #4a6349 谷地深绿
    "  c=mix(c,vec3(0.510,0.659,0.416),smoothstep(0.00,0.18,t));",   // #82a86a 苔绿
    "  c=mix(c,vec3(0.788,0.659,0.416),smoothstep(0.18,0.34,t));",   // #c9a86a 土黄
    "  c=mix(c,vec3(0.831,0.659,0.455),smoothstep(0.34,0.52,t));",   // #d4a874 矿脉金
    "  c=mix(c,vec3(0.753,0.380,0.227),smoothstep(0.52,0.70,t));",   // #c0613a 陶土
    "  c=mix(c,vec3(0.612,0.290,0.184),smoothstep(0.70,0.86,t));",   // #9c4a2f 赭红
    "  c=mix(c,vec3(0.925,0.882,0.820),smoothstep(0.86,1.00,t));",   // #ece1d1 山脊米白
    "  return c;",
    "}",
    "void main(){",
    "  float t = clamp((vH - uMinH) / max(uMaxH - uMinH, 1.0), 0.0, 1.0);",
    "  vec3 col = ramp(t);",
    "  vec2 uv = vec2(vSt.x, mix(vSt.y, 1.0 - vSt.y, uFlipV));",
    "  float hs = texture(uHill, uv).r;",
    "  col *= mix(1.0, mix(0.42, 1.38, hs), uHillOn);",
    "  float ci = vH / max(uContour, 1.0);",
    "  float ff = fract(ci);",
    "  float df = min(ff, 1.0 - ff);",
    "  float aa = max(fwidth(ci), 1e-5);",
    "  float line = 1.0 - smoothstep(0.0, aa * 1.6, df);",
    "  col = mix(col, col * 0.42, line * uContourOn);",
    "  float dist = distance(czm_viewerPositionWC, vWC);",
    "  float fog = clamp((dist - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0) * uFogAmt;",
    "  col = mix(col, uFogColor, fog);",
    "  out_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  // ---------------- 构建地形网格 ----------------
  function buildTerrain() {
    var positions = new Float32Array(N * 3);
    var sts = new Float32Array(N * 2);
    var hgts = new Float32Array(N);
    var batchIds = new Float32Array(N);
    var tmp = [0, 0, 0];

    for (var j = 0; j < H; j++) {
      var lat = D.north - (j / (H - 1)) * (D.north - D.south);
      for (var i = 0; i < W; i++) {
        var k = j * W + i;
        var lon = D.west + (i / (W - 1)) * (D.east - D.west);
        var h = D.minH + heights[k] * D.scale;
        hgts[k] = h;
        sts[k * 2] = i / (W - 1);
        sts[k * 2 + 1] = j / (H - 1);          // 0=北 1=南（配合 flipY=false）
        ecef(lon, lat, h, tmp);
        positions[k * 3] = tmp[0];
        positions[k * 3 + 1] = tmp[1];
        positions[k * 3 + 2] = tmp[2];
      }
    }

    // 只生成四角全部有效的格网
    var idx = [];
    for (var jj = 0; jj < H - 1; jj++) {
      for (var ii = 0; ii < W - 1; ii++) {
        var a = jj * W + ii, b = a + 1, c = a + W, d = c + 1;
        if (mask[a] && mask[b] && mask[c] && mask[d]) {
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    var indices = new Uint32Array(idx);

    var bs0 = Cesium.BoundingSphere.fromVertices(positions);
    var geo = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3, values: positions
        }),
        st: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2, values: sts
        }),
        hgt: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 1, values: hgts
        }),
        batchId: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 1, values: batchIds
        })
      },
      indices: indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: bs0,
      boundingSphereCV: Cesium.BoundingSphere.clone(bs0)
    });

    var appearance = new Cesium.Appearance({
      vertexShaderSource: VS,
      fragmentShaderSource: FS,
      translucent: false,
      renderState: {
        depthTest: { enabled: true },
        depthMask: true,
        cull: { enabled: false }
      }
    });
    appearance.uniforms = uniforms;   // 关键：Appearance 不保存构造参数里的 uniforms

    var prim = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry: geo }),
      appearance: appearance,
      asynchronous: false,
      allowPicking: false
    });
    scene.primitives.add(prim);
    return { prim: prim, indices: indices.length / 3 };
  }

  // ---------------- 叠加层 ----------------
  var lineCol = new Cesium.PolylineCollection();
  scene.primitives.add(lineCol);
  var aggCol = new Cesium.PointPrimitiveCollection();   // 区县气泡
  scene.primitives.add(aggCol);
  var labelCol = new Cesium.LabelCollection();          // 区县注记
  scene.primitives.add(labelCol);
  var ptCol = new Cesium.PointPrimitiveCollection();    // 逐点（后 add 在气泡之上）
  scene.primitives.add(ptCol);
  var infoByPrim = new Map();

  var LEVEL_COLOR = {
    "国家级": Cesium.Color.fromCssColorString("#dd7a4a"),   // 陶土亮
    "省级": Cesium.Color.fromCssColorString("#ecbe83"),     // 矿石金
    "市级": Cesium.Color.fromCssColorString("#8cc0db"),     // 钢蓝
    "县级": Cesium.Color.fromCssColorString("#82a86a")      // 苔绿
  };
  var LEVEL_ORDER = ["国家级", "省级", "市级", "县级"];
  var curLevel = null;   // null = 全部

  function buildBoundaries(exag) {
    lineCol.removeAll();
    if (!document.getElementById("cBound").checked) return;
    COUNTIES.forEach(function (c) {
      c.rings.forEach(function (ring) {
        var pos = [];
        ring.forEach(function (p) {
          var h = surfaceH(p[0], p[1], exag);
          pos.push(Cesium.Cartesian3.fromDegrees(p[0], p[1], h + 60));
        });
        if (pos.length < 2) return;
        lineCol.add({
          positions: pos, width: 2,
          material: Cesium.Material.fromType("Color", {
            color: Cesium.Color.fromCssColorString("#ffffff").withAlpha(0.55)
          })
        });
      });
    });
  }

  // ---------------- 区县聚合 ----------------
  // 坐标仅具区县级精度（427 条仅 96 个唯一坐标），逐点绘制会重叠失真，
  // 故按"地区"字段聚合为区县气泡：大小 ∝ 项目数，颜色随数量由青到红。
  function normCounty(a) { return a === "市辖区" ? "梅江区" : a; }
  var AGG = {};
  COUNTIES.forEach(function (c) {
    AGG[c.name] = { name: c.name, center: c.center || [0, 0], items: [] };
  });
  POINTS.forEach(function (p) {
    var k = normCounty(p.a);
    if (AGG[k]) AGG[k].items.push(p);
  });

  function buildAgg(exag) {
    aggCol.removeAll();
    labelCol.removeAll();
    infoByPrim.forEach(function (v, k) { if (v.type === "county") infoByPrim.delete(k); });
    if (!document.getElementById("cAgg").checked) return;
    var counts = Object.keys(AGG).map(function (k) { return AGG[k].items.length; });
    var mx = Math.max.apply(null, counts), mn = Math.min.apply(null, counts);
    var cLow = Cesium.Color.fromCssColorString("#6fa6c4");   // 钢蓝
    var cHigh = Cesium.Color.fromCssColorString("#dd7a4a");  // 陶土亮
    Object.keys(AGG).forEach(function (k) {
      var g = AGG[k];
      var shown = g.items.filter(function (p) { return !curLevel || p.l === curLevel; });
      if (curLevel && shown.length === 0) return;   // 该级别下此区县无项目则不画
      var t = mx > mn ? (g.items.length - mn) / (mx - mn) : 0.5;
      var col = Cesium.Color.lerp(cLow, cHigh, t, new Cesium.Color());
      var size = 22 + Math.sqrt(shown.length) * 5.5;   // 梅江96→76px, 蕉岭22→48px
      var h = surfaceH(g.center[0], g.center[1], exag);
      var prim = aggCol.add({
        position: Cesium.Cartesian3.fromDegrees(g.center[0], g.center[1], h + 200),
        color: col, pixelSize: size,
        outlineColor: Cesium.Color.fromCssColorString("#ffffff"),
        outlineWidth: 2.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      });
      infoByPrim.set(prim, { type: "county", g: g });
      // 区县注记：名称 + 项目数，悬在气泡正上方
      labelCol.add({
        position: Cesium.Cartesian3.fromDegrees(g.center[0], g.center[1], h + 200),
        text: g.name + "  " + shown.length,
        font: "bold 15px 'Microsoft YaHei', sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#ffffff"),
        outlineColor: Cesium.Color.fromCssColorString("#14100c"),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#14100c").withAlpha(0.55),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        pixelOffset: new Cesium.Cartesian2(0, -(size / 2 + 16)),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 1.0
      });
    });
  }

  // 逐点层：427 个非遗点按级别着色（坐标为区县级代理，仅示意）
  function buildPoints(exag) {
    ptCol.removeAll();
    infoByPrim.forEach(function (v, k) { if (v.type === "point") infoByPrim.delete(k); });
    if (!document.getElementById("cPts").checked) return;
    POINTS.forEach(function (p) {
      if (curLevel && p.l !== curLevel) return;
      var h = surfaceH(p.lon, p.lat, exag);
      var col = LEVEL_COLOR[p.l] || Cesium.Color.WHITE;
      var prim = ptCol.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, h + 320),
        color: col, pixelSize: p.l === "国家级" ? 12 : 8,
        outlineColor: Cesium.Color.fromCssColorString("#14100c"),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      });
      infoByPrim.set(prim, { type: "point", p: p });
    });
  }

  function rebuildOverlays() {
    var exag = uniforms.uExag;
    buildBoundaries(exag);
    buildAgg(exag);
    buildPoints(exag);
  }

  // ---------------- 交互 ----------------
  var infoEl = document.getElementById("info");
  var infoBody = document.getElementById("infoBody");
  document.getElementById("infoClose").onclick = function () { infoEl.style.display = "none"; };

  // PC / 移动端协同：窄屏时面板变为抽屉，默认收起给三维视图让位
  var IS_MOBILE = window.matchMedia("(max-width: 768px)").matches;
  var panelEl = document.getElementById("panel");
  var menuBtn = document.getElementById("menuBtn");
  function setPanel(open) {
    panelEl.classList.toggle("open", open);
    menuBtn.textContent = open ? "× 收起面板" : "☰ 控制面板";
  }
  menuBtn.onclick = function () { setPanel(!panelEl.classList.contains("open")); };
  document.getElementById("panelClose").onclick = function () { setPanel(false); };
  if (IS_MOBILE) setPanel(false);

  // 项目介绍：优先用收录的专项简介（带列入年份与来源），否则退回类别释义，不做臆造
  var INTRO = window.MZ_INTRO || {};
  var CATDESC = window.MZ_CAT_DESC || {};
  function introHtml(p) {
    var it = INTRO[p.n];
    if (it) {
      return '<div class="year">列入 ' + it.year + "</div>" +
             '<div class="intro">' + it.text + "</div>" +
             '<div class="src">资料来源：' + it.src + "</div>";
    }
    var cd = CATDESC[p.c];
    if (cd) {
      return '<div class="intro">' + cd + "</div>" +
             '<div class="src">类别释义 · 该项目专项简介待补录</div>';
    }
    return '<div class="intro">该项目专项介绍尚未收录，可查阅梅州市非物质文化遗产名录。</div>';
  }

  var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(function (click) {
    var picked = scene.pick(click.position);
    if (!Cesium.defined(picked)) { infoEl.style.display = "none"; return; }
    var prim = picked.primitive || picked;
    var hit = infoByPrim.get(prim);
    if (!hit) { infoEl.style.display = "none"; return; }

    if (hit.type === "point") {
      var p = hit.p;
      var lc = LEVEL_COLOR[p.l] ? LEVEL_COLOR[p.l].toCssHexString() : "#fff";
      infoBody.innerHTML =
        "<h3>" + p.n + "</h3>" +
        '<div class="kv"><span>级别</span><span style="color:' + lc + '">' + p.l + "</span></div>" +
        '<div class="kv"><span>类别</span><span>' + p.c + "</span></div>" +
        '<div class="kv"><span>区县</span><span>' + p.a + "</span></div>" +
        introHtml(p) +
        '<div class="kv" style="color:var(--faint)"><span>说明</span><span style="font-size:11px">坐标为区县级代理位置，仅示意所属区县</span></div>';
      infoEl.style.display = "block";
      return;
    }

    // 区县详情：级别构成（带色）、主要类别、代表项目
    var g = hit.g;
    var lvCount = {};
    LEVEL_ORDER.forEach(function (lv) { lvCount[lv] = 0; });
    var catCount = {};
    g.items.forEach(function (p) {
      lvCount[p.l] = (lvCount[p.l] || 0) + 1;
      catCount[p.c] = (catCount[p.c] || 0) + 1;
    });
    var lvHtml = LEVEL_ORDER.map(function (lv) {
      return '<span style="color:' + LEVEL_COLOR[lv].toCssHexString() + ';margin-right:8px">' +
             lv + " " + lvCount[lv] + "</span>";
    }).join("");
    var cats = Object.keys(catCount).sort(function (a, b) { return catCount[b] - catCount[a]; });
    var catHtml = cats.slice(0, 3).map(function (c) { return c + "(" + catCount[c] + ")"; }).join("、");
    var names = g.items.slice(0, 8).map(function (p) { return p.n; });
    if (g.items.length > 8) names.push("…等共 " + g.items.length + " 项");
    infoBody.innerHTML =
      "<h3>" + g.name + " · " + g.items.length + " 项</h3>" +
      '<div class="kv"><span>级别构成</span><span>' + lvHtml + "</span></div>" +
      '<div class="kv"><span>主要类别</span><span>' + catHtml + "</span></div>" +
      '<div class="kv"><span>代表项目</span><span style="line-height:1.6">' + names.join("、") + "</span></div>";
    infoEl.style.display = "block";
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function bind(id, fn) { document.getElementById(id).addEventListener("input", fn); }
  bind("exag", function (e) {
    uniforms.uExag = parseFloat(e.target.value);
    document.getElementById("vExag").textContent = uniforms.uExag.toFixed(1) + "×";
    rebuildOverlays();
  });
  bind("cont", function (e) {
    uniforms.uContour = parseFloat(e.target.value);
    document.getElementById("vCont").textContent = uniforms.uContour.toFixed(0) + " m";
  });
  document.getElementById("cHill").onchange = function (e) { uniforms.uHillOn = e.target.checked ? 1 : 0; };
  document.getElementById("cCont").onchange = function (e) { uniforms.uContourOn = e.target.checked ? 1 : 0; };
  document.getElementById("cBound").onchange = rebuildOverlays;
  document.getElementById("cPts").onchange = function () { buildPoints(uniforms.uExag); };
  document.getElementById("cAgg").onchange = function () { buildAgg(uniforms.uExag); };

  var lvlBtns = { bAll: null, b1: "国家级", b2: "省级", b3: "市级", b4: "县级" };
  Object.keys(lvlBtns).forEach(function (id) {
    document.getElementById(id).onclick = function () {
      curLevel = lvlBtns[id];
      Object.keys(lvlBtns).forEach(function (o) {
        document.getElementById(o).classList.toggle("on", o === id);
      });
      buildPoints(uniforms.uExag);
      buildAgg(uniforms.uExag);
    };
  });

  // 视角按钮
  function flyTo(lon, lat, range) {
    // 用 lookAt 明确"看向"目标点：
    // 不能用 setView + Cartesian3.fromDegrees(lon, lat, range)——第三个参数是海拔高度，
    // 会把相机放到正上方 range 米处，再叠加俯角后视线落点会飞到目标之外。
    var h = surfaceH(lon, lat, uniforms.uExag);
    var target = Cesium.Cartesian3.fromDegrees(lon, lat, h);
    viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0),
      Cesium.Math.toRadians(-45),
      range
    ));
    // lookAt 会把相机锁成"绕目标旋转"的轨道模式（无法自由平移）。
    // 定位完立刻重置变换矩阵解锁：保留当前视角，但恢复自由操作。
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  // 诊断接口：供无头测试脚本读取内部状态
  window.__DIAG = function () {
    return {
      pts: ptCol.length,
      bubbles: aggCol.length,
      labels: labelCol.length,
      bounds: lineCol.length,
      prims: scene.primitives.length,
      level: curLevel,
      infoShown: document.getElementById("info").style.display === "block",
      infoName: (document.getElementById("infoBody").textContent || "").slice(0, 40),
      exag: uniforms.uExag,
      contour: uniforms.uContour,
      loading: document.getElementById("loading").style.display,
      camLon: viewer.camera.positionCartographic.longitude,
      camLat: viewer.camera.positionCartographic.latitude,
      camH: viewer.camera.positionCartographic.height
    };
  };

  // 供测试：把经纬度换算成屏幕像素坐标（含抬升后的贴地点高度）
  // 注：Cesium 1.115 里 SceneTransforms.worldToWindowCoordinates 不可用，
  // 这里直接用 projectionMatrix * viewMatrix 手算 MVP 变换。
  window.__winOf = function (lon, lat) {
    var c = Cesium.Cartesian3.fromDegrees(
      lon, lat, surfaceH(lon, lat, uniforms.uExag) + 120);
    // 注意：Camera 上没有 projectionMatrix，投影矩阵在 frustum 上
    var fr = scene.camera.frustum;
    var proj = fr.projectionMatrix || fr.infiniteProjectionMatrix;
    if (!proj || !scene.camera.viewMatrix) return null;
    var mvp = Cesium.Matrix4.multiply(
      proj, scene.camera.viewMatrix, new Cesium.Matrix4());
    var p = Cesium.Matrix4.multiplyByVector(
      mvp, Cesium.Cartesian4.fromElements(c.x, c.y, c.z, 1), new Cesium.Cartesian4());
    if (!p || p.w <= 0) return null;          // 在相机背后
    return {
      x: (p.x / p.w + 1) / 2 * scene.canvas.clientWidth,
      y: (1 - p.y / p.w) / 2 * scene.canvas.clientHeight
    };
  };
  var flyBox = document.getElementById("flyBtns");
  function addFlyBtn(label, lon, lat, range) {
    var b = document.createElement("button");
    b.textContent = label;
    b.onclick = function () {
      flyTo(lon, lat, range);
      if (IS_MOBILE) setPanel(false);   // 手机端定位后收起面板，全屏看地形
    };
    flyBox.appendChild(b);
  }
  var v = D.view;
  addFlyBtn("全市", (v.west + v.east) / 2, (v.south + v.north) / 2, 175000);
  COUNTIES.forEach(function (c) {
    var sx = 0, sy = 0, n = 0;
    c.rings[0].forEach(function (p) { sx += p[0]; sy += p[1]; n++; });
    addFlyBtn(c.name.replace(/[市区县]$/, ""), sx / n, sy / n, 62000);
  });

  // ---------------- 启动 ----------------
  document.getElementById("rMin").textContent = D.minH.toFixed(0) + " m";
  document.getElementById("rMax").textContent = D.maxH.toFixed(0) + " m";

  // 绕过 Cesium.loadImage 的 worker/dataURI 路径，用原生 Image 主线程加载更稳
  var hillImg = new Image();
  hillImg.onload = function () {
    try {
      uniforms.uHill = new Cesium.Texture({
        context: scene.context,
        source: hillImg,
        flipY: false
      });
    } catch (e) {
      fatal("晕渲纹理创建失败: " + (e && e.message ? e.message : e));
      return;
    }
    var t = buildTerrain();
    rebuildOverlays();
    var cx = (v.west + v.east) / 2, cy = (v.south + v.north) / 2;
    flyTo(cx, cy, 175000);
    document.getElementById("loading").style.display = "none";
    console.log("[OK] 三角面数:", t.indices, "| 区县气泡:", Object.keys(AGG).length,
                "| 非遗项目:", POINTS.length,
                "| 高程:", D.minH.toFixed(1), "~", D.maxH.toFixed(1));
  };
  hillImg.onerror = function () {
    fatal("晕渲纹理加载失败");
  };
  hillImg.src = D.hillshade;
})();
