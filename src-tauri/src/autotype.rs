//! Auto-type engine (PLAN Phase 6 / ATY-01..04).
//!
//! Parses a KeePass-style auto-type sequence into a list of [`Action`]s and
//! replays them as synthetic keystrokes into whichever window currently has
//! focus. Keystroke synthesis is inherently OS-specific and only implemented on
//! Windows (the V1 target); other platforms compile a stub that returns a clear
//! error, so the workspace builds everywhere.
//!
//! The sequence grammar is intentionally small: `{USERNAME}`, `{PASSWORD}`,
//! `{TITLE}`, `{URL}`, `{TOTP}`, `{TAB}`, `{ENTER}` (alias `{RETURN}`), and any
//! literal text in between. Unknown `{...}` tokens are skipped.

use std::sync::Mutex;

use crate::error::AppResult;

/// Tauri-managed state remembering which window had focus when an auto-type
/// hotkey was last pressed. When the user picks an entry from the fallback
/// picker (which stole focus), we hand focus back to this window before typing.
#[derive(Default)]
pub struct AutoTypeTarget(pub Mutex<Option<isize>>);

/// The default sequence used when an entry has no custom override (ATY-02).
/// Deliberately does NOT auto-submit (no trailing `{ENTER}`) — the user submits
/// manually. Add `{ENTER}` via a per-entry "AutoType Sequence" to auto-submit.
pub const DEFAULT_SEQUENCE: &str = "{USERNAME}{TAB}{PASSWORD}";

/// Sequence that types only the password — used for selective auto-type
/// (Ctrl+Alt+P, ATY-04). Also non-submitting.
pub const PASSWORD_ONLY_SEQUENCE: &str = "{PASSWORD}";

/// The custom-field key an entry may set to override its auto-type sequence.
pub const SEQUENCE_FIELD: &str = "AutoType Sequence";

/// Field values an auto-type run can reference.
#[derive(Debug, Clone, Default)]
pub struct TypeFields {
    pub username: String,
    pub password: String,
    pub title: String,
    pub url: String,
    /// Pre-computed current TOTP code (empty when the entry has no OTP).
    pub totp: String,
}

/// One step in a parsed auto-type sequence.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Text(String),
    Tab,
    Enter,
}

/// Parse a sequence string into concrete actions, substituting field values.
pub fn parse_sequence(seq: &str, fields: &TypeFields) -> Vec<Action> {
    let mut actions: Vec<Action> = Vec::new();
    let mut literal = String::new();
    let mut chars = seq.chars().peekable();

    let flush = |literal: &mut String, actions: &mut Vec<Action>| {
        if !literal.is_empty() {
            actions.push(Action::Text(std::mem::take(literal)));
        }
    };

    while let Some(c) = chars.next() {
        if c != '{' {
            literal.push(c);
            continue;
        }
        // Read the token up to the closing brace.
        let mut token = String::new();
        let mut closed = false;
        for tc in chars.by_ref() {
            if tc == '}' {
                closed = true;
                break;
            }
            token.push(tc);
        }
        if !closed {
            // Unterminated brace — treat literally.
            literal.push('{');
            literal.push_str(&token);
            continue;
        }
        match token.to_ascii_uppercase().as_str() {
            "USERNAME" => {
                if !fields.username.is_empty() {
                    literal.push_str(&fields.username);
                }
            }
            "PASSWORD" => {
                if !fields.password.is_empty() {
                    literal.push_str(&fields.password);
                }
            }
            "TITLE" => literal.push_str(&fields.title),
            "URL" => literal.push_str(&fields.url),
            "TOTP" => literal.push_str(&fields.totp),
            "TAB" => {
                flush(&mut literal, &mut actions);
                actions.push(Action::Tab);
            }
            "ENTER" | "RETURN" => {
                flush(&mut literal, &mut actions);
                actions.push(Action::Enter);
            }
            // Unknown token: ignore it (matches lenient KeePass behaviour).
            _ => {}
        }
    }
    flush(&mut literal, &mut actions);
    actions
}

/// Raw handle (as `isize`) + title of the currently-focused foreground window.
/// The handle is opaque to the rest of the app; it is only ever round-tripped
/// back through [`focus_and_type`].
pub fn foreground_window() -> AppResult<(isize, String)> {
    imp::foreground_window()
}

/// Replay a parsed sequence as keystrokes into the already-focused window.
pub fn type_sequence(actions: &[Action]) -> AppResult<()> {
    imp::type_sequence(actions)
}

