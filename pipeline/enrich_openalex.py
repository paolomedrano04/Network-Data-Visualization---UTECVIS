"""
enrich_openalex.py
Valor diferencial: completa la red con datos abiertos de OpenAlex (api.openalex.org).

Por qué: la exportación de CRIS que usamos es una muestra (2500 registros) y deja solo 17 coautorías
entre los 92 investigadores. OpenAlex indexa la producción completa con la lista de autores, su
institución y país, y el año. Con eso se obtiene:
  1. coautorías internas UTEC-UTEC con año (red más densa y con dimensión temporal),
  2. proyección externa de cada investigador: instituciones y países con los que publica,
  3. actividad reciente (publicaciones en los últimos 5 años) e índice h.

Emparejamiento de autores: primero por ORCID (si el scraper de CRIS lo obtuvo), si no por nombre
dentro de la institución UTEC en OpenAlex. Solo se acepta un nombre si coincide en al menos el 60 %
de sus palabras; los no encontrados se reportan.

Uso:
  python -m pipeline.enrich_openalex --email tu_correo@utec.edu.pe
  python -m pipeline.build_network
Salida: data/raw/openalex_summary.json  (y caché en data/raw/openalex_cache/)
"""
import argparse
import hashlib
import json
import re
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from itertools import combinations
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
CACHE = RAW / "openalex_cache"
API = "https://api.openalex.org"
MEGA = 50          # obras con más autores (p. ej. colaboraciones del LHC) no cuentan para socios externos
MAX_WORKS = 400    # tope por autor


def norm(s):
    s = "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(c) != "Mn")
    return set(re.sub(r"[^a-z ]", " ", s).split()) - {"de", "la", "del", "y"}


def name_match(a, b):
    A, B = norm(a), norm(b)
    return len(A & B) / max(1, min(len(A), len(B)))


class Client:
    def __init__(self, email=None, delay=0.12):
        self.s = requests.Session()
        self.email = email
        self.delay = delay
        CACHE.mkdir(parents=True, exist_ok=True)

    def get(self, path, params=None):
        params = dict(params or {})
        if self.email:
            params["mailto"] = self.email
        key = hashlib.md5((path + json.dumps(params, sort_keys=True)).encode()).hexdigest()
        cp = CACHE / f"{key}.json"
        if cp.exists():
            return json.loads(cp.read_text("utf-8"))
        for attempt in range(4):
            r = self.s.get(API + path, params=params, timeout=40)
            if r.status_code == 200:
                data = r.json()
                cp.write_text(json.dumps(data), "utf-8")
                time.sleep(self.delay)
                return data
            if r.status_code == 404:
                return None
            time.sleep(2 * (attempt + 1))
        return None


def find_institution(cl, override=None):
    if override:
        return override if override.startswith("I") else override.split("/")[-1]
    data = cl.get("/institutions", {"search": "Universidad de Ingeniería y Tecnología", "filter": "country_code:PE"})
    for r in (data or {}).get("results", []):
        if "tecnolog" in r["display_name"].lower():
            return r["id"].split("/")[-1]
    raise SystemExit("No se encontró UTEC en OpenAlex; use --institution Ixxxxxxx")


def find_author(cl, person, inst):
    orcid = (person.get("orcid") or "").split("/")[-1]
    if orcid:
        a = cl.get(f"/authors/orcid:{orcid}")
        if a:
            return a
    data = cl.get("/authors", {"search": person["name"], "filter": f"affiliations.institution.id:{inst}", "per-page": 5})
    best, score = None, 0
    for r in (data or {}).get("results", []):
        sc = name_match(person["name"], r["display_name"])
        if sc > score:
            best, score = r, sc
    return best if score >= 0.6 else None


def works_of(cl, author_id):
    out, cursor = [], "*"
    while cursor and len(out) < MAX_WORKS:
        data = cl.get("/works", {"filter": f"author.id:{author_id},from_publication_date:2010-01-01",
                                 "per-page": 200, "cursor": cursor,
                                 "select": "id,publication_year,authorships"})
        if not data:
            break
        out += data.get("results", [])
        cursor = data.get("meta", {}).get("next_cursor")
        if not data.get("results"):
            break
    return out


def run(email=None, institution=None):
    cl = Client(email)
    base = json.loads((RAW / "faculty_network_filtered.json").read_text("utf-8"))["nodes"]
    scraped = {}
    sp = RAW / "faculty_scraped.json"
    if sp.exists():
        scraped = {" ".join(sorted(norm(p["name"]))): p for p in json.loads(sp.read_text("utf-8"))}
    inst = find_institution(cl, institution)
    print("Institución UTEC en OpenAlex:", inst)

    oa_of, authors, missing = {}, {}, []
    for p in base:
        extra = scraped.get(" ".join(sorted(norm(p["name"]))), {})
        a = find_author(cl, {**p, **extra}, inst)
        if not a:
            missing.append(p["name"])
            continue
        oa_of[a["id"].split("/")[-1]] = p["id"]
        authors[p["id"]] = a
    print(f"Emparejados {len(authors)} de {len(base)}. Sin coincidencia: {len(missing)}")

    this_year = date.today().year
    pairs = defaultdict(lambda: {"count": 0, "years": []})
    summary, seen_pair_work = {}, set()
    for pid, a in authors.items():
        works = works_of(cl, a["id"].split("/")[-1])
        inst_c, countries, years = Counter(), Counter(), []
        for w in works:
            y = w.get("publication_year")
            years.append(y)
            auths = w.get("authorships", [])
            # coautorías internas (otro investigador de la lista en la misma obra)
            ours = sorted({oa_of[x["author"]["id"].split("/")[-1]] for x in auths
                           if x.get("author", {}).get("id", "").split("/")[-1] in oa_of})
            for u, v in combinations(ours, 2):
                if (u, v, w["id"]) not in seen_pair_work:
                    seen_pair_work.add((u, v, w["id"]))
                    pairs[(u, v)]["count"] += 1
                    pairs[(u, v)]["years"].append(y)
            if len(auths) > MEGA:
                continue
            for x in auths:
                for i in x.get("institutions", []):
                    if i.get("id", "").split("/")[-1] == inst:
                        continue
                    if i.get("display_name"):
                        inst_c[i["display_name"]] += 1
                    if i.get("country_code"):
                        countries[i["country_code"]] += 1
        years = [y for y in years if y]
        summary[str(pid)] = {
            "openalex_id": a["id"], "works": len(works),
            "works_last5": sum(1 for y in years if y >= this_year - 4),
            "first_year": min(years) if years else None, "last_year": max(years) if years else None,
            "h_index": (a.get("summary_stats") or {}).get("h_index"),
            "ext_institutions": len(inst_c),
            "countries": [c for c, _ in countries.most_common() if c != "PE"][:12],
            "top_partners": [n for n, _ in inst_c.most_common(5)],
        }
    out = {"institution": inst, "generated": date.today().isoformat(), "matched": len(authors),
           "missing": missing, "authors": summary,
           "pairs": [{"a": u, "b": v, **d} for (u, v), d in pairs.items()]}
    (RAW / "openalex_summary.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(f"Coautorías internas encontradas: {len(out['pairs'])}. Siguiente: python -m pipeline.build_network")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Enriquecer UtecVis con OpenAlex")
    ap.add_argument("--email", help="correo para el 'polite pool' de OpenAlex (recomendado)")
    ap.add_argument("--institution", help="ID OpenAlex de UTEC si la búsqueda automática falla")
    a = ap.parse_args()
    run(a.email, a.institution)
