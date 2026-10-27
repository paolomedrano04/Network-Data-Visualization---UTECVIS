"""
export_static.py
Genera la carpeta docs/ con UtecVis como sitio estático, listo para GitHub Pages.

    python export_static.py

GitHub Pages solo sirve archivos (no ejecuta Python), así que:
  - los datos de /api/graph se guardan en docs/data/graph.json (con las fotos incrustadas);
  - los reportes se guardan como páginas: reporte.html, reporte/<departamento>.html, investigador/<id>.html;
  - "Colaborar" usa propuestas ya generadas (docs/data/colabora.json) para las parejas sugeridas
    de cada investigador. Si antes de exportar generaste ideas con el LLM en tu PC, se publican esas;
    para el resto se usan reglas, calculadas en el navegador. La clave de API NUNCA se publica.
"""
import json
import os
import re
import shutil
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "docs"


def slug(t):
    t = "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


def fix(html, depth):
    """Convierte las rutas del servidor Flask en rutas relativas de archivos."""
    p = "../" * depth
    html = html.replace('href="/static/', f'href="{p}static/').replace('src="/static/', f'src="{p}static/')
    html = html.replace('url("/static/', f'url("{p}static/')
    html = re.sub(r'href="/#p=(\d+)"', lambda m: f'href="{p}index.html#p={m.group(1)}"', html)
    html = html.replace('href="/"', f'href="{p}index.html"').replace('href="/reporte"', f'href="{p}reporte.html"')
    html = re.sub(r'href="/investigador/(\d+)"', lambda m: f'href="{p}investigador/{m.group(1)}.html"', html)
    html = re.sub(r'href="/reporte\?d=([^"]+)"', lambda m: f'href="{p}reporte/{slug(m.group(1))}.html"', html)
    return html


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8")


def main():
    # la exportación nunca usa ni publica la clave: solo propuestas guardadas o reglas
    os.environ.pop("ANTHROPIC_API_KEY", None)
    import app as A
    import pipeline.colabora as C
    C._ollama_ok = lambda: False
    A.ensure_data()
    c = A.app.test_client()

    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "static", OUT / "static")
    (OUT / ".nojekyll").write_text("", "utf-8")   # GitHub Pages sirve los archivos tal cual

    # página principal
    html = fix(c.get("/").get_data(as_text=True), 0)
    html = html.replace('<script src="static/js/d3.min.js">', '<script>window.UTECVIS_STATIC = true;</script>\n<script src="static/js/d3.min.js">', 1)
    write(OUT / "index.html", html)

    # datos
    write(OUT / "data" / "graph.json", json.dumps(c.get("/api/graph").get_json(), ensure_ascii=False, separators=(",", ":")))
    for f in ("nodes.csv", "edges.csv", "nodes.json", "edges.json", "affinity.json", "meta.json"):
        if (ROOT / "data" / f).exists():
            shutil.copy(ROOT / "data" / f, OUT / "data" / f)

    # reportes
    write(OUT / "reporte.html", fix(c.get("/reporte").get_data(as_text=True), 0))
    ins = json.loads((ROOT / "data" / "insights.json").read_text("utf-8"))
    for d in ins["departments"]:
        r = c.get("/reporte", query_string={"d": d})
        if r.status_code == 200:
            write(OUT / "reporte" / f"{slug(d)}.html", fix(r.get_data(as_text=True), 1))
    nodes = json.loads((ROOT / "data" / "nodes.json").read_text("utf-8"))
    for n in nodes:
        write(OUT / "investigador" / f"{n['id']}.html", fix(c.get(f"/investigador/{n['id']}").get_data(as_text=True), 1))

    # Colaborar: propuestas para las parejas sugeridas (en ambos sentidos)
    sleep, C.time.sleep = C.time.sleep, (lambda s: None)
    pre, from_llm = {}, 0
    pairs = {(n["id"], r["id"]) for n in nodes for r in n.get("recommendations", [])}
    pairs |= {(b, a) for a, b in pairs}
    for a, b in sorted(pairs):
        evs, text = [], ""
        for ev in C.stream_events(a, b):
            if ev["type"] == "delta":
                text += ev["text"]
                continue
            if ev["type"] == "done":
                if text:
                    evs.append({"type": "text", "text": text})
                ev = {k: v for k, v in ev.items() if k != "context"}
                from_llm += ev["source"] != "rules"
            evs.append(ev)
        pre[f"{a}-{b}"] = evs
    C.time.sleep = sleep
    write(OUT / "data" / "colabora.json", json.dumps(pre, ensure_ascii=False, separators=(",", ":")))

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"Sitio estático en {OUT}  ({size:.1f} MB)")
    print(f"  {len(nodes)} fichas, {len(ins['departments'])} reportes de departamento, {len(pre)} propuestas de colaboración "
          f"({from_llm} generadas antes con el LLM, el resto con reglas)")
    print("Siguiente paso: subir el proyecto a GitHub y activar Pages en la carpeta /docs (ver README).")


if __name__ == "__main__":
    main()
