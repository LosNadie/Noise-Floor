-- Readers who signed in with Q助理. The session itself is a signed cookie (see
-- packages/contracts/src/site-session.ts), so this table is not what admits them: it is the record of
-- who has ever signed in, which the console lists and the reader's own profile is refreshed from.

CREATE TABLE qz_users (
  q_uid              text PRIMARY KEY,
  nickname           text,
  avatar_url         text,
  -- Only ever filled when the application asks for the phone scope and the reader agreed that time.
  phone              text,
  is_connected_agent boolean NOT NULL DEFAULT false,
  first_login_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz NOT NULL DEFAULT now(),
  login_count        integer NOT NULL DEFAULT 1
);

CREATE INDEX qz_users_last_login_idx ON qz_users (last_login_at DESC);
