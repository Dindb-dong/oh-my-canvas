//! Credential-free profile preference for FigCraft-compatible server commands.
use super::*;
use omc_workspace::ProfilePreferences;

const DEFAULT_SERVER: &str = ProfilePreferences::DEFAULT_PUBLISH_SERVER;

pub fn normalize_figcraft_endpoint(address: &str) -> Result<reqwest::Url> {
    let invalid = || EngineError::invalid("server must be a ws:// or wss:// endpoint");
    let address = address.trim();
    let (scheme, rest) = address.split_once("://").ok_or_else(invalid)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if address.len() > 2048
        || address.chars().any(char::is_whitespace)
        || !matches!(scheme.to_ascii_lowercase().as_str(), "ws" | "wss")
        || authority.is_empty()
        || authority.contains('@')
    {
        return Err(invalid());
    }
    let mut parsed = reqwest::Url::parse(address).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "ws" | "wss")
        || parsed.host_str().is_none()
        || parsed.port() == Some(0)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || address.contains('\\')
    {
        return Err(invalid());
    }
    let path = parsed.path();
    if path.len() > 256
        || !path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~')
        })
    {
        return Err(invalid());
    }
    if !path.ends_with('/') {
        parsed.set_path(&format!("{path}/"));
    }
    Ok(parsed)
}

impl ToolRouter {
    pub fn fig_resolve_publish_server(&self, explicit: Option<&str>) -> Result<String> {
        if let Some(server) = explicit.map(str::trim).filter(|server| !server.is_empty()) {
            return Ok(server.to_owned());
        }
        let server = self.workspace.preferences().publish_server;
        if server.is_empty() {
            return Err(EngineError::invalid(
                "Online sharing is disabled in the FigCraft server preference",
            ));
        }
        Ok(normalize_figcraft_endpoint(&server)?.into())
    }

    pub(super) fn fig_set_publish_server(&self, params: &Value) -> Result<Value> {
        schema::check(
            &json!({"type":"object","properties":{"url":{"type":"string","maxLength":2048}},"additionalProperties":false}),
            params,
            "params",
        )?;
        let url = match params["url"].as_str().map(str::trim) {
            None => DEFAULT_SERVER.to_owned(),
            Some("") => String::new(),
            Some(url) => normalize_figcraft_endpoint(url)?.into(),
        };
        self.workspace.update_preference(|preferences| {
            preferences.publish_server = url;
            json!({"url":preferences.publish_server,"default":DEFAULT_SERVER})
        })
    }
}
