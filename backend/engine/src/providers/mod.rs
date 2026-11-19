//! What every money provider (Paga, Bitnob) shares: the accounts they hold for our users, the
//! operations we ask them to do, and the webhooks they send back. The provider-specific HTTP
//! clients live in their own modules and only translate; the money rules are all here.
//!
//! Money at a provider is mirrored by a system clearing account per provider and asset
//! (`paga_clearing`, `bitnob_clearing`). A deposit moves money from the clearing account to the
//! user; a payout moves it back. The clearing balance, negated, is what the provider should hold
//! for us, which is what reconciliation compares.

use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::LedgerError;
use crate::ledger::{self, CaptureRequest, Entry, HoldRequest, Owner, TransferRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Paga,
    Bitnob,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paga => "paga",
            Self::Bitnob => "bitnob",
        }
    }

    /// Tappi's books for the money this provider holds.
    pub fn clearing(self) -> Owner {
        Owner::system(format!("{}_clearing", self.as_str()))
    }
}

// ---------------- Accounts the provider holds for a user ----------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ProviderAccount {
    pub id: Uuid,
    pub provider: String,
    pub owner_id: String,
    pub kind: String,
    pub asset: String,
    pub network: Option<String>,
    pub external_id: String,
    pub details: Value,
}

pub struct NewAccount<'a> {
    pub provider: Provider,
    pub owner_id: &'a str,
    pub kind: &'a str,
    pub asset: &'a str,
    pub network: Option<&'a str>,
    pub external_id: &'a str,
    pub details: Value,
}

/// Saves an account a provider created for a user. Saving the same one again is a no-op.
pub async fn save_account(
    pool: &PgPool,
    account: NewAccount<'_>,
) -> Result<ProviderAccount, LedgerError> {
    sqlx::query(
        "INSERT INTO engine.provider_accounts (provider, owner_id, kind, asset, network, external_id, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider, external_id) DO NOTHING",
    )
    .bind(account.provider.as_str())
    .bind(account.owner_id)
    .bind(account.kind)
    .bind(account.asset)
    .bind(account.network)
    .bind(account.external_id)
    .bind(&account.details)
    .execute(pool)
    .await?;
    find_account(pool, account.provider, account.external_id)
        .await?
        .ok_or(LedgerError::NotFound)
}

pub async fn find_account(
    pool: &PgPool,
    provider: Provider,
    external_id: &str,
) -> Result<Option<ProviderAccount>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT id, provider, owner_id, kind, asset, network, external_id, details
         FROM engine.provider_accounts WHERE provider = $1 AND external_id = $2",
    )
    .bind(provider.as_str())
    .bind(external_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn accounts_of(
    pool: &PgPool,
    owner_id: &str,
) -> Result<Vec<ProviderAccount>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT id, provider, owner_id, kind, asset, network, external_id, details
         FROM engine.provider_accounts WHERE owner_id = $1 ORDER BY created_at",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await?)
}

// ---------------- Webhooks ----------------

/// Stores a webhook before acting on it. None when this event was already received (a retry).
pub async fn record_webhook(
    pool: &PgPool,
    provider: Provider,
    event_id: &str,
    event_type: Option<&str>,
    payload: &Value,
) -> Result<Option<Uuid>, LedgerError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO engine.webhook_events (provider, event_id, event_type, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id",
    )
    .bind(provider.as_str())
    .bind(event_id)
    .bind(event_type)
    .bind(payload)
    .fetch_optional(pool)
    .await?)
}

