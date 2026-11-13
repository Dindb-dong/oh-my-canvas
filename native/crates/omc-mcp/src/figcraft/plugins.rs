use super::*;
use base64::engine::general_purpose::STANDARD;
use omc_plugin::{
    manifest::{Access, MANIFEST_FILE, Manifest, Panel, ParamKind},
    sandbox::{Host, Instance, Limits, RunOutput, UiChange, check_module},
};
use serde_json::Map;
use std::{io::Read, path::PathBuf};
pub(super) mod widgets;
pub(crate) mod directory;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("plugin.directory.list", "Browse plugin directory", false, "server?, query?"),
    ("plugin.directory.install", "Install plugin from directory", false, "id, version?, confirm, server?, sha256?"),
    ("plugin.directory.publish", "Publish plugin to directory", false, "path | plugin, server"),
    ("plugin.directory.unpublish", "Unpublish plugin from directory", false, "id, version?, server"),
    ("plugin.list", "List plugins", false, ""),
    ("plugins.manage", "Manage plugins", false, ""),
    (
        "plugin.import",
        "Import plugin",
        false,
        "path | manifest, wasm",
    ),
    ("plugin.remove", "Remove plugin", false, "id"),
    (
        "plugin.run",
        "Run plugin",
        false,
        "id, command?, params?, fuel?",
    ),
    ("plugins.runLast", "Run last plugin", false, ""),
    ("plugin.ui", "Plugin panel", false, "id?"),
    (
        "plugin.event",
        "Use plugin panel control",
        false,
        "id, control, value?",
    ),
    ("plugin.close", "Close plugin panel", false, "id"),
];

#[derive(Default)]
pub(crate) struct Plugins {
    installed: BTreeMap<String, Plugin>,
    panels: Vec<OpenPanel>,
    last: Option<(String, String, Value)>,
    settings: BTreeMap<String, BTreeMap<String, String>>,
    directory: Option<String>,
}

struct Plugin {
    manifest: Manifest,
    wasm: Vec<u8>,
    path: Option<PathBuf>,
    directory_assets: Vec<directory::Asset>,
}

struct OpenPanel {
    id: String,
    document: String,
    command: String,
    params: Value,
    panel: Panel,
    values: Map<String, Value>,
    instance: Option<Instance>,
}

impl OpenPanel {
    fn describe(&self) -> Value {
        json!({"plugin":self.id,"command":self.command,"title":self.panel.title,
            "controls":self.panel.controls,"values":self.values})
    }
}

fn limits(fuel: Option<u64>) -> Limits {
    Limits {
        fuel: fuel.unwrap_or(25_000_000).min(25_000_000),
        module_bytes: 2 * 1024 * 1024,
        max_calls: 100,
        max_message: 512 * 1024,
        ..Limits::default()
    }
}

fn read_bounded(path: &std::path::Path, limit: usize) -> Result<Vec<u8>> {
    if !std::fs::metadata(path).map_err(plugin_error)?.is_file() {
        return Err(EngineError::invalid("plugin input must be a regular file"));
    }
    let input = std::fs::File::open(path).map_err(plugin_error)?;
    if !input.metadata().map_err(plugin_error)?.is_file() {
        return Err(EngineError::invalid("plugin input must be a regular file"));
    }
    let mut bytes = Vec::new();
    input
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(plugin_error)?;
    if bytes.len() > limit {
        return Err(EngineError::new(
            "resource_limit",
            "plugin input exceeds byte limit",
        ));
    }
    Ok(bytes)
}

fn plugin_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::invalid(error.to_string())
}

