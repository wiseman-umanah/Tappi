//! Paga adapter against a fake Paga that checks our signatures the way the docs describe.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use sqlx::PgPool;
use tappi_engine::http::{AppState, router};
use tappi_engine::ledger::{self, Owner};
use tappi_engine::providers::paga::{self, AccountHolder, BankPayout, PagaConfig};
use tappi_engine::providers::{self, Provider, major_to_minor, minor_to_major};
use tower::ServiceExt;

const PUBLIC: &str = "pub-key";
const SECRET: &str = "secret-key";
const HASH_KEY: &str = "hash-key-123";

fn sha512(parts: &[&str]) -> String {
    let mut h = Sha512::new();
    for p in parts {
        h.update(p.as_bytes());
    }
    h.update(HASH_KEY.as_bytes());
    hex::encode(h.finalize())
}

fn text(v: &Value, field: &str) -> String {
    match v.get(field) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// What the fake Paga answers to depositToBank / transactionStatus.
#[derive(Clone)]
enum Outcome {
    Ok,
    Pending,
    Fail(i64),
    Http500,
}

#[derive(Clone)]
struct Fake {
    payout: Arc<Mutex<Outcome>>,
    status: Arc<Mutex<Outcome>>,
    references: Arc<Mutex<HashSet<String>>>,
    calls: Arc<Mutex<Vec<String>>>,
}

async fn fake_create(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    fake.calls.lock().unwrap().push("create".into());
    let basic = format!(
        "Basic {}",
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("{PUBLIC}:{SECRET}")
        )
    );
    assert_eq!(headers["authorization"], basic.as_str());
    let sweep = &body["autoSweep"];
    let expected = sha512(&[
        &text(&body, "referenceNumber"),
        &text(&body, "accountReference"),
        &text(&body, "iifiNumber"),
        &text(sweep, "bankPublicId"),
        &text(sweep, "destination"),
        &text(sweep, "accountNumber"),
        &text(&body, "callbackUrl"),
    ]);
    assert_eq!(headers["hash"], expected.as_str(), "create hash");
    assert_eq!(sweep["destination"], "VIRTUAL_ACCOUNT");
    assert!(text(&body, "callbackUrl").ends_with("/api/webhooks/paga/funding"));
    let reference = text(&body, "accountReference");
    if !fake.references.lock().unwrap().insert(reference.clone()) {
        return Json(json!({ "statusCode": "102", "statusMessage": "duplicate" }));
    }
    Json(json!({ "statusCode": "0", "accountNumber": "0750529406", "accountReference": reference }))
}

async fn fake_retrieve(
    Path(reference): Path<String>,
    headers: HeaderMap,
    req: Request<Body>,
) -> Json<Value> {
    let query = req.uri().query().unwrap_or_default().to_owned();
    let number = query.trim_start_matches("referenceNumber=");
    assert_eq!(headers["hash"], sha512(&[number, &reference]).as_str());
    Json(json!({ "statusCode": "0", "accountNumber": "0750529406", "accountReference": reference }))
}

async fn fake_business(
    State(fake): State<Fake>,
    Path(op): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    fake.calls.lock().unwrap().push(op.clone());
    assert_eq!(headers["principal"], PUBLIC);
    assert_eq!(headers["credentials"], SECRET);
    let r = text(&body, "referenceNumber");
    let money = [
        r.clone(),
        text(&body, "amount"),
        text(&body, "destinationBankUUID"),
        text(&body, "destinationBankAccountNumber"),
    ];
    let expected = match op.as_str() {
        "validateDepositToBank" | "depositToBank" => {
            sha512(&money.iter().map(String::as_str).collect::<Vec<_>>())
        }
        _ => sha512(&[&r]),
    };
    assert_eq!(headers["hash"], expected.as_str(), "{op} hash");
    let reply = |outcome: Outcome| match outcome {
        Outcome::Ok => (
            StatusCode::OK,
            Json(json!({ "responseCode": 0, "transactionId": "PG1", "fee": 50, "vat": 3.75 })),
        ),
        Outcome::Pending => (StatusCode::OK, Json(json!({ "responseCode": 3 }))),
        Outcome::Fail(code) => (
            StatusCode::OK,
            Json(json!({ "responseCode": code, "message": "Invalid bank account" })),
        ),
        Outcome::Http500 => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))),
    };
    match op.as_str() {
        "getBanks" => (
            StatusCode::OK,
            Json(
                json!({ "responseCode": 0, "banks": [{ "uuid": "B1", "name": "Access Bank", "sortCode": "044" }] }),
            ),
        ),
        "validateDepositToBank" => (
            StatusCode::OK,
            Json(
                json!({ "responseCode": 0, "destinationAccountHolderNameAtBank": "ADA OBI", "fee": 50, "vat": 3.75 }),
            ),
        ),
        "depositToBank" => {
            assert_eq!(text(&body, "amount"), "4000.00", "naira with kobo");
            reply(fake.payout.lock().unwrap().clone())
        }
        "transactionStatus" => reply(fake.status.lock().unwrap().clone()),
        "accountBalance" => (
            StatusCode::OK,
            Json(json!({ "responseCode": 0, "availableBalance": 5946.25 })),
        ),
        _ => (StatusCode::NOT_FOUND, Json(json!({}))),
    }
}

