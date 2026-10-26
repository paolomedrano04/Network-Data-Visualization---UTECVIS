"""
scrape_cris.py
Web scraping del portal de investigación de UTEC (https://cris.utec.edu.pe, plataforma Pure).

Qué obtiene
  1. Listado de perfiles      /es/persons/?page=N
  2. Perfil de cada docente   /es/persons/<slug>/
     nombre, departamento, grupos/centros, foto, citas, índice h, áreas
  3. Red de coautoría         /es/persons/<slug>/network-persons/
     docentes UTEC con los que comparte producción ("N compartidos")
  4. (opcional) Fingerprint   /es/persons/<slug>/fingerprints/  conceptos temáticos

Salidas (data/raw/)
  faculty_scraped.json   perfiles en el mismo esquema que faculty_network_filtered.json
  coauthorship.json      pares {source_slug, target_slug, shared}
  html_cache/            HTML descargado (las re-ejecuciones son incrementales)

Uso
  python -m pipeline.scrape_cris                    # perfiles + coautoría
  python -m pipeline.scrape_cris --only-known       # solo los 92 docentes del dataset base
  python -m pipeline.scrape_cris --fingerprints     # añade conceptos de fingerprint
  python -m pipeline.scrape_cris --browser          # usa Chromium (Playwright) si el sitio bloquea requests
  python -m pipeline.scrape_cris --visible          # igual, pero con la ventana visible (pasa mejor el anti-bots)
  python -m pipeline.scrape_cris --publications     # producción de cada perfil -> publicaciones_combinadas.csv
  python -m pipeline.scrape_cris --photos           # descarga fotos a static/photos/<id>.jpg
  python -m pipeline.scrape_cris --organisations    # estructura: universidad > facultad > departamento; centros y grupos
  python -m pipeline.scrape_cris --refresh          # ignora la caché y vuelve a descargar
  python -m pipeline.scrape_cris --html-dir data/raw/manual   # páginas guardadas con Ctrl+S (sin bloqueos)
Luego:
  python -m pipeline.build_network

Buenas prácticas: pausa entre peticiones, User-Agent identificable, caché local y
respeto de robots.txt. El portal tiene protección anti-bots; si responde 403, usar --browser.
"""
import argparse
import hashlib
import json
import random
import re
import sys
import time
import unicodedata
from pathlib import Path
from urllib import robotparser
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://cris.utec.edu.pe"
LANG = "es"
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
CACHE = RAW / "html_cache"
PHOTOS = ROOT / "static" / "photos"

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 UtecVis-DS5343/1.0"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-PE,es;q=0.9,en;q=0.7",
}

DEPT_PREFIX = ("departamento", "department", "facultad", "faculty")
GROUP_PREFIX = ("grupo", "centro", "research group", "research center", "research centre",
                "center", "centre", "instituto", "laboratorio")
EXCLUDE_ORGS = ("universidad de ingeniería y tecnología", "university of engineering and technology")


# ---------------------------------------------------------------------------
# Descarga
# ---------------------------------------------------------------------------
# Señales de la página de verificación anti-bots (esa página nunca se guarda en caché)
CHALLENGE = ("just a moment", "un momento", "cf-challenge", "challenge-platform", "verify you are human",
             "verifica que eres un ser humano")


def is_challenge(html):
    low = (html or "")[:6000].lower()
    return any(s in low for s in CHALLENGE)


