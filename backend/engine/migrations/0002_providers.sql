-- Talking to money providers (Paga, Bitnob). Everything the engine sends or receives is written
-- down before it's acted on, so a restart, a timeout or a repeated webhook never loses or doubles money.

-- Accounts a provider holds for one of our users: a Paga NUBAN, a Bitnob deposit address. Incoming
-- money is matched to the user through this table.
CREATE TABLE engine.provider_accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider    text NOT NULL CHECK (provider IN ('paga', 'bitnob')),
    owner_id    text NOT NULL,
    -- 'nuban' (bank account number) or 'address' (crypto deposit address).
    kind        text NOT NULL CHECK (kind IN ('nuban', 'address')),
    asset       text NOT NULL REFERENCES engine.assets (code),
    -- For crypto: the chain (tron, ethereum, bitcoin…). Null for bank accounts.
    network     text,
    -- What the provider calls it: the account number, the address, or the provider's own id.
    external_id text NOT NULL,
    -- Shown to the user: account number + bank name, or the address (+ memo/tag where needed).
    details     jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id),
    UNIQUE (provider, owner_id, kind, asset, network)
);

-- A provider's own record of one of our users (Bitnob customers: needed before an address is issued).
CREATE TABLE engine.provider_customers (
    provider    text NOT NULL CHECK (provider IN ('paga', 'bitnob')),
    owner_id    text NOT NULL,
    external_id text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, owner_id),
    UNIQUE (provider, external_id)
);

-- One row per operation we ask a provider to do (a payout, an address, a trade). The idempotency
-- key is ours and is also sent to the provider where it supports one, so a retry is the same request.
--   created → submitted → pending → succeeded | failed
-- `pending` means the provider accepted it but hasn't finished; a webhook or a status check settles it.
CREATE TABLE engine.provider_ops (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider           text NOT NULL CHECK (provider IN ('paga', 'bitnob')),
    kind               text NOT NULL,
    idempotency_key    text NOT NULL UNIQUE,
    status             text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'submitted', 'pending', 'succeeded', 'failed')),
    owner_id           text,
    asset              text REFERENCES engine.assets (code),
    amount             bigint,
    -- Money reserved while the operation is in flight (payouts).
    hold_id            uuid REFERENCES engine.holds (id),
    -- The provider's id for it, once known.
    provider_reference text,
    request            jsonb NOT NULL DEFAULT '{}',
    response           jsonb,
    error              text,
    attempts           integer NOT NULL DEFAULT 0,
    -- When the background checker should next ask the provider about it.
    next_check_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_ops_open_idx ON engine.provider_ops (next_check_at)
    WHERE status IN ('submitted', 'pending');
CREATE INDEX provider_ops_reference_idx ON engine.provider_ops (provider, provider_reference);

-- Every webhook, stored raw before anything is done with it. The provider's own event id makes a
-- repeated delivery a no-op.
CREATE TABLE engine.webhook_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider     text NOT NULL CHECK (provider IN ('paga', 'bitnob')),
    event_id     text NOT NULL,
    event_type   text,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    -- Why it couldn't be applied (unknown account, bad data); kept for a person to look at.
    error        text,
    UNIQUE (provider, event_id)
);

CREATE INDEX webhook_events_unprocessed_idx ON engine.webhook_events (received_at) WHERE processed_at IS NULL;

-- What happened to a user that the app should hear about (a deposit landed, a payout finished),
-- in order. The API reads it with GET /v1/events?after=<id> and turns it into activity and alerts.
CREATE TABLE engine.events (
    id         bigserial PRIMARY KEY,
    owner_id   text NOT NULL,
    kind       text NOT NULL,
    payload    jsonb NOT NULL,
    -- Makes recording the same event twice (a repeated webhook) a no-op.
    dedupe_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
