-- 014_normalize_emails.sql
-- Normalize existing emails to lowercase and trimmed.
-- UPDATE OR IGNORE is used to avoid crashing if normalization creates duplicates
-- (e.g., if 'Owner@' and 'owner@' both existed, they would conflict on the UNIQUE constraint,
-- so we just ignore the conflict and leave the latter one as is).

UPDATE OR IGNORE users SET email = lower(trim(email));
UPDATE OR IGNORE invitations SET email = lower(trim(email)) WHERE email IS NOT NULL;
