#!/usr/bin/env python3
"""
Génère data/streets.json.gz : les rues de Paris intra-muros (OpenStreetMap),
découpées en tronçons, avec nom et arrondissement.

Aucune dépendance : Python 3.8+ suffit.

    python3 scripts/build_streets.py               # télécharge via Overpass
    python3 scripts/build_streets.py --avec-bois   # garde les bois de Boulogne et Vincennes

Format de sortie (JSON compressé gzip) :
{
  "v": "<empreinte>",          # change à chaque génération → l'app recalcule
  "date": "AAAA-MM-JJ",
  "names": ["Rue de Rivoli", ...],
  "seg": [[iNom, arrondissement, x0, y0, dx1, dy1, ...], ...]
}
Coordonnées en entiers (degrés × 1e5), la première absolue, les suivantes en delta.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
UA = "rues-de-paris/1.0 (script de generation, https://github.com)"
PARIS_AREA = 3600007444  # relation OSM 7444 (commune de Paris)

HIGHWAYS = [
    "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
    "unclassified", "residential", "living_street", "pedestrian", "footway", "path",
    "steps", "service", "track", "cycleway",
]
MAX_SEG_M = 200  # longueur maximale d'un tronçon
MIN_SEG_M = 2    # tronçons plus courts ignorés
SCALE = 1e5

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "streets.json.gz")


def fetch(endpoint, data):
    """POST via urllib, puis via curl si le SSL de Python est trop ancien (macOS)."""
    try:
        req = urllib.request.Request(endpoint, data=data, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=400) as r:
            return r.read()
    except urllib.error.URLError as e:
        if "SSL" not in str(e) or not shutil.which("curl"):
            raise
        out = subprocess.run(["curl", "-sS", "--fail", "--max-time", "400", "-A", UA, "--data-binary", "@-", endpoint],
                             input=data, capture_output=True)
        if out.returncode:
            raise RuntimeError(out.stderr.decode().strip())
        return out.stdout


def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(6):
        for endpoint in OVERPASS:
            try:
                print(f"→ requête Overpass ({endpoint})…", file=sys.stderr)
                raw = json.loads(fetch(endpoint, data))
                if not raw.get("elements"):
                    raise RuntimeError(raw.get("remark") or "réponse vide")
                return raw
            except Exception as e:  # serveur saturé : on réessaie ailleurs
                last = e
                print(f"  échec : {str(e)[:200]}", file=sys.stderr)
        time.sleep(min(300, 15 * 2 ** attempt))
    raise SystemExit(f"Overpass indisponible : {last}\n"
                     "Réessayez plus tard, ou utilisez --osm avec un extrait .osm/.osm.gz (voir README).")


def build_query(with_woods):
    hw = "|".join(HIGHWAYS)
    woods = "" if with_woods else """
  way(area.paris)["name"~"^Bois de (Boulogne|Vincennes)$"]["leisure"="park"];
  relation(area.paris)["name"~"^Bois de (Boulogne|Vincennes)$"]["leisure"="park"];
"""
    excl = "" if with_woods else """
(.woods; map_to_area;)->.woodsArea;
way.all(area.woodsArea)->.inWoods;
(.all; - .inWoods;)->.all;
"""
    return f"""
[out:json][timeout:300];
area({PARIS_AREA})->.paris;
way(area.paris)["highway"~"^({hw})$"]["name"]
  ["area"!="yes"]["tunnel"!="yes"]["access"!~"^(private|no)$"]
  ["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(parking_aisle|driveway|drive-through)$"]->.all;
