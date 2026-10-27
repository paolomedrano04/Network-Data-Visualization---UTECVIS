/* UtecVis v4: una sola vista. Tareas con hallazgos (generados en pipeline/insights.py), herramientas
   flotantes (ranking, estructura organizativa, métricas, ajustes, reporte) y ficha compartible. */
(async function () {
  "use strict";
  const { shortName, METRICS, fmt, fmt2, fmtInt, pct } = UtecVis;
  const $ = (s) => document.querySelector(s);

  const data = await (await fetch("/api/graph")).json();
  const meta = data.meta, S = meta.summary, INS = data.insights;
  const vis = UtecVis.create($("#chart"), data, {
    tooltip: $("#tooltip"),
    onSelect: (d, ev) => {
      const anchor = vis.state.selected ? vis.state.selected.id : pathAnchor;
      if (ev && ev.shiftKey && anchor != null && anchor !== d.id) return pathTo(anchor, d.id);
      if (vis.state.selected && vis.state.selected.id === d.id) return closeProfile();  // segundo clic: deselecciona
      openProfile(d.id);
    },
    onBackground: () => { closeProfile(); closePops(); },
    onDept: (name) => setDept(vis.state.dept === name ? null : name),
  });
  const N = vis.nodes, byId = vis.byId;
  const by = (m) => N.slice().sort((a, b) => b[m] - a[m] || b.publications - a.publications);
  const task = (id) => INS.tasks.find((t) => t.id === id);

  // ======================================================= leyenda
  const sv = (inner, w = 26, h = 16) => `<svg width="${w}" height="${h}">${inner}</svg>`;
  const L = {
    territory: [sv('<rect x="1" y="2" width="24" height="12" rx="6" fill="#eff3f6"/>'), "Fondo gris: departamento (clic en el nombre para filtrar)"],
    faculty: [sv('<rect x="1" y="2" width="24" height="12" rx="6" fill="none" stroke="#c4cdd3" stroke-dasharray="3 3"/>'), "Contorno punteado: facultad (estructura de CRIS)"],
    size: (m) => [sv('<circle cx="6" cy="10" r="4" fill="#e7ecef" stroke="#c4cdd3"/><circle cx="18" cy="8" r="7" fill="#e7ecef" stroke="#c4cdd3"/>'), `Tamaño: ${m}`],
    cross: [sv('<line x1="1" y1="8" x2="25" y2="8" stroke="#00aeef" stroke-width="3.5" stroke-linecap="round"/>'), "Coautoría entre departamentos"],
    same: [sv('<line x1="1" y1="8" x2="25" y2="8" stroke="#a3acb4" stroke-width="3" stroke-linecap="round"/>'), "Coautoría en el mismo departamento"],
    width: [sv('<line x1="1" y1="4" x2="25" y2="4" stroke="#a3acb4" stroke-width="1.5"/><line x1="1" y1="11" x2="25" y2="11" stroke="#a3acb4" stroke-width="4"/>'), "Grosor: publicaciones compartidas"],
    groupdot: [sv('<line x1="1" y1="8" x2="25" y2="8" stroke="#9aa5ae" stroke-width="1.6" stroke-dasharray="1 4" stroke-linecap="round"/>'), "Punteado: comparten grupo de investigación, sin coautoría"],
    halo: [sv('<circle cx="13" cy="8" r="4" fill="#e7ecef"/><circle cx="13" cy="8" r="6.5" fill="none" stroke="#15181c" stroke-width="2.5"/>'), "Halo negro: intermediación (puente)"],
    leader: [sv('<circle cx="11" cy="9" r="6" fill="#e7ecef"/><circle cx="16" cy="4.5" r="3.5" fill="#15181c" stroke="#fff"/>'), "Punto negro: coordina o dirige una unidad"],
    radial: [sv('<circle cx="13" cy="8" r="3" fill="#00aeef"/><circle cx="13" cy="8" r="7" fill="none" stroke="#c4cdd3" stroke-dasharray="2 2"/>'), "Centro: tu departamento. Más cerca = temas más afines"],
    aff: [sv('<line x1="1" y1="8" x2="25" y2="8" stroke="#15181c" stroke-width="2" stroke-dasharray="5 3" opacity=".6"/>'), "Discontinua: colaboración probable (sin coautoría aún)"],
  };
  const GROUP_TXT = { faculty: "facultad", department: "departamento", group: "grupo de investigación" };
  function groupLegend() {
    const g = vis.state.groupBy;
    if (g === "affinity") return [[sv('<circle cx="7" cy="8" r="4" fill="#e7ecef" stroke="#c4cdd3"/><circle cx="19" cy="8" r="4" fill="#e7ecef" stroke="#c4cdd3"/><line x1="11" y1="8" x2="15" y2="8" stroke="#c4cdd3"/>'), "Juntos = temas de investigación parecidos (NLP)"]];
    if (!GROUP_TXT[g]) return [];
    return [[sv('<rect x="1" y="2" width="24" height="12" rx="6" fill="#eff3f6"/>'), `Fondo gris: ${GROUP_TXT[g]} (clic en el nombre para filtrar)`],
      ...(g === "department" ? [L.faculty] : [])];
  }
  const setLegend = (keys) => { $("#legend").innerHTML = keys.map(([s, t]) => `<li>${s}<span>${t}</span></li>`).join(""); };

  // ======================================================= pasos: panorama + tareas
  const lonelyIds = by("publications").slice(0, 5).filter((d) => d.coauthors === 0).map((d) => d.id);
  let myDept = "";
  let pathAnchor = null;                             // origen del camino (shift + clic)                                   // contexto elegido en "Soy de"
  const mine = (d) => !myDept || d.department === myDept;
  const touches = (e) => !myDept || e.source.department === myDept || e.target.department === myDept;
  let useRadial = true;   // con "Soy de": mapa radial; si el usuario elige una agrupación, se usa esa
  const layoutFor = () => (myDept && useRadial ? "radial" : "clusters");
  const VIEWS = {
    P: { tab: "Panorama", view: { size: "publications", layers: {} },
      legend: () => (myDept && useRadial ? [L.radial, L.cross, L.same] : [...groupLegend(), L.size("publicaciones"), L.cross]),
      apply() { if (myDept) vis.setHighlight({ co: touches }); } },
    T1: { view: { size: "coauthors", layers: {} }, legend: () => [L.size("número de coautores UTEC"), L.width, L.cross, L.same],
      apply() {
        const ranked = by("coauthors").filter((d) => d.coauthors > 0 && mine(d)).slice(0, 5).map((d) => d.id);
        const lone = myDept ? (INS.departments[myDept] || {}).lonely || [] : lonelyIds;
        const ids = new Set(N.filter((d) => (d.coauthors > 0 && (mine(d) || [...vis.nbrs.get(d.id)].some((x) => mine(byId.get(x))))) || lone.includes(d.id)).map((d) => d.id));
        vis.setHighlight({ nodes: ids, ranked, labels: lone, co: touches });
      } },
    T2: { view: { size: "coauthors", layers: { halo: true, leaders: true } }, legend: () => [L.halo, L.leader, L.size("número de coautores UTEC")],
      apply() {
        const ranked = by("betweenness").filter((d) => d.betweenness > 0 && mine(d)).slice(0, 5).map((d) => d.id);
        const top = new Set(ranked.slice(0, 2));
        const ids = new Set(N.filter((d) => d.betweenness > 0 || d.coauthors > 0 || (myDept && mine(d))).map((d) => d.id));
        vis.setHighlight({ nodes: ids, ranked, co: touches, gr: (e) => e.cross_department && (top.has(e.source.id) || top.has(e.target.id)) });
      } },
    T3: { view: { size: "publications", layers: { group: true } }, legend: () => [L.cross, L.same, L.groupdot, ...(myDept && useRadial ? [L.radial] : groupLegend())],
      apply() {
        if (myDept) vis.setHighlight({ co: touches, gr: touches });
        setTimeout(() => vis.drawIn((e) => e.cross_department && touches(e)), 400);
      } },
    T4: { view: { size: "publications", layers: {} }, legend: () => [L.aff],
      apply() {
        const top = vis.affinity.filter((e) => touches(e)).slice(0, 12);
        const set = new Set(top);
        const ids = new Set(top.flatMap((e) => [e.source.id, e.target.id]));
        const lab = top.slice(0, 2).flatMap((e) => [e.source.id, e.target.id]);
        vis.setHighlight({ nodes: ids, co: () => false, affinity: true, aff: (e) => set.has(e), labels: lab });
      } },
    T5: { view: { size: "ext_institutions", layers: {} }, legend: () => [L.size("instituciones externas coautoras")],
      apply() { vis.setHighlight({ ranked: by("ext_institutions").filter((d) => d.ext_institutions > 0 && mine(d)).slice(0, 5).map((d) => d.id) }); } },
  };
  const nTasks = INS.tasks.length;
  const STEPS = [{ id: "P", ...VIEWS.P }, ...INS.tasks.map((t) => ({ ...t, ...VIEWS[t.id], tab: `${t.id} ${t.tab}` }))];

  function caption(s) {
    const D = myDept ? INS.departments[myDept] : null;
    $("#kicker").textContent = s.id === "P" ? (myDept ? `Desde ${myDept}` : "Panorama") : `${s.id} de ${nTasks}`;
    $("#question").textContent = s.id === "P" ? (myDept ? "¿Con quién se conecta tu departamento?" : "¿Cómo colaboran los investigadores de UTEC?") : s.question;
    let head, why;
    if (s.id === "P") {
      head = D ? (D.gap === D.closest[0] ? `Lo más afín a ustedes por temas es ${D.closest[0]}, y aún no tienen ninguna coautoría.`
        : D.gap ? `Lo más afín a ustedes por temas es ${D.closest[0]}. Con ${D.gap} también hay afinidad y ninguna coautoría.` : `Lo más afín a ustedes por temas es ${D.closest[0]}.`)
        : `${S.researchers} investigadores, 3 facultades. ${S.coauthorships} coautorías; ${S.coauthorships_cross} cruzan departamentos.`;
      why = `<p>Clic en una foto: seleccionar. Shift + clic en otra: el camino entre ambos. Arrastre para moverla.</p><p class="m">${D ? "Distancia al centro = 1 − similitud de áreas (TF-IDF) entre departamentos." : "Fondo gris: departamento. Contorno punteado: facultad (estructura de CRIS)."}</p>`;
    } else {
      head = D && D.headlines[s.id] ? D.headlines[s.id] : s.headline;
      why = `<p>${s.finding}</p>${s.evidence.filter(Boolean).slice(0, 2).map((e) => `<p>${e}</p>`).join("")}<p class="m">Métrica: ${s.metric}</p>`;
    }
    $("#answer").textContent = head;
    $("#why-body").innerHTML = why;
  }
  $("#why").addEventListener("click", () => {
    const open = $("#why-body").hidden;
    $("#why-body").hidden = !open; $("#why").setAttribute("aria-expanded", open);
  });

  let current = 0;
  const stepLi = d3.select("#steps").selectAll("li").data(STEPS).join("li").attr("tabindex", 0)
    .html((s) => (s.id === "P" ? "Inicio" : `<span class="n">${s.id}</span>${s.tab.slice(3)}`))
    .on("click", (ev, s) => goTo(STEPS.indexOf(s)))
    .on("keydown", (ev, s) => { if (ev.key === "Enter") goTo(STEPS.indexOf(s)); });
  $("#prev").addEventListener("click", () => goTo(current - 1));
  $("#next").addEventListener("click", () => goTo(current + 1));

  function goTo(i) {
    current = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[current];
    closeProfile();
    vis.setDept(null);
    vis.setHighlight(null);
    vis.setLayers({ halo: false, affinity: false, group: false, leaders: false, ...s.view.layers });
    if (vis.state.size !== s.view.size) vis.setSize(s.view.size);
    vis.setLayout(layoutFor(), myDept);
    s.apply();
    setLegend(s.legend());
    caption(s);
    syncSettings();
    syncGroupingUI();
    stepLi.classed("active", (x, k) => k === current);
    $("#prev").disabled = current === 0;
    $("#next").disabled = current === STEPS.length - 1;
    if (openPop === "ranking") renderRanking();
  }

  // ======================================================= "Soy de": ambiente configurado por departamento
  const sel = d3.select("#my-dept");
  sel.selectAll("option.d").data(meta.departments.filter((d) => d.researchers >= 2).map((d) => d.name).sort()).join("option")
    .attr("class", "d").attr("value", (d) => d).text((d) => d);
  function setMyDept(d) {
    myDept = d;
    useRadial = !!d;   // al elegir un departamento se abre su mapa de afinidad
    try { d ? localStorage.setItem("utecvis-dept", d) : localStorage.removeItem("utecvis-dept"); } catch (e) { /* sin almacenamiento */ }
    $("#my-dept").value = d;
    vis.setMyDept(d || null);
    const D = d ? INS.departments[d] : null;
    $("#terms").innerHTML = D ? `Sus temas: <b>${D.terms.join(", ")}</b>. ${D.members} investigadores.` : "";
    updateReportLink();
    goTo(current);
  }
  $("#my-dept").addEventListener("change", (e) => setMyDept(e.target.value));
  function updateReportLink() {
    const id = vis.state.selected ? vis.state.selected.id : null;
    const a = $("#report-link");
    a.href = id != null ? `/investigador/${id}` : myDept ? `/reporte?d=${encodeURIComponent(myDept)}` : "/reporte";
    a.textContent = id != null ? "Reporte de la persona" : myDept ? "Reporte del departamento" : "Reporte general";
  }

  // ======================================================= agrupar en vivo
  // Siempre activo: en "Soy de" o en beeswarm, elegir una agrupación vuelve a la red con esa agrupación;
  // "Mapa de mi departamento" (solo con "Soy de") regresa al mapa radial de afinidad.
  function setGrouping(g) {
    if (g === "radial") {
      useRadial = true;
      vis.setLayout("radial", myDept);
    } else {
      useRadial = false;
      vis.setGroupBy(g);
      try { localStorage.setItem("utecvis-group", g); } catch (e) { /* sin almacenamiento */ }
      if (vis.state.layout !== "clusters") vis.setLayout("clusters");
    }
    STEPS[current].apply();
    setLegend(STEPS[current].legend());
    syncSettings();
    syncGroupingUI();
  }
  document.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => setGrouping(b.dataset.group)));
  function syncGroupingUI() {
    const radial = vis.state.layout === "radial";
    const mine = document.querySelector('[data-group="radial"]');
    mine.hidden = !myDept;
    document.querySelectorAll("[data-group]").forEach((b) => b.classList.toggle("on",
      b.dataset.group === "radial" ? radial : !radial && vis.state.layout === "clusters" && b.dataset.group === vis.state.groupBy));
  }

  // ======================================================= ajustes
  function syncSettings() {
    document.querySelectorAll("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === vis.state.layout));
    document.querySelectorAll(".tg").forEach((b) => b.classList.toggle("on", !!vis.state.layers[b.dataset.layer]));
    $("#size-metric").value = vis.state.size in METRICS ? vis.state.size : "publications";
  }
  document.querySelectorAll("[data-layout]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.layout === "clusters" && myDept) useRadial = false;
    vis.setLayout(b.dataset.layout, myDept); syncSettings(); syncGroupingUI();
  }));
  document.querySelectorAll(".tg").forEach((b) => b.addEventListener("click", () => {
    vis.setLayers({ [b.dataset.layer]: !vis.state.layers[b.dataset.layer] }); syncSettings();
  }));
  $("#size-metric").addEventListener("change", (e) => vis.setSize(e.target.value));
  const resLabel = (v) => (v < 0.25 ? "baja" : v < 0.7 ? "media" : "alta");
  $("#resistance").addEventListener("input", (e) => { vis.setResistance(+e.target.value); $("#res-out").textContent = resLabel(+e.target.value); });

  // ======================================================= herramientas flotantes
  let openPop = null;
  const RENDER = { ranking: renderRanking, org: renderOrg, metrics: renderMetrics, settings: () => {} };
  document.querySelectorAll("button.tool[data-pop]").forEach((b) => b.addEventListener("click", () => {
    const name = b.dataset.pop;
    if (openPop === name) return closePops();
    closePops(); closeProfile();
    openPop = name; b.setAttribute("aria-expanded", "true");
    RENDER[name](); $(`#pop-${name}`).hidden = false;
  }));
  function closePops() {
    openPop = null;
    document.querySelectorAll(".pop").forEach((p) => { p.hidden = true; });
    document.querySelectorAll("button.tool").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  const hoverRow = (sel, idOf) => sel.on("mouseenter", (ev, x) => vis.hoverNode(idOf(x))).on("mouseleave", () => vis.hoverNode(null))
    .on("click", (ev, x) => { openProfile(idOf(x)); vis.focusNode(idOf(x)); });
  function list(p, rows, val, fmtv, sub) {
    const max = d3.max(rows, val) || 1;
    const li = p.append("ol").attr("class", "rows").selectAll("li").data(rows).join("li");
    hoverRow(li, (d) => d.id);
    li.append("span").attr("class", "pos").text((d, i) => i + 1);
    const w = li.append("span");
    w.append("div").attr("class", "nm").text((d) => d.name);
    if (sub) w.append("div").attr("class", "ds").text(sub);
    w.append("div").attr("class", "bar").append("span").style("width", (d) => `${(100 * val(d)) / max}%`);
    li.append("span").attr("class", "val").text((d) => fmtv(val(d)));
  }
  function pairList(p, rows) {
    const li = p.append("ol").attr("class", "rows").selectAll("li").data(rows).join("li")
      .on("mouseenter", (ev, e) => vis.hoverEdge(e)).on("mouseleave", () => vis.hoverEdge(null))
      .on("click", (ev, e) => openProfile(e.source.id));
    li.append("span").attr("class", "pos").text((e) => e.rank);
    const w = li.append("span");
    w.append("div").attr("class", "nm").text((e) => `${shortName(e.source.name)} y ${shortName(e.target.name)}`);
    w.append("div").attr("class", "ds").text((e) => [e.shared_groups.length ? "mismo grupo" : "", e.shared_terms.slice(0, 3).join(", ")].filter(Boolean).join(". "));
    li.append("span").attr("class", "val").text((e) => fmt2.format(e.score));
  }
  const roleOf = (d) => (d.leadership && d.leadership[0] ? `${d.leadership[0].role}, ${d.leadership[0].unit.replace(/^Grupo de Investigación en /, "")}` : d.department);

  // ======================================================= "Yo quiero colaborar con..." (LLM, en vivo)
  // Ventana al centro: dos personas con su foto y áreas; al pedir ideas se ve, paso a paso, lo que hace
  // el sistema (perfiles, temas en común, conexiones en la red) y el texto del LLM llegando en tiempo real.
  const colab = { a: null, b: null, interests: new Set(), estado: null, es: null };
  fetch("/api/colabora/estado").then((r) => r.json()).then((e) => { colab.estado = e; }).catch(() => {});
  const findPerson = (q) => {
    q = (q || "").trim().toLowerCase();
    return q ? N.find((x) => x.name.toLowerCase() === q) || N.find((x) => x.name.toLowerCase().includes(q)) : null;
  };
  const avatar = (sel, d, size) => {
    const w = sel.append("span").attr("class", "cbm-av").style("width", `${size}px`).style("height", `${size}px`);
    if (!d) { w.classed("empty", true).text("?"); return w; }
    const src = d.photo || (d.photo_local ? `/photo/${d.id}` : d.image_url);
    if (src) w.append("img").attr("src", src).attr("alt", "").on("error", function () { d3.select(this).remove(); w.text(UtecVis.initials(d.name)); });
    else w.text(UtecVis.initials(d.name));
    return w;
  };
  const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function openColabora(a, b) {
    closePops(); closeProfile();
    if (a != null && a !== colab.a) { colab.a = a; colab.interests.clear(); }
    if (b != null) colab.b = b;
    if (colab.a == null && vis.state.selected) colab.a = vis.state.selected.id;
    $("#cbm").hidden = false;
    document.body.classList.add("cbm-open");
    renderColabora();
  }
  function closeColabora() {
    if (colab.es) { colab.es.close(); colab.es = null; }
    $("#cbm").hidden = true;
    document.body.classList.remove("cbm-open");
  }
  $("#open-colabora").addEventListener("click", () => openColabora());
  d3.select("#cbm").on("click", (ev) => { if (ev.target.id === "cbm") closeColabora(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("#cbm").hidden) closeColabora(); });

  function renderColabora() {
    if (colab.es) { colab.es.close(); colab.es = null; }
    const card = d3.select("#cbm .cbm-card").html("");
    card.append("button").attr("class", "cbm-x").attr("aria-label", "Cerrar").text("×").on("click", closeColabora);
    const e = colab.estado;
    const head = card.append("header").attr("class", "cbm-head");
    head.append("h2").text("Ideas para colaborar");
    head.append("p").text("Elige a dos personas y te proponemos temas para trabajar juntos, a partir de sus áreas y publicaciones.");

    // ---- las dos personas y el puente entre ellas
    const pair = card.append("div").attr("class", "cbm-pair");
    const side = (key, label) => {
      const d = colab[key] != null ? byId.get(colab[key]) : null;
      const box = pair.append("div").attr("class", `cbm-person ${key}`);
      avatar(box, d, 84);
      box.append("label").attr("class", "cbm-l").text(label);
      box.append("input").attr("list", "people").attr("placeholder", "Escribe un nombre").property("value", d ? d.name : "")
        .on("change", function () {
          const x = findPerson(this.value);
          if (x) { colab[key] = x.id; if (key === "a") colab.interests.clear(); renderColabora(); }
        });
      if (!d) return;
      box.append("div").attr("class", "cbm-dept").text(d.department);
      const tags = box.append("div").attr("class", "cb-tags");
      tags.selectAll("button").data(d.areas.slice(0, 8)).join("button")
        .attr("class", (t) => `cb-tag${colab.interests.has(t) ? " on" : ""}`).text((t) => t).attr("title", "Marcar como tema de interés")
        .on("click", (ev, t) => { colab.interests.has(t) ? colab.interests.delete(t) : colab.interests.add(t); renderColabora(); });
      if (!d.areas.length) tags.append("span").attr("class", "cb-empty").text("Sin áreas registradas en CRIS.");
    };
    side("a", "Yo soy");
    const bridge = pair.append("div").attr("class", "cbm-bridge");
    bridge.append("svg").attr("viewBox", "0 0 200 20").attr("preserveAspectRatio", "none")
      .append("line").attr("x1", 0).attr("x2", 200).attr("y1", 10).attr("y2", 10);
    const A = colab.a != null ? byId.get(colab.a) : null, B = colab.b != null ? byId.get(colab.b) : null;
    const bInfo = bridge.append("div").attr("class", "cbm-binfo");
    if (A && B) {
      const sameG = A.groups.filter((g) => B.groups.includes(g));
      const rec = A.recommendations.find((r) => r.id === B.id);
      bInfo.append("div").attr("class", "cbm-bt").text(nbrsOf(A.id).has(B.id) ? "Ya publicaron juntos" : "Aún no publican juntos");
      if (sameG.length) bInfo.append("div").attr("class", "cbm-bg").text((sameG[0].match(/\(([^)]+)\)/) || [])[1] || "Mismo grupo");
      if (rec) bInfo.append("div").attr("class", "cbm-bs").text(`Afinidad ${fmt2.format(rec.score)}`);
      bInfo.append("div").attr("class", "cbm-shared");
      bInfo.append("div").attr("class", "cbm-common");
    } else bInfo.append("div").attr("class", "cbm-bt").text("¿Con quién?");
    side("b", "Quiero colaborar con");

    if (A && A.recommendations.length) {
      const q = card.append("div").attr("class", "cbm-quick");
      q.append("span").text("Afines a ti:");
      const bt = q.selectAll("button").data(A.recommendations).join("button").classed("on", (r) => r.id === colab.b)
        .on("click", (ev, r) => { colab.b = r.id; renderColabora(); });
      bt.each(function (r) { avatar(d3.select(this), byId.get(r.id), 22); });
      bt.append("span").text((r) => shortName(byId.get(r.id).name));
    }
    const ok = A && B && A.id !== B.id;
    const go = card.append("button").attr("class", "cb-go").property("disabled", !ok)
      .text(colab.interests.size ? `Sugerir temas (enfocado en ${colab.interests.size} interés${colab.interests.size > 1 ? "es" : ""})` : "Sugerir temas");
    const live = card.append("div").attr("class", "cbm-live");
    go.on("click", () => run(false));

    // ---- ejecución en vivo
    function run(refresh) {
      live.html("").classed("on", true);
      card.classed("thinking", true);
      // baja hasta el panel en vivo para que se vea cómo avanza
      setTimeout(() => card.node().scrollTo({ top: live.node().offsetTop - 20, behavior: "smooth" }), 60);
      go.property("disabled", true);
      vis.setHighlight({ nodes: new Set([A.id, B.id]), ranked: [A.id, B.id] });
      const steps = live.append("ol").attr("class", "cbm-steps");
      const right = live.append("div").attr("class", "cbm-right");
      const think = right.append("div").attr("class", "cbm-think");
      think.append("div").attr("class", "cbm-think-h").text("Pensando en voz alta");
      const thinkBody = think.append("div").attr("class", "cbm-think-b");
      const summary = right.append("p").attr("class", "cb-sum");
      const ideas = right.append("ol").attr("class", "cbm-ideas");
      const stepEl = {};
      const step = (id, title) => {
        const li = steps.append("li").attr("class", "run");
        li.append("span").attr("class", "dot");
        const t = li.append("div");
        t.append("b").text(title);
        stepEl[id] = { li, d: t.append("div").attr("class", "det") };
        return stepEl[id];
      };
      const done = (id, html) => { const s = stepEl[id]; if (!s) return; s.li.attr("class", "ok"); s.d.html(html); };
      step("perfiles", "Leyendo perfiles");

      let buf = "", nIdea = 0;
      const typing = thinkBody.append("p").attr("class", "typing");
      function feed(text) {
        buf += text;
        const parts = buf.split("\n");
        buf = parts.pop();
        parts.forEach(line);
        typing.text(buf.replace(/^\s*(ANALISIS|RESUMEN|TEMA|PASO)\s*:\s*/i, "").replace(/\s*\|\|\s*/g, ". "));
      }
      function addIdea(p) {
        const li = ideas.append("li").attr("class", "idea");
        li.append("span").attr("class", "n").text(++nIdea);
        const w = li.append("div");
        w.append("b").text(p[0]);
        w.append("p").text(p[1] || "");
        const ap = w.append("div").attr("class", "ap");
        [[A, p[2]], [B, p[3]]].forEach(([d, t]) => {
          if (!t) return;
          const r = ap.append("div").attr("class", "apr");
          avatar(r, d, 20);
          r.append("span").html(`<b>${esc(shortName(d.name))}</b> ${esc(t.replace(/^[^:]+:\s*/, ""))}`);
        });
        if (p[4]) w.append("div").attr("class", "ev pend").text(`Basado en: ${p[4]}`);
      }
      function line(raw) {
        const m = raw.trim().replace(/^[-*#\s]+/, "").replace(/\*\*/g, "").match(/^(ANALISIS|ANÁLISIS|RESUMEN|TEMA|PASO)\s*:\s*(.*)$/i);
        if (!m) return;
        const tag = m[1].toUpperCase().replace("Á", "A"), rest = m[2];
        if (tag === "ANALISIS") thinkBody.insert("p", ".typing").attr("class", "an").text(rest);
        if (tag === "RESUMEN") summary.text(rest);
        if (tag === "TEMA") addIdea(rest.split("||").map((x) => x.trim()));
        if (tag === "PASO") right.append("p").attr("class", "cb-step").html(`<b>Primer paso:</b> ${esc(rest)}`);
      }

      const url = `/api/colabora/stream?a=${A.id}&b=${B.id}&i=${encodeURIComponent([...colab.interests].join("|"))}${refresh ? "&refresh=1" : ""}`;
      const es = new EventSource(url);
      colab.es = es;
      es.onmessage = (msg) => {
        const ev = JSON.parse(msg.data);
        if (ev.type === "step" && ev.id === "perfiles") {
          done("perfiles", `${ev.a_areas} y ${ev.b_areas} áreas de investigación, ${ev.a_titles} y ${ev.b_titles} títulos de publicaciones`);
          step("comun", "Buscando temas en común");
        }
        if (ev.type === "step" && ev.id === "comun") {
          done("comun", ev.shared_terms.length ? `Comparten: ${ev.shared_terms.map((t) => `<span class="mini">${esc(t)}</span>`).join(" ")}` : "No comparten términos: se buscan áreas complementarias");
          const sh = d3.select(".cbm-shared").html("");
          sh.selectAll("span").data(ev.shared_terms.slice(0, 4)).join("span").attr("class", "mini pop").style("animation-delay", (t, i) => `${i * 120}ms`).text((t) => t);
          step("red", "Revisando la red de colaboración");
        }
        if (ev.type === "step" && ev.id === "red") {
          done("red", ev.already_coauthors ? "Ya publicaron juntos" : ev.common_ids.length ? `${ev.common_ids.length} colega(s) en común que pueden presentarlos` : "Sin colegas en común directos");
          const cm = d3.select(".cbm-common").html("");
          ev.common_ids.forEach((id) => avatar(cm, byId.get(id), 22).attr("title", byId.get(id).name).classed("pop", true));
          vis.setHighlight({ nodes: new Set([A.id, B.id, ...ev.common_ids]), ranked: [A.id, B.id], labels: ev.common_ids,
            co: (e) => [A.id, B.id].includes(e.source.id) || [A.id, B.id].includes(e.target.id) });
        }
        if (ev.type === "llm") {
          step("llm", "Proponiendo temas");
          // el detalle técnico (modelo, proveedor, motivo) queda solo para quien lo busque: tooltip y consola
          stepEl.llm.li.attr("title", ev.source === "llm" ? `${ev.provider || "claude"}: ${ev.model}` : ev.source);
          if (ev.note) console.info("UtecVis:", ev.note);

        }
        if (ev.type === "delta") feed(ev.text);
        if (ev.type === "retry") {
          done("llm", "Faltaban detalles");
          if (ev.note) console.info("UtecVis:", ev.note);
          step("retry", "Completando la propuesta");
        }
        if (ev.type === "done") {
          es.close(); colab.es = null;
          feed("\n"); typing.remove();
          // el resultado final del servidor manda: si algo no llegó completo en vivo, se dibuja aquí
          if (ev.result.resumen) summary.text(ev.result.resumen);
          const shown = ideas.selectAll("li.idea > div > b").nodes().map((n) => n.textContent);
          const same = shown.length === ev.result.temas.length && ev.result.temas.every((t, i) => shown[i] === t.titulo)
            && ideas.selectAll("li.idea").nodes().every((n) => n.querySelectorAll(".apr").length >= 2);
          if (!same) {
            ideas.html(""); nIdea = 0;
            ev.result.temas.forEach((t) => addIdea([t.titulo, t.por_que, t.aporte_a, t.aporte_b, t.evidencia]));
            right.selectAll(".cb-step").remove();
            if (ev.result.primer_paso) right.append("p").attr("class", "cb-step").html(`<b>Primer paso:</b> ${esc(ev.result.primer_paso)}`);
          }
          if (stepEl.retry) done("retry", "Listo");
          if (!stepEl.retry) done("llm", ev.source === "cache" ? "Propuesta guardada de una consulta anterior" : "Listo");
          if (ev.note) console.info("UtecVis:", ev.note);
          step("fin", "Ideas listas"); done("fin", `${ev.result.temas.length} temas, cada uno con su evidencia verificada contra CRIS`);
          ideas.selectAll("li.idea").each(function (_, i) {
            const t = ev.result.temas[i]; if (!t) return;
            d3.select(this).select(".ev").attr("class", `ev ${t.verificada ? "ok" : "no"}`)
              .text(`${t.verificada ? "✓ Verificado:" : "Sin verificar:"} ${t.evidencia}`);
          });
          card.classed("thinking", false);
          go.property("disabled", false);
          const act = right.append("div").attr("class", "share");
          act.append("button").text("Ver en la red").on("click", () => {
            closeColabora();
            if (!vis.showPath(A.id, B.id)) vis.setHighlight({ nodes: new Set([A.id, B.id]), ranked: [A.id, B.id] });
          });
          if (colab.estado && colab.estado.llm) act.append("button").text("Otra propuesta").on("click", () => run(true));
          act.append("button").text("Copiar").on("click", function () {
            const r = ev.result;
            navigator.clipboard && navigator.clipboard.writeText(`${A.name} y ${B.name}\n${r.resumen}\n`
              + r.temas.map((t, i) => `${i + 1}. ${t.titulo}: ${t.por_que}`).join("\n") + (r.primer_paso ? `\nPrimer paso: ${r.primer_paso}` : ""));
            this.textContent = "Copiado";
          });
          right.append("p").attr("class", "cb-src").text(ev.source === "rules" ? "Ideas armadas a partir de las áreas de ambos." : "Ideas generadas con IA a partir de datos de CRIS. Revísalas antes de usarlas.");
        }
      };
      es.onerror = () => {
        es.close(); colab.es = null; card.classed("thinking", false); go.property("disabled", false);
        if (!ideas.selectAll("li").size()) live.append("p").attr("class", "cb-wait").text("Se cortó la conexión con el servidor. Intenta de nuevo.");
      };
    }
  }
  const nbrsOf = (id) => vis.nbrs.get(id) || new Set();

  function renderRanking() {
    const p = d3.select("#pop-ranking").html("");
    const id = STEPS[current].id;
    if (id === "P") {
      p.append("h2").text("Más publicaciones");
      p.append("p").attr("class", "sub").text("Muestra de producción registrada en CRIS.");
      list(p, by("publications").slice(0, 8), (d) => d.publications, fmtInt.format, (d) => d.department);
    } else if (id === "T1") {
      p.append("h2").text("Colaboradores más prolíficos");
      p.append("p").attr("class", "sub").text("Grado = coautores UTEC. Entre paréntesis, grado ponderado (publicaciones compartidas).");
      list(p, by("coauthors").filter((d) => d.coauthors > 0).slice(0, 8), (d) => d.coauthors, String, (d) => `${d.department}, ${d.coauthorships} publicaciones compartidas`);
      p.append("h4").text("Alta producción, sin coautores UTEC");
      list(p, by("publications").filter((d) => d.coauthors === 0).slice(0, 5), (d) => d.publications, fmtInt.format, (d) => d.department);
    } else if (id === "T2") {
      p.append("h2").text("Puentes");
      p.append("p").attr("class", "sub").text("Intermediación sobre coautoría + grupos. Debajo de cada nombre, su cargo según CRIS.");
      list(p, by("betweenness").filter((d) => d.betweenness > 0).slice(0, 8), (d) => d.betweenness, fmt.format, roleOf);
    } else if (id === "T3") {
      p.append("h2").text("Coautorías por departamento");
      p.append("p").attr("class", "sub").text("Internas: dentro del departamento. Externas: con otros departamentos.");
      const rows = meta.departments.slice().sort((a, b) => (b.coauthorships_internal + b.coauthorships_external) - (a.coauthorships_internal + a.coauthorships_external));
      const li = p.append("ol").attr("class", "rows").selectAll("li").data(rows).join("li").on("click", (ev, d) => setDept(d.name));
      li.append("span").attr("class", "pos").text((d) => d.researchers);
      const w = li.append("span");
      w.append("div").attr("class", "nm").text((d) => d.name);
      w.append("div").attr("class", "ds").text((d) => `${d.coauthorships_internal} internas, ${d.coauthorships_external} con otros departamentos`);
      li.append("span").attr("class", "val").text((d) => d.coauthorships_internal + d.coauthorships_external);
    } else if (id === "T4") {
      p.append("h2").text("Colaboraciones probables");
      p.append("p").attr("class", "sub").text("Pares sin coautoría, ordenados por puntaje de predicción.");
      pairList(p, vis.affinity.slice(0, 10));
    } else {
      p.append("h2").text("Proyección externa");
      list(p, by("ext_institutions").filter((d) => d.ext_institutions > 0).slice(0, 8), (d) => d.ext_institutions, String,
        (d) => (d.external.top_partners || []).slice(0, 2).join(", "));
    }
  }

  function renderOrg() {
    const p = d3.select("#pop-org").html("");
    const units = meta.organisation.units || [];
    p.append("h2").text("Estructura organizativa");
    p.append("p").attr("class", "sub").text("Facultades y departamentos de cris.utec.edu.pe. Clic en un departamento para filtrar; en un grupo, para ver a sus miembros.");
    const count = (dep) => N.filter((d) => d.department_full === dep || d.department === dep.replace(/^Departamento de /, "")).length;
    // nombre completo de CRIS -> nombre corto usado en la red (se toma de los propios investigadores,
    // porque CRIS y la red no siempre escriben igual el departamento)
    const fullToShort = new Map(N.map((d) => [d.department_full, d.department]));
    const deptShort = (full) => fullToShort.get(full)
      || (meta.departments.find((d) => full.endsWith(d.name) || d.name === full.replace(/^Departamento de /, "")) || {}).name || null;
    const tree = p.append("ul").attr("class", "tree");
    const parents = ["Facultad de Ingeniería", "Facultad de Computación", "Facultad de Negocios", "Departamentos Académicos Transversales"];
    parents.forEach((f) => {
      const kids = units.filter((u) => u.parent === f && u.type === "Departamento");
      if (!kids.length) return;
      const li = tree.append("li");
      li.append("div").attr("class", "fac-h").html(`${f} <small>${kids.length} dpto${kids.length > 1 ? "s" : ""}.</small>`);
      li.append("ul").selectAll("li").data(kids).join("li")
        .classed("on", (u) => !!vis.state.dept && deptShort(u.name) === vis.state.dept)
        .classed("empty", (u) => !deptShort(u.name))
        .on("click", (ev, u) => {
          const k = deptShort(u.name);
          if (!k) return;                                      // departamento sin investigadores en la red
          setDept(vis.state.dept === k ? null : k);            // segundo clic: quita el filtro
          renderOrg();
        })
        .html((u) => `<span>${u.name.replace(/^Departamento de /, "")}</span><span class="c">${count(u.name)} inv.</span>`);
    });
    const groups = units.filter((u) => u.type === "Grupo de Investigación" || (u.type === "Centro" && u.name !== "Grupos de Investigación"));
    const li = tree.append("li");
    li.append("div").attr("class", "fac-h").html(`Investigación <small>centros y grupos</small>`);
    li.append("ul").selectAll("li").data(groups).join("li")
      .on("click", (ev, u) => {
        const ids = new Set(N.filter((d) => d.groups.includes(u.name)).map((d) => d.id));
        vis.setDept(null);
        vis.setHighlight({ nodes: ids, co: (e) => ids.has(e.source.id) || ids.has(e.target.id), labels: [...ids] });
      })
      .html((u) => {
        const n = N.filter((d) => d.groups.includes(u.name)).length;
        const lead = (u.leaders || [])[0];
        const short = (u.name.match(/\(([^)]+)\)/) || [])[1] || u.name.replace(/^(Grupo de [Ii]nvestigación en |Centro de Investigación (en |y )?)/, "");
        return `<span>${short}${lead ? `<br><span class="c">${lead.role}: ${lead.name}</span>` : ""}</span><span class="c">${n} inv.</span>`;
      });
    p.append("p").attr("class", "src").text(`Fuente: ${meta.organisation.source}. Recolectado: ${meta.organisation.collected}.`);
  }

  function setDept(name) {
    vis.setHighlight(null);
    vis.setDept(name);
  }

  function renderMetrics() {
    const p = d3.select("#pop-metrics").html("");
    const C = meta.network_stats.coauthor, X = meta.network_stats.extended;
    p.append("h2").text("Métricas de la red");
    p.append("p").attr("class", "sub").text("NetworkX. Coautoría: publicaciones compartidas. Ampliada: coautoría + grupos de investigación.");
    const rows = [["Nodos", C.nodes, X.nodes, fmtInt], ["Aristas", C.edges, X.edges, fmtInt], ["Densidad", C.density, X.density, fmt],
      ["Componentes conexas", C.components, X.components, fmtInt], ["Aislados", C.isolates, X.isolates, fmtInt],
      ["Componente mayor", C.largest_component, X.largest_component, fmtInt], ["Diámetro (comp. mayor)", C.diameter_largest, X.diameter_largest, fmtInt],
      ["Camino medio (comp. mayor)", C.avg_path_largest, X.avg_path_largest, fmt2], ["Clustering medio", C.avg_clustering, X.avg_clustering, fmt2]];
    const t = p.append("table").attr("class", "mtable");
    t.append("tr").html("<th></th><th>Coautoría</th><th>Ampliada</th>");
    rows.forEach(([l, a, b, f]) => t.append("tr").html(`<td>${l}</td><td>${f.format(a)}</td><td>${f.format(b)}</td>`));
    p.append("h4").text("Por investigador");
    p.append("p").attr("class", "sub").style("margin", 0).text("Grado, grado ponderado, intermediación (Brandes, distancia 1/peso), cercanía, vector propio, PageRank y coeficiente de participación. Ver la ficha.");
    const v = meta.affinity_validation;
    if (v) { p.append("h4").text("Validación de la predicción (T4)"); p.append("p").attr("class", "sub").style("margin", 0).text(`AUC ${fmt2.format(v.auc_affinity)} contra las ${v.positives} coautorías reales (solo texto: ${fmt2.format(v.auc_topic_only)}).`); }
  }

  // ======================================================= ficha compartible
  function openProfile(id) {
    closePops();
    pathAnchor = id;
    const d = byId.get(id);
    vis.setHighlight(null);
    vis.select(id);
    history.replaceState(null, "", `#p=${id}`);
    updateReportLink();
    const ins = INS.people[String(id)] || { tags: [], lines: [] };
    const p = d3.select("#profile").html("");
    const top = p.append("div").attr("class", "top");
    top.append("span").attr("class", "sub").style("margin", 0).text("Seleccionado");
    top.append("button").attr("class", "close").attr("aria-label", "Quitar selección").text("×").on("click", () => closeProfile());
    const head = p.append("div").attr("class", "who-head");
    const ph = () => head.insert("div", ":first-child").attr("class", "avatar").text(UtecVis.initials(d.name));
    if (d.photo || d.image_url || d.photo_local) {
      let tried = false;
      head.append("img").attr("class", "avatar").attr("alt", d.name).attr("referrerpolicy", "no-referrer")
        .attr("src", d.photo || (d.photo_local ? `/photo/${d.id}` : d.image_url))
        .on("error", function () { if (!tried && !d.photo) { tried = true; this.src = `/photo/${d.id}`; } else { d3.select(this).remove(); ph(); } });
    } else ph();
    const h = head.append("div");
    h.append("h3").text(d.name);
    h.append("div").attr("class", "dept").text(d.department + (d.leadership.length ? `. ${d.leadership[0].role}` : ""));
    p.append("div").attr("class", "tags").selectAll("span").data(ins.tags).join("span").attr("class", "tag").text((t) => t);
    p.append("div").attr("class", "statline").html(
      `<span><b>${fmtInt.format(d.publications)}</b>publicaciones</span><span><b>${d.coauthors}</b>coautores UTEC</span><span><b>${d.betweenness > 0 ? "n.º " + d.rank.betweenness : "–"}</b>como puente</span>`);

    if (d.recommendations.length) {
      p.append("h4").text("Podría escribirle a");
      const li = p.append("ul").attr("class", "recs").selectAll("li").data(d.recommendations).join("li");
      hoverRow(li, (r) => r.id);
      li.append("div").html((r) => `<b>${byId.get(r.id).name}</b>`);
      li.append("div").attr("class", "why").text((r) => [r.same_group ? "mismo grupo" : byId.get(r.id).department, r.shared_terms.join(", ")].filter(Boolean).join(". "));
      li.append("button").attr("class", "cb-ideas").text("Ideas para colaborar")
        .on("click", (ev, r) => { ev.stopPropagation(); openColabora(d.id, r.id); });
    }

    p.append("h4").text("¿Cómo llegar a alguien?");
    const f = p.append("div").attr("class", "find");
    const inp = f.append("input").attr("list", "people").attr("placeholder", "Nombre de un colega").attr("aria-label", "Camino hacia");
    p.append("div").attr("class", "path").attr("id", "path-out").text("Shift + clic en otra foto también funciona.");
    inp.on("change", function () {
      const q = this.value.trim().toLowerCase();
      const t = N.find((x) => x.name.toLowerCase() === q) || N.find((x) => x.name.toLowerCase().includes(q));
      if (t) pathTo(d.id, t.id);
    });

    const co = vis.coauthor.filter((e) => e.source === d || e.target === d).sort((a, b) => b.weight - a.weight);
    const det = p.append("details").attr("class", "more");
    det.append("summary").text(`Coautorías UTEC (${co.length}) y más métricas`);
    const li2 = det.append("ol").attr("class", "rows").selectAll("li").data(co).join("li").style("grid-template-columns", "1fr auto");
    hoverRow(li2, (e) => (e.source === d ? e.target.id : e.source.id));
    const w = li2.append("span");
    w.append("div").attr("class", "nm").text((e) => (e.source === d ? e.target : e.source).name);
    w.append("ul").attr("class", "pubs").selectAll("li").data((e) => e.publications.slice(0, 1)).join("li")
      .append("a").attr("href", (x) => x.url).attr("target", "_blank").attr("rel", "noopener noreferrer").text((x) => x.title).on("click", (ev) => ev.stopPropagation());
    li2.append("span").attr("class", "val").text((e) => e.weight);
    det.append("p").attr("class", "sub").style("margin", "8px 0 0")
      .text(`Intermediación ${fmt.format(d.betweenness)}, cercanía ${fmt.format(d.closeness)}, vector propio ${fmt.format(d.eigenvector)}, PageRank ${fmt.format(d.pagerank)}, participación ${fmt2.format(d.participation)}.`);

    const share = p.append("div").attr("class", "share");
    share.append("a").attr("href", `/investigador/${d.id}`).attr("target", "_blank").text("Su reporte");
    share.append("button").text("Copiar enlace").on("click", function () {
      navigator.clipboard && navigator.clipboard.writeText(`${location.origin}/#p=${d.id}`);
      this.textContent = "Copiado";
    });
    $("#profile").hidden = false;
  }

  function pathTo(a, b) {
    if ($("#profile").hidden || pathAnchor !== a) openProfile(a);
    pathAnchor = a;
    const res = vis.showPath(a, b);
    const out = d3.select("#path-out");
    if (!res) { out.text(`No hay camino entre ambos en la red (coautoría + grupos).`); return; }
    const kinds = res.edges.slice().reverse().map((e) => (e.type === "coauthor" ? "coautoría" : "mismo grupo"));
    out.html(res.ids.map((id, i) => `<b>${shortName(byId.get(id).name)}</b>${i < kinds.length ? `<span class="arrow" title="${kinds[i]}">→</span>` : ""}`).join("")
      + `<div class="sub" style="margin-top:4px">${res.ids.length - 2 > 0 ? `${res.ids.length - 2} intermediario(s) que pueden presentarlos.` : "Ya están conectados directamente."}</div>`);
  }

  function closeProfile() {
    pathAnchor = null;
    $("#profile").hidden = true;
    vis.select(null);
    vis.setHighlight(null);
    if (typeof current === "number" && STEPS[current]) STEPS[current].apply();
    if (typeof updateReportLink === "function") updateReportLink();
    if (location.hash) history.replaceState(null, "", location.pathname);
  }

  // ======================================================= búsqueda, teclado y enlace directo
  const dl = $("#people");
  N.slice().sort((a, b) => a.name.localeCompare(b.name, "es")).forEach((d) => { const o = document.createElement("option"); o.value = d.name; dl.appendChild(o); });
  $("#search").addEventListener("change", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const d = N.find((x) => x.name.toLowerCase() === q) || N.find((x) => x.name.toLowerCase().includes(q));
    if (d) { openProfile(d.id); vis.focusNode(d.id); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target.matches("input, select")) { if (ev.key === "Escape") ev.target.blur(); return; }
    if (ev.key === "ArrowRight") goTo(current + 1);
    if (ev.key === "ArrowLeft") goTo(current - 1);
    if (ev.key === "Escape") { closePops(); closeProfile(); vis.resetZoom(); }
  });

  const m = location.hash.match(/p=(\d+)/);  // enlace compartido: se lee antes de que goTo limpie el hash
  let savedGroup = "none", savedDept = "";
  try { savedGroup = localStorage.getItem("utecvis-group") || "none"; savedDept = localStorage.getItem("utecvis-dept") || ""; } catch (e) { /* sin almacenamiento */ }
  vis.setGroupBy(savedGroup);
  if (savedDept && INS.departments[savedDept]) setMyDept(savedDept); else goTo(0);
  if (m && byId.has(+m[1])) setTimeout(() => { openProfile(+m[1]); vis.focusNode(+m[1]); }, 1200);
})();
