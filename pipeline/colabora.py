"""
colabora.py
"Yo quiero colaborar con...": sugiere temas de investigación conjunta para dos investigadores.

1. Arma el contexto con datos reales del proyecto: áreas de investigación, grupos, departamento,
   títulos de publicaciones, términos en común (TF-IDF), puntaje de afinidad y colegas en común.
2. Si hay una clave de API de Anthropic (variable de entorno ANTHROPIC_API_KEY), le pide a un LLM
   (Claude) 3 temas con su porqué, lo que aporta cada uno y un primer paso concreto.
3. Si no hay clave, no hay internet o la respuesta falla, genera una sugerencia automática con
   reglas (cruce de áreas complementarias y términos compartidos). La app funciona igual sin LLM.

Las respuestas se guardan en data/colabora_cache.json: una vez generada, una sugerencia se vuelve a
mostrar al instante y sin internet (útil para la exposición).

Configuración (PowerShell, antes de `python app.py`):
    $env:ANTHROPIC_API_KEY = "sk-ant-..."
    $env:UTECVIS_MODEL = "claude-haiku-5-5"    # opcional; por defecto claude-sonnet-5-5 (costo medio)
"""
import csv
import hashlib
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import time

import requests

from pipeline.nlp import shared_terms, topic_similarity

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
CACHE = DATA / "colabora_cache.json"
API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-sonnet-5-5"   # modelo de costo medio (Haiku es más barato; Opus, más caro)

_state = {}


def _key(s):
    s = (s or "").lower()
    for a, b in zip("áéíóúüñ", "aeiouun"):
        s = s.replace(a, b)
    return re.sub(r"[^a-z ]", "", s).strip()


