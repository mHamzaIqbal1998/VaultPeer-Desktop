//! Secure clipboard (PLAN Phase 6 / CLP-03).
//!
//! Copies text to the clipboard while flagging it so Windows clipboard history,
//! cloud sync, and third-party clipboard managers skip the content — keeping
//! copied secrets out of those persistence channels. Auto-clear after a timeout
//! is handled separately on the frontend (`lib/clipboard.ts`).
//!
//! Windows-only (the V1 target). On other platforms the function returns an
//! error so the frontend falls back to the standard Web Clipboard API.

use crate::error::AppResult;

/// Copy `text`, asking the OS/clipboard managers not to retain it.
pub fn copy_protected(text: &str) -> AppResult<()> {
    imp::copy_protected(text)
}

#[cfg(windows)]
mod imp {
    use crate::error::{AppError, AppResult};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    /// Allocate a movable global block and copy `bytes` into it (clipboard owns
    /// the block once handed to `SetClipboardData`).
    fn alloc_copy(bytes: &[u8]) -> AppResult<HGLOBAL> {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len())
                .map_err(|e| AppError::Other(format!("GlobalAlloc: {e}")))?;
            let ptr = GlobalLock(h);
            if ptr.is_null() {
                return Err(AppError::Other("GlobalLock failed".into()));
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(h);
            Ok(h)
        }
    }

    /// Best-effort: register a clipboard format and attach a small marker value
    /// so monitors honouring it skip the content. Failures are non-fatal.
    unsafe fn mark(format: PCWSTR, payload: &[u8]) {
        let id = RegisterClipboardFormatW(format);
        if id != 0 {
            if let Ok(h) = alloc_copy(payload) {
                let _ = SetClipboardData(id, HANDLE(h.0));
            }
        }
    }

    pub fn copy_protected(text: &str) -> AppResult<()> {
        // CF_UNICODETEXT expects a NUL-terminated UTF-16 string.
        let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let text_bytes: &[u8] =
            unsafe { std::slice::from_raw_parts(utf16.as_ptr() as *const u8, utf16.len() * 2) };

        unsafe {
            OpenClipboard(HWND::default())
                .map_err(|e| AppError::Other(format!("OpenClipboard: {e}")))?;

            // Ensure the clipboard is closed even if a step below fails.
            let result = (|| {
                EmptyClipboard().map_err(|e| AppError::Other(format!("EmptyClipboard: {e}")))?;

                let h = alloc_copy(text_bytes)?;
                SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(h.0))
                    .map_err(|e| AppError::Other(format!("SetClipboardData: {e}")))?;

                // Exclude from clipboard monitors, Win+V history, and cloud sync.
                let zero = 0u32.to_ne_bytes();
                mark(w!("ExcludeClipboardContentFromMonitorProcessing"), &[0u8]);
                mark(w!("CanIncludeInClipboardHistory"), &zero);
                mark(w!("CanUploadToCloudClipboard"), &zero);
                Ok(())
            })();

            let _ = CloseClipboard();
            result
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use crate::error::{AppError, AppResult};

    pub fn copy_protected(_text: &str) -> AppResult<()> {
        Err(AppError::InvalidOperation(
            "protected clipboard is only available on Windows".into(),
        ))
    }
}
