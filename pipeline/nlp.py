"""
nlp.py
Procesamiento de lenguaje natural sobre las áreas de investigación (ResearchAreas).

Objetivo: inferir afinidad temática entre profesores a partir del texto libre
de sus áreas de investigación (tip de la consigna: "use NLP to help identify
and structure the network relationships").

Pasos
1. Limpieza: separar por ';', quitar ruido (niveles RENACYT como "Nivel VII",
   nombres de grupos RENACYT como "Carlos Monge IV"), corregir erratas detectadas.
2. Normalización: minúsculas, sin tildes, sinónimos ES/EN → forma canónica
   (p. ej. "machine learning" → "aprendizaje automatico").
3. Tokenización + stopwords ES/EN + stemming ligero (plurales).
4. TF-IDF (unigramas + bigramas, tf sublineal) y similitud coseno.
5. Explicabilidad: para cada par se guardan los términos compartidos con
   mayor aporte al coseno (se muestran en la interfaz).
"""
import re
import unicodedata

import numpy as np
from scipy.sparse import diags
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# --- 1. Ruido y erratas detectadas en el dataset original -------------------
# Valores que no son áreas sino clasificaciones RENACYT (nivel o grupo)
RENACYT_PATTERN = re.compile(
    r"^(nivel\s+[ivx]+|maria\s+rostworowski\s+[ivx]+|carlos\s+monge\s+[ivx]+)$",
    re.IGNORECASE,
)

TYPO_FIXES = {
    "finanas": "finanzas",
    "opeaciones": "operaciones",
    "imulación": "simulación",
    "biocemánica": "biomecánica",
    "ontrol de movimiento": "control de movimiento",
    "l estudio de": "el estudio de",
    "ingenieria de software": "ingeniería de software",
}

# --- 2. Sinónimos (se aplican sobre texto ya sin tildes, en minúsculas) -----
SYNONYMS = [
    (r"\bmachine learning\b", "aprendizaje automatico"),
    (r"\bdeep learning\b", "aprendizaje profundo"),
    (r"\bdeep reinforcement learning\b", "aprendizaje por refuerzo"),
    (r"\brepresentation learning\b", "aprendizaje de representaciones"),
    (r"\bdata science\b", "ciencia de datos"),
    (r"\bdata mining\b", "mineria de datos"),
    (r"\bbig ?data\b", "big_data"),
    (r"\bhigh performance computing\b", "alto rendimiento computacional"),
    (r"\bhpc\b", "alto rendimiento computacional"),
    (r"\bbiomechanics\b", "biomecanica"),
    (r"\bbioengineering\b", "bioingenieria"),
    (r"\brehabilitation\b", "rehabilitacion"),
    (r"\bbusiness and economics\b", "negocios economia"),
    (r"\binteligencia artificial\b", "inteligencia_artificial"),
    (r"\bia\b", "inteligencia_artificial"),
    (r"\bvision por computadora\b", "vision_computacional"),
    (r"\bvision computacional\b", "vision_computacional"),
    (r"\belementos? (micro-)?finitos?\b", "elementos_finitos"),
    (r"\binvestigacion de operaciones\b", "investigacion_operaciones"),
    (r"\boptimizacion combinatoria\b", "optimizacion_combinatoria"),
    (r"\bteoria de grafos\b", "teoria_grafos"),
    (r"\bhormigon\b", "concreto"),
    (r"\bcemento(s)?\b", "concreto"),
    (r"\bfpgas?\b", "fpga"),
    (r"\binterfase cerebro computadora\b", "interfaz cerebro"),
    (r"\bbci\b", "interfaz cerebro"),
    (r"\bredes de comunicacion\b", "redes_comunicacion"),
    (r"\bcomunicacion social\b", "comunicacion_social"),
]

