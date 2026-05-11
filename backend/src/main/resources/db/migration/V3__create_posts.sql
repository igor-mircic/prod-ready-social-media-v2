CREATE TABLE posts (
    id          UUID         PRIMARY KEY,
    author_id   UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body        TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ  NULL
);

CREATE INDEX posts_author_created_idx
    ON posts (author_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;
