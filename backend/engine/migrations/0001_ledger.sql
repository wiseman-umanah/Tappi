-- Tappi's double-entry ledger. The engine is the only writer; every table lives in schema `engine`.
-- Amounts are integers in each asset's smallest unit (kobo, micro-dollars, satoshis).

CREATE SCHEMA IF NOT EXISTS engine;

CREATE TABLE engine.assets (
    code     text PRIMARY KEY,
    decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    kind     text NOT NULL CHECK (kind IN ('fiat', 'crypto'))
);

INSERT INTO engine.assets (code, decimals, kind) VALUES
    ('NGN', 2, 'fiat'),
    ('USDT', 6, 'crypto'),
    ('USDC', 6, 'crypto'),
    ('BTC', 8, 'crypto');

-- One account per owner per asset. owner_type 'user' = a Tappi user (owner_id is their app user id);
-- 'system' = Tappi's own books (provider clearing, fees, unclaimed funds, sandbox mint).
-- balance is the posted total; held is reserved by active holds; available = balance - held.
CREATE TABLE engine.accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type     text NOT NULL CHECK (owner_type IN ('user', 'system')),
    owner_id       text NOT NULL,
    asset          text NOT NULL REFERENCES engine.assets (code),
    balance        bigint NOT NULL DEFAULT 0,
    held           bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
    -- Only system accounts (clearing, mint) may go below zero.
    allow_negative boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_type, owner_id, asset),
    UNIQUE (id, asset),
    CHECK (allow_negative OR balance - held >= 0),
    CHECK (owner_type = 'system' OR NOT allow_negative)
);

-- One row per money movement. The idempotency key makes retries safe: the same key with the same
-- request returns the original entry; the same key with a different request is refused.
CREATE TABLE engine.journal_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key text NOT NULL UNIQUE,
    request_hash    text NOT NULL,
    kind            text NOT NULL,
    reference       text,
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine.postings (
    id         bigserial PRIMARY KEY,
    entry_id   uuid NOT NULL REFERENCES engine.journal_entries (id),
    account_id uuid NOT NULL,
    asset      text NOT NULL,
    amount     bigint NOT NULL CHECK (amount <> 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (account_id, asset) REFERENCES engine.accounts (id, asset)
);

CREATE INDEX postings_entry_idx ON engine.postings (entry_id);
CREATE INDEX postings_account_idx ON engine.postings (account_id, id);

-- Last line of defence: at commit, every entry's postings must sum to zero for each asset.
CREATE FUNCTION engine.check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM engine.postings WHERE entry_id = NEW.entry_id
        GROUP BY asset HAVING sum(amount) <> 0
    ) THEN
        RAISE EXCEPTION 'journal entry % does not balance', NEW.entry_id;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER postings_balanced
    AFTER INSERT ON engine.postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION engine.check_entry_balanced();

-- Ledger rows are never edited or deleted; corrections are new entries.
CREATE FUNCTION engine.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON engine.journal_entries
    FOR EACH ROW EXECUTE FUNCTION engine.forbid_change();
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON engine.postings
    FOR EACH ROW EXECUTE FUNCTION engine.forbid_change();

-- Money reserved for something not yet final (a pending payout, a charge awaiting capture).
-- active → captured (the money moved, see entry_id) or released (given back).
CREATE TABLE engine.holds (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key text NOT NULL UNIQUE,
    request_hash    text NOT NULL,
    account_id      uuid NOT NULL REFERENCES engine.accounts (id),
    amount          bigint NOT NULL CHECK (amount > 0),
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'released')),
    reference       text,
    entry_id        uuid REFERENCES engine.journal_entries (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz
);

CREATE INDEX holds_account_idx ON engine.holds (account_id) WHERE status = 'active';
