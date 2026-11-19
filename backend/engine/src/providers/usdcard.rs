//! Bitnob USD virtual Visa cards (prepaid). See backend/docs/bitnob.md.
//!
//! - Card KYC first (Bitnob: "no approval means no card"). BVN or NIN is verified instantly.
//! - The user pays for the card, top-ups and fees from their USDT or USDC (1 USD = 1,000,000
//!   micro-units, the same as those coins' smallest units). Their balance is held, and moves to
//!   Bitnob's clearing account when Bitnob confirms; it comes back on failure.
//! - The card's own balance lives at Bitnob and is read from Bitnob; withdrawals and the refund on
//!   termination are credited back to the user's USDT or USDC.
//!
//! Card details (number, CVV, expiry) are fetched from Bitnob when asked for and never stored.

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::bitnob::{BitnobConfig, BitnobError, call};
use super::{NewPayout, Op, Provider, emit_event, signed_text};
use crate::error::LedgerError;
use crate::ledger::{self, Owner, TransferRequest};
use crate::providers;

/// What a card costs the user, in micro-dollars. Defaults are Bitnob's published fees; set them in
/// .env (CARD_*_FEE_*) when Bitnob's prices or your agreement change. The app shows these numbers.
#[derive(Clone, Debug, Serialize)]
pub struct CardFees {
    /// Charged once when the card is made.
    pub creation: i64,
    /// Per top-up below `percent_from`.
    pub topup_flat: i64,
    /// Per top-up from `percent_from` up, in hundredths of a percent (100 = 1%).
    pub topup_percent_bps: i64,
    pub percent_from: i64,
}

impl Default for CardFees {
    fn default() -> Self {
        Self {
            creation: 1_000_000,
            topup_flat: 1_000_000,
            topup_percent_bps: 100,
            percent_from: 100_000_000,
        }
    }
}

impl CardFees {
    pub fn topup(&self, amount: i64) -> i64 {
        if amount < self.percent_from {
            self.topup_flat
        } else {
            // Rounded up: the user never pays less than the fee Tappi is charged.
            (amount * self.topup_percent_bps + 9_999) / 10_000
        }
    }
}

pub const MIN_LOAD: i64 = 2_000_000;
pub const MAX_LOAD: i64 = 2_500_000_000;
/// Bitnob keeps at least $1 on a card.
const MIN_LEFT: i64 = 1_000_000;

pub fn topup_fee(amount: i64) -> i64 {
    if amount < 100_000_000 {
        1_000_000
    } else {
        amount / 100
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Card {
    pub id: Uuid,
    pub owner_id: String,
    pub bitnob_card_id: Option<String>,
    pub status: String,
    pub funding_asset: String,
    pub last4: Option<String>,
}

pub async fn live_card(pool: &PgPool, owner_id: &str) -> Result<Option<Card>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT id, owner_id, bitnob_card_id, status, funding_asset, last4 FROM engine.usd_cards
         WHERE owner_id = $1 AND status IN ('pending', 'active', 'frozen')",
    )
    .bind(owner_id)
    .fetch_optional(pool)
    .await?)
}

async fn card_by_bitnob_id(
    pool: &PgPool,
    bitnob_card_id: &str,
) -> Result<Option<Card>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT id, owner_id, bitnob_card_id, status, funding_asset, last4 FROM engine.usd_cards WHERE bitnob_card_id = $1",
    )
    .bind(bitnob_card_id)
    .fetch_optional(pool)
    .await?)
}

async fn set_status(pool: &PgPool, card_id: Uuid, status: &str) -> Result<(), LedgerError> {
    sqlx::query("UPDATE engine.usd_cards SET status = $2, updated_at = now() WHERE id = $1")
        .bind(card_id)
        .bind(status)
        .execute(pool)
        .await?;
    Ok(())
}

async fn customer_id(pool: &PgPool, owner_id: &str) -> Result<Option<String>, LedgerError> {
    Ok(sqlx::query_scalar("SELECT external_id FROM engine.provider_customers WHERE provider = 'bitnob' AND owner_id = $1")
        .bind(owner_id)
        .fetch_optional(pool)
        .await?)
}

