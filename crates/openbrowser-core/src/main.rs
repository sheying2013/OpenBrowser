use openbrowser_core::error::{CoreError, Result};
use openbrowser_core::process::{FileLock, ProcessLock};
use openbrowser_core::proxy::{FailClosedPolicy, LocalProxyBridge, ProxyConfig, ProxyForwarder};
use openbrowser_core::sync::{ScreenBounds, TileGridLayout};
use openbrowser_core::tls::{ClientHelloBuilder, TlsProfile};
use serde_json::json;
use std::io::{BufRead, Read, Write};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

const CONTROL_PROTOCOL: u32 = 1;
const MAX_CONTROL_LINE: usize = 65_536;

fn invalid(message: &str) -> CoreError {
    CoreError::InvalidConfig(message.to_owned())
}

// One bounded line is a configuration or control frame, never an argv credential.
// A dedicated OS thread avoids uncancellable Tokio stdin reads delaying runtime shutdown.
fn control_lines() -> mpsc::Receiver<Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel(8);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let mut frame = Vec::new();
            let read = (&mut reader)
                .take((MAX_CONTROL_LINE + 1) as u64)
                .read_until(b'\n', &mut frame);
            match read {
                Ok(0) => break,
                Ok(_) if frame.len() > MAX_CONTROL_LINE => {
                    let _ = tx.blocking_send(Err(invalid("Control frame exceeds 64 KiB")));
                    break;
                }
                Ok(_) => {
                    if tx.blocking_send(Ok(frame)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.blocking_send(Err(error.into()));
                    break;
                }
            }
        }
    });
    rx
}

fn emit(value: serde_json::Value) -> Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &value)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, options) = args
        .split_first()
        .ok_or_else(|| invalid("Expected bridge, tls, lock, layout or version"))?;
    match command.as_str() {
        "bridge" => run_bridge(options).await,
        "tls" => run_tls(options),
        "lock" => run_lock(options).await,
        "layout" => run_layout(options),
        "--version" | "-v" | "version" if options.is_empty() => emit(json!({
            "name": "openbrowser-core", "version": env!("CARGO_PKG_VERSION"),
            "control_protocol": CONTROL_PROTOCOL,
            "capabilities": ["http-upstream", "socks5-upstream", "layout-planner", "file-lock"]
        })),
        _ => Err(invalid("Unknown command or unexpected options")),
    }
}

async fn run_bridge(args: &[String]) -> Result<()> {
    if !args.is_empty() {
        return Err(invalid(
            "Bridge configuration must be supplied as one private stdin JSON line",
        ));
    }
    let mut lines = control_lines();
    let first = timeout(Duration::from_secs(10), lines.recv())
        .await?
        .ok_or_else(|| invalid("Missing bridge configuration"))??;
    let config: ProxyConfig = serde_json::from_slice(&first)?;
    let (status_tx, mut statuses) = mpsc::channel(32);
    let bridge =
        LocalProxyBridge::new(config, FailClosedPolicy::default()).with_status_sender(status_tx);
    let address = bridge.start().await?;
    if let Err(error) = emit(json!({
        "status": "listening", "control_protocol": CONTROL_PROTOCOL,
        "host": "127.0.0.1", "port": address.port(), "pid": std::process::id(),
        "chrome_url": format!("http://127.0.0.1:{}", address.port())
    })) {
        bridge.stop().await?;
        return Err(error);
    }
    let control_result = async {
        loop {
            tokio::select! {
                frame = lines.recv() => {
                    let Some(frame) = frame else { break };
                    let frame = frame?;
                    let command = std::str::from_utf8(&frame)
                        .map_err(|_| invalid("Control frame must be UTF-8"))?.trim();
                    if command == "stop" || command == "exit" { break; }
                    return Err(invalid("Unknown bridge control command"));
                }
                Some(code) = statuses.recv() => {
                    emit(json!({"event":"status", "code":code, "message":code}))?;
                }
            }
        }
        Ok(())
    }
    .await;
    bridge.stop().await?;
    control_result?;
    emit(json!({"status": "stopped"}))
}

fn option_pairs(args: &[String], allowed: &[&str]) -> Result<Vec<(String, String)>> {
    if !args.len().is_multiple_of(2) {
        return Err(invalid("Every option requires a value"));
    }
    let mut result = Vec::new();
    for pair in args.as_chunks::<2>().0 {
        if !allowed.contains(&pair[0].as_str()) || result.iter().any(|(key, _)| key == &pair[0]) {
            return Err(invalid("Unknown or duplicate option"));
        }
        result.push((pair[0].clone(), pair[1].clone()));
    }
    Ok(result)
}

fn run_tls(args: &[String]) -> Result<()> {
    let pairs = option_pairs(args, &["--sni"])?;
    let sni = pairs
        .first()
        .map_or("example.com", |(_, value)| value.as_str());
    if sni.is_empty()
        || sni.len() > 253
        || !sni
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err(invalid("Invalid SNI hostname"));
    }
    // Offline inspection only. Browser TLS and HTTPS proxy transport remain unchanged.
    let builder = ClientHelloBuilder::new(TlsProfile::chrome()).server_name(sni);
    let packet = builder.build()?;
    let ja3 = builder.compute_ja3();
    emit(json!({"experimental": true, "transport_integrated": false,
        "ja3": ja3.raw, "ja3_hash": ja3.hash, "ja4": builder.compute_ja4().formatted,
        "client_hello_len": packet.len(), "sni": sni}))
}

async fn run_lock(args: &[String]) -> Result<()> {
    let pairs = option_pairs(args, &["--path"])?;
    let path = pairs
        .first()
        .filter(|(_, value)| !value.is_empty())
        .ok_or_else(|| invalid("Missing --path for lock"))?;
    let mut lock = FileLock::new(&path.1);
    if !lock.try_lock()? {
        emit(json!({"status":"busy", "acquired":false}))?;
        return Err(invalid("Lock already held"));
    }
    emit(json!({"status":"locked", "acquired":true, "pid":std::process::id()}))?;
    let mut lines = control_lines();
    if let Some(frame) = lines.recv().await {
        frame?;
    }
    lock.unlock()?;
    emit(json!({"status":"unlocked"}))
}

fn run_layout(args: &[String]) -> Result<()> {
    let mut screen = ScreenBounds::default();
    let (mut count, mut margin, mut gap) = (4usize, 8u32, 8u32);
    for (key, value) in option_pairs(
        args,
        &[
            "--screen-w",
            "--screen-h",
            "--taskbar",
            "--count",
            "--margin",
            "--gap",
        ],
    )? {
        let number: u32 = value
            .parse()
            .map_err(|_| invalid("Expected an unsigned 32-bit integer"))?;
        match key.as_str() {
            "--screen-w" => screen.width = number,
            "--screen-h" => screen.height = number,
            "--taskbar" => screen.taskbar_height = number,
            "--count" => count = number as usize,
            "--margin" => margin = number,
            "--gap" => gap = number,
            _ => unreachable!(),
        }
    }
    let windows = TileGridLayout::calculate(screen, count, margin, gap)?;
    emit(
        json!({"screen":{"width":screen.width,"height":screen.height,"taskbar":screen.taskbar_height},
        "count":count,"windows":windows}),
    )
}
