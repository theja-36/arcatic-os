-- Arcatic Marketing OS — 0019 Push receipts in their own column
--
-- The service worker reports "displayed" / "clicked" at the same moment the notifier is still
-- writing its own delivery outcome. Sharing one jsonb column made the later write overwrite the
-- earlier one (found on local staging). Receipts now live in `receipts`, written only by the
-- receipt endpoint; `delivery` stays the server-side outcome (push status, email).
alter table public.notifications add column receipts jsonb not null default '{}'::jsonb;
