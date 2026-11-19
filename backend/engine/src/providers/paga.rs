//! Paga Engine: customer account numbers (subsidiary accounts, auto-swept into Tappi's business
//! balance), deposit webhooks, and payouts to Nigerian banks. See backend/docs/paga.md.
//!
//! Paga's rule for payouts: never resend after a timeout or an unclear answer. We ask
//! `transactionStatus` with the same reference instead (the background checker does), and only a
//! clear final failure gives the user their money back.

use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    NewAccount, NewPayout, Op, Provider, book_fee, emit_event, major_to_minor, minor_to_major,
    signed_text,
};
use crate::error::LedgerError;
use crate::providers;

#[derive(Clone, Debug)]
pub struct PagaConfig {
    pub public_key: String,
    pub secret_key: String,
    pub hash_key: String,
    pub live: bool,
    /// Our public address (https://…); Paga posts webhooks to {public_url}/api/webhooks/paga/….
    pub public_url: String,
    /// Tests point both Paga APIs at a fake server.
    pub base_override: Option<String>,
}

impl PagaConfig {
    fn business_base(&self) -> &str {
        match &self.base_override {
            Some(base) => base,
            None if self.live => "https://www.mypaga.com",
            None => "https://beta.mypaga.com",
        }
    }

    fn collect_base(&self) -> &str {
        match &self.base_override {
            Some(base) => base,
            None if self.live => "https://collect.paga.com",
            None => "https://beta-collect.paga.com",
        }
    }

    fn webhook_url(&self, kind: &str) -> String {
        format!(
            "{}/api/webhooks/paga/{kind}",
            self.public_url.trim_end_matches('/')
        )
    }

