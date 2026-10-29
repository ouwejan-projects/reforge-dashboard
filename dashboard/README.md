# Dashboard-modules (maatwerk)

Alles wat hier staat verschijnt als klant-module in het dashboard van deze organisatie.

- Eigen pagina:  dashboard/pages/<naam>/index.html   (eigen item in de zijbalk, sectie "Maatwerk")
- Widget:        dashboard/widgets/<naam>.html       (onder "Maatwerk" op de startpagina)

De eigenaar zet elke module aan/uit bij Instellingen -> Onderdelen -> Klant-modules.
Zelfstandige HTML/CSS/JS, geen build-stap. <naam>: kleine letters, cijfers en streepjes
(geen dashboard-namen zoals settings, api, usage, report, security). Eigen css/js/plaatjes
in dezelfde map, relatief ernaar verwijzen. Maximaal 5 MB per bestand. Commit je werk hier.
Optioneel: dashboard/manifest.json met { "pages": [{ "slug", "title", "description", "icon" }],
"widgets": [{ "slug", "title", "height" }] }. icon: Puzzle (standaard), LayoutDashboard, BarChart3,
Table, FileText, Calendar, Users, Wrench, Star.
