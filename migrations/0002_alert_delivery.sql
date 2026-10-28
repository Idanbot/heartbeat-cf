ALTER TABLE devices ADD COLUMN alert_claim_token TEXT;
ALTER TABLE devices ADD COLUMN alert_claim_until TEXT;
ALTER TABLE devices ADD COLUMN alert_retry_at TEXT;
ALTER TABLE devices ADD COLUMN alert_attempts INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_devices_last_healthy_timestamp;
DROP INDEX IF EXISTS idx_devices_heartbeat;

CREATE INDEX idx_devices_pending_alerts
  ON devices(COALESCE(last_healthy_timestamp, unavailable_since_timestamp, last_timestamp), id)
  WHERE alert_sent_at IS NULL;
