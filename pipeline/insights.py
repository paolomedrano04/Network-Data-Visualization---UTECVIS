"""
insights.py
Convierte las métricas en hallazgos legibles: uno por tarea (hallazgo, evidencia y qué pueden hacer
los investigadores) y uno por investigador (su rol en la red y a quién le convendría escribir).
Lo usan la vista (títulos de cada paso, ficha) y el reporte imprimible /reporte.
"""
import networkx as nx


def pct(a, b):
    return f"{round(100 * a / b)} %" if b else "0 %"


def num(x, d=2):
    if not isinstance(x, float):
        return str(x)
    return f"{x:.{d}f}".rstrip("0").rstrip(".").replace(".", ",")


def first_last(name):
    w = name.split()
    return name if len(w) <= 2 else f"{w[0]} {w[-2] if len(w) >= 4 else w[1]}"


def short_unit(u):
    import re
    if u.startswith("Universidad"):
        return "UTEC"
    m = re.search(r"\(([^)]+)\)", u)
    if m:
        return m.group(1)
    return re.sub(r"^(Grupo de Investigación en |Centro de Investigación (en |y )?|Departamento de )", "", u)


def components_after_removal(X, v):
    H = X.copy()
    H.remove_node(v)
    big = lambda G: sum(1 for c in nx.connected_components(G) if len(c) > 1)
    return big(H) - big(X)