def _load():
    """Carga (una vez) nodos, aristas, afinidad, similitud temática y títulos de publicaciones."""
    mtime = (DATA / "nodes.json").stat().st_mtime
    if _state.get("mtime") == mtime:
        return _state
    nodes = json.loads((DATA / "nodes.json").read_text("utf-8"))
    edges = json.loads((DATA / "edges.json").read_text("utf-8"))
    affinity = json.loads((DATA / "affinity.json").read_text("utf-8"))
    order = [n["id"] for n in nodes]
    by = {n["id"]: n for n in nodes}
    S, vec, Xt = topic_similarity(["; ".join(by[v]["areas"]) for v in order])
    adj = defaultdict(set)
    co = {}
    for e in edges:
        adj[e["source"]].add(e["target"]); adj[e["target"]].add(e["source"])
        if e["type"] == "coauthor":
            co[tuple(sorted((e["source"], e["target"])))] = e
    titles = defaultdict(list)
    by_name = {_key(n["name"]): n["id"] for n in nodes}
    path = RAW / "publicaciones_combinadas.csv"
    if path.exists():
        with open(path, encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                ids = {int(x) for x in (r.get("faculty_ids") or "").split(";") if x.strip().isdigit()}
                ids |= {by_name[_key(x)] for x in (r.get("linked_professor_names") or "").split(";") if _key(x) in by_name}
                for i in ids:
                    if i in by and len(titles[i]) < 8 and r.get("title"):
                        titles[i].append(r["title"].strip())
    aff = {tuple(sorted((a["source"], a["target"]))): a for a in affinity}
    _state.update(mtime=mtime, nodes=nodes, by=by, pos={v: i for i, v in enumerate(order)},
                  S=S, vec=vec, Xt=Xt, adj=adj, co=co, titles=titles, aff=aff)
    return _state


def context(a, b, interests=()):
    st = _load()
    A, B = st["by"][a], st["by"][b]
    i, j = st["pos"][a], st["pos"][b]
    common = [st["by"][c]["name"] for c in st["adj"][a] & st["adj"][b]]
    pair = tuple(sorted((a, b)))
    rec = next((r for r in A.get("recommendations", []) if r["id"] == b), None)
    return {
        "a": {"name": A["name"], "department": A["department"], "groups": A["groups"], "areas": A["areas"],
              "titles": st["titles"].get(a, [])[:6], "leadership": [l["role"] for l in A.get("leadership", [])]},
        "b": {"name": B["name"], "department": B["department"], "groups": B["groups"], "areas": B["areas"],
              "titles": st["titles"].get(b, [])[:6], "leadership": [l["role"] for l in B.get("leadership", [])]},
        "topic_similarity": round(float(st["S"][i, j]), 3),
        "shared_terms": shared_terms(i, j, st["Xt"], st["vec"], k=5),
        "same_group": sorted(set(A["groups"]) & set(B["groups"])),
        "already_coauthors": pair in st["co"],
        "coauthored_titles": [p["title"] for p in st["co"][pair]["publications"][:3]] if pair in st["co"] else [],
        "common_colleagues": common[:5],
        "affinity_score": (st["aff"].get(pair) or {}).get("score") or (rec or {}).get("score"),
        "interests": [x for x in interests if x],
    }


# ---------------------------------------------------------------- sugerencia sin LLM
def _first(name):
    w = name.split()
    return w[0]


def rule_based(ctx):
    """Cruza un área de cada uno (las más relacionadas con los términos compartidos) y arma 3 temas."""
    A, B = ctx["a"], ctx["b"]
    shared = ctx["shared_terms"]
    focus = ctx["interests"]
    ka = [x for x in A["areas"] if x in focus] + [x for x in A["areas"] if x not in focus]
    kb = [x for x in B["areas"] if x in focus] + [x for x in B["areas"] if x not in focus]
    ka = ka or ["su línea de investigación"]
    kb = kb or ["su línea de investigación"]
    topics = []
    # pares variados: 1.º con 1.º, 2.º con 2.º... (los intereses elegidos van primero)
    pairs = [(ka[k % len(ka)], kb[k % len(kb)]) for k in range(6)]
    seen = set()
    pairs = [p for p in pairs if _key(p[0]) != _key(p[1]) and not (p in seen or seen.add(p))]
    for x, y in pairs[:3]:
        topics.append({
            "titulo": f"{x} aplicado a {y.lower()}",
            "por_que": (f"Une una línea de {_first(A['name'])} ({x}) con una de {_first(B['name'])} ({y})"
                        + (f"; ya comparten intereses en {', '.join(shared[:3])}." if shared else ".")),
            "aporte_a": f"{_first(A['name'])}: experiencia en {x.lower()}.",
            "aporte_b": f"{_first(B['name'])}: experiencia en {y.lower()}.",
        })
    if not topics:
        topics = [{"titulo": f"Proyecto conjunto en {', '.join(shared[:2]) or 'un tema común'}",
                   "por_que": "Sus áreas registradas son muy cercanas.", "aporte_a": "", "aporte_b": ""}]
    reasons = []
    if ctx["same_group"]:
        reasons.append(f"están en el mismo grupo ({ctx['same_group'][0]})")
    if shared:
        reasons.append(f"comparten temas como {', '.join(shared[:3])}")
    if ctx["common_colleagues"]:
        reasons.append(f"tienen colegas en común ({', '.join(ctx['common_colleagues'][:2])})")
    joined = (", ".join(reasons[:-1]) + " y " + reasons[-1]) if len(reasons) > 1 else (reasons[0] if reasons else "tienen áreas que se pueden complementar")
    resumen = (f"{_first(A['name'])} y {_first(B['name'])} " + joined
               + (". Ya publicaron juntos; estas ideas amplían esa línea." if ctx["already_coauthors"] else "."))
    paso = (f"Pedirle a {ctx['common_colleagues'][0]} que los presente" if ctx["common_colleagues"]
            else f"Proponer una reunión de 30 minutos para revisar {topics[0]['titulo'].lower()}")
    return {"resumen": resumen, "temas": topics, "primer_paso": paso + ".", "fuente": "reglas"}


# ---------------------------------------------------------------- LLM (Claude)
SYSTEM = (
    "Eres un asesor de investigación de la Universidad de Ingeniería y Tecnología (UTEC, Lima). "
    "Propones colaboraciones científicas realistas entre dos investigadores, basándote SOLO en los datos dados "
    "(áreas, grupos, títulos de publicaciones, términos compartidos). No inventes logros, cargos ni publicaciones. "
    "Escribe en español, claro y concreto, sin puntos medios como separadores. "
    "Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código."
)


def _prompt(ctx):
    return (
        "Datos de los dos investigadores (JSON):\n" + json.dumps(ctx, ensure_ascii=False, indent=1) + "\n\n"
        "Propón 3 temas de investigación conjunta que combinen las áreas de ambos. "
        + ("Prioriza estos intereses elegidos por el usuario: " + ", ".join(ctx["interests"]) + ". " if ctx["interests"] else "")
        + "Formato exacto:\n"
        '{"resumen": "1 frase: por qué esta pareja tiene sentido", '
        '"temas": [{"titulo": "máx. 12 palabras", "por_que": "1 a 2 frases ligadas a sus áreas reales", '
        '"aporte_a": "qué aporta la primera persona", "aporte_b": "qué aporta la segunda persona"}], '
        '"primer_paso": "una acción concreta para empezar esta semana"}'
    )


def ask_llm(ctx):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None, "Sin clave de API: se muestra una sugerencia automática."
    model = os.environ.get("UTECVIS_MODEL", DEFAULT_MODEL)
    try:
        r = requests.post(API_URL, timeout=45, headers={
            "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": model, "max_tokens": 1200, "system": SYSTEM,
                  "messages": [{"role": "user", "content": _prompt(ctx)}]})
        if r.status_code != 200:
            return None, f"Respuesta de{r.status_code}: se muestra una sugerencia automática."
        text = "".join(c.get("text", "") for c in r.json().get("content", []) if c.get("type") == "text")
        text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
        out = json.loads(text[text.find("{"): text.rfind("}") + 1])
        assert out.get("temas")
        out["fuente"] = "llm"
        out["modelo"] = model
        return out, None
    except Exception as e:  # sin internet, JSON inválido, etc.
        return None, f"No se pudo consultar({type(e).__name__}): se muestra una sugerencia automática."


def suggest(a, b, interests=(), refresh=False):
    ctx = context(a, b, interests)
    key = hashlib.md5(json.dumps([a, b, sorted(ctx["interests"]), os.environ.get("UTECVIS_MODEL", DEFAULT_MODEL)]).encode()).hexdigest()
    cache = json.loads(CACHE.read_text("utf-8")) if CACHE.exists() else {}
    if key in cache and not refresh:
        return {**cache[key], "contexto": ctx, "cache": True}
    out, note = ask_llm(ctx)
    if out:
        cache[key] = out
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), "utf-8")
    else:
        out = rule_based(ctx)
        out["nota"] = note
    return {**out, "contexto": ctx, "cache": False}


