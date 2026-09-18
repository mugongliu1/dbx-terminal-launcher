use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use dbx_plugin_sdk::{
    PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};

const PLUGIN_ID: &str = "io.github.mugongliu1.terminal";
const PLUGIN_VERSION: &str = "0.2.3";
const MIN_TERMINAL_SIZE: u16 = 2;
const MAX_TERMINAL_SIZE: u16 = 500;
const MAX_INPUT_BYTES: usize = 64 * 1024;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Clone, Default)]
struct Plugin {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputParams {
    session_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeParams {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "terminal/start" => self.start(parse_params(params)?, emitter),
            "terminal/input" => self.input(parse_params(params)?),
            "terminal/resize" => self.resize(parse_params(params)?),
            "terminal/close" => self.close(parse_params(params)?),
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

impl Plugin {
    fn start(&self, params: StartParams, emitter: &PluginEmitter) -> Result<Value, PluginError> {
        validate_session_id(&params.session_id)?;
        validate_size(params.cols, params.rows)?;

        if self.sessions()?.contains_key(&params.session_id) {
            return Err(plugin_error(
                "A terminal with this session ID is already running",
            ));
        }

        let shell = platform_shell();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(params.cols, params.rows))
            .map_err(|error| plugin_error(format!("Failed to create terminal: {error}")))?;

        let mut command = CommandBuilder::new(&shell.program);
        command.args(shell.args.iter());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(home) = home_directory() {
            command.cwd(home);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| plugin_error(format!("Failed to start shell: {error}")))?;
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| plugin_error(format!("Failed to open terminal output: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| plugin_error(format!("Failed to open terminal input: {error}")))?;

        self.sessions()?.insert(
            params.session_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                killer,
            },
        );

        let output_session_id = params.session_id.clone();
        let output_emitter = emitter.clone();
        thread::Builder::new()
            .name(format!("terminal-output-{}", short_id(&output_session_id)))
            .spawn(move || {
                let mut buffer = [0_u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => {
                            if output_emitter
                                .event(
                                    "terminal/output",
                                    json!({
                                        "sessionId": output_session_id,
                                        "dataBase64": BASE64.encode(&buffer[..length]),
                                    }),
                                )
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error)
                            if error.kind() == std::io::ErrorKind::BrokenPipe
                                || error.raw_os_error() == Some(109) =>
                        {
                            break;
                        }
                        Err(error) => {
                            let _ = output_emitter.event(
                                "terminal/error",
                                json!({
                                    "sessionId": output_session_id,
                                    "message": format!("Terminal output failed: {error}"),
                                }),
                            );
                            break;
                        }
                    }
                }
            })
            .map_err(|error| plugin_error(format!("Failed to start output reader: {error}")))?;

        let sessions = Arc::clone(&self.sessions);
        let wait_session_id = params.session_id.clone();
        let wait_emitter = emitter.clone();
        thread::Builder::new()
            .name(format!("terminal-wait-{}", short_id(&wait_session_id)))
            .spawn(move || match child.wait() {
                Ok(status) => {
                    if let Ok(mut sessions) = sessions.lock() {
                        sessions.remove(&wait_session_id);
                    }
                    let _ = wait_emitter.event(
                        "terminal/exit",
                        json!({
                            "sessionId": wait_session_id,
                            "exitCode": status.exit_code(),
                            "signal": status.signal(),
                        }),
                    );
                }
                Err(error) => {
                    if let Ok(mut sessions) = sessions.lock() {
                        sessions.remove(&wait_session_id);
                    }
                    let _ = wait_emitter.event(
                        "terminal/error",
                        json!({
                            "sessionId": wait_session_id,
                            "message": format!("Failed to wait for shell: {error}"),
                        }),
                    );
                }
            })
            .map_err(|error| plugin_error(format!("Failed to monitor shell: {error}")))?;

        Ok(json!({
            "sessionId": params.session_id,
            "shell": shell.label,
            "cols": params.cols,
            "rows": params.rows,
        }))
    }

    fn input(&self, params: InputParams) -> Result<Value, PluginError> {
        validate_session_id(&params.session_id)?;
        if params.data.len() > MAX_INPUT_BYTES {
            return Err(invalid_params("Terminal input exceeds 64 KiB"));
        }

        let mut sessions = self.sessions()?;
        let session = sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| plugin_error("Terminal session is not running"))?;
        session
            .writer
            .write_all(params.data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|error| plugin_error(format!("Failed to write terminal input: {error}")))?;
        Ok(json!({ "accepted": true }))
    }

