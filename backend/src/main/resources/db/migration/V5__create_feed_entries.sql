CREATE TABLE feed_entries (
    recipient_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id       UUID         NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id     UUID         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY (recipient_id, post_id)
);

CREATE INDEX feed_entries_read_idx
    ON feed_entries (recipient_id, created_at DESC, post_id DESC);

CREATE INDEX feed_entries_author_idx
    ON feed_entries (recipient_id, author_id);
