pub mod config;
pub mod error;
pub mod http;
pub mod ledger;
pub mod providers;

use std::str::FromStr;

use sqlx::PgPool;
use sqlx::migrate::Migrator;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Connects with `search_path=engine` (so sqlx's own migrations table lives in the engine schema
/// too) and applies pending migrations.
pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let options = PgConnectOptions::from_str(database_url)?.options([("search_path", "engine")]);
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options)
        .await?;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS engine")
        .execute(&pool)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}