    fn resize(&self, params: ResizeParams) -> Result<Value, PluginError> {
        validate_session_id(&params.session_id)?;
        validate_size(params.cols, params.rows)?;

        let sessions = self.sessions()?;
        let session = sessions
            .get(&params.session_id)
            .ok_or_else(|| plugin_error("Terminal session is not running"))?;
        session
            .master
            .resize(pty_size(params.cols, params.rows))
            .map_err(|error| plugin_error(format!("Failed to resize terminal: {error}")))?;
        Ok(json!({ "cols": params.cols, "rows": params.rows }))
    }

    fn close(&self, params: SessionParams) -> Result<Value, PluginError> {
        validate_session_id(&params.session_id)?;
        let session = self.sessions()?.remove(&params.session_id);
        let Some(mut session) = session else {
            return Ok(json!({ "closed": false }));
        };

        // portable-pty 0.9's Windows clone_killer reverses TerminateProcess's
        // success check. The session is already detached, so termination is
        // intentionally best effort on every platform.
        let _ = session.killer.kill();
        Ok(json!({ "closed": true }))
    }

    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<String, TerminalSession>>, PluginError> {
        self.sessions
            .lock()
            .map_err(|_| plugin_error("Terminal session state is unavailable"))
    }
}

struct ShellCommand {
    program: String,
    args: Vec<String>,
    label: String,
}

#[cfg(windows)]
fn platform_shell() -> ShellCommand {
    ShellCommand {
        program: "powershell.exe".to_string(),
        args: vec!["-NoLogo".to_string()],
        label: "PowerShell".to_string(),
    }
}

#[cfg(not(windows))]
fn platform_shell() -> ShellCommand {
    let configured = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty() && std::path::Path::new(value).is_file());
    #[cfg(target_os = "macos")]
    let fallback = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    let fallback = if std::path::Path::new("/bin/bash").is_file() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };
    let program = configured.unwrap_or_else(|| fallback.to_string());
    let label = std::path::Path::new(&program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Shell")
        .to_string();
    ShellCommand {
        program,
        args: Vec::new(),
        label,
    }
}

fn home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";
    env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, PluginError> {
    serde_json::from_value(params)
        .map_err(|error| invalid_params(format!("Invalid terminal parameters: {error}")))
}

fn validate_session_id(session_id: &str) -> Result<(), PluginError> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(invalid_params("Session ID is invalid"))
    }
}

fn validate_size(cols: u16, rows: u16) -> Result<(), PluginError> {
    if (MIN_TERMINAL_SIZE..=MAX_TERMINAL_SIZE).contains(&cols)
        && (MIN_TERMINAL_SIZE..=MAX_TERMINAL_SIZE).contains(&rows)
    {
        Ok(())
    } else {
        Err(invalid_params(
            "Terminal rows and columns must be between 2 and 500",
        ))
    }
}

fn short_id(session_id: &str) -> &str {
    &session_id[..session_id.len().min(12)]
}

fn invalid_params(message: impl Into<String>) -> PluginError {
    PluginError::new(-32602, message)
}

fn plugin_error(message: impl Into<String>) -> PluginError {
    PluginError::new(-32000, message)
}

fn main() -> std::io::Result<()> {
    PluginServer::new(
        PluginMetadata::new(PLUGIN_ID, PLUGIN_VERSION).with_capability("terminal.pty"),
        Plugin::default(),
    )
    .serve()
}

#[cfg(test)]
mod tests {
    use super::{validate_session_id, validate_size};

    #[test]
    fn accepts_browser_generated_session_ids() {
        assert!(validate_session_id("terminal-123e4567-e89b-12d3-a456-426614174000").is_ok());
    }

    #[test]
    fn rejects_unsafe_or_oversized_session_ids() {
        assert!(validate_session_id("../terminal").is_err());
        assert!(validate_session_id(&"a".repeat(129)).is_err());
    }

    #[test]
    fn validates_terminal_dimensions() {
        assert!(validate_size(80, 24).is_ok());
        assert!(validate_size(1, 24).is_err());
        assert!(validate_size(80, 501).is_err());
    }
}
