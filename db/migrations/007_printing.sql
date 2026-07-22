-- =============================================================================
-- BFC24 WMS v2 — Migration 007: Printing System
-- =============================================================================
BEGIN;

CREATE TYPE wms.printer_connection AS ENUM ('agent', 'network', 'usb');
CREATE TYPE wms.print_job_status AS ENUM ('new', 'processing', 'printed', 'error', 'cancelled');

CREATE TABLE wms.printers (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         REFERENCES wms.warehouses(id),
  printer_code    TEXT        NOT NULL,
  printer_name    TEXT        NOT NULL,
  printer_type    TEXT        NOT NULL DEFAULT 'label',
  connection_type wms.printer_connection NOT NULL DEFAULT 'agent',
  agent_code      TEXT,
  device_name     TEXT,
  ip_address      TEXT,
  port            INT,
  zone_code       TEXT,
  is_default      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, printer_code)
);

CREATE INDEX idx_printers_tenant    ON wms.printers(tenant_id);
CREATE INDEX idx_printers_warehouse ON wms.printers(warehouse_id);
CREATE INDEX idx_printers_active    ON wms.printers(tenant_id, is_active);

CREATE TRIGGER trg_printers_updated_at
  BEFORE UPDATE ON wms.printers
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

CREATE TABLE wms.printer_routes (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  route_code      TEXT        NOT NULL,
  doc_type        TEXT        NOT NULL,  -- wb_sticker | shipping_qr | inbound_label | etc.
  warehouse_id    INT         REFERENCES wms.warehouses(id),
  zone_code       TEXT,
  client_id       INT         REFERENCES wms.clients(id),
  printer_id      INT         NOT NULL REFERENCES wms.printers(id),
  is_default      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, route_code)
);

CREATE INDEX idx_printer_routes_tenant   ON wms.printer_routes(tenant_id);
CREATE INDEX idx_printer_routes_doc_type ON wms.printer_routes(tenant_id, doc_type, is_active);

CREATE TRIGGER trg_printer_routes_updated_at
  BEFORE UPDATE ON wms.printer_routes
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

CREATE TABLE wms.print_jobs (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  job_code        TEXT        NOT NULL UNIQUE,
  printer_id      INT         NOT NULL REFERENCES wms.printers(id),
  route_id        INT         REFERENCES wms.printer_routes(id),
  doc_type        TEXT        NOT NULL,
  entity_type     TEXT,       -- shipment | picking_task | inbound_order
  entity_id       BIGINT,
  copies          SMALLINT    NOT NULL DEFAULT 1,
  payload_json    JSONB       NOT NULL DEFAULT '{}',
  status          wms.print_job_status NOT NULL DEFAULT 'new',
  error_text      TEXT,
  attempt_count   SMALLINT    NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  printed_at      TIMESTAMPTZ,
  created_by      INT         REFERENCES wms.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_print_jobs_tenant   ON wms.print_jobs(tenant_id);
CREATE INDEX idx_print_jobs_printer  ON wms.print_jobs(printer_id, status);
CREATE INDEX idx_print_jobs_status   ON wms.print_jobs(status, created_at) WHERE status IN ('new', 'error');
CREATE INDEX idx_print_jobs_entity   ON wms.print_jobs(entity_type, entity_id) WHERE entity_type IS NOT NULL;

CREATE TRIGGER trg_print_jobs_updated_at
  BEFORE UPDATE ON wms.print_jobs
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

COMMIT;
