//! Bitnob adapter: Bitnob's own published webhook test vector, and a fake Bitnob that checks our
//! request signatures the way the docs describe.

use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Sha256, Sha512};
use sqlx::PgPool;
use tappi_engine::http::{AppState, router};
use tappi_engine::ledger::{self, Owner};
use tappi_engine::providers::bitnob::{self, BitnobConfig, BitnobError, CryptoSend, Holder};
use tappi_engine::providers::{self, Provider};
use tower::ServiceExt;

const CLIENT_ID: &str = "client-123";
const CLIENT_SECRET: &str = "client-secret";
const WEBHOOK_SECRET: &str = "webhook-secret";
const ADA: &str = "6f1c2a4e-0000-4000-8000-000000000001";

#[test]
fn webhook_signature_matches_bitnobs_published_vector() {
    // From https://www.bitnob.dev/api-reference/webhooks.md: the body keeps Bitnob's < escapes.
    let cfg = BitnobConfig {
        client_id: "x".into(),
        client_secret: "x".into(),
        webhook_secret: "test_secret".into(),
        base_url: String::new(),
        card_fees: Default::default(),
    };
    // Built with an explicit backslash so editors can't turn the escapes into < > &.
    let bs = '\\';
    let body = format!(
        r#"{{"data":{{"amount":"9000000","chain":"tron","reference":"ref{bs}u003c1{bs}u003e{bs}u0026x"}},"event":"payouts.withdrawal.success","event_id":"evt_1"}}"#
    );
    let body = body.as_bytes();
    let signature = "2367e131d723576925cd841dd00490f5f0f6717f7caaa9130f28543dfb641f4e58b3e6c240dee32066f27b757ba767d97a39808c7b03669b500088c9c391a0aa";
    assert!(bitnob::verify_webhook(&cfg, body, Some(signature)));
    assert!(!bitnob::verify_webhook(
        &cfg,
        body,
        Some(&signature.replace('2', "3"))
    ));
    assert!(!bitnob::verify_webhook(&cfg, body, None));
}

#[derive(Clone, Copy)]
enum SendAnswer {
    Accepted,
    Refused,
}

#[derive(Clone)]
struct Fake {
    send: Arc<Mutex<SendAnswer>>,
    addresses_made: Arc<Mutex<u32>>,
    balances: Arc<Mutex<Value>>,
}

/// Checks the four X-Auth headers against the raw body, as Bitnob does.
fn check_signature(headers: &HeaderMap, body: &[u8]) {
    let get = |h: &str| {
        headers
            .get(h)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    assert_eq!(get("x-auth-client"), CLIENT_ID);
    let (timestamp, nonce) = (get("x-auth-timestamp"), get("x-auth-nonce"));
    assert!(timestamp.parse::<i64>().is_ok(), "timestamp in seconds");
    assert_eq!(nonce.len(), 32, "16 bytes, hex");
    let mut mac = Hmac::<Sha256>::new_from_slice(CLIENT_SECRET.as_bytes()).unwrap();
    mac.update(
        format!(
            "{CLIENT_ID}:{timestamp}:{nonce}:{}",
            String::from_utf8_lossy(body)
        )
        .as_bytes(),
    );
    assert_eq!(
        get("x-auth-signature"),
        hex::encode(mac.finalize().into_bytes()),
        "request signature"
    );
}

fn ok(data: Value) -> (StatusCode, Json<Value>) {
    (
        StatusCode::OK,
        Json(json!({ "success": true, "data": data })),
    )
}

async fn customers(headers: HeaderMap, body: Bytes) -> (StatusCode, Json<Value>) {
    check_signature(&headers, &body);
    ok(json!({ "id": "cus_1", "email": "ada@example.com" }))
}

async fn addresses(
    State(fake): State<Fake>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    check_signature(&headers, &body);
    let request: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(request["customer_id"], "cus_1");
    *fake.addresses_made.lock().unwrap() += 1;
    let chain = request["chain"].as_str().unwrap();
    ok(
        json!({ "id": "adr_1", "chain": chain, "address": format!("{chain}-address-for-ada"), "status": "active" }),
    )
}

async fn validate(headers: HeaderMap, body: Bytes) -> (StatusCode, Json<Value>) {
    check_signature(&headers, &body);
    let request: Value = serde_json::from_slice(&body).unwrap();
    ok(json!({ "valid": request["address"] != "not-an-address" }))
}

async fn withdrawals(
    State(fake): State<Fake>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    check_signature(&headers, &body);
    let request: Value = serde_json::from_slice(&body).unwrap();
    assert!(request["amount"].is_string(), "smallest units as a string");
    match *fake.send.lock().unwrap() {
        SendAnswer::Accepted => ok(
            json!({ "transaction_id": "tx_out_1", "status": "pending", "reference": request["reference"] }),
        ),
        SendAnswer::Refused => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(
                json!({ "success": false, "error": { "code": "PRECONDITION_FAILED", "detail": "destination blocked" } }),
            ),
        ),
    }
}

