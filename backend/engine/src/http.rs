//! The engine's HTTP API. Only the Tappi API calls it, over the private network, with the shared
//! token. Amounts are integers in the asset's smallest unit.

use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::LedgerError;
use crate::ledger::{
    self, CaptureRequest, HoldRequest, Owner, OwnerType, SANDBOX_MINT, TransferRequest,
};
use crate::providers::bitnob::{self, BitnobConfig, BitnobError};
use crate::providers::paga::{self, PagaConfig, PagaError};
use crate::providers::{self, Op};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub token: Arc<str>,
    pub sandbox: bool,
    pub paga: Option<Arc<PagaConfig>>,
    pub bitnob: Option<Arc<BitnobConfig>>,
}

pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/transfers", post(transfer))
        .route("/owners/{owner_type}/{owner_id}/balances", get(balances))
        .route("/holds", post(create_hold))
        .route("/holds/{id}", get(get_hold))
        .route("/holds/{id}/capture", post(capture_hold))
        .route("/holds/{id}/release", post(release_hold))
        .route("/entries/by-key/{key}", get(entry_by_key))
        .route("/owners/user/{owner_id}/close", post(close_account))
        .route("/sandbox/credit", post(sandbox_credit))
        .route("/sandbox/debit", post(sandbox_debit))
        .route("/events", get(events))
        .route("/ops/{id}", get(get_op))
        .route(
            "/owners/user/{owner_id}/provider-accounts",
            get(provider_accounts),
        )
        .route("/paga/accounts", post(paga_account))
        .route("/paga/banks", get(paga_banks))
        .route("/paga/resolve", post(paga_resolve))
        .route("/paga/payouts", post(paga_payout))
        .route("/paga/reconcile", get(paga_reconcile))
        .route("/bitnob/addresses", post(bitnob_address))
        .route("/bitnob/sends", post(bitnob_send))
        .route("/bitnob/reconcile", get(bitnob_reconcile))
        .route("/swaps/quote", post(swap_quote))
        .route("/swaps", post(swap_execute))
        .route("/usd-cards/occupations", get(card_occupations))
        .route("/usd-cards/fees", get(card_fees))
        .route("/usd-cards/kyc", post(card_kyc))
        .route("/usd-cards/{owner_id}", get(card_summary))
        .route("/usd-cards/{owner_id}/kyc", get(card_kyc_status))
        .route("/usd-cards/{owner_id}/create", post(card_create))
        .route("/usd-cards/{owner_id}/fund", post(card_fund))
        .route("/usd-cards/{owner_id}/withdraw", post(card_withdraw))
        .route("/usd-cards/{owner_id}/frozen", post(card_frozen))
        .route("/usd-cards/{owner_id}/terminate", post(card_terminate))
        .route("/usd-cards/{owner_id}/secrets", get(card_secrets))
        .route("/usd-cards/{owner_id}/transactions", get(card_transactions))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    // Webhooks carry no token: they come from the provider (forwarded by the API) and are trusted
    // only if their signature checks out.
    let webhooks = Router::new()
        .route("/paga/funding", post(paga_funding_webhook))
        .route("/paga/payout", post(paga_payout_webhook))
        .route("/bitnob/events", post(bitnob_webhook));
    Router::new()
        .route("/health", get(health))
        .nest("/v1", v1)
        .nest("/webhooks", webhooks)
        .with_state(state)
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, LedgerError> {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(presented.as_bytes(), state.token.as_bytes()) {
        return Err(LedgerError::Unauthorized);
    }
    Ok(next.run(request).await)
}

async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query("SELECT 1").execute(&state.pool).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(error) => {
            tracing::error!(%error, "health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false })),
            )
        }
    }
}

/// Moves money between two users (payments, sends, refunds). System accounts are only moved by
/// the engine itself (deposits, payouts, fees), never through this endpoint.
async fn transfer(
    State(state): State<AppState>,
    Json(req): Json<TransferRequest>,
) -> Result<(StatusCode, Json<ledger::Entry>), LedgerError> {
    if req.from.owner_type != OwnerType::User || req.to.owner_type != OwnerType::User {
        return Err(LedgerError::NotAUser);
    }
    let entry = ledger::transfer(&state.pool, &req).await?;
    let status = if entry.replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(entry)))
}

async fn balances(
    State(state): State<AppState>,
    Path((owner_type, owner_id)): Path<(OwnerType, String)>,
) -> Result<Json<Vec<ledger::Balance>>, LedgerError> {
    Ok(Json(
        ledger::balances(
            &state.pool,
            &Owner {
                owner_type,
                owner_id,
            },
        )
        .await?,
    ))
}