class Fetcher:
    def __init__(self, use_browser=False, delay=(1.5, 3.0), refresh=False, visible=False):
        self.delay = delay
        self.refresh = refresh
        self.use_browser = use_browser
        self.visible = visible
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._pw = self._browser = self._page = None
        CACHE.mkdir(parents=True, exist_ok=True)
        self.robots = self._load_robots()

    def _load_robots(self):
        """Lee robots.txt con las mismas cabeceras (o con el navegador). Si el portal bloquea la lectura,
        Python lo tomaría como 'prohibido todo'; aquí se avisa y se sigue con pausas entre peticiones."""
        text = None
        try:
            r = self.session.get(BASE + "/robots.txt", timeout=15)
            if r.status_code == 200 and not is_challenge(r.text):
                text = r.text
        except requests.RequestException:
            pass
        if text is None and self.use_browser:
            try:
                self._browser_get(BASE + "/robots.txt")
                text = self._page.inner_text("body")
            except Exception:
                text = None
        if not text or "user-agent" not in text.lower():
            print("  Aviso: no se pudo leer robots.txt; se continúa con pausas entre peticiones.")
            return None
        rp = robotparser.RobotFileParser()
        rp.parse(text.splitlines())
        return rp

    def _cache_path(self, url):
        return CACHE / (hashlib.md5(url.encode()).hexdigest() + ".html")

    def _browser_get(self, url):
        if self._page is None:
            from playwright.sync_api import sync_playwright  # pip install playwright && playwright install chromium
            self._pw = sync_playwright().start()
            # Perfil persistente: si usted resuelve la verificación una vez, la cookie se conserva
            # para las páginas siguientes y para las próximas ejecuciones.
            profile = RAW / ".browser_profile"
            profile.mkdir(parents=True, exist_ok=True)
            self._browser = self._pw.chromium.launch_persistent_context(
                str(profile), headless=not self.visible, locale="es-PE", viewport={"width": 1280, "height": 900})
            self._page = self._browser.pages[0] if self._browser.pages else self._browser.new_page()
        # 'networkidle' nunca llega en este portal (analítica y recursos abiertos): basta con el DOM listo
        self._page.goto(url, wait_until="domcontentloaded", timeout=60000)
        wait = 60 if self.visible else 15         # con ventana visible: hasta 2 minutos para que usted la resuelva
        for i in range(wait):
            html = self._page.content()
            if not is_challenge(html):
                break
            if i == 0:
                print("  Verificación anti-bots: " + ("marque la casilla en la ventana de Chrome (tiene 2 minutos)..."
                      if self.visible else "esperando... (si no avanza, use --visible)"))
            self._page.wait_for_timeout(2000)
        self._page.wait_for_timeout(1500)        # deja cargar listas dinámicas
        return self._page.content()

    def get(self, url):
        cp = self._cache_path(url)
        if cp.exists() and not self.refresh:
            cached = cp.read_text("utf-8")
            if not is_challenge(cached):
                return cached
        if self.robots and not self.robots.can_fetch(HEADERS["User-Agent"], url):
            print(f"  robots.txt no permite: {url}")
            return None
        time.sleep(random.uniform(*self.delay))
        html = None
        if self.use_browser:
            for attempt in range(2):
                try:
                    html = self._browser_get(url)
                    break
                except Exception as e:
                    print(f"  no se pudo abrir {url} ({type(e).__name__}); reintento {attempt + 1}")
                    time.sleep(5)
        else:
            for attempt in range(3):
                try:
                    r = self.session.get(url, timeout=30)
                except requests.RequestException as e:
                    print(f"  error de red ({e}); reintento {attempt + 1}")
                    time.sleep(3 * (attempt + 1))
                    continue
                if r.status_code == 200 and not is_challenge(r.text):
                    html = r.text
                    break
                if r.status_code in (200, 403, 429, 503):
                    print(f"  {r.status_code} (bloqueo anti-bots) en {url}. Use --browser")
                    time.sleep(5 * (attempt + 1))
                    continue
                print(f"  HTTP {r.status_code}: {url}")
                break
        if html and is_challenge(html):
            print(f"  La verificación anti-bots no se resolvió en {url}. Pruebe con --browser --visible")
            return None
        if html:
            cp.write_text(html, "utf-8")
        return html

    def close(self):
        if self._browser:
            self._browser.close()
            self._pw.stop()
            self._browser = None


# ---------------------------------------------------------------------------
# Parsers (tolerantes a cambios menores de la plantilla de Pure)
# ---------------------------------------------------------------------------
def slug_from_url(href):
    m = re.search(r"/persons/([^/?#]+)", href or "")
    return unquote(m.group(1)) if m else None


