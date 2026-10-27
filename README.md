# UtecVis: red de colaboración científica de UTEC

Autores: Gianella Araceli Lira Ñaupari (https://www.linkedin.com/in/gianella-araceli-lira-%C3%B1aupari-9102b524a/) y Paolo Medrano Terán (https://www.linkedin.com/in/paolo-medrano-ter%C3%A1n-b45123246/)

DS5343 Visualización de Datos, 2026-2. Flask + D3 v7 (sin otras librerías de visualización).

## Ejecutar

```
pip install -r requirements.txt
python app.py                      # http://127.0.0.1:5000
```

| Ruta | Qué es |
|---|---|
| `/` | La visualización (una sola vista) |
| `/reporte`, `/reporte?d=<dpto>` | Reporte imprimible (Guardar como PDF): general o del departamento elegido |
| `/investigador/<id>` | Ficha individual imprimible: rol en la red y a quién le conviene escribir |
| `/#p=<id>` | Enlace directo a la ficha de un investigador dentro de la red |
| `/data/nodes.csv`, `/data/edges.csv` | Archivos de nodos y aristas |
| `/api/graph`, `POST /api/rebuild` | Datos para D3 y recálculo tras actualizar los datos |

D3, Montserrat y los datos van incluidos: la vista funciona sin internet. Las fotos se guardan solas en
`static/photos/` la primera vez que se abre la app con internet (proxy con caché de `/photo/<id>`).

## Datos y web scraping (cris.utec.edu.pe)

| Fuente | Qué aporta | Cómo se obtiene |
|---|---|---|
| Perfiles (`/es/persons/`) | ProfessorID, nombre, departamento, áreas, grupos, foto, citas, índice h, ORCID, cargos | `python -m pipeline.scrape_cris` |
| Publicaciones | Coautorías (co-ocurrencia de investigadores en una publicación), con título | `--publications` (regenera `publicaciones_combinadas.csv`) |
| **Estructura organizativa** (`/es/organisations/`) | Universidad > facultad > departamento; Dirección de Investigación > centros y grupos; coordinadores y directores | `--organisations` (genera `organisations.json`) |
| Red de cada perfil (`network-persons`, `network-organisations`) | Coautores UTEC y organizaciones externas | incluido en la ejecución normal |
| OpenAlex (opcional, valor diferencial) | Producción completa con año, coautorías internas faltantes en la muestra, instituciones y países socios | `python -m pipeline.enrich_openalex --email tu@utec.edu.pe` |

Si el portal bloquea el acceso automatizado (verificación anti-bots), se guardan las páginas del listado con Ctrl+S desde el navegador en `data/raw/manual/` y se procesan con `python -m pipeline.scrape_cris --html-dir data/raw/manual` (así se obtuvieron los 104 perfiles actuales y las 73 unidades). Quienes ya no figuran en CRIS dejan de ser nodos (`keep_people_not_in_cris` en `build_network.py`).

Luego `python -m pipeline.build_network` recalcula todo. El scraper usa caché, pausas y robots.txt; si el
portal responde 403 (protección anti-bots), usar `--browser` (Playwright). El portal declara reservados los
derechos de minería de datos: el uso es académico. `data/raw/organisations.json` se armó con el árbol
"Encontrar organización/área" y las páginas de cada unidad ("Unidad organizativa", unidad padre y coordinador).

## Tareas analíticas y lo que responde la vista

| | Pregunta | Métrica | Codificación |
|---|---|---|---|
| T1 | ¿Quiénes son los colaboradores más prolíficos? | Grado y grado ponderado (coautoría) | Tamaño = coautores; grosor = publicaciones compartidas; ranking numerado |
| T2 | ¿Quiénes actúan como puentes entre departamentos y grupos? | Intermediación de Brandes (distancia 1/peso) en coautoría + grupos; participación; cargos (CRIS) | Halo negro = intermediación; punto negro = coordina/dirige |
| T3 | ¿Los departamentos colaboran entre sí o en silos? | % coautorías entre departamentos y facultades; grupos multidepartamento; pares de grupo que publican juntos | Territorio = departamento, contorno = facultad, cian = entre departamentos, punteado = mismo grupo sin coautoría |
| T4 | ¿Qué nuevas colaboraciones son más probables? | Predicción de enlaces: 0,5 TF-IDF de áreas (NLP) + 0,3 Adamic-Adar + 0,2 mismo grupo; validación AUC | Líneas discontinuas animadas; 3 recomendaciones por ficha |
| T5 | ¿Quiénes conectan a UTEC con instituciones externas? (aparece solo con OpenAlex) | N.º de instituciones externas coautoras | Tamaño = instituciones externas |

Los hallazgos concretos (nombres y cifras) no se fijan aquí porque cambian con los datos: se ven en la vista y en `/reporte`. Cada tarea muestra: pregunta, hallazgo con números, evidencia, la métrica usada y **qué pueden hacer los
investigadores** con ese hallazgo. Los textos se generan desde los datos (`pipeline/insights.py`), así que se
actualizan solos al volver a hacer scraping.

## Uso desde el lado de un profesor (producto)

- **Colaborar (con LLM)**: "Yo soy ___ y quiero colaborar con ___". Al elegir cada persona aparecen sus áreas de investigación como etiquetas (se pueden marcar como intereses) y sus 3 colegas más afines como atajos. El botón "Sugerir temas" envía al servidor los datos reales de ambos (áreas, grupos, títulos de publicaciones, términos compartidos por TF-IDF, colegas en común) y un LLM (Claude, API de Anthropic) propone 3 temas conjuntos con su porqué, lo que aporta cada uno y un primer paso. Se abre como ventana al centro con las fotos de ambos y muestra el proceso en vivo (Server-Sent Events): perfiles leídos, temas en común (TF-IDF), colegas en común en la red (que también se resaltan detrás) y el texto del LLM llegando en tiempo real. Cada tema cita su evidencia (un área o publicación) y el servidor la verifica contra los datos de CRIS: "✓ Verificado" o "Sin verificar". También se abre desde la ficha ("Ideas para colaborar"). Para activarlo: `$env:ANTHROPIC_API_KEY = "sk-ant-..."` antes de `python app.py` (por defecto `claude-sonnet-5-5`, de costo medio; configurable con `UTECVIS_MODEL`). Sin clave o sin internet, responde con reglas automáticas; las respuestas del LLM quedan guardadas en `data/colabora_cache.json` para mostrarlas sin conexión.

- **Soy de (arriba a la izquierda)**: el profesor elige su departamento y toda la vista se reconfigura. Su departamento va al centro y los demás se ubican según su afinidad temática (TF-IDF de sus áreas): cerca y sin líneas es una oportunidad. Cada tarea responde desde su departamento y el botón cambia a "Reporte del departamento". La elección se recuerda en el navegador.
- **Seleccionar**: clic en una foto para seleccionar (se resalta su red y se abre su ficha); clic de nuevo o Esc para quitar la selección.
- **Camino entre dos personas**: con alguien seleccionado, Shift + clic en otra foto (o escribir un nombre en "¿Cómo llegar a alguien?") muestra la ruta más corta y quién puede presentarlos.
- **Reportes según quien consulta**: `/reporte` (general), `/reporte?d=<departamento>` (afinidades, oportunidades, integrantes y a quién escribirle) e `/investigador/<id>` (persona).

1. El docente del curso comparte `/reporte` (PDF) con los hallazgos generales y la lista de colaboraciones recomendadas.
2. Cada investigador recibe su enlace `/#p=<id>` o su ficha `/investigador/<id>`: ve su rol (núcleo, puente, conector interdepartamental, alta producción sin red interna), su posición en el ranking y **tres colegas a quienes escribir** con el porqué (mismo grupo, temas en común).
3. Un coordinador de grupo usa *Estructura* para ver a sus miembros y sus vínculos, y T3 para detectar quiénes de su grupo aún no han publicado juntos.

## Diseño (qué, por qué, cómo; Munzner)

- **Qué**: red no dirigida con atributos de nodo (departamento, facultad, publicaciones, métricas, cargos) y de arista (publicaciones compartidas, cruce de departamento); capa institucional (grupos) y capa predicha (afinidad).
- **Por qué**: tareas T1 a T4 (identificar extremos, localizar puentes, resumir topología por grupos, predecir enlaces).
- **Cómo, posición**: fuerzas en dos niveles: facultad y luego departamento (enclosure tipo *group in a box*); alternativa *beeswarm* (sustrato semántico) por departamento con x = publicaciones. El departamento se lee por posición, no por color, para no saturar.
- **Cómo, color**: negro, grises y un solo acento cian, reservado para lo que la tarea destaca (coautoría entre departamentos, rankings).
- **Cómo, tamaño y forma**: tamaño = métrica de la tarea (coautores, publicaciones); grosor = publicaciones compartidas; halo = intermediación; línea continua = coautoría, punteada = grupo, discontinua = predicción.
- **Animación (mantra de Shneiderman)**: entrada por departamento y panorama (*overview*); cada tarea cambia tamaño, capas y disposición con transiciones; zoom, filtro por departamento o grupo, búsqueda y capas (*zoom and filter*); tooltip en *mouseenter*, ficha en *click*, doble clic para acercar (*details on demand*). Arrastre con resistencia: el nodo sigue al cursor con retraso y vuelve con rebote amortiguado.

## Cumplimiento de la consigna

| Requisito | Dónde |
|---|---|
| Una sola visualización de red | `/` (todo en una vista; herramientas flotantes) |
| Datos de CRIS con ProfessorID, Name, Department, ResearchAreas | `data/raw/faculty_network_filtered.json` + scraper |
| Descarga por web scraping | `pipeline/scrape_cris.py` (perfiles, publicaciones, estructura, red) |
| Enriquecer con otras métricas (Scholar, h-index, etc.) | Citas, índice h, ORCID, cargos; OpenAlex opcional |
| Mínimo 4 tareas y la vista las responde | T1 a T4 (+T5), con hallazgo y evidencia en pantalla |
| NLP para estructurar relaciones | `pipeline/nlp.py` (TF-IDF, sinónimos ES/EN, términos explicativos) |
| Fotos de los profesores como nodos | Sí, con caché local |
| Métricas correctamente calculadas | NetworkX; control cruzado de coautorías (17/17 coinciden); validación AUC |
| Interacción (mouseenter, mouseover, click) y animación | Sí (ver Diseño) |
| Solo D3 | `static/js/d3.min.js`; ninguna otra librería de visualización |
| ZIP con app Flask y archivos de nodos y aristas | `app.py`, `data/nodes.*`, `data/edges.*` |

## Métricas y validación

- Coautoría: co-ocurrencia en publicaciones del CSV de CRIS, verificada contra `utec_network_coauthorship_verified.json` (17 de 17 pares coinciden).
- Intermediación sobre la red ampliada: con solo coautoría, 5 de 92 investigadores tendrían valor mayor que cero.
- Métricas globales (herramienta Métricas): densidad, componentes, aislados, diámetro y camino medio de la componente mayor, clustering.
- Predicción: AUC con las coautorías reales como positivos y Adamic-Adar calculado sin la capa de coautoría (no circular).

## Limitaciones

- Las publicaciones de CRIS son una muestra (2500 registros) y no traen año válido; OpenAlex resuelve ambas cosas si se ejecuta el enriquecimiento.
- El scraper se probó contra HTML de ejemplo con la estructura del portal Pure; si UTEC cambia la plantilla hay que ajustar selectores.

## Guion de presentación (6 a 7 minutos)

1. Objetivo y datos (1 min): CRIS por scraping, estructura organizativa, NLP y por qué la red de coautoría sola es escasa.
2. Panorama (30 s): facultades, departamentos, fotos; cómo leer la vista.
3. T1 a T4 (4 min, 1 min cada una): pregunta, métrica, hallazgo, qué deben hacer los investigadores.
4. Producto (1 min): ficha de un profesor, sus recomendaciones y el reporte en PDF.
5. Decisiones de diseño y validación (30 s): color, posición, animación; AUC.

## Estructura

```
app.py                      Flask: vista, API, reporte, fichas, fotos, archivos
pipeline/scrape_cris.py     web scraping de cris.utec.edu.pe (perfiles, publicaciones, estructura, red)
pipeline/enrich_openalex.py enriquecimiento opcional con OpenAlex
pipeline/nlp.py             limpieza y similitud temática (TF-IDF)
pipeline/build_network.py   red, métricas, estructura, predicción y validación
pipeline/insights.py        hallazgos por tarea y por investigador
data/                       nodes, edges, affinity, meta, insights (JSON) y nodes/edges (CSV)
data/raw/                   datos de entrada (incluye organisations.json)
templates/                  vista, reporte y ficha
static/js/utecvis.js        módulo D3 de la red
static/js/app.js            tareas, herramientas flotantes y ficha
static/fonts, static/photos Montserrat local y caché de fotos
observable/                 celdas para prototipar en Observable
```


## Publicar en GitHub Pages

GitHub Pages solo sirve archivos (no ejecuta Python). `export_static.py` genera la carpeta `docs/` con todo el sitio:
la red, las fotos (incrustadas en `docs/data/graph.json`), los reportes como páginas (`reporte.html`,
`reporte/<departamento>.html`, `investigador/<id>.html`) y las propuestas de "Colaborar" para las parejas sugeridas
(`docs/data/colabora.json`). Si antes de exportar generaste ideas con el LLM en tu PC, se publican esas; para el resto,
el navegador arma ideas con reglas. **La clave de API nunca se publica.**

1. `python export_static.py`
2. Crear un repositorio público en github.com (por ejemplo `utecvis`) y subir el proyecto:
   ```
   git init
   git add .
   git commit -m "UtecVis"
   git branch -M main
   git remote add origin https://github.com/USUARIO/utecvis.git
   git push -u origin main
   ```
3. En GitHub: Settings, Pages, "Deploy from a branch", rama `main`, carpeta `/docs`, Save.
4. En 1 o 2 minutos queda en `https://USUARIO.github.io/utecvis/`.

Para actualizar: `python export_static.py`, luego `git add .`, `git commit -m "Actualización"` y `git push`.