/// Marks a stored webhook as handled, or records why it couldn't be.
pub async fn finish_webhook(
    pool: &PgPool,
    id: Uuid,
    error: Option<&str>,
) -> Result<(), LedgerError> {
    sqlx::query("UPDATE engine.webhook_events SET processed_at = now(), error = $2 WHERE id = $1")
        .bind(id)
        .bind(error)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------- Deposits ----------------

/// Money arrived at the provider for a user: credit them from the provider's clearing account.
/// Keyed on the provider's own transaction id, so the same deposit is never credited twice,
/// whether it's reported by a webhook, a repeated webhook or a status check.
pub async fn credit_deposit(
    pool: &PgPool,
    provider: Provider,
    provider_txn_id: &str,
    owner_id: &str,
    asset: &str,
    amount: i64,
    metadata: Value,
) -> Result<Entry, LedgerError> {
    ledger::transfer(
        pool,
        &TransferRequest {
            idempotency_key: format!("deposit:{}:{provider_txn_id}", provider.as_str()),
            kind: "deposit".into(),
            from: provider.clearing(),
            to: Owner::user(owner_id),
            asset: asset.into(),
            amount,
            reference: Some(format!("{}:{provider_txn_id}", provider.as_str())),
            metadata: Some(metadata),
        },
    )
    .await
}

// ---------------- Operations (payouts and anything else in flight) ----------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Op {
    pub id: Uuid,
    pub provider: String,
    pub kind: String,
    pub idempotency_key: String,
    pub status: String,
    pub owner_id: Option<String>,
    pub asset: Option<String>,
    pub amount: Option<i64>,
    pub hold_id: Option<Uuid>,
    pub provider_reference: Option<String>,
    pub request: Value,
    pub response: Option<Value>,
    pub error: Option<String>,
    pub attempts: i32,
}

const OP_COLUMNS: &str =
    "id, provider, kind, idempotency_key, status, owner_id, asset, amount, hold_id,
                          provider_reference, request, response, error, attempts";

pub async fn get_op(pool: &PgPool, id: Uuid) -> Result<Op, LedgerError> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OP_COLUMNS} FROM engine.provider_ops WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(LedgerError::NotFound)
}

pub async fn op_by_key(pool: &PgPool, key: &str) -> Result<Option<Op>, LedgerError> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OP_COLUMNS} FROM engine.provider_ops WHERE idempotency_key = $1"
    )))
    .bind(key)
    .fetch_optional(pool)
    .await?)
}

pub async fn op_by_reference(
    pool: &PgPool,
    provider: Provider,
    reference: &str,
) -> Result<Option<Op>, LedgerError> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OP_COLUMNS} FROM engine.provider_ops WHERE provider = $1 AND provider_reference = $2"
    )))
    .bind(provider.as_str())
    .bind(reference)
    .fetch_optional(pool)
    .await?)
}

pub struct NewPayout<'a> {
    pub provider: Provider,
    pub kind: &'a str,
    pub key: &'a str,
    pub owner_id: &'a str,
    pub asset: &'a str,
    pub amount: i64,
    /// What will be sent to the provider (beneficiary, narration…), kept for retries and audits.
    pub request: Value,
}

/// Starts a payout: records the operation and holds the user's money so it can't be spent while
/// the provider works. Calling again with the same key returns the same operation.
pub async fn start_payout(pool: &PgPool, payout: NewPayout<'_>) -> Result<Op, LedgerError> {
    if let Some(existing) = op_by_key(pool, payout.key).await? {
        return Ok(existing);
    }
    let hold = ledger::create_hold(
        pool,
        &HoldRequest {
            idempotency_key: format!("op:{}:hold", payout.key),
            owner: Owner::user(payout.owner_id),
            asset: payout.asset.into(),
            amount: payout.amount,
            reference: Some(format!("{}:{}", payout.provider.as_str(), payout.kind)),
        },
    )
    .await?;
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO engine.provider_ops (provider, kind, idempotency_key, owner_id, asset, amount, hold_id, request)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id",
    )
    .bind(payout.provider.as_str())
    .bind(payout.kind)
    .bind(payout.key)
    .bind(payout.owner_id)
    .bind(payout.asset)
    .bind(payout.amount)
    .bind(hold.id)
    .bind(&payout.request)
    .fetch_optional(pool)
    .await?;
    match id {
        Some(id) => get_op(pool, id).await,
        // Lost a race with the same request: the hold is keyed too, so it's the same hold.
        None => op_by_key(pool, payout.key)
            .await?
            .ok_or(LedgerError::NotFound),
    }
}