def person_links(soup):
    """Enlaces a perfiles dentro de títulos de resultados (h3/h2)."""
    out = []
    for h in soup.select("h3 a[href*='/persons/'], h2.title a[href*='/persons/']"):
        slug = slug_from_url(h.get("href"))
        if slug:
            out.append((slug, h.get_text(" ", strip=True), urljoin(BASE, h["href"])))
    return out


def parse_listing(html):
    return person_links(BeautifulSoup(html, "lxml"))


def _num(text):
    return int(re.sub(r"[^\d]", "", text)) if text and re.search(r"\d", text) else None


def parse_profile(html, url):
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)
    name_el = soup.select_one(".person-details h1, main h1, h1")
    name = name_el.get_text(" ", strip=True) if name_el else ""

    # Organizaciones del encabezado (antes de las pestañas del perfil)
    department, groups = "", []
    header = soup.select_one(".person-details, .header.person-details, .rendering_person_personorganisationlistrendererportal")
    scope = header or soup
    for a in scope.select("a[href*='/organisations/']"):
        org = a.get_text(" ", strip=True)
        low = org.lower()
        if not org or low.startswith(EXCLUDE_ORGS):
            continue
        if low.startswith(DEPT_PREFIX) and not department:
            department = org
        elif low.startswith(GROUP_PREFIX) and org not in groups:
            groups.append(org)

    img = soup.select_one("meta[property='og:image']")
    image_url = img["content"].rstrip("/") + "?w=160&f=jpg" if img and img.get("content") else ""

    m_cit = re.search(r"(\d[\d.,]*)\s*(?:Citas|Citations)", text)
    m_h = re.search(r"(\d+)\s*(?:Índice h|Indice h|h-index)(?!\w)", text)

    # Áreas de investigación: bloque bajo un título que las mencione
    areas = ""
    for hd in soup.select("h2, h3, h4"):
        t = hd.get_text(" ", strip=True).lower()
        if re.search(r"(áreas? de investigación|intereses de investigación|research interests|research areas)", t):
            parts = []
            for sib in hd.find_next_siblings():
                if sib.name in ("h2", "h3", "h4"):
                    break
                parts.append(sib.get_text("; ", strip=True))
            areas = "; ".join(p for p in parts if p)
            break

    mail = re.search(r"([a-z0-9._-]+)\s*utec\.edu\s*pe", text)
    orcid = next((re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", a["href"]).group(0)
                  for a in soup.select("a[href*='orcid.org/']") if re.search(r"\d{4}-\d{4}", a["href"])), "")
    scopus = next((re.search(r"authorId=(\d+)", a["href"]).group(1)
                   for a in soup.select("a[href*='scopus.com']") if "authorId=" in a["href"]), "")
    roles = sorted({m.group(1) for m in re.finditer(
        r"(Coordinador[a]?|Director[a]?|Investigador[a]?|Profesor[a]? (?:Principal|Asociado|Auxiliar)|Docente \w+)", text)})
    return {
        "orcid": orcid, "scopus_id": scopus, "roles": roles,
        "name": name,
        "slug": slug_from_url(url),
        "profile_url": url,
        "department": department,
        "research_groups": "; ".join(groups),
        "research_areas": areas,
        "image_url": image_url,
        "email": f"{mail.group(1)}@utec.edu.pe" if mail else "",
        "citations": _num(m_cit.group(1)) if m_cit else None,
        "h_index": int(m_h.group(1)) if m_h else None,
    }


def parse_network_persons(html, source_slug):
    """Cada resultado: enlace a un perfil + 'N compartido(s)' / 'N shared'."""
    soup = BeautifulSoup(html, "lxml")
    rows = []
    items = soup.select("li.grid-result-item, li.list-result-item, .result-container")
    for it in items or [soup]:
        links = person_links(it)
        if not links:
            continue
        slug, name, _ = links[0]
        if slug == source_slug:
            continue
        m = re.search(r"(\d+)\s*(?:compartid|shared)", it.get_text(" ", strip=True), re.I)
        rows.append({"source_slug": source_slug, "target_slug": slug, "target_name": name,
                     "shared": int(m.group(1)) if m else 1})
    # dedup
    seen, out = set(), []
    for r in rows:
        if r["target_slug"] not in seen:
            seen.add(r["target_slug"])
            out.append(r)
    return out


