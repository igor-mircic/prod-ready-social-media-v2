CREATE TABLE auth_access_tokens (
    id          UUID         PRIMARY KEY,
    user_id     UUID         NOT NULL REFERENCES users(id),
    token_hash  TEXT         NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ  NULL
);

CREATE INDEX idx_auth_access_tokens_token_hash ON auth_access_tokens (token_hash);

CREATE TABLE auth_refresh_tokens (
    id          UUID         PRIMARY KEY,
    user_id     UUID         NOT NULL REFERENCES users(id),
    token_hash  TEXT         NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ  NULL,
    replaced_by UUID         NULL REFERENCES auth_refresh_tokens(id)
);

CREATE INDEX idx_auth_refresh_tokens_token_hash ON auth_refresh_tokens (token_hash);