# ================================================================ modo en vivo (streaming)
# El navegador recibe eventos a medida que el sistema avanza: perfiles leídos, temas en común,
# conexiones en la red y, al final, el texto del LLM llegando en tiempo real, línea por línea.
import time

LINE_PROMPT = (
    "Responde SOLO con líneas en este formato, sin nada más:\n"
    "ANALISIS: <observación breve sobre lo que tienen en común o se complementa> (escribe 2 o 3 líneas ANALISIS)\n"
    "RESUMEN: <1 frase: por qué esta pareja tiene sentido>\n"
    "TEMA: <título, máx. 12 palabras> || <por qué, 1 a 2 frases> || <qué aporta la primera persona> || "
    "<qué aporta la segunda persona> || <evidencia: copia literal el área o el título de publicación en que te basas>\n"
    "(escribe exactamente 3 líneas TEMA)\n"
    "PASO: <una acción concreta para empezar esta semana>"
)


def _line_prompt(ctx):
    return ("Datos de los dos investigadores (JSON):\n" + json.dumps(ctx, ensure_ascii=False, indent=1) + "\n\n"
            "Propón 3 temas de investigación conjunta que combinen las áreas de ambos. "
            + ("Prioriza estos intereses elegidos por el usuario: " + ", ".join(ctx["interests"]) + ". " if ctx["interests"] else "")
            + LINE_PROMPT)


