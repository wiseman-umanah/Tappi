//! Test swaps (ENGINE_SANDBOX=true only): filled inside Tappi's ledger at fixed test rates instead
//! of Bitnob, so testers holding test money (tappi-fund) can try the Swap screen. Same quote →
//! execute flow and the same tables as real swaps; the quote is marked `test` and the app says so.
//! With ENGINE_SANDBOX off, swaps always go to Bitnob.

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::bitnob::BitnobError;
use super::trading::{self, Quote};
use super::{Provider, emit_event};
use crate::error::LedgerError;
use crate::ledger::{self, Owner, SANDBOX_MINT, TransferRequest};
use crate::providers;

/// Test rates: naira per US dollar and dollars per bitcoin (TEST_NGN_PER_USD, TEST_USD_PER_BTC).
fn rates() -> (i128, i128) {
    let read = |name: &str, default: i128| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.trim().parse::<i128>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    (
        read("TEST_NGN_PER_USD", 1569),
        read("TEST_USD_PER_BTC", 68_000),
    )
}

fn decimals(asset: &str) -> u32 {
    match asset {
        "NGN" => 2,
        "BTC" => 8,
        _ => 6,
    }
}

/// One whole unit of the asset in US dollars, as an exact fraction (numerator, denominator):
/// no rounding until the final amount.
fn price(asset: &str) -> (i128, i128) {
    let (ngn_per_usd, usd_per_btc) = rates();
    match asset {
        "NGN" => (1, ngn_per_usd),
        "BTC" => (usd_per_btc, 1),
        _ => (1, 1),
    }
}

/// What `amount` (smallest units of `from`) is worth in `to`, at the test rates. Rounded down once.
pub fn convert(from: &str, to: &str, amount: i64) -> i64 {
    let ((from_num, from_den), (to_num, to_den)) = (price(from), price(to));
    let out = (amount as i128) * 10i128.pow(decimals(to)) * from_num * to_den
        / (10i128.pow(decimals(from)) * from_den * to_num);
    out as i64
}

pub async fn quote(
    pool: &PgPool,
    owner_id: &str,
    from: &str,
    to: &str,
    amount: i64,
) -> Result<Quote, BitnobError> {
    let known = ["NGN", "USDT", "USDC", "BTC"];
    if !known.contains(&from) || !known.contains(&to) || from == to {
        return Err(BitnobError::Invalid(format!(
            "{from} can't be swapped for {to}"
        )));
    }
    let receive = convert(from, to, amount);
    if amount <= 0 || receive <= 0 {
        return Err(BitnobError::Invalid(
            "That amount is too small to swap.".into(),
        ));
    }
    let id = format!("test-{}", Uuid::new_v4().simple());
    let (ngn_per_usd, usd_per_btc) = rates();
    sqlx::query(
        "INSERT INTO engine.trade_quotes (id, owner_id, from_asset, to_asset, send_amount, receive_amount, order_request, price, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, now() + interval '60 seconds')",
    )
    .bind(&id)
    .bind(owner_id)
    .bind(from)
    .bind(to)
    .bind(amount)
    .bind(receive)
    .bind(json!({ "test": true, "ngnPerUsd": ngn_per_usd.to_string(), "usdPerBtc": usd_per_btc.to_string() }))
    .execute(pool)
    .await
    .map_err(LedgerError::from)?;
    trading::get_quote(pool, &id).await
}

pub fn is_test(q: &Quote) -> bool {
    q.order_request.get("test").and_then(|v| v.as_bool()) == Some(true)
}

/// Fills a test quote: the user's side goes to the test mint, the other side comes from it.
/// Safe to repeat (each leg is keyed on the quote).
pub async fn execute(
    pool: &PgPool,
    owner_id: &str,
    quote_id: &str,
) -> Result<providers::Op, BitnobError> {
    let q = trading::get_quote(pool, quote_id).await?;
    if q.owner_id != owner_id || !is_test(&q) {
        return Err(BitnobError::Ledger(LedgerError::NotFound));
    }
    let key = format!("trade:{quote_id}");
    if let Some(existing) = providers::op_by_key(pool, &key).await?
        && existing.status == "succeeded"
    {
        return Ok(existing);
    }
    if q.expires_at <= chrono::Utc::now() {
        return Err(BitnobError::Invalid(
            "That rate expired. Get a new one.".into(),
        ));
    }
    let leg = |key: String, from: Owner, to: Owner, asset: &str, amount: i64| TransferRequest {
        idempotency_key: key,
        kind: "test_trade".into(),
        from,
        to,
        asset: asset.into(),
        amount,
        reference: Some(format!("test-swap:{quote_id}")),
        metadata: None,
    };
    let mint = Owner::system(SANDBOX_MINT);
    ledger::transfer(
        pool,
        &leg(
            format!("{key}:out"),
            Owner::user(owner_id),
            mint.clone(),
            &q.from_asset,
            q.send_amount,
        ),
    )
    .await?;
    let credited = ledger::transfer(
        pool,
        &leg(
            format!("{key}:in"),
            mint,
            Owner::user(owner_id),
            &q.to_asset,
            q.receive_amount,
        ),
    )
    .await?;

    let op = providers::start_op(
        pool,
        Provider::Bitnob,
        "test_trade",
        &key,
        Some(owner_id),
        json!({ "quoteId": q.id, "to": q.to_asset, "receive": q.receive_amount, "test": true }),
    )
    .await?;
    sqlx::query(
        "UPDATE engine.provider_ops SET status = 'succeeded', asset = $2, amount = $3, updated_at = now() WHERE id = $1",
    )
    .bind(op.id)
    .bind(&q.from_asset)
    .bind(q.send_amount)
    .execute(pool)
    .await
    .map_err(LedgerError::from)?;
    sqlx::query("UPDATE engine.trade_quotes SET op_id = $2 WHERE id = $1 AND op_id IS NULL")
        .bind(&q.id)
        .bind(op.id)
        .execute(pool)
        .await
        .map_err(LedgerError::from)?;
    emit_event(
        pool,
        owner_id,
        "swap",
        json!({ "opId": op.id, "entryId": credited.id, "from": q.from_asset, "sent": q.send_amount, "to": q.to_asset, "received": q.receive_amount }),
        &format!("trade:{}:done", op.id),
    )
    .await?;
    Ok(providers::get_op(pool, op.id).await?)
}