def parse_external_orgs(html):
    """Pestaña Red > Unidades de investigación: instituciones externas con las que publica."""
    soup = BeautifulSoup(html, "lxml")
    out = []
    for it in soup.select("li.grid-result-item, li.list-result-item"):
        a = it.select_one("h3 a")
        if not a or "/organisations/" in a.get("href", "") and "utec" in a["href"]:
            continue
        m = re.search(r"(\d+)\s*(?:compartid|shared)", it.get_text(" ", strip=True), re.I)
        out.append({"name": a.get_text(" ", strip=True), "shared": int(m.group(1)) if m else 1})
    return out


def parse_publications(html):
    """Lista de producción de un perfil: título, url, año y perfiles UTEC enlazados."""
    soup = BeautifulSoup(html, "lxml")
    out = []
    for it in soup.select("li.list-result-item, li.grid-result-item, .result-container"):
        a = it.select_one("h3 a[href*='/publications/'], h2 a[href*='/publications/']")
        if not a:
            continue
        date = it.select_one("span.date")
        year = re.search(r"(19|20)\d{2}", date.get_text() if date else "")
        out.append({
            "url": urljoin(BASE, a["href"]).split("?")[0],
            "title": a.get_text(" ", strip=True),
            "year": year.group(0) if year else "",
            "person_slugs": sorted({slug_from_url(x["href"]) for x in it.select("a[href*='/persons/']")} - {None}),
        })
    seen, res = set(), []
    for r in out:
        if r["url"] not in seen:
            seen.add(r["url"])
            res.append(r)
    return res


def parse_fingerprints(html):
    soup = BeautifulSoup(html, "lxml")
    out = []
    for c in soup.select("[class*='concept']"):
        label = c.get_text(" ", strip=True)
        if not label or len(label) > 80:
            continue
        val = None
        container = c.find_parent("li") or c.parent
        m = re.search(r"(\d+)\s*%", container.get_text(" ", strip=True)) if container else None
        if m:
            val = int(m.group(1))
        out.append({"concept": label, "weight": val})
    seen, res = set(), []
    for r in out:
        if r["concept"] not in seen:
            seen.add(r["concept"])
            res.append(r)
    return res[:30]


# ---------------------------------------------------------------------------
# Flujo principal
# ---------------------------------------------------------------------------
def norm_name(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z ]", "", s).strip()


def list_all_persons(f, max_pages=60):
    found, page = {}, 0
    while page < max_pages:
        url = f"{BASE}/{LANG}/persons/?page={page}"
        html = f.get(url)
        if not html:
            break
        new = 0
        for slug, name, href in parse_listing(html):
            if slug not in found:
                found[slug] = (name, href)
                new += 1
        print(f"  página {page}: {new} perfiles nuevos (total {len(found)})")
        if new == 0:
            break
        page += 1
    return found


def download_photos(f):
    base = json.loads((RAW / "faculty_network_filtered.json").read_text("utf-8"))["nodes"]
    PHOTOS.mkdir(parents=True, exist_ok=True)
    ok = 0
    for p in base:
        if not p.get("image_url"):
            continue
        dest = PHOTOS / f"{p['id']}.jpg"
        if dest.exists():
            ok += 1
            continue
        time.sleep(random.uniform(*f.delay))
        try:
            r = f.session.get(p["image_url"], timeout=30)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                dest.write_bytes(r.content)
                ok += 1
        except requests.RequestException:
            pass
    print(f"Fotos disponibles localmente: {ok}/{len(base)}")


