"""
build_network.py
Construye la red de colaboración científica de UTEC y sus métricas.

Entradas (data/raw/)
  faculty_network_filtered.json            92 investigadores (base del curso)
  publicaciones_combinadas.csv             publicaciones exportadas de CRIS con faculty_ids
  utec_network_coauthorship_verified.json  coautorías verificadas (control cruzado)
  faculty_scraped.json, coauthorship.json  (opcionales) salida de scrape_cris.py

Capas de la red
  coautoría   publicación compartida entre dos investigadores (evidencia fuerte)
  grupo       pertenencia al mismo grupo o centro de investigación (vínculo institucional)
  afinidad    pares SIN coautoría con intereses parecidos (NLP) y vecinos en común

Salidas (data/)
  nodes.json, nodes.csv, edges.json, edges.csv, affinity.json, meta.json

Uso:  python -m pipeline.build_network
"""
import csv
import json
import math
import random
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

import networkx as nx
import numpy as np
from sklearn.metrics import roc_auc_score

from pipeline.insights import build_insights
from pipeline.nlp import clean_areas, shared_terms, strip_accents, topic_similarity

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"

PARAMS = {
    "ext_w_coauthor": 2.0,     # red ampliada: peso por log2(1 + coautorías)
    "ext_w_group": 1.0,        # red ampliada: peso por grupo compartido
    "aff_w_topic": 0.5,        # afinidad: similitud temática (TF-IDF, coseno)
    "aff_w_adamic": 0.3,       # afinidad: Adamic-Adar en la red ampliada
    "aff_w_group": 0.2,        # afinidad: pertenecer al mismo grupo
    "aff_min_topic": 0.05,     # coseno mínimo para considerar un par por intereses
    "n_affinity": 40,
    "keep_people_not_in_cris": False,  # True = conservar a quienes ya no figuran en el listado actual de CRIS
}

SHORT = {
    "Departamento de Ciencia de la Computación": "Computación",
    "Departamento de Ciencias": "Ciencias",
    "Departamento de Ingeniería Mecánica y de la Energía": "Mecánica y Energía",
    "Departamento de Bioingeniería e Ingeniería Química": "Bioingeniería y Química",
    "Departamento de Ingeniería Electrónica y Mecatrónica": "Electrónica y Mecatrónica",
    "Departamento de Humanidades, Artes y Ciencias Sociales": "Humanidades y Artes",
    "Departamento de Ingeniería Industrial y Gestión de la Ingeniería": "Industrial y Gestión",
    "Departamento de Ingeniería Civil y Ambiental": "Civil y Ambiental",
    "Departamento de Ciencia de Datos y Sistemas de Información": "Ciencia de Datos y SI",
    "Departamento de Negocios Digitales": "Negocios Digitales",
    "Facultad de Negocios": "Facultad de Negocios",
    "Unknown Department": "Sin departamento",
}


def name_key(s):
    return re.sub(r"[^a-z ]", "", strip_accents((s or "").lower())).strip()


def dept_short(full):
    if not full or full.lower().startswith("unknown"):
        return "Sin departamento"
    return SHORT.get(full, re.sub(r"^Departamento de ", "", full))


