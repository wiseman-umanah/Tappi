use tappi_engine::config::Config;
use tappi_engine::http::{AppState, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env().unwrap_or_else(|error| panic!("config: {error}"));
    let pool = tappi_engine::connect(&config.database_url)
        .await
        .expect("database");
    if config.sandbox {
        tracing::warn!(
            "ENGINE_SANDBOX is on: /v1/sandbox/* can mint money. Tests only: turn it off"
        );
    }

    let paga = config.paga.clone().map(std::sync::Arc::new);
    match &paga {
        Some(cfg) => {
            tracing::info!(live = cfg.live, "paga enabled");
            tokio::spawn(tappi_engine::providers::paga::run_checker(
                pool.clone(),
                cfg.clone(),
            ));
        }
        None => tracing::info!("paga not configured (set PAGA_* keys to enable)"),
    }

    let bitnob = config.bitnob.clone().map(std::sync::Arc::new);
    match &bitnob {
        Some(cfg) => {
            // In the background: the engine starts listening without waiting on Bitnob.
            let check = cfg.clone();
            tokio::spawn(async move {
                match tappi_engine::providers::bitnob::whoami(&check).await {
                    Ok(who) => tracing::info!(environment = %who["environment"], "bitnob enabled"),
                    Err(error) => {
                        tracing::error!(%error, "bitnob keys don't work (check BITNOB_* in .env, and the IP whitelist)")
                    }
                }
            });
            tokio::spawn(tappi_engine::providers::bitnob::run_trade_checker(
                pool.clone(),
                cfg.clone(),
            ));
            tokio::spawn(tappi_engine::providers::bitnob::run_checker(
                pool.clone(),
                cfg.clone(),
            ));
        }
        None => tracing::info!("bitnob not configured (set BITNOB_* keys to enable)"),
    }

    let app = router(AppState {
        pool,
        token: config.token.into(),
        sandbox: config.sandbox,
        paga,
        bitnob,
    });
    let listener = tokio::net::TcpListener::bind(&config.addr)
        .await
        .expect("bind");
    tracing::info!(addr = %config.addr, "tappi engine listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .expect("server");
}