    /// Lowercase hex SHA-512 of the parts, then the hash key, with no separators.
    pub fn hash(&self, parts: &[&str]) -> String {
        let mut hasher = Sha512::new();
        for part in parts {
            hasher.update(part.as_bytes());
        }
        hasher.update(self.hash_key.as_bytes());
        hex::encode(hasher.finalize())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PagaError {
    /// No answer (network, timeout): the outcome is unknown.
    #[error("Paga unreachable: {0}")]
    Unreachable(String),
    /// Paga answered with an HTTP error. 400/401/403 mean the request wasn't processed.
    #[error("Paga answered HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("unexpected answer from Paga: {0}")]
    BadResponse(String),
    #[error("Paga isn't configured")]
    NotConfigured,
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

async fn read(response: reqwest::Response) -> Result<Value, PagaError> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| PagaError::Unreachable(e.to_string()))?;
    if !status.is_success() {
        return Err(PagaError::Http {
            status: status.as_u16(),
            body: text.chars().take(500).collect(),
        });
    }
    serde_json::from_str(&text)
        .map_err(|_| PagaError::BadResponse(text.chars().take(500).collect()))
}

/// Business API: payouts, banks, status, balance.
async fn business(
    cfg: &PagaConfig,
    op: &str,
    hash: String,
    body: Value,
) -> Result<Value, PagaError> {
    let response = client()
        .post(format!(
            "{}/paga-webservices/business-rest/secured/{op}",
            cfg.business_base()
        ))
        .header("principal", &cfg.public_key)
        .header("credentials", &cfg.secret_key)
        .header("hash", hash)
        .json(&body)
        .send()
        .await
        .map_err(|e| PagaError::Unreachable(e.to_string()))?;
    read(response).await
}

fn basic_auth(cfg: &PagaConfig) -> String {
    let token = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", cfg.public_key, cfg.secret_key));
    format!("Basic {token}")
}

fn response_code(body: &Value, field: &str) -> Option<i64> {
    match body.get(field)? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn reference() -> String {
    Uuid::new_v4().simple().to_string()
}

// ---------------- Customer account numbers ----------------

/// Paga's permanent reference for a user's account: 30 characters, derived from our user id so a
/// retry asks for the same account.
pub fn account_reference(owner_id: &str) -> String {
    let compact: String = owner_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    format!("tp{}", &compact[..compact.len().min(28)])
}

pub struct AccountHolder<'a> {
    pub owner_id: &'a str,
    pub name: &'a str,
    pub email: Option<&'a str>,
    pub phone: Option<&'a str>,
}

/// The user's own NGN account number, created at Paga on first request. Deposits to it go
/// straight into Tappi's Paga balance (auto-sweep) and are credited to the user by the webhook.
pub async fn ensure_account(
    pool: &PgPool,
    cfg: &PagaConfig,
    holder: AccountHolder<'_>,
) -> Result<providers::ProviderAccount, PagaError> {
    if let Some(existing) = providers::accounts_of(pool, holder.owner_id)
        .await?
        .into_iter()
        .find(|a| a.provider == "paga" && a.kind == "nuban")
    {
        return Ok(existing);
    }
    let account_reference = account_reference(holder.owner_id);
    let reference_number = reference();
    let callback = cfg.webhook_url("funding");
    let destination = "VIRTUAL_ACCOUNT";
    let hash = cfg.hash(&[
        &reference_number,
        &account_reference,
        "",
        "",
        destination,
        "",
        &callback,
    ]);
    // Paga refuses an empty first or last name, so a one-word name is used for both.
    let name = match holder.name.trim() {
        "" => "Tappi Customer",
        name => name,
    };
    let (first, last) = name
        .split_once(' ')
        .map(|(first, last)| (first, last.trim()))
        .unwrap_or((name, name));
    let body = json!({
        "referenceNumber": reference_number,
        "accountReference": account_reference,
        "accountName": name,
        "firstName": first,
        "lastName": last,
        "email": holder.email,
        "phoneNumber": holder.phone,
        "callbackUrl": callback,
        // Documented as optional, but Paga's sandbox refuses the request without it.
        "status": "ACTIVE",
        "autoSweep": { "destination": destination },
    });
    let response = client()
        .post(format!("{}/subsidiary-accounts", cfg.collect_base()))
        .header("authorization", basic_auth(cfg))
        .header("hash", hash)
        .json(&body)
        .send()
        .await
        .map_err(|e| PagaError::Unreachable(e.to_string()))?;
    let mut created = read(response).await?;
    match response_code(&created, "statusCode") {
        Some(0) => {}
        // Already created by an earlier attempt that we didn't hear back from: fetch it.
        Some(102) => created = retrieve_account(cfg, &account_reference).await?,
        _ => return Err(PagaError::BadResponse(created.to_string())),
    }
    let number = created
        .get("accountNumber")
        .and_then(Value::as_str)
        .ok_or_else(|| PagaError::BadResponse(created.to_string()))?;
    Ok(providers::save_account(
        pool,
        NewAccount {
            provider: Provider::Paga,
            owner_id: holder.owner_id,
            kind: "nuban",
            asset: "NGN",
            network: None,
            external_id: number,
            details: json!({ "accountNumber": number, "accountName": holder.name, "bankName": "Paga", "accountReference": account_reference }),
        },
    )
    .await?)
}

async fn retrieve_account(cfg: &PagaConfig, account_reference: &str) -> Result<Value, PagaError> {
    let reference_number = reference();
    let response = client()
        // Both are plain letters and digits: nothing to escape.
        .get(format!(
            "{}/subsidiary-accounts/{account_reference}?referenceNumber={reference_number}",
            cfg.collect_base()
        ))
        .header("authorization", basic_auth(cfg))
        .header("hash", cfg.hash(&[&reference_number, account_reference]))
        .send()
        .await
        .map_err(|e| PagaError::Unreachable(e.to_string()))?;
    let body = read(response).await?;
    match response_code(&body, "statusCode") {
        Some(0) => Ok(body),
        _ => Err(PagaError::BadResponse(body.to_string())),
    }
}

// ---------------- Banks ----------------

/// Every bank Paga can pay, as Paga lists them ({uuid, name, sortCode}). Cached for a day.
pub async fn banks(cfg: &PagaConfig) -> Result<Value, PagaError> {
    static CACHE: tokio::sync::Mutex<Option<(std::time::Instant, Value)>> =
        tokio::sync::Mutex::const_new(None);
    let mut cache = CACHE.lock().await;
    if let Some((at, banks)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(86_400)
    {
        return Ok(banks.clone());
    }
    let reference_number = reference();
    let body = business(
        cfg,
        "getBanks",
        cfg.hash(&[&reference_number]),
        json!({ "referenceNumber": reference_number }),
    )
    .await?;
    if response_code(&body, "responseCode") != Some(0) {
        return Err(PagaError::BadResponse(body.to_string()));
    }
    let banks = body.get("banks").cloned().unwrap_or(Value::Array(vec![]));
    *cache = Some((std::time::Instant::now(), banks.clone()));
    Ok(banks)
}

/// Name check before paying: the account holder's name and Paga's fee. None if the account is invalid.
pub async fn resolve_account(
    cfg: &PagaConfig,
    bank_uuid: &str,
    account_number: &str,
    amount_kobo: i64,
) -> Result<Option<Value>, PagaError> {
    let reference_number = reference();
    let amount = minor_to_major(amount_kobo, 2);
    let body = business(
        cfg,
        "validateDepositToBank",
        cfg.hash(&[&reference_number, &amount, bank_uuid, account_number]),
        json!({
            "referenceNumber": reference_number,
            "amount": amount,
            "destinationBankUUID": bank_uuid,
            "destinationBankAccountNumber": account_number,
        }),
    )
    .await?;
    Ok(match response_code(&body, "responseCode") {
        Some(0) => Some(json!({
            "accountName": body.get("destinationAccountHolderNameAtBank"),
            "fee": signed_text(body.get("fee")),
            "vat": signed_text(body.get("vat")),
        })),
        _ => None,
    })
}

// ---------------- Payouts ----------------

/// Response codes that are a definite "no": the money goes back to the user. Everything else that
/// isn't 0 is treated as pending and checked again (Paga: don't assume failure, don't resend).
const FINAL_FAILURES: &[i64] = &[4, 103, 104, 107, 114, 115, 136, 137, 138, 139];

pub struct BankPayout<'a> {
    pub key: &'a str,
    pub owner_id: &'a str,
    pub amount: i64,
    pub bank_uuid: &'a str,
    pub account_number: &'a str,
    pub account_name: Option<&'a str>,
    pub remarks: Option<&'a str>,
}

/// Sends a user's naira to a bank account. Returns the operation; its status says where it got
/// to (succeeded, failed, or pending for the checker or webhook to settle).
pub async fn payout(pool: &PgPool, cfg: &PagaConfig, p: BankPayout<'_>) -> Result<Op, PagaError> {
    let op = providers::start_payout(
        pool,
        NewPayout {
            provider: Provider::Paga,
            kind: "bank_payout",
            key: p.key,
            owner_id: p.owner_id,
            asset: "NGN",
            amount: p.amount,
            request: json!({
                "bankUuid": p.bank_uuid,
                "accountNumber": p.account_number,
                "accountName": p.account_name,
                "remarks": p.remarks,
            }),
        },
    )
    .await?;
    if op.status != "created" {
        return Ok(op);
    }
    // Recorded before the call: if we crash mid-request, the checker asks Paga what happened.
    providers::mark_submitted(pool, op.id, 60).await?;
    let reference_number = op.id.simple().to_string();
    let amount = minor_to_major(p.amount, 2);
    let result = business(
        cfg,
        "depositToBank",
        cfg.hash(&[&reference_number, &amount, p.bank_uuid, p.account_number]),
        json!({
            "referenceNumber": reference_number,
            "amount": amount,
            "currency": "NGN",
            "destinationBankUUID": p.bank_uuid,
            "destinationBankAccountNumber": p.account_number,
            "statusCallbackUrl": cfg.webhook_url("payout"),
            "remarks": p.remarks.unwrap_or("Tappi withdrawal"),
            "alternateSenderName": "Tappi",
        }),
    )
    .await;
    settle_payout(pool, op.id, result).await
}

/// Applies an answer about a payout (from sending it, a status check or a webhook).
async fn settle_payout(
    pool: &PgPool,
    op_id: Uuid,
    result: Result<Value, PagaError>,
) -> Result<Op, PagaError> {
    match result {
        Ok(body) => match response_code(&body, "responseCode") {
            Some(0) => {
                let op = providers::succeed_op(
                    pool,
                    op_id,
                    body.get("transactionId").and_then(Value::as_str),
                    &body,
                )
                .await?;
                let fee = major_to_minor(&signed_text(body.get("fee")), 2).unwrap_or(0)
                    + major_to_minor(&signed_text(body.get("vat")), 2).unwrap_or(0);
                book_fee(pool, Provider::Paga, &op.id.to_string(), "NGN", fee).await?;
                if let (Some(owner), Some(amount), Some(hold_id)) =
                    (&op.owner_id, op.amount, op.hold_id)
                {
                    let entry =
                        crate::ledger::entry_by_key(pool, &format!("hold:{hold_id}:capture"))
                            .await?;
                    emit_event(
                        pool,
                        owner,
                        "payout_succeeded",
                        json!({ "opId": op.id, "entryId": entry.id, "asset": "NGN", "amount": amount, "request": op.request }),
                        &format!("payout:{}:done", op.id),
                    )
                    .await?;
                }
                Ok(op)
            }
            Some(code) if FINAL_FAILURES.contains(&code) => {
                let message = body
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Paga refused the transfer");
                let op =
                    providers::fail_op(pool, op_id, &format!("{code}: {message}"), Some(&body))
                        .await?;
                if let Some(owner) = &op.owner_id {
                    emit_event(
                        pool,
                        owner,
                        "payout_failed",
                        json!({ "opId": op.id, "reason": message }),
                        &format!("payout:{}:failed", op.id),
                    )
                    .await?;
                }
                Ok(op)
            }
            _ => {
                providers::mark_pending(
                    pool,
                    op_id,
                    body.get("transactionId").and_then(Value::as_str),
                    &body,
                    60,
                )
                .await?;
                Ok(providers::get_op(pool, op_id).await?)
            }
        },
        // Rejected before processing (bad keys, bad hash, IP not allow-listed): nothing was sent.
        Err(PagaError::Http {
            status: status @ (400 | 401 | 403),
            body,
        }) => {
            tracing::error!(status, %body, "Paga rejected a payout request; check keys, hash and IP allow-list");
            let op = providers::fail_op(pool, op_id, &format!("Paga HTTP {status}"), None).await?;
            Ok(op)
        }
        Err(error) => {
            tracing::warn!(%error, %op_id, "payout outcome unknown; will check its status");
            providers::mark_pending(
                pool,
                op_id,
                None,
                &json!({ "error": error.to_string() }),
                60,
            )
            .await?;
            Ok(providers::get_op(pool, op_id).await?)
        }
    }
}

/// Asks Paga about a payout whose outcome we're still waiting for.
pub async fn check_payout(pool: &PgPool, cfg: &PagaConfig, op: &Op) -> Result<Op, PagaError> {
    let reference_number = op.id.simple().to_string();
    let result = business(
        cfg,
        "transactionStatus",
        cfg.hash(&[&reference_number]),
        json!({ "referenceNumber": reference_number }),
    )
    .await;
    let settled = settle_payout(pool, op.id, result).await?;
    if settled.status == "pending" {
        // Back off: 1, 2, 4… minutes, at most an hour.
        let wait = 60i64.saturating_mul(1 << op.attempts.clamp(0, 6)).min(3600);
        providers::mark_pending(
            pool,
            op.id,
            None,
            settled.response.as_ref().unwrap_or(&Value::Null),
            wait,
        )
        .await?;
    }
    Ok(settled)
}

// ---------------- Webhooks ----------------

fn header_fields(header: Option<&str>) -> Option<Vec<String>> {
    let fields: Vec<String> = header?
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|f| !f.is_empty())
        .map(str::to_owned)
        .collect();
    (!fields.is_empty()).then_some(fields)
}