# ---------------------------------------------------------------- 1. Carga
def load_people():
    base = json.loads((RAW / "faculty_network_filtered.json").read_text("utf-8"))["nodes"]
    info = {"scraped_profiles": 0, "updated": 0, "added": 0}
    sp = RAW / "faculty_scraped.json"
    if sp.exists():
        scraped = json.loads(sp.read_text("utf-8"))
        info["scraped_profiles"] = len(scraped)
        # Emparejamiento robusto: correo, luego nombre con tildes/espacios normalizados y, si no,
        # coincidencia de palabras (p. ej. "Fabien Yves Paul Cornillier" = "Fabien Cornillier").
        mail_count = Counter((p.get("email") or "").lower() for p in base)

        def match(sp):
            mail = (sp.get("email") or "").lower()
            for p in base:  # el correo solo identifica si no está repetido (hay dos personas con el mismo)
                if mail and mail_count[mail] == 1 and (p.get("email") or "").lower() == mail:
                    return p
            k = name_key(sp.get("name"))
            for p in base:
                if name_key(p["name"]) == k:
                    return p
            ks = set(k.split())
            best, sc = None, 0
            for p in base:
                o = set(name_key(p["name"]).split())
                v = len(ks & o) / max(1, min(len(ks), len(o)))
                if v > sc:
                    best, sc = p, v
            return best if sc >= 0.75 and len(ks & set(name_key(best["name"]).split())) >= 2 else None

        nxt = max(p["id"] for p in base) + 1
        info["new_people"] = []
        matched = set()
        for s in scraped:
            if not name_key(s.get("name")):
                continue
            p = match(s)
            if p:
                matched.add(p["id"])
                for f in ("department", "research_groups", "research_areas", "image_url", "email",
                          "slug", "profile_url", "orcid", "scopus_id", "roles", "external_orgs", "local_image"):
                    if s.get(f):
                        p[f] = s[f]
                for f in ("citations", "h_index"):
                    if s.get(f) is not None:
                        p[f] = s[f]
                info["updated"] += 1
            else:
                s = dict(s, id=nxt)
                nxt += 1
                base.append(s)
                info["added"] += 1
                info["new_people"].append(s["name"])
                matched.add(s["id"])
        # Si el scraping trajo el listado completo, quien ya no aparece en CRIS deja de ser nodo
        original = [p for p in base if p["id"] < nxt and p["id"] not in matched and not p.get("slug")]
        info["not_in_cris"] = [p["name"] for p in original]
        if len(scraped) >= 0.9 * (len(base) - info["added"]) and not PARAMS["keep_people_not_in_cris"]:
            gone = {p["id"] for p in original}
            base = [p for p in base if p["id"] not in gone]
    return base, info


