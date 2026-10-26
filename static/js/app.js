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
  const setLegend = (keys) => { $("#legend").innerHTML = keys.map(([s, t]) => `<li>${s}<span>${t}</span></li>`).join(""); };

  // ======================================================= pasos: panorama + tareas
  const lonelyIds = by("publications").slice(0, 5).filter((d) => d.coauthors === 0).map((d) => d.id);
  let myDept = "";
  let pathAnchor = null;                             // origen del camino (shift + clic)                                   // contexto elegido en "Soy de"
  const mine = (d) => !myDept || d.department === myDept;
  const touches = (e) => !myDept || e.source.department === myDept || e.target.department === myDept;
  const layoutFor = () => (myDept ? "radial" : "clusters");
  const VIEWS = {
    P: { tab: "Panorama", view: { size: "publications", layers: {} },
      legend: () => (myDept ? [L.radial, L.cross, L.same] : [L.faculty, L.territory, L.size("publicaciones"), L.cross]),
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
    T3: { view: { size: "publications", layers: { group: true } }, legend: () => [L.cross, L.same, L.groupdot, myDept ? L.radial : L.faculty],
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

  // ======================================================= ajustes
  function syncSettings() {
    document.querySelectorAll("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === vis.state.layout));
    document.querySelectorAll(".tg").forEach((b) => b.classList.toggle("on", !!vis.state.layers[b.dataset.layer]));
    $("#size-metric").value = vis.state.size in METRICS ? vis.state.size : "publications";
  }
  document.querySelectorAll("[data-layout]").forEach((b) => b.addEventListener("click", () => { vis.setLayout(b.dataset.layout); syncSettings(); }));
  document.querySelectorAll(".tg").forEach((b) => b.addEventListener("click", () => {
    vis.setLayers({ [b.dataset.layer]: !vis.state.layers[b.dataset.layer] }); syncSettings();
  }));
  $("#size-metric").addEventListener("change", (e) => vis.setSize(e.target.value));
  const resLabel = (v) => (v < 0.25 ? "baja" : v < 0.7 ? "media" : "alta");
  $("#resistance").addEventListener("input", (e) => { vis.setResistance(+e.target.value); $("#res-out").textContent = resLabel(+e.target.value); });

  // ======================================================= herramientas flotantes
  let openPop = null;
  const RENDER = { ranking: renderRanking, org: renderOrg, metrics: renderMetrics, settings: () => {} };
  document.querySelectorAll("button.tool").forEach((b) => b.addEventListener("click", () => {
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
    const deptShort = (full) => (meta.departments.find((d) => full.endsWith(d.name) || d.name === full.replace(/^Departamento de /, "")) || {}).name;
    const tree = p.append("ul").attr("class", "tree");
    const parents = ["Facultad de Ingeniería", "Facultad de Computación", "Facultad de Negocios", "Departamentos Académicos Transversales"];
    parents.forEach((f) => {
      const kids = units.filter((u) => u.parent === f && u.type === "Departamento");
      if (!kids.length) return;
      const li = tree.append("li");
      li.append("div").attr("class", "fac-h").html(`${f} <small>${kids.length} dpto${kids.length > 1 ? "s" : ""}.</small>`);
      li.append("ul").selectAll("li").data(kids).join("li")
        .classed("on", (u) => deptShort(u.name) === vis.state.dept)
        .on("click", (ev, u) => { setDept(deptShort(u.name)); renderOrg(); })
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
    if (d.image_url || d.photo_local) {
      let tried = false;
      head.append("img").attr("class", "avatar").attr("alt", d.name).attr("referrerpolicy", "no-referrer")
        .attr("src", d.photo_local ? `/photo/${d.id}` : d.image_url)
        .on("error", function () { if (!tried && !d.photo_local) { tried = true; this.src = `/photo/${d.id}`; } else { d3.select(this).remove(); ph(); } });
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
  goTo(0);
  if (m && byId.has(+m[1])) setTimeout(() => { openProfile(+m[1]); vis.focusNode(+m[1]); }, 1200);
})();