/// Checks a webhook's signature: SHA-512 of the named body fields, then the hash key. Paga may
/// say which fields it signed (`*-parameters` header); otherwise the documented order is used.
pub fn verify(
    cfg: &PagaConfig,
    body: &Value,
    signature: Option<&str>,
    parameters: Option<&str>,
    default_fields: &[&str],
) -> bool {
    let Some(signature) = signature else {
        return false;
    };
    let fields = header_fields(parameters)
        .unwrap_or_else(|| default_fields.iter().map(|f| (*f).to_owned()).collect());
    let values: Vec<String> = fields.iter().map(|f| signed_text(body.get(f))).collect();
    let refs: Vec<&str> = values.iter().map(String::as_str).collect();
    let expected = cfg.hash(&refs);
    let ok = crate::http::constant_time_eq(
        expected.as_bytes(),
        signature.trim().to_ascii_lowercase().as_bytes(),
    );
    if !ok {
        tracing::warn!(?fields, "Paga webhook signature didn't match");
    }
    ok
}

pub const FUNDING_FIELDS: &[&str] = &[
    "transactionReference",
    "transactionDate",
    "amount",
    "accountNumber",
    "timestamp",
];
pub const PAYOUT_FIELDS: &[&str] = &[
    "referenceNumber",
    "transactionDate",
    "transactionId",
    "amount",
    "sessionId",
];