async fn create_hold(
    State(state): State<AppState>,
    Json(req): Json<HoldRequest>,
) -> Result<Json<ledger::Hold>, LedgerError> {
    Ok(Json(ledger::create_hold(&state.pool, &req).await?))
}

async fn get_hold(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ledger::Hold>, LedgerError> {
    Ok(Json(ledger::get_hold(&state.pool, id).await?))
}

async fn capture_hold(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<CaptureRequest>,
) -> Result<Json<ledger::Entry>, LedgerError> {
    if req.to.owner_type != OwnerType::User {
        return Err(LedgerError::NotAUser);
    }
    Ok(Json(ledger::capture_hold(&state.pool, id, &req).await?))
}

async fn release_hold(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ledger::Hold>, LedgerError> {
    Ok(Json(ledger::release_hold(&state.pool, id).await?))
}

async fn entry_by_key(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<ledger::Entry>, LedgerError> {
    Ok(Json(ledger::entry_by_key(&state.pool, &key).await?))
}

/// Account closure: sweeps whatever the user has left to Tappi's closed-accounts books.
async fn close_account(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<Value>, LedgerError> {
    let entry = ledger::close_account(&state.pool, &owner_id).await?;
    Ok(Json(json!({ "entry": entry })))
}

#[derive(Deserialize)]
struct SandboxMove {
    idempotency_key: String,
    owner_id: String,
    asset: String,
    amount: i64,
}

/// Automated tests only (ENGINE_SANDBOX=true): money minted from a system account. The app never
/// reaches this; real money arrives through Paga and Bitnob.
async fn sandbox_credit(
    State(state): State<AppState>,
    Json(req): Json<SandboxMove>,
) -> Result<(StatusCode, Json<ledger::Entry>), LedgerError> {
    if !state.sandbox {
        return Err(LedgerError::Forbidden);
    }
    let entry = ledger::transfer(
        &state.pool,
        &TransferRequest {
            idempotency_key: req.idempotency_key,
            kind: "sandbox_credit".into(),
            from: Owner::system(SANDBOX_MINT),
            to: Owner::user(req.owner_id),
            asset: req.asset,
            amount: req.amount,
            reference: None,
            metadata: None,
        },
    )
    .await?;
    let status = if entry.replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(entry)))
}

/// Automated tests only (ENGINE_SANDBOX=true): money taken back out to the mint.
async fn sandbox_debit(
    State(state): State<AppState>,
    Json(req): Json<SandboxMove>,
) -> Result<(StatusCode, Json<ledger::Entry>), LedgerError> {
    if !state.sandbox {
        return Err(LedgerError::Forbidden);
    }
    let entry = ledger::transfer(
        &state.pool,
        &TransferRequest {
            idempotency_key: req.idempotency_key,
            kind: "sandbox_debit".into(),
            from: Owner::user(req.owner_id),
            to: Owner::system(SANDBOX_MINT),
            asset: req.asset,
            amount: req.amount,
            reference: None,
            metadata: None,
        },
    )
    .await?;
    let status = if entry.replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(entry)))
}

// ---------------- Providers ----------------

impl axum::response::IntoResponse for PagaError {
    fn into_response(self) -> Response {
        // Paga refused the request and said why (e.g. "Account not sufficiently verified"): pass
        // the reason on, so the app can say what's wrong instead of a vague failure.
        if let PagaError::Http {
            status: 400..=499,
            body,
        } = &self
        {
            let reason = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|b| {
                    b.get("statusMessage")
                        .or_else(|| b.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "request refused".into());
            let reason = reason.trim_start_matches("Error processing request: ");
            tracing::error!(error = %self, "paga refused a request");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": { "code": "provider_refused", "message": reason.to_owned() } })),
            )
                .into_response();
        }
        let (status, code) = match self {
            PagaError::Ledger(error) => return error.into_response(),
            PagaError::NotConfigured => {
                (StatusCode::SERVICE_UNAVAILABLE, "provider_not_configured")
            }
            _ => (StatusCode::BAD_GATEWAY, "provider_error"),
        };
        tracing::error!(error = %self, "paga");
        (
            status,
            Json(json!({ "error": { "code": code, "message": self.to_string() } })),
        )
            .into_response()
    }
}

fn paga_config(state: &AppState) -> Result<Arc<PagaConfig>, PagaError> {
    state.paga.clone().ok_or(PagaError::NotConfigured)
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after: i64,
    #[serde(default = "default_limit")]
    limit: i64,
}

fn default_limit() -> i64 {
    100
}

