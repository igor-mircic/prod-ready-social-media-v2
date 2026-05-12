CREATE TABLE follows (
    follower_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CONSTRAINT follows_no_self CHECK (follower_id <> followee_id)
);

CREATE INDEX follows_followee_follower_idx
    ON follows (followee_id, follower_id);