impl Plugin {
    fn load(params: &Value) -> Result<Self> {
        let cap = limits(None).module_bytes;
        let (manifest, wasm, path) = if let Some(path) = params["path"].as_str() {
            if params.get("manifest").is_some() || params.get("wasm").is_some() {
                return Err(EngineError::invalid("pass path or manifest and wasm"));
            }
            let path = PathBuf::from(path);
            let file = if path.is_dir() {
                path.join(MANIFEST_FILE)
            } else {
                path
            };
            let file = file.canonicalize().map_err(plugin_error)?;
            let base = file
                .parent()
                .ok_or_else(|| EngineError::invalid("plugin folder required"))?;
            let manifest = read_bounded(&file, omc_plugin::manifest::MAX_MANIFEST_BYTES)?;
            let manifest = Manifest::parse(std::str::from_utf8(&manifest).map_err(plugin_error)?)
                .map_err(plugin_error)?;
            let module = base
                .join(&manifest.main)
                .canonicalize()
                .map_err(plugin_error)?;
            if !module.starts_with(base) {
                return Err(EngineError::invalid("plugin module escapes its folder"));
            }
            (manifest, read_bounded(&module, cap)?, Some(file))
        } else {
            let manifest = match &params["manifest"] {
                Value::String(text) => Manifest::parse(text),
                value => Manifest::from_value(value),
            }
            .map_err(plugin_error)?;
            let encoded = string(params, "wasm")?;
            if encoded.len() > cap.div_ceil(3) * 4 {
                return Err(EngineError::new(
                    "resource_limit",
                    "plugin module exceeds 2 MiB",
                ));
            }
            (
                manifest,
                STANDARD.decode(encoded).map_err(plugin_error)?,
                None,
            )
        };
        check_module(&wasm, &limits(None)).map_err(plugin_error)?;
        Ok(Self {
            manifest,
            wasm,
            path,
            directory_assets: Vec::new(),
        })
    }

    fn describe(&self) -> Value {
        let mut row = json!(self.manifest);
        row["path"] = json!(self.path);
        row["loaded"] = json!(true);
        row
    }
}

struct PluginHost<'a> {
    router: &'a ToolRouter,
    session: &'a str,
    root: &'a str,
    manifest: &'a Manifest,
    snapshot: DocumentSnapshot,
    selection: Vec<Value>,
    commands: Vec<Command>,
    settings: BTreeMap<String, String>,
    changed_selection: bool,
}

impl Host for PluginHost<'_> {
    fn call(&mut self, command: &str, params: &str) -> std::result::Result<String, String> {
        if !self.manifest.permissions.allows(command) {
            return Err("command is outside the plugin allowlist".into());
        }
        let params: Value = omc_protocol::decode_json_with_limit(params.as_bytes(), 512 * 1024)
            .map_err(|error| error.message)?;
        if !params.is_object() {
            return Err("command params must be an object".into());
        }
        let result = match command {
            "select.get" => Ok(json!({"ids":self.selection})),
            "node.get" => {
                let id = self
                    .router
                    .fig_layer(self.session, &self.snapshot, &params["id"])
                    .map_err(|error| error.message)?;
                let depth = params["depth"].as_u64().unwrap_or(1).min(12) as usize;
                Ok(self.router.fig_node(
                    self.session,
                    &self.snapshot,
                    self.snapshot.nodes.get(&id).ok_or("unknown plugin layer")?,
                    depth,
                    &mut 200,
                ))
            }
            "select.set" => {
                let raw = self
                    .router
                    .fig_layers(
                        self.session,
                        &self.snapshot,
                        params["ids"].as_array().ok_or("ids must be an array")?,
                    )
                    .map_err(|error| error.message)?;
                self.selection = raw
                    .iter()
                    .map(|id| json!(self.router.fig_alias(self.session, &self.snapshot.id, id)))
                    .collect();
                self.changed_selection = true;
                Ok(json!({"ids":self.selection}))
            }
            "node.create" | "node.set" | "frame.create" | "shape.rectangle" | "shape.ellipse"
            | "text.create"
                if self.manifest.permissions.access == Access::Write =>
            {
                let mut params = params;
                let command = match command {
                    "node.create" | "node.set" => command,
                    kind => {
                        params["type"] = json!(match kind {
                            "frame.create" => "frame",
                            "shape.rectangle" => "rectangle",
                            "shape.ellipse" => "ellipse",
                            _ => "text",
                        });
                        "node.create"
                    }
                };
                if self.commands.len() >= 100 {
                    return Err("plugin edit exceeds 100 operations".into());
                }
                let mut candidate = self.snapshot.clone();
                let mut selected = self.selection.clone();
                let mut commands = Vec::new();
                let value = self
                    .router
                    .fig_edit(
                        self.session,
                        self.root,
                        &mut candidate,
                        &mut selected,
                        &mut commands,
                        command,
                        &params,
                    )
                    .map_err(|error| error.message)?;
                if self
                    .commands
                    .iter()
                    .chain(&commands)
                    .map(Command::operation_count)
                    .sum::<usize>()
                    > 100
                {
                    return Err("plugin edit exceeds 100 operations".into());
                }
                self.snapshot = candidate;
                self.changed_selection |= self.selection != selected;
                self.selection = selected;
                self.commands.extend(commands);
                Ok(value)
            }
            _ => Err(EngineError::invalid(
                "command is unavailable to this plugin",
            )),
        }
        .map_err(|error| error.message)?;
        Ok(result.to_string())
    }

    fn selection(&mut self) -> String {
        json!(self.selection).to_string()
    }
    fn notify(&mut self, _message: &str) {}
    fn setting(&mut self, key: &str) -> Option<String> {
        self.settings.get(key).cloned()
    }
    fn set_setting(&mut self, key: &str, value: Option<&str>) -> std::result::Result<(), String> {
        if key.is_empty() || key.len() > 128 {
            return Err("invalid setting key".into());
        }
        if let Some(value) = value {
            if value.len() > 4096 || (self.settings.len() >= 64 && !self.settings.contains_key(key))
            {
                return Err("plugin settings exceed limit".into());
            }
            serde_json::from_str::<Value>(value).map_err(|_| "plugin setting is not JSON")?;
            self.settings.insert(key.to_owned(), value.to_owned());
        } else {
            self.settings.remove(key);
        }
        Ok(())
    }
}