// ---------------- Card KYC ----------------

/// The cardholder's details for Bitnob's card KYC, as the user entered them.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct KycInput {
    pub owner_id: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    /// YYYY-MM-DD.
    pub date_of_birth: String,
    /// Without the leading 0 or +234, e.g. 8012345678.
    pub phone_number: String,
    /// bvn or nin (verified instantly, no photo).
    pub id_type: String,
    pub id_number: String,
    pub line1: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    /// A code from Bitnob's occupations list.
    pub occupation: String,
    pub employment_status: String,
    pub account_purpose: String,
    pub annual_salary: String,
    pub expected_monthly_volume: String,
}

/// Bitnob's list of occupation codes for the KYC form.
pub async fn occupations(cfg: &BitnobConfig) -> Result<Value, BitnobError> {
    call(
        cfg,
        reqwest::Method::GET,
        "/api/cards/kyc/occupations",
        None,
    )
    .await
}

/// Submits card KYC. Returns Bitnob's normalised status (initiated, pending, approved, rejected).
pub async fn submit_kyc(
    pool: &PgPool,
    cfg: &BitnobConfig,
    k: &KycInput,
) -> Result<Value, BitnobError> {
    if !matches!(k.id_type.as_str(), "bvn" | "nin") {
        return Err(BitnobError::Invalid("Use your BVN or NIN.".into()));
    }
    let body = json!({
        "card_program": "prepaid",
        "customer": {
            "customer_type": "individual",
            "first_name": k.first_name,
            "last_name": k.last_name,
            "date_of_birth": k.date_of_birth,
            "email": k.email,
            "dial_code": "+234",
            "phone_number": k.phone_number,
            "id_type": k.id_type,
            "id_number": k.id_number,
            "line1": k.line1,
            "city": k.city,
            "state": k.state,
            "postal_code": k.postal_code,
            "country": "NGA",
        },
        "occupation": k.occupation,
        "employment_status": k.employment_status,
        "account_purpose": k.account_purpose,
        "annual_salary": k.annual_salary,
        "expected_monthly_volume": k.expected_monthly_volume,
        "terms_of_service_accepted": true,
    });
    let data = match call(cfg, reqwest::Method::POST, "/api/cards/kyc", Some(&body)).await {
        Ok(data) => data,
        // Something in the form doesn't pass: say what (Bitnob's own words, e.g. "Phone number is invalid").
        Err(BitnobError::Api {
            status: 400 | 422,
            code,
            detail,
        }) => {
            tracing::warn!(%code, %detail, "card KYC refused");
            return Err(BitnobError::Invalid(detail));
        }
        Err(error) => return Err(error),
    };
    let customer = signed_text(data.get("customer_id"));
    if customer.is_empty() {
        return Err(BitnobError::BadResponse(data.to_string()));
    }
    // The KYC'd customer is the user's Bitnob customer from now on.
    sqlx::query(
        "INSERT INTO engine.provider_customers (provider, owner_id, external_id) VALUES ('bitnob', $1, $2)
         ON CONFLICT (provider, owner_id) DO UPDATE SET external_id = EXCLUDED.external_id",
    )
    .bind(&k.owner_id)
    .bind(&customer)
    .execute(pool)
    .await
    .map_err(LedgerError::from)?;
    Ok(json!({ "status": data.get("normalized_status").cloned().unwrap_or(Value::Null) }))
}

/// Where the user's card KYC stands: none, initiated, pending, approved or rejected (+ reason).
pub async fn kyc_status(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
) -> Result<Value, BitnobError> {
    let Some(customer) = customer_id(pool, owner_id).await? else {
        return Ok(json!({ "status": "none" }));
    };
    let data = match call(
        cfg,
        reqwest::Method::GET,
        &format!("/api/cards/kyc/{customer}?card_program=prepaid"),
        None,
    )
    .await
    {
        Ok(data) => data,
        Err(BitnobError::Api { status: 404, .. }) => return Ok(json!({ "status": "none" })),
        Err(error) => return Err(error),
    };
    let reason = data
        .get("rejection_details")
        .and_then(Value::as_array)
        .and_then(|d| d.first())
        .and_then(|d| d.get("message"))
        .cloned()
        .or_else(|| data.get("reason").cloned());
    Ok(
        json!({ "status": data.get("normalized_status").cloned().unwrap_or(json!("none")), "reason": reason }),
    )
}