def org_type(name):
    low = name.lower()
    for k, t in (("universidad", "Universidad"), ("facultad", "Facultad"), ("departamentos académicos", "Agrupación"),
                 ("departamento", "Departamento"), ("grupos de investigación", "Centro"), ("grupo", "Grupo de Investigación"),
                 ("centro", "Centro"), ("dirección", "Dirección"), ("instituto", "Instituto"), ("escuela", "Unidad de enseñanza"),
                 ("laboratorio", "Laboratorio")):
        if low.startswith(k) or (k == "laboratorio" and k in low):
            return t
    return "Unidad"


def parse_org_tree(html):
    """Árbol 'Encontrar organización/área': listas anidadas de enlaces a /organisations/."""
    soup = BeautifulSoup(html, "lxml")
    out = []

    def walk(ul, parent):
        for li in ul.find_all("li", recursive=False):
            a = li.find("a", href=re.compile(r"/organisations/[^/?#]+"))
            name = a.get_text(" ", strip=True) if a else None
            if name:
                out.append({"name": name, "type": org_type(name), "parent": parent, "url": urljoin(BASE, a["href"])})
            for sub in li.find_all("ul", recursive=False):
                walk(sub, name or parent)

    root = soup.select_one("main ul, .organisation-hierarchy ul, ul")
    for ul in soup.select("main ul") or ([root] if root else []):
        if ul.find_parent("li") is None:
            walk(ul, None)
    seen, res = set(), []
    for o in out:
        if o["name"] not in seen:
            seen.add(o["name"])
            res.append(o)
    return res


def parse_org_page(html):
    """Página de una unidad: líderes ('Coordinador: X', 'Director', 'Directora')."""
    text = BeautifulSoup(html, "lxml").get_text(" ", strip=True)
    leaders = [{"name": m.group(2).strip(" -"), "role": m.group(1)}
               for m in re.finditer(r"(Coordinador[a]?|Director[a]?(?: Académico)?)\s*:?\s*([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.]+){1,4})", text)]
    return leaders


