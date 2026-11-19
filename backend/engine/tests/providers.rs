use serde_json::json;
use sqlx::PgPool;
use tappi_engine::error::LedgerError;
use tappi_engine::ledger::{self, Owner};
use tappi_engine::providers::{self, NewAccount, NewPayout, Provider};

async fn available(pool: &PgPool, user: &str, asset: &str) -> i64 {
    ledger::balances(pool, &Owner::user(user))
        .await
        .unwrap()
        .into_iter()
        .find(|b| b.asset == asset)
        .unwrap()
        .available
}

fn payout<'a>(key: &'a str, owner: &'a str, amount: i64) -> NewPayout<'a> {
    NewPayout {
        provider: Provider::Paga,
        kind: "bank_payout",
        key,
        owner_id: owner,
        asset: "NGN",
        amount,
        request: json!({ "bank": "test" }),
    }
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_deposit_is_credited_once_however_often_it_is_reported(pool: PgPool) {
    let first = providers::credit_deposit(
        &pool,
        Provider::Paga,
        "TXN-1",
        "ada",
        "NGN",
        500_000,
        json!({}),
    )
    .await
    .unwrap();
    let again = providers::credit_deposit(
        &pool,
        Provider::Paga,
        "TXN-1",
        "ada",
        "NGN",
        500_000,
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(first.id, again.id);
    assert!(again.replayed);
    assert_eq!(available(&pool, "ada", "NGN").await, 500_000);
    // The books say Paga holds that money for us.
    assert_eq!(
        providers::expected_provider_balances(&pool, Provider::Paga)
            .await
            .unwrap(),
        [("NGN".to_string(), 500_000)]
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn webhooks_are_stored_once(pool: PgPool) {
    let payload = json!({ "transactionReference": "T1" });
    let first = providers::record_webhook(&pool, Provider::Paga, "T1", Some("funding"), &payload)
        .await
        .unwrap();
    assert!(first.is_some());
    assert!(
        providers::record_webhook(&pool, Provider::Paga, "T1", Some("funding"), &payload)
            .await
            .unwrap()
            .is_none()
    );
    // The same id from another provider is a different event.
    assert!(
        providers::record_webhook(&pool, Provider::Bitnob, "T1", None, &payload)
            .await
            .unwrap()
            .is_some()
    );
    providers::finish_webhook(&pool, first.unwrap(), None)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn accounts_map_provider_ids_to_users(pool: PgPool) {
    let saved = providers::save_account(
        &pool,
        NewAccount {
            provider: Provider::Paga,
            owner_id: "ada",
            kind: "nuban",
            asset: "NGN",
            network: None,
            external_id: "0750529406",
            details: json!({ "bankName": "Paga" }),
        },
    )
    .await
    .unwrap();
    let found = providers::find_account(&pool, Provider::Paga, "0750529406")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((found.id, found.owner_id.as_str()), (saved.id, "ada"));
    assert!(
        providers::find_account(&pool, Provider::Paga, "0000000000")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(providers::accounts_of(&pool, "ada").await.unwrap().len(), 1);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_payout_holds_the_money_then_settles_it_at_the_provider(pool: PgPool) {
    providers::credit_deposit(
        &pool,
        Provider::Paga,
        "IN-1",
        "ada",
        "NGN",
        1_000_000,
        json!({}),
    )
    .await
    .unwrap();
    let op = providers::start_payout(&pool, payout("w1", "ada", 400_000))
        .await
        .unwrap();
    assert_eq!(op.status, "created");
    assert_eq!(
        available(&pool, "ada", "NGN").await,
        600_000,
        "held while in flight"
    );
    // Same key: same operation, not a second hold.
    assert_eq!(
        providers::start_payout(&pool, payout("w1", "ada", 400_000))
            .await
            .unwrap()
            .id,
        op.id
    );
    assert_eq!(available(&pool, "ada", "NGN").await, 600_000);

    providers::mark_submitted(&pool, op.id, 30).await.unwrap();
    providers::mark_pending(
        &pool,
        op.id,
        Some("PAGA-77"),
        &json!({ "responseCode": 3 }),
        60,
    )
    .await
    .unwrap();
    assert_eq!(
        providers::op_by_reference(&pool, Provider::Paga, "PAGA-77")
            .await
            .unwrap()
            .unwrap()
            .id,
        op.id
    );

    let done = providers::succeed_op(&pool, op.id, None, &json!({ "responseCode": 0 }))
        .await
        .unwrap();
    assert_eq!(done.status, "succeeded");
    // Reported again (webhook after a status check): nothing changes.
    providers::succeed_op(&pool, op.id, None, &json!({}))
        .await
        .unwrap();
    assert_eq!(available(&pool, "ada", "NGN").await, 600_000);
    assert_eq!(
        providers::expected_provider_balances(&pool, Provider::Paga)
            .await
            .unwrap(),
        [("NGN".to_string(), 600_000)]
    );
    assert!(matches!(
        providers::fail_op(&pool, op.id, "late failure", None).await,
        Err(LedgerError::HoldClosed)
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_failed_payout_gives_the_money_back(pool: PgPool) {
    providers::credit_deposit(
        &pool,
        Provider::Paga,
        "IN-1",
        "ada",
        "NGN",
        1_000_000,
        json!({}),
    )
    .await
    .unwrap();
    let op = providers::start_payout(&pool, payout("w1", "ada", 1_000_000))
        .await
        .unwrap();
    assert_eq!(available(&pool, "ada", "NGN").await, 0);
    let failed = providers::fail_op(
        &pool,
        op.id,
        "invalid bank account",
        Some(&json!({ "responseCode": 115 })),
    )
    .await
    .unwrap();
    assert_eq!(
        (failed.status.as_str(), failed.error.as_deref()),
        ("failed", Some("invalid bank account"))
    );
    providers::fail_op(&pool, op.id, "again", None)
        .await
        .unwrap();
    assert_eq!(available(&pool, "ada", "NGN").await, 1_000_000);
    assert!(matches!(
        providers::succeed_op(&pool, op.id, None, &json!({})).await,
        Err(LedgerError::HoldClosed)
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn a_payout_needs_the_money(pool: PgPool) {
    let result = providers::start_payout(&pool, payout("w1", "ada", 1)).await;
    assert!(matches!(result, Err(LedgerError::InsufficientFunds)));
    assert!(
        providers::op_by_key(&pool, "w1").await.unwrap().is_none(),
        "nothing recorded"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn open_operations_come_up_for_checking(pool: PgPool) {
    providers::credit_deposit(
        &pool,
        Provider::Paga,
        "IN-1",
        "ada",
        "NGN",
        1_000,
        json!({}),
    )
    .await
    .unwrap();
    let op = providers::start_payout(&pool, payout("w1", "ada", 500))
        .await
        .unwrap();
    providers::mark_submitted(&pool, op.id, 0).await.unwrap();
    let due = providers::due_for_check(&pool, 10).await.unwrap();
    assert_eq!(due.iter().map(|o| o.id).collect::<Vec<_>>(), [op.id]);
    providers::mark_pending(&pool, op.id, None, &json!({}), 3600)
        .await
        .unwrap();
    assert!(
        providers::due_for_check(&pool, 10)
            .await
            .unwrap()
            .is_empty(),
        "not due for an hour"
    );
}
