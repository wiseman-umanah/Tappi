//! Swaps through Bitnob's trading API, against a fake Bitnob that answers like its documented
//! examples and checks our request signatures.

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::PgPool;
use tappi_engine::ledger::{self, Owner};
use tappi_engine::providers::bitnob::{BitnobConfig, BitnobError};
use tappi_engine::providers::trading::{self, orient, scaled};
use tappi_engine::providers::{self, Provider};

const CLIENT_ID: &str = "client-123";
const CLIENT_SECRET: &str = "client-secret";
const ADA: &str = "6f1c2a4e-0000-4000-8000-000000000001";

#[derive(Clone, Copy, PartialEq)]
enum OrderAnswer {
    Filled,
    Pending,
    Refused,
    Broken,
}

#[derive(Clone)]
struct Fake {
    order: Arc<Mutex<OrderAnswer>>,
    lookup: Arc<Mutex<OrderAnswer>>,
    expires_in: Arc<Mutex<i64>>,
    orders_placed: Arc<Mutex<Vec<Value>>>,
}

fn check_signature(headers: &HeaderMap, body: &[u8]) {
    let get = |h: &str| {
        headers
            .get(h)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(CLIENT_SECRET.as_bytes()).unwrap();
    mac.update(
        format!(
            "{CLIENT_ID}:{}:{}:{}",
            get("x-auth-timestamp"),
            get("x-auth-nonce"),
            String::from_utf8_lossy(body)
        )
        .as_bytes(),
    );
    assert_eq!(
        get("x-auth-signature"),
        hex::encode(mac.finalize().into_bytes())
    );
}

fn ok(data: Value) -> (StatusCode, Json<Value>) {
    (
        StatusCode::OK,
        Json(json!({ "success": true, "data": data })),
    )
}

async fn quotes(
    State(fake): State<Fake>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    check_signature(&headers, &body);
    let r: Value = serde_json::from_slice(&body).unwrap();
    let (base, quote, side, qty) = (
        r["base_currency"].as_str().unwrap(),
        r["quote_currency"].as_str().unwrap(),
        r["side"].as_str().unwrap(),
        r["quantity"].as_str().unwrap(),
    );
    // Prices: 1 USDT = ₦1,560.25; 1 BTC = 68,000 USDT.
    let (send_c, send_q, recv_c, recv_q) = match (base, quote, side) {
        // Spending naira: ₦5,000 → 3.2046146… USDT (Bitnob writes more places than we keep).
        ("NGN", "USDT", "SELL") => ("NGN", qty.to_owned(), "USDT", "3.20461464156".to_owned()),
        ("USDT", "NGN", "SELL") => ("USDT", qty.to_owned(), "NGN", "15602.501".to_owned()),
        // Buying BTC with USDT, sized in BTC.
        ("BTC", "USDT", "BUY") => ("USDT", "68.0000001".to_owned(), "BTC", qty.to_owned()),
        other => panic!("unexpected quote {other:?}"),
    };
    let expires = chrono::Utc::now() + chrono::Duration::seconds(*fake.expires_in.lock().unwrap());
    ok(json!({ "quote": {
        "id": format!("q-{}", uuid::Uuid::new_v4().simple()), "base_currency": base, "quote_currency": quote, "side": side,
        "quantity": qty, "price": "1560.25",
        "exchange": { "send_currency": send_c, "send_quantity": send_q, "receive_currency": recv_c, "receive_quantity": recv_q },
        "expires_at": expires.to_rfc3339(),
    }}))
}

fn order_reply(answer: OrderAnswer, request: &Value) -> (StatusCode, Json<Value>) {
    match answer {
        OrderAnswer::Filled => ok(
            json!({ "order": { "id": "ord-1", "status": "filled", "reference": request["reference"] } }),
        ),
        OrderAnswer::Pending => ok(
            json!({ "order": { "id": "ord-1", "status": "pending", "reference": request["reference"] } }),
        ),
        OrderAnswer::Refused => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(
                json!({ "success": false, "error": { "code": "PRECONDITION_FAILED", "detail": "quote expired" } }),
            ),
        ),
        OrderAnswer::Broken => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))),
    }
}

async fn orders(
    State(fake): State<Fake>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    check_signature(&headers, &body);
    let request: Value = serde_json::from_slice(&body).unwrap();
    fake.orders_placed.lock().unwrap().push(request.clone());
    let answer = *fake.order.lock().unwrap();
    order_reply(answer, &request)
}

async fn order_lookup(
    State(fake): State<Fake>,
    Path(reference): Path<String>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    check_signature(&headers, b"");
    let answer = *fake.lookup.lock().unwrap();
    order_reply(answer, &json!({ "reference": reference }))
}