STOPWORDS = set(
    """
    a al algo algunas algunos ante antes como con contra cual cuando de del desde
    donde durante e el ella ellas ellos en entre era es esa esas ese eso esos esta
    estas este esto estos la las le les lo los mas me mi muy no nos o otra otras
    otro otros para pero por que se sin sobre su sus tambien te tiene tu un una
    unas uno unos y ya
    the of and in for to on with as by an at from or is are be into its this that
    area areas enfasis particular estudio estudios desarrollo proyecto proyectos
    diversas diversos aplicacion aplicaciones relacionado relacionados tipo base
    nuevo nuevos nuevas emergente emergentes general entender variedad
    sistema ingenieria
    """.split()
)


def strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn"
    )


def clean_areas(raw: str):
    """Devuelve (lista_de_areas_limpias, lista_de_valores_renacyt)."""
    if not raw:
        return [], []
    text = raw
    for bad, good in TYPO_FIXES.items():
        text = re.sub(re.escape(bad), good, text, flags=re.IGNORECASE)
    areas, renacyt = [], []
    for part in text.split(";"):
        part = re.sub(r"\s+", " ", part).strip(" .,\t")
        if not part:
            continue
        if RENACYT_PATTERN.match(part):
            renacyt.append(part)
            continue
        areas.append(part[0].upper() + part[1:])
    return areas, renacyt


def _light_stem(tok: str) -> str:
    # Stemming mínimo de plurales del español (evita depender de NLTK)
    if len(tok) > 5 and tok.endswith(("ones", "ales", "ores", "ares", "eles")):
        return tok[:-2]
    if len(tok) > 4 and tok.endswith("s") and not tok.endswith(("ss", "is", "us")):
        return tok[:-1]
    return tok


def normalize(text: str) -> str:
    text = strip_accents(text.lower())
    for pattern, repl in SYNONYMS:
        text = re.sub(pattern, repl, text)
    text = re.sub(r"[^a-z0-9_ ]+", " ", text)
    toks = [t for t in text.split() if t not in STOPWORDS and len(t) > 2]
    toks = [_light_stem(t) for t in toks]
    toks = [t for t in toks if t not in STOPWORDS]
    return " ".join(toks)


# Forma legible (con tildes) de cada raíz, para mostrar términos en la interfaz
SURFACE = {}


def _learn_surface(docs):
    from collections import Counter
    counts = {}
    for d in docs:
        for w in re.findall(r"[a-záéíóúüñ0-9]+", d.lower()):
            key = _light_stem(strip_accents(w))
            counts.setdefault(key, Counter())[w] += 1
    SURFACE.clear()
    SURFACE.update({k: c.most_common(1)[0][0] for k, c in counts.items()})


def readable(term: str) -> str:
    return " ".join(SURFACE.get(t, t) for t in term.replace("_", " ").split())


def topic_similarity(docs):
    """
    docs: lista de strings (áreas concatenadas por profesor; "" si no tiene).
    Retorna (S, vectorizer, X) con S matriz de similitud coseno (diag = 0).
    """
    _learn_surface(docs)
    norm_docs = [normalize(d) for d in docs]
    vec = TfidfVectorizer(
        ngram_range=(1, 2),
        sublinear_tf=True,
        min_df=1,
        token_pattern=r"(?u)\b[a-z0-9_]{3,}\b",
    )
    # Documentos vacíos -> vector cero (similitud 0 con todos)
    X = vec.fit_transform([d if d else "zzvacio" for d in norm_docs])
    keep = np.array([0.0 if not d else 1.0 for d in norm_docs])
    X = (diags(keep) @ X).tocsr()
    X.eliminate_zeros()
    S = cosine_similarity(X)
    np.fill_diagonal(S, 0.0)
    return S, vec, X


def shared_terms(i, j, X, vec, k=4):
    """Términos que más aportan al coseno entre i y j (explicabilidad)."""
    contrib = X[i].multiply(X[j]).toarray().ravel()
    if contrib.sum() == 0:
        return []
    terms = vec.get_feature_names_out()
    idx = np.argsort(contrib)[::-1]
    out = []
    for t in idx:
        if contrib[t] <= 0 or len(out) >= k:
            break
        term = readable(terms[t])
        # evita repetir un unigrama ya contenido en un bigrama elegido
        if any(term in o or o in term for o in out):
            continue
        out.append(term)
    return out
