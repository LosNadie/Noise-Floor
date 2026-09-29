-- Reader topic subscriptions for the daily Q助理 push.
-- One row per signed-in reader who opted in; `topics` holds the topic slugs they care about
-- (an empty array means "everything"). The digest job (worker schedule "qz.subscription.digest",
-- 08:30 Asia/Shanghai) reads this table once a morning and pushes each reader a personal digest.

CREATE TABLE qz_subscriptions (
  q_uid          text PRIMARY KEY REFERENCES qz_users (q_uid) ON DELETE CASCADE,
  topics         text[] NOT NULL DEFAULT '{}',
  enabled        boolean NOT NULL DEFAULT true,
  -- Beijing date (YYYY-MM-DD) of the last digest that was booked for this reader, so re-runs
  -- and mid-day crashes never lead to a double send.
  last_push_date text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per message we attempted, keyed by the platform idempotency id we generated.
CREATE TABLE qz_pushes (
  message_id text PRIMARY KEY,
  q_uid      text NOT NULL,
  date_key   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('sent', 'failed')),
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX qz_pushes_date_idx ON qz_pushes (date_key);
