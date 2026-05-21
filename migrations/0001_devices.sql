CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  heartbeat INTEGER NOT NULL CHECK (heartbeat IN (0, 1)),
  last_timestamp TEXT NOT NULL,
  last_healthy_timestamp TEXT,
  unavailable_since_timestamp TEXT,
  alert_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_last_healthy_timestamp
  ON devices(last_healthy_timestamp);

CREATE INDEX IF NOT EXISTS idx_devices_heartbeat
  ON devices(heartbeat);