// ---------------- Card lifecycle ----------------

fn check_load(amount: i64) -> Result<(), BitnobError> {
    if !(MIN_LOAD..=MAX_LOAD).contains(&amount) {
        return Err(BitnobError::Invalid("Load between $2 and $2,500.".into()));
    }
    Ok(())
}

fn check_asset(asset: &str) -> Result<(), BitnobError> {
    if !matches!(asset, "USDT" | "USDC") {
        return Err(BitnobError::Invalid(
            "Pay for the card with USDT or USDC.".into(),
        ));
    }
    Ok(())
}

/// Creates the user's card with `amount` on it, paid from `asset` (amount + fees). The card is
/// `pending` until Bitnob's webhook says it's ready.
pub async fn create(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
    amount: i64,
    asset: &str,
    key: &str,
) -> Result<Card, BitnobError> {
    check_load(amount)?;
    check_asset(asset)?;
    if let Some(card) = live_card(pool, owner_id).await? {
        return Ok(card);
    }
    let customer = customer_id(pool, owner_id)
        .await?
        .ok_or_else(|| BitnobError::Invalid("Verify your identity first.".into()))?;
    let cost = amount + cfg.card_fees.creation + cfg.card_fees.topup(amount);
    let op = providers::start_payout(
        pool,
        NewPayout {
            provider: Provider::Bitnob,
            kind: "card_create",
            key: &format!("card-create:{owner_id}:{key}"),
            owner_id,
            asset,
            amount: cost,
            request: json!({ "load": amount, "fees": cost - amount }),
        },
    )
    .await?;
    let card_id: Uuid = sqlx::query_scalar(
        "INSERT INTO engine.usd_cards (owner_id, funding_asset, op_id) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id) WHERE status IN ('pending', 'active', 'frozen') DO UPDATE SET updated_at = now()
         RETURNING id",
    )
    .bind(owner_id)
    .bind(asset)
    .bind(op.id)
    .fetch_one(pool)
    .await
    .map_err(LedgerError::from)?;
    if op.status == "created" {
        providers::mark_submitted(pool, op.id, 300).await?;
        let body = json!({
            "card_type": "virtual",
            "card_program": "prepaid",
            "card_brand": "visa",
            "currency": "USD",
            "amount": amount,
            "customer_id": customer,
            "reference": op.id.simple().to_string(),
        });
        match call(cfg, reqwest::Method::POST, "/api/cards", Some(&body)).await {
            Ok(data) => {
                let card = data.get("card").unwrap_or(&data);
                sqlx::query("UPDATE engine.usd_cards SET bitnob_card_id = $2, updated_at = now() WHERE id = $1")
                    .bind(card_id)
                    .bind(signed_text(card.get("id")))
                    .execute(pool)
                    .await
                    .map_err(LedgerError::from)?;
                if signed_text(card.get("status")) == "active" {
                    card_ready(pool, op.id, card).await?;
                } else {
                    providers::mark_pending(pool, op.id, None, card, 300).await?;
                }
            }
            Err(BitnobError::Api {
                status,
                code,
                detail,
            }) if (400..500).contains(&status) && ![408, 409, 429].contains(&status) => {
                tracing::warn!(status, %code, %detail, "Bitnob refused to create a card");
                providers::fail_op(pool, op.id, &format!("{code}: {detail}"), None).await?;
                set_status(pool, card_id, "failed").await?;
                return Err(BitnobError::Invalid(format!(
                    "The card couldn't be created: {detail}"
                )));
            }
            Err(error) => {
                tracing::warn!(%error, "card creation outcome unknown; waiting for Bitnob's webhook");
                providers::mark_pending(
                    pool,
                    op.id,
                    None,
                    &json!({ "error": error.to_string() }),
                    300,
                )
                .await?;
            }
        }
    }
    sqlx::query_as("SELECT id, owner_id, bitnob_card_id, status, funding_asset, last4 FROM engine.usd_cards WHERE id = $1")
        .bind(card_id)
        .fetch_one(pool)
        .await
        .map_err(|e| LedgerError::from(e).into())
}