async fn prices(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    check_signature(&headers, b"");
    ok(json!({ "price": { "base_currency": "BTC", "quote_currency": "USDT", "price": "68000" } }))
}

async fn start_fake() -> (Fake, BitnobConfig) {
    let fake = Fake {
        order: Arc::new(Mutex::new(OrderAnswer::Filled)),
        lookup: Arc::new(Mutex::new(OrderAnswer::Filled)),
        expires_in: Arc::new(Mutex::new(30)),
        orders_placed: Arc::default(),
    };
    let app = Router::new()
        .route("/api/trading/quotes", post(quotes))
        .route("/api/trading/orders", post(orders))
        .route("/api/trading/orders/{reference}", get(order_lookup))
        .route("/api/trading/prices", get(prices))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        fake,
        BitnobConfig {
            client_id: CLIENT_ID.into(),
            client_secret: CLIENT_SECRET.into(),
            webhook_secret: "w".into(),
            base_url,
            card_fees: Default::default(),
        },
    )
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

async fn fund(pool: &PgPool, asset: &str, amount: i64) {
    providers::credit_deposit(
        pool,
        Provider::Paga,
        &format!("seed-{asset}"),
        ADA,
        asset,
        amount,
        json!({}),
    )
    .await
    .unwrap();
}

#[test]
fn pairs_are_oriented_the_way_bitnob_documents() {
    assert_eq!(
        orient("NGN", "USDT"),
        Some(("NGN", "USDT", "SELL")),
        "spend naira: naira is the base, SELL"
    );
    assert_eq!(orient("USDC", "NGN"), Some(("USDC", "NGN", "SELL")));
    assert_eq!(orient("BTC", "USDT"), Some(("BTC", "USDT", "SELL")));
    assert_eq!(orient("USDT", "BTC"), Some(("BTC", "USDT", "BUY")));
    assert_eq!(orient("USDT", "USDC"), Some(("USDC", "USDT", "BUY")));
    assert_eq!(orient("USDT", "USDT"), None);
    assert_eq!(orient("ETH", "USDT"), None);
}

