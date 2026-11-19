//! Swaps through Bitnob's trading API: NGN ⇄ USDT/USDC/BTC, BTC ⇄ USDT/USDC, USDT ⇄ USDC.
//!
//! 1. `quote`: Bitnob prices it; the quote (amounts, how to place the order, expiry) is stored here.
//! 2. `execute`: the user's side is held, the order placed against that quote, and when Bitnob fills
//!    it the held amount moves to Bitnob's clearing account and the bought asset is credited.
//!
//! Bitnob trades out of Tappi's company balances, so a naira swap spends Tappi's NGN *at Bitnob*:
//! that float has to be topped up from Paga separately (reconciliation shows it). Crypto-pair orders
//! aren't deduplicated by Bitnob, so a placed order is never resent: unclear outcomes are looked up.

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::bitnob::{BitnobConfig, BitnobError, call};
use super::{NewPayout, Op, Provider, emit_event, signed_text};
use crate::error::LedgerError;
use crate::ledger::{self, Owner, TransferRequest};
use crate::providers;

/// Crypto pairs as Bitnob orients them (base, quote). Selling `base` is SELL; buying it is BUY,
/// sized from Bitnob's price because Bitnob quotes in base units.
pub const CRYPTO_PAIRS: &[(&str, &str)] = &[("BTC", "USDT"), ("BTC", "USDC"), ("USDC", "USDT")];
const CRYPTO: &[&str] = &["USDT", "USDC", "BTC"];

fn decimals(asset: &str) -> u32 {
    match asset {
        "NGN" => 2,
        "BTC" => 8,
        _ => 6,
    }
}

/// How a from → to swap is placed: (base, quote, side). Naira pairs put what the user spends as
/// the base and SELL it (Bitnob's documented way to fix the amount spent), in both directions.
pub fn orient(from: &str, to: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let known = |a: &str| ["NGN", "USDT", "USDC", "BTC"].into_iter().find(|k| *k == a);
    let (from, to) = (known(from)?, known(to)?);
    if from == to {
        return None;
    }
    if from == "NGN" || to == "NGN" {
        return Some((from, to, "SELL"));
    }
    if !CRYPTO.contains(&from) || !CRYPTO.contains(&to) {
        return None;
    }
    CRYPTO_PAIRS
        .iter()
        .find_map(|&(base, quote)| match (from, to) {
            (f, t) if f == base && t == quote => Some((base, quote, "SELL")),
            (f, t) if f == quote && t == base => Some((base, quote, "BUY")),
            _ => None,
        })
}

fn involves_naira(order: &Value) -> bool {
    order["base_currency"] == "NGN" || order["quote_currency"] == "NGN"
}

/// A decimal string as a scaled integer: ("12.5", 3) → 12500. Extra places are rounded down, or up
/// when `up` (what we pay is never rounded below what Bitnob takes; what we get never above).
pub fn scaled(text: &str, places: u32, up: bool) -> Option<i128> {
    let text = text.trim();
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let (kept, rest) = frac.split_at(frac.len().min(places as usize));
    let mut value: i128 = format!("{whole}{kept:0<width$}", width = places as usize)
        .parse()
        .ok()?;
    if up && rest.bytes().any(|b| b != b'0') {
        value += 1;
    }
    Some(value)
}