def load_publications(ids, people=()):
    """Publicaciones por investigador y coautorías (co-ocurrencia en el CSV)."""
    pubs_of, pair_pubs, title = defaultdict(set), defaultdict(set), {}
    by_name = {name_key(p["name"]): p["id"] for p in people}
    path = RAW / "publicaciones_combinadas.csv"
    n_records = 0
    if path.exists():
        with open(path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                n_records += 1
                fid = {int(x) for x in (r.get("faculty_ids") or "").split(";")
                       if x.strip().isdigit() and int(x) in ids}
                # investigadores nuevos (scrapeados después del JSON base) se enlazan por nombre
                for nmx in (r.get("linked_professor_names") or "").split(";"):
                    if name_key(nmx) in by_name:
                        fid.add(by_name[name_key(nmx)])
                fid = sorted(fid)
                title[r["url"]] = r.get("title", "")
                for i in fid:
                    pubs_of[i].add(r["url"])
                for a, b in combinations(fid, 2):
                    pair_pubs[(a, b)].add(r["url"])
    return pubs_of, pair_pubs, title, n_records


def cross_check(pair_pubs):
    """Compara contra el JSON de coautorías verificadas."""
    p = RAW / "utec_network_coauthorship_verified.json"
    if not p.exists():
        return None
    ver = {tuple(sorted((l["source"], l["target"]))): l["weight"]
           for l in json.loads(p.read_text("utf-8"))["links"]}
    csv_w = {k: len(v) for k, v in pair_pubs.items()}
    return {"verified_pairs": len(ver), "csv_pairs": len(csv_w),
            "identical": ver == csv_w,
            "only_in_verified": len(set(ver) - set(csv_w)), "only_in_csv": len(set(csv_w) - set(ver))}


def load_scraped_coauthorship(people):
    p = RAW / "coauthorship.json"
    if not p.exists():
        return {}
    slug = {x.get("slug"): x["id"] for x in people if x.get("slug")}
    name = {name_key(x["name"]): x["id"] for x in people}
    out = {}
    for r in json.loads(p.read_text("utf-8")):
        a = slug.get(r.get("source_slug")) or name.get(name_key(r.get("source_name")))
        b = slug.get(r.get("target_slug")) or name.get(name_key(r.get("target_name")))
        if a is None or b is None or a == b:
            continue
        k = tuple(sorted((a, b)))
        out[k] = max(out.get(k, 0), int(r.get("shared", 1)))
    return out


FAC_SHORT = {"Facultad de Ingeniería": "Facultad de Ingeniería", "Facultad de Computación": "Facultad de Computación",
             "Facultad de Negocios": "Facultad de Negocios",
             "Departamentos Académicos Transversales": "Departamentos Transversales"}


def load_organisations():
    """Estructura scrapeada de cris.utec.edu.pe/es/organisations: unidad, tipo, padre y líderes."""
    p = RAW / "organisations.json"
    org = json.loads(p.read_text("utf-8")) if p.exists() else {"organisations": [], "people_roles": []}
    org.setdefault("people_roles", [])
    ex = RAW / "organisations_extra.json"   # complemento curado: se agrega solo lo que falte
    if ex.exists():
        extra = json.loads(ex.read_text("utf-8"))
        names = {o["name"] for o in org["organisations"]}
        org["organisations"] += [o for o in extra.get("organisations", []) if o["name"] not in names]
        have = {(r["name"], r["role"]) for r in org["people_roles"]}
        org["people_roles"] += [r for r in extra.get("people_roles", []) if (r["name"], r["role"]) not in have]
    return org


def faculty_map(org):
    """Departamento (nombre corto) -> facultad (o agrupación) a la que pertenece."""
    out = {}
    for o in org["organisations"]:
        if o["type"] == "Departamento" and o.get("parent") in FAC_SHORT:
            for nm in [o["name"]] + o.get("aliases", []):
                out[dept_short(nm)] = FAC_SHORT[o["parent"]]
    for f in FAC_SHORT:  # personas adscritas directamente a una facultad
        out.setdefault(f, FAC_SHORT[f])
    return out


def leadership(org, name):
    """Cargos de una persona (coordinación de grupo, dirección de centro o departamento)."""
    me = set(name_key(name).split())
    roles = []
    entries = [(l, o["name"]) for o in org["organisations"] for l in o.get("leaders", [])]
    entries += [({"name": r["name"], "role": r["role"]}, r["org"]) for r in org.get("people_roles", [])]
    for l, unit in entries:
        other = set(name_key(l["name"]).split())
        if other and len(me & other) / min(len(me), len(other)) >= 0.75:
            roles.append({"role": l["role"], "unit": unit})
    return roles


def load_external():
    """Salida opcional de enrich_openalex.py: coautorías con año y proyección externa por autor."""
    p = RAW / "openalex_summary.json"
    if not p.exists():
        return None
    return json.loads(p.read_text("utf-8"))


# ---------------------------------------------------------------- 2. Métricas
def participation(G, dept):
    out = {}
    for v in G:
        k = G.degree(v, weight="weight")
        if not k:
            out[v] = 0.0
            continue
        s = defaultdict(float)
        for u in G[v]:
            s[dept[u]] += G[v][u]["weight"]
        out[v] = 1 - sum((x / k) ** 2 for x in s.values())
    return out


def adamic_adar(G, order):
    pos = {v: i for i, v in enumerate(order)}
    A = np.zeros((len(order), len(order)))
    for z in G:
        k = G.degree(z)
        if k < 2:
            continue
        nb = [pos[u] for u in G[z]]
        for a, b in combinations(nb, 2):
            A[a, b] += 1 / math.log(k)
            A[b, a] += 1 / math.log(k)
    return A


def affinity_scores(order, S, A, same_group):
    P = PARAMS
    s_n = S / (S.max() or 1)
    a_n = A / (A.max() or 1)
    return P["aff_w_topic"] * s_n + P["aff_w_adamic"] * a_n + P["aff_w_group"] * same_group


def external_fields(ext, v):
    a = (ext or {}).get("authors", {}).get(str(v))
    if not a:
        return {"external": None}
    return {"external": {
        "institutions": a.get("ext_institutions", 0), "countries": a.get("countries", []),
        "top_partners": a.get("top_partners", [])[:3], "works": a.get("works", 0),
        "works_last5": a.get("works_last5", 0), "first_year": a.get("first_year"),
        "last_year": a.get("last_year"), "h_index": a.get("h_index"), "openalex": a.get("openalex_id"),
    }}


def dept_profile(order, dept, Xt, vec, co):
    """Afinidad temática entre departamentos (coseno de su vector TF-IDF medio) y sus temas principales."""
    from sklearn.metrics.pairwise import cosine_similarity
    from pipeline.nlp import readable
    names = sorted(set(dept.values()))
    terms = vec.get_feature_names_out()
    M = np.vstack([np.asarray(Xt[[i for i, v in enumerate(order) if dept[v] == d]].mean(axis=0)).ravel() for d in names])
    Sd = cosine_similarity(M)
    pair_co = Counter()
    for (a, b), c in co.items():
        pair_co[tuple(sorted((dept[a], dept[b])))] += c
    out = {}
    for i, d in enumerate(names):
        top = [readable(terms[j]) for j in np.argsort(M[i])[::-1][:6] if M[i, j] > 0]
        seen = []
        for t in top:
            if not any(t in x or x in t for x in seen):
                seen.append(t)
        out[d] = {"terms": seen[:4],
                  "similarity": {names[j]: round(float(Sd[i, j]), 3) for j in range(len(names)) if j != i},
                  "coauthorships_with": {names[j]: pair_co.get(tuple(sorted((d, names[j]))), 0) for j in range(len(names)) if j != i}}
    return out


def graph_stats(G):
    """Métricas globales vistas en clase: densidad, componentes, diámetro, camino medio."""
    comps = sorted(nx.connected_components(G), key=len, reverse=True)
    big = G.subgraph(comps[0])
    return {
        "nodes": G.number_of_nodes(), "edges": G.number_of_edges(),
        "density": round(nx.density(G), 4),
        "components": len(comps), "isolates": nx.number_of_isolates(G),
        "largest_component": len(comps[0]),
        "diameter_largest": nx.diameter(big) if len(comps[0]) > 1 else 0,
        "avg_path_largest": round(nx.average_shortest_path_length(big), 3) if len(comps[0]) > 1 else 0,
        "avg_clustering": round(nx.average_clustering(G), 4),
    }


# ---------------------------------------------------------------- 3. Orquestación
def copy_local_photos(people):
    """Fotos que vinieron en páginas guardadas con Ctrl+S: se copian a static/photos/<id>.jpg."""
    import shutil
    dest_dir = ROOT / "static" / "photos"
    dest_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in people:
        src = p.get("local_image")
        dest = dest_dir / f"{p['id']}.jpg"
        if src and Path(src).exists() and not dest.exists():
            shutil.copyfile(src, dest)
            n += 1
    return n


def build():
    people, merge_info = load_people()
    merge_info["photos_copied"] = copy_local_photos(people)
    ids = {p["id"] for p in people}
    order = [p["id"] for p in people]
    pos = {v: i for i, v in enumerate(order)}
    by = {p["id"]: p for p in people}

    for p in people:
        p["dept"] = dept_short(p.get("department", ""))
        p["groups"] = [g.strip() for g in (p.get("research_groups") or "").split(";") if g.strip()]
        p["areas"], ren = clean_areas(p.get("research_areas", ""))
        p["renacyt"] = ren[0] if ren else ""

    pubs_of, pair_pubs, title, n_records = load_publications(ids, people)
    check = cross_check(pair_pubs)
    scraped = load_scraped_coauthorship(people)

    # --- Capa de coautoría (CSV de CRIS + scraping + OpenAlex, se toma el máximo por par)
    co = {k: len(v) for k, v in pair_pubs.items()}
    for k, c in scraped.items():
        co[k] = max(co.get(k, 0), c)
    ext = load_external()
    years_of = {}
    if ext:
        for r in ext.get("pairs", []):
            a, b = int(r["a"]), int(r["b"])
            if a in ids and b in ids and a != b:
                k = tuple(sorted((a, b)))
                co[k] = max(co.get(k, 0), int(r["count"]))
                years_of[k] = sorted(r.get("years", []))
    C = nx.Graph()
    C.add_nodes_from(order)
    for (a, b), c in co.items():
        C.add_edge(a, b, weight=c)

    # --- Capa institucional (grupo compartido)
    grp = {}
    for a, b in combinations(order, 2):
        sg = sorted(set(by[a]["groups"]) & set(by[b]["groups"]))
        if sg:
            grp[(a, b)] = sg

    # --- Red ampliada = coautoría + grupo (para puentes)
    X = nx.Graph()
    X.add_nodes_from(order)
    for k in set(co) | set(grp):
        w = PARAMS["ext_w_coauthor"] * math.log2(1 + co.get(k, 0)) + PARAMS["ext_w_group"] * len(grp.get(k, []))
        X.add_edge(*k, weight=w, distance=1 / w)

    dept = {v: by[v]["dept"] for v in order}
    org = load_organisations()
    fac_of = faculty_map(org)
    fac = {v: fac_of.get(dept[v], "Sin facultad registrada") for v in order}
    deg_c = dict(C.degree())
    wdeg_c = dict(C.degree(weight="weight"))
    btw_c = nx.betweenness_centrality(C, normalized=True)
    btw_x = nx.betweenness_centrality(X, weight="distance", normalized=True)
    part_x = participation(X, dept)
    clo_x = nx.closeness_centrality(X, distance="distance")
    pr_x = nx.pagerank(X, weight="weight")
    eig_x = {v: 0.0 for v in order}
    for comp_nodes in nx.connected_components(X):  # vector propio por componente (red no conexa)
        if len(comp_nodes) > 2:
            vals = nx.eigenvector_centrality_numpy(X.subgraph(comp_nodes), weight="weight")
            for k2, val in vals.items():
                eig_x[k2] = abs(val) * len(comp_nodes) / len(order)
    comp = {}
    for i, c in enumerate(sorted(nx.connected_components(C), key=len, reverse=True)):
        for v in c:
            comp[v] = i if len(c) > 1 else -1

    # --- Afinidad por NLP (+ estructura) para pares sin coautoría
    S, vec, Xt = topic_similarity(["; ".join(by[v]["areas"]) for v in order])
    A = adamic_adar(X, order)
    G_same = np.zeros_like(S)
    for (a, b) in grp:
        G_same[pos[a], pos[b]] = G_same[pos[b], pos[a]] = 1
    F = affinity_scores(order, S, A, G_same)

    cand = []
    for i, j in combinations(range(len(order)), 2):
        a, b = order[i], order[j]
        if C.has_edge(a, b) or S[i, j] < PARAMS["aff_min_topic"]:
            continue
        cand.append((F[i, j], i, j))
    cand.sort(reverse=True)
    # Recomendaciones personales: los 3 pares más afines de cada investigador
    recs = defaultdict(list)
    for sc, i, j in cand:
        for me, other in ((i, j), (j, i)):
            if len(recs[order[me]]) < 3:
                recs[order[me]].append({"id": order[other], "score": round(float(sc), 3),
                                        "shared_terms": shared_terms(i, j, Xt, vec, k=3),
                                        "same_group": bool(G_same[i, j]),
                                        "cross_department": dept[order[i]] != dept[order[j]]})
    affinity = []
    for r, (sc, i, j) in enumerate(cand[: PARAMS["n_affinity"]], 1):
        a, b = order[i], order[j]
        affinity.append({
            "source": a, "target": b, "rank": r, "score": round(float(sc), 4),
            "topic_sim": round(float(S[i, j]), 4), "adamic_adar": round(float(A[i, j]), 4),
            "shared_groups": grp.get((a, b), []), "shared_terms": shared_terms(i, j, Xt, vec),
            "common_neighbors": sorted(set(X[a]) & set(X[b])),
            "cross_department": dept[a] != dept[b],
        })

    # --- Validación: ¿la afinidad anticipa las coautorías reales? (AUC sobre todos los pares)
    # Para no ser circulares, Adamic-Adar se recalcula solo con la capa de grupos.
    Xg = nx.Graph()
    Xg.add_nodes_from(order)
    Xg.add_edges_from(grp)
    Fg = affinity_scores(order, S, adamic_adar(Xg, order), G_same)
    y, f_all, f_topic = [], [], []
    for i, j in combinations(range(len(order)), 2):
        y.append(1 if C.has_edge(order[i], order[j]) else 0)
        f_all.append(Fg[i, j])
        f_topic.append(S[i, j])
    validation = None
    if sum(y) >= 3:
        validation = {"auc_affinity": round(roc_auc_score(y, f_all), 3),
                      "auc_topic_only": round(roc_auc_score(y, f_topic), 3),
                      "positives": int(sum(y)), "pairs": len(y),
                      "note": "Coautorías reales como positivos; Adamic-Adar sin la capa de coautoría."}

    # --- Nodos
    def rank(metric_vals):
        o = sorted(metric_vals, key=lambda v: metric_vals[v], reverse=True)
        return {v: i + 1 for i, v in enumerate(o)}

    pubs = {v: len(pubs_of[v]) for v in order}
    cites = {v: by[v].get("citations", 0) or 0 for v in order}
    rk = {"publications": rank(pubs), "coauthors": rank(deg_c), "coauthorships": rank(wdeg_c),
          "closeness": rank(clo_x), "pagerank": rank(pr_x), "eigenvector": rank(eig_x),
          "betweenness": rank(btw_x), "citations": rank(cites)}

    nodes = []
    for v in order:
        p = by[v]
        nb = list(C.neighbors(v))
        other = sorted({dept[u] for u in nb if dept[u] != dept[v]})
        nodes.append({
            "id": v, "name": p["name"], "department": p["dept"], "department_full": p.get("department", ""),
            "faculty": fac[v], "leadership": leadership(org, p["name"]),
            "groups": p["groups"], "areas": p["areas"], "renacyt": p["renacyt"],
            "image_url": p.get("image_url", "") if "no-portrait" not in (p.get("image_url") or "") else "",
            "email": p.get("email", ""), "profile_url": p.get("profile_url", ""),
            "orcid": p.get("orcid", ""), "roles": p.get("roles", []),
            "citations": cites[v], "publications": pubs[v],
            "coauthors": deg_c[v], "coauthorships": wdeg_c[v],
            "cross_dept_coauthors": sum(1 for u in nb if dept[u] != dept[v]),
            "collab_departments": other,
            "betweenness": round(btw_x[v], 5), "betweenness_coauthor": round(btw_c[v], 5),
            "participation": round(part_x[v], 4), "component": comp[v],
            "closeness": round(clo_x[v], 4), "pagerank": round(pr_x[v], 5), "eigenvector": round(eig_x[v], 4),
            "rank": {m: rk[m][v] for m in rk},
            "recommendations": recs.get(v, []),
            **external_fields(ext, v),
        })

    # --- Aristas
    edges = []
    for (a, b), c in sorted(co.items()):
        edges.append({"source": a, "target": b, "type": "coauthor", "weight": c, "years": years_of.get((a, b), []),
                      "cross_department": dept[a] != dept[b],
                      "publications": [{"title": title.get(u, ""), "url": u} for u in sorted(pair_pubs.get((a, b), []))],
                      "shared_groups": grp.get((a, b), [])})
    for (a, b), sg in sorted(grp.items()):
        edges.append({"source": a, "target": b, "type": "group", "weight": len(sg),
                      "cross_department": dept[a] != dept[b], "shared_groups": sg,
                      "coauthored": co.get((a, b), 0)})

    # --- Departamentos
    depts = []
    for d in sorted(set(dept.values())):
        mem = [v for v in order if dept[v] == d]
        urls = set().union(*[pubs_of[v] for v in mem]) if mem else set()
        top = max(mem, key=lambda v: pubs[v])
        inner = sum(c for (a, b), c in co.items() if dept[a] == d and dept[b] == d)
        outer = sum(c for (a, b), c in co.items() if (dept[a] == d) != (dept[b] == d))
        depts.append({
            "name": d, "researchers": len(mem), "publications": len(urls),
            "with_publications": sum(1 for v in mem if pubs[v]),
            "per_researcher": round(len(urls) / len(mem), 1),
            "median_publications": float(np.median([pubs[v] for v in mem])),
            "top_author": by[top]["name"] if pubs[top] else "",
            "top_share": round(pubs[top] / len(urls), 3) if urls else 0,
            "coauthorships_internal": inner, "coauthorships_external": outer,
        })
    depts.sort(key=lambda d: -d["publications"])

    cross_co = sum(1 for e in edges if e["type"] == "coauthor" and e["cross_department"])
    n_co = sum(1 for e in edges if e["type"] == "coauthor")
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "params": PARAMS,
        "sources": {"publication_records": n_records, "new_people_from_cris": merge_info.get("new_people", []),
                    "linked_publications": len(set().union(*pubs_of.values())) if pubs_of else 0,
                    "coauthorship_cross_check": check, "scraping": merge_info,
                    "scraped_coauthorship_pairs": len(scraped)},
        "summary": {
            "researchers": len(order),
            "with_publications": sum(1 for v in order if pubs[v]),
            "coauthorships": n_co, "coauthorships_cross": cross_co,
            "with_coauthors": sum(1 for v in order if deg_c[v]),
            "coauthor_components": [len(c) for c in sorted(nx.connected_components(C), key=len, reverse=True) if len(c) > 1],
            "nonzero_betweenness_coauthor": sum(1 for v in order if btw_c[v] > 0),
            "nonzero_betweenness_extended": sum(1 for v in order if btw_x[v] > 0),
            "coauthorships_cross_faculty": sum(1 for (a, b) in co if fac[a] != fac[b]),
            "leaders": sum(1 for v in order if leadership(org, by[v]["name"])),
            "group_ties": len(grp),
            "group_ties_coauthored": sum(1 for k in grp if k in co),
            "groups_total": len({g for p in people for g in p["groups"]}),
            "groups_multi_department": sum(1 for g in {g for p in people for g in p["groups"]}
                                           if len({p["dept"] for p in people if g in p["groups"]}) > 1),
            "external_available": bool(ext),
            "affinity_links": len(affinity),
            "affinity_cross": sum(a["cross_department"] for a in affinity),
        },
        "departments": depts,
        "department_profile": dept_profile(order, dept, Xt, vec, co),
        "organisation": {"source": org.get("source", ""), "collected": org.get("collected", ""),
                         "units": org["organisations"], "faculty_of_department": fac_of},
        "affinity_validation": validation,
        "network_stats": {"coauthor": graph_stats(C), "extended": graph_stats(X)},
        "year_note": "La columna year del CSV no trae años válidos: no hay análisis temporal.",
    }

    OUT.mkdir(exist_ok=True)
    insights = build_insights(nodes, edges, affinity, meta, X)
    for name, obj in (("nodes", nodes), ("edges", edges), ("affinity", affinity), ("meta", meta), ("insights", insights)):
        (OUT / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False, indent=1), "utf-8")
    with open(OUT / "nodes.csv", "w", newline="", encoding="utf-8") as f:
        cols = ["id", "name", "department", "publications", "citations", "coauthors", "coauthorships",
                "cross_dept_coauthors", "betweenness", "betweenness_coauthor", "participation", "renacyt"]
        w = csv.writer(f)
        w.writerow(cols + ["groups", "areas"])
        for n in nodes:
            w.writerow([n[c] for c in cols] + ["; ".join(n["groups"]), "; ".join(n["areas"])])
    with open(OUT / "edges.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["source", "target", "type", "weight", "cross_department", "shared_groups", "publication_titles"])
        for e in edges:
            w.writerow([e["source"], e["target"], e["type"], e["weight"], e["cross_department"],
                        "; ".join(e["shared_groups"]),
                        " | ".join(p["title"] for p in e.get("publications", []))])
        for a in affinity:
            w.writerow([a["source"], a["target"], "affinity", a["score"], a["cross_department"],
                        "; ".join(a["shared_groups"]), ""])
    return meta


if __name__ == "__main__":
    m = build()
    print(json.dumps(m["summary"], ensure_ascii=False, indent=1))
    print("Control cruzado:", m["sources"]["coauthorship_cross_check"])
    print("Validación afinidad:", m["affinity_validation"])
