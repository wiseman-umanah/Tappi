//! USD virtual cards against a fake Bitnob shaped like its documented examples.

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use sqlx::PgPool;
use tappi_engine::ledger::{self, Owner};
use tappi_engine::providers::bitnob::{BitnobConfig, BitnobError};
use tappi_engine::providers::usdcard::{self, KycInput};
use tappi_engine::providers::{self, Provider};

const ADA: &str = "6f1c2a4e-0000-4000-8000-000000000001";

#[derive(Clone)]
struct Fake {
    create_status: Arc<Mutex<&'static str>>,
    move_status: Arc<Mutex<&'static str>>,
    card_balance: Arc<Mutex<i64>>,
    encrypted: Arc<Mutex<bool>>,
    refuse_create: Arc<Mutex<bool>>,
    kyc_invalid: Arc<Mutex<bool>>,
}

fn ok(data: Value) -> (StatusCode, Json<Value>) {
    (
        StatusCode::OK,
        Json(json!({ "success": true, "data": data })),
    )
}

async fn kyc(State(fake): State<Fake>, body: Bytes) -> (StatusCode, Json<Value>) {
    if *fake.kyc_invalid.lock().unwrap() {
        // Bitnob's documented validation shape.
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "success": false, "error": { "code": "BAD_REQUEST", "message": "Validation failed",
                "details": { "phone_number": "Phone number is invalid" } } }),
            ),
        );
    }
    let r: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(r["customer"]["country"], "NGA");
    assert_eq!(r["terms_of_service_accepted"], true);
    ok(json!({ "customer_id": "cus-kyc-1", "status": "approved", "normalized_status": "approved" }))
}

async fn kyc_status() -> (StatusCode, Json<Value>) {
    ok(json!({ "customer_id": "cus-kyc-1", "status": "approved", "normalized_status": "approved" }))
}

async fn create(State(fake): State<Fake>, body: Bytes) -> (StatusCode, Json<Value>) {
    let r: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (
            r["card_type"].as_str(),
            r["currency"].as_str(),
            r["customer_id"].as_str()
        ),
        (Some("virtual"), Some("USD"), Some("cus-kyc-1"))
    );
    if *fake.refuse_create.lock().unwrap() {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "success": false, "error": { "code": "VALIDATION_ERROR", "detail": "KYC verification required" } }),
            ),
        );
    }
    ok(
        json!({ "card": { "id": "card-1", "status": *fake.create_status.lock().unwrap(), "reference": r["reference"], "last_four_digit": "4242" } }),
    )
}

async fn card(State(fake): State<Fake>) -> (StatusCode, Json<Value>) {
    ok(
        json!({ "card": { "id": "card-1", "status": "active", "balance_amount": fake.card_balance.lock().unwrap().to_string(), "last_four_digit": "4242", "name": "ADA OBI" } }),
    )
}

async fn balance(State(fake): State<Fake>, body: Bytes) -> (StatusCode, Json<Value>) {
    let r: Value = serde_json::from_slice(&body).unwrap();
    ok(
        json!({ "success": false, "transaction": { "status": *fake.move_status.lock().unwrap(), "reference": r["reference"], "amount": r["amount"].to_string() } }),
    )
}

async fn status() -> (StatusCode, Json<Value>) {
    ok(json!({ "card": { "id": "card-1", "status": "frozen" } }))
}

async fn terminate() -> (StatusCode, Json<Value>) {
    ok(json!({ "transaction": { "type": "termination", "status": "pending" } }))
}

async fn secure(State(fake): State<Fake>, Path(_): Path<String>) -> (StatusCode, Json<Value>) {
    if *fake.encrypted.lock().unwrap() {
        return ok(
            json!({ "encrypted_details": { "encrypted_data": "x", "encrypted_key": "y", "algorithm": "RSA-OAEP-256+AES-256-GCM" } }),
        );
    }
    ok(
        json!({ "details": { "card_number": "4111111111111111", "cvv": "123", "expiry_month": "10", "expiry_year": "2029", "name": "ADA OBI" } }),
    )
}

async fn start_fake() -> (Fake, BitnobConfig) {
    let fake = Fake {
        create_status: Arc::new(Mutex::new("pending")),
        move_status: Arc::new(Mutex::new("pending")),
        card_balance: Arc::new(Mutex::new(10_000_000)),
        encrypted: Arc::default(),
        refuse_create: Arc::default(),
        kyc_invalid: Arc::default(),
    };
    let app = Router::new()
        .route("/api/cards/kyc", post(kyc))
        .route("/api/cards/kyc/{customer}", get(kyc_status))
        .route("/api/cards", post(create))
        .route("/api/cards/{id}", get(card).delete(terminate))
        .route("/api/cards/{id}/balance", post(balance))
        .route("/api/cards/{id}/status", post(status))
        .route("/api/cards/{id}/secure", get(secure))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        fake,
        BitnobConfig {
            client_id: "c".into(),
            client_secret: "s".into(),
            webhook_secret: "w".into(),
            base_url,
            card_fees: Default::default(),
        },
    )
}

