/* UtecVis v3: módulo de red en D3 v7 (patrón de "chart" reutilizable, como en Observable).
 *   const vis = UtecVis.create(elemento, {nodes, edges, affinity, meta}, opciones)
 * Una sola vista con dos disposiciones animadas:
 *   "clusters": fuerzas agrupadas por departamento (territorios, enclosure)
 *   "swarm":    beeswarm por departamento, x = publicaciones (sustrato semántico)
 */
(function (global) {
  "use strict";

  const fmt = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 3 });
  const fmt2 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
  const fmtInt = new Intl.NumberFormat("es-PE");
  const pct = new Intl.NumberFormat("es-PE", { style: "percent", maximumFractionDigits: 0 });

  const METRICS = {
    publications: { label: "Publicaciones", f: fmtInt },
    coauthors: { label: "Coautores", f: fmtInt },
    coauthorships: { label: "Coautorías", f: fmtInt },
    betweenness: { label: "Intermediación", f: fmt },
    pagerank: { label: "PageRank", f: fmt },
    citations: { label: "Citas", f: fmtInt },
    ext_institutions: { label: "Instituciones externas", f: fmtInt },
  };

  // nombres cortos solo para rotular la red (la ficha y los reportes usan el nombre completo)
  const SHORT_LABEL = {
    "Ciencia de Computación y de Datos": "Computación y Datos",
    "Sistemas y Seguridad de la Información": "Sistemas y Seguridad",
    "Bioingeniería y Química": "Bioingeniería y Química",
    "Humanidades y Artes": "Humanidades",
    "Electrónica y Mecatrónica": "Electrónica y Mecatrónica",
    "Industrial y Gestión": "Industrial y Gestión",
    "Mecánica y Energía": "Mecánica y Energía",
    "Ciencia de Datos y SI": "Datos y SI",
  };
  const deptLabel = (k) => SHORT_LABEL[k] || k;
  const PARTICLES = new Set(["de", "la", "del", "las", "los", "y"]);
  function shortName(name) {
    const w = name.split(/\s+/);
    if (w.length <= 2) return name;
    let i = w.length >= 4 ? w.length - 2 : 1;
    if (/^[A-Z]\.$/.test(w[i])) i = w.length - 1;
    const sur = [w[i]];
    while (i - 1 > 0 && PARTICLES.has(w[i - 1].toLowerCase())) { i--; sur.unshift(w[i]); }
    return `${w[0]} ${sur.join(" ")}`;
  }
  function initials(name) {
    const w = name.split(/\s+/).filter((x) => !PARTICLES.has(x.toLowerCase()));
    return (w[0][0] + (w.length > 2 ? w[w.length - 2][0] : (w[1] || " ")[0])).toUpperCase();
  }

  const reduce = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DUR = reduce ? 0 : 900;

  function create(el, data, opts = {}) {
    const W = 1400;
    const H = Math.max(720, Math.round((W * (el.clientHeight || 800)) / (el.clientWidth || 1400)));
    // zona libre: arriba a la izquierda va el título; abajo, el reproductor
    const BOX = { x0: W * 0.31, x1: W - 40, y0: 120, y1: H - 140 };  // la columna izquierda es del texto

    // Quien figura en CRIS directamente en la facultad (sin departamento) es su decano/a:
    // no forma un "departamento" aparte, se ubica en la cabecera de su facultad.
    const N = data.nodes.map((d) => ({ ...d, ext_institutions: d.external ? d.external.institutions : 0,
      dean: /^Facultad/.test(d.department) }));
    const deanTitle = (d) => ((d.leadership || []).find((l) => /decan/i.test(l.role)) || {}).role || "Decanato";
    const byId = new Map(N.map((d) => [d.id, d]));
    const link = (e) => ({ ...e, source: byId.get(e.source), target: byId.get(e.target) });
    const CO = data.edges.filter((e) => e.type === "coauthor").map(link);
    const GR = data.edges.filter((e) => e.type === "group").map(link);
    const AF = data.affinity.map(link);
    const nbrs = new Map(N.map((d) => [d.id, new Set()]));
    CO.forEach((e) => { nbrs.get(e.source.id).add(e.target.id); nbrs.get(e.target.id).add(e.source.id); });
    const depts = data.meta.departments.map((d) => d.name); // ordenados por publicaciones

    const state = {
      size: "publications", layout: "clusters",
      layers: { coauthor: true, group: false, affinity: false, halo: false, leaders: false },
      dept: null, highlight: null, selected: null, hover: null, dragging: null,
      resistance: 0.55,
    };

    // ------------------------------------------------------------ contenedores
    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, W, H])
      .attr("preserveAspectRatio", "xMidYMid meet").attr("role", "img")
      .attr("aria-label", "Red de coautorías entre investigadores de UTEC");
    const defs = svg.append("defs");
    defs.append("filter").attr("id", "lift").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%")
      .append("feDropShadow").attr("dx", 0).attr("dy", 1.5).attr("stdDeviation", 2).attr("flood-color", "#10202c").attr("flood-opacity", 0.18);
    const root = svg.append("g");
    const gRad = root.append("g").attr("opacity", 0), gFac = root.append("g"), gHull = root.append("g"), gSwarm = root.append("g").attr("opacity", 0), gHullL = root.append("g"),
      gGroup = root.append("g"), gAff = root.append("g"), gCo = root.append("g"), gTether = root.append("g"),
      gHit = root.append("g"), gNode = root.append("g"), gLabel = root.append("g");
    const zoom = d3.zoom().scaleExtent([0.5, 6]).on("zoom", (ev) => root.attr("transform", ev.transform));
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", (ev) => { if (ev.target === svg.node() && opts.onBackground) opts.onBackground(); });

    // ------------------------------------------------------------ escalas
    const coW = d3.scaleLinear().domain([1, d3.max(CO, (e) => e.weight) || 1]).range([1.6, 6]);
    const affW = d3.scaleLinear().domain(d3.extent(AF, (e) => e.score)).range([1, 2.4]);
    const haloW = d3.scaleSqrt().domain([0, d3.max(N, (d) => d.betweenness) || 1]).range([0, 7]);
    const maxPub = d3.max(N, (d) => d.publications) || 1;
    function radius(d) {
      if (state.layout === "swarm") return 10;
      const max = d3.max(N, (n) => n[state.size]) || 1;
      return d3.scaleSqrt().domain([0, max]).range([9, state.size === "publications" ? 36 : 28])(d[state.size]);
    }
    const setRadii = () => N.forEach((d) => { d.r = radius(d); });
    setRadii();

    // ------------------------------------------------------------ disposición 1: territorios
    // Dos niveles: primero se ubica cada facultad (estructura de CRIS) y luego sus departamentos a su alrededor,
    // así los departamentos de una misma facultad quedan contiguos ("group in a box").
    function clusterCenters() {
      const groups = d3.group(N.filter((d) => !d.dean), (d) => d.department);
      const facOf = new Map(N.map((d) => [d.department, d.faculty]));
      // el radio de choque incluye el ancho del nombre: así los rótulos caben sin pisarse
      const lw = (id) => (deptLabel(id).length * 15 * 0.62) / 2 + 10;
      const cn = [...groups].map(([id, arr]) => {
        const r = Math.sqrt(d3.sum(arr, (d) => (d.r + 7) ** 2)) * 1.22 + 10;
        return { id, fac: facOf.get(id), r, rc: Math.max(r, lw(id)) };
      });
      const facs = [...d3.group(cn, (d) => d.fac)].map(([id, arr]) => ({ id, r: Math.sqrt(d3.sum(arr, (d) => (d.rc + 14) ** 2)) * 0.95 }))
        .sort((a, b) => b.r - a.r);
      // facultades compactas: sin repulsión, solo no se superponen y se acercan al centro
      const fsim = d3.forceSimulation(facs).randomSource(d3.randomLcg(3))
        .force("k", d3.forceCollide((d) => d.r + 18).iterations(3))
        .force("x", d3.forceX(W / 2).strength(0.08)).force("y", d3.forceY(H / 2).strength(0.12)).stop();
      for (let i = 0; i < 400; i++) fsim.tick();
      const anchor = new Map(facs.map((f) => [f.id, f]));
      const w = new Map();
      const add = (a, b, v) => { if (a === b) return; const k = a < b ? `${a}|${b}` : `${b}|${a}`; w.set(k, (w.get(k) || 0) + v); };
      CO.forEach((e) => add(e.source.department, e.target.department, e.weight));
      const links = [...w].map(([k, v]) => { const [s2, t] = k.split("|"); return { source: s2, target: t, value: v }; })
        .filter((l) => groups.has(l.source) && groups.has(l.target));   // los decanatos no son nodos de este nivel
      cn.forEach((d) => { const a = anchor.get(d.fac); d.x = a.x; d.y = a.y; });
      const sim = d3.forceSimulation(cn).randomSource(d3.randomLcg(5))
        .force("l", d3.forceLink(links).id((d) => d.id).distance((l) => l.source.r + l.target.r + 30).strength(0.02))
        .force("c", d3.forceManyBody().strength(-15)).force("k", d3.forceCollide((d) => d.rc + 14).iterations(3))
        .force("x", d3.forceX((d) => anchor.get(d.fac).x).strength(0.3)).force("y", d3.forceY((d) => anchor.get(d.fac).y).strength(0.3)).stop();
      for (let i = 0; i < 500; i++) sim.tick();
      const x0 = d3.min(cn, (d) => d.x - d.rc), x1 = d3.max(cn, (d) => d.x + d.rc);
      const y0 = d3.min(cn, (d) => d.y - d.r - 24), y1 = d3.max(cn, (d) => d.y + d.r + 20);
      // Las distancias NO se comprimen (comprimirlas hacía que fotos y rótulos se pisaran):
      // si no cabe, se aleja la cámara (zoom inicial) en lugar de juntar los departamentos.
      const bx = (BOX.x0 + BOX.x1) / 2, by = (BOX.y0 + BOX.y1) / 2;
      const fit = Math.min(1, (BOX.x1 - BOX.x0) / (x1 - x0), (BOX.y1 - BOX.y0) / (y1 - y0));
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      N.forEach((d) => {
        if (d.dean) return;
        const c = cn.find((q) => q.id === d.department); d.cx = bx + (c.x - mx); d.cy = by + (c.y - my);
      });
      // decano/a: centrado sobre los departamentos de su facultad, en la parte superior
      N.filter((d) => d.dean).forEach((d) => {
        const deps = cn.filter((q) => q.fac === d.faculty);
        if (!deps.length) { d.cx = bx; d.cy = by; return; }
        d.cx = bx + (d3.mean(deps, (q) => q.x) - mx);
        d.cy = by + (d3.min(deps, (q) => q.y - q.r) - my) - 46;
      });
      baseT = d3.zoomIdentity.translate(bx, by).scale(fit).translate(-bx, -by);
    }
    let baseT = d3.zoomIdentity;
    // vista inicial de cada disposición: territorios ajustados para que todo quepa; mapa radial un poco alejado
    const radialT = () => { const bx = (BOX.x0 + BOX.x1) / 2, by = (BOX.y0 + BOX.y1) / 2;
      return d3.zoomIdentity.translate(bx, by).scale(0.8).translate(-bx, -by); };
    const homeT = () => (state.layout === "clusters" ? baseT : state.layout === "radial" ? radialT() : d3.zoomIdentity);

    // ------------------------------------------------------------ disposición 2: beeswarm por departamento
    // Columna "0" a la izquierda para quienes no tienen publicaciones (el logaritmo no admite 0)
    const SW = { label: BOX.x0 + 165, z0: BOX.x0 + 185, slot: 22, xL: BOX.x0 + 345, xR: BOX.x1 - 75 };
    const swX = d3.scaleLog().domain([1, maxPub]).range([SW.xL, SW.xR]);
    const swY = d3.scaleBand().domain(depts).range([BOX.y0 + 40, BOX.y1 + 20]).paddingInner(0.08);
    const zeroIdx = new Map();
    d3.group(N.filter((d) => d.publications === 0), (d) => d.department)
      .forEach((arr) => arr.sort((a, b) => a.name.localeCompare(b.name)).forEach((d, i) => zeroIdx.set(d.id, i)));
    const zoneMid = SW.z0 + SW.slot * 2.5;
    const xOf = (v) => (v >= 1 ? swX(v) : zoneMid);
    N.forEach((d) => {
      d.sx = d.publications > 0 ? swX(d.publications) : SW.z0 + 11 + zeroIdx.get(d.id) * SW.slot;
      d.sy = swY(d.department) + swY.bandwidth() / 2;
    });
    (function drawSwarmGuides() {
      const ticks = [1, 2, 5, 10, 20, 50, 100, 200, 500].filter((t) => t <= maxPub);
      const top = swY.range()[0], bottom = swY.range()[1];
      const axis = gSwarm.append("g").attr("class", "sw-axis");
      axis.selectAll("line").data(ticks).join("line").attr("x1", swX).attr("x2", swX).attr("y1", top).attr("y2", bottom);
      axis.selectAll("text.t").data(ticks).join("text").attr("class", "t").attr("x", swX).attr("y", top - 8).text((t) => fmtInt.format(t));
      axis.append("rect").attr("class", "sw-zero").attr("x", SW.z0 - 4).attr("y", top).attr("width", SW.slot * 5 + 8).attr("height", bottom - top).attr("rx", 8);
      axis.append("text").attr("x", zoneMid).attr("y", top - 8).text("Sin publicaciones");
      axis.append("text").attr("class", "sw-title").attr("x", SW.xR).attr("y", top - 28)
        .text("Publicaciones por investigador (escala log.)");
      const meta = new Map(data.meta.departments.map((d) => [d.name, d]));
      const row = gSwarm.append("g").selectAll("g").data(depts).join("g")
        .attr("transform", (d) => `translate(0,${swY(d) + swY.bandwidth() / 2})`);
      row.append("line").attr("class", "sw-row").attr("x1", SW.z0 - 4).attr("x2", SW.xR + 10);
      row.append("text").attr("class", "sw-dept").attr("x", SW.label).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d);
      row.append("line").attr("class", "sw-median")
        .attr("x1", (d) => xOf(meta.get(d).median_publications)).attr("x2", (d) => xOf(meta.get(d).median_publications))
        .attr("y1", -swY.bandwidth() * 0.42).attr("y2", swY.bandwidth() * 0.42);
      const tot = row.append("text").attr("class", "sw-total").attr("x", SW.xR + 18).attr("dy", "0.35em");
      tot.append("tspan").attr("class", "n").text((d) => fmtInt.format(meta.get(d).publications));
    })();

    clusterCenters();
    const rnd = d3.randomLcg(42);  // disposición reproducible entre recargas
    N.forEach((d) => { d.x = d.cx + (rnd() - 0.5) * 40; d.y = d.cy + (rnd() - 0.5) * 40; });

    // ------------------------------------------------------------ aristas
    const groupSel = gGroup.selectAll("line").data(GR).join("line").attr("class", "edge group");
    const affSel = gAff.selectAll("line").data(AF).join("line").attr("class", "aff").attr("stroke-width", (e) => affW(e.score));
    const coSel = gCo.selectAll("line").data(CO).join("line")
      .attr("class", (e) => `edge coauthor${e.cross_department ? " cross" : ""}`)
      .attr("stroke-width", (e) => coW(e.weight)).attr("stroke-opacity", 0);
    const hitCo = gHit.selectAll("line.hc").data(CO).join("line").attr("class", "edge-hit hc");
    const hitAf = gHit.selectAll("line.ha").data(AF).join("line").attr("class", "edge-hit ha");
    const tipOn = (sel, fn) => sel
      .on("mouseenter", (ev, e) => { state.hover = e; apply(); showTip(ev, fn(e)); })
      .on("mousemove", (ev) => moveTip(ev))
      .on("mouseleave", () => { state.hover = null; apply(); hideTip(); });
    tipOn(hitCo, coTip); tipOn(hitAf, affTip);
    const tether = gTether.append("line").attr("class", "tether").style("display", "none");

    // ------------------------------------------------------------ nodos: foto recortada
    const clipC = defs.selectAll("clipPath").data(N, (d) => d.id).join("clipPath").attr("id", (d) => `c${d.id}`)
      .append("circle").attr("r", 0);
    const nodeSel = gNode.selectAll("g.node").data(N, (d) => d.id).join((enter) => {
      const g = enter.append("g").attr("class", "node").attr("tabindex", 0).attr("aria-label", (d) => `${d.name}, ${d.department}`);
      g.append("circle").attr("class", "halo");
      g.append("circle").attr("class", "bg").attr("filter", "url(#lift)");
      g.append("text").attr("class", "initials").text((d) => initials(d.name));
      g.filter((d) => d.image_url || d.photo_local).append("image")
        .attr("clip-path", (d) => `url(#c${d.id})`).attr("preserveAspectRatio", "xMidYMid slice")
        // cadena de carga: caché local, luego CRIS directo, luego proxy de Flask, luego iniciales
        .attr("href", (d) => (d.photo_local ? `/photo/${d.id}` : d.image_url))
        .on("error", function (ev, d) {
          const img = d3.select(this);
          if (!d._tried && !d.photo_local) { d._tried = true; img.attr("href", `/photo/${d.id}`); } else img.remove();
        });
      g.append("circle").attr("class", "ring");
      g.filter((d) => d.leadership && d.leadership.length).append("circle").attr("class", "lead").attr("r", 4.5);
      return g;
    });

    nodeSel
      .on("mouseenter", (ev, d) => { if (state.dragging) return; state.hover = d; apply(); showTip(ev, nodeTip(d)); })
      .on("mousemove", (ev) => moveTip(ev))
      .on("mouseleave", () => { if (state.dragging) return; state.hover = null; apply(); hideTip(); })
      .on("click", (ev, d) => { ev.stopPropagation(); opts.onSelect && opts.onSelect(d, ev); })
      .on("dblclick", (ev, d) => { ev.stopPropagation(); focusNode(d.id); })
      .on("keydown", (ev, d) => { if (ev.key === "Enter") opts.onSelect && opts.onSelect(d); })
      .call(d3.drag().clickDistance(6).filter((ev) => !ev.button).on("start", dragStart).on("drag", dragMove).on("end", dragEnd));

    // ------------------------------------------------------------ arrastre con resistencia
    // El nodo no salta al cursor: lo sigue con retraso (más resistencia, más lento) unido por un
    // hilo; sus coautores se estiran como un elástico y, al soltarlo, vuelve con un rebote amortiguado.
    function dragStart(ev, d) {
      hideTip();
      state.dragging = d; d.tx = d.x; d.ty = d.y; d.fx = d.x; d.fy = d.y;
      sim.force("co").strength((e) => (e.source === d || e.target === d ? 0.35 : baseCo(e)));
      sim.alphaTarget(0.25).restart();
      tether.style("display", null);
    }
    function dragMove(ev, d) { d.tx = ev.x; d.ty = ev.y; }
    function dragEnd(ev, d) {
      state.dragging = null; d.fx = d.fy = null;
      sim.force("co").strength(baseCo);
      sim.alphaTarget(0).alpha(0.6).restart();
      tether.style("display", "none");
    }
    function followPointer() {
      const d = state.dragging; if (!d) return;
      const k = 1 - 0.9 * state.resistance;           // fracción del trayecto que avanza en cada tick
      d.fx += (d.tx - d.fx) * k; d.fy += (d.ty - d.fy) * k;
      const dist = Math.hypot(d.tx - d.fx, d.ty - d.fy);
      tether.attr("x1", d.fx).attr("y1", d.fy).attr("x2", d.tx).attr("y2", d.ty).attr("stroke-opacity", Math.min(0.85, dist / 50));
    }

    // ------------------------------------------------------------ rótulos en caja
    const labelSel = gLabel.selectAll("g.chip").data(N, (d) => d.id).join((enter) => {
      const g = enter.append("g").attr("class", "chip").style("display", "none");
      g.append("rect"); g.append("text");
      return g;
    });
    function setLabel(g, d, rank) {
      g.classed("rank", !!rank && rank !== "dean").classed("dean", rank === "dean");
      const t = g.select("text").text(null);
      if (rank === "dean") t.append("tspan").attr("class", "num").text(`${deanTitle(d)}  `);
      else if (rank) t.append("tspan").attr("class", "num").text(`${rank}  `);
      t.append("tspan").text(shortName(d.name));
      const w = t.node().getComputedTextLength();
      g.select("rect").attr("x", -w / 2 - 8).attr("y", -10).attr("width", w + 16).attr("height", 20).attr("rx", 10);
      t.attr("x", -w / 2).attr("y", 0.5);
    }

    function drawRadii(dur = DUR) {
      const t = svg.transition().duration(dur).ease(d3.easeCubicInOut);
      nodeSel.selectAll(".bg, .ring").transition(t).attr("r", (d) => d.r);
      nodeSel.select("image").transition(t).attr("x", (d) => -d.r).attr("y", (d) => -d.r).attr("width", (d) => 2 * d.r).attr("height", (d) => 2 * d.r);
      clipC.transition(t).attr("r", (d) => d.r);
      drawHalo(t);
      nodeSel.select(".initials").style("font-size", (d) => `${Math.max(8, d.r * 0.62)}px`);
      nodeSel.select(".lead").transition(t).attr("cx", (d) => d.r * 0.72).attr("cy", (d) => -d.r * 0.72);
      sim.force("collide").radius(collideR);
      sim.alpha(0.4).restart();
    }
    function drawHalo(t) {
      const on = state.layers.halo && state.layout !== "swarm";
      nodeSel.select(".halo").transition(t || svg.transition().duration(DUR))
        .attr("r", (d) => d.r + 4 + haloW(d.betweenness) / 2)
        .attr("stroke-width", (d) => haloW(d.betweenness))
        .attr("stroke-opacity", (d) => (on && d.betweenness > 0 ? 1 : 0));
    }
    const collideR = (d) => d.r + (state.layout === "swarm" ? 1.5 : 4 + (state.layers.halo ? haloW(d.betweenness) : 0));

    // ------------------------------------------------------------ simulación
    const baseCo = (e) => (state.layout !== "clusters" ? 0 : e.cross_department ? 0.02 : 0.15);
    const sim = d3.forceSimulation(N).randomSource(d3.randomLcg(7))
      .force("co", d3.forceLink(CO).id((d) => d.id).distance((e) => e.source.r + e.target.r + 26).strength(baseCo))
      .force("charge", d3.forceManyBody().strength(-26))
      .force("collide", d3.forceCollide(collideR).iterations(2))
      .force("x", d3.forceX((d) => d.cx).strength(0.17))
      .force("y", d3.forceY((d) => d.cy).strength(0.17))
      .velocityDecay(0.2 + 0.5 * state.resistance)
      .alphaDecay(0.03).on("tick", () => { followPointer(); ticked(); });

    // ------------------------------------------------------------ territorios (enclosure)
    const hullLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6));
    function hulls() {
      return [...d3.group(N.filter((d) => !d.dean), (d) => d.department)].map(([k, arr]) => {
        const pts = [];
        arr.forEach((d) => { const rr = d.r + 13; for (let a = 0; a < 12; a++) pts.push([d.x + rr * Math.cos(a * Math.PI / 6), d.y + rr * Math.sin(a * Math.PI / 6)]); });
        const hull = d3.polygonHull(pts);
        return { key: k, hull, top: d3.min(hull, (p) => p[1]), bottom: d3.max(hull, (p) => p[1]), cx: d3.mean(arr, (d) => d.x) };
      });
    }
    const pos = (sel) => sel.attr("x1", (e) => e.source.x).attr("y1", (e) => e.source.y).attr("x2", (e) => e.target.x).attr("y2", (e) => e.target.y);
    function ticked() {
      pos(coSel); pos(hitCo); pos(groupSel); pos(affSel); pos(hitAf);
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
      // el rótulo del decano va arriba de su foto (abajo están los departamentos de su facultad)
      labelSel.attr("transform", (d) => `translate(${d.x},${d.dean ? d.y - d.r - 14 : d.y + d.r + 15})`);
      if (state.layout === "swarm") return;
      const fh = [...d3.group(N, (d) => d.faculty)].filter(([k]) => !/^Sin/.test(k)).map(([k, arr]) => {
        const pts = [];
        arr.forEach((d) => { const rr = d.r + 46; for (let a = 0; a < 12; a++) pts.push([d.x + rr * Math.cos(a * Math.PI / 6), d.y + rr * Math.sin(a * Math.PI / 6)]); });
        const hull = d3.polygonHull(pts);
        const top = hull.reduce((m, p) => (p[1] < m[1] ? p : m));
        const bottom = hull.reduce((m, p) => (p[1] > m[1] ? p : m));  // el nombre de la facultad va abajo: arriba están los departamentos
        return { key: k, hull, top, bottom };
      });
      gFac.selectAll("path").data(fh, (d) => d.key).join("path").attr("class", "fac").attr("d", (d) => hullLine(d.hull));
      const h = hulls();
      // ---- rótulos sin choques: primero facultades, luego departamentos de arriba hacia abajo;
      // si un rótulo choca con otro ya ubicado, se desplaza hacia arriba (o abajo si se aleja demasiado)
      const labelOf = deptLabel;
      const items = [
        ...fh.map((f) => ({ kind: "fac", key: f.key, text: f.key, x: f.bottom[0], fs: 12,
          cands: [f.bottom[1] + 14, f.bottom[1] + 28, f.top[1] - 10, f.top[1] - 24] })),
        ...h.map((d) => ({ kind: "dep", key: d.key, text: labelOf(d.key), x: d.cx, fs: 15,
          cands: [d.top - 9, d.top - 25] })),
      ];
      const placed = [];
      const box = (l) => ({ x0: l.x - (l.text.length * l.fs * 0.62) / 2 - 4, x1: l.x + (l.text.length * l.fs * 0.62) / 2 + 4, y0: l.y - l.fs, y1: l.y + 4 });
      const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      // las fotos también son obstáculos: un rótulo no debe tapar a ningún investigador
      const obstacles = N.map((d) => ({ x0: d.x - d.r, x1: d.x + d.r, y0: d.y - d.r, y1: d.y + d.r }))
        .concat(N.filter((d) => d.dean).map((d) => ({ x0: d.x - 85, x1: d.x + 85, y0: d.y - d.r - 26, y1: d.y - d.r - 2 })));
      // cada rótulo prueba unas pocas posiciones cerca de su grupo (arriba, más arriba, debajo)
      // y se queda con la primera que no tapa fotos ni otros rótulos; si ninguna está libre, la menos tapada
      items.sort((a, b) => (a.kind === b.kind ? a.cands[0] - b.cands[0] : a.kind === "fac" ? -1 : 1)).forEach((l) => {
        const half = (l.text.length * l.fs * 0.62) / 2;
        let best = null, bestHits = Infinity;
        for (const y of l.cands) {
          l.y = y;
          const b = box(l);
          const hits = placed.filter((p) => hit(b, box(p))).length * 3 + obstacles.filter((p) => hit(b, p)).length;
          if (hits < bestHits) { best = l.y; bestHits = hits; }
          if (!hits) break;
        }
        l.y = best;   // sin recortes al borde: la cámara se ajusta para que todo quepa
        placed.push(l);
      });
      const lpos = new Map(placed.map((l) => [l.kind + l.key, l]));
      gFac.selectAll("text").data(fh, (d) => d.key).join("text").attr("class", "fac-label")
        .attr("x", (d) => lpos.get("fac" + d.key).x).attr("y", (d) => lpos.get("fac" + d.key).y).text((d) => d.key);
      gHull.selectAll("path").data(h, (d) => d.key).join("path").attr("class", "hull")
        .attr("d", (d) => hullLine(d.hull)).classed("on", (d) => d.key === state.dept || (state.layout === "radial" && d.key === state.myDept)).classed("dim", (d) => state.dept && d.key !== state.dept);
      gHullL.selectAll("text").data(h, (d) => d.key).join((e) => e.append("text").attr("class", "hull-label")
        .on("click", (ev, d) => { ev.stopPropagation(); opts.onDept && opts.onDept(d.key); }))
        .attr("x", (d) => lpos.get("dep" + d.key).x).attr("y", (d) => lpos.get("dep" + d.key).y).text((d) => labelOf(d.key))
        .classed("dim", (d) => state.dept && d.key !== state.dept);
    }

    // ------------------------------------------------------------ disposición 3: afinidad desde mi departamento
    // El departamento elegido va al centro; los demás se ubican a una distancia inversa a su afinidad temática
    // (TF-IDF de sus áreas). Cerca y sin líneas = oportunidad de colaboración.
    function radialCenters(center) {
      const prof = data.meta.department_profile[center];
      if (!prof) return;
      const cx = (BOX.x0 + BOX.x1) / 2, cy = (BOX.y0 + BOX.y1) / 2;
      const R = Math.min(BOX.x1 - BOX.x0, BOX.y1 - BOX.y0) / 2 - 75;
      const others = Object.entries(prof.similarity).sort((a, b) => b[1] - a[1]);
      const maxS = d3.max(others, (d) => d[1]) || 1;
      const rad = d3.scaleLinear().domain([maxS, 0]).range([R * 0.38, R]);
      const pos = new Map([[center, [cx, cy]]]);
      others.forEach(([d, sim], i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / others.length + (i % 2 ? 0.25 : 0);
        pos.set(d, [cx + rad(sim) * Math.cos(a), cy + rad(sim) * Math.sin(a)]);
      });
      // los departamentos muy afines caerían encima unos de otros: se separan sin alejarlos de su anillo
      const size = d3.rollup(N, (v) => Math.sqrt(d3.sum(v, (d) => (d.r + 6) ** 2)) * 1.15 + 8, (d) => d.department);
      const an = [...pos].map(([id, [x, y]]) => ({ id, x, y, tx: x, ty: y, r: size.get(id) || 20, fixed: id === center }));
      an.forEach((a) => { if (a.fixed) { a.fx = a.x; a.fy = a.y; } });
      const asim = d3.forceSimulation(an).randomSource(d3.randomLcg(9))
        .force("x", d3.forceX((a) => a.tx).strength(0.25)).force("y", d3.forceY((a) => a.ty).strength(0.25))
        .force("k", d3.forceCollide((a) => a.r + 26).iterations(3)).stop();
      for (let i = 0; i < 300; i++) {
        asim.tick();
        // nada se sale del área de la red (ni bajo la barra de tareas ni bajo las herramientas)
        an.forEach((a) => { a.x = Math.max(BOX.x0 + a.r, Math.min(BOX.x1 - a.r, a.x)); a.y = Math.max(BOX.y0 + a.r * 0.6, Math.min(BOX.y1 - a.r, a.y)); });
      }
      an.forEach((a) => pos.set(a.id, [a.x, a.y]));
      N.forEach((d) => { [d.rx, d.ry] = pos.get(d.department) || [cx, cy]; });
      N.filter((d) => d.dean).forEach((d) => {
        const deps = [...pos].filter(([k]) => k !== d.department && N.some((n) => !n.dean && n.department === k && n.faculty === d.faculty));
        if (deps.length) { d.rx = d3.mean(deps, (p) => p[1][0]); d.ry = d3.min(deps, (p) => p[1][1]) - 60; }
      });
      gRad.selectAll("*").remove();
      // anillos de referencia muy tenues y sin texto: la leyenda explica que más cerca = más afín
      [maxS * 0.5, 0].forEach((v) => {
        gRad.append("circle").attr("class", "ring-guide").attr("cx", cx).attr("cy", cy).attr("r", rad(v));
      });
    }

    // ------------------------------------------------------------ cambio de disposición (animado)
    function setLayout(mode, center) {
      if (mode === "radial") radialCenters(center || state.myDept);
      if (mode === state.layout && mode !== "radial") return;
      state.layout = mode;
      svg.transition("zoom").duration(DUR).call(zoom.transform, homeT());
      setRadii();
      const sw = mode === "swarm", rd = mode === "radial";
      sim.force("x").x((d) => (sw ? d.sx : rd ? d.rx : d.cx)).strength(sw ? 0.9 : rd ? 0.22 : 0.17);
      sim.force("y").y((d) => (sw ? d.sy : rd ? d.ry : d.cy)).strength(sw ? 0.45 : rd ? 0.22 : 0.17);
      gRad.transition().duration(DUR).attr("opacity", rd ? 1 : 0);
      sim.force("charge").strength(sw ? 0 : -26);
      sim.force("co").strength(baseCo);
      gHull.transition().duration(DUR / 2).attr("opacity", sw ? 0 : 1);
      gFac.transition().duration(DUR / 2).attr("opacity", sw || rd ? 0 : 1);
      gHullL.transition().duration(DUR / 2).attr("opacity", sw ? 0 : 1);
      gSwarm.transition().delay(sw ? DUR / 2 : 0).duration(DUR / 2).attr("opacity", sw ? 1 : 0);
      drawRadii();
      sim.alpha(1).restart();
      apply();
    }

    // ------------------------------------------------------------ estado visual
    function apply() {
      const sw = state.layout === "swarm";
      const showAff = state.layers.affinity || (state.highlight && state.highlight.affinity);
      groupSel.style("display", state.layers.group || (state.highlight && state.highlight.gr) ? null : "none");
      affSel.style("display", showAff ? null : "none"); hitAf.style("display", showAff ? null : "none");
      coSel.style("display", state.layers.coauthor ? null : "none"); hitCo.style("display", state.layers.coauthor ? null : "none");

      let nodeOn = () => true, coOn = () => !sw, affOn = () => true, grOn = () => true;
      const labels = new Map();
      const h = state.hover;
      const focus = h && h.name ? h : state.selected;

      if (h && h.source) {
        nodeOn = (d) => d === h.source || d === h.target;
        coOn = affOn = (e) => e === h; grOn = () => false;
        labels.set(h.source.id, 0); labels.set(h.target.id, 0);
      } else if (focus) {
        const nb = nbrs.get(focus.id);
        const af = new Set(AF.filter((e) => e.source === focus || e.target === focus).flatMap((e) => [e.source.id, e.target.id]));
        nodeOn = (d) => d === focus || nb.has(d.id) || af.has(d.id);
        coOn = affOn = grOn = (e) => e.source === focus || e.target === focus;
        affSel.filter((e) => e.source === focus || e.target === focus).style("display", null);
        [focus.id, ...nb, ...af].forEach((id) => labels.set(id, 0));
      } else if (state.highlight) {
        const s = state.highlight;
        if (s.nodes) nodeOn = (d) => s.nodes.has(d.id);
        if (s.co) coOn = s.co;
        if (s.aff) affOn = s.aff;
        grOn = s.gr || (() => false);
        (s.ranked || []).forEach((id, i) => labels.set(id, i + 1));
        (s.labels || []).forEach((id) => { if (!labels.has(id)) labels.set(id, 0); });
      } else if (state.dept) {
        nodeOn = (d) => d.department === state.dept;
        coOn = affOn = grOn = (e) => e.source.department === state.dept || e.target.department === state.dept;
      }
      if (!focus && !(h && h.source) && state.layout !== "swarm") {
        N.filter((d) => d.dean && nodeOn(d) && !labels.has(d.id)).forEach((d) => labels.set(d.id, "dean"));
      }

      nodeSel.classed("faded", (d) => !nodeOn(d)).classed("selected", (d) => state.selected === d);
      nodeSel.select(".lead").style("display", state.layers.leaders ? null : "none");
      coSel.classed("faded", (e) => !coOn(e) && !sw).classed("gone", (e) => sw && !coOn(e));
      affSel.classed("faded", (e) => !affOn(e));
      groupSel.classed("faded", (e) => !grOn(e));
      labelSel.style("display", (d) => (labels.has(d.id) ? null : "none"))
        .each(function (d) { if (labels.has(d.id)) setLabel(d3.select(this), d, labels.get(d.id)); });
      // reordenar el DOM durante el hover hace que el navegador pierda el clic: solo se reordena fuera del hover
      if (!state.hover) nodeSel.filter((d) => labels.has(d.id) || d === state.selected).raise();
      nodeSel.classed("mine", (d) => state.myDept && d.department === state.myDept);
      ticked();
    }

    // ------------------------------------------------------------ tooltips
    const tip = d3.select(opts.tooltip);
    const host = opts.tooltip ? opts.tooltip.parentElement : el;
    function showTip(ev, html) { tip.html(html).attr("hidden", null); moveTip(ev); }
    function moveTip(ev) {
      const [x, y] = d3.pointer(ev, host);
      const tw = tip.node().offsetWidth, th = tip.node().offsetHeight;
      tip.style("left", `${Math.min(x + 16, host.clientWidth - tw - 14)}px`)
        .style("top", `${y + th + 30 > host.clientHeight ? y - th - 14 : y + 16}px`);
    }
    function hideTip() { tip.attr("hidden", true); }
    function nodeTip(d) {
      const m = METRICS[state.size];
      return `<b>${d.name}</b><div class="t-sub">${d.department}</div>
        <div class="t-row">${m.label} <b>${m.f.format(d[state.size])}</b> <span class="t-sub">puesto ${d.rank[state.size] || "-"}</span></div>
        <div class="t-sub">${d.publications} publicaciones, ${d.coauthors} coautores UTEC</div>
        ${(d.leadership || []).map((l) => `<div class="t-row">${l.role}: ${l.unit}</div>`).join("")}`;
    }
    function coTip(e) {
      return `<b>${shortName(e.source.name)} y ${shortName(e.target.name)}</b>
        <div class="t-sub">${e.weight} publicación${e.weight > 1 ? "es" : ""} en común, ${e.cross_department ? "entre departamentos" : "mismo departamento"}</div>
        ${e.publications.slice(0, 2).map((p) => `<div class="t-pub">${p.title}</div>`).join("")}`;
    }
    function affTip(e) {
      const why = [];
      if (e.shared_groups.length) why.push("mismo grupo de investigación");
      if (e.shared_terms.length) why.push(`intereses: ${e.shared_terms.join(", ")}`);
      return `<b>Posible colaboración n.º ${e.rank}</b><div class="t-sub">${shortName(e.source.name)} y ${shortName(e.target.name)}, afinidad ${fmt2.format(e.score)}</div>
        ${why.map((w) => `<div class="t-row">${w}</div>`).join("")}`;
    }

    // ------------------------------------------------------------ entrada animada (overview first)
    function intro() {
      const order = [...new Set(N.map((d) => d.department))];
      const delay = (d) => order.indexOf(d.department) * 90 + Math.random() * 120;
      nodeSel.select(".initials").style("font-size", (d) => `${Math.max(8, d.r * 0.62)}px`);
      nodeSel.selectAll(".bg, .ring").attr("r", 0).transition().delay(delay).duration(DUR).attr("r", (d) => d.r);
      nodeSel.select("image").attr("x", (d) => -d.r).attr("y", (d) => -d.r).attr("width", (d) => 2 * d.r).attr("height", (d) => 2 * d.r)
        .style("opacity", 0).transition().delay(delay).duration(DUR).style("opacity", 1);
      clipC.transition().delay(delay).duration(DUR).attr("r", (d) => d.r);
      nodeSel.select(".halo").attr("r", (d) => d.r + 4).attr("stroke-opacity", 0);
      coSel.transition().delay(order.length * 90 + 300).duration(DUR).attr("stroke-opacity", 1);
      apply();
    }

    function drawIn(filter) {
      if (reduce) return;
      coSel.filter(filter).each(function () {
        const len = Math.hypot(this.x2.baseVal.value - this.x1.baseVal.value, this.y2.baseVal.value - this.y1.baseVal.value);
        d3.select(this).attr("stroke-dasharray", `${len} ${len}`).attr("stroke-dashoffset", len)
          .transition().delay((d, i) => i * 110).duration(900).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0)
          .on("end", function () { d3.select(this).attr("stroke-dasharray", null); });
      });
    }

    // ------------------------------------------------------------ camino más corto (¿quién me puede presentar?)
    const adj = new Map(N.map((d) => [d.id, []]));
    [...CO, ...GR].forEach((e) => { adj.get(e.source.id).push([e.target.id, e]); adj.get(e.target.id).push([e.source.id, e]); });
    function shortestPath(a, b) {
      const prev = new Map([[a, null]]), q = [a];
      while (q.length) {
        const u = q.shift();
        if (u === b) break;
        // se prefieren coautorías: se exploran antes que los vínculos de grupo
        adj.get(u).slice().sort((x, y) => (x[1].type === "coauthor" ? -1 : 1) - (y[1].type === "coauthor" ? -1 : 1))
          .forEach(([v, e]) => { if (!prev.has(v)) { prev.set(v, [u, e]); q.push(v); } });
      }
      if (!prev.has(b)) return null;
      const ids = [], edges = [];
      for (let v = b; v !== null; v = prev.get(v) ? prev.get(v)[0] : null) { ids.unshift(v); if (prev.get(v)) edges.push(prev.get(v)[1]); }
      return { ids, edges };
    }
    function showPath(a, b) {
      const p = shortestPath(a, b);
      if (!p) return null;
      const es = new Set(p.edges);
      state.selected = null;
      setHighlight({ nodes: new Set(p.ids), co: (e) => es.has(e), gr: (e) => es.has(e), ranked: p.ids, path: true });
      return p;
    }

    // ------------------------------------------------------------ API
    function setSize(m) {
      state.size = m; setRadii();
      if (state.layout === "clusters") { clusterCenters(); sim.force("x").x((d) => d.cx); sim.force("y").y((d) => d.cy); svg.transition("zoom").duration(DUR).call(zoom.transform, baseT); }
      drawRadii(); apply();
    }
    function setLayers(l) { Object.assign(state.layers, l); drawHalo(); sim.force("collide").radius(collideR); sim.alpha(0.2).restart(); apply(); }
    function setResistance(r) { state.resistance = r; sim.velocityDecay(0.2 + 0.5 * r); }
    function setDept(d) { state.dept = d; apply(); }
    function setMyDept(d) { state.myDept = d; apply(); }
    function setHighlight(h) { state.highlight = h; apply(); }
    function select(id) { state.selected = id == null ? null : byId.get(id); apply(); }
    function hoverNode(id) { state.hover = id == null ? null : byId.get(id); apply(); }
    function hoverEdge(e) { state.hover = e; apply(); }
    function focusNode(id, k = 1.8) {
      const d = byId.get(id); if (!d) return;
      svg.transition("zoom").duration(DUR).call(zoom.transform, d3.zoomIdentity.translate(W * 0.66, H / 2).scale(k).translate(-d.x, -d.y));
    }
    function resetZoom() { svg.transition("zoom").duration(DUR).call(zoom.transform, homeT()); }

    svg.call(zoom.transform, homeT());
    intro();
    return { setMyDept, shortestPath, showPath, setSize, setLayout, setLayers, setResistance, setDept, setHighlight, select, hoverNode, hoverEdge,
      focusNode, resetZoom, drawIn, state, nodes: N, coauthor: CO, affinity: AF, byId, nbrs };
  }

  global.UtecVis = { create, shortName, initials, METRICS, fmt, fmt2, fmtInt, pct };
})(window);