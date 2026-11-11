//! Native stdio MCP bridge. No Node or browser runtime is needed.
use clap::Parser;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    path::PathBuf,
    time::{Duration, Instant},
};
#[derive(Parser)]
struct Args {
    #[arg(long)]
    profile: PathBuf,
    #[arg(long)]
    connect_only: bool,
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let descriptor_path = args.profile.join("native-v1/service.json");
    let http = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .no_proxy()
        .build()?;
    let mut descriptor = read_descriptor(&descriptor_path).filter(|d| healthy(&http, d));
    if descriptor.is_none() {
        if args.connect_only {
            return Err("workspace service is unavailable".into());
        }
        let service = std::env::current_exe()?
            .parent()
            .unwrap()
            .join(if cfg!(windows) {
                "omc-service.exe"
            } else {
                "omc-service"
            });
        std::process::Command::new(service)
            .arg("--profile")
            .arg(&args.profile)
            .arg("--port")
            .arg("0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            descriptor = read_descriptor(&descriptor_path).filter(|d| healthy(&http, d));
            if descriptor.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let descriptor = descriptor.ok_or("service startup deadline")?;
    let endpoint = descriptor["endpoint"].as_str().ok_or("endpoint missing")?;
    let token = descriptor["token"].as_str().ok_or("credential missing")?;
    let mut session = None::<String>;
    let input = std::io::stdin();
    let mut reader = input.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = Vec::new();
        if reader
            .by_ref()
            .take(1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?
            == 0
        {
            break;
        }
        if line.len() > 1024 * 1024 {
            return Err("MCP frame exceeds 1 MiB".into());
        }
        let request: Value = serde_json::from_slice(&line)?;
        let mut outgoing = http
            .post(format!("{endpoint}/mcp"))
            .bearer_auth(token)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .header("MCP-Protocol-Version", "2025-06-18")
            .body(line);
        if let Some(session) = &session {
            outgoing = outgoing.header("Mcp-Session-Id", session);
        }
        let response = outgoing.send()?;
        if let Some(id) = response.headers().get("mcp-session-id") {
            session = Some(id.to_str()?.to_owned());
        }
        let status = response.status();
        if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
            continue;
        }
        let result = if status.is_success() {
            response.json::<Value>()?
        } else {
            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":format!("native service HTTP {}",status.as_u16())}})
        };
        serde_json::to_writer(&mut output, &result)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    if let Some(session) = session {
        let _ = http
            .delete(format!("{endpoint}/mcp"))
            .bearer_auth(token)
            .header("Mcp-Session-Id", session)
            .send();
    }
    Ok(())
}
fn read_descriptor(path: &std::path::Path) -> Option<Value> {
    let d: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let endpoint = d["endpoint"].as_str()?;
    if d["protocol"] != "omc.service/1" || !endpoint.starts_with("http://127.0.0.1:") {
        return None;
    }
    Some(d)
}
fn healthy(http: &reqwest::blocking::Client, d: &Value) -> bool {
    http.get(format!("{}/health", d["endpoint"].as_str().unwrap_or("")))
        .bearer_auth(d["token"].as_str().unwrap_or(""))
        .timeout(Duration::from_millis(200))
        .send()
        .is_ok_and(|r| r.status().is_success())
}