#[test]
fn amounts_round_in_tappis_favour() {
    assert_eq!(
        scaled("3.20461464156", 6, false),
        Some(3_204_614),
        "what the user gets rounds down"
    );
    assert_eq!(
        scaled("68.0000001", 6, true),
        Some(68_000_001),
        "what the user pays rounds up"
    );
    assert_eq!(scaled("5000", 2, false), Some(500_000));
    assert_eq!(scaled("-1", 2, false), None);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn naira_to_usdt(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "NGN", 1_000_000).await;
    let q = trading::quote(&pool, &cfg, ADA, "NGN", "USDT", 500_000)
        .await
        .unwrap();
    assert_eq!((q.send_amount, q.receive_amount), (500_000, 3_204_614));
    assert_eq!(q.order_request["quantity"], "5000");

    let op = trading::execute(&pool, &cfg, ADA, &q.id).await.unwrap();
    assert_eq!(op.status, "succeeded");
    assert_eq!(available(&pool, "NGN").await, 500_000);
    assert_eq!(available(&pool, "USDT").await, 3_204_614);
    // Tappi's books: Bitnob now holds ₦5,000 less of our naira float and 3.204614 USDT more.
    let books = providers::expected_provider_balances(&pool, Provider::Bitnob)
        .await
        .unwrap();
    assert!(
        books.contains(&("NGN".to_string(), -500_000))
            && books.contains(&("USDT".to_string(), 3_204_614))
    );
    let placed = fake.orders_placed.lock().unwrap().clone();
    assert_eq!(placed[0]["quote_id"], q.id.as_str());
    assert!(placed[0].get("price").is_none(), "no price on naira orders");
    let events = providers::events_after(&pool, 0, 10).await.unwrap();
    assert_eq!(events.last().unwrap().kind, "swap");

    // Executing the same quote again: the same swap, nothing traded twice.
    assert_eq!(
        trading::execute(&pool, &cfg, ADA, &q.id).await.unwrap().id,
        op.id
    );
    assert_eq!(fake.orders_placed.lock().unwrap().len(), 1);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn buying_bitcoin_with_usdt_is_sized_from_the_price(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "USDT", 100_000_000).await;
    // 68 USDT at 68,000 USDT/BTC → 0.001 BTC.
    let q = trading::quote(&pool, &cfg, ADA, "USDT", "BTC", 68_000_000)
        .await
        .unwrap();
    assert_eq!(q.order_request["side"], "BUY");
    assert_eq!(q.order_request["quantity"], "0.001");
    assert_eq!(
        (q.send_amount, q.receive_amount),
        (68_000_001, 100_000),
        "pays rounded up, gets exactly 0.001 BTC"
    );
    trading::execute(&pool, &cfg, ADA, &q.id).await.unwrap();
    assert_eq!(available(&pool, "BTC").await, 100_000);
    assert_eq!(available(&pool, "USDT").await, 100_000_000 - 68_000_001);
    assert_eq!(
        fake.orders_placed.lock().unwrap()[0]["price"],
        "1560.25",
        "crypto orders carry the quoted price"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn an_expired_quote_holds_nothing(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "NGN", 1_000_000).await;
    *fake.expires_in.lock().unwrap() = 0;
    let q = trading::quote(&pool, &cfg, ADA, "NGN", "USDT", 500_000)
        .await
        .unwrap();
    assert!(matches!(
        trading::execute(&pool, &cfg, ADA, &q.id).await,
        Err(BitnobError::Invalid(_))
    ));
    assert_eq!(available(&pool, "NGN").await, 1_000_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn only_the_owner_can_use_a_quote(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    fund(&pool, "NGN", 1_000_000).await;
    let q = trading::quote(&pool, &cfg, ADA, "NGN", "USDT", 500_000)
        .await
        .unwrap();
    assert!(
        trading::execute(&pool, &cfg, "someone-else", &q.id)
            .await
            .is_err()
    );
    assert_eq!(available(&pool, "NGN").await, 1_000_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_refused_order_gives_the_money_back(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "NGN", 1_000_000).await;
    *fake.order.lock().unwrap() = OrderAnswer::Refused;
    let q = trading::quote(&pool, &cfg, ADA, "NGN", "USDT", 500_000)
        .await
        .unwrap();
    assert_eq!(
        trading::execute(&pool, &cfg, ADA, &q.id)
            .await
            .unwrap()
            .status,
        "failed"
    );
    assert_eq!(available(&pool, "NGN").await, 1_000_000);
    assert_eq!(available(&pool, "USDT").await, 0);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn an_unclear_crypto_order_is_looked_up_never_resent(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "USDT", 100_000_000).await;
    *fake.order.lock().unwrap() = OrderAnswer::Broken;
    let q = trading::quote(&pool, &cfg, ADA, "USDT", "BTC", 68_000_000)
        .await
        .unwrap();
    let op = trading::execute(&pool, &cfg, ADA, &q.id).await.unwrap();
    assert_eq!(op.status, "pending");
    assert_eq!(
        available(&pool, "USDT").await,
        100_000_000 - 68_000_001,
        "held"
    );

    let op = trading::check(&pool, &cfg, &op).await.unwrap();
    assert_eq!(op.status, "succeeded");
    assert_eq!(available(&pool, "BTC").await, 100_000);
    assert_eq!(
        fake.orders_placed.lock().unwrap().len(),
        1,
        "the crypto order was never resent"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn an_unclear_naira_order_is_resent_with_the_same_reference(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "NGN", 1_000_000).await;
    *fake.order.lock().unwrap() = OrderAnswer::Broken;
    let q = trading::quote(&pool, &cfg, ADA, "NGN", "USDT", 500_000)
        .await
        .unwrap();
    let op = trading::execute(&pool, &cfg, ADA, &q.id).await.unwrap();
    assert_eq!(op.status, "pending");
    *fake.order.lock().unwrap() = OrderAnswer::Filled;
    let op = trading::check(&pool, &cfg, &op).await.unwrap();
    assert_eq!(op.status, "succeeded");
    let placed = fake.orders_placed.lock().unwrap().clone();
    assert_eq!(placed.len(), 2);
    assert_eq!(
        placed[0]["reference"], placed[1]["reference"],
        "same reference: Bitnob returns the original naira order"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn the_trade_webhook_settles_a_pending_swap(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    fund(&pool, "NGN", 1_000_000).await;
    *fake.order.lock().unwrap() = OrderAnswer::Pending;
    let q = trading::quote(&pool, &cfg, ADA, "NGN", "USDT", 500_000)
        .await
        .unwrap();
    let op = trading::execute(&pool, &cfg, ADA, &q.id).await.unwrap();
    assert_eq!(op.status, "pending");
    trading::handle_webhook(
        &pool,
        "trade.completed",
        &json!({ "reference": op.id.simple().to_string(), "status": "completed" }),
    )
    .await
    .unwrap();
    assert_eq!(available(&pool, "USDT").await, 3_204_614);
}