/// Starts an operation that doesn't hold money (creating an account, an address). Same key, same op.
pub async fn start_op(
    pool: &PgPool,
    provider: Provider,
    kind: &str,
    key: &str,
    owner_id: Option<&str>,
    request: Value,
) -> Result<Op, LedgerError> {
    sqlx::query(
        "INSERT INTO engine.provider_ops (provider, kind, idempotency_key, owner_id, request)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING",
    )
    .bind(provider.as_str())
    .bind(kind)
    .bind(key)
    .bind(owner_id)
    .bind(&request)
    .execute(pool)
    .await?;
    op_by_key(pool, key).await?.ok_or(LedgerError::NotFound)
}

/// The provider accepted the operation but hasn't finished it. Checked again after `check_in_secs`.
pub async fn mark_pending(
    pool: &PgPool,
    id: Uuid,
    provider_reference: Option<&str>,
    response: &Value,
    check_in_secs: i64,
) -> Result<(), LedgerError> {
    sqlx::query(
        "UPDATE engine.provider_ops
         SET status = 'pending', provider_reference = coalesce($2, provider_reference), response = $3,
             attempts = attempts + 1, next_check_at = now() + make_interval(secs => $4), updated_at = now()
         WHERE id = $1 AND status IN ('created', 'submitted', 'pending')",
    )
    .bind(id)
    .bind(provider_reference)
    .bind(response)
    .bind(check_in_secs as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// About to call the provider. If we crash right after, the checker asks the provider what happened.
pub async fn mark_submitted(
    pool: &PgPool,
    id: Uuid,
    check_in_secs: i64,
) -> Result<(), LedgerError> {
    sqlx::query(
        "UPDATE engine.provider_ops
         SET status = 'submitted', attempts = attempts + 1, next_check_at = now() + make_interval(secs => $2),
             updated_at = now()
         WHERE id = $1 AND status IN ('created', 'submitted')",
    )
    .bind(id)
    .bind(check_in_secs as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// The provider finished it. A held payout moves to the provider's clearing account. Safe to call
/// more than once (webhook and status check can both report it).
pub async fn succeed_op(
    pool: &PgPool,
    id: Uuid,
    provider_reference: Option<&str>,
    response: &Value,
) -> Result<Op, LedgerError> {
    let op = get_op(pool, id).await?;
    match op.status.as_str() {
        "succeeded" => return Ok(op),
        "failed" => return Err(LedgerError::HoldClosed),
        _ => {}
    }
    if let Some(hold_id) = op.hold_id {
        let provider = if op.provider == "paga" {
            Provider::Paga
        } else {
            Provider::Bitnob
        };
        ledger::capture_hold(
            pool,
            hold_id,
            &CaptureRequest {
                to: provider.clearing(),
                kind: op.kind.clone(),
                metadata: Some(response.clone()),
            },
        )
        .await?;
    }
    sqlx::query(
        "UPDATE engine.provider_ops
         SET status = 'succeeded', provider_reference = coalesce($2, provider_reference), response = $3,
             next_check_at = NULL, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(provider_reference)
    .bind(response)
    .execute(pool)
    .await?;
    get_op(pool, id).await
}

/// The provider refused or gave up. A held payout's money goes back to the user. Safe to repeat;
/// refused if the operation already succeeded (the money has left).
pub async fn fail_op(
    pool: &PgPool,
    id: Uuid,
    error: &str,
    response: Option<&Value>,
) -> Result<Op, LedgerError> {
    let op = get_op(pool, id).await?;
    match op.status.as_str() {
        "failed" => return Ok(op),
        "succeeded" => return Err(LedgerError::HoldClosed),
        _ => {}
    }
    if let Some(hold_id) = op.hold_id {
        ledger::release_hold(pool, hold_id).await?;
    }
    sqlx::query(
        "UPDATE engine.provider_ops
         SET status = 'failed', error = $2, response = coalesce($3, response), next_check_at = NULL, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(error)
    .bind(response)
    .execute(pool)
    .await?;
    get_op(pool, id).await
}

/// Operations whose outcome we're still waiting on and that are due for a status check.
pub async fn due_for_check(pool: &PgPool, limit: i64) -> Result<Vec<Op>, LedgerError> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OP_COLUMNS} FROM engine.provider_ops
         WHERE status IN ('submitted', 'pending') AND next_check_at <= now()
         ORDER BY next_check_at LIMIT $1"
    )))
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

/// What Tappi's books say each provider holds for us, per asset (for reconciliation).
pub async fn expected_provider_balances(
    pool: &PgPool,
    provider: Provider,
) -> Result<Vec<(String, i64)>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT asset, -balance FROM engine.accounts WHERE owner_type = 'system' AND owner_id = $1 ORDER BY asset",
    )
    .bind(format!("{}_clearing", provider.as_str()))
    .fetch_all(pool)
    .await?)
}

