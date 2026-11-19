-- Swaps through Bitnob's trading API. A quote is fetched first and kept here, so executing it uses
-- the amounts Bitnob quoted (never amounts sent by the app), and each quote is used at most once.
CREATE TABLE engine.trade_quotes (
    -- Bitnob's quote id.
    id             text PRIMARY KEY,
    owner_id       text NOT NULL,
    from_asset     text NOT NULL REFERENCES engine.assets (code),
    to_asset       text NOT NULL REFERENCES engine.assets (code),
    -- Smallest units: what the user pays, and what they get.
    send_amount    bigint NOT NULL CHECK (send_amount > 0),
    receive_amount bigint NOT NULL CHECK (receive_amount > 0),
    -- How the order must be placed at Bitnob (base/quote currency, side, quantity as Bitnob wrote it).
    order_request  jsonb NOT NULL,
    price          text,
    expires_at     timestamptz NOT NULL,
    -- Set when an order is placed with it.
    op_id          uuid REFERENCES engine.provider_ops (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (from_asset <> to_asset)
);

CREATE INDEX trade_quotes_owner_idx ON engine.trade_quotes (owner_id, created_at);
