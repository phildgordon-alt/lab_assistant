-- 001_state_history.sql
--
-- Audit log for every write attempt against the jobs table (and, in the
-- future, other entities). Written by server/domain/jobs-repo.js inside the
-- same transaction as the underlying jobs UPDATE/INSERT, so the log can
-- never disagree with what actually happened.
--
-- Captures both APPLIED writes (changes_json populated) and FULLY REJECTED
-- writes (changes_json empty, skipped_json + reason_json populated). This
-- lets you answer "why isn't the trace adapter flipping invoice 12345?"
-- by reading the audit trail of attempted writes — even ones that wrote
-- nothing to jobs.

CREATE TABLE IF NOT EXISTS state_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,             -- 'jobs' for now; future: 'tray', 'batch'
  entity_id     TEXT NOT NULL,             -- invoice for jobs rows
  source        TEXT NOT NULL,             -- one of jobs-contract.SOURCES
  actor         TEXT NOT NULL,             -- writer module name (e.g. 'dvi-trace.js')
  prev_status   TEXT,                      -- jobs.status before write (NULL on first INSERT)
  next_status   TEXT,                      -- jobs.status after write
  prev_stage    TEXT,                      -- current_stage before
  next_stage    TEXT,                      -- current_stage after
  changes_json  TEXT NOT NULL,             -- JSON of fields that landed (may be '{}')
  skipped_json  TEXT,                      -- JSON array of fields the contract refused
  reason_json   TEXT,                      -- JSON {field: reason-code}
  metadata_json TEXT,                      -- caller-supplied context (e.g. {file: 'shiplog.xml'})
  observed_at   INTEGER NOT NULL,          -- ms — caller's event time (NOT Date.now())
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Forensic queries: "show me everything that touched invoice X, newest first"
CREATE INDEX IF NOT EXISTS idx_sh_entity ON state_history(entity_type, entity_id, recorded_at);

-- "what has writer Y been doing?"
CREATE INDEX IF NOT EXISTS idx_sh_source ON state_history(source, recorded_at);

-- "events around timestamp T"
CREATE INDEX IF NOT EXISTS idx_sh_observed ON state_history(observed_at);