/// Money that left the user's balance for the card (create or top-up), for their activity.
async fn emit_load(pool: &PgPool, op: &Op) -> Result<(), BitnobError> {
    if let (Some(owner), Some(asset), Some(amount), Some(hold_id)) =
        (&op.owner_id, &op.asset, op.amount, op.hold_id)
    {
        let entry = ledger::entry_by_key(pool, &format!("hold:{hold_id}:capture")).await?;
        emit_event(
            pool,
            owner,
            "card_load",
            json!({ "entryId": entry.id, "asset": asset, "amount": amount }),
            &format!("card-load:{}", op.id),
        )
        .await?;
    }
    Ok(())
}

async fn card_ready(pool: &PgPool, op_id: Uuid, card: &Value) -> Result<(), BitnobError> {
    let op = providers::succeed_op(pool, op_id, None, card).await?;
    emit_load(pool, &op).await?;
    let last4 = Some(signed_text(
        card.get("last_four_digit").or_else(|| card.get("lastFour")),
    ))
    .filter(|s| !s.is_empty());
    sqlx::query("UPDATE engine.usd_cards SET status = 'active', last4 = coalesce($2, last4), updated_at = now() WHERE op_id = $1")
        .bind(op_id)
        .bind(last4)
        .execute(pool)
        .await
        .map_err(LedgerError::from)?;
    if let Some(owner) = &op.owner_id {
        emit_event(
            pool,
            owner,
            "card_ready",
            json!({ "opId": op.id }),
            &format!("card:{op_id}:ready"),
        )
        .await?;
    }
    Ok(())
}

async fn active_card(pool: &PgPool, owner_id: &str) -> Result<(Card, String), BitnobError> {
    let card = live_card(pool, owner_id)
        .await?
        .ok_or_else(|| BitnobError::Invalid("You don't have a USD card yet.".into()))?;
    let bitnob_id = card
        .bitnob_card_id
        .clone()
        .ok_or_else(|| BitnobError::Invalid("Your card is still being made.".into()))?;
    Ok((card, bitnob_id))
}

/// Adds `amount` to the card, paid from `asset` (amount + top-up fee). Pending until Bitnob confirms.
pub async fn fund(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
    amount: i64,
    asset: &str,
    key: &str,
) -> Result<Op, BitnobError> {
    check_load(amount)?;
    check_asset(asset)?;
    let (card, bitnob_id) = active_card(pool, owner_id).await?;
    if card.status != "active" {
        return Err(BitnobError::Invalid(
            "Unfreeze your card to add money.".into(),
        ));
    }
    let cost = amount + cfg.card_fees.topup(amount);
    let op = providers::start_payout(
        pool,
        NewPayout {
            provider: Provider::Bitnob,
            kind: "card_fund",
            key: &format!("card-fund:{owner_id}:{key}"),
            owner_id,
            asset,
            amount: cost,
            request: json!({ "card": bitnob_id, "load": amount }),
        },
    )
    .await?;
    if op.status != "created" {
        return Ok(op);
    }
    providers::mark_submitted(pool, op.id, 300).await?;
    let body = json!({ "type": "fund", "amount": amount, "reference": op.id.simple().to_string() });
    balance_move(pool, cfg, &op, &bitnob_id, &body).await
}