async fn start_fake() -> (Fake, PagaConfig) {
    let fake = Fake {
        payout: Arc::new(Mutex::new(Outcome::Ok)),
        status: Arc::new(Mutex::new(Outcome::Pending)),
        references: Arc::default(),
        calls: Arc::default(),
    };
    let app = Router::new()
        .route("/subsidiary-accounts", post(fake_create))
        .route("/subsidiary-accounts/{reference}", get(fake_retrieve))
        .route(
            "/paga-webservices/business-rest/secured/{op}",
            post(fake_business),
        )
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let cfg = PagaConfig {
        public_key: PUBLIC.into(),
        secret_key: SECRET.into(),
        hash_key: HASH_KEY.into(),
        live: false,
        public_url: "https://tappi.example".into(),
        base_override: Some(base),
    };
    (fake, cfg)
}

async fn available(pool: &PgPool, user: &str) -> i64 {
    ledger::balances(pool, &Owner::user(user))
        .await
        .unwrap()
        .into_iter()
        .find(|b| b.asset == "NGN")
        .unwrap()
        .available
}

async fn ada_account(pool: &PgPool, cfg: &PagaConfig) -> String {
    let holder = AccountHolder {
        owner_id: "6f1c2a4e-0000-4000-8000-000000000001",
        name: "Ada Obi",
        email: Some("ada@example.com"),
        phone: None,
    };
    paga::ensure_account(pool, cfg, holder)
        .await
        .unwrap()
        .owner_id
}

fn funding_body(txn: &str) -> Value {
    serde_json::from_str(&format!(
        r#"{{"statusCode":"0","transactionReference":"{txn}","transactionDate":"2026-11-18T10:00:00.123","amount":5000.0,
            "clearingFeeAmount":37.5,"accountNumber":"0750529406","timestamp":"1763460000",
            "payerDetails":{{"paymentMethod":"BANK_TRANSFER","payerName":"Chidi Okafor"}}}}"#
    ))
    .unwrap()
}

/// Posts a webhook to the engine signed the way Paga signs it.
async fn send_webhook(
    pool: &PgPool,
    cfg: &PagaConfig,
    path: &str,
    header: &str,
    body: &Value,
    fields: &[&str],
    tamper: bool,
) -> StatusCode {
    let values: Vec<String> = fields.iter().map(|f| text(body, f)).collect();
    let mut signature = sha512(&values.iter().map(String::as_str).collect::<Vec<_>>());
    if tamper {
        signature.replace_range(0..1, if signature.starts_with('a') { "b" } else { "a" });
    }
    let app = router(AppState {
        pool: pool.clone(),
        token: "t".repeat(32).into(),
        sandbox: false,
        paga: Some(Arc::new(cfg.clone())),
        bitnob: None,
    });
    let request = Request::post(path)
        .header(header, signature)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let _ = response.into_body().collect().await;
    status
}