async fn balances(State(fake): State<Fake>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    check_signature(&headers, b"");
    ok(fake.balances.lock().unwrap().clone())
}

async fn start_fake() -> (Fake, BitnobConfig) {
    let fake = Fake {
        send: Arc::new(Mutex::new(SendAnswer::Accepted)),
        addresses_made: Arc::default(),
        balances: Arc::new(Mutex::new(json!({ "accounts": [] }))),
    };
    let app = Router::new()
        .route("/api/customers", post(customers))
        .route("/api/addresses", post(addresses))
        .route("/api/addresses/validate", post(validate))
        .route("/api/withdrawals", post(withdrawals))
        .route("/api/balances", get(balances))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        fake,
        BitnobConfig {
            client_id: CLIENT_ID.into(),
            client_secret: CLIENT_SECRET.into(),
            webhook_secret: WEBHOOK_SECRET.into(),
            base_url,
            card_fees: Default::default(),
        },
    )
}

fn ada() -> Holder<'static> {
    Holder {
        owner_id: ADA,
        email: "ada@example.com",
        first_name: Some("Ada"),
        last_name: Some("Obi"),
    }
}

async fn available(pool: &PgPool, asset: &str) -> i64 {
    ledger::balances(pool, &Owner::user(ADA))
        .await
        .unwrap()
        .into_iter()
        .find(|b| b.asset == asset)
        .unwrap()
        .available
}

/// Posts a webhook to the engine, signed with the webhook secret (or not).
async fn webhook(pool: &PgPool, cfg: &BitnobConfig, body: &Value, signed: bool) -> StatusCode {
    let raw = body.to_string();
    let mut mac =
        Hmac::<Sha512>::new_from_slice(if signed { WEBHOOK_SECRET } else { "wrong" }.as_bytes())
            .unwrap();
    mac.update(raw.as_bytes());
    let app = router(AppState {
        pool: pool.clone(),
        token: "t".repeat(32).into(),
        sandbox: false,
        paga: None,
        bitnob: Some(Arc::new(cfg.clone())),
    });
    let request = Request::post("/webhooks/bitnob/events")
        .header(
            "x-bitnob-signature",
            hex::encode(mac.finalize().into_bytes()),
        )
        .body(Body::from(raw))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let _ = response.into_body().collect().await;
    status
}