/// Moves `amount` from the card back to the user's balance (in the card's funding asset). Bitnob
/// keeps at least $1 on the card. Credited when Bitnob confirms.
pub async fn withdraw(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
    amount: i64,
    key: &str,
) -> Result<Op, BitnobError> {
    if amount < 10_000 {
        return Err(BitnobError::Invalid("Enter an amount.".into()));
    }
    let (card, bitnob_id) = active_card(pool, owner_id).await?;
    let info = details_public(cfg, &bitnob_id).await?;
    let balance = info["balance"].as_i64().unwrap_or(0);
    if amount > balance - MIN_LEFT {
        return Err(BitnobError::Invalid(
            "At least $1 has to stay on the card.".into(),
        ));
    }
    let op = providers::start_op(
        pool,
        Provider::Bitnob,
        "card_withdraw",
        &format!("card-withdraw:{owner_id}:{key}"),
        Some(owner_id),
        json!({ "card": bitnob_id, "amount": amount, "to": card.funding_asset }),
    )
    .await?;
    if op.status != "created" {
        return Ok(op);
    }
    providers::mark_submitted(pool, op.id, 300).await?;
    let body =
        json!({ "type": "withdraw", "amount": amount, "reference": op.id.simple().to_string() });
    balance_move(pool, cfg, &op, &bitnob_id, &body).await
}

async fn balance_move(
    pool: &PgPool,
    cfg: &BitnobConfig,
    op: &Op,
    bitnob_id: &str,
    body: &Value,
) -> Result<Op, BitnobError> {
    match call(
        cfg,
        reqwest::Method::POST,
        &format!("/api/cards/{bitnob_id}/balance"),
        Some(body),
    )
    .await
    {
        Ok(data) => {
            let tx = data.get("transaction").unwrap_or(&data);
            match signed_text(tx.get("status")).as_str() {
                "completed" => settle_move(pool, op.id, true, tx).await,
                "failed" | "declined" | "reversed" => settle_move(pool, op.id, false, tx).await,
                _ => {
                    providers::mark_pending(pool, op.id, None, tx, 300).await?;
                    Ok(providers::get_op(pool, op.id).await?)
                }
            }
        }
        Err(BitnobError::Api {
            status,
            code,
            detail,
        }) if (400..500).contains(&status) && ![408, 409, 429].contains(&status) => {
            tracing::warn!(status, %code, %detail, "Bitnob refused a card balance move");
            // Nothing moved; a held top-up goes back to the user.
            providers::fail_op(pool, op.id, &format!("{code}: {detail}"), None).await?;
            Err(BitnobError::Invalid(if detail.contains("120 seconds") {
                "You just added money. Wait two minutes before adding more.".into()
            } else {
                format!("It was refused: {detail}")
            }))
        }
        Err(error) => {
            tracing::warn!(%error, "card balance move outcome unknown; waiting for Bitnob's webhook");
            providers::mark_pending(
                pool,
                op.id,
                None,
                &json!({ "error": error.to_string() }),
                300,
            )
            .await?;
            Ok(providers::get_op(pool, op.id).await?)
        }
    }
}

/// A top-up or withdrawal finished (from the HTTP answer or a webhook). Safe to repeat.
async fn settle_move(
    pool: &PgPool,
    op_id: Uuid,
    ok: bool,
    data: &Value,
) -> Result<Op, BitnobError> {
    let op = providers::get_op(pool, op_id).await?;
    match (op.kind.as_str(), ok) {
        ("card_fund", true) => {
            let op = providers::succeed_op(pool, op_id, None, data).await?;
            emit_load(pool, &op).await?;
            Ok(op)
        }
        ("card_withdraw", true) => {
            let owner = op.owner_id.clone().unwrap_or_default();
            let to = op.request["to"].as_str().unwrap_or("USDC").to_owned();
            let amount = op.request["amount"].as_i64().unwrap_or(0);
            let entry = ledger::transfer(
                pool,
                &TransferRequest {
                    idempotency_key: format!("card-withdraw:{op_id}:in"),
                    kind: "card_withdraw".into(),
                    from: Provider::Bitnob.clearing(),
                    to: Owner::user(owner.clone()),
                    asset: to.clone(),
                    amount,
                    reference: Some(format!("bitnob:card:{op_id}")),
                    metadata: None,
                },
            )
            .await?;
            let op = providers::succeed_op(pool, op_id, None, data).await?;
            emit_event(
                pool,
                &owner,
                "card_withdraw",
                json!({ "entryId": entry.id, "asset": to, "amount": amount }),
                &format!("card-withdraw:{op_id}"),
            )
            .await?;
            Ok(op)
        }
        (_, false) => Ok(providers::fail_op(pool, op_id, "Bitnob refused it", Some(data)).await?),
        _ => Ok(providers::succeed_op(pool, op_id, None, data).await?),
    }
}

