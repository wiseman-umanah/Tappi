use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("amount must be a positive whole number of the asset's smallest unit")]
    InvalidAmount,
    #[error("unknown asset {0}")]
    UnknownAsset(String),
    #[error("source and destination are the same account")]
    SameAccount,
    #[error("only user accounts can do this")]
    NotAUser,
    #[error("insufficient funds")]
    InsufficientFunds,
    #[error("this idempotency key was already used for a different request")]
    IdempotencyConflict,
    #[error("the hold is already closed")]
    HoldClosed,
    #[error("some of this account's money is on hold")]
    HasActiveHolds,
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("unauthorized")]
    Unauthorized,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

impl LedgerError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::InvalidAmount => (StatusCode::BAD_REQUEST, "invalid_amount"),
            Self::UnknownAsset(_) => (StatusCode::BAD_REQUEST, "unknown_asset"),
            Self::SameAccount => (StatusCode::BAD_REQUEST, "same_account"),
            Self::NotAUser => (StatusCode::BAD_REQUEST, "not_a_user"),
            Self::InsufficientFunds => (StatusCode::UNPROCESSABLE_ENTITY, "insufficient_funds"),
            Self::IdempotencyConflict => (StatusCode::CONFLICT, "idempotency_conflict"),
            Self::HoldClosed => (StatusCode::CONFLICT, "hold_closed"),
            Self::HasActiveHolds => (StatusCode::CONFLICT, "has_active_holds"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Database(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for LedgerError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let message = if let Self::Database(error) = &self {
            tracing::error!(%error, "database error");
            "internal error".to_owned()
        } else {
            self.to_string()
        };
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response()
    }
}