def build_insights(nodes, edges, affinity, meta, X):
    S = meta["summary"]
    by = lambda k: sorted(nodes, key=lambda d: (-d[k], -d["publications"]))
    nm = {n["id"]: n for n in nodes}
    co = [e for e in edges if e["type"] == "coauthor"]
    depts = meta["departments"]
    tasks = []

    # ---------------- T1 colaboradores más prolíficos
    tc = [n for n in by("coauthors") if n["coauthors"] > 0][:5]
    top_pub = by("publications")[:5]
    lonely = [n for n in top_pub if n["coauthors"] == 0]
    tasks.append({
        "id": "T1", "tab": "Colaboradores",
        "headline": f"{first_last(tc[0]['name'])} lidera: {tc[0]['coauthors']} coautores UTEC. Solo {S['with_coauthors']} de {S['researchers']} publican con un colega.",
        "question": "¿Quiénes son los colaboradores más prolíficos?",
        "metric": "Grado (n.º de coautores UTEC) y grado ponderado (publicaciones compartidas)",
        "finding": (f"{tc[0]['name']} es quien más colabora dentro de UTEC: {tc[0]['coauthors']} coautores y "
                    f"{tc[0]['coauthorships']} publicaciones compartidas. Le sigue {tc[1]['name']} "
                    f"({tc[1]['coauthors']} y {tc[1]['coauthorships']})."),
        "evidence": [
            f"Solo {S['with_coauthors']} de {S['researchers']} investigadores ({pct(S['with_coauthors'], S['researchers'])}) "
            f"tienen al menos una coautoría con un colega de la lista.",
            (f"{len(lonely)} de los 5 que más publican no tienen ningún coautor UTEC: "
             + ", ".join(f"{first_last(n['name'])} ({n['publications']})" for n in lonely) + ".") if lonely else
            "Los que más publican también colaboran dentro de UTEC.",
        ],
        "action": ("Publicar mucho no implica colaborar adentro. Los investigadores muy productivos sin coautores "
                   "UTEC son la mayor oportunidad para crear equipos internos."),
        "ranking": [{"id": n["id"], "value": n["coauthors"], "extra": n["coauthorships"]} for n in tc],
    })

    # ---------------- T2 puentes
    tb = [n for n in by("betweenness") if n["betweenness"] > 0][:5]
    impact = {n["id"]: components_after_removal(X, n["id"]) for n in tb[:3]}
    both = [n for n in tb if n["betweenness_coauthor"] > 0]
    tasks.append({
        "id": "T2", "tab": "Puentes",
        "headline": f"{first_last(tb[0]['name'])} y {first_last(tb[1]['name'])} sostienen los puentes"
                    + (f"; {sum(1 for n in tb if n.get('leadership'))} de los 5 principales tienen un cargo." if any(n.get('leadership') for n in tb) else "."),
        "question": "¿Quiénes actúan como puentes entre departamentos y grupos?",
        "metric": "Intermediación de Brandes (distancia = 1 / peso) en la red de coautoría + grupos; coeficiente de participación",
        "finding": (f"{tb[0]['name']} ({tb[0]['department']}) y {tb[1]['name']} ({tb[1]['department']}) son los "
                    f"principales puentes (intermediación {num(tb[0]['betweenness'], 3)} y {num(tb[1]['betweenness'], 3)}), aunque no registran coautorías UTEC: su rol de puente viene de pertenecer a grupos de varios departamentos."
                    if tb[0]["coauthors"] == 0 else f"{num(tb[1]['betweenness'], 3)})."),
        "evidence": [
            f"Si {first_last(tb[0]['name'])} no estuviera, la red ampliada se dividiría en "
            f"{impact[tb[0]['id']]} grupo(s) más: es un punto único de conexión." if impact[tb[0]['id']] > 0 else
            f"La red tiene caminos alternativos: retirar a {first_last(tb[0]['name'])} no la divide, pero alarga las rutas.",
            (" y ".join(first_last(n["name"]) for n in both) + (" son" if len(both) > 1 else " es") + " puente también en la red de coautoría pura: "
             "conectan departamentos con publicaciones, no solo con pertenencia a grupos.") if both else
            "Ningún puente lo es también en coautoría pura: hoy los puentes se apoyan en los grupos, no en publicaciones.",
            (f"{sum(1 for n in tb if n.get('leadership'))} de los 5 principales puentes ocupan un cargo según la estructura de CRIS: "
             + "; ".join(f"{first_last(n['name'])} ({n['leadership'][0]['role'].lower()} de {short_unit(n['leadership'][0]['unit'])})"
                         for n in tb if n.get("leadership")) + ". Ser puente va de la mano con coordinar.")
            if any(n.get("leadership") for n in tb) else "",
            f"Con solo coautorías, {S['nonzero_betweenness_coauthor']} de {S['researchers']} tendrían intermediación mayor que cero; "
            "por eso se mide sobre la red ampliada.",
        ],
        "action": ("Los puentes son los mejores intermediarios para presentar a colegas de otros departamentos. "
                   "Depender de pocos puentes es un riesgo: conviene que surjan otros."),
        "ranking": [{"id": n["id"], "value": n["betweenness"], "extra": n["participation"]} for n in tb],
    })

    # ---------------- T3 silos o interdisciplina
    no_co = [d["name"] for d in depts if d["coauthorships_internal"] + d["coauthorships_external"] == 0 and d["researchers"] >= 3]
    tasks.append({
        "id": "T3", "tab": "Interdisciplina",
        "headline": f"Los grupos ya mezclan departamentos, pero solo {S['group_ties_coauthored']} de {S['group_ties']} pares de grupo han publicado juntos.",
        "question": "¿Los departamentos colaboran entre sí o trabajan en silos?",
        "metric": "Proporción de coautorías entre departamentos; grupos con miembros de varios departamentos; pares de grupo que publican juntos",
        "finding": (f"La estructura ya es interdisciplinaria: {S['groups_multi_department']} de {S['groups_total']} grupos de "
                    f"investigación reúnen a varios departamentos y {S['coauthorships_cross']} de {S['coauthorships']} coautorías "
                    f"cruzan departamentos ({S.get('coauthorships_cross_faculty', 0)} incluso cruzan facultades). Pero compartir grupo casi no se traduce en publicar: "
                    f"solo {S['group_ties_coauthored']} de {S['group_ties']} pares del mismo grupo tienen una coautoría "
                    f"({pct(S['group_ties_coauthored'], S['group_ties'])})."),
        "evidence": [
            (f"{len(no_co)} departamentos con 3 o más investigadores no registran ninguna coautoría UTEC: "
             + ", ".join(no_co) + ".") if no_co else "Todos los departamentos registran coautorías.",
            "Línea cian: coautoría entre departamentos. Punteado: comparten grupo pero no han publicado juntos.",
        ],
        "action": ("El potencial está dentro de los propios grupos: los pares punteados ya se conocen y comparten "
                   "agenda; convertir esa pertenencia en una publicación es el paso más corto."),
        "ranking": [],
    })

    # ---------------- T4 colaboraciones probables
    v = meta.get("affinity_validation") or {}
    a0 = affinity[0]
    tasks.append({
        "id": "T4", "tab": "Predicción",
        "headline": f"{len(affinity)} parejas afines aún no publican juntas. La más clara: {first_last(nm[a0['source']]['name'])} y {first_last(nm[a0['target']]['name'])}.",
        "question": "¿Qué nuevas colaboraciones son más probables?",
        "metric": "Predicción de enlaces: 0,5 similitud de áreas (NLP, TF-IDF) + 0,3 Adamic-Adar + 0,2 mismo grupo",
        "finding": (f"{len(affinity)} pares con intereses afines aún no publican juntos; el más claro es "
                    f"{nm[a0['source']]['name']} y {nm[a0['target']]['name']}"
                    + (f", por {', '.join(a0['shared_terms'][:2])}." if a0["shared_terms"] else ".")),
        "evidence": [
            f"{S['affinity_cross']} de las {len(affinity)} sugerencias cruzan departamentos.",
            (f"Validación: usando las {v['positives']} coautorías reales como positivos, el puntaje obtiene AUC "
             f"{num(v['auc_affinity'])} (solo texto: {num(v['auc_topic_only'])}). Es mejor que el azar (0,5), "
             "así que las sugerencias tienen base.") if v else "",
        ],
        "action": "Cada investigador tiene en su ficha sus 3 colegas más afines y el porqué (grupo, temas en común).",
        "ranking": [{"pair": [a["source"], a["target"]], "value": a["score"]} for a in affinity[:10]],
    })

    # ---------------- T5 proyección externa (solo con datos de OpenAlex)
    ext_nodes = [n for n in nodes if n.get("external")]
    if ext_nodes:
        te = sorted(ext_nodes, key=lambda n: -n["external"]["institutions"])[:5]
        from collections import Counter
        cc = Counter(c for n in ext_nodes for c in n["external"]["countries"])
        gate = [n for n in te if n["coauthors"] == 0]
        tasks.append({
            "id": "T5", "tab": "Proyección externa",
            "headline": f"{first_last(te[0]['name'])} es quien más abre UTEC al exterior: {te[0]['external']['institutions']} instituciones.",
            "question": "¿Quiénes conectan a UTEC con instituciones externas?",
            "metric": "N.º de instituciones externas coautoras (OpenAlex, sin colaboraciones de más de 50 autores)",
            "finding": (f"{te[0]['name']} es quien más conecta a UTEC hacia afuera: publica con "
                        f"{te[0]['external']['institutions']} instituciones externas."),
            "evidence": [
                "Países socios más frecuentes: " + ", ".join(c for c, _ in cc.most_common(6)) + ".",
                (", ".join(first_last(n["name"]) for n in gate) + " tienen fuerte red externa pero ninguna coautoría "
                 "interna: pueden abrir sus redes a colegas de UTEC.") if gate else "",
            ],
            "action": "Para buscar socios internacionales, el primer contacto puede ser el colega UTEC que ya publica con ellos.",
            "ranking": [{"id": n["id"], "value": n["external"]["institutions"]} for n in te],
        })

    # ---------------- por investigador
    people = {}
    p75 = sorted(n["publications"] for n in nodes)[int(0.75 * len(nodes))]
    top_btw = {n["id"] for n in tb}
    for n in nodes:
        tags, lines = [], []
        dean = next((l for l in n.get("leadership", []) if "decan" in l["role"].lower()), None)
        if dean:
            tags.append(f"{dean['role']} de la {dean['unit']}")
        if n["coauthors"] >= 3:
            tags.append("Núcleo de colaboración")
        if n["id"] in top_btw:
            tags.append("Puente")
        if n["cross_dept_coauthors"] >= 2:
            tags.append("Conector interdepartamental")
        if n["publications"] >= p75 and n["coauthors"] == 0:
            tags.append("Alta producción, sin red interna")
        if n["coauthors"] == 0 and not n["groups"]:
            tags.append("Por integrar")
        if n["coauthors"]:
            lines.append(f"Publica con {n['coauthors']} colega(s) UTEC"
                         + (f", {n['cross_dept_coauthors']} de otros departamentos." if n["cross_dept_coauthors"] else ", todos de su departamento."))
        else:
            lines.append("Aún no registra coautorías con otros investigadores de la lista.")
        if n["betweenness"] > 0:
            lines.append(f"Es puesto {n['rank']['betweenness']} de {len(nodes)} como puente entre grupos.")
        if n["recommendations"]:
            r = n["recommendations"][0]
            why = "comparten grupo" if r["same_group"] else ""
            terms = ", ".join(r["shared_terms"])
            lines.append(f"Colega más afín sin coautoría: {nm[r['id']]['name']}"
                         + (f" ({why}{'; ' if why and terms else ''}{'temas: ' + terms if terms else ''})." if why or terms else "."))
        people[str(n["id"])] = {"tags": tags, "lines": lines}

    return {"tasks": tasks, "people": people, "departments": dept_insights(nodes, edges, affinity, meta)}


