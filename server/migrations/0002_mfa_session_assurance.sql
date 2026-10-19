CREATE TABLE IF NOT EXISTS user_mfa_sessions (
  session_id text PRIMARY KEY REFERENCES "session"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  mfa_enabled_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_mfa_sessions_user_id_idx ON user_mfa_sessions(user_id);