/// What happened to users since `after`, oldest first: the API turns these into activity.
async fn events(
    State(state): State<AppState>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<Vec<providers::Event>>, LedgerError> {
    Ok(Json(
        providers::events_after(&state.pool, q.after, q.limit.clamp(1, 500)).await?,
    ))
}

async fn get_op(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Op>, LedgerError> {
    Ok(Json(providers::get_op(&state.pool, id).await?))
}

async fn provider_accounts(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<Vec<providers::ProviderAccount>>, LedgerError> {
    Ok(Json(providers::accounts_of(&state.pool, &owner_id).await?))
}

#[derive(Deserialize)]
struct PagaAccountRequest {
    owner_id: String,
    name: String,
    email: Option<String>,
    phone: Option<String>,
}

/// The user's own NGN account number (created at Paga the first time).
async fn paga_account(
    State(state): State<AppState>,
    Json(req): Json<PagaAccountRequest>,
) -> Result<Json<providers::ProviderAccount>, PagaError> {
    let cfg = paga_config(&state)?;
    let holder = paga::AccountHolder {
        owner_id: &req.owner_id,
        name: &req.name,
        email: req.email.as_deref(),
        phone: req.phone.as_deref(),
    };
    Ok(Json(paga::ensure_account(&state.pool, &cfg, holder).await?))
}

async fn paga_banks(State(state): State<AppState>) -> Result<Json<Value>, PagaError> {
    let cfg = paga_config(&state)?;
    Ok(Json(paga::banks(&cfg).await?))
}

#[derive(Deserialize)]
struct ResolveRequest {
    bank_uuid: String,
    account_number: String,
    amount: i64,
}

/// Name check: who owns the account and what Paga charges. 404 if it isn't a valid account.
async fn paga_resolve(
    State(state): State<AppState>,
    Json(req): Json<ResolveRequest>,
) -> Result<Json<Value>, PagaError> {
    let cfg = paga_config(&state)?;
    paga::resolve_account(
        &cfg,
        &req.bank_uuid,
        &req.account_number,
        req.amount.max(100),
    )
    .await?
    .map(Json)
    .ok_or(PagaError::Ledger(LedgerError::NotFound))
}

#[derive(Deserialize)]
struct PayoutRequest {
    idempotency_key: String,
    owner_id: String,
    amount: i64,
    bank_uuid: String,
    account_number: String,
    account_name: Option<String>,
    remarks: Option<String>,
}

/// Withdraw a user's naira to a bank account. The answer may be `pending`: poll /v1/ops/{id}.
async fn paga_payout(
    State(state): State<AppState>,
    Json(req): Json<PayoutRequest>,
) -> Result<Json<Op>, PagaError> {
    let cfg = paga_config(&state)?;
    let op = paga::payout(
        &state.pool,
        &cfg,
        paga::BankPayout {
            key: &format!("payout:{}:{}", req.owner_id, req.idempotency_key),
            owner_id: &req.owner_id,
            amount: req.amount,
            bank_uuid: &req.bank_uuid,
            account_number: &req.account_number,
            account_name: req.account_name.as_deref(),
            remarks: req.remarks.as_deref(),
        },
    )
    .await?;
    Ok(Json(op))
}

async fn paga_reconcile(State(state): State<AppState>) -> Result<Json<Value>, PagaError> {
    let cfg = paga_config(&state)?;
    Ok(Json(paga::reconcile(&state.pool, &cfg).await?))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

const PAGA_OK: &str = r#"{"status":"SUCCESS"}"#;

async fn paga_webhook(
    state: &AppState,
    headers: &HeaderMap,
    body: &str,
    signature_header: &str,
    fields: &[&str],
) -> Result<Value, (StatusCode, &'static str)> {
    let cfg = state
        .paga
        .clone()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "paga not configured"))?;
    let parsed: Value =
        serde_json::from_str(body).map_err(|_| (StatusCode::BAD_REQUEST, "not json"))?;
    let parameters = header(headers, &format!("{signature_header}-parameters"));
    if !paga::verify(
        &cfg,
        &parsed,
        header(headers, signature_header),
        parameters,
        fields,
    ) {
        return Err((StatusCode::UNAUTHORIZED, "bad signature"));
    }
    Ok(parsed)
}

async fn paga_funding_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = match paga_webhook(
        &state,
        &headers,
        &body,
        "x-paga-hash-v3",
        paga::FUNDING_FIELDS,
    )
    .await
    {
        Ok(parsed) => parsed,
        Err((status, why)) => return (status, why.into()),
    };
    match paga::handle_funding(&state.pool, &parsed).await {
        Ok(()) => (StatusCode::OK, PAGA_OK.into()),
        Err(error) => {
            // Not acknowledged: Paga will send it again.
            tracing::error!(%error, "paga funding webhook");
            (StatusCode::INTERNAL_SERVER_ERROR, "retry".into())
        }
    }
}

async fn paga_payout_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed =
        match paga_webhook(&state, &headers, &body, "x-paga-hash", paga::PAYOUT_FIELDS).await {
            Ok(parsed) => parsed,
            Err((status, why)) => return (status, why.into()),
        };
    match paga::handle_payout(&state.pool, &parsed).await {
        Ok(()) => (StatusCode::OK, PAGA_OK.into()),
        Err(error) => {
            tracing::error!(%error, "paga payout webhook");
            (StatusCode::INTERNAL_SERVER_ERROR, "retry".into())
        }
    }
}

