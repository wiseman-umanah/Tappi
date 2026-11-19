//! Each test gets its own fresh database (sqlx::test), migrated with the engine's migrations.
//! Needs DATABASE_URL pointing at a Postgres the user may create databases on (see docker-compose.yml).

use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tappi_engine::error::LedgerError;
use tappi_engine::ledger::{
    self, CLOSED_ACCOUNTS, CaptureRequest, HoldRequest, HoldStatus, Owner, SANDBOX_MINT,
    TransferRequest,
};

fn transfer(key: &str, from: Owner, to: Owner, asset: &str, amount: i64) -> TransferRequest {
    TransferRequest {
        idempotency_key: key.into(),
        kind: "test".into(),
        from,
        to,
        asset: asset.into(),
        amount,
        reference: None,
        metadata: None,
    }
}

async fn mint(pool: &PgPool, user: &str, asset: &str, amount: i64) {
    let key = format!("mint:{user}:{asset}:{amount}");
    ledger::transfer(
        pool,
        &transfer(
            &key,
            Owner::system(SANDBOX_MINT),
            Owner::user(user),
            asset,
            amount,
        ),
    )
    .await
    .unwrap();
}

async fn available(pool: &PgPool, user: &str, asset: &str) -> i64 {
    ledger::balances(pool, &Owner::user(user))
        .await
        .unwrap()
        .into_iter()
        .find(|b| b.asset == asset)
        .unwrap()
        .available
}