pub async fn set_frozen(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
    frozen: bool,
) -> Result<Card, BitnobError> {
    let (card, bitnob_id) = active_card(pool, owner_id).await?;
    let status = if frozen { "frozen" } else { "active" };
    call(
        cfg,
        reqwest::Method::POST,
        &format!("/api/cards/{bitnob_id}/status"),
        Some(&json!({ "status": status })),
    )
    .await?;
    set_status(pool, card.id, status).await?;
    Ok(Card {
        status: status.into(),
        ..card
    })
}

/// Ends the card. Bitnob refunds its balance (webhook), credited to the card's funding asset.
/// Not possible in the card's first 24 hours.
pub async fn terminate(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
) -> Result<Card, BitnobError> {
    let (card, bitnob_id) = active_card(pool, owner_id).await?;
    match call(
        cfg,
        reqwest::Method::DELETE,
        &format!("/api/cards/{bitnob_id}"),
        Some(&json!({ "reason": "Closed by the cardholder" })),
    )
    .await
    {
        Ok(_) => {}
        Err(BitnobError::Api {
            status: 400,
            detail,
            ..
        }) => {
            return Err(BitnobError::Invalid(format!(
                "It can't be closed yet: {detail}"
            )));
        }
        Err(error) => return Err(error),
    }
    set_status(pool, card.id, "terminated").await?;
    Ok(Card {
        status: "terminated".into(),
        ..card
    })
}

async fn details_public(cfg: &BitnobConfig, bitnob_id: &str) -> Result<Value, BitnobError> {
    let data = call(
        cfg,
        reqwest::Method::GET,
        &format!("/api/cards/{bitnob_id}"),
        None,
    )
    .await?;
    let c = data.get("card").unwrap_or(&data);
    Ok(json!({
        "balance": signed_text(c.get("balance_amount")).parse::<i64>().unwrap_or(0),
        "last4": c.get("last_four_digit"),
        "status": c.get("status"),
        "name": c.get("name"),
        "brand": c.get("card_brand"),
    }))
}

/// The card as the app shows it: status, last 4 and balance (from Bitnob).
pub async fn summary(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
) -> Result<Value, BitnobError> {
    let Some(card) = live_card(pool, owner_id).await? else {
        return Ok(Value::Null);
    };
    let mut out = json!({ "status": card.status, "fundingAsset": card.funding_asset, "last4": card.last4, "balance": 0 });
    if let Some(id) = &card.bitnob_card_id
        && card.status != "pending"
        && let Ok(info) = details_public(cfg, id).await
    {
        out["balance"] = info["balance"].clone();
        out["last4"] = info["last4"].clone();
        out["name"] = info["name"].clone();
    }
    Ok(out)
}

/// Number, CVV and expiry, straight from Bitnob (no encryption key registered, so Bitnob returns
/// them over HTTPS). Only after the PIN (the API checks it); never stored or logged.
pub async fn secrets(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
) -> Result<Value, BitnobError> {
    let (_, bitnob_id) = active_card(pool, owner_id).await?;
    let data = call(
        cfg,
        reqwest::Method::GET,
        &format!("/api/cards/{bitnob_id}/secure"),
        None,
    )
    .await?;
    if data.get("encrypted_details").is_some() {
        // A card encryption key is registered in Bitnob's dashboard: remove it, or add decryption.
        tracing::error!(
            "card details came back encrypted; remove the card encryption key in Bitnob's dashboard"
        );
        return Err(BitnobError::Invalid(
            "Card details aren't available right now. Please try again later.".into(),
        ));
    }
    let d = data.get("details").cloned().unwrap_or(Value::Null);
    Ok(json!({
        "number": d.get("card_number"),
        "cvv": d.get("cvv"),
        "expiryMonth": d.get("expiry_month"),
        "expiryYear": d.get("expiry_year"),
        "name": d.get("name"),
    }))
}

