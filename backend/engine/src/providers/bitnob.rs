//! Bitnob Business API (custodial): crypto deposit addresses per user, crediting deposits from
//! webhooks, and sending crypto out. See backend/docs/bitnob.md.
//!
//! Bitnob holds the crypto in Tappi's company balance; the engine's ledger says which user owns
//! what. One host serves sandbox and live: the keys decide which.

use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Sha256, Sha512};
use sqlx::PgPool;
use uuid::Uuid;

use super::{NewAccount, NewPayout, Op, Provider, book_fee, emit_event, signed_text};
use crate::error::LedgerError;
use crate::providers;

#[derive(Clone, Debug)]
pub struct BitnobConfig {
    pub client_id: String,
    pub client_secret: String,
    /// Signs webhooks (dashboard → Settings → Webhooks); not the API secret.
    pub webhook_secret: String,
    /// Tests point it at a fake server.
    pub base_url: String,
    /// What the USD card costs users (see `usdcard::CardFees`).
    pub card_fees: super::usdcard::CardFees,
}

pub const BASE_URL: &str = "https://api.bitnob.com";

/// Assets Tappi holds through Bitnob, and the chains a user can deposit or send them on.
/// Bitnob's own list (GET /api/addresses/supported-chains) is the final word per account.
pub const CHAINS: &[(&str, &[&str])] = &[
    ("USDT", &["tron", "ethereum", "polygon", "solana", "bsc"]),
    ("USDC", &["ethereum", "polygon", "solana", "base", "bsc"]),
    ("BTC", &["bitcoin"]),
];

pub fn chain_supported(asset: &str, chain: &str) -> bool {
    CHAINS
        .iter()
        .any(|(a, chains)| *a == asset && chains.contains(&chain))
}

#[derive(Debug, thiserror::Error)]
pub enum BitnobError {
    #[error("Bitnob unreachable: {0}")]
    Unreachable(String),
    /// Bitnob answered with an error; `code` is its machine-readable reason.
    #[error("Bitnob answered HTTP {status} ({code}): {detail}")]
    Api {
        status: u16,
        code: String,
        detail: String,
    },
    #[error("unexpected answer from Bitnob: {0}")]
    BadResponse(String),
    #[error("Bitnob isn't configured")]
    NotConfigured,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Ledger(#[from] LedgerError),
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client")
    })
}