fn deposit(event_id: &str, address: &str, currency: &str, amount: &str) -> Value {
    json!({
        "event": "deposit.success",
        "event_id": event_id,
        "data": { "address": address, "amount": amount, "chain": "ethereum", "currency": currency, "fee": "0",
                  "hash": "0xabc", "reference": "RCV_1", "transaction_id": format!("tx-{event_id}") }
    })
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn addresses_are_made_once_per_chain(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    let usdt = bitnob::ensure_address(&pool, &cfg, ada(), "USDT", "ethereum")
        .await
        .unwrap();
    assert_eq!(usdt.details["address"], "ethereum-address-for-ada");
    bitnob::ensure_address(&pool, &cfg, ada(), "USDT", "ethereum")
        .await
        .unwrap();
    // USDC on the same chain shares the address.
    let usdc = bitnob::ensure_address(&pool, &cfg, ada(), "USDC", "ethereum")
        .await
        .unwrap();
    assert_eq!(usdc.details["address"], "ethereum-address-for-ada");
    assert_eq!(*fake.addresses_made.lock().unwrap(), 1);
    bitnob::ensure_address(&pool, &cfg, ada(), "BTC", "bitcoin")
        .await
        .unwrap();
    assert_eq!(*fake.addresses_made.lock().unwrap(), 2);
    assert!(matches!(
        bitnob::ensure_address(&pool, &cfg, ada(), "USDC", "tron").await,
        Err(BitnobError::Invalid(_))
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn crypto_deposits_are_credited_once(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    bitnob::ensure_address(&pool, &cfg, ada(), "USDT", "ethereum")
        .await
        .unwrap();
    let body = deposit("evt_1", "ethereum-address-for-ada", "USDT", "9000000");

    assert_eq!(
        webhook(&pool, &cfg, &body, false).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        available(&pool, "USDT").await,
        0,
        "forged webhook credits nothing"
    );
    assert_eq!(webhook(&pool, &cfg, &body, true).await, StatusCode::OK);
    assert_eq!(webhook(&pool, &cfg, &body, true).await, StatusCode::OK);
    assert_eq!(available(&pool, "USDT").await, 9_000_000, "9 USDT once");

    // USDC to the same address is USDC, not USDT.
    webhook(
        &pool,
        &cfg,
        &deposit("evt_2", "ethereum-address-for-ada", "USDC", "2500000"),
        true,
    )
    .await;
    assert_eq!(available(&pool, "USDC").await, 2_500_000);
    let events = providers::events_after(&pool, 0, 10).await.unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].payload["from"], "USDT on ethereum");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_deposit_to_an_unknown_address_is_kept_for_review(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    assert_eq!(
        webhook(
            &pool,
            &cfg,
            &deposit("evt_9", "stranger", "USDT", "100"),
            true
        )
        .await,
        StatusCode::OK
    );
    let error: Option<String> = sqlx::query_scalar("SELECT error FROM engine.webhook_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(error.unwrap().contains("stranger"));
}

async fn funded(pool: &PgPool) {
    providers::credit_deposit(
        pool,
        Provider::Bitnob,
        "seed",
        ADA,
        "USDT",
        20_000_000,
        json!({}),
    )
    .await
    .unwrap();
}

fn send_usdt(key: &str, to: &'static str) -> CryptoSend<'static> {
    let key: &'static str = Box::leak(key.to_owned().into_boxed_str());
    CryptoSend {
        key,
        owner_id: ADA,
        asset: "USDT",
        chain: "ethereum",
        amount: 5_000_000,
        to_address: to,
    }
}

fn transfer_event(kind: &str, op: &providers::Op, fee: &str) -> Value {
    json!({
        "event": kind,
        "event_id": format!("{kind}-{}", op.id),
        "data": { "reference": op.id.simple().to_string(), "amount": "5000000", "currency": "USDT", "chain": "ethereum",
                  "fee": fee, "hash": "0xdef", "transaction_id": "tx_out_1" }
    })
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_send_holds_until_bitnob_confirms(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    funded(&pool).await;
    let op = bitnob::send(&pool, &cfg, send_usdt("s1", "0xfriend"))
        .await
        .unwrap();
    assert_eq!(op.status, "pending");
    assert_eq!(available(&pool, "USDT").await, 15_000_000, "held");

    assert_eq!(
        webhook(
            &pool,
            &cfg,
            &transfer_event("transfer.success", &op, "1000000"),
            true
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        providers::get_op(&pool, op.id).await.unwrap().status,
        "succeeded"
    );
    assert_eq!(available(&pool, "USDT").await, 15_000_000);
    // Bitnob's $1 fee is Tappi's: it leaves Bitnob's balance, not the user's.
    let expected = providers::expected_provider_balances(&pool, Provider::Bitnob)
        .await
        .unwrap();
    assert_eq!(expected, [("USDT".to_string(), 15_000_000 - 1_000_000)]);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_failed_send_gives_the_money_back(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    funded(&pool).await;
    let op = bitnob::send(&pool, &cfg, send_usdt("s1", "0xfriend"))
        .await
        .unwrap();
    webhook(
        &pool,
        &cfg,
        &transfer_event("transfer.failed", &op, "0"),
        true,
    )
    .await;
    assert_eq!(
        providers::get_op(&pool, op.id).await.unwrap().status,
        "failed"
    );
    assert_eq!(available(&pool, "USDT").await, 20_000_000);

    // Refused outright by Bitnob: back at once.
    *fake.send.lock().unwrap() = SendAnswer::Refused;
    let refused = bitnob::send(&pool, &cfg, send_usdt("s2", "0xfriend"))
        .await
        .unwrap();
    assert_eq!(refused.status, "failed");
    assert_eq!(available(&pool, "USDT").await, 20_000_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn bad_sends_are_stopped_before_any_money_is_held(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    funded(&pool).await;
    assert!(matches!(
        bitnob::send(&pool, &cfg, send_usdt("s1", "not-an-address")).await,
        Err(BitnobError::Invalid(_))
    ));
    let wrong_chain = CryptoSend {
        chain: "bitcoin",
        ..send_usdt("s2", "0xfriend")
    };
    assert!(matches!(
        bitnob::send(&pool, &cfg, wrong_chain).await,
        Err(BitnobError::Invalid(_))
    ));
    assert_eq!(available(&pool, "USDT").await, 20_000_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn reconciliation_compares_bitnob_balances_with_our_books(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    funded(&pool).await;
    *fake.balances.lock().unwrap() = json!({ "accounts": [
        { "currency": "USDT", "available_balance": "20000000" },
        { "currency": "BTC", "available_balance": "500" },
    ] });
    let report = bitnob::reconcile(&pool, &cfg).await.unwrap();
    let usdt = report
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["asset"] == "USDT")
        .unwrap();
    assert_eq!(usdt["difference"], 0);
    let btc = report
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["asset"] == "BTC")
        .unwrap();
    assert_eq!(
        btc["difference"], 500,
        "Tappi's own sats, not owed to anyone"
    );
}