impl ToolRouter {
    pub(super) fn fig_plugins_command(
        &self,
        session: &str,
        name: &str,
        args: &Value,
        params: &Value,
    ) -> Result<Value> {
        let id_schema = json!({"type":"string","minLength":1,"maxLength":128});
        let fields = match name {
            "plugin.import" => {
                json!({"path":{"type":"string"},"manifest":{},"wasm":{"type":"string"}})
            }
            "plugin.run" => {
                json!({"id":id_schema,"command":id_schema,"params":{"type":"object"},"fuel":{"type":"integer","minimum":1}})
            }
            "plugin.event" => json!({"id":id_schema,"control":id_schema,"value":{}}),
            "plugin.ui" | "plugin.close" | "plugin.remove" => json!({"id":id_schema}),
            _ => json!({}),
        };
        schema::check(
            &json!({"type":"object","properties":fields,"additionalProperties":false}),
            params,
            "params",
        )?;
        let state = self
            .fig_plugins
            .lock()
            .unwrap()
            .entry(session.to_owned())
            .or_default()
            .clone();
        let mut state = state.lock().unwrap();
        let id = params["id"].as_str();
        match name {
            "plugin.list" | "plugins.manage" => {
                return Ok(
                    json!({"plugins":state.installed.values().map(Plugin::describe).collect::<Vec<_>>(),
                "last":state.last.as_ref().map(|(id,command,_)|json!({"id":id,"command":command}))}),
                );
            }
            "plugin.import" => {
                let plugin = Plugin::load(params)?;
                let id = plugin.manifest.id.clone();
                if state.installed.len() >= 16 && !state.installed.contains_key(&id) {
                    return Err(EngineError::new(
                        "resource_limit",
                        "at most 16 plugins per MCP session",
                    ));
                }
                let row = plugin.describe();
                state.panels.retain(|panel| panel.id != id);
                let replaced = state.installed.insert(id.clone(), plugin).is_some();
                return Ok(json!({"id":id,"imported":row,"replaced":replaced}));
            }
            "plugin.remove" => {
                let id = string(params, "id")?;
                state.panels.retain(|panel| panel.id != id);
                state.settings.remove(id);
                return Ok(json!({"removed":state.installed.remove(id).is_some()}));
            }
            "plugin.ui" => {
                return Ok(state
                    .panels
                    .iter()
                    .rev()
                    .find(|panel| id.is_none_or(|id| id == panel.id))
                    .map(OpenPanel::describe)
                    .unwrap_or_default());
            }
            "plugin.close" => {
                let id = string(params, "id")?;
                let count = state.panels.len();
                state.panels.retain(|panel| panel.id != id);
                return Ok(json!({"closed":count != state.panels.len()}));
            }
            _ => {}
        }
        let document = self.workspace.target(
            session,
            args["document"]
                .as_str()
                .map(native_id)
                .transpose()?
                .as_deref(),
        )?;
        let snapshot = self.workspace.snapshot(&document)?;
        let view = self.state(session, &document)?;
        let selection = view.view["selection"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut panel = None;
        let (id, command, values, fuel, callback) = match name {
            "plugin.run" => (
                string(params, "id")?.to_owned(),
                params["command"].as_str().map(str::to_owned),
                params.get("params").cloned().unwrap_or_else(|| json!({})),
                params["fuel"].as_u64(),
                None,
            ),
            "plugins.runLast" => {
                let (id, command, values) = state
                    .last
                    .clone()
                    .ok_or_else(|| EngineError::invalid("no plugin has run yet"))?;
                (id, Some(command), values, None, None)
            }
            "plugin.event" => {
                let id = string(params, "id")?;
                let control = string(params, "control")?;
                let index = state
                    .panels
                    .iter()
                    .position(|panel| panel.id == id && panel.document == document)
                    .ok_or_else(|| EngineError::invalid("plugin has no panel for this document"))?;
                let open = &state.panels[index];
                let field = open
                    .panel
                    .control(control)
                    .filter(|control| !matches!(control.kind, ParamKind::Note | ParamKind::Image))
                    .ok_or_else(|| EngineError::invalid("unknown plugin panel control"))?;
                let is_field = field.is_field();
                let value = if is_field {
                    field.coerce(&params["value"]).map_err(plugin_error)?
                } else {
                    Value::Null
                };
                let mut open = state.panels.remove(index);
                if is_field {
                    open.values.insert(control.to_owned(), value.clone());
                }
                let input = json!({"event":{"control":control,"value":value},"values":open.values});
                let call = (
                    id.to_owned(),
                    Some(open.command.clone()),
                    open.params.clone(),
                    None,
                    Some(input),
                );
                panel = Some(open);
                call
            }
            _ => return Err(EngineError::invalid("unknown plugin command")),
        };
        let plugin = state
            .installed
            .get(&id)
            .ok_or_else(|| EngineError::invalid("plugin is not installed"))?;
        let manifest = plugin.manifest.clone();
        let command = manifest
            .command(command.as_deref())
            .ok_or_else(|| EngineError::invalid("unknown command in plugin manifest"))?;
        let values = command.resolve_params(&values).map_err(plugin_error)?;
        let mut input =
            json!({"api":manifest.api,"command":command.id,"params":values,"selection":selection});
        if let Some(callback) = callback {
            input["event"] = callback["event"].clone();
            input["values"] = callback["values"].clone();
        }
        let original = snapshot.sequence;
        let mut host = PluginHost {
            router: self,
            session,
            root: &view.root,
            manifest: &manifest,
            snapshot,
            selection,
            commands: vec![],
            settings: state.settings.get(&id).cloned().unwrap_or_default(),
            changed_selection: false,
        };
        let mut instance = if let Some(open) = panel.as_mut() {
            open.instance
                .take()
                .ok_or_else(|| EngineError::invalid("plugin panel is closed"))?
        } else {
            Instance::new(&plugin.wasm, &limits(fuel)).map_err(plugin_error)?
        };
        let out = instance
            .call(&input.to_string(), &mut host)
            .map_err(plugin_error)?;
        if !host.commands.is_empty() {
            self.submit(
                session,
                &document,
                Command::Batch {
                    commands: host.commands,
                },
                &Value::Null,
                Some(original),
            )?;
        }
        if host.changed_selection {
            self.fig_selection(&(session.to_owned(), document.clone()), &host.selection);
        }
        state.settings.insert(id.clone(), host.settings);
        if name != "plugin.event" {
            state.last = Some((id.clone(), command.id.clone(), values.clone()));
        }
        let RunOutput {
            output,
            logs,
            calls,
            fuel,
            ui,
            ..
        } = out;
        match ui {
            Some(UiChange::Show(new)) if manifest.api >= 2 => {
                let fields = new.values(
                    &panel
                        .as_ref()
                        .map(|open| open.values.clone())
                        .unwrap_or_default(),
                );
                state.panels.retain(|open| open.id != id);
                if state.panels.len() == 4 {
                    state.panels.remove(0);
                }
                state.panels.push(OpenPanel {
                    id: id.clone(),
                    document,
                    command: command.id.clone(),
                    params: values,
                    panel: new,
                    values: fields,
                    instance: Some(instance),
                });
            }
            Some(UiChange::Close) => state.panels.retain(|open| open.id != id),
            _ => {
                if let Some(mut open) = panel {
                    open.instance = Some(instance);
                    state.panels.push(open);
                }
            }
        }
        let output = serde_json::from_str::<Value>(&output).unwrap_or(Value::String(output));
        Ok(
            json!({"plugin":id,"command":command.id,"output":output,"logs":logs,"calls":calls,"fuel":fuel,
            "panel":state.panels.iter().find(|panel|panel.id==id).map(OpenPanel::describe)}),
        )
    }
}