/// Money arrived in a user's Paga account number. Credits them once, books Paga's clearing fee,
/// and tells the API. Errors are recorded on the stored webhook for a person to look at.
pub async fn handle_funding(pool: &PgPool, body: &Value) -> Result<(), PagaError> {
    let txn = signed_text(body.get("transactionReference"));
    if txn.is_empty() {
        return Err(PagaError::BadResponse(
            "funding webhook without transactionReference".into(),
        ));
    }
    let event = providers::record_webhook(
        pool,
        Provider::Paga,
        &format!("funding:{txn}"),
        Some("funding"),
        body,
    )
    .await?;
    let outcome = credit_funding(pool, &txn, body).await;
    if let Some(event_id) = event {
        providers::finish_webhook(pool, event_id, outcome.as_ref().err().map(String::as_str))
            .await?;
    }
    Ok(())
}

async fn credit_funding(pool: &PgPool, txn: &str, body: &Value) -> Result<(), String> {
    let number = signed_text(body.get("accountNumber"));
    let account = providers::find_account(pool, Provider::Paga, &number)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no Tappi user has Paga account {number}"))?;
    let amount = major_to_minor(&signed_text(body.get("amount")), 2).ok_or("unreadable amount")?;
    let payer = body.get("payerDetails").cloned().unwrap_or(Value::Null);
    let entry = providers::credit_deposit(
        pool,
        Provider::Paga,
        txn,
        &account.owner_id,
        "NGN",
        amount,
        json!({ "payer": payer }),
    )
    .await
    .map_err(|e| e.to_string())?;
    let fee = major_to_minor(&signed_text(body.get("clearingFeeAmount")), 2).unwrap_or(0);
    book_fee(pool, Provider::Paga, &format!("funding:{txn}"), "NGN", fee)
        .await
        .map_err(|e| e.to_string())?;
    let from = payer
        .get("payerName")
        .and_then(Value::as_str)
        .unwrap_or("Bank transfer");
    emit_event(
        pool,
        &account.owner_id,
        "deposit",
        json!({ "asset": "NGN", "amount": amount, "entryId": entry.id, "from": from, "provider": "paga" }),
        &format!("deposit:{}", entry.id),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Paga's word on a payout we sent.
pub async fn handle_payout(pool: &PgPool, body: &Value) -> Result<(), PagaError> {
    let reference_number = signed_text(body.get("referenceNumber"));
    let op_id = Uuid::parse_str(&reference_number)
        .map_err(|_| PagaError::BadResponse(format!("unknown payout {reference_number}")))?;
    let attempt = signed_text(body.get("transactionId"));
    let event = providers::record_webhook(
        pool,
        Provider::Paga,
        &format!("payout:{reference_number}:{attempt}"),
        Some("payout"),
        body,
    )
    .await?;
    let outcome = settle_payout(pool, op_id, Ok(body.clone())).await;
    if let Err(error) = &outcome {
        // E.g. a failure reported after the payout already succeeded: kept for a person to look at,
        // and acknowledged so Paga stops resending.
        tracing::error!(%error, %op_id, "couldn't apply a Paga payout notification");
    }
    if let Some(event_id) = event {
        providers::finish_webhook(
            pool,
            event_id,
            outcome.as_ref().err().map(|e| e.to_string()).as_deref(),
        )
        .await?;
    }
    Ok(())
}

// ---------------- Reconciliation ----------------

/// Paga's available balance next to what our books say Paga should hold.
pub async fn reconcile(pool: &PgPool, cfg: &PagaConfig) -> Result<Value, PagaError> {
    let reference_number = reference();
    let body = business(
        cfg,
        "accountBalance",
        cfg.hash(&[&reference_number]),
        json!({ "referenceNumber": reference_number }),
    )
    .await?;
    if response_code(&body, "responseCode") != Some(0) {
        // E.g. wrong keys, or this machine's IP not allow-listed by Paga: say so instead of a blank report.
        return Err(PagaError::BadResponse(format!(
            "accountBalance answered responseCode {}: {}",
            signed_text(body.get("responseCode")),
            signed_text(body.get("message"))
        )));
    }
    let actual = major_to_minor(&signed_text(body.get("availableBalance")), 2);
    let expected = providers::expected_provider_balances(pool, Provider::Paga)
        .await?
        .into_iter()
        .find(|(asset, _)| asset == "NGN")
        .map(|(_, amount)| amount)
        .unwrap_or(0);
    Ok(json!({
        "asset": "NGN",
        "expected": expected,
        "actual": actual,
        // Positive: Paga holds more than our users are owed (Tappi's own money, e.g. a float top-up).
        "difference": actual.map(|a| a - expected),
    }))
}

/// Runs forever: asks Paga about payouts whose outcome we're still waiting for (no webhook yet, or
/// we crashed mid-request), and logs reconciliation drift once an hour.
pub async fn run_checker(pool: PgPool, cfg: std::sync::Arc<PagaConfig>) {
    let mut last_reconcile = std::time::Instant::now() - Duration::from_secs(3600);
    loop {
        match providers::due_for_check(&pool, 50).await {
            Ok(ops) => {
                for op in ops
                    .iter()
                    .filter(|op| op.provider == "paga" && op.kind == "bank_payout")
                {
                    if let Err(error) = check_payout(&pool, &cfg, op).await {
                        tracing::warn!(%error, op = %op.id, "paga status check failed");
                    }
                }
            }
            Err(error) => tracing::error!(%error, "loading payouts to check"),
        }
        if last_reconcile.elapsed() >= Duration::from_secs(3600) {
            last_reconcile = std::time::Instant::now();
            match reconcile(&pool, &cfg).await {
                Ok(report) if report["difference"].as_i64().is_some_and(|d| d < 0) => {
                    tracing::error!(%report, "Paga holds LESS than Tappi owes its users");
                }
                Ok(report) => tracing::info!(%report, "paga reconciliation"),
                Err(error) => tracing::warn!(%error, "paga reconciliation failed"),
            }
        }
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
}
