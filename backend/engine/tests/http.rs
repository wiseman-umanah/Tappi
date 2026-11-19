use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tappi_engine::http::{AppState, router};
use tower::ServiceExt;

const TOKEN: &str = "test-token-test-token-test-token-0000";

fn app(pool: PgPool, sandbox: bool) -> Router {
    router(AppState {
        pool,
        token: TOKEN.into(),
        sandbox,
        paga: None,
        bitnob: None,
    })
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = body
        .map(|b| Body::from(b.to_string()))
        .unwrap_or_else(Body::empty);
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn health_is_open_everything_else_needs_the_token(pool: PgPool) {
    let app = app(pool, false);
    assert_eq!(
        call(&app, "GET", "/health", None, None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", "/v1/owners/user/ada/balances", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/v1/owners/user/ada/balances",
            Some("wrong"),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/v1/owners/user/ada/balances",
            Some(TOKEN),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn sandbox_credit_only_in_sandbox(pool: PgPool) {
    let credit =
        json!({ "idempotency_key": "w1", "owner_id": "ada", "asset": "NGN", "amount": 5_000_000 });
    let (status, body) = call(
        &app(pool.clone(), false),
        "POST",
        "/v1/sandbox/credit",
        Some(TOKEN),
        Some(credit.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "forbidden");

    let sandbox = app(pool, true);
    assert_eq!(
        call(
            &sandbox,
            "POST",
            "/v1/sandbox/credit",
            Some(TOKEN),
            Some(credit.clone())
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(
            &sandbox,
            "POST",
            "/v1/sandbox/credit",
            Some(TOKEN),
            Some(credit)
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn transfers_flow_over_http(pool: PgPool) {
    let app = app(pool, true);
    let credit =
        json!({ "idempotency_key": "w1", "owner_id": "ada", "asset": "NGN", "amount": 1_000 });
    call(
        &app,
        "POST",
        "/v1/sandbox/credit",
        Some(TOKEN),
        Some(credit),
    )
    .await;

    let pay = json!({
        "idempotency_key": "pay:1", "kind": "payment",
        "from": { "owner_type": "user", "owner_id": "ada" },
        "to": { "owner_type": "user", "owner_id": "bola" },
        "asset": "NGN", "amount": 400, "reference": "charge:AB2CD3"
    });
    let (status, entry) = call(
        &app,
        "POST",
        "/v1/transfers",
        Some(TOKEN),
        Some(pay.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(entry["reference"], "charge:AB2CD3");
    assert_eq!(
        call(&app, "POST", "/v1/transfers", Some(TOKEN), Some(pay))
            .await
            .0,
        StatusCode::OK
    );

    let too_much = json!({
        "idempotency_key": "pay:2", "kind": "payment",
        "from": { "owner_type": "user", "owner_id": "ada" },
        "to": { "owner_type": "user", "owner_id": "bola" },
        "asset": "NGN", "amount": 601
    });
    let (status, body) = call(&app, "POST", "/v1/transfers", Some(TOKEN), Some(too_much)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "insufficient_funds");

    let (_, balances) = call(
        &app,
        "GET",
        "/v1/owners/user/ada/balances",
        Some(TOKEN),
        None,
    )
    .await;
    let ngn = balances
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["asset"] == "NGN")
        .unwrap();
    assert_eq!(ngn["available"], 600);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn system_accounts_cant_be_moved_through_the_api(pool: PgPool) {
    let app = app(pool, false);
    let steal = json!({
        "idempotency_key": "evil", "kind": "payment",
        "from": { "owner_type": "system", "owner_id": "sandbox_mint" },
        "to": { "owner_type": "user", "owner_id": "ada" },
        "asset": "NGN", "amount": 1_000_000
    });
    let (status, body) = call(&app, "POST", "/v1/transfers", Some(TOKEN), Some(steal)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "not_a_user");
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn sandbox_debit_and_close_over_http(pool: PgPool) {
    let live = app(pool.clone(), false);
    let debit =
        json!({ "idempotency_key": "d1", "owner_id": "ada", "asset": "NGN", "amount": 300 });
    assert_eq!(
        call(
            &live,
            "POST",
            "/v1/sandbox/debit",
            Some(TOKEN),
            Some(debit.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    let app = app(pool, true);
    let credit =
        json!({ "idempotency_key": "w1", "owner_id": "ada", "asset": "NGN", "amount": 1_000 });
    call(
        &app,
        "POST",
        "/v1/sandbox/credit",
        Some(TOKEN),
        Some(credit),
    )
    .await;
    assert_eq!(
        call(&app, "POST", "/v1/sandbox/debit", Some(TOKEN), Some(debit))
            .await
            .0,
        StatusCode::CREATED
    );
    let (status, found) = call(&app, "GET", "/v1/entries/by-key/d1", Some(TOKEN), None).await;
    assert_eq!(
        (status, found["kind"].as_str()),
        (StatusCode::OK, Some("sandbox_debit"))
    );

    let (status, closed) = call(&app, "POST", "/v1/owners/user/ada/close", Some(TOKEN), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(closed["entry"]["kind"], "account_closure");
    let (_, empty) = call(
        &app,
        "POST",
        "/v1/owners/user/bola/close",
        Some(TOKEN),
        None,
    )
    .await;
    assert_eq!(empty["entry"], Value::Null);
}