// ---------------- Bitnob ----------------

impl axum::response::IntoResponse for BitnobError {
    fn into_response(self) -> Response {
        if let BitnobError::Ledger(error) = self {
            return error.into_response();
        }
        let (status, code) = match &self {
            BitnobError::NotConfigured => {
                (StatusCode::SERVICE_UNAVAILABLE, "provider_not_configured")
            }
            BitnobError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
            _ => (StatusCode::BAD_GATEWAY, "provider_error"),
        };
        if status != StatusCode::BAD_REQUEST {
            tracing::error!(error = %self, "bitnob");
        }
        (
            status,
            Json(json!({ "error": { "code": code, "message": self.to_string() } })),
        )
            .into_response()
    }
}

fn bitnob_config(state: &AppState) -> Result<Arc<BitnobConfig>, BitnobError> {
    state.bitnob.clone().ok_or(BitnobError::NotConfigured)
}

#[derive(Deserialize)]
struct AddressRequest {
    owner_id: String,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    asset: String,
    chain: String,
}

/// The user's deposit address for an asset on a chain (created at Bitnob the first time).
async fn bitnob_address(
    State(state): State<AppState>,
    Json(req): Json<AddressRequest>,
) -> Result<Json<providers::ProviderAccount>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    let holder = bitnob::Holder {
        owner_id: &req.owner_id,
        email: &req.email,
        first_name: req.first_name.as_deref(),
        last_name: req.last_name.as_deref(),
    };
    Ok(Json(
        bitnob::ensure_address(
            &state.pool,
            &cfg,
            holder,
            &req.asset,
            &req.chain.to_ascii_lowercase(),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct SendRequest {
    idempotency_key: String,
    owner_id: String,
    asset: String,
    chain: String,
    amount: i64,
    to_address: String,
}

/// Sends a user's crypto out. Usually `pending` until Bitnob's webhook: poll /v1/ops/{id}.
async fn bitnob_send(
    State(state): State<AppState>,
    Json(req): Json<SendRequest>,
) -> Result<Json<Op>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    let op = bitnob::send(
        &state.pool,
        &cfg,
        bitnob::CryptoSend {
            key: &format!("send:{}:{}", req.owner_id, req.idempotency_key),
            owner_id: &req.owner_id,
            asset: &req.asset,
            chain: &req.chain.to_ascii_lowercase(),
            amount: req.amount,
            to_address: req.to_address.trim(),
        },
    )
    .await?;
    Ok(Json(op))
}

async fn bitnob_reconcile(State(state): State<AppState>) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(bitnob::reconcile(&state.pool, &cfg).await?))
}

async fn bitnob_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> (StatusCode, String) {
    let Some(cfg) = state.bitnob.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "bitnob not configured".into(),
        );
    };
    // Checked against the raw bytes: Bitnob escapes some characters, so re-serialised JSON wouldn't match.
    if !bitnob::verify_webhook(&cfg, &body, header(&headers, "x-bitnob-signature")) {
        return (StatusCode::UNAUTHORIZED, "bad signature".into());
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "not json".into());
    };
    match bitnob::handle_webhook(&state.pool, &parsed).await {
        Ok(()) => (StatusCode::OK, r#"{"received":true}"#.into()),
        Err(error) => {
            tracing::error!(%error, "bitnob webhook");
            (StatusCode::INTERNAL_SERVER_ERROR, "retry".into())
        }
    }
}

// ---------------- Swaps (Bitnob trading) ----------------

#[derive(Deserialize)]
struct SwapQuoteRequest {
    owner_id: String,
    from: String,
    to: String,
    /// Smallest units of `from`.
    amount: i64,
}

