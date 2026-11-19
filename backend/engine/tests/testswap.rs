//! Test swaps (ENGINE_SANDBOX only): filled in the ledger at test rates, through the real routes.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tappi_engine::http::{AppState, router};
use tappi_engine::ledger::{self, Owner, SANDBOX_MINT, TransferRequest};
use tappi_engine::providers::testswap::convert;
use tower::ServiceExt;

const TOKEN: &str = "test-token-test-token-test-token-0000";
const ADA: &str = "ada";

fn app(pool: PgPool, sandbox: bool) -> Router {
    router(AppState {
        pool,
        token: TOKEN.into(),
        sandbox,
        paga: None,
        bitnob: None,
    })
}

async fn post(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::post(uri)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
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

async fn give(pool: &PgPool, asset: &str, amount: i64) {
    ledger::transfer(
        pool,
        &TransferRequest {
            idempotency_key: format!("give-{asset}"),
            kind: "test".into(),
            from: Owner::system(SANDBOX_MINT),
            to: Owner::user(ADA),
            asset: asset.into(),
            amount,
            reference: None,
            metadata: None,
        },
    )
    .await
    .unwrap();
}

#[test]
fn test_rates() {
    // ₦1,569 = $1; $68,000 = 1 BTC; USDT = USDC = $1. Exact, no drift.
    assert_eq!(convert("USDT", "NGN", 1_000_000), 156_900);
    assert_eq!(convert("NGN", "USDT", 156_900), 1_000_000);
    assert_eq!(convert("USDT", "USDC", 5_000_000), 5_000_000);
    assert_eq!(convert("USDT", "BTC", 68_000_000), 100_000);
    assert_eq!(
        convert("NGN", "USDT", 156_899),
        999_993,
        "rounded down, never up"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn usdt_to_naira_with_test_money(pool: PgPool) {
    give(&pool, "USDT", 10_000_000).await;
    let app = app(pool.clone(), true);
    let (status, quote) = post(
        &app,
        "/v1/swaps/quote",
        json!({ "owner_id": ADA, "from": "USDT", "to": "NGN", "amount": 10_000_000 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{quote}");
    assert_eq!(quote["receive_amount"], 1_569_000);
    assert_eq!(quote["order_request"]["test"], true);

    let swap = json!({ "owner_id": ADA, "quote_id": quote["id"] });
    let (_, op) = post(&app, "/v1/swaps", swap.clone()).await;
    assert_eq!(op["status"], "succeeded");
    let (_, again) = post(&app, "/v1/swaps", swap).await;
    assert_eq!(op["id"], again["id"], "one quote, one swap");
    assert_eq!(available(&pool, "USDT").await, 0);
    assert_eq!(available(&pool, "NGN").await, 1_569_000, "₦15,690 once");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn test_quotes_never_fill_once_test_money_is_off(pool: PgPool) {
    give(&pool, "NGN", 1_000_000).await;
    let (_, quote) = post(
        &app(pool.clone(), true),
        "/v1/swaps/quote",
        json!({ "owner_id": ADA, "from": "NGN", "to": "USDC", "amount": 1_000_000 }),
    )
    .await;
    let (status, _) = post(
        &app(pool.clone(), false),
        "/v1/swaps",
        json!({ "owner_id": ADA, "quote_id": quote["id"] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(available(&pool, "NGN").await, 1_000_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_test_swap_still_needs_the_money(pool: PgPool) {
    let (status, _) = post(
        &app(pool, true),
        "/v1/swaps/quote",
        json!({ "owner_id": ADA, "from": "NGN", "to": "USDT", "amount": 500 }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
