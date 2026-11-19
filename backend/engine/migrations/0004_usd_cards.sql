-- Bitnob USD virtual Visa cards. The card's balance lives at Bitnob (that's what Visa spends from);
-- the ledger records money moving between the user's Tappi balance and their card.
CREATE TABLE engine.usd_cards (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       text NOT NULL,
    -- Bitnob's card id, once Bitnob has answered.
    bitnob_card_id text UNIQUE,
    -- pending → active ⇄ frozen → terminated (or failed if Bitnob couldn't make it).
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'active', 'frozen', 'terminated', 'failed')),
    -- Which Tappi balance paid for it, and gets money back (withdrawals, termination refund).
    funding_asset  text NOT NULL REFERENCES engine.assets (code) CHECK (funding_asset IN ('USDT', 'USDC')),
    last4          text,
    -- The operation that created it.
    op_id          uuid REFERENCES engine.provider_ops (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One live card per user.
CREATE UNIQUE INDEX usd_cards_one_live_idx ON engine.usd_cards (owner_id) WHERE status IN ('pending', 'active', 'frozen');
