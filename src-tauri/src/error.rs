use serde::Serialize;

/// Application-wide error type. Implements `Serialize` so it can be returned
/// directly from Tauri commands and surfaced to the frontend as a string.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("path is not valid UTF-8")]
    NonUtf8Path,

    // General-purpose variant for non-I/O failures surfaced by later phases
    // (crypto, sync, etc.). Allowed to be unused while the core is scaffolded.
    #[allow(dead_code)]
    #[error("{0}")]
    Other(String),
}

/// Serialize as a plain string message so the JS side receives a readable error.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
