//! Double-entry ledger. Every money movement is one journal entry whose postings sum to zero per
//! asset; account balances are kept in step inside the same transaction. Accounts are locked in id
//! order so concurrent movements can't deadlock, and checked before they're debited (the database
//! CHECK constraints are the backstop, not the plan).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::LedgerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum OwnerType {
    User,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub owner_type: OwnerType,
    pub owner_id: String,
}

impl Owner {
    pub fn user(id: impl Into<String>) -> Self {
        Self {
            owner_type: OwnerType::User,
            owner_id: id.into(),
        }
    }

    pub fn system(id: impl Into<String>) -> Self {
        Self {
            owner_type: OwnerType::System,
            owner_id: id.into(),
        }
    }
}

/// Where sandbox credits come from. Goes negative by design; never exists in production.
pub const SANDBOX_MINT: &str = "sandbox_mint";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRequest {
    pub idempotency_key: String,
    pub kind: String,
    pub from: Owner,
    pub to: Owner,
    pub asset: String,
    /// In the asset's smallest unit.
    pub amount: i64,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Posting {
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub asset: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: Uuid,
    pub idempotency_key: String,
    pub kind: String,
    pub reference: Option<String>,
    pub metadata: Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub postings: Vec<Posting>,
    /// True when this is an earlier result returned for a repeated idempotency key.
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Balance {
    pub asset: String,
    pub decimals: i16,
    pub balance: i64,
    pub held: i64,
    pub available: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum HoldStatus {
    Active,
    Captured,
    Released,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Hold {
    pub id: Uuid,
    pub idempotency_key: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub asset: String,
    pub amount: i64,
    pub status: HoldStatus,
    pub reference: Option<String>,
    pub entry_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoldRequest {
    pub idempotency_key: String,
    pub owner: Owner,
    pub asset: String,
    pub amount: i64,
    #[serde(default)]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRequest {
    pub to: Owner,
    pub kind: String,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(sqlx::FromRow)]
struct LockedAccount {
    id: Uuid,
    balance: i64,
    held: i64,
    allow_negative: bool,
}

struct Leg {
    account_id: Uuid,
    asset: String,
    amount: i64,
}

fn request_hash<T: Serialize>(request: &T) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(request).expect("request serializes"),
    ))
}

fn validate_amount(amount: i64) -> Result<(), LedgerError> {
    if amount <= 0 {
        Err(LedgerError::InvalidAmount)
    } else {
        Ok(())
    }
}

async fn ensure_asset(tx: &mut Transaction<'_, Postgres>, asset: &str) -> Result<(), LedgerError> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT code FROM engine.assets WHERE code = $1")
            .bind(asset)
            .fetch_optional(&mut **tx)
            .await?;
    found
        .map(|_| ())
        .ok_or_else(|| LedgerError::UnknownAsset(asset.to_owned()))
}

/// Returns the account's id, creating it on first use. System accounts are clearing accounts and
/// may go negative; user accounts never may. Takes no row locks: locking happens in
/// `lock_accounts`, in id order (an upsert's DO UPDATE would lock in call order and deadlock).
async fn account_id(
    tx: &mut Transaction<'_, Postgres>,
    owner: &Owner,
    asset: &str,
) -> Result<Uuid, LedgerError> {
    const FIND: &str =
        "SELECT id FROM engine.accounts WHERE owner_type = $1 AND owner_id = $2 AND asset = $3";
    for _ in 0..2 {
        let found: Option<Uuid> = sqlx::query_scalar(FIND)
            .bind(owner.owner_type)
            .bind(&owner.owner_id)
            .bind(asset)
            .fetch_optional(&mut **tx)
            .await?;
        if let Some(id) = found {
            return Ok(id);
        }
        let created: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO engine.accounts (owner_type, owner_id, asset, allow_negative)
             VALUES ($1, $2, $3, $1 = 'system')
             ON CONFLICT (owner_type, owner_id, asset) DO NOTHING
             RETURNING id",
        )
        .bind(owner.owner_type)
        .bind(&owner.owner_id)
        .bind(asset)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(id) = created {
            return Ok(id);
        }
    }
    unreachable!("account exists after a conflicting insert")
}

async fn lock_accounts(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> Result<Vec<LockedAccount>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT id, balance, held, allow_negative FROM engine.accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE",
    )
    .bind(ids)
    .fetch_all(&mut **tx)
    .await?)
}

