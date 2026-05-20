use crate::GatewayError;
use axum::http;
use serde_json::json;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const SYSTEM_UPDATE_COMMAND_ENV: &str = "AETHER_SYSTEM_UPDATE_COMMAND";
const SYSTEM_UPDATE_WORKDIR_ENV: &str = "AETHER_SYSTEM_UPDATE_WORKDIR";

static SYSTEM_UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

/// RAII guard that resets [`SYSTEM_UPDATE_RUNNING`] on drop.
struct SystemUpdateGuard;

impl SystemUpdateGuard {
    fn try_acquire() -> Option<Self> {
        if SYSTEM_UPDATE_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for SystemUpdateGuard {
    fn drop(&mut self) {
        SYSTEM_UPDATE_RUNNING.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn build_admin_system_update_capability_payload() -> serde_json::Value {
    let status = system_update_status();
    json!({
        "enabled": status.enabled,
        "command_env": SYSTEM_UPDATE_COMMAND_ENV,
        "workdir_env": SYSTEM_UPDATE_WORKDIR_ENV,
        "command": status.command,
        "workdir": status.workdir,
        "detail": status.detail,
        "message": if status.enabled {
            "一键更新已启用"
        } else {
            status.detail.as_deref().unwrap_or("未配置一键更新命令")
        },
    })
}

pub(crate) async fn prepare_admin_system_update_task(
) -> Result<Result<serde_json::Value, (http::StatusCode, serde_json::Value)>, GatewayError> {
    let (command, workdir) = match prepare_system_update_command(&["--prepare"]) {
        Ok(command) => command,
        Err(response) => return Ok(Err(response)),
    };
    let Some(guard) = SystemUpdateGuard::try_acquire() else {
        return Ok(Err(update_already_running_response()));
    };

    let result = tokio::task::spawn_blocking(move || run_system_update_command(&command, workdir))
        .await
        .map_err(|err| err.to_string())
        .and_then(|inner| inner);
    drop(guard);

    match result {
        Ok(()) => Ok(Ok(json!({
            "message": "更新包已下载完成，点击“立即重启”完成安装",
            "started": true,
            "need_restart": true,
        }))),
        Err(err) => Ok(Err((
            http::StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "detail": err }),
        ))),
    }
}

pub(crate) async fn start_admin_system_update_task(
) -> Result<Result<serde_json::Value, (http::StatusCode, serde_json::Value)>, GatewayError> {
    let (command, workdir) = match prepare_system_update_command(&["--no-pull", "--force-recreate"])
    {
        Ok(command) => command,
        Err(response) => return Ok(Err(response)),
    };

    let Some(guard) = SystemUpdateGuard::try_acquire() else {
        return Ok(Err(update_already_running_response()));
    };

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let result =
            tokio::task::spawn_blocking(move || run_system_update_command(&command, workdir))
                .await
                .map_err(|err| err.to_string())
                .and_then(|inner| inner);
        if let Err(err) = result {
            tracing::error!(error = %err, "admin system one-click update failed");
        }
        drop(guard);
    });

    Ok(Ok(json!({
        "message": "一键重启已启动，服务会在重建 app 容器后短暂不可用",
        "started": true,
        "need_restart": true,
    })))
}

fn prepare_system_update_command(
    args: &[&str],
) -> Result<(String, Option<String>), (http::StatusCode, serde_json::Value)> {
    let status = system_update_status();
    let Some(command) = status.command else {
        return Err(missing_update_command_response());
    };
    if !status.enabled {
        return Err((
            http::StatusCode::PRECONDITION_REQUIRED,
            json!({
                "detail": status.detail.unwrap_or_else(|| "一键更新运行时不可用".to_string()),
            }),
        ));
    }
    Ok((append_command_args(&command, args), status.workdir))
}

fn missing_update_command_response() -> (http::StatusCode, serde_json::Value) {
    (
        http::StatusCode::PRECONDITION_REQUIRED,
        json!({
            "detail": format!(
                "未配置一键更新命令。请在部署环境中设置 {SYSTEM_UPDATE_COMMAND_ENV}，例如 /opt/aether/compose/update.sh"
            ),
        }),
    )
}

fn update_already_running_response() -> (http::StatusCode, serde_json::Value) {
    (
        http::StatusCode::CONFLICT,
        json!({ "detail": "已有一键更新任务正在执行" }),
    )
}

fn append_command_args(command: &str, args: &[&str]) -> String {
    if args.is_empty() {
        return command.to_string();
    }
    format!("{} {}", command, args.join(" "))
}

fn system_update_command() -> Option<String> {
    std::env::var(SYSTEM_UPDATE_COMMAND_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn system_update_workdir() -> Option<String> {
    std::env::var(SYSTEM_UPDATE_WORKDIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug)]
struct SystemUpdateStatus {
    enabled: bool,
    command: Option<String>,
    workdir: Option<String>,
    detail: Option<String>,
}

fn system_update_status() -> SystemUpdateStatus {
    let command = system_update_command();
    let workdir = system_update_workdir();
    let detail = validate_system_update_runtime(command.as_deref(), workdir.as_deref()).err();
    SystemUpdateStatus {
        enabled: command.is_some() && detail.is_none(),
        command,
        workdir,
        detail,
    }
}

fn validate_system_update_runtime(
    command: Option<&str>,
    workdir: Option<&str>,
) -> Result<(), String> {
    let Some(command) = command else {
        return Err(format!(
            "未配置一键更新命令。请设置 {SYSTEM_UPDATE_COMMAND_ENV}"
        ));
    };
    let command_path = first_command_token(command);
    let path = Path::new(&command_path);
    if !path.is_file() {
        return Err(format!("一键更新命令路径不可访问: {command_path}"));
    }

    if let Some(workdir) = workdir {
        let path = Path::new(workdir);
        if !path.is_dir() {
            return Err(format!("一键更新工作目录不可访问: {workdir}"));
        }
    }

    Ok(())
}

fn first_command_token(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .unwrap_or(command)
        .trim_matches(['"', '\''])
        .to_string()
}

fn run_system_update_command(command: &str, workdir: Option<String>) -> Result<(), String> {
    validate_system_update_runtime(Some(command), workdir.as_deref())?;

    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = Command::new("sh");
        process.arg("-c").arg(command);
        process
    };

    if let Some(workdir) = workdir {
        process.current_dir(workdir);
    }

    let output = process
        .output()
        .map_err(|err| format!("启动一键更新命令失败: {err}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = stderr
        .trim()
        .split('\n')
        .next()
        .filter(|line| !line.trim().is_empty())
        .or_else(|| stdout.trim().split('\n').next())
        .unwrap_or("更新命令执行失败");
    Err(format!("一键更新命令退出状态 {}: {detail}", output.status))
}