pub async fn transactions(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
) -> Result<Value, BitnobError> {
    let (_, bitnob_id) = active_card(pool, owner_id).await?;
    let data = call(
        cfg,
        reqwest::Method::GET,
        &format!("/api/cards/{bitnob_id}/transactions?limit=30"),
        None,
    )
    .await?;
    let rows = data
        .get("transactions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(Value::Array(
        rows.iter()
            .map(|t| {
                json!({
                    "id": t.get("id"),
                    "type": t.get("type"),
                    "status": t.get("status"),
                    "amount": signed_text(t.get("amount")).parse::<i64>().unwrap_or(0),
                    "merchant": t.get("merchant_name").or_else(|| t.get("description")),
                    "at": t.get("transaction_date").or_else(|| t.get("created_at")),
                })
            })
            .collect(),
    ))
}

// ---------------- Webhooks ----------------

/// `virtualcard.*` events. Ours are matched on `reference` (the operation id).
pub async fn handle_webhook(pool: &PgPool, kind: &str, data: &Value) -> Result<(), String> {
    let op_of = |data: &Value| Uuid::parse_str(&signed_text(data.get("reference"))).ok();
    let result: Result<(), BitnobError> = async {
        match kind {
            "virtualcard.created.completed" => {
                if let Some(op_id) = op_of(data) {
                    sqlx::query("UPDATE engine.usd_cards SET bitnob_card_id = coalesce(bitnob_card_id, $2) WHERE op_id = $1")
                        .bind(op_id)
                        .bind(signed_text(data.get("id")))
                        .execute(pool)
                        .await
                        .map_err(LedgerError::from)?;
                    card_ready(pool, op_id, data).await?;
                }
            }
            "virtualcard.created.failed" => {
                if let Some(op_id) = op_of(data) {
                    providers::fail_op(pool, op_id, &signed_text(data.get("failureReason")), Some(data)).await?;
                    sqlx::query("UPDATE engine.usd_cards SET status = 'failed', updated_at = now() WHERE op_id = $1")
                        .bind(op_id)
                        .execute(pool)
                        .await
                        .map_err(LedgerError::from)?;
                }
            }
            "virtualcard.topup.completed" | "virtualcard.withdrawal.completed" => {
                if let Some(op_id) = op_of(data) {
                    settle_move(pool, op_id, true, data).await?;
                }
            }
            "virtualcard.topup.failed" | "virtualcard.withdrawal.failed" => {
                if let Some(op_id) = op_of(data) {
                    settle_move(pool, op_id, false, data).await?;
                }
            }
            "virtualcard.terminated.refund" => {
                let card = card_by_bitnob_id(pool, &signed_text(data.get("cardId"))).await?;
                let amount = signed_text(data.get("amount")).parse::<i64>().unwrap_or(0);
                if let Some(card) = card
                    && amount > 0
                {
                    let entry = ledger::transfer(
                        pool,
                        &TransferRequest {
                            idempotency_key: format!("card-terminated:{}", card.id),
                            kind: "card_refund".into(),
                            from: Provider::Bitnob.clearing(),
                            to: Owner::user(card.owner_id.clone()),
                            asset: card.funding_asset.clone(),
                            amount,
                            reference: Some(format!("bitnob:card:{}", card.id)),
                            metadata: None,
                        },
                    )
                    .await?;
                    set_status(pool, card.id, "terminated").await?;
                    emit_event(
                        pool,
                        &card.owner_id,
                        "card_withdraw",
                        json!({ "entryId": entry.id, "asset": card.funding_asset, "amount": amount }),
                        &format!("card-terminated:{}", card.id),
                    )
                    .await?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    .await;
    result.map_err(|e| e.to_string())
}