({woods})->.woods;
{excl}
.all out body geom qt;
relation(area.paris)["boundary"="administrative"]["admin_level"="9"];
out body geom qt;
"""


# --- géométrie -------------------------------------------------------------

LAT0 = 48.8566
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def dist(a, b):
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)


def length(pts):
    return sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def point_at(pts, d):
    for i in range(len(pts) - 1):
        l = dist(pts[i], pts[i + 1])
        if d <= l or i == len(pts) - 2:
            t = 0 if l == 0 else min(1, d / l)
            return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t)
        d -= l
    return pts[-1]


def cut(pts, d0, d1):
    """Sous-polyligne entre les abscisses curvilignes d0 et d1."""
    out = [point_at(pts, d0)]
    acc = 0
    for i in range(len(pts) - 1):
        acc += dist(pts[i], pts[i + 1])
        if d0 < acc < d1:
            out.append(pts[i + 1])
    out.append(point_at(pts, d1))
    return out


def assemble_rings(ways):
    """Assemble des morceaux de contour (listes de points) en anneaux fermés."""
    ways = [list(w) for w in ways if len(w) > 1]
    rings = []
    while ways:
        ring = ways.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[::-1][1:]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[::-1][:-1] + ring
                else:
                    continue
                ways.pop(i)
                changed = True
                break
        rings.append(ring)
    return rings


def in_ring(p, ring):
    x, y = p
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# --- programme principal ---------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--avec-bois", action="store_true", help="inclure les bois de Boulogne et de Vincennes")
    ap.add_argument("--entree", help="réutiliser une réponse Overpass déjà téléchargée (JSON)")
    ap.add_argument("--brut", help="enregistrer aussi la réponse Overpass brute dans ce fichier")
    ap.add_argument("--sortie", default=OUT)
    args = ap.parse_args()

    if args.entree:
        with open(args.entree) as f:
            raw = json.load(f)
    else:
        raw = overpass(build_query(args.avec_bois))
        if args.brut:
            with open(args.brut, "w") as f:
                json.dump(raw, f)

    ways = [e for e in raw["elements"] if e["type"] == "way" and "geometry" in e]
    rels = [e for e in raw["elements"] if e["type"] == "relation"]
    print(f"{len(ways)} voies, {len(rels)} arrondissements", file=sys.stderr)

    # Arrondissements (polygones)
    arrs = []
    for r in rels:
        insee = r.get("tags", {}).get("ref:INSEE", "")
        if not insee.startswith("751"):
            continue
        outer = [[(g["lon"], g["lat"]) for g in m["geometry"]] for m in r["members"]
                 if m["type"] == "way" and m.get("role") in ("outer", "") and "geometry" in m]
        rings = assemble_rings(outer)
        bbox = (min(p[0] for r_ in rings for p in r_), min(p[1] for r_ in rings for p in r_),
                max(p[0] for r_ in rings for p in r_), max(p[1] for r_ in rings for p in r_))
        arrs.append((int(insee[-2:]), rings, bbox))
    if len(arrs) != 20:
        print(f"⚠ {len(arrs)} arrondissements trouvés au lieu de 20", file=sys.stderr)

    def arrondissement(p):
        for num, rings, bb in arrs:
            if bb[0] <= p[0] <= bb[2] and bb[1] <= p[1] <= bb[3] and any(in_ring(p, r_) for r_ in rings):
                return num
        best = min(arrs, key=lambda a: min(dist(p, q) for r_ in a[1] for q in r_[::5]), default=None)
        return best[0] if best else 0

    # Intersections : un nœud partagé par plusieurs voies (ou deux fois par la même) coupe le tronçon.
    usage = {}
    for w in ways:
        for i, n in enumerate(w["nodes"]):
            usage[n] = usage.get(n, 0) + (2 if i in (0, len(w["nodes"]) - 1) else 1)

    names, name_idx, segs = [], {}, []
    for w in ways:
        name = w["tags"]["name"].strip()
        if name not in name_idx:
            name_idx[name] = len(names)
            names.append(name)
        geom = [(g["lon"], g["lat"]) for g in w["geometry"]]
        nodes = w["nodes"]
        pieces, start = [], 0
        for i in range(1, len(nodes)):
            if i == len(nodes) - 1 or usage.get(nodes[i], 0) > 1:
                pieces.append(geom[start:i + 1])
                start = i
        for piece in pieces:
            L = length(piece)
            if L < MIN_SEG_M:
                continue
            k = max(1, math.ceil(L / MAX_SEG_M))
            for j in range(k):
                sub = piece if k == 1 else cut(piece, L * j / k, L * (j + 1) / k)
                mid = point_at(sub, length(sub) / 2)
                segs.append((name_idx[name], arrondissement(mid), sub))

    # Encodage compact
    out_segs = []
    for ni, arr, pts in segs:
        q = [(round(x * SCALE), round(y * SCALE)) for x, y in pts]
        dedup = [q[0]] + [q[i] for i in range(1, len(q)) if q[i] != q[i - 1]]
        if len(dedup) < 2:
            continue
        row = [ni, arr, dedup[0][0], dedup[0][1]]
        for i in range(1, len(dedup)):
            row += [dedup[i][0] - dedup[i - 1][0], dedup[i][1] - dedup[i - 1][1]]
        out_segs.append(row)
    out_segs.sort(key=lambda r: (r[1], names[r[0]]))

    body = {"names": names, "seg": out_segs}
    digest = hashlib.sha1(json.dumps(body, separators=(",", ":")).encode()).hexdigest()[:12]
    doc = {"v": digest, "date": time.strftime("%Y-%m-%d"), **body}
    payload = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    os.makedirs(os.path.dirname(args.sortie), exist_ok=True)
    with open(args.sortie, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(payload)

    km = sum(length(s[2]) for s in segs) / 1000
    print(f"✓ {len(out_segs)} tronçons, {len(names)} rues, {km:.0f} km → {args.sortie} "
          f"({os.path.getsize(args.sortie) / 1e6:.1f} Mo, brut {len(payload) / 1e6:.1f} Mo)", file=sys.stderr)


if __name__ == "__main__":
    main()
