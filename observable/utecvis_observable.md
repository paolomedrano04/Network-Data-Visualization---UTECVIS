# UtecVis en Observable (prototipo)

Versión de prototipado en Observable, con la misma lógica de la app Flask (D3 v7).
Sirve para iterar codificaciones en clase antes de pasarlas a `static/js/utecvis.js`.

**Cómo usarlo**

1. Crear un notebook nuevo en observablehq.com.
2. Adjuntar como *File attachments* los archivos `data/nodes.json`, `data/edges.json` y `data/affinity.json` del ZIP.
3. Pegar cada bloque de abajo en una celda distinta, en este orden.

---

```js
nodes = FileAttachment("nodes.json").json()
```

```js
edges = FileAttachment("edges.json").json()
```

```js
affinity = FileAttachment("affinity.json").json()
```

```js
viewof size = Inputs.select(
  new Map([["Publicaciones", "publications"], ["Coautores", "coauthors"],
           ["Coautorías", "coauthorships"], ["Intermediación", "betweenness"]]),
  {label: "Tamaño del nodo"}
)
```

```js
viewof showAffinity = Inputs.toggle({label: "Mostrar afinidades (T4)", value: false})
```

```js
deptColor = {
  const c = {
    "Computación": "#6c8cff", "Ciencias": "#f5b841", "Mecánica y Energía": "#a37ef2",
    "Bioingeniería y Química": "#4cc38a", "Electrónica y Mecatrónica": "#ff7a45",
    "Humanidades y Artes": "#f0679e", "Industrial y Gestión": "#c9e265", "Civil y Ambiental": "#2fa39a"
  };
  return d => c[d] ?? "#8a9199";
}
```

```js
chart = {
  const width = 960, height = 640;
  const N = nodes.map(d => ({...d}));
  const byId = new Map(N.map(d => [d.id, d]));
  const CO = edges.filter(e => e.type === "coauthor")
    .map(e => ({...e, source: byId.get(e.source), target: byId.get(e.target)}));
  const AF = affinity.map(e => ({...e, source: byId.get(e.source), target: byId.get(e.target)}));

  // Centro de cada departamento en una circunferencia (overview first)
  const depts = [...new Set(N.map(d => d.department))];
  const angle = d3.scalePoint().domain(depts).range([0, 2 * Math.PI]).padding(0.5);
  const center = d => [width / 2 + 230 * Math.cos(angle(d.department)), height / 2 + 210 * Math.sin(angle(d.department))];

  const r = d3.scaleSqrt().domain([0, d3.max(N, d => d[size]) || 1]).range([5, 26]);
  const halo = d3.scaleSqrt().domain([0, d3.max(N, d => d.betweenness)]).range([0, 6]);

  const svg = d3.create("svg").attr("viewBox", [0, 0, width, height]).style("background", "#0c0e10");
  const g = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.5, 5]).on("zoom", e => g.attr("transform", e.transform)));

  const aff = g.append("g").selectAll("line").data(showAffinity ? AF : []).join("line")
    .attr("stroke", "#f3f6f7").attr("stroke-dasharray", "6 4").attr("opacity", 0.6);
  const co = g.append("g").selectAll("line").data(CO).join("line")
    .attr("stroke", e => e.cross_department ? "#1fb1ec" : "#8b949c")
    .attr("stroke-width", e => 1.5 + e.weight);

  const defs = svg.append("defs");
  defs.selectAll("clipPath").data(N).join("clipPath").attr("id", d => `oc${d.id}`)
    .append("circle").attr("r", d => r(d[size]));

  const node = g.append("g").selectAll("g").data(N).join("g");
  node.append("circle").attr("r", d => r(d[size]) + 4 + halo(d.betweenness) / 2)
    .attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", d => halo(d.betweenness));
  node.append("circle").attr("r", d => r(d[size])).attr("fill", "#2a2f34");
  node.filter(d => d.image_url).append("image").attr("href", d => d.image_url)
    .attr("x", d => -r(d[size])).attr("y", d => -r(d[size]))
    .attr("width", d => 2 * r(d[size])).attr("height", d => 2 * r(d[size]))
    .attr("clip-path", d => `url(#oc${d.id})`).attr("preserveAspectRatio", "xMidYMid slice");
  node.append("circle").attr("r", d => r(d[size])).attr("fill", "none")
    .attr("stroke", d => deptColor(d.department)).attr("stroke-width", 3);
  node.append("title").text(d => `${d.name}\n${d.department}\n${d.publications} publicaciones, ${d.coauthors} coautores`);

  // Detalles bajo demanda: resaltar vecinos al pasar el cursor
  node.on("mouseenter", (e, d) => {
    const nb = new Set(CO.filter(x => x.source === d || x.target === d).flatMap(x => [x.source, x.target]));
    node.attr("opacity", n => n === d || nb.has(n) ? 1 : 0.15);
    co.attr("opacity", x => x.source === d || x.target === d ? 1 : 0.1);
  }).on("mouseleave", () => { node.attr("opacity", 1); co.attr("opacity", 1); });

  const sim = d3.forceSimulation(N)
    .force("link", d3.forceLink(CO).strength(e => e.cross_department ? 0.02 : 0.15))
    .force("x", d3.forceX(d => center(d)[0]).strength(0.15))
    .force("y", d3.forceY(d => center(d)[1]).strength(0.15))
    .force("collide", d3.forceCollide(d => r(d[size]) + 4 + halo(d.betweenness)))
    .on("tick", () => {
      co.attr("x1", e => e.source.x).attr("y1", e => e.source.y).attr("x2", e => e.target.x).attr("y2", e => e.target.y);
      aff.attr("x1", e => e.source.x).attr("y1", e => e.source.y).attr("x2", e => e.target.x).attr("y2", e => e.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
  invalidation.then(() => sim.stop());
  return svg.node();
}
```
