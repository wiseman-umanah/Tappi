use std::env;

use crate::providers::bitnob::{self, BitnobConfig};
use crate::providers::paga::PagaConfig;
use crate::providers::usdcard::CardFees;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    /// Shared secret the API sends as `Authorization: Bearer …`. The engine is never public.
    pub token: String,
    pub addr: String,
    /// Allows `/v1/sandbox/*` (minting test money). Automated tests only; never in a running deployment.
    pub sandbox: bool,
    /// Paga, when all its keys are set (and PUBLIC_URL, for its webhooks).
    pub paga: Option<PagaConfig>,
    /// Bitnob, when its client id, client secret and webhook secret are set.
    pub bitnob: Option<BitnobConfig>,
}

fn optional(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// Dollars ("1", "0.50") as micro-dollars.
fn dollars(name: &str, default: i64) -> Result<i64, String> {
    match optional(name) {
        None => Ok(default),
        Some(text) => crate::providers::major_to_minor(&text, 6)
            .ok_or_else(|| format!("{name} must be an amount in dollars, like 1 or 0.50")),
    }
}

/// USD card fees from .env, defaulting to Bitnob's published ones.
fn card_fees() -> Result<CardFees, String> {
    let d = CardFees::default();
    let percent = match optional("CARD_TOPUP_FEE_PERCENT") {
        None => d.topup_percent_bps,
        // "1" or "1.5" percent → hundredths of a percent.
        Some(text) => crate::providers::major_to_minor(&text, 2)
            .ok_or("CARD_TOPUP_FEE_PERCENT must be a number like 1 or 1.5")?,
    };
    Ok(CardFees {
        creation: dollars("CARD_CREATION_FEE_USD", d.creation)?,
        topup_flat: dollars("CARD_TOPUP_FEE_USD", d.topup_flat)?,
        topup_percent_bps: percent,
        percent_from: dollars("CARD_TOPUP_PERCENT_FROM_USD", d.percent_from)?,
    })
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
        let token = env::var("ENGINE_TOKEN").map_err(|_| "ENGINE_TOKEN is required")?;
        if token.len() < 32 {
            return Err("ENGINE_TOKEN must be at least 32 characters".into());
        }
        let public_url = optional("PUBLIC_URL");
        let paga = match (
            optional("PAGA_PUBLIC_KEY"),
            optional("PAGA_SECRET_KEY"),
            optional("PAGA_HASH_KEY"),
        ) {
            (Some(public_key), Some(secret_key), Some(hash_key)) => Some(PagaConfig {
                public_key,
                secret_key,
                hash_key,
                live: match optional("PAGA_ENV").as_deref() {
                    None | Some("sandbox") => false,
                    Some("live") => true,
                    Some(other) => {
                        return Err(format!("PAGA_ENV must be sandbox or live, not {other}"));
                    }
                },
                public_url: public_url
                    .clone()
                    .ok_or("PUBLIC_URL is required with Paga keys (Paga posts webhooks to it)")?,
                base_override: None,
            }),
            (None, None, None) => None,
            _ => {
                return Err(
                    "set all of PAGA_PUBLIC_KEY, PAGA_SECRET_KEY and PAGA_HASH_KEY, or none".into(),
                );
            }
        };
        let bitnob = match (optional("BITNOB_CLIENT_ID"), optional("BITNOB_CLIENT_SECRET"), optional("BITNOB_WEBHOOK_SECRET")) {
            (Some(client_id), Some(client_secret), Some(webhook_secret)) => Some(BitnobConfig {
                client_id,
                client_secret,
                webhook_secret,
                base_url: optional("BITNOB_BASE_URL").unwrap_or_else(|| bitnob::BASE_URL.into()),
                card_fees: card_fees()?,
            }),
            (None, None, None) => None,
            _ => return Err("set all of BITNOB_CLIENT_ID, BITNOB_CLIENT_SECRET and BITNOB_WEBHOOK_SECRET, or none".into()),
        };
        Ok(Self {
            database_url,
            token,
            addr: env::var("ENGINE_ADDR").unwrap_or_else(|_| "127.0.0.1:8090".into()),
            sandbox: env::var("ENGINE_SANDBOX").is_ok_and(|v| v == "true"),
            paga,
            bitnob,
        })
    }
}
