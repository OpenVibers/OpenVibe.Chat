-- phase: expand
-- Durable results for the Chat-owned ingress. Keep separate from bridge_applied so J3 can
-- retire the Live bridge without losing retry protection for the replacement routes.
CREATE TABLE IF NOT EXISTS chat_ingress_applied (
    principal text COLLATE "C" NOT NULL,
    family text COLLATE "C" NOT NULL,
    key text COLLATE "C" NOT NULL,
    body_hash text COLLATE "C" NOT NULL,
    result text COLLATE "C" NOT NULL,
    delivered bigint NOT NULL DEFAULT 0,
    delivery_claimed_at bigint,
    applied_at bigint NOT NULL,
    PRIMARY KEY (principal, family, key)
);