fn kyc_input(id_type: &str) -> KycInput {
    KycInput {
        owner_id: ADA.into(),
        email: "ada@example.com".into(),
        first_name: "Ada".into(),
        last_name: "Obi".into(),
        date_of_birth: "1990-04-12".into(),
        phone_number: "8012345678".into(),
        id_type: id_type.into(),
        id_number: "22222222222".into(),
        line1: "12 Admiralty Way".into(),
        city: "Lagos".into(),
        state: "Lagos".into(),
        postal_code: "106104".into(),
        occupation: "13-2011".into(),
        employment_status: "employed".into(),
        account_purpose: "online subscriptions".into(),
        annual_salary: "24000".into(),
        expected_monthly_volume: "500".into(),
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

async fn verified_and_funded(pool: &PgPool, cfg: &BitnobConfig) {
    usdcard::submit_kyc(pool, cfg, &kyc_input("bvn"))
        .await
        .unwrap();
    providers::credit_deposit(
        pool,
        Provider::Bitnob,
        "seed",
        ADA,
        "USDC",
        50_000_000,
        json!({}),
    )
    .await
    .unwrap();
}

#[test]
fn fees_follow_bitnobs_table() {
    let fees = usdcard::CardFees::default();
    assert_eq!(fees.topup(2_000_000), 1_000_000, "$1 below $100");
    assert_eq!(fees.topup(100_000_000), 1_000_000, "1% from $100");
    assert_eq!(fees.topup(250_000_000), 2_500_000);
    // Changed prices (e.g. 1.5% from $50) apply as configured, rounded up.
    let custom = usdcard::CardFees {
        creation: 2_000_000,
        topup_flat: 500_000,
        topup_percent_bps: 150,
        percent_from: 50_000_000,
    };
    assert_eq!(custom.topup(40_000_000), 500_000);
    assert_eq!(custom.topup(66_666_667), 1_000_001);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn kyc_with_bvn_or_nin_only(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    assert!(matches!(
        usdcard::submit_kyc(&pool, &cfg, &kyc_input("passport")).await,
        Err(BitnobError::Invalid(_))
    ));
    assert_eq!(
        usdcard::kyc_status(&pool, &cfg, ADA).await.unwrap()["status"],
        "none"
    );
    assert_eq!(
        usdcard::submit_kyc(&pool, &cfg, &kyc_input("nin"))
            .await
            .unwrap()["status"],
        "approved"
    );
    assert_eq!(
        usdcard::kyc_status(&pool, &cfg, ADA).await.unwrap()["status"],
        "approved"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_card_costs_its_load_plus_fees_and_is_held_until_ready(pool: PgPool) {
    let (_, cfg) = start_fake().await;
    verified_and_funded(&pool, &cfg).await;
    assert!(
        matches!(
            usdcard::create(&pool, &cfg, ADA, 1_000_000, "USDC", "k").await,
            Err(BitnobError::Invalid(_))
        ),
        "at least $2"
    );

    let card = usdcard::create(&pool, &cfg, ADA, 10_000_000, "USDC", "k")
        .await
        .unwrap();
    assert_eq!(card.status, "pending");
    // $10 on the card + $1 creation + $1 top-up fee.
    assert_eq!(
        available(&pool, "USDC").await,
        50_000_000 - 12_000_000,
        "held"
    );
    // Asking again doesn't make a second card.
    assert_eq!(
        usdcard::create(&pool, &cfg, ADA, 10_000_000, "USDC", "k2")
            .await
            .unwrap()
            .id,
        card.id
    );

    let op_ref =
        sqlx::query_scalar::<_, uuid::Uuid>("SELECT op_id FROM engine.usd_cards WHERE id = $1")
            .bind(card.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    usdcard::handle_webhook(
        &pool,
        "virtualcard.created.completed",
        &json!({ "id": "card-1", "reference": op_ref.simple().to_string(), "status": "active" }),
    )
    .await
    .unwrap();
    let summary = usdcard::summary(&pool, &cfg, ADA).await.unwrap();
    assert_eq!(
        (summary["status"].as_str(), summary["balance"].as_i64()),
        (Some("active"), Some(10_000_000))
    );
    assert_eq!(available(&pool, "USDC").await, 38_000_000);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_refused_card_gives_the_money_back(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    verified_and_funded(&pool, &cfg).await;
    *fake.refuse_create.lock().unwrap() = true;
    assert!(
        usdcard::create(&pool, &cfg, ADA, 10_000_000, "USDC", "k")
            .await
            .is_err()
    );
    assert_eq!(available(&pool, "USDC").await, 50_000_000);
    assert!(usdcard::live_card(&pool, ADA).await.unwrap().is_none());
}

async fn active_card(pool: &PgPool, cfg: &BitnobConfig, fake: &Fake) {
    verified_and_funded(pool, cfg).await;
    *fake.create_status.lock().unwrap() = "active";
    usdcard::create(pool, cfg, ADA, 10_000_000, "USDC", "k")
        .await
        .unwrap();
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn topping_up_and_withdrawing(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    active_card(&pool, &cfg, &fake).await;
    assert_eq!(available(&pool, "USDC").await, 38_000_000);

    // Top-up: pending, then the webhook confirms it.
    let op = usdcard::fund(&pool, &cfg, ADA, 5_000_000, "USDC", "f1")
        .await
        .unwrap();
    assert_eq!(op.status, "pending");
    assert_eq!(
        available(&pool, "USDC").await,
        38_000_000 - 6_000_000,
        "$5 + $1 fee held"
    );
    usdcard::handle_webhook(&pool, "virtualcard.topup.completed", &json!({ "cardId": "card-1", "reference": op.id.simple().to_string(), "status": "completed" }))
        .await
        .unwrap();
    assert_eq!(
        providers::get_op(&pool, op.id).await.unwrap().status,
        "succeeded"
    );

    // Withdrawal: $1 must stay on the card ($10 on it).
    assert!(matches!(
        usdcard::withdraw(&pool, &cfg, ADA, 9_500_000, "w0").await,
        Err(BitnobError::Invalid(_))
    ));
    *fake.move_status.lock().unwrap() = "completed";
    usdcard::withdraw(&pool, &cfg, ADA, 4_000_000, "w1")
        .await
        .unwrap();
    assert_eq!(
        available(&pool, "USDC").await,
        32_000_000 + 4_000_000,
        "credited back as USDC"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn freeze_terminate_and_refund(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    active_card(&pool, &cfg, &fake).await;
    assert_eq!(
        usdcard::set_frozen(&pool, &cfg, ADA, true)
            .await
            .unwrap()
            .status,
        "frozen"
    );
    assert!(
        usdcard::fund(&pool, &cfg, ADA, 5_000_000, "USDC", "f")
            .await
            .is_err(),
        "no top-ups while frozen"
    );
    usdcard::set_frozen(&pool, &cfg, ADA, false).await.unwrap();

    usdcard::terminate(&pool, &cfg, ADA).await.unwrap();
    usdcard::handle_webhook(
        &pool,
        "virtualcard.terminated.refund",
        &json!({ "cardId": "card-1", "amount": 10_000_000, "status": "completed" }),
    )
    .await
    .unwrap();
    usdcard::handle_webhook(
        &pool,
        "virtualcard.terminated.refund",
        &json!({ "cardId": "card-1", "amount": 10_000_000, "status": "completed" }),
    )
    .await
    .unwrap();
    assert_eq!(
        available(&pool, "USDC").await,
        38_000_000 + 10_000_000,
        "refunded once"
    );
    assert!(usdcard::live_card(&pool, ADA).await.unwrap().is_none());
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn card_details(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    active_card(&pool, &cfg, &fake).await;
    let d = usdcard::secrets(&pool, &cfg, ADA).await.unwrap();
    assert_eq!(
        (
            d["number"].as_str(),
            d["cvv"].as_str(),
            d["expiryMonth"].as_str()
        ),
        (Some("4111111111111111"), Some("123"), Some("10"))
    );
    *fake.encrypted.lock().unwrap() = true;
    assert!(
        matches!(
            usdcard::secrets(&pool, &cfg, ADA).await,
            Err(BitnobError::Invalid(_))
        ),
        "can't show encrypted details"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn kyc_problems_say_which_field(pool: PgPool) {
    let (fake, cfg) = start_fake().await;
    *fake.kyc_invalid.lock().unwrap() = true;
    match usdcard::submit_kyc(&pool, &cfg, &kyc_input("bvn")).await {
        Err(BitnobError::Invalid(message)) => assert_eq!(message, "Phone number is invalid"),
        other => panic!("expected the field's message, got {other:?}"),
    }
}