/// Inserts the entry header. None means the key was already used (by a committed entry).
async fn insert_entry(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    hash: &str,
    kind: &str,
    reference: Option<&str>,
    metadata: &Value,
) -> Result<Option<Uuid>, LedgerError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO engine.journal_entries (idempotency_key, request_hash, kind, reference, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id",
    )
    .bind(key)
    .bind(hash)
    .bind(kind)
    .bind(reference)
    .bind(metadata)
    .fetch_optional(&mut **tx)
    .await?)
}

async fn insert_legs(
    tx: &mut Transaction<'_, Postgres>,
    entry_id: Uuid,
    legs: &[Leg],
) -> Result<(), LedgerError> {
    for leg in legs {
        sqlx::query("INSERT INTO engine.postings (entry_id, account_id, asset, amount) VALUES ($1, $2, $3, $4)")
            .bind(entry_id)
            .bind(leg.account_id)
            .bind(&leg.asset)
            .bind(leg.amount)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE engine.accounts SET balance = balance + $2 WHERE id = $1")
            .bind(leg.account_id)
            .bind(leg.amount)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn load_entry<'e, E>(executor: E, id: Uuid, replayed: bool) -> Result<Entry, LedgerError>
where
    E: sqlx::PgExecutor<'e> + Copy,
{
    let (idempotency_key, kind, reference, metadata, created_at) = sqlx::query_as::<
        _,
        (String, String, Option<String>, Value, chrono::DateTime<chrono::Utc>),
    >("SELECT idempotency_key, kind, reference, metadata, created_at FROM engine.journal_entries WHERE id = $1")
    .bind(id)
    .fetch_one(executor)
    .await?;
    let postings = sqlx::query_as(
        "SELECT a.owner_type, a.owner_id, p.asset, p.amount
         FROM engine.postings p JOIN engine.accounts a ON a.id = p.account_id
         WHERE p.entry_id = $1 ORDER BY p.id",
    )
    .bind(id)
    .fetch_all(executor)
    .await?;
    Ok(Entry {
        id,
        idempotency_key,
        kind,
        reference,
        metadata,
        created_at,
        postings,
        replayed,
    })
}

/// The entry already recorded under `key`, if the request matches the one that created it.
async fn replay(pool: &PgPool, key: &str, hash: &str) -> Result<Entry, LedgerError> {
    let (id, stored): (Uuid, String) = sqlx::query_as(
        "SELECT id, request_hash FROM engine.journal_entries WHERE idempotency_key = $1",
    )
    .bind(key)
    .fetch_one(pool)
    .await?;
    if stored != hash {
        return Err(LedgerError::IdempotencyConflict);
    }
    load_entry(pool, id, true).await
}

/// Moves `amount` of `asset` from one owner to another. Safe to retry with the same key.
pub async fn transfer(pool: &PgPool, req: &TransferRequest) -> Result<Entry, LedgerError> {
    validate_amount(req.amount)?;
    if req.from == req.to {
        return Err(LedgerError::SameAccount);
    }
    let hash = request_hash(req);
    let metadata = req
        .metadata
        .clone()
        .unwrap_or_else(|| Value::Object(Default::default()));

    let mut tx = pool.begin().await?;
    let Some(entry_id) = insert_entry(
        &mut tx,
        &req.idempotency_key,
        &hash,
        &req.kind,
        req.reference.as_deref(),
        &metadata,
    )
    .await?
    else {
        tx.rollback().await?;
        return replay(pool, &req.idempotency_key, &hash).await;
    };
    ensure_asset(&mut tx, &req.asset).await?;
    let from = account_id(&mut tx, &req.from, &req.asset).await?;
    let to = account_id(&mut tx, &req.to, &req.asset).await?;

    let locked = lock_accounts(&mut tx, &[from, to]).await?;
    let source = locked
        .iter()
        .find(|a| a.id == from)
        .expect("source account locked");
    if !source.allow_negative && source.balance - source.held < req.amount {
        return Err(LedgerError::InsufficientFunds);
    }

    insert_legs(
        &mut tx,
        entry_id,
        &[
            Leg {
                account_id: from,
                asset: req.asset.clone(),
                amount: -req.amount,
            },
            Leg {
                account_id: to,
                asset: req.asset.clone(),
                amount: req.amount,
            },
        ],
    )
    .await?;
    tx.commit().await?;
    load_entry(pool, entry_id, false).await
}

/// Where a closed account's leftover balances go. Kept on Tappi's books (the customer, or their
/// estate, can still claim it), never mixed with revenue.
pub const CLOSED_ACCOUNTS: &str = "closed_accounts";

/// The entry recorded under an idempotency key, for a caller whose request timed out and needs to
/// know whether the money moved.
pub async fn entry_by_key(pool: &PgPool, key: &str) -> Result<Entry, LedgerError> {
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM engine.journal_entries WHERE idempotency_key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?
            .ok_or(LedgerError::NotFound)?;
    load_entry(pool, id, true).await
}

/// Sweeps every balance a closing user has left to `CLOSED_ACCOUNTS`, as one entry. Returns None
/// when there was nothing to sweep. Refused while any of their money is on hold. Safe to repeat.
pub async fn close_account(pool: &PgPool, user_id: &str) -> Result<Option<Entry>, LedgerError> {
    let key = format!("close:user:{user_id}");
    let mut tx = pool.begin().await?;
    let Some(entry_id) = insert_entry(
        &mut tx,
        &key,
        "-",
        "account_closure",
        None,
        &Value::Object(Default::default()),
    )
    .await?
    else {
        tx.rollback().await?;
        return entry_by_key(pool, &key).await.map(Some);
    };

    let accounts: Vec<(Uuid, String, i64, i64)> = sqlx::query_as(
        "SELECT id, asset, balance, held FROM engine.accounts
         WHERE owner_type = 'user' AND owner_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    if accounts.iter().any(|(_, _, _, held)| *held > 0) {
        return Err(LedgerError::HasActiveHolds);
    }
    let mut legs = Vec::new();
    for (id, asset, balance, _) in accounts
        .into_iter()
        .filter(|(_, _, balance, _)| *balance > 0)
    {
        let sink = account_id(&mut tx, &Owner::system(CLOSED_ACCOUNTS), &asset).await?;
        legs.push(Leg {
            account_id: id,
            asset: asset.clone(),
            amount: -balance,
        });
        legs.push(Leg {
            account_id: sink,
            asset,
            amount: balance,
        });
    }
    if legs.is_empty() {
        // Nothing to sweep: don't keep an empty entry, so a later deposit could still be swept.
        tx.rollback().await?;
        return Ok(None);
    }
    insert_legs(&mut tx, entry_id, &legs).await?;
    tx.commit().await?;
    load_entry(pool, entry_id, false).await.map(Some)
}

/// Every asset with the owner's balance (zero where they have no account yet).
pub async fn balances(pool: &PgPool, owner: &Owner) -> Result<Vec<Balance>, LedgerError> {
    Ok(sqlx::query_as(
        "SELECT s.code AS asset, s.decimals,
                coalesce(a.balance, 0) AS balance,
                coalesce(a.held, 0) AS held,
                coalesce(a.balance - a.held, 0) AS available
         FROM engine.assets s
         LEFT JOIN engine.accounts a ON a.asset = s.code AND a.owner_type = $1 AND a.owner_id = $2
         ORDER BY s.code",
    )
    .bind(owner.owner_type)
    .bind(&owner.owner_id)
    .fetch_all(pool)
    .await?)
}

pub async fn get_hold(pool: &PgPool, id: Uuid) -> Result<Hold, LedgerError> {
    sqlx::query_as(
        "SELECT h.id, h.idempotency_key, a.owner_type, a.owner_id, a.asset, h.amount, h.status,
                h.reference, h.entry_id, h.created_at
         FROM engine.holds h JOIN engine.accounts a ON a.id = h.account_id
         WHERE h.id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(LedgerError::NotFound)
}

/// Reserves money so it can't be spent while something is pending. Safe to retry with the same key.
pub async fn create_hold(pool: &PgPool, req: &HoldRequest) -> Result<Hold, LedgerError> {
    validate_amount(req.amount)?;
    if req.owner.owner_type != OwnerType::User {
        return Err(LedgerError::NotAUser);
    }
    let hash = request_hash(req);

    let mut tx = pool.begin().await?;
    ensure_asset(&mut tx, &req.asset).await?;
    let account = account_id(&mut tx, &req.owner, &req.asset).await?;
    let hold_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO engine.holds (idempotency_key, request_hash, account_id, amount, reference)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id",
    )
    .bind(&req.idempotency_key)
    .bind(&hash)
    .bind(account)
    .bind(req.amount)
    .bind(&req.reference)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(hold_id) = hold_id else {
        tx.rollback().await?;
        let (id, stored): (Uuid, String) =
            sqlx::query_as("SELECT id, request_hash FROM engine.holds WHERE idempotency_key = $1")
                .bind(&req.idempotency_key)
                .fetch_one(pool)
                .await?;
        if stored != hash {
            return Err(LedgerError::IdempotencyConflict);
        }
        return get_hold(pool, id).await;
    };

    let locked = lock_accounts(&mut tx, &[account]).await?;
    if locked[0].balance - locked[0].held < req.amount {
        return Err(LedgerError::InsufficientFunds);
    }
    sqlx::query("UPDATE engine.accounts SET held = held + $2 WHERE id = $1")
        .bind(account)
        .bind(req.amount)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    get_hold(pool, hold_id).await
}

#[derive(sqlx::FromRow)]
struct LockedHold {
    account_id: Uuid,
    amount: i64,
    status: HoldStatus,
    entry_id: Option<Uuid>,
}

async fn lock_hold(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<LockedHold, LedgerError> {
    sqlx::query_as(
        "SELECT account_id, amount, status, entry_id FROM engine.holds WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(LedgerError::NotFound)
}

/// Moves the held money to `to`. Capturing an already-captured hold returns the same entry.
pub async fn capture_hold(
    pool: &PgPool,
    id: Uuid,
    req: &CaptureRequest,
) -> Result<Entry, LedgerError> {
    let mut tx = pool.begin().await?;
    let hold = lock_hold(&mut tx, id).await?;
    match hold.status {
        HoldStatus::Captured => {
            tx.rollback().await?;
            return load_entry(
                pool,
                hold.entry_id.expect("captured hold has an entry"),
                true,
            )
            .await;
        }
        HoldStatus::Released => return Err(LedgerError::HoldClosed),
        HoldStatus::Active => {}
    }

    let asset: String = sqlx::query_scalar("SELECT asset FROM engine.accounts WHERE id = $1")
        .bind(hold.account_id)
        .fetch_one(&mut *tx)
        .await?;
    let to = account_id(&mut tx, &req.to, &asset).await?;
    if to == hold.account_id {
        return Err(LedgerError::SameAccount);
    }
    let metadata = req
        .metadata
        .clone()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let reference = format!("hold:{id}");
    let entry_id = insert_entry(
        &mut tx,
        &format!("hold:{id}:capture"),
        &request_hash(req),
        &req.kind,
        Some(&reference),
        &metadata,
    )
    .await?
    .ok_or(LedgerError::IdempotencyConflict)?;

    lock_accounts(&mut tx, &[hold.account_id, to]).await?;
    sqlx::query("UPDATE engine.accounts SET held = held - $2 WHERE id = $1")
        .bind(hold.account_id)
        .bind(hold.amount)
        .execute(&mut *tx)
        .await?;
    insert_legs(
        &mut tx,
        entry_id,
        &[
            Leg {
                account_id: hold.account_id,
                asset: asset.clone(),
                amount: -hold.amount,
            },
            Leg {
                account_id: to,
                asset,
                amount: hold.amount,
            },
        ],
    )
    .await?;
    sqlx::query("UPDATE engine.holds SET status = 'captured', entry_id = $2, closed_at = now() WHERE id = $1")
        .bind(id)
        .bind(entry_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    load_entry(pool, entry_id, false).await
}

/// Gives the held money back. Releasing twice is fine; releasing a captured hold is not.
pub async fn release_hold(pool: &PgPool, id: Uuid) -> Result<Hold, LedgerError> {
    let mut tx = pool.begin().await?;
    let hold = lock_hold(&mut tx, id).await?;
    match hold.status {
        HoldStatus::Released => {}
        HoldStatus::Captured => return Err(LedgerError::HoldClosed),
        HoldStatus::Active => {
            lock_accounts(&mut tx, &[hold.account_id]).await?;
            sqlx::query("UPDATE engine.accounts SET held = held - $2 WHERE id = $1")
                .bind(hold.account_id)
                .bind(hold.amount)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE engine.holds SET status = 'released', closed_at = now() WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    get_hold(pool, id).await
}