def parse_lines(text, ctx):
    """Convierte el texto por líneas en la misma estructura que usa la interfaz, y verifica la evidencia."""
    out = {"analisis": [], "resumen": "", "temas": [], "primer_paso": ""}
    for raw in text.splitlines():
        line = raw.strip().lstrip("-* ")
        tag, _, rest = line.partition(":")
        tag, rest = tag.strip().upper(), rest.strip()
        if tag == "ANALISIS" and rest:
            out["analisis"].append(rest)
        elif tag == "RESUMEN":
            out["resumen"] = rest
        elif tag == "TEMA":
            p = [x.strip() for x in rest.split("||")] + [""] * 5
            out["temas"].append({"titulo": p[0], "por_que": p[1], "aporte_a": p[2], "aporte_b": p[3],
                                 "evidencia": p[4], "verificada": verify(p[4], ctx)})
        elif tag == "PASO":
            out["primer_paso"] = rest
    return out


def verify(evidence, ctx):
    """¿La evidencia citada existe de verdad en las áreas o publicaciones de alguno de los dos?"""
    ev = set(_key(evidence).split()) - {"de", "la", "el", "en", "y", "a", "los", "las", "del", "para", "con"}
    if not ev:
        return False
    for src in ctx["a"]["areas"] + ctx["b"]["areas"] + ctx["a"]["titles"] + ctx["b"]["titles"]:
        words = set(_key(src).split())
        if words and len(ev & words) / min(len(ev), len(words)) >= 0.6:
            return True
    return False


def _rules_as_lines(ctx):
    r = rule_based(ctx)
    A, B = _first(ctx["a"]["name"]), _first(ctx["b"]["name"])
    lines = [f"ANALISIS: {A} tiene {len(ctx['a']['areas'])} áreas registradas y {B} tiene {len(ctx['b']['areas'])}."]
    if ctx["shared_terms"]:
        lines.append(f"ANALISIS: Los términos que comparten son {', '.join(ctx['shared_terms'][:4])}.")
    lines.append(f"RESUMEN: {r['resumen']}")
    for t in r["temas"]:
        ev = t["titulo"].split(" aplicado a ")[0]
        lines.append(f"TEMA: {t['titulo']} || {t['por_que']} || {t['aporte_a']} || {t['aporte_b']} || {ev}")
    lines.append(f"PASO: {r['primer_paso']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- proveedor del LLM
# 1) Claude (pago por uso) si hay ANTHROPIC_API_KEY.
# 2) Si no, un modelo LOCAL y GRATUITO con Ollama (https://ollama.com), si está abierto en la PC.
# 3) Si no hay ninguno, reglas automáticas.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("UTECVIS_OLLAMA_MODEL", "qwen2.5:3b")
_probe = {"t": 0, "ok": False}


def _ollama_ok():
    if time.time() - _probe["t"] < 20:
        return _probe["ok"]
    try:
        tags = requests.get(f"{OLLAMA_URL}/api/tags", timeout=0.8).json().get("models", [])
        names = {m.get("name", "") for m in tags}
        _probe["ok"] = any(n == OLLAMA_MODEL or n.split(":")[0] == OLLAMA_MODEL.split(":")[0] for n in names)
    except Exception:
        _probe["ok"] = False
    _probe["t"] = time.time()
    return _probe["ok"]


def provider():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "claude", os.environ.get("UTECVIS_MODEL", DEFAULT_MODEL)
    if _ollama_ok():
        return "ollama", OLLAMA_MODEL
    return None, None


def _ollama_stream(ctx):
    """Modelo local con Ollama: gratis y sin internet. Entrega el texto a medida que se genera."""
    sys_txt = SYSTEM.replace("Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código.", "")
    r = requests.post(f"{OLLAMA_URL}/api/chat", timeout=180, stream=True, json={
        "model": OLLAMA_MODEL, "stream": True, "options": {"temperature": 0.4},
        "messages": [{"role": "system", "content": sys_txt}, {"role": "user", "content": _line_prompt(ctx)}]})
    if r.status_code != 200:
        raise RuntimeError(f"Ollama respondió {r.status_code}")
    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        ev = json.loads(raw)
        chunk = (ev.get("message") or {}).get("content", "")
        if chunk:
            yield chunk
        if ev.get("done"):
            break


def _llm_stream(ctx):
    """Llama a la API con stream=true y va entregando los fragmentos de texto."""
    if provider()[0] == "ollama":
        yield from _ollama_stream(ctx)
        return
    key = os.environ.get("ANTHROPIC_API_KEY")
    model = os.environ.get("UTECVIS_MODEL", DEFAULT_MODEL)
    r = requests.post(API_URL, timeout=60, stream=True, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": model, "max_tokens": 1400, "stream": True, "system": SYSTEM.replace(
            "Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código.", ""),
            "messages": [{"role": "user", "content": _line_prompt(ctx)}]})
    if r.status_code != 200:
        raise RuntimeError(f"Respondió{r.status_code}")
    for raw in r.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        ev = json.loads(raw[5:].strip())
        if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
            yield ev["delta"]["text"]


