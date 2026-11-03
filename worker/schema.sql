-- Schéma D1 pour le récepteur Overland.
-- À exécuter une seule fois (console D1 du tableau de bord Cloudflare ou `wrangler d1 execute`).

CREATE TABLE IF NOT EXISTS points (
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- curseur de synchronisation
  device    TEXT    NOT NULL DEFAULT '',
  ts        INTEGER NOT NULL,                  -- horodatage en millisecondes (UTC)
  lat       REAL    NOT NULL,
  lon       REAL    NOT NULL,
  acc       REAL,                              -- précision horizontale (m)
  speed     REAL,                              -- vitesse (m/s), -1 si inconnue
  motion    TEXT,                              -- activité iOS : walking, running, driving…
  received  INTEGER NOT NULL                   -- date de réception (ms)
);

-- Dédoublonnage : un seul point par appareil et par instant.
CREATE UNIQUE INDEX IF NOT EXISTS points_device_ts ON points (device, ts);