#[test]
fn amounts_convert_exactly() {
    assert_eq!(major_to_minor("5000", 2), Some(500_000));
    assert_eq!(major_to_minor("5000.0", 2), Some(500_000));
    assert_eq!(major_to_minor("37.5", 2), Some(3_750));
    assert_eq!(major_to_minor("0.10", 2), Some(10));
    assert_eq!(major_to_minor("1.005", 2), None, "never rounds");
    assert_eq!(major_to_minor("-5", 2), None);
    assert_eq!(major_to_minor("abc", 2), None);
    assert_eq!(minor_to_major(400_000, 2), "4000.00");
    assert_eq!(minor_to_major(5, 2), "0.05");
    assert_eq!(
        paga::account_reference("6f1c2a4e-0000-4000-8000-000000000001").len(),
        30
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn account_numbers_are_created_once(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    ada_account(&pool, &cfg).await;
    ada_account(&pool, &cfg).await;
    assert_eq!(
        fake.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| *c == "create")
            .count(),
        1,
        "second ask is served from our records"
    );
    let accounts = providers::accounts_of(&pool, "6f1c2a4e-0000-4000-8000-000000000001")
        .await
        .unwrap();
    assert_eq!(accounts[0].details["accountNumber"], "0750529406");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_lost_create_answer_recovers_the_existing_account(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    // Paga already has it (an earlier attempt whose answer we never got): 102, then retrieve.
    fake.references
        .lock()
        .unwrap()
        .insert(paga::account_reference(
            "6f1c2a4e-0000-4000-8000-000000000001",
        ));
    ada_account(&pool, &cfg).await;
    assert!(
        providers::find_account(&pool, Provider::Paga, "0750529406")
            .await
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_deposit_webhook_credits_the_user_once(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    let owner = ada_account(&pool, &cfg).await;
    let body = funding_body("TX-100");
    let path = "/webhooks/paga/funding";

    assert_eq!(
        send_webhook(
            &pool,
            &cfg,
            path,
            "x-paga-hash-v3",
            &body,
            paga::FUNDING_FIELDS,
            true
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        available(&pool, &owner).await,
        0,
        "forged webhook credits nothing"
    );

    assert_eq!(
        send_webhook(
            &pool,
            &cfg,
            path,
            "x-paga-hash-v3",
            &body,
            paga::FUNDING_FIELDS,
            false
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        send_webhook(
            &pool,
            &cfg,
            path,
            "x-paga-hash-v3",
            &body,
            paga::FUNDING_FIELDS,
            false
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(available(&pool, &owner).await, 500_000, "₦5,000 once");
    // Paga keeps its ₦37.50 clearing fee: Tappi pays it, the user doesn't.
    let expected = providers::expected_provider_balances(&pool, Provider::Paga)
        .await
        .unwrap();
    assert_eq!(expected, [("NGN".to_string(), 500_000 - 3_750)]);
    let events = providers::events_after(&pool, 0, 10).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        (
            events[0].kind.as_str(),
            events[0].payload["amount"].as_i64()
        ),
        ("deposit", Some(500_000))
    );
    assert_eq!(events[0].payload["from"], "Chidi Okafor");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_deposit_to_an_unknown_account_is_kept_for_review(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    let mut body = funding_body("TX-200");
    body["accountNumber"] = json!("0999999999");
    let status = send_webhook(
        &pool,
        &cfg,
        "/webhooks/paga/funding",
        "x-paga-hash-v3",
        &body,
        paga::FUNDING_FIELDS,
        false,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "acknowledged so Paga stops resending"
    );
    let error: Option<String> = sqlx::query_scalar("SELECT error FROM engine.webhook_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(error.unwrap().contains("0999999999"));
}

async fn funded(pool: &PgPool, cfg: &PagaConfig) -> String {
    let owner = ada_account(pool, cfg).await;
    providers::credit_deposit(
        pool,
        Provider::Paga,
        "SEED",
        &owner,
        "NGN",
        1_000_000,
        json!({}),
    )
    .await
    .unwrap();
    owner
}

fn withdrawal<'a>(owner: &'a str, key: &'a str) -> BankPayout<'a> {
    BankPayout {
        key,
        owner_id: owner,
        amount: 400_000,
        bank_uuid: "B1",
        account_number: "0123456789",
        account_name: Some("ADA OBI"),
        remarks: None,
    }
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_payout_that_succeeds(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    let owner = funded(&pool, &cfg).await;
    let op = paga::payout(&pool, &cfg, withdrawal(&owner, "w1"))
        .await
        .unwrap();
    assert_eq!(op.status, "succeeded");
    assert_eq!(available(&pool, &owner).await, 600_000);
    // ₦50 fee + ₦3.75 VAT is Tappi's cost and leaves Paga's balance too.
    let expected = providers::expected_provider_balances(&pool, Provider::Paga)
        .await
        .unwrap();
    assert_eq!(expected, [("NGN".to_string(), 600_000 - 5_375)]);
    // Same key again: same payout, nothing sent twice.
    assert_eq!(
        paga::payout(&pool, &cfg, withdrawal(&owner, "w1"))
            .await
            .unwrap()
            .id,
        op.id
    );
    assert_eq!(available(&pool, &owner).await, 600_000);
    let report = paga::reconcile(&pool, &cfg).await.unwrap();
    assert_eq!(report["difference"], 0, "books match Paga's balance");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_refused_payout_gives_the_money_back(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    let owner = funded(&pool, &cfg).await;
    *fake.payout.lock().unwrap() = Outcome::Fail(115);
    let op = paga::payout(&pool, &cfg, withdrawal(&owner, "w1"))
        .await
        .unwrap();
    assert_eq!(op.status, "failed");
    assert_eq!(available(&pool, &owner).await, 1_000_000);
    let events = providers::events_after(&pool, 0, 10).await.unwrap();
    assert_eq!(events.last().unwrap().kind, "payout_failed");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn an_unclear_answer_is_never_resent_only_checked(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    let owner = funded(&pool, &cfg).await;
    *fake.payout.lock().unwrap() = Outcome::Http500;
    let op = paga::payout(&pool, &cfg, withdrawal(&owner, "w1"))
        .await
        .unwrap();
    assert_eq!(op.status, "pending");
    assert_eq!(available(&pool, &owner).await, 600_000, "still held");

    // Still processing at Paga.
    let op = paga::check_payout(&pool, &cfg, &op).await.unwrap();
    assert_eq!(op.status, "pending");
    // Then it lands.
    *fake.status.lock().unwrap() = Outcome::Ok;
    let op = paga::check_payout(&pool, &cfg, &op).await.unwrap();
    assert_eq!(op.status, "succeeded");
    assert_eq!(available(&pool, &owner).await, 600_000);
    let sends = fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| *c == "depositToBank")
        .count();
    assert_eq!(sends, 1, "depositToBank was never sent twice");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn the_payout_webhook_settles_a_pending_payout(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    let owner = funded(&pool, &cfg).await;
    *fake.payout.lock().unwrap() = Outcome::Pending;
    let op = paga::payout(&pool, &cfg, withdrawal(&owner, "w1"))
        .await
        .unwrap();
    assert_eq!(op.status, "pending");
    let body: Value = serde_json::from_str(&format!(
        r#"{{"responseCode":0,"referenceNumber":"{}","transactionId":"PG9","transactionDate":"2026-11-18 11:02:25.56",
            "amount":"4000.0","sessionId":"100002261103","fee":50,"vat":3.75}}"#,
        op.id.simple()
    ))
    .unwrap();
    let status = send_webhook(
        &pool,
        &cfg,
        "/webhooks/paga/payout",
        "x-paga-hash",
        &body,
        paga::PAYOUT_FIELDS,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        providers::get_op(&pool, op.id).await.unwrap().status,
        "succeeded"
    );
    assert_eq!(available(&pool, &owner).await, 600_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn banks_and_name_check(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    let _ = pool;
    let banks = paga::banks(&cfg).await.unwrap();
    assert_eq!(banks[0]["name"], "Access Bank");
    let resolved = paga::resolve_account(&cfg, "B1", "0123456789", 400_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved["accountName"], "ADA OBI");
}

#[tokio::test]
async fn a_paga_refusal_says_why() {
    use axum::response::IntoResponse;
    let error = paga::PagaError::Http {
        status: 400,
        body: r#"{"referenceNumber":"x","statusCode":"100","statusMessage":"Error processing request: Account not sufficiently verified"}"#.into(),
    };
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["error"]["code"], "provider_refused");
    assert_eq!(
        body["error"]["message"],
        "Account not sufficiently verified"
    );
}