def scrape_organisations(f):
    html = f.get(f"{BASE}/{LANG}/organisations/")
    if not html:
        print("No se pudo leer /organisations/. Pruebe con --browser --visible.")
        return
    orgs = parse_org_tree(html)
    for o in orgs:
        ph = f.get(o["url"])
        if ph:
            o["leaders"] = parse_org_page(ph)
    out = {"source": f"{BASE}/{LANG}/organisations/", "collected": time.strftime("%Y-%m-%d"),
           "method": "scrape_cris.py --organisations", "organisations": orgs}
    (RAW / "organisations.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(f"Unidades: {len(orgs)} -> data/raw/organisations.json")


def parse_listing_people(html, folder=None):
    """Listado 'Encontrar perfiles' guardado desde el navegador: nombre, correo, departamento,
    grupos (con su rol) y foto de cada persona. Con esto ya se tienen los 104 nodos."""
    soup = BeautifulSoup(html, "lxml")
    people = []
    for it in soup.select("li.grid-result-item, li.list-result-item"):
        a = it.select_one("h3 a[href*='/persons/']")
        if not a:
            continue
        txt = it.get_text(" ", strip=True)
        mail = re.search(r"([a-z0-9._-]+)\s*@?\s*utec\.edu\s*\.?\s*pe", txt)
        dept, groups, roles = "", [], []
        for o in it.select("a[href*='/organisations/']"):
            org = o.get_text(" ", strip=True)
            low = org.lower()
            tail = (o.next_sibling or "")
            role = tail.strip(" -\n") if isinstance(tail, str) else ""
            if not org or low.startswith(EXCLUDE_ORGS):
                continue
            if low.startswith(DEPT_PREFIX) and not dept:
                dept = org
            elif low.startswith(GROUP_PREFIX):
                groups.append(org)
            if role:
                roles.append(role)
        img = it.select_one("img")
        src = img.get("src", "") if img else ""
        # Al guardar con Ctrl+S, Chrome cambia la foto a un archivo local (p0_files/...): se usa ese archivo
        local = ""
        if src and "files-asset" not in src and folder is not None:
            cand = Path(folder) / unquote(src.split("?")[0])
            if cand.exists() and cand.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
                local = str(cand.resolve())
        people.append({
            "name": a.get_text(" ", strip=True), "slug": slug_from_url(a["href"]),
            "profile_url": urljoin(BASE, a["href"]), "email": f"{mail.group(1)}@utec.edu.pe" if mail else "",
            "department": dept, "research_groups": "; ".join(groups), "roles": sorted(set(roles)),
            "image_url": (urljoin(BASE, src.split("?")[0]) + "?w=160&f=jpg"
                          if "files-asset" in src and "no-portrait" not in src else ""),
            "local_image": local if "no-portrait" not in src else "",
        })
    return people


def from_saved_html(folder):
    """Modo sin bloqueos: lee páginas guardadas con Ctrl+S desde su navegador normal."""
    folder = Path(folder)
    files = sorted(list(folder.glob("*.html")) + list(folder.glob("*.htm")))
    if not files:
        print(f"No hay archivos .html en {folder}")
        return
    people, orgs = {}, []
    for fp in files:
        html = fp.read_text("utf-8", errors="ignore")
        found = parse_listing_people(html, fp.parent)
        for p in found:
            people[p["slug"] or p["name"]] = p
        tree = parse_org_tree(html) if "/organisations/" in html and not found else []
        if len(tree) > 5:
            orgs = tree
        print(f"  {fp.name}: {len(found)} perfiles, {len(tree)} unidades")
    if people:
        (RAW / "faculty_scraped.json").write_text(json.dumps(list(people.values()), ensure_ascii=False, indent=1), "utf-8")
        print(f"Perfiles: {len(people)} -> data/raw/faculty_scraped.json")
    if orgs:
        out = {"source": f"{BASE}/{LANG}/organisations/ (páginas guardadas)", "collected": time.strftime("%Y-%m-%d"),
               "method": "scrape_cris.py --html-dir", "organisations": orgs}
        prev = RAW / "organisations.json"
        if prev.exists():  # conserva los líderes y cargos ya conocidos
            old = json.loads(prev.read_text("utf-8"))
            out["people_roles"] = old.get("people_roles", [])
            known = {o["name"]: o.get("leaders", []) for o in old["organisations"]}
            for o in orgs:
                o["leaders"] = o.get("leaders") or known.get(o["name"], [])
        prev.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
        print(f"Unidades: {len(orgs)} -> data/raw/organisations.json")
    print("Siguiente paso: python -m pipeline.build_network")


def write_publications_csv(pubs, profiles):
    """Mismo formato que publicaciones_combinadas.csv: url,title,year,faculty_ids,linked_professor_names."""
    import csv
    base = json.loads((RAW / "faculty_network_filtered.json").read_text("utf-8"))["nodes"]
    id_by_name = {norm_name(p["name"]): p["id"] for p in base}
    name_by_slug = {p["slug"]: p["name"] for p in profiles if p.get("slug")}
    path = RAW / "publicaciones_combinadas.csv"
    rows = {}
    if path.exists():  # se conserva lo anterior y se actualiza
        with open(path, encoding="utf-8-sig") as fh:
            rows = {r["url"]: r for r in csv.DictReader(fh)}
    for u, r in pubs.items():
        names = [name_by_slug[s] for s in r["person_slugs"] if s in name_by_slug]
        ids = sorted({id_by_name[norm_name(n)] for n in names if norm_name(n) in id_by_name})
        rows[u] = {"url": u, "title": r["title"], "year": r["year"],
                   "faculty_ids": ";".join(map(str, ids)), "linked_professor_names": ";".join(names)}
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["url", "title", "year", "faculty_ids", "linked_professor_names"])
        w.writeheader()
        w.writerows(rows.values())
    print(f"  publicaciones_combinadas.csv: {len(rows)} registros")