/// Restore focus to a previously-captured window, then type into it — used when
/// the user picks an entry from the auto-type fallback picker (the picker stole
/// focus, so the real target window must be re-focused first).
pub fn focus_and_type(window: isize, actions: &[Action]) -> AppResult<()> {
    imp::focus_and_type(window, actions)
}

// ── Windows implementation ────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::Action;
    use crate::error::{AppError, AppResult};
    use core::ffi::c_void;
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, SetForegroundWindow,
    };

    pub fn foreground_window() -> AppResult<(isize, String)> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return Ok((0, String::new()));
            }
            let len = GetWindowTextLengthW(hwnd);
            let title = if len <= 0 {
                String::new()
            } else {
                let mut buf = vec![0u16; len as usize + 1];
                let written = GetWindowTextW(hwnd, &mut buf);
                String::from_utf16_lossy(&buf[..written as usize])
            };
            Ok((hwnd.0 as isize, title))
        }
    }

    pub fn focus_and_type(window: isize, actions: &[Action]) -> AppResult<()> {
        if window != 0 {
            unsafe {
                let hwnd = HWND(window as *mut c_void);
                let _ = SetForegroundWindow(hwnd);
            }
            // Let the focus change settle before sending keystrokes.
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        type_sequence(actions)
    }

    pub fn type_sequence(actions: &[Action]) -> AppResult<()> {
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| AppError::Other(format!("auto-type init failed: {e}")))?;

        // The triggering hotkey's modifiers (Ctrl+Alt) may still be held when we
        // begin injecting. Release them first and give the user a moment to lift
        // the keys — otherwise an injected Tab becomes Alt+Tab (window switch)
        // and typed letters turn into Ctrl/Alt shortcuts.
        for modifier in [Key::Control, Key::Alt, Key::Shift, Key::Meta] {
            let _ = enigo.key(modifier, Direction::Release);
        }
        std::thread::sleep(std::time::Duration::from_millis(180));

        for action in actions {
            match action {
                Action::Text(t) => enigo
                    .text(t)
                    .map_err(|e| AppError::Other(format!("auto-type failed: {e}")))?,
                Action::Tab => enigo
                    .key(Key::Tab, Direction::Click)
                    .map_err(|e| AppError::Other(format!("auto-type failed: {e}")))?,
                Action::Enter => enigo
                    .key(Key::Return, Direction::Click)
                    .map_err(|e| AppError::Other(format!("auto-type failed: {e}")))?,
            }
            // A gap helps slower / SPA target apps keep up with the input queue
            // and lets focus settle after a Tab before the next field is typed.
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        Ok(())
    }
}

// ── Non-Windows stub ──────────────────────────────────────────────────────────

#[cfg(not(windows))]
mod imp {
    use super::Action;
    use crate::error::{AppError, AppResult};

    fn unsupported<T>() -> AppResult<T> {
        Err(AppError::InvalidOperation(
            "auto-type is only available on Windows".into(),
        ))
    }

    pub fn foreground_window() -> AppResult<(isize, String)> {
        unsupported()
    }

    pub fn focus_and_type(_window: isize, _actions: &[Action]) -> AppResult<()> {
        unsupported()
    }

    pub fn type_sequence(_actions: &[Action]) -> AppResult<()> {
        unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> TypeFields {
        TypeFields {
            username: "alex".into(),
            password: "s3cret".into(),
            title: "Gmail".into(),
            url: "https://mail.google.com".into(),
            totp: "123456".into(),
        }
    }

    #[test]
    fn parses_default_sequence() {
        // The default fills username + password but does not auto-submit.
        let actions = parse_sequence(DEFAULT_SEQUENCE, &fields());
        assert_eq!(
            actions,
            vec![
                Action::Text("alex".into()),
                Action::Tab,
                Action::Text("s3cret".into()),
            ]
        );
    }

    #[test]
    fn parses_literals_and_tokens() {
        let actions = parse_sequence("user:{USERNAME} {TOTP}{ENTER}", &fields());
        assert_eq!(
            actions,
            vec![
                Action::Text("user:alex 123456".into()),
                Action::Enter,
            ]
        );
    }

    #[test]
    fn unknown_tokens_are_skipped() {
        let actions = parse_sequence("{FOO}{PASSWORD}", &fields());
        assert_eq!(actions, vec![Action::Text("s3cret".into())]);
    }

    #[test]
    fn unterminated_brace_is_literal() {
        let actions = parse_sequence("{PASSWORD", &fields());
        assert_eq!(actions, vec![Action::Text("{PASSWORD".into())]);
    }
}