/// Bitnob's request signature: hex HMAC-SHA256(client secret, "CLIENT_ID:TIMESTAMP:NONCE:BODY").
pub fn sign(cfg: &BitnobConfig, timestamp: &str, nonce: &str, body: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(cfg.client_secret.as_bytes()).expect("any key length");
    mac.update(format!("{}:{timestamp}:{nonce}:{body}", cfg.client_id).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Webhook check: hex HMAC-SHA512 of the raw body with the webhook secret.
pub fn verify_webhook(cfg: &BitnobConfig, raw_body: &[u8], signature: Option<&str>) -> bool {
    let Some(signature) = signature else {
        return false;
    };
    let mut mac =
        Hmac::<Sha512>::new_from_slice(cfg.webhook_secret.as_bytes()).expect("any key length");
    mac.update(raw_body);
    let expected = hex::encode(mac.finalize().into_bytes());
    crate::http::constant_time_eq(
        expected.as_bytes(),
        signature.trim().to_ascii_lowercase().as_bytes(),
    )
}

pub(crate) async fn call(
    cfg: &BitnobConfig,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, BitnobError> {
    // Serialised once: the signature covers exactly these bytes.
    let payload = body.map(Value::to_string).unwrap_or_default();
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let nonce = Uuid::new_v4().simple().to_string();
    let mut request = client()
        .request(
            method,
            format!("{}{path}", cfg.base_url.trim_end_matches('/')),
        )
        .header("X-Auth-Client", &cfg.client_id)
        .header("X-Auth-Timestamp", &timestamp)
        .header("X-Auth-Nonce", &nonce)
        .header("X-Auth-Signature", sign(cfg, &timestamp, &nonce, &payload));
    if body.is_some() {
        request = request
            .header("content-type", "application/json")
            .body(payload);
    }
    let response = request
        .send()
        .await
        .map_err(|e| BitnobError::Unreachable(e.to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| BitnobError::Unreachable(e.to_string()))?;
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() || parsed.get("success") == Some(&Value::Bool(false)) {
        let error = parsed.get("error").unwrap_or(&parsed);
        let summary = [
            signed_text(error.get("detail")),
            signed_text(error.get("message")),
            signed_text(parsed.get("message")),
        ]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| text.chars().take(300).collect());
        // Validation errors say what's wrong per field: {"details": {"phone_number": "…"}}.
        let fields: Vec<String> = error
            .get("details")
            .and_then(Value::as_object)
            .map(|d| {
                d.iter()
                    .filter_map(|(_, v)| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        return Err(BitnobError::Api {
            status: status.as_u16(),
            code: signed_text(error.get("code")),
            detail: if fields.is_empty() || summary != "Validation failed" {
                summary
            } else {
                fields.join(". ")
            },
        });
    }
    parsed
        .get("data")
        .cloned()
        .ok_or_else(|| BitnobError::BadResponse(text.chars().take(300).collect()))
}

/// Which environment the keys belong to ("sandbox" / "production"): logged at start-up.
pub async fn whoami(cfg: &BitnobConfig) -> Result<Value, BitnobError> {
    call(cfg, reqwest::Method::GET, "/api/whoami", None).await
}

// ---------------- Customers and deposit addresses ----------------

pub struct Holder<'a> {
    pub owner_id: &'a str,
    pub email: &'a str,
    pub first_name: Option<&'a str>,
    pub last_name: Option<&'a str>,
}

/// Bitnob's customer record for a user (created once; Bitnob also dedupes by email).
async fn ensure_customer(
    pool: &PgPool,
    cfg: &BitnobConfig,
    holder: &Holder<'_>,
) -> Result<String, BitnobError> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT external_id FROM engine.provider_customers WHERE provider = 'bitnob' AND owner_id = $1")
            .bind(holder.owner_id)
            .fetch_optional(pool)
            .await
            .map_err(LedgerError::from)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let created = call(
        cfg,
        reqwest::Method::POST,
        "/api/customers",
        Some(&json!({
            "email": holder.email,
            "customer_type": "individual",
            "first_name": holder.first_name,
            "last_name": holder.last_name,
        })),
    )
    .await?;
    let id = created
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| BitnobError::BadResponse(created.to_string()))?;
    sqlx::query(
        "INSERT INTO engine.provider_customers (provider, owner_id, external_id) VALUES ('bitnob', $1, $2)
         ON CONFLICT (provider, owner_id) DO NOTHING",
    )
    .bind(holder.owner_id)
    .bind(id)
    .execute(pool)
    .await
    .map_err(LedgerError::from)?;
    Ok(id.to_owned())
}

/// The user's deposit address for `asset` on `chain`, created at Bitnob the first time. One address
/// per user per chain (USDT and USDC on the same chain share it).
pub async fn ensure_address(
    pool: &PgPool,
    cfg: &BitnobConfig,
    holder: Holder<'_>,
    asset: &str,
    chain: &str,
) -> Result<providers::ProviderAccount, BitnobError> {
    if !chain_supported(asset, chain) {
        return Err(BitnobError::Invalid(format!(
            "{asset} isn't available on {chain}"
        )));
    }
    let mine = providers::accounts_of(pool, holder.owner_id).await?;
    let on_chain = |a: &&providers::ProviderAccount| {
        a.provider == "bitnob" && a.network.as_deref() == Some(chain)
    };
    if let Some(existing) = mine.iter().find(|a| on_chain(a) && a.asset == asset) {
        return Ok(existing.clone());
    }
    // Same chain, other stablecoin: same address, recorded for this asset too.
    let address = match mine.iter().find(on_chain) {
        Some(other) => other.external_id.clone(),
        None => {
            let customer = ensure_customer(pool, cfg, &holder).await?;
            let created = call(
                cfg,
                reqwest::Method::POST,
                "/api/addresses",
                Some(&json!({
                    "chain": chain,
                    "customer_id": customer,
                    "label": format!("tappi {chain}"),
                    // Unique per user and chain: a retry gets the same address, not a second one.
                    "reference": format!("tappi-{}-{chain}", holder.owner_id),
                })),
            )
            .await;
            let created = match created {
                Ok(created) => created,
                // Made by an earlier attempt we never heard back from: find it.
                Err(BitnobError::Api { status: 409, .. }) => {
                    find_address(cfg, &customer, chain).await?
                }
                Err(error) => return Err(error),
            };
            created
                .get("address")
                .and_then(Value::as_str)
                .ok_or_else(|| BitnobError::BadResponse(created.to_string()))?
                .to_owned()
        }
    };
    // Accounts are unique per provider + external id, so the second asset on a chain is stored under
    // "address#ASSET"; deposits are matched on the address itself (see `owner_of_address`).
    let external_id = if mine.iter().any(|a| on_chain(&a)) {
        format!("{address}#{asset}")
    } else {
        address.clone()
    };
    Ok(providers::save_account(
        pool,
        NewAccount {
            provider: Provider::Bitnob,
            owner_id: holder.owner_id,
            kind: "address",
            asset,
            network: Some(chain),
            external_id: &external_id,
            details: json!({ "address": address, "chain": chain, "asset": asset }),
        },
    )
    .await?)
}

async fn find_address(
    cfg: &BitnobConfig,
    customer: &str,
    chain: &str,
) -> Result<Value, BitnobError> {
    let listed = call(
        cfg,
        reqwest::Method::GET,
        &format!("/api/addresses?chain={chain}&customer_id={customer}"),
        None,
    )
    .await?;
    let rows = listed
        .get("addresses")
        .or_else(|| listed.get("items"))
        .unwrap_or(&listed);
    rows.as_array()
        .and_then(|rows| rows.first())
        .cloned()
        .ok_or_else(|| BitnobError::BadResponse(listed.to_string()))
}

async fn owner_of_address(pool: &PgPool, address: &str) -> Result<Option<String>, LedgerError> {
    Ok(providers::find_account(pool, Provider::Bitnob, address)
        .await?
        .map(|a| a.owner_id))
}

// ---------------- Sending crypto out ----------------

pub struct CryptoSend<'a> {
    pub key: &'a str,
    pub owner_id: &'a str,
    pub asset: &'a str,
    pub chain: &'a str,
    /// Smallest units (satoshis, micro-dollars).
    pub amount: i64,
    pub to_address: &'a str,
}

/// Sends a user's crypto to an outside address. The user's balance is held until Bitnob reports the
/// result (`transfer.success` / `transfer.failed` webhook).
pub async fn send(pool: &PgPool, cfg: &BitnobConfig, s: CryptoSend<'_>) -> Result<Op, BitnobError> {
    if !chain_supported(s.asset, s.chain) {
        return Err(BitnobError::Invalid(format!(
            "{} can't be sent on {}",
            s.asset, s.chain
        )));
    }
    let check = call(
        cfg,
        reqwest::Method::POST,
        "/api/addresses/validate",
        Some(&json!({ "address": s.to_address, "chain": s.chain })),
    )
    .await?;
    if check.get("valid") != Some(&Value::Bool(true)) {
        return Err(BitnobError::Invalid(format!(
            "That isn't a valid {} address.",
            s.chain
        )));
    }
    let op = providers::start_payout(
        pool,
        NewPayout {
            provider: Provider::Bitnob,
            kind: "crypto_send",
            key: s.key,
            owner_id: s.owner_id,
            asset: s.asset,
            amount: s.amount,
            request: json!({ "toAddress": s.to_address, "chain": s.chain }),
        },
    )
    .await?;
    if op.status != "created" {
        return Ok(op);
    }
    providers::mark_submitted(pool, op.id, 300).await?;
    let reference = op.id.simple().to_string();
    let result = call(
        cfg,
        reqwest::Method::POST,
        "/api/withdrawals",
        Some(&json!({
            "to_address": s.to_address,
            "amount": s.amount.to_string(),
            "currency": s.asset,
            "chain": s.chain,
            "reference": reference,
            "description": "Tappi send",
        })),
    )
    .await;
    match result {
        Ok(body) => {
            providers::mark_pending(
                pool,
                op.id,
                body.get("transaction_id").and_then(Value::as_str),
                &body,
                600,
            )
            .await?;
        }
        // Already sent under this reference by an attempt we never heard back from: wait for the webhook.
        Err(BitnobError::Api { status: 409, .. }) => {
            providers::mark_pending(pool, op.id, None, &json!({ "duplicate": true }), 600).await?;
        }
        // Refused before anything moved: the user's money comes back.
        Err(BitnobError::Api {
            status,
            code,
            detail,
        }) if (400..500).contains(&status) && status != 408 && status != 429 => {
            tracing::warn!(status, %code, %detail, "Bitnob refused a crypto send");
            let op = providers::fail_op(pool, op.id, &format!("{code}: {detail}"), None).await?;
            emit_event(
                pool,
                s.owner_id,
                "crypto_send_failed",
                json!({ "opId": op.id, "reason": detail }),
                &format!("send:{}:failed", op.id),
            )
            .await?;
        }
        // No clear answer: hold the money and wait for the webhook.
        Err(error) => {
            tracing::warn!(%error, op = %op.id, "crypto send outcome unknown; waiting for Bitnob's webhook");
            providers::mark_pending(
                pool,
                op.id,
                None,
                &json!({ "error": error.to_string() }),
                600,
            )
            .await?;
        }
    }
    Ok(providers::get_op(pool, op.id).await?)
}

// ---------------- Webhooks ----------------

/// A verified webhook from Bitnob. Each event is applied once (deduped on `event_id`); problems are
/// kept on the stored event for a person to look at.
pub async fn handle_webhook(pool: &PgPool, body: &Value) -> Result<(), BitnobError> {
    let event_id = signed_text(body.get("event_id"));
    let kind = signed_text(body.get("event"));
    if event_id.is_empty() {
        return Err(BitnobError::BadResponse("webhook without event_id".into()));
    }
    let stored =
        providers::record_webhook(pool, Provider::Bitnob, &event_id, Some(&kind), body).await?;
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    let outcome = match kind.as_str() {
        "deposit.success" => credit_deposit(pool, &data).await,
        "transfer.success" => settle_send(pool, &data, true).await,
        "transfer.failed" => settle_send(pool, &data, false).await,
        "trade.completed" | "trade.failed" => {
            super::trading::handle_webhook(pool, &kind, &data).await
        }
        k if k.starts_with("virtualcard.") => super::usdcard::handle_webhook(pool, k, &data).await,
        // International payouts: not used yet.
        _ => Ok(()),
    };
    if let Some(id) = stored {
        providers::finish_webhook(pool, id, outcome.as_ref().err().map(String::as_str)).await?;
    }
    Ok(())
}

fn units(data: &Value, field: &str) -> Option<i64> {
    let text = signed_text(data.get(field));
    if text.is_empty() {
        Some(0)
    } else {
        text.parse().ok()
    }
}

async fn credit_deposit(pool: &PgPool, data: &Value) -> Result<(), String> {
    let address = signed_text(data.get("address"));
    let asset = signed_text(data.get("currency")).to_ascii_uppercase();
    let txn = signed_text(data.get("transaction_id"));
    let owner = owner_of_address(pool, &address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no Tappi user has Bitnob address {address}"))?;
    if !matches!(asset.as_str(), "USDT" | "USDC" | "BTC") {
        return Err(format!("unsupported deposit currency {asset}"));
    }
    let amount = units(data, "amount")
        .filter(|a| *a > 0)
        .ok_or("unreadable amount")?;
    let entry = providers::credit_deposit(
        pool,
        Provider::Bitnob,
        &txn,
        &owner,
        &asset,
        amount,
        json!({ "chain": data.get("chain"), "hash": data.get("hash"), "from": data.get("from_address") }),
    )
    .await
    .map_err(|e| e.to_string())?;
    let fee = units(data, "fee").unwrap_or(0);
    book_fee(
        pool,
        Provider::Bitnob,
        &format!("deposit:{txn}"),
        &asset,
        fee,
    )
    .await
    .map_err(|e| e.to_string())?;
    let chain = signed_text(data.get("chain"));
    emit_event(
        pool,
        &owner,
        "deposit",
        json!({ "asset": asset, "amount": amount, "entryId": entry.id, "from": format!("{asset} on {chain}"), "provider": "bitnob" }),
        &format!("deposit:{}", entry.id),
    )
    .await
    .map_err(|e| e.to_string())
}

async fn settle_send(pool: &PgPool, data: &Value, success: bool) -> Result<(), String> {
    let reference = signed_text(data.get("reference"));
    let op_id =
        Uuid::parse_str(&reference).map_err(|_| format!("not a Tappi send: {reference}"))?;
    if success {
        let op = providers::succeed_op(
            pool,
            op_id,
            data.get("transaction_id").and_then(Value::as_str),
            data,
        )
        .await
        .map_err(|e| e.to_string())?;
        let asset = op.asset.clone().unwrap_or_default();
        // Bitnob's network fee comes out of Tappi's balance on top of the amount: Tappi's cost.
        book_fee(
            pool,
            Provider::Bitnob,
            &format!("send:{op_id}"),
            &asset,
            units(data, "fee").unwrap_or(0),
        )
        .await
        .map_err(|e| e.to_string())?;
        if let (Some(owner), Some(amount), Some(hold_id)) = (&op.owner_id, op.amount, op.hold_id) {
            let entry = crate::ledger::entry_by_key(pool, &format!("hold:{hold_id}:capture"))
                .await
                .map_err(|e| e.to_string())?;
            emit_event(
                pool,
                owner,
                "crypto_send_succeeded",
                json!({ "opId": op.id, "entryId": entry.id, "asset": asset, "amount": amount, "request": op.request }),
                &format!("send:{op_id}:done"),
            )
            .await
            .map_err(|e| e.to_string())?;
        }
    } else {
        let op = providers::fail_op(pool, op_id, "Bitnob couldn't send it", Some(data))
            .await
            .map_err(|e| e.to_string())?;
        if let Some(owner) = &op.owner_id {
            emit_event(
                pool,
                owner,
                "crypto_send_failed",
                json!({ "opId": op.id }),
                &format!("send:{op_id}:failed"),
            )
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------- Reconciliation ----------------

/// Bitnob's balances next to what our books say Bitnob should hold, per asset.
pub async fn reconcile(pool: &PgPool, cfg: &BitnobConfig) -> Result<Value, BitnobError> {
    let balances = call(cfg, reqwest::Method::GET, "/api/balances", None).await?;
    let expected = providers::expected_provider_balances(pool, Provider::Bitnob).await?;
    let accounts = balances
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // NGN too: naira swaps spend Tappi's naira float held at Bitnob.
    let report: Vec<Value> = ["NGN", "USDT", "USDC", "BTC"]
        .iter()
        .map(|asset| {
            let actual = accounts
                .iter()
                .find(|a| signed_text(a.get("currency")).eq_ignore_ascii_case(asset))
                .and_then(|a| signed_text(a.get("available_balance")).parse::<i64>().ok());
            let expected = expected.iter().find(|(a, _)| a == asset).map(|(_, v)| *v).unwrap_or(0);
            json!({ "asset": asset, "expected": expected, "actual": actual, "difference": actual.map(|a| a - expected) })
        })
        .collect();
    Ok(Value::Array(report))
}

/// Runs forever: settles trades whose outcome is unclear (every 10 s, they're quick).
pub async fn run_trade_checker(pool: PgPool, cfg: std::sync::Arc<BitnobConfig>) {
    loop {
        match providers::due_for_check(&pool, 50).await {
            Ok(ops) => {
                for op in ops
                    .iter()
                    .filter(|op| op.provider == "bitnob" && op.kind == "trade")
                {
                    if let Err(error) = super::trading::check(&pool, &cfg, op).await {
                        tracing::warn!(%error, op = %op.id, "trade check failed");
                    }
                }
            }
            Err(error) => tracing::error!(%error, "loading trades to check"),
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

/// Runs forever: hourly reconciliation, and a warning for sends Bitnob hasn't reported on in a day.
pub async fn run_checker(pool: PgPool, cfg: std::sync::Arc<BitnobConfig>) {
    loop {
        match reconcile(&pool, &cfg).await {
            Ok(report) => {
                let short = report
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|r| r["difference"].as_i64().is_some_and(|d| d < 0));
                if short {
                    tracing::error!(%report, "Bitnob holds LESS than Tappi owes its users");
                } else {
                    tracing::info!(%report, "bitnob reconciliation");
                }
            }
            Err(error) => tracing::warn!(%error, "bitnob reconciliation failed"),
        }
        let stuck: Result<Vec<(Uuid,)>, _> = sqlx::query_as(
            "SELECT id FROM engine.provider_ops WHERE provider = 'bitnob' AND status IN ('submitted', 'pending')
             AND created_at < now() - interval '1 day'",
        )
        .fetch_all(&pool)
        .await;
        if let Ok(stuck) = stuck
            && !stuck.is_empty()
        {
            tracing::error!(
                count = stuck.len(),
                "Bitnob sends with no result after a day: check them in the Bitnob dashboard"
            );
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