def dept_insights(nodes, edges, affinity, meta):
    """Lectura de cada tarea desde un departamento: lo que ve un profesor que elige 'Soy de ...'."""
    prof = meta["department_profile"]
    nm = {n["id"]: n for n in nodes}
    co = [e for e in edges if e["type"] == "coauthor"]
    out = {}
    for d, P in prof.items():
        mem = [n for n in nodes if n["department"] == d]
        ids = {n["id"] for n in mem}
        tc = sorted([n for n in mem if n["coauthors"]], key=lambda n: (-n["coauthors"], -n["coauthorships"]))
        lonely = sorted([n for n in mem if not n["coauthors"]], key=lambda n: -n["publications"])
        bridges = sorted([n for n in mem if n["betweenness"] > 0], key=lambda n: -n["betweenness"])
        ext = sorted({(nm[e["target"]] if e["source"] in ids else nm[e["source"]])["department"]
                      for e in co if (e["source"] in ids) != (e["target"] in ids)})
        sim = sorted(P["similarity"].items(), key=lambda kv: -kv[1])
        gap = next(((o, v) for o, v in sim[:4] if P["coauthorships_with"].get(o, 0) == 0), None)
        aff = [a for a in affinity if a["source"] in ids or a["target"] in ids]
        h1 = (f"{first_last(tc[0]['name'])} es su colaborador más activo ({tc[0]['coauthors']} coautores)."
              if tc else "Nadie del departamento registra coautorías con colegas UTEC.")
        if lonely and lonely[0]["publications"] >= 10:
            h1 += f" {first_last(lonely[0]['name'])} publica mucho ({lonely[0]['publications']}) pero sin coautores UTEC."
        h2 = (f"{first_last(bridges[0]['name'])} es su principal puente." if bridges else "El departamento no tiene puentes propios.") + \
             (f" Ya publican con {', '.join(ext)}." if ext else " Aún no publican con otros departamentos.")
        if gap and gap[0] == sim[0][0]:
            h3 = f"Por temas, lo más cercano es {sim[0][0]}, y aún no tienen ninguna coautoría."
        else:
            h3 = f"Por temas, lo más cercano es {sim[0][0]}" + (f"; con {gap[0]} también son afines y no tienen ninguna coautoría." if gap else ".")
        h4 = (f"{len(aff)} colaboraciones probables involucran al departamento; la más clara: "
              f"{first_last(nm[aff[0]['source']]['name'])} y {first_last(nm[aff[0]['target']]['name'])}." if aff
              else "No hay colaboraciones probables claras para el departamento.")
        out[d] = {"members": len(mem), "terms": P["terms"], "closest": [o for o, _ in sim[:3]],
                  "gap": gap[0] if gap else None, "headlines": {"T1": h1, "T2": h2, "T3": h3, "T4": h4},
                  "lonely": [n["id"] for n in lonely[:3] if n["publications"] >= 10],
                  "affinity": [a["rank"] for a in aff[:8]]}
    return out
