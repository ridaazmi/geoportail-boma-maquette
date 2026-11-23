# Géoportail de Boma : maquette de démonstration

**Démo en ligne : https://ridaazmi.github.io/geoportail-boma-maquette/**

Maquette interactive à joindre à l'offre technique. Elle tourne sur des **données réelles de Boma** :
- voirie et bâti : OpenStreetMap ;
- établissements de santé : GRID3 RDC v9.0 ;
- relief : SRTM.

## Lancer la démo

Un navigateur et une connexion internet suffisent (pour les fonds de carte et les bibliothèques).

```powershell
python -m http.server 8765 --directory "D:\PRESTATIONS\UrbanAnalyse_GOMA\demo_geoportail\web"
```

Ouvrir ensuite http://localhost:8765.

Les données sont chargées en `<script>`, donc un double-clic sur `web/index.html` devrait aussi fonctionner (non testé). Le serveur local reste la méthode sûre.

## Ce que la maquette démontre (correspondance avec les TDR)

| Exigence des TDR | Dans la maquette |
|---|---|
| Couches structurées par thème | Onglet **Couches** : mobilité, équipements, habitat, risques, aide à la décision, limites, saisies |
| Interface simplifiée, dialogues guidés, fiches préremplies | **+ Nouvelle saisie** : assistant en 4 étapes, avec date, agent, secteur, voie proche et altitude remplis automatiquement, et des champs obligatoires contrôlés. Fiche **voirie** modifiable depuis la carte |
| AMC pour prioriser les investissements | Onglet **Analyse multicritère** : 4 scénarios (équipements, assainissement, voirie, déchets), poids ajustables, contraintes éliminatoires, classement des secteurs, score expliqué maille par maille |
| Dimensions environnement, climat, social, genre | Critères dédiés : inondation, érosion, isolement piéton (genre et inclusion) |
| Suivi de critères objectifs | Onglet **Indicateurs** : accès aux soins, exposition aux risques, linéaire de voirie |
| Rapports automatiques | Onglet **Rapports** : 4 rapports thématiques, ville entière ou par secteur, à imprimer en PDF ou à télécharger en Word |
| Scénarios stratégiques | Enregistrement, rechargement et **comparaison** de scénarios |
| Accès interne et accès partenaires | Sélecteur **Profil** : administrateur Mairie ou ANAT (édition), partenaire (lecture seule) |
| OGC et QGIS | Bouton **Services OGC / QGIS** : adresses WMS/WFS/WCS (illustratives) et export GeoJSON réel |
| Aide-mémoire intégré | Infobulles (i) et **visite guidée** (bouton « ? Aide ») |
| Traçabilité | **Journal des modifications** (onglet Rapports) |

## Limites (à annoncer honnêtement lors de la présentation)
- Les saisies et modifications sont stockées dans le navigateur (`localStorage`). En production, elles iront dans PostGIS, avec un historique.
- Les distances sont mesurées à vol d'oiseau. En production, ce seront des distances sur le réseau (pgRouting).
- « Inondation » et « isolement piéton » sont des **proxys** : ils seront remplacés par les données des études (modélisation hydrologique, enquêtes ménages).
- Les sources ouvertes ne recensent que 4 écoles. C'est justement l'un des arguments en faveur de l'inventaire de la phase 2.
- Les secteurs sont approchés à partir des aires de santé GRID3. Ils seront remplacés par les limites officielles des quartiers.

## Catalogue des données de la phase 1

Les couches sont organisées selon le catalogue des données collectées par Urban Analyse (7 catégories). Le tableau complet est consultable dans l'application : **À propos**, ou le lien **Catalogue des données** en pied de page. Pour chaque couche, il indique si un aperçu existe à partir de données ouvertes, ou si la couche reste « à intégrer » depuis la collecte.

| Catégorie | Aperçu dans la maquette (sources ouvertes) |
|---|---|
| 01. Limites administratives | Limite de la ville (OSM), quartiers approchés (localités GRID3) ; communes à intégrer |
| 02. Infrastructures de transport | Voirie (OSM), gare, port et aérodrome (OSM, Overture) |
| 03. Équipements administratifs et sécuritaires | 1 équipement (OSM) ; postes de police à intégrer |
| 04. Équipements et services collectifs | Santé (GRID3), écoles, sport, culture, tourisme (OSM, Overture) |
| 05. Activités économiques | Marché, commerces et services (OSM, Overture) |
| 06. Environnement et occupation du sol | Espaces verts (Overture / ESA WorldCover), zones d'érosion (pente du MNT), occupation urbaine (OSM) ; cimetières à intégrer |
| 07. Fonds cartographiques | Fond satellite (Esri), MNT ombré (SRTM) ; relevé drone à intégrer |

L'en-tête et le pied de page portent les logos de la Mairie de Boma, de l'ANAT et d'Expertise France (dossier `web/img`), la mention « Propulsé par Urban Analyse » et le contact.

## Régénérer les données (scripts ETL modifiables)

```powershell
pip install numpy shapely pillow requests duckdb
cd scripts
python 01_extract_osm.py        # OpenStreetMap (Overpass)
python 02_extract_dem.py        # MNT (tuiles Terrarium / SRTM)
python 03_extract_overture.py   # lieux Overture (complément, facultatif)
python 04_build_dataset.py      # intégration + grille de critères -> web/data/boma_data.js
python 05_extract_catalogue.py  # couches complémentaires OSM + Overture (catalogue phase 1)
python 06_build_catalogue.py    # couches du catalogue + MNT ombré -> web/data/boma_catalogue.js
```

`06_build_catalogue.py` utilise aussi `data_raw/grid3_settlements.gpkg` (HDX : *GRID3 COD – Settlement Names v9.0*).

Les données GRID3 (`data_raw/grid3_health.gpkg`) viennent de HDX : *GRID3 COD – Health Facilities v9.0*.

## Structure
```
demo_geoportail/
├─ scripts/     ETL Python (extraction, intégration, critères AMC)
├─ data_raw/    données sources téléchargées
└─ web/         application (index.html, css/, js/app.js, data/boma_data.js)
```
