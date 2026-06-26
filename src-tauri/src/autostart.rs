//! "Start with Windows" launch-on-login toggle (PLAN Phase 7 / SET-05).
//!
//! Implemented natively against the per-user `Run` registry key
//! (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`), which Windows reads
//! at sign-in to launch the listed programs. Using HKCU (not HKLM) keeps this a
//! per-user setting that needs no elevation.
//!
//! Off-Windows the functions are safe stubs: [`set_enabled`] reports the feature
//! is unsupported and [`is_enabled`] returns `false`, so the rest of the app
//! (and the Linux dev build) is unaffected.

use crate::error::{AppError, AppResult};

/// Registry value name under the Run key; also the user-visible task name.
#[cfg(windows)]
const VALUE_NAME: &str = "VaultPeer";

/// Enable or disable launching VaultPeer when the user signs in.
#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_SZ,
    };

    // UTF-16, null-terminated helper for the Win32 *W APIs.
    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let value = wide(VALUE_NAME);

    unsafe {
        let mut hkey = HKEY(std::ptr::null_mut());
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_SET_VALUE,
            &mut hkey,
        );
        if status != ERROR_SUCCESS {
            return Err(AppError::Other(format!(
                "could not open Run registry key (error {})",
                status.0
            )));
        }

        let result = if enabled {
            // Value: the quoted absolute path to the running executable.
            let exe = std::env::current_exe()
                .map_err(|e| AppError::Other(format!("could not resolve executable path: {e}")))?;
            let command = format!("\"{}\"", exe.to_string_lossy());
            let data = wide(&command);
            // Byte view of the UTF-16 buffer (including the null terminator).
            let bytes = std::slice::from_raw_parts(
                data.as_ptr() as *const u8,
                data.len() * std::mem::size_of::<u16>(),
            );
            RegSetValueExW(hkey, PCWSTR(value.as_ptr()), 0, REG_SZ, Some(bytes))
        } else {
            let status = RegDeleteValueW(hkey, PCWSTR(value.as_ptr()));
            // Deleting an absent value is success from the user's perspective.
            if status == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND {
                ERROR_SUCCESS
            } else {
                status
            }
        };

        let _ = RegCloseKey(hkey);

        if result != ERROR_SUCCESS {
            return Err(AppError::Other(format!(
                "could not update autostart entry (error {})",
                result.0
            )));
        }
    }

    Ok(())
}

/// Whether the launch-on-login entry is currently present.
#[cfg(windows)]
pub fn is_enabled() -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let value = wide(VALUE_NAME);

    unsafe {
        let mut hkey = HKEY(std::ptr::null_mut());
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        ) != ERROR_SUCCESS
        {
            return false;
        }
        let present = RegQueryValueExW(hkey, PCWSTR(value.as_ptr()), None, None, None, None)
            == ERROR_SUCCESS;
        let _ = RegCloseKey(hkey);
        present
    }
}

/// Non-Windows stub: launch-on-login is a Windows-only feature for V1.
#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> AppResult<()> {
    Err(AppError::Other(
        "Start with Windows is only available on Windows.".into(),
    ))
}

/// Non-Windows stub: never enabled.
#[cfg(not(windows))]
pub fn is_enabled() -> bool {
    false
}
