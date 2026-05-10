-- COMP-3.a: E-invoice format selector for the organisation.
--
-- Stores the user's chosen e-invoice output format. The XML emitter
-- (XRechnung / ZUGFeRD) is implemented in COMP-3.b; this column only
-- captures the selection so it can be persisted and surfaced in the UI.
ALTER TABLE settings_organization
  ADD COLUMN einvoice_format TEXT NOT NULL DEFAULT 'plain'
  CHECK (einvoice_format IN ('plain', 'zugferd', 'xrechnung'));