def main():
    ap = argparse.ArgumentParser(description="Scraping de cris.utec.edu.pe para UtecVis")
    ap.add_argument("--browser", action="store_true", help="usar Chromium vía Playwright")
    ap.add_argument("--visible", action="store_true", help="con --browser, mostrar la ventana del navegador")
    ap.add_argument("--html-dir", help="carpeta con páginas de CRIS guardadas desde su navegador (Ctrl+S)")
    ap.add_argument("--only-known", action="store_true", help="solo docentes del dataset base")
    ap.add_argument("--fingerprints", action="store_true", help="descargar conceptos de fingerprint")
    ap.add_argument("--no-network", action="store_true", help="no descargar coautorías")
    ap.add_argument("--photos", action="store_true", help="solo descargar fotos")
    ap.add_argument("--organisations", action="store_true", help="solo la estructura organizativa (facultades, departamentos, centros, grupos)")
    ap.add_argument("--publications", action="store_true",
                    help="descargar la producción de cada perfil y regenerar publicaciones_combinadas.csv")
    ap.add_argument("--refresh", action="store_true", help="ignorar caché HTML")
    ap.add_argument("--max", type=int, default=0, help="máximo de perfiles (pruebas)")
    args = ap.parse_args()

    if args.html_dir:
        from_saved_html(args.html_dir)
        return
    f = Fetcher(use_browser=args.browser or args.visible, refresh=args.refresh, visible=args.visible)
    if args.photos:
        download_photos(f)
        return
    if args.organisations:
        scrape_organisations(f)
        f.close()
        return

    print("1/3 Listando perfiles…")
    persons = list_all_persons(f)
    if not persons:
        print("No se pudo leer el listado. Pruebe con --browser. El dataset base sigue siendo válido.")
        sys.exit(1)

    if args.only_known:
        base = json.loads((RAW / "faculty_network_filtered.json").read_text("utf-8"))["nodes"]
        known = {norm_name(p["name"]) for p in base}
        persons = {s: v for s, v in persons.items() if norm_name(v[0]) in known}
        print(f"  filtrados a {len(persons)} docentes del dataset base")
    items = list(persons.items())[: args.max or None]

    print("2/3 Perfiles…")
    profiles, coauth, pubs = [], [], {}
    for k, (slug, (name, href)) in enumerate(items, 1):
        url = f"{BASE}/{LANG}/persons/{slug}/"
        html = f.get(url)
        if not html:
            continue
        prof = parse_profile(html, url)
        prof["name"] = prof["name"] or name
        if args.fingerprints:
            fh = f.get(f"{url}fingerprints/")
            if fh:
                prof["fingerprints"] = parse_fingerprints(fh)
        profiles.append(prof)
        if not args.no_network:
            nh = f.get(f"{url}network-persons/")
            if nh:
                coauth.extend(parse_network_persons(nh, slug))
            oh = f.get(f"{url}network-organisations/")
            if oh:
                prof["external_orgs"] = parse_external_orgs(oh)
        if args.publications:
            for page in range(0, 30):
                ph = f.get(f"{url}publications/?page={page}")
                rows = parse_publications(ph) if ph else []
                if not rows:
                    break
                for r in rows:
                    pubs.setdefault(r["url"], {**r, "person_slugs": set()})["person_slugs"].update(r["person_slugs"] + [slug])
        print(f"  [{k}/{len(items)}] {prof['name']}  ({prof['department'] or 'sin dpto.'})")

    print("3/3 Guardando…")
    (RAW / "faculty_scraped.json").write_text(json.dumps(profiles, ensure_ascii=False, indent=1), "utf-8")
    (RAW / "coauthorship.json").write_text(json.dumps(coauth, ensure_ascii=False, indent=1), "utf-8")
    if pubs:
        write_publications_csv(pubs, profiles)
    print(f"Perfiles: {len(profiles)}  Pares de coautoría: {len(coauth)}  Publicaciones: {len(pubs)}")
    print("Siguiente paso: python -m pipeline.build_network")
    f.close()


if __name__ == "__main__":
    main()