// ---------------- Fees and events ----------------

/// Where provider fees Tappi pays are booked (an expense: goes negative).
pub fn fees_account(provider: Provider) -> Owner {
    Owner::system(format!("{}_fees", provider.as_str()))
}

/// A fee the provider took from what it holds for us (a deposit's clearing fee, a payout's fee + VAT).
/// Tappi pays it, so users' balances don't change; keyed so it's booked once.
pub async fn book_fee(
    pool: &PgPool,
    provider: Provider,
    key: &str,
    asset: &str,
    amount: i64,
) -> Result<(), LedgerError> {
    if amount <= 0 {
        return Ok(());
    }
    ledger::transfer(
        pool,
        &TransferRequest {
            idempotency_key: format!("fee:{}:{key}", provider.as_str()),
            kind: "provider_fee".into(),
            from: fees_account(provider),
            to: provider.clearing(),
            asset: asset.into(),
            amount,
            reference: Some(key.into()),
            metadata: None,
        },
    )
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Event {
    pub id: i64,
    pub owner_id: String,
    pub kind: String,
    pub payload: Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Tells the API something happened to a user. Recording the same `dedupe_key` again is a no-op.
pub async fn emit_event(
    pool: &PgPool,
    owner_id: &str,
    kind: &str,
    payload: Value,
    dedupe_key: &str,
) -> Result<(), LedgerError> {
    sqlx::query(
        "INSERT INTO engine.events (owner_id, kind, payload, dedupe_key) VALUES ($1, $2, $3, $4)
         ON CONFLICT (dedupe_key) DO NOTHING",
    )
    .bind(owner_id)
    .bind(kind)
    .bind(payload)
    .bind(dedupe_key)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn events_after(
    pool: &PgPool,
    after: i64,
    limit: i64,
) -> Result<Vec<Event>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT id, owner_id, kind, payload, created_at FROM engine.events WHERE id > $1 ORDER BY id LIMIT $2",
    )
    .bind(after)
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

/// "5000", "5000.0", "37.5" (naira as Paga writes it) → kobo. None for anything else, including
/// more than two non-zero decimal places: money is never rounded silently.
pub fn major_to_minor(text: &str, decimals: u32) -> Option<i64> {
    let text = text.trim();
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let frac = frac.trim_end_matches('0');
    if frac.len() > decimals as usize {
        return None;
    }
    let scale = 10i64.checked_pow(decimals)?;
    let frac_value: i64 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<width$}", width = decimals as usize)
            .parse()
            .ok()?
    };
    whole
        .parse::<i64>()
        .ok()?
        .checked_mul(scale)?
        .checked_add(frac_value)
}

/// Smallest units → the decimal string providers want ("5000.00").
pub fn minor_to_major(amount: i64, decimals: u32) -> String {
    let scale = 10i64.pow(decimals);
    format!(
        "{}.{:0width$}",
        amount / scale,
        amount % scale,
        width = decimals as usize
    )
}

/// A JSON value as the text a provider signed: strings as-is, numbers exactly as written
/// (needs serde_json's arbitrary_precision), missing/null as "".
pub fn signed_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

pub mod bitnob;
pub mod paga;
pub mod testswap;
pub mod trading;
pub mod usdcard;
