"""
UtecVis: red de colaboración científica de UTEC (DS5343 Visualización de Datos, 2026-2).

    pip install -r requirements.txt
    python app.py        ->  http://127.0.0.1:5000
"""
import json
from pathlib import Path

import requests
from flask import Flask, abort, jsonify, render_template, request, send_from_directory

from pipeline.build_network import build

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
PHOTOS = ROOT / "static" / "photos"
FILES = ("nodes.json", "edges.json", "affinity.json", "meta.json", "insights.json")

app = Flask(__name__)
app.json.ensure_ascii = False


def ensure_data():
    if not all((DATA / f).exists() for f in FILES):
        build()


def read(name):
    return json.loads((DATA / name).read_text("utf-8"))


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/graph")
def graph():
    ensure_data()
    out = {k: read(f"{k}.json") for k in ("nodes", "edges", "affinity", "meta", "insights")}
    for n in out["nodes"]:  # fotos ya guardadas localmente (se sirven sin internet)
        n["photo_local"] = (PHOTOS / f"{n['id']}.jpg").exists()
    return jsonify(out)


@app.get("/reporte")
def report():
    """Reporte imprimible. Se personaliza según quien consulta: ?d=<departamento> o ?p=<id de investigador>."""
    ensure_data()
    if request.args.get("p", "").isdigit():
        return person(int(request.args["p"]))
    nodes = {n["id"]: n for n in read("nodes.json")}
    ins, meta, aff = read("insights.json"), read("meta.json"), read("affinity.json")
    d = request.args.get("d")
    if d and d in ins["departments"]:
        mem = sorted([n for n in nodes.values() if n["department"] == d], key=lambda n: (-n["coauthors"], -n["publications"]))
        ids = {n["id"] for n in mem}
        prof = meta["department_profile"][d]
        closest = sorted(prof["similarity"].items(), key=lambda kv: -kv[1])[:5]
        pairs = [a for a in aff if a["source"] in ids or a["target"] in ids][:10]
        return render_template("report_dept.html", d=d, D=ins["departments"][d], mem=mem, nodes=nodes, prof=prof,
                               closest=closest, pairs=pairs, tasks=ins["tasks"], meta=meta, ids=ids)
    return render_template("report.html", ins=ins, meta=meta, nodes=nodes, affinity=aff[:15])


@app.get("/investigador/<int:pid>")
def person(pid):
    """Ficha individual imprimible: lo que la red dice de un investigador y a quién le conviene escribir."""
    ensure_data()
    nodes = {n["id"]: n for n in read("nodes.json")}
    if pid not in nodes:
        abort(404)
    edges = [e for e in read("edges.json") if e["type"] == "coauthor" and pid in (e["source"], e["target"])]
    return render_template("person.html", n=nodes[pid], nodes=nodes, edges=edges,
                           ins=read("insights.json")["people"][str(pid)], meta=read("meta.json"))


@app.post("/api/colabora")
def colabora():
    """'Yo quiero colaborar con...': temas sugeridos"""
    from pipeline.colabora import suggest
    ensure_data()
    body = request.get_json(force=True, silent=True) or {}
    try:
        a, b = int(body.get("a")), int(body.get("b"))
    except (TypeError, ValueError):
        abort(400)
    if a == b:
        abort(400)
    return jsonify(suggest(a, b, body.get("interests") or [], bool(body.get("refresh"))))


@app.get("/api/colabora/stream")
def colabora_stream():
    """Versión en vivo: Server-Sent Events con cada paso y el texto a medida que llega."""
    from flask import Response, stream_with_context
    from pipeline.colabora import stream_events
    ensure_data()
    try:
        a, b = int(request.args["a"]), int(request.args["b"])
    except (KeyError, ValueError):
        abort(400)
    interests = [x for x in request.args.get("i", "").split("|") if x]
    refresh = request.args.get("refresh") == "1"

    def gen():
        for ev in stream_events(a, b, interests, refresh):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/colabora/estado")
def colabora_estado():
    from pipeline.colabora import provider
    prov, model = provider()
    return jsonify({"llm": bool(prov), "proveedor": prov, "modelo": model})


@app.post("/api/rebuild")
def rebuild():
    """Recalcula la red con lo que haya en data/raw (por ejemplo, tras correr el scraper)."""
    meta = build()
    return jsonify({"ok": True, "summary": meta["summary"]})


PHOTO_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "es-PE,es;q=0.9",
}


@app.get("/photo/<int:pid>")
def photo(pid):
    """Proxy con caché: sirve la foto local o la descarga una vez desde CRIS y la guarda.
    Así las fotos se ven aunque el portal bloquee la carga directa desde el navegador,
    y quedan disponibles sin internet para la exposición."""
    local = PHOTOS / f"{pid}.jpg"
    if local.exists():
        return send_from_directory(PHOTOS, local.name, max_age=86400)
    node = next((n for n in read("nodes.json") if n["id"] == pid), None)
    if not node or not node.get("image_url"):
        abort(404)
    try:
        r = requests.get(node["image_url"], headers=PHOTO_HEADERS, timeout=8)
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            PHOTOS.mkdir(parents=True, exist_ok=True)
            local.write_bytes(r.content)
            return send_from_directory(PHOTOS, local.name, max_age=86400)
    except requests.RequestException:
        pass
    abort(404)


@app.get("/data/<path:fname>")
def data_file(fname):
    if fname not in FILES + ("nodes.csv", "edges.csv"):
        abort(404)
    return send_from_directory(DATA, fname, as_attachment=fname.endswith(".csv"))


def photo_check():
    """Avisa en la consola cuántas fotos locales hay (si son 0, la red mostrará iniciales)."""
    try:
        nodes = json.loads((DATA / "nodes.json").read_text("utf-8"))
        have = sum((PHOTOS / f"{n['id']}.jpg").exists() for n in nodes)
        print(f"  Fotos locales: {have} de {len(nodes)} en {PHOTOS}")
        if have < len(nodes) // 2:
            print("  Pocas fotos: ejecute 'python -m pipeline.build_network' para copiarlas desde data/raw/manual.")
    except Exception as e:
        print(f"  No se pudo revisar las fotos: {e}")


if __name__ == "__main__":
    ensure_data()
    photo_check()
    app.run(debug=True, port=5000)