/// Sum of every account's balance per asset — always zero in a double-entry ledger.
async fn assert_books_balance(pool: &PgPool) {
    let unbalanced: Vec<(String, i64)> = sqlx::query_as(
        "SELECT asset, sum(balance)::bigint FROM engine.accounts GROUP BY asset HAVING sum(balance) <> 0",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(unbalanced.is_empty(), "books don't balance: {unbalanced:?}");
    let drift: Vec<(uuid::Uuid,)> = sqlx::query_as(
        "SELECT a.id FROM engine.accounts a
         LEFT JOIN engine.postings p ON p.account_id = a.id
         GROUP BY a.id HAVING a.balance <> coalesce(sum(p.amount), 0)",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(
        drift.is_empty(),
        "cached balances drifted from postings: {drift:?}"
    );
}

/// For the stress tests: every task queues for the same two accounts' row locks, holding a
/// connection while it waits. The test framework's default pool (5 connections, short wait) times
/// out on a busy machine; that's a test artefact, not a ledger problem, so give it a realistic pool.
/// A real deadlock would still fail fast: Postgres reports it as "deadlock detected".
async fn stress_pool(options: PgPoolOptions, connect: PgConnectOptions) -> PgPool {
    options
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(120))
        .connect_with(connect)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn new_user_has_zero_in_every_asset(pool: PgPool) {
    let balances = ledger::balances(&pool, &Owner::user("ada")).await.unwrap();
    let assets: Vec<_> = balances
        .iter()
        .map(|b| (b.asset.as_str(), b.decimals, b.balance))
        .collect();
    assert_eq!(
        assets,
        [("BTC", 8, 0), ("NGN", 2, 0), ("USDC", 6, 0), ("USDT", 6, 0)]
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn transfer_moves_money(pool: PgPool) {
    mint(&pool, "ada", "NGN", 500_000).await;
    let entry = ledger::transfer(
        &pool,
        &transfer(
            "t1",
            Owner::user("ada"),
            Owner::user("bola"),
            "NGN",
            120_000,
        ),
    )
    .await
    .unwrap();
    assert!(!entry.replayed);
    assert_eq!(entry.postings.iter().map(|p| p.amount).sum::<i64>(), 0);
    assert_eq!(available(&pool, "ada", "NGN").await, 380_000);
    assert_eq!(available(&pool, "bola", "NGN").await, 120_000);
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn transfer_refuses_overdraft_and_leaves_nothing_behind(pool: PgPool) {
    mint(&pool, "ada", "USDT", 1_000_000).await;
    let result = ledger::transfer(
        &pool,
        &transfer(
            "t1",
            Owner::user("ada"),
            Owner::user("bola"),
            "USDT",
            1_000_001,
        ),
    )
    .await;
    assert!(matches!(result, Err(LedgerError::InsufficientFunds)));
    assert_eq!(available(&pool, "ada", "USDT").await, 1_000_000);
    // The failed attempt didn't burn its idempotency key: once funded, the same key succeeds.
    mint(&pool, "ada", "USDT", 1).await;
    ledger::transfer(
        &pool,
        &transfer(
            "t1",
            Owner::user("ada"),
            Owner::user("bola"),
            "USDT",
            1_000_001,
        ),
    )
    .await
    .unwrap();
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn transfer_rejects_bad_input(pool: PgPool) {
    let bad = |amount, asset: &str, to: &str| {
        transfer("x", Owner::user("ada"), Owner::user(to), asset, amount)
    };
    assert!(matches!(
        ledger::transfer(&pool, &bad(0, "NGN", "bola")).await,
        Err(LedgerError::InvalidAmount)
    ));
    assert!(matches!(
        ledger::transfer(&pool, &bad(-5, "NGN", "bola")).await,
        Err(LedgerError::InvalidAmount)
    ));
    assert!(matches!(
        ledger::transfer(&pool, &bad(5, "ETH", "bola")).await,
        Err(LedgerError::UnknownAsset(_))
    ));
    assert!(matches!(
        ledger::transfer(&pool, &bad(5, "NGN", "ada")).await,
        Err(LedgerError::SameAccount)
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn same_key_replays_and_different_request_conflicts(pool: PgPool) {
    mint(&pool, "ada", "NGN", 100_000).await;
    let req = transfer(
        "pay:1",
        Owner::user("ada"),
        Owner::user("bola"),
        "NGN",
        40_000,
    );
    let first = ledger::transfer(&pool, &req).await.unwrap();
    let again = ledger::transfer(&pool, &req).await.unwrap();
    assert!(again.replayed);
    assert_eq!(first.id, again.id);
    assert_eq!(
        available(&pool, "ada", "NGN").await,
        60_000,
        "moved once, not twice"
    );

    let changed = TransferRequest {
        amount: 41_000,
        ..req
    };
    assert!(matches!(
        ledger::transfer(&pool, &changed).await,
        Err(LedgerError::IdempotencyConflict)
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn concurrent_debits_never_overdraw(options: PgPoolOptions, connect: PgConnectOptions) {
    let pool = stress_pool(options, connect).await;
    mint(&pool, "ada", "NGN", 100).await;
    let tasks: Vec<_> = (0..25)
        .map(|i| {
            let pool = pool.clone();
            tokio::spawn(async move {
                ledger::transfer(
                    &pool,
                    &transfer(
                        &format!("c{i}"),
                        Owner::user("ada"),
                        Owner::user("bola"),
                        "NGN",
                        10,
                    ),
                )
                .await
            })
        })
        .collect();
    let mut ok = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => ok += 1,
            Err(LedgerError::InsufficientFunds) => {}
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }
    assert_eq!(ok, 10);
    assert_eq!(available(&pool, "ada", "NGN").await, 0);
    assert_eq!(available(&pool, "bola", "NGN").await, 100);
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn opposite_transfers_at_once_dont_deadlock(
    options: PgPoolOptions,
    connect: PgConnectOptions,
) {
    let pool = stress_pool(options, connect).await;
    mint(&pool, "ada", "NGN", 1_000).await;
    mint(&pool, "bola", "NGN", 1_000).await;
    let tasks: Vec<_> = (0..40)
        .map(|i| {
            let pool = pool.clone();
            let (from, to) = if i % 2 == 0 {
                ("ada", "bola")
            } else {
                ("bola", "ada")
            };
            tokio::spawn(async move {
                ledger::transfer(
                    &pool,
                    &transfer(
                        &format!("x{i}"),
                        Owner::user(from),
                        Owner::user(to),
                        "NGN",
                        7,
                    ),
                )
                .await
            })
        })
        .collect();
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(
        available(&pool, "ada", "NGN").await + available(&pool, "bola", "NGN").await,
        2_000
    );
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn hold_reserves_then_captures(pool: PgPool) {
    mint(&pool, "ada", "BTC", 100_000).await;
    let hold = ledger::create_hold(
        &pool,
        &HoldRequest {
            idempotency_key: "h1".into(),
            owner: Owner::user("ada"),
            asset: "BTC".into(),
            amount: 60_000,
            reference: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(available(&pool, "ada", "BTC").await, 40_000);

    // Held money can't be spent elsewhere.
    let spend = ledger::transfer(
        &pool,
        &transfer("s1", Owner::user("ada"), Owner::user("bola"), "BTC", 50_000),
    )
    .await;
    assert!(matches!(spend, Err(LedgerError::InsufficientFunds)));

    let capture = CaptureRequest {
        to: Owner::user("bola"),
        kind: "charge".into(),
        metadata: None,
    };
    let entry = ledger::capture_hold(&pool, hold.id, &capture)
        .await
        .unwrap();
    let again = ledger::capture_hold(&pool, hold.id, &capture)
        .await
        .unwrap();
    assert!(again.replayed);
    assert_eq!(entry.id, again.id);

    assert_eq!(available(&pool, "ada", "BTC").await, 40_000);
    assert_eq!(available(&pool, "bola", "BTC").await, 60_000);
    assert_eq!(
        ledger::get_hold(&pool, hold.id).await.unwrap().status,
        HoldStatus::Captured
    );
    assert!(matches!(
        ledger::release_hold(&pool, hold.id).await,
        Err(LedgerError::HoldClosed)
    ));
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn hold_release_gives_money_back(pool: PgPool) {
    mint(&pool, "ada", "USDC", 5_000_000).await;
    let req = HoldRequest {
        idempotency_key: "h1".into(),
        owner: Owner::user("ada"),
        asset: "USDC".into(),
        amount: 5_000_000,
        reference: None,
    };
    let hold = ledger::create_hold(&pool, &req).await.unwrap();
    assert_eq!(
        ledger::create_hold(&pool, &req).await.unwrap().id,
        hold.id,
        "same key, same hold"
    );
    assert_eq!(available(&pool, "ada", "USDC").await, 0);

    ledger::release_hold(&pool, hold.id).await.unwrap();
    ledger::release_hold(&pool, hold.id).await.unwrap();
    assert_eq!(available(&pool, "ada", "USDC").await, 5_000_000);

    let capture = CaptureRequest {
        to: Owner::user("bola"),
        kind: "charge".into(),
        metadata: None,
    };
    assert!(matches!(
        ledger::capture_hold(&pool, hold.id, &capture).await,
        Err(LedgerError::HoldClosed)
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn hold_cannot_exceed_available(pool: PgPool) {
    mint(&pool, "ada", "NGN", 10).await;
    let req = HoldRequest {
        idempotency_key: "h1".into(),
        owner: Owner::user("ada"),
        asset: "NGN".into(),
        amount: 11,
        reference: None,
    };
    assert!(matches!(
        ledger::create_hold(&pool, &req).await,
        Err(LedgerError::InsufficientFunds)
    ));
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn ledger_rows_are_append_only(pool: PgPool) {
    mint(&pool, "ada", "NGN", 10).await;
    let edit = sqlx::query("UPDATE engine.postings SET amount = amount * 2")
        .execute(&pool)
        .await;
    assert!(edit.is_err());
    let delete = sqlx::query("DELETE FROM engine.journal_entries")
        .execute(&pool)
        .await;
    assert!(delete.is_err());
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn database_rejects_an_unbalanced_entry(pool: PgPool) {
    mint(&pool, "ada", "NGN", 10).await;
    let mut tx = pool.begin().await.unwrap();
    let entry: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO engine.journal_entries (idempotency_key, request_hash, kind) VALUES ('bad', '-', 'test') RETURNING id",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO engine.postings (entry_id, account_id, asset, amount)
         SELECT $1, id, asset, 5 FROM engine.accounts WHERE owner_id = 'ada'",
    )
    .bind(entry)
    .execute(&mut *tx)
    .await
    .unwrap();
    assert!(
        tx.commit().await.is_err(),
        "deferred trigger must refuse postings that don't sum to zero"
    );
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn closing_sweeps_every_asset_once(pool: PgPool) {
    mint(&pool, "ada", "NGN", 700).await;
    mint(&pool, "ada", "BTC", 1_234).await;
    let entry = ledger::close_account(&pool, "ada")
        .await
        .unwrap()
        .expect("something to sweep");
    assert_eq!(entry.kind, "account_closure");
    assert_eq!(entry.postings.len(), 4);
    assert_eq!(available(&pool, "ada", "NGN").await, 0);
    assert_eq!(available(&pool, "ada", "BTC").await, 0);
    let books = ledger::balances(&pool, &Owner::system(CLOSED_ACCOUNTS))
        .await
        .unwrap();
    assert_eq!(
        books.iter().find(|b| b.asset == "BTC").unwrap().balance,
        1_234
    );

    let again = ledger::close_account(&pool, "ada").await.unwrap().unwrap();
    assert!(again.replayed);
    assert_eq!(again.id, entry.id);
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn closing_an_empty_account_records_nothing(pool: PgPool) {
    assert!(
        ledger::close_account(&pool, "nobody")
            .await
            .unwrap()
            .is_none()
    );
    let entries: i64 = sqlx::query_scalar("SELECT count(*) FROM engine.journal_entries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(entries, 0);
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn closing_waits_for_holds_to_finish(pool: PgPool) {
    mint(&pool, "ada", "USDC", 100).await;
    let hold = ledger::create_hold(
        &pool,
        &HoldRequest {
            idempotency_key: "h".into(),
            owner: Owner::user("ada"),
            asset: "USDC".into(),
            amount: 40,
            reference: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        ledger::close_account(&pool, "ada").await,
        Err(LedgerError::HasActiveHolds)
    ));
    ledger::release_hold(&pool, hold.id).await.unwrap();
    assert!(ledger::close_account(&pool, "ada").await.unwrap().is_some());
    assert_books_balance(&pool).await;
}

#[sqlx::test(migrator = "tappi_engine::MIGRATOR")]
async fn entries_can_be_found_by_key(pool: PgPool) {
    mint(&pool, "ada", "NGN", 50).await;
    ledger::transfer(
        &pool,
        &transfer(
            "charge:1:pay",
            Owner::user("ada"),
            Owner::user("bola"),
            "NGN",
            20,
        ),
    )
    .await
    .unwrap();
    let found = ledger::entry_by_key(&pool, "charge:1:pay").await.unwrap();
    assert_eq!(
        found.postings.iter().map(|p| p.amount.abs()).max(),
        Some(20)
    );
    assert!(matches!(
        ledger::entry_by_key(&pool, "charge:2:pay").await,
        Err(LedgerError::NotFound)
    ));
}