fn major(amount: i128, places: u32) -> String {
    let scale = 10i128.pow(places);
    let text = format!(
        "{}.{:0width$}",
        amount / scale,
        amount % scale,
        width = places as usize
    );
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Quote {
    pub id: String,
    pub owner_id: String,
    pub from_asset: String,
    pub to_asset: String,
    pub send_amount: i64,
    pub receive_amount: i64,
    pub order_request: Value,
    pub price: Option<String>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub op_id: Option<Uuid>,
}

/// Bitnob's price for one `base` in `quote` (crypto pairs; used to size a BUY).
async fn price(cfg: &BitnobConfig, base: &str, quote: &str) -> Result<String, BitnobError> {
    let data = call(
        cfg,
        reqwest::Method::GET,
        &format!("/api/trading/prices?base_currency={base}&quote_currency={quote}"),
        None,
    )
    .await?;
    let p = signed_text(data.pointer("/price/price").or_else(|| data.get("price")));
    if p.is_empty() {
        Err(BitnobError::BadResponse(data.to_string()))
    } else {
        Ok(p)
    }
}

/// Prices a swap of `amount` (smallest units of `from`) and stores the quote for `execute`.
pub async fn quote(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
    from: &str,
    to: &str,
    amount: i64,
) -> Result<Quote, BitnobError> {
    let (base, quote_asset, side) = orient(from, to)
        .ok_or_else(|| BitnobError::Invalid(format!("{from} can't be swapped for {to}")))?;
    if amount <= 0 {
        return Err(BitnobError::Invalid("Enter an amount.".into()));
    }
    let base_places = decimals(base);
    // Bitnob quotes in base units. Selling base (every naira swap, and crypto sells): the amount is
    // already base. Buying base (crypto only): size it from the price, then use Bitnob's exact amounts.
    let quantity = if side == "SELL" {
        major(amount as i128, base_places)
    } else {
        let price = scaled(&price(cfg, base, quote_asset).await?, 8, false)
            .filter(|p| *p > 0)
            .ok_or_else(|| BitnobError::BadResponse("no price".into()))?;
        // amount (quote, minor) / price (quote per base, ×1e8) → base, minor.
        let base_minor = (amount as i128) * 10i128.pow(base_places) * 100_000_000
            / (price * 10i128.pow(decimals(quote_asset)));
        if base_minor <= 0 {
            return Err(BitnobError::Invalid(
                "That amount is too small to swap.".into(),
            ));
        }
        major(base_minor, base_places)
    };
    let request = json!({ "base_currency": base, "quote_currency": quote_asset, "side": side, "quantity": quantity });
    let data = call(
        cfg,
        reqwest::Method::POST,
        "/api/trading/quotes",
        Some(&request),
    )
    .await?;
    let q = data.get("quote").unwrap_or(&data);
    let exchange = q.get("exchange").cloned().unwrap_or(Value::Null);
    let id = signed_text(q.get("id"));
    let send_currency = signed_text(exchange.get("send_currency")).to_ascii_uppercase();
    let receive_currency = signed_text(exchange.get("receive_currency")).to_ascii_uppercase();
    // Bitnob may write more decimal places than we keep: what the user pays rounds up, what they
    // get rounds down, so Tappi never gives away a fraction.
    let send = scaled(
        &signed_text(exchange.get("send_quantity")),
        decimals(from),
        true,
    );
    let receive = scaled(
        &signed_text(exchange.get("receive_quantity")),
        decimals(to),
        false,
    );
    let expires_at = signed_text(q.get("expires_at"))
        .parse::<chrono::DateTime<chrono::Utc>>()
        .ok();
    let (Some(send), Some(receive), Some(expires_at)) = (send, receive, expires_at) else {
        return Err(BitnobError::BadResponse(data.to_string()));
    };
    if id.is_empty() || send_currency != from || receive_currency != to || send <= 0 || receive <= 0
    {
        return Err(BitnobError::BadResponse(data.to_string()));
    }
    let order_request = json!({ "base_currency": base, "quote_currency": quote_asset, "side": side, "quantity": q.get("quantity").cloned().unwrap_or(json!(quantity)) });
    sqlx::query(
        "INSERT INTO engine.trade_quotes (id, owner_id, from_asset, to_asset, send_amount, receive_amount, order_request, price, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&id)
    .bind(owner_id)
    .bind(from)
    .bind(to)
    .bind(send as i64)
    .bind(receive as i64)
    .bind(&order_request)
    .bind(Some(signed_text(q.get("price"))).filter(|p| !p.is_empty()))
    .bind(expires_at)
    .execute(pool)
    .await
    .map_err(LedgerError::from)?;
    get_quote(pool, &id).await
}

pub async fn get_quote(pool: &PgPool, id: &str) -> Result<Quote, BitnobError> {
    sqlx::query_as(
        "SELECT id, owner_id, from_asset, to_asset, send_amount, receive_amount, order_request, price, expires_at, op_id
         FROM engine.trade_quotes WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(LedgerError::from)?
    .ok_or(BitnobError::Ledger(LedgerError::NotFound))
}

/// Places the order for a stored quote. One quote makes at most one order: the operation is keyed
/// on the quote, so a retry (or a second tap) returns the same swap.
pub async fn execute(
    pool: &PgPool,
    cfg: &BitnobConfig,
    owner_id: &str,
    quote_id: &str,
) -> Result<Op, BitnobError> {
    let q = get_quote(pool, quote_id).await?;
    if q.owner_id != owner_id {
        return Err(BitnobError::Ledger(LedgerError::NotFound));
    }
    let key = format!("trade:{quote_id}");
    if let Some(existing) = providers::op_by_key(pool, &key).await? {
        return Ok(existing);
    }
    if q.expires_at <= chrono::Utc::now() + chrono::Duration::seconds(1) {
        return Err(BitnobError::Invalid(
            "That rate expired. Get a new one.".into(),
        ));
    }
    let op = providers::start_payout(
        pool,
        NewPayout {
            provider: Provider::Bitnob,
            kind: "trade",
            key: &key,
            owner_id,
            asset: &q.from_asset,
            amount: q.send_amount,
            request: json!({ "quoteId": q.id, "to": q.to_asset, "receive": q.receive_amount }),
        },
    )
    .await?;
    sqlx::query("UPDATE engine.trade_quotes SET op_id = $2 WHERE id = $1 AND op_id IS NULL")
        .bind(&q.id)
        .bind(op.id)
        .execute(pool)
        .await
        .map_err(LedgerError::from)?;
    if op.status != "created" {
        return Ok(op);
    }
    providers::mark_submitted(pool, op.id, 30).await?;
    let mut order = q.order_request.clone();
    order["quote_id"] = json!(q.id);
    order["reference"] = json!(op.id.simple().to_string());
    // Crypto orders are placed at the quoted price (ignored for naira pairs).
    if !involves_naira(&order)
        && let Some(price) = &q.price
    {
        order["price"] = json!(price);
    }
    // Kept so an unclear naira order can be re-sent as is (Bitnob dedupes those by reference).
    sqlx::query("UPDATE engine.provider_ops SET request = request || jsonb_build_object('order', $2::jsonb) WHERE id = $1")
        .bind(op.id)
        .bind(&order)
        .execute(pool)
        .await
        .map_err(LedgerError::from)?;
    let placed = call(
        cfg,
        reqwest::Method::POST,
        "/api/trading/orders",
        Some(&order),
    )
    .await;
    match placed {
        Ok(data) => apply_order(pool, op.id, &data).await,
        // Refused outright (expired quote, not enough balance at Bitnob…): nothing traded.
        Err(BitnobError::Api {
            status,
            code,
            detail,
        }) if (400..500).contains(&status) && ![408, 409, 429].contains(&status) => {
            tracing::warn!(status, %code, %detail, "Bitnob refused a trade");
            let reason = if code == "INSUFFICIENT_FUNDS"
                || detail.to_ascii_lowercase().contains("insufficient")
            {
                "Swaps are paused for this currency right now. Try again later."
            } else {
                "That rate expired or the swap was refused. Get a new rate and try again."
            };
            Ok(
                providers::fail_op(pool, op.id, &format!("{code}: {detail} | {reason}"), None)
                    .await?,
            )
        }
        // Unknown outcome: never resend (Bitnob doesn't dedupe crypto orders); look it up instead.
        Err(error) => {
            tracing::warn!(%error, op = %op.id, "trade outcome unknown; will look it up");
            providers::mark_pending(
                pool,
                op.id,
                None,
                &json!({ "error": error.to_string() }),
                15,
            )
            .await?;
            Ok(providers::get_op(pool, op.id).await?)
        }
    }
}

/// Applies Bitnob's view of an order (from placing it, a lookup or a webhook).
async fn apply_order(pool: &PgPool, op_id: Uuid, data: &Value) -> Result<Op, BitnobError> {
    let order = data.get("order").unwrap_or(data);
    let status = signed_text(order.get("status")).to_ascii_lowercase();
    match status.as_str() {
        "filled" | "completed" => settle(pool, op_id, order).await,
        "rejected" | "cancelled" | "canceled" | "failed" => {
            Ok(providers::fail_op(pool, op_id, &format!("Bitnob: {status}"), Some(order)).await?)
        }
        _ => {
            providers::mark_pending(
                pool,
                op_id,
                Some(&signed_text(order.get("id")))
                    .filter(|s| !s.is_empty())
                    .map(String::as_str),
                order,
                15,
            )
            .await?;
            Ok(providers::get_op(pool, op_id).await?)
        }
    }
}

/// The order filled: the held amount goes to Bitnob's clearing account and the bought asset comes
/// out of it to the user. Safe to repeat.
async fn settle(pool: &PgPool, op_id: Uuid, order: &Value) -> Result<Op, BitnobError> {
    let op = providers::succeed_op(
        pool,
        op_id,
        Some(&signed_text(order.get("id")))
            .filter(|s| !s.is_empty())
            .map(String::as_str),
        order,
    )
    .await?;
    let (Some(owner), Some(to), Some(receive)) = (
        op.owner_id.clone(),
        op.request
            .get("to")
            .and_then(Value::as_str)
            .map(str::to_owned),
        op.request.get("receive").and_then(Value::as_i64),
    ) else {
        return Err(BitnobError::BadResponse(format!(
            "trade {op_id} is missing its details"
        )));
    };
    let credited = ledger::transfer(
        pool,
        &TransferRequest {
            idempotency_key: format!("trade:{op_id}:in"),
            kind: "trade".into(),
            from: Provider::Bitnob.clearing(),
            to: Owner::user(owner.clone()),
            asset: to.clone(),
            amount: receive,
            reference: Some(format!("bitnob:trade:{op_id}")),
            metadata: None,
        },
    )
    .await?;
    emit_event(
        pool,
        &owner,
        "swap",
        json!({ "opId": op.id, "entryId": credited.id, "from": op.asset, "sent": op.amount, "to": to, "received": receive }),
        &format!("trade:{op_id}:done"),
    )
    .await?;
    Ok(op)
}

/// Finds out what happened to a trade we're unsure about (the checker calls this). Naira orders
/// are deduplicated by reference at Bitnob, so the same order is simply sent again (it returns the
/// original); crypto orders aren't, so they're looked up by reference and never resent.
pub async fn check(pool: &PgPool, cfg: &BitnobConfig, op: &Op) -> Result<Op, BitnobError> {
    let reference = op.id.simple().to_string();
    let order = op.request.get("order").cloned().unwrap_or(Value::Null);
    let answer = if involves_naira(&order) {
        call(
            cfg,
            reqwest::Method::POST,
            "/api/trading/orders",
            Some(&order),
        )
        .await
    } else {
        call(
            cfg,
            reqwest::Method::GET,
            &format!("/api/trading/orders/{reference}"),
            None,
        )
        .await
    };
    match answer {
        Ok(data) => apply_order(pool, op.id, &data).await,
        Err(BitnobError::Api { status: 404, .. }) if !involves_naira(&order) => {
            // Never placed. Once its quote has expired it can't be placed any more: give the money back.
            let expired: Option<bool> = sqlx::query_scalar("SELECT expires_at < now() - interval '1 minute' FROM engine.trade_quotes WHERE op_id = $1")
                .bind(op.id)
                .fetch_optional(pool)
                .await
                .map_err(LedgerError::from)?;
            if expired.unwrap_or(true) {
                Ok(providers::fail_op(pool, op.id, "the order was never placed", None).await?)
            } else {
                providers::mark_pending(
                    pool,
                    op.id,
                    None,
                    &json!({ "lookup": "not found yet" }),
                    15,
                )
                .await?;
                Ok(providers::get_op(pool, op.id).await?)
            }
        }
        // A naira re-send refused outright (expired quote…): it never traded.
        Err(BitnobError::Api {
            status,
            code,
            detail,
        }) if involves_naira(&order)
            && (400..500).contains(&status)
            && ![408, 409, 429].contains(&status) =>
        {
            Ok(providers::fail_op(pool, op.id, &format!("{code}: {detail}"), None).await?)
        }
        Err(error) => {
            tracing::warn!(%error, op = %op.id, "trade check failed");
            providers::mark_pending(
                pool,
                op.id,
                None,
                &json!({ "error": error.to_string() }),
                60,
            )
            .await?;
            Ok(providers::get_op(pool, op.id).await?)
        }
    }
}

/// `trade.completed` / `trade.failed` webhooks: matched on our reference (the operation id).
pub async fn handle_webhook(pool: &PgPool, kind: &str, data: &Value) -> Result<(), String> {
    let reference = signed_text(data.get("reference"));
    let op_id =
        Uuid::parse_str(&reference).map_err(|_| format!("not a Tappi trade: {reference}"))?;
    let result = if kind == "trade.completed" {
        let mut order = data.clone();
        order["status"] = json!("filled");
        apply_order(pool, op_id, &order).await
    } else {
        providers::fail_op(
            pool,
            op_id,
            &format!("Bitnob: {}", signed_text(data.get("reason"))),
            Some(data),
        )
        .await
        .map_err(BitnobError::from)
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}