def _typed(text, step=18, delay=0.012):
    """Para la sugerencia por reglas o guardada: se 'escribe' en vivo."""
    for k in range(0, len(text), step):
        time.sleep(delay)
        yield text[k:k + step]


def stream_events(a, b, interests=(), refresh=False):
    st = _load()
    ctx = context(a, b, interests)
    yield {"type": "step", "id": "perfiles", "a_areas": len(ctx["a"]["areas"]), "b_areas": len(ctx["b"]["areas"]),
           "a_titles": len(ctx["a"]["titles"]), "b_titles": len(ctx["b"]["titles"])}
    time.sleep(0.35)
    yield {"type": "step", "id": "comun", "shared_terms": ctx["shared_terms"], "same_group": ctx["same_group"],
           "topic_similarity": ctx["topic_similarity"], "affinity_score": ctx["affinity_score"]}
    time.sleep(0.35)
    common_ids = sorted(st["adj"][a] & st["adj"][b])
    yield {"type": "step", "id": "red", "common_ids": common_ids[:5], "already_coauthors": ctx["already_coauthors"]}
    time.sleep(0.25)

    prov, pmodel = provider()
    model = pmodel or os.environ.get("UTECVIS_MODEL", DEFAULT_MODEL)
    key = "v2-" + hashlib.md5(json.dumps([a, b, sorted(ctx["interests"]), model]).encode()).hexdigest()
    cache = json.loads(CACHE.read_text("utf-8")) if CACHE.exists() else {}
    text, source, note = "", "rules", None
    if key in cache and not refresh:
        source = "cache"
        yield {"type": "llm", "source": "cache", "model": cache[key].get("model", model)}
        for chunk in _typed(cache[key]["text"], 40, 0.008):
            text += chunk
            yield {"type": "delta", "text": chunk}
    elif prov:
        yield {"type": "llm", "source": "llm", "model": model, "provider": prov}
        try:
            for chunk in _llm_stream(ctx):
                text += chunk
                yield {"type": "delta", "text": chunk}
            source = "llm"
            if text.strip():
                cache[key] = {"text": text, "model": model}
                CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), "utf-8")
        except Exception as e:
            note = f"{e if isinstance(e, RuntimeError) else type(e).__name__}: se muestra una sugerencia automática."
            text = ""
    if not text.strip():
        source = "rules"
        yield {"type": "llm", "source": "rules", "note": note or "Sin LLM disponible (ni clave de API ni Ollama): sugerencia automática por reglas."}
        for chunk in _typed(_rules_as_lines(ctx)):
            text += chunk
            yield {"type": "delta", "text": chunk}
    result = parse_lines(text, ctx)
    if not result["temas"]:   # el LLM no respetó el formato: se recurre a las reglas
        result = parse_lines(_rules_as_lines(ctx), ctx)
        source = "rules"
    yield {"type": "done", "source": source, "model": model, "provider": prov, "note": note, "result": result, "context": ctx}