/// Prices a swap and keeps the quote; the app shows it, then executes it by id.
async fn swap_quote(
    State(state): State<AppState>,
    Json(req): Json<SwapQuoteRequest>,
) -> Result<Json<providers::trading::Quote>, BitnobError> {
    let balance = ledger::balances(&state.pool, &Owner::user(&req.owner_id)).await?;
    let available = balance
        .iter()
        .find(|b| b.asset == req.from)
        .map(|b| b.available)
        .unwrap_or(0);
    if req.amount > available {
        return Err(BitnobError::Ledger(LedgerError::InsufficientFunds));
    }
    // Test money (ENGINE_SANDBOX): filled in the ledger at test rates, never sent to Bitnob.
    if state.sandbox {
        return Ok(Json(
            providers::testswap::quote(&state.pool, &req.owner_id, &req.from, &req.to, req.amount)
                .await?,
        ));
    }
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        providers::trading::quote(
            &state.pool,
            &cfg,
            &req.owner_id,
            &req.from,
            &req.to,
            req.amount,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct SwapRequest {
    owner_id: String,
    quote_id: String,
}

/// Executes a stored quote. `succeeded` = done; `pending` = settling (poll /v1/ops/{id}).
async fn swap_execute(
    State(state): State<AppState>,
    Json(req): Json<SwapRequest>,
) -> Result<Json<Op>, BitnobError> {
    let quote = providers::trading::get_quote(&state.pool, &req.quote_id).await?;
    if providers::testswap::is_test(&quote) {
        // A test quote only ever fills while test money is on.
        if !state.sandbox {
            return Err(BitnobError::Invalid(
                "That rate expired. Get a new one.".into(),
            ));
        }
        return Ok(Json(
            providers::testswap::execute(&state.pool, &req.owner_id, &req.quote_id).await?,
        ));
    }
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        providers::trading::execute(&state.pool, &cfg, &req.owner_id, &req.quote_id).await?,
    ))
}

// ---------------- USD cards (Bitnob) ----------------

use crate::providers::usdcard;

/// What the card costs, so the app shows the same numbers the engine charges.
async fn card_fees(State(state): State<AppState>) -> Result<Json<usdcard::CardFees>, BitnobError> {
    Ok(Json(bitnob_config(&state)?.card_fees.clone()))
}

async fn card_occupations(State(state): State<AppState>) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(usdcard::occupations(&cfg).await?))
}

async fn card_kyc(
    State(state): State<AppState>,
    Json(req): Json<usdcard::KycInput>,
) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(usdcard::submit_kyc(&state.pool, &cfg, &req).await?))
}

async fn card_kyc_status(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        usdcard::kyc_status(&state.pool, &cfg, &owner_id).await?,
    ))
}

async fn card_summary(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(usdcard::summary(&state.pool, &cfg, &owner_id).await?))
}

#[derive(Deserialize)]
struct CardMoney {
    idempotency_key: String,
    /// Micro-dollars (= USDT/USDC smallest units).
    amount: i64,
    #[serde(default)]
    asset: Option<String>,
}

async fn card_create(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(req): Json<CardMoney>,
) -> Result<Json<usdcard::Card>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    let asset = req.asset.unwrap_or_else(|| "USDC".into());
    Ok(Json(
        usdcard::create(
            &state.pool,
            &cfg,
            &owner_id,
            req.amount,
            &asset,
            &req.idempotency_key,
        )
        .await?,
    ))
}

async fn card_fund(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(req): Json<CardMoney>,
) -> Result<Json<Op>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    let asset = req.asset.unwrap_or_else(|| "USDC".into());
    Ok(Json(
        usdcard::fund(
            &state.pool,
            &cfg,
            &owner_id,
            req.amount,
            &asset,
            &req.idempotency_key,
        )
        .await?,
    ))
}

async fn card_withdraw(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(req): Json<CardMoney>,
) -> Result<Json<Op>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        usdcard::withdraw(
            &state.pool,
            &cfg,
            &owner_id,
            req.amount,
            &req.idempotency_key,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct Frozen {
    frozen: bool,
}

async fn card_frozen(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(req): Json<Frozen>,
) -> Result<Json<usdcard::Card>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        usdcard::set_frozen(&state.pool, &cfg, &owner_id, req.frozen).await?,
    ))
}

async fn card_terminate(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<usdcard::Card>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        usdcard::terminate(&state.pool, &cfg, &owner_id).await?,
    ))
}

async fn card_secrets(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(usdcard::secrets(&state.pool, &cfg, &owner_id).await?))
}

async fn card_transactions(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> Result<Json<Value>, BitnobError> {
    let cfg = bitnob_config(&state)?;
    Ok(Json(
        usdcard::transactions(&state.pool, &cfg, &owner_id).await?,
    ))
}
