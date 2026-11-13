//! FigCraft catalog commands backed by the native document authority.
pub(crate) mod library_archive;
mod library_ops;
mod library_swap;
pub(crate) mod library_team;
mod variable_io;
pub(crate) mod variable_ops;

use super::*;
use omc_model::{NodeKind, new_id, rank_between};
use std::collections::BTreeSet;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "style.bind",
        "Bind style field to variable",
        true,
        "{style, field, variable?}",
    ),
    (
        "style.move",
        "Move styles",
        true,
        "{styles, before?, folder?}",
    ),
    ("style.list", "List styles", false, "{type?}"),
    (
        "style.create",
        "Create style",
        true,
        "{type, name, from?, description?, value?}",
    ),
    ("style.apply", "Apply style", true, "{ids?, style, target?}"),
    ("style.detach", "Detach style", true, "{ids?, which}"),
    (
        "style.update",
        "Edit style",
        true,
        "{style, name?, description?, value?, from?}",
    ),
    ("style.duplicate", "Duplicate style", true, "{style}"),
    ("style.delete", "Delete style", true, "{style}"),
    (
        "style.renameFolder",
        "Rename style folder",
        true,
        "{folder, name}",
    ),
    (
        "variable.moveMode",
        "Move collection mode",
        true,
        "{collection, mode, to}",
    ),
    (
        "variable.removeMode",
        "Remove collection mode",
        true,
        "{collection, mode}",
    ),
    (
        "variable.setMode",
        "Set collection mode on page or frame",
        true,
        "{ids?, collection, mode}",
    ),
    ("variable.list", "List variables", false, "{}"),
    ("variable.import", "Import variables", true, "{variables}"),
    (
        "variable.export",
        "Export variables",
        false,
        "{collections?, format?, path?}",
    ),
    ("variable.delete", "Delete variable", true, "{variable}"),
    (
        "variable.extendCollection",
        "Extend variable collection",
        true,
        "{collection, name?}",
    ),
    (
        "variable.resetOverride",
        "Reset variable override",
        true,
        "{variable, mode?}",
    ),
    (
        "variable.deleteCollection",
        "Delete variable collection",
        true,
        "{collection}",
    ),
    (
        "variable.createCollection",
        "Create variable collection",
        true,
        "{name, modes?}",
    ),
    (
        "variable.renameCollection",
        "Rename collection",
        true,
        "{collection, name}",
    ),
    (
        "variable.addMode",
        "Add mode",
        true,
        "{collection, name, from?}",
    ),
    (
        "variable.renameMode",
        "Rename mode",
        true,
        "{collection, mode, name}",
    ),
    (
        "variable.create",
        "Create variable",
        true,
        "{collection, name, type, value? | values?, description?}",
    ),
    (
        "variable.set",
        "Set variable value",
        true,
        "{variable, mode?, value}",
    ),
    (
        "variable.update",
        "Edit variable",
        true,
        "{variable, name?, description?, scopes?, hiddenFromPublishing?, codeSyntax?}",
    ),
    (
        "variable.duplicate",
        "Duplicate variable",
        true,
        "{variable}",
    ),
    (
        "variable.bind",
        "Bind variable",
        true,
        "{ids?, field, variable}",
    ),
    ("component.create", "Create component", true, "{ids?}"),
    (
        "component.createMultiple",
        "Create multiple components",
        true,
        "{ids?}",
    ),
    ("component.list", "List components", false, "{}"),
    ("component.goToMain", "Go to main component", false, "{id?}"),
    (
        "component.resetInstance",
        "Reset instance overrides",
        true,
        "{ids?}",
    ),
    ("component.detach", "Detach instance", true, "{ids?}"),
    (
        "instance.create",
        "Create instance",
        true,
        "{component, x?, y?, parent?}",
    ),
    ("instance.swap", "Swap component", true, "{ids?, component}"),
    (
        "instance.place",
        "Place component at a point",
        true,
        "{component, x, y}",
    ),
    (
        "instance.swapAt",
        "Swap instance at a point",
        true,
        "{component, x, y}",
    ),
    (
        "library.publish",
        "Publish library",
        true,
        "{description?, include?, exclude?}",
    ),
    ("library.add", "Add library", true, "{path}"),
    (
        "library.import",
        "Import linked library component",
        true,
        "{library, component}",
    ),
    (
        "library.applyStyle",
        "Apply linked library style",
        true,
        "{library, style, ids?, target?}",
    ),
    (
        "library.importVariable",
        "Import linked library variable",
        true,
        "{library, variable}",
    ),
    (
        "library.bindVariable",
        "Bind linked library variable",
        true,
        "{library, variable, field, ids?}",
    ),
    (
        "library.aliasVariable",
        "Alias linked library variable",
        true,
        "{library, alias, variable, mode?}",
    ),
    (
        "library.setVariableMode",
        "Set linked library variable mode",
        true,
        "{library, collection, mode, ids?}",
    ),
    (
        "library.extendCollection",
        "Extend linked variable collection",
        true,
        "{library, collection, name?}",
    ),
    ("library.swap", "Swap linked libraries", true, "{from, to}"),
    (
        "library.swapAt",
        "Swap instance at a point",
        true,
        "{library, component, x, y}",
    ),
    ("library.updates", "List library updates", false, "{}"),
    (
        "library.check",
        "Check team library updates",
        false,
        "{library?}",
    ),
    (
        "library.publishToServer",
        "Publish a team library",
        true,
        "{server?, key?, include?, exclude?, description?}",
    ),
    (
        "library.usage",
        "Inspect local library usage",
        false,
        "{library?, days?}",
    ),
    (
        "library.acceptUpdates",
        "Accept library updates",
        true,
        "{ids?}",
    ),
    (
        "library.list",
        "List embedded libraries",
        false,
        "{assets?}",
    ),
    (
        "library.remove",
        "Remove embedded library",
        true,
        "{library}",
    ),
    (
        "library.place",
        "Place embedded library component",
        true,
        "{library, component, x?, y?}",
    ),
    (
        "comment.list",
        "List comments",
        false,
        "{page?, filter?, sort?, query?}",
    ),
    ("comment.add", "Add comment", true, "{text, x, y, page?}"),
    ("comment.reply", "Reply to comment", true, "{id, text}"),
    ("comment.edit", "Edit comment", true, "{id, reply?, text}"),
    (
        "comment.resolve",
        "Resolve comment",
        true,
        "{id, resolved?}",
    ),
    ("comment.move", "Move comment", true, "{id, x, y, page?}"),
    ("comment.delete", "Delete comment", true, "{id, reply?}"),
    ("comment.people", "List comment authors", false, "{}"),
    (
        "comment.react",
        "React to comment",
        true,
        "{id, reply?, emoji, on?}",
    ),
    ("comment.link", "Get comment link", false, "{id}"),
];

type Entries = BTreeMap<String, Value>;

pub(super) fn entry<'a>(entries: &'a Entries, reference: &str) -> Result<&'a Value> {
    if let Some(value) = entries.get(reference) {
        return Ok(value);
    }
    let mut matches = entries.values().filter(|value| value["name"] == reference);
    let found = matches
        .next()
        .ok_or_else(|| EngineError::invalid(format!("unknown catalog entry {reference}")))?;
    if matches.next().is_some() {
        return Err(EngineError::invalid(format!(
            "ambiguous catalog name {reference}; use its ID"
        )));
    }
    Ok(found)
}

pub(super) fn catalog(namespace: &str, id: &str, patch: Value) -> Result<Command> {
    let mut patch = properties(&patch)?;
    patch.remove("id");
    Ok(Command::CatalogSet {
        namespace: namespace.into(),
        entity_id: id.into(),
        properties: patch,
    })
}

fn collection_patch(id: &str, value: &Value) -> Result<Command> {
    Ok(Command::DocumentMetadata {
        properties: properties(value)?
            .into_iter()
            .filter(|(key, _)| key != "id")
            .map(|(key, value)| (format!("figcraftCollections/{id}/{key}"), value))
            .collect(),
    })
}

fn name(value: &Value) -> Result<&str> {
    let name = string(value, "name")?.trim();
    if name.is_empty() {
        return Err(EngineError::invalid("name must not be empty"));
    }
    Ok(name)
}

fn unsupported(message: &str) -> EngineError {
    EngineError::new("unsupported_command", message)
}

fn style_fields(which: &str) -> Result<&'static [&'static str]> {
    match which {
        "fill" => Ok(&["fill", "fills"]),
        "stroke" => Ok(&["stroke", "strokes"]),
        "text" => Ok(&[
            "fontFamily",
            "fontSize",
            "fontWeight",
            "fontStyle",
            "color",
            "lineHeight",
            "letterSpacing",
            "textAlign",
        ]),
        "effect" => Ok(&["effects", "shadows", "blur"]),
        _ => Err(unsupported(
            "Native rendering does not support this style target",
        )),
    }
}

fn style_link(which: &str) -> String {
    format!("{which}StyleId")
}

pub(super) fn paint_style<'a>(
    snapshot: &DocumentSnapshot,
    styles: &'a Entries,
    style: &str,
    library: Option<&str>,
) -> Result<&'a Value> {
    let found = if let Some(library) = library {
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        let library = library_ops::library(&libraries, library)?;
        let (key, _) = library_ops::asset(library, "styles", style)?;
        let id = library["styleMap"][key]
            .as_str()
            .ok_or_else(|| EngineError::invalid("Linked style is not installed"))?;
        entry(styles, id)?
    } else {
        entry(styles, style)?
    };
    if found["type"] != "paint" {
        return Err(EngineError::invalid("a color style is required"));
    }
    Ok(found)
}

fn style_target(kind: &str, target: Option<&str>) -> Result<&'static str> {
    match (kind, target) {
        ("paint", None | Some("fill")) => Ok("fill"),
        ("paint", Some("stroke")) => Ok("stroke"),
        ("text", None | Some("text")) => Ok("text"),
        ("effect", None | Some("effect")) => Ok("effect"),
        _ => Err(unsupported(
            "Native rendering does not support this style target",
        )),
    }
}

fn detach_style(
    commands: &mut Vec<Command>,
    snapshot: &DocumentSnapshot,
    node: &Node,
    which: &str,
) -> Result<()> {
    let (effective, _) = omc_style::ReferenceContext::new(snapshot).properties(node);
    let properties: Properties = style_fields(which)?
        .iter()
        .filter_map(|key| {
            effective
                .get(*key)
                .map(|value| ((*key).into(), value.clone()))
        })
        .collect();
    if !properties.is_empty() {
        commands.push(Command::NodeSet {
            node_id: node.id.clone(),
            properties,
        });
    }
    commands.push(Command::NodeUnset {
        node_id: node.id.clone(),
        properties: vec![style_link(which)],
    });
    Ok(())
}

impl ToolRouter {
    pub(super) fn fig_catalog_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        command: &str,
        params: &Value,
    ) -> Result<Value> {
        let (family, action) = command
            .split_once('.')
            .ok_or_else(|| unsupported("Unknown catalog command"))?;
        match family {
            "style" => self.fig_style_command(session, snapshot, selection, action, params),
            "variable" => self.fig_variable_command(session, snapshot, selection, action, params),
            "component" | "instance" => {
                self.fig_component_command(session, snapshot, state, selection, command, params)
            }
            "library" => {
                self.fig_library_command(session, snapshot, state, selection, action, params)
            }
            "comment" => self.fig_comment_command(session, snapshot, state, action, params),
            _ => Err(unsupported("Unknown catalog command")),
        }
    }

    fn catalog_commit(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        mut commands: Vec<Command>,
    ) -> Result<()> {
        let command = match commands.len() {
            0 => return Ok(()),
            1 => commands.pop().unwrap(),
            _ => Command::Batch { commands },
        };
        self.submit(
            session,
            &snapshot.id,
            command,
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        Ok(())
    }

    fn catalog_targets(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        params: &Value,
        selection: &[Value],
    ) -> Result<Vec<String>> {
        let single;
        let ids = if let Some(ids) = params.get("ids") {
            ids.as_array()
                .ok_or_else(|| EngineError::invalid("ids must be an array"))?
        } else if let Some(id) = params.get("id") {
            single = [id.clone()];
            &single[..]
        } else {
            selection
        };
        if ids.is_empty() {
            return Err(EngineError::invalid(
                "Select at least one layer or pass ids",
            ));
        }
        let mut seen = BTreeSet::new();
        ids.iter()
            .map(|id| self.fig_layer(session, snapshot, id))
            .filter(|result| result.as_ref().map_or(true, |id| seen.insert(id.clone())))
            .collect()
    }

    fn fig_style_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        selection: &[Value],
        action: &str,
        params: &Value,
    ) -> Result<Value> {
        let entries = resources::catalogs(&snapshot.metadata, "styles");
        if action == "list" {
            let kind = params["type"].as_str();
            return Ok(json!(
                ordered_styles(&entries)
                    .into_iter()
                    .map(|(_, style)| style)
                    .filter(|style| kind.is_none_or(|kind| style["type"] == kind))
                    .collect::<Vec<_>>()
            ));
        }
        if params.get("start").is_some() || params.get("end").is_some() {
            return Err(unsupported(
                "Text style ranges require native rich-text style references",
            ));
        }
        let mut commands = Vec::new();
        if action == "detach" {
            let target = string(params, "which")?;
            style_fields(target)?;
            for id in self.catalog_targets(session, snapshot, params, selection)? {
                let node = &snapshot.nodes[&id];
                if node.properties.contains_key(&style_link(target)) {
                    detach_style(&mut commands, snapshot, node, target)?;
                }
            }
            self.catalog_commit(session, snapshot, commands)?;
            return Ok(json!({"ok":true}));
        }
        if action == "move" {
            let ids = params["styles"]
                .as_array()
                .filter(|ids| !ids.is_empty())
                .ok_or_else(|| EngineError::invalid("Pass at least one style ID"))?;
            let mut picked = BTreeSet::new();
            for id in ids {
                let style = entry(
                    &entries,
                    id.as_str()
                        .ok_or_else(|| EngineError::invalid("Expected style ID"))?,
                )?;
                if style["libraryId"].is_string() {
                    return Err(EngineError::invalid("Library styles are read-only"));
                }
                picked.insert(string(style, "id")?);
            }
            let before = params["before"]
                .as_str()
                .map(|id| entry(&entries, id))
                .transpose()?
                .map(|style| string(style, "id"))
                .transpose()?;
            let mut ordered = ordered_styles(&entries);
            let (moved, retained): (Vec<_>, Vec<_>) = ordered
                .drain(..)
                .partition(|(id, _)| picked.contains(id.as_str()));
            ordered = retained;
            let index = before
                .and_then(|id| ordered.iter().position(|(candidate, _)| *candidate == id))
                .unwrap_or(ordered.len());
            ordered.splice(index..index, moved);
            let step = u64::MAX / (ordered.len() as u64 + 1);
            for (index, (id, style)) in ordered.into_iter().enumerate() {
                let mut patch = json!({"order":step * (index as u64 + 1)});
                if let Some(folder) = params["folder"]
                    .as_str()
                    .filter(|_| picked.contains(id.as_str()))
                {
                    let label = name(style)?.rsplit('/').next().unwrap();
                    let folder = folder.trim_matches('/').trim();
                    patch["name"] = if folder.is_empty() {
                        json!(label)
                    } else {
                        json!(format!("{folder}/{label}"))
                    };
                }
                if patch["order"] != style["order"] || patch.get("name").is_some() {
                    commands.push(catalog("styles", id, patch)?);
                }
            }
            self.catalog_commit(session, snapshot, commands)?;
            return Ok(json!({"ok":true}));
        }
        if action == "renameFolder" {
            let folder = string(params, "folder")?.trim_matches('/');
            let next = name(params)?.trim_matches('/');
            if folder.is_empty() || next.is_empty() {
                return Err(EngineError::invalid("Expected nonempty style folder paths"));
            }
            let prefix = format!("{folder}/");
            for (id, style) in &entries {
                if let Some(suffix) = style["name"]
                    .as_str()
                    .and_then(|name| name.strip_prefix(&prefix))
                {
                    if style["libraryId"].is_null() {
                        commands.push(catalog(
                            "styles",
                            id,
                            json!({"name":format!("{next}/{suffix}")}),
                        )?);
                    }
                }
            }
            self.catalog_commit(session, snapshot, commands)?;
            return Ok(json!({"ok":true}));
        }
        let existing = if action == "create" {
            Value::Null
        } else {
            entry(&entries, string(params, "style")?)?.clone()
        };
        let id = if matches!(action, "create" | "duplicate") {
            new_id("style")
        } else {
            string(&existing, "id")?.to_owned()
        };
        let kind = params["type"]
            .as_str()
            .or(existing["type"].as_str())
            .unwrap_or("");
        if matches!(action, "update" | "delete" | "bind") && existing["libraryId"].is_string() {
            return Err(EngineError::invalid(
                "Library style definitions are read-only",
            ));
        }
        match action {
            "create" | "update" => {
                let mut patch = json!({});
                if action == "create" {
                    patch["type"] = json!(kind);
                    patch["order"] = json!(
                        entries
                            .values()
                            .filter_map(|style| style["order"].as_u64())
                            .max()
                            .unwrap_or(0)
                            .saturating_add(1)
                    );
                }
                if action == "create" || params.get("name").is_some() {
                    patch["name"] = json!(name(params)?);
                }
                if let Some(description) = params.get("description") {
                    patch["description"] = description.clone();
                }
                let target = style_target(kind, None)?;
                if let Some(value) = params.get("value") {
                    patch["value"] = normalize_style(kind, value)?;
                } else if action == "create" || params.get("from").is_some() {
                    let source = params
                        .get("from")
                        .or_else(|| selection.first())
                        .ok_or_else(|| {
                            EngineError::invalid("Style value or source layer required")
                        })?;
                    let source = self.fig_layer(session, snapshot, source)?;
                    let (props, _) = omc_style::ReferenceContext::new(snapshot)
                        .properties(&snapshot.nodes[&source]);
                    let value = match target {
                        "fill" => props.get("fills").or_else(|| props.get("fill")).cloned(),
                        "effect" => props.get("effects").cloned(),
                        "text" => Some(json!(
                            style_fields(target)?
                                .iter()
                                .filter_map(|key| props.get(*key).map(|v| (*key, v)))
                                .collect::<BTreeMap<_, _>>()
                        )),
                        _ => None,
                    }
                    .ok_or_else(|| {
                        EngineError::invalid("Source layer has no matching style value")
                    })?;
                    patch["value"] = normalize_style(kind, &value)?;
                }
                if patch.as_object().is_some_and(|patch| !patch.is_empty()) {
                    commands.push(catalog("styles", &id, patch)?);
                }
                if action == "create" && params.get("value").is_none() {
                    let source = params.get("from").or_else(|| selection.first()).unwrap();
                    let node_id = self.fig_layer(session, snapshot, source)?;
                    append_style_apply(&mut commands, node_id, &id, target)?;
                }
            }
            "bind" => {
                let tokens = resources::catalogs(&snapshot.metadata, "tokens");
                let mut value = existing["value"].clone();
                let field = string(params, "field")?;
                let reference = params["variable"]
                    .as_str()
                    .map(|id| entry(&tokens, id))
                    .transpose()?;
                let (field_value, expected) = style_binding_field(kind, &mut value, field)?;
                if let Some(token) = reference {
                    if token["type"] != expected {
                        return Err(EngineError::invalid(
                            "Variable and style property types do not match",
                        ));
                    }
                    *field_value = json!({"$token":token["id"]});
                } else if field_value.get("$token").is_some() {
                    *field_value = resolve_catalog_value(snapshot, field_value)?;
                }
                commands.push(catalog("styles", &id, json!({"value":value}))?);
            }
            "apply" => {
                let target = style_target(kind, params["target"].as_str())?;
                for node_id in self.catalog_targets(session, snapshot, params, selection)? {
                    if target == "text" && snapshot.nodes[&node_id].kind != NodeKind::Text {
                        return Err(EngineError::invalid("A text style requires a text layer"));
                    }
                    append_style_apply(&mut commands, node_id, &id, target)?;
                }
            }
            "duplicate" => {
                let mut patch = existing.clone();
                patch["name"] = json!(format!("{} copy", name(&existing)?));
                patch.as_object_mut().unwrap().remove("libraryId");
                commands.push(catalog("styles", &id, patch)?);
            }
            "delete" => {
                for node in snapshot.nodes.values() {
                    for target in ["fill", "stroke", "text", "effect"] {
                        if node
                            .properties
                            .get(&style_link(target))
                            .and_then(Value::as_str)
                            == Some(&id)
                        {
                            detach_style(&mut commands, snapshot, node, target)?;
                        }
                    }
                }
                commands.push(catalog("styles", &id, json!({"deleted":true}))?);
            }
            _ => return Err(unsupported("Unknown style command")),
        }
        self.catalog_commit(session, snapshot, commands)?;
        Ok(if matches!(action, "create" | "duplicate") {
            json!({"id":id})
        } else {
            json!({"ok":true})
        })
    }
}

fn ordered_styles(entries: &Entries) -> Vec<(&String, &Value)> {
    let mut styles: Vec<_> = entries.iter().collect();
    styles.sort_by_key(|(id, style)| (style["order"].as_u64().unwrap_or(0), id.as_str()));
    styles
}

pub(super) fn append_style_apply(
    commands: &mut Vec<Command>,
    node_id: String,
    id: &str,
    target: &str,
) -> Result<()> {
    commands.push(Command::NodeUnset {
        node_id: node_id.clone(),
        properties: style_fields(target)?
            .iter()
            .map(|key| (*key).into())
            .collect(),
    });
    commands.push(Command::NodeSet {
        node_id,
        properties: Properties::from([(style_link(target), json!(id))]),
    });
    Ok(())
}

fn resolve_catalog_value(snapshot: &DocumentSnapshot, value: &Value) -> Result<Value> {
    let mut probe = Node::new(NodeKind::Frame);
    probe
        .properties
        .insert("catalogValue".into(), value.clone());
    let (props, diagnostics) = omc_style::ReferenceContext::new(snapshot).properties(&probe);
    if diagnostics.is_empty() {
        Ok(props["catalogValue"].clone())
    } else {
        Err(EngineError::invalid("Cannot resolve catalog value"))
    }
}

fn style_binding_field<'a>(
    kind: &str,
    value: &'a mut Value,
    field: &str,
) -> Result<(&'a mut Value, &'static str)> {
    let parts: Vec<_> = field.split('/').collect();
    let (target, expected) = match (kind, parts.as_slice()) {
        ("paint", ["fill"]) if !value.is_array() => (Some(value), "color"),
        ("paint", ["fill"]) => (value.get_mut(0).and_then(|p| p.get_mut("color")), "color"),
        ("paint", ["fills", index, "color"]) => (
            index
                .parse::<usize>()
                .ok()
                .and_then(|index| value.get_mut(index))
                .and_then(|p| p.get_mut("color")),
            "color",
        ),
        ("paint", ["fills", index, "stops", stop, "color"]) => (
            index
                .parse::<usize>()
                .ok()
                .and_then(|index| value.get_mut(index))
                .and_then(|p| p.get_mut("stops"))
                .and_then(|stops| {
                    stop.parse::<usize>()
                        .ok()
                        .and_then(|index| stops.get_mut(index))
                })
                .and_then(|stop| stop.get_mut("color")),
            "color",
        ),
        ("text", [field @ ("fontSize" | "lineHeight" | "letterSpacing")]) => {
            (value.get_mut(*field), "number")
        }
        ("text", [field @ ("fontFamily" | "fontStyle")]) => (value.get_mut(*field), "string"),
        (
            "effect",
            [
                "effects",
                index,
                field @ ("color" | "radius" | "spread" | "offsetX" | "offsetY"),
            ],
        ) => (
            index
                .parse::<usize>()
                .ok()
                .and_then(|index| value.get_mut(index))
                .and_then(|effect| effect.get_mut(*field)),
            if *field == "color" { "color" } else { "number" },
        ),
        _ => {
            return Err(unsupported(
                "This style field cannot be bound to a variable",
            ));
        }
    };
    Ok((
        target.ok_or_else(|| EngineError::invalid("Style value has no such field"))?,
        expected,
    ))
}

fn normalize_style(kind: &str, value: &Value) -> Result<Value> {
    if kind == "paint" {
        if let Some(paints) = value.as_array() {
            return Ok(json!(
                paints
                    .iter()
                    .map(|paint| {
                        if paint["type"]
                            .as_str()
                            .is_some_and(|kind| kind.eq_ignore_ascii_case("solid"))
                        {
                            let mut paint = paint.clone();
                            paint["type"] = json!("solid");
                            paint
                        } else {
                            paint.clone()
                        }
                    })
                    .collect::<Vec<_>>()
            ));
        }
        if value.is_string() || value.is_object() {
            return Ok(value.clone());
        }
    }
    if (kind == "text" && value.is_object()) || (kind == "effect" && value.is_array()) {
        return Ok(value.clone());
    }
    Err(EngineError::invalid("Invalid style value"))
}

fn mode_id<'a>(modes: &'a [Value], value: &str) -> Result<&'a str> {
    modes
        .iter()
        .find(|mode| mode["id"] == value || mode["name"] == value)
        .and_then(|mode| mode["id"].as_str())
        .ok_or_else(|| EngineError::invalid(format!("Unknown collection mode {value}")))
}

fn token_value(entries: &Entries, kind: &str, value: &Value, id: &str) -> Result<Value> {
    if let Some(fields) = value.as_object().filter(|fields| fields.len() == 1) {
        let reference = |alias: &str| -> Result<Value> {
            let variable = entry(entries, alias)?;
            if variable["type"] != kind {
                return Err(EngineError::invalid(
                    "Variable alias must use the same type",
                ));
            }
            let alias = string(variable, "id")?;
            let mut checked = BTreeSet::new();
            let mut pending = vec![alias];
            while let Some(next) = pending.pop() {
                if next == id {
                    return Err(EngineError::invalid("Variable alias cycle"));
                }
                if checked.insert(next)
                    && let Some(token) = entries.get(next)
                {
                    variable_ops::references(&token["value"], &mut pending);
                    variable_ops::references(&token["modes"], &mut pending);
                }
            }
            Ok(json!({"$token":alias}))
        };
        if let Some(alias) = fields.get("alias").and_then(Value::as_str) {
            return reference(alias);
        }
        if kind == "color" {
            let fraction = |value: &Value| {
                value
                    .as_f64()
                    .filter(|number| (0. ..=1.).contains(number))
                    .ok_or_else(|| {
                        EngineError::invalid("Color calculation fractions must be in 0..1")
                    })
            };
            if let Some(alpha) = fields.get("alpha") {
                return Ok(json!({"$colorAlpha":{
                    "color":reference(string(alpha,"variable")?)?,
                    "opacity":fraction(&alpha["opacity"])?,
                }}));
            }
            if let Some(mix) = fields.get("mix") {
                let operand = |value: &Value| {
                    if value.as_object().is_none_or(|fields| fields.len() != 1) {
                        return Err(EngineError::invalid(
                            "Color mix needs variable or literal operands",
                        ));
                    }
                    if let Some(variable) = value["variable"].as_str() {
                        reference(variable)
                    } else {
                        token_value(entries, "color", &value["literal"], id)
                    }
                };
                return Ok(json!({"$colorMix":{
                    "from":operand(&mix["from"])?,"to":operand(&mix["to"])?,"t":fraction(&mix["t"])?,
                }}));
            }
        }
    }
    let valid = match kind {
        "color" => value.as_str().is_some_and(|color| {
            color.strip_prefix('#').is_some_and(|hex| {
                matches!(hex.len(), 3 | 4 | 6 | 8)
                    && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        }),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        _ => false,
    };
    if valid {
        Ok(value.clone())
    } else {
        Err(EngineError::invalid(format!(
            "Expected a {kind} variable literal or a same-type alias"
        )))
    }
}

fn fig_token_value(value: &Value) -> Value {
    if let Some(alpha) = value.get("$colorAlpha") {
        return json!({"alpha":{"variable":alpha["color"]["$token"],"opacity":alpha["opacity"]}});
    }
    if let Some(mix) = value.get("$colorMix") {
        let operand = |value: &Value| {
            value
                .get("$token")
                .map_or_else(|| json!({"literal":value}), |id| json!({"variable":id}))
        };
        return json!({"mix":{"from":operand(&mix["from"]),"to":operand(&mix["to"]),"t":mix["t"]}});
    }
    value["$token"]
        .as_str()
        .map_or_else(|| value.clone(), |id| json!({"alias":id}))
}

impl ToolRouter {
    fn fig_variable_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        selection: &[Value],
        action: &str,
        params: &Value,
    ) -> Result<Value> {
        let collections = resources::catalogs(&snapshot.metadata, "figcraftCollections");
        let tokens = resources::catalogs(&snapshot.metadata, "tokens");
        let mut commands = Vec::new();
        let result = match action {
            "import" => {
                variable_io::import(&collections, &tokens, &params["variables"], &mut commands)?
            }
            "export" => return variable_io::export(snapshot, &collections, &tokens, params),
            "list" => {
                let variables: Vec<Value> = tokens
                    .values()
                    .map(|token| {
                        let mut item = token.clone();
                        item["collection"] = token["collectionId"].clone();
                        if let Some(modes) = token["modes"].as_object() {
                            item["values"] = json!(
                                modes
                                    .iter()
                                    .map(|(id, value)| (id, fig_token_value(value)))
                                    .collect::<BTreeMap<_, _>>()
                            );
                        }
                        item["value"] = fig_token_value(&token["value"]);
                        item
                    })
                    .collect();
                return Ok(
                    json!({"collections":collections.values().collect::<Vec<_>>(),"variables":variables}),
                );
            }
            "createCollection" => {
                let collection = new_id("collection");
                let supplied = params
                    .get("modes")
                    .cloned()
                    .unwrap_or_else(|| json!(["Mode 1"]));
                let values = supplied
                    .as_array()
                    .filter(|modes| !modes.is_empty() && modes.len() <= 64)
                    .ok_or_else(|| EngineError::invalid("Expected 1–64 mode names"))?;
                let mut seen = BTreeSet::new();
                let mut modes = Vec::new();
                for value in values {
                    let mode = value
                        .as_str()
                        .map(str::trim)
                        .filter(|mode| !mode.is_empty() && seen.insert(*mode))
                        .ok_or_else(|| {
                            EngineError::invalid("Expected distinct nonempty mode names")
                        })?;
                    modes.push(json!({"id":new_id("mode"),"name":mode}));
                }
                commands.push(collection_patch(
                    &collection,
                    &json!({"name":name(params)?,"modes":modes}),
                )?);
                json!({"id":collection})
            }
            "renameCollection" | "addMode" | "renameMode" => {
                let current = entry(&collections, string(params, "collection")?)?;
                let collection = string(current, "id")?;
                let next_name = name(params)?;
                if current["libraryId"].is_string()
                    || action != "renameCollection" && current["extendsCollection"].is_string()
                {
                    return Err(EngineError::invalid(
                        "Inherited or linked modes are read-only",
                    ));
                }
                if action == "renameCollection" {
                    commands.push(collection_patch(collection, &json!({"name":next_name}))?);
                    json!({"ok":true})
                } else {
                    let mut modes = current["modes"]
                        .as_array()
                        .ok_or_else(|| EngineError::invalid("Collection has no modes"))?
                        .clone();
                    if modes.iter().any(|mode| mode["name"] == next_name) {
                        return Err(EngineError::invalid("Mode name is already in use"));
                    }
                    let id = if action == "addMode" {
                        if modes.len() >= 64 {
                            return Err(EngineError::invalid("Collection already has 64 modes"));
                        }
                        let from = params["from"]
                            .as_str()
                            .map(|name| mode_id(&modes, name))
                            .transpose()?
                            .unwrap_or(string(&modes[0], "id")?);
                        let id = new_id("mode");
                        for (token_id, token) in tokens
                            .iter()
                            .filter(|(_, token)| token["collectionId"] == collection)
                        {
                            let mut values = token["modes"].clone();
                            values[&id] = values.get(from).unwrap_or(&token["value"]).clone();
                            commands.push(catalog("tokens", token_id, json!({"modes":values}))?);
                        }
                        modes.push(json!({"id":id,"name":next_name}));
                        id
                    } else {
                        let id = mode_id(&modes, string(params, "mode")?)?.to_owned();
                        modes.iter_mut().find(|mode| mode["id"] == id).unwrap()["name"] =
                            json!(next_name);
                        id
                    };
                    commands.push(collection_patch(collection, &json!({"modes":modes}))?);
                    if action == "addMode" {
                        json!({"id":id})
                    } else {
                        json!({"ok":true})
                    }
                }
            }
            "moveMode" | "removeMode" => {
                let current = entry(&collections, string(params, "collection")?)?;
                if current["libraryId"].is_string() || current["extendsCollection"].is_string() {
                    return Err(EngineError::invalid(
                        "Inherited or linked modes are read-only",
                    ));
                }
                let id = string(current, "id")?;
                let mut modes = current["modes"]
                    .as_array()
                    .ok_or_else(|| EngineError::invalid("Collection has no modes"))?
                    .clone();
                let mode = mode_id(&modes, string(params, "mode")?)?.to_owned();
                let from = modes.iter().position(|item| item["id"] == mode).unwrap();
                if action == "removeMode" && modes.len() == 1 {
                    return Err(EngineError::invalid(
                        "A collection must keep at least one mode",
                    ));
                }
                let moved = modes.remove(from);
                if action == "moveMode" {
                    let to = params["to"]
                        .as_u64()
                        .filter(|to| *to <= modes.len() as u64)
                        .ok_or_else(|| EngineError::invalid("Mode index is out of range"))?;
                    modes.insert(to as usize, moved);
                }
                let default = string(&modes[0], "id")?;
                for (token_id, token) in tokens
                    .iter()
                    .filter(|(_, token)| token["collectionId"] == id)
                {
                    let mut values = token["modes"].clone();
                    if action == "removeMode" {
                        values.as_object_mut().unwrap().remove(&mode);
                    }
                    let value = values.get(default).unwrap_or(&token["value"]).clone();
                    values[default] = value.clone();
                    let mut patch = json!({"value":value,"modes":values});
                    if action == "removeMode" && token["activeMode"] == mode {
                        patch["activeMode"] = Value::Null;
                    }
                    commands.push(catalog("tokens", token_id, patch)?);
                }
                commands.push(collection_patch(id, &json!({"modes":modes}))?);
                json!({"ok":true})
            }
            "create" => {
                let current = entry(&collections, string(params, "collection")?)?;
                if current["libraryId"].is_string() {
                    return Err(EngineError::invalid("Linked collections are read-only"));
                }

                let modes = current["modes"]
                    .as_array()
                    .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
                let default = string(&modes[0], "id")?;
                let kind = string(params, "type")?;
                let id = new_id("token");
                let mut values = json!({});
                if let Some(value) = params.get("value") {
                    values[default] = token_value(&tokens, kind, value, &id)?;
                }
                if let Some(raw) = params.get("values") {
                    for (mode, value) in raw.as_object().ok_or_else(|| {
                        EngineError::invalid("values must map mode names to values")
                    })? {
                        values[mode_id(modes, mode)?] = token_value(&tokens, kind, value, &id)?;
                    }
                }
                if values.get(default).is_none() {
                    return Err(EngineError::invalid("Default mode value required"));
                }
                commands.push(catalog("tokens", &id, json!({"collectionId":current["id"],"name":name(params)?,"type":kind,"description":params["description"],"value":values[default],"modes":values}))?);
                json!({"id":id})
            }
            "extendCollection" => {
                let source = entry(&collections, string(params, "collection")?)?;
                if source["libraryId"].is_string() {
                    return Err(EngineError::invalid(
                        "Use library.extendCollection for a linked collection",
                    ));
                }
                variable_ops::extension(&collections, source, params, &mut commands)?
            }
            "resetOverride" => {
                let token = entry(&tokens, string(params, "variable")?)?;
                if !token["extendsVariable"].is_string() {
                    return Err(EngineError::invalid(
                        "Only inherited variables have overrides",
                    ));
                }
                let mut overrides: BTreeSet<_> = token["overrideModes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                if let Some(mode) = params["mode"].as_str() {
                    let collection = entry(&collections, string(token, "collectionId")?)?;
                    let modes = collection["modes"]
                        .as_array()
                        .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
                    overrides.remove(mode_id(modes, mode)?);
                } else {
                    overrides.clear();
                }
                commands.push(catalog(
                    "tokens",
                    string(token, "id")?,
                    json!({"overrideModes":overrides}),
                )?);
                json!({"ok":true})
            }
            "delete" | "deleteCollection" => {
                let collection;
                let mut gone = BTreeSet::new();
                if action == "delete" {
                    let token = entry(&tokens, string(params, "variable")?)?;
                    if token["libraryId"].is_string() {
                        return Err(EngineError::invalid("Library variables are read-only"));
                    }
                    collection = None;
                    gone.insert(string(token, "id")?);
                } else {
                    let token_collection = entry(&collections, string(params, "collection")?)?;
                    if token_collection["libraryId"].is_string() {
                        return Err(EngineError::invalid(
                            "Library variable collections are read-only",
                        ));
                    }
                    let id = string(token_collection, "id")?;
                    collection = Some(id);
                    gone.extend(
                        tokens
                            .iter()
                            .filter(|(_, token)| token["collectionId"] == id)
                            .map(|(id, _)| id.as_str()),
                    );
                }
                variable_ops::delete(snapshot, &tokens, &gone, collection, &mut commands)?;
                if collection.is_some() {
                    json!({"deletedVariables":gone.len()})
                } else {
                    json!({"ok":true})
                }
            }
            "set" | "update" | "duplicate" => {
                let token = entry(&tokens, string(params, "variable")?)?;
                let id = string(token, "id")?;
                if token["libraryId"].is_string() {
                    return Err(EngineError::invalid("Library variables are read-only"));
                }
                if action == "duplicate" {
                    let mut patch = token.clone();
                    patch["name"] = json!(format!("{} copy", name(token)?));
                    patch["extendsVariable"] = Value::Null;
                    patch["overrideModes"] = json!([]);

                    let id = new_id("token");
                    commands.push(catalog("tokens", &id, patch)?);
                    json!({"id":id})
                } else {
                    let mut patch = json!({});
                    if action == "update" {
                        if params.get("name").is_some() {
                            if token["extendsVariable"].is_string() {
                                return Err(EngineError::invalid(
                                    "Inherited variable names are read-only",
                                ));
                            }
                            patch["name"] = json!(name(params)?);
                        }
                        if let Some(description) = params.get("description") {
                            patch["description"] = description.clone();
                        }
                        variable_ops::append_update(token, params, &mut patch)?;
                    } else {
                        let value = params
                            .get("value")
                            .ok_or_else(|| EngineError::invalid("Variable value required"))?;
                        let value = token_value(&tokens, string(token, "type")?, value, id)?;
                        if let Some(collection) = token["collectionId"]
                            .as_str()
                            .and_then(|id| collections.get(id))
                        {
                            let modes = collection["modes"]
                                .as_array()
                                .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
                            let default = string(&modes[0], "id")?;
                            let mode = params["mode"]
                                .as_str()
                                .map(|mode| mode_id(modes, mode))
                                .transpose()?
                                .unwrap_or(default);
                            let mut values = token["modes"].clone();
                            values[mode] = value.clone();
                            patch["modes"] = values;
                            if token["extendsVariable"].is_string() {
                                let mut overrides: BTreeSet<_> = token["overrideModes"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str)
                                    .collect();
                                overrides.insert(mode);
                                patch["overrideModes"] = json!(overrides);
                            }
                            if mode == default {
                                patch["value"] = value;
                            }
                        } else if params["mode"].is_null() {
                            patch["value"] = value;
                        } else {
                            return Err(EngineError::invalid(
                                "This variable has no FigCraft collection modes",
                            ));
                        }
                    }
                    if patch.as_object().is_some_and(|p| !p.is_empty()) {
                        commands.push(catalog("tokens", id, patch)?);
                    }
                    json!({"ok":true})
                }
            }
            "setMode" => {
                let collection = entry(&collections, string(params, "collection")?)?;
                let id = string(collection, "id")?;
                let modes = collection["modes"]
                    .as_array()
                    .ok_or_else(|| EngineError::invalid("Collection has no modes"))?;
                let mode = match params.get("mode") {
                    Some(Value::Null) => None,
                    Some(Value::String(mode)) => Some(mode_id(modes, mode)?),
                    _ => return Err(EngineError::invalid("Pass a mode name, ID, or null")),
                };
                let targets = if params.get("ids").is_none() && selection.is_empty() {
                    vec![self.state(session, &snapshot.id)?.root]
                } else {
                    self.catalog_targets(session, snapshot, params, selection)?
                };
                for node_id in targets {
                    let node = &snapshot.nodes[&node_id];
                    if !matches!(
                        node.kind,
                        NodeKind::Frame | NodeKind::Component | NodeKind::Instance
                    ) {
                        return Err(EngineError::invalid(
                            "Variable mode overrides belong to a page or frame",
                        ));
                    }
                    let mut overrides = node
                        .properties
                        .get("figcraftVariableModes")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(mode) = mode {
                        overrides.insert(id.into(), json!(mode));
                    } else {
                        overrides.remove(id);
                    }
                    commands.push(Command::NodeSet {
                        node_id,
                        properties: Properties::from([(
                            "figcraftVariableModes".into(),
                            json!(overrides),
                        )]),
                    });
                }
                json!({"ok":true})
            }
            "bind" => {
                let requested = string(params, "field")?;
                let (field, kind) = match requested {
                    field @ ("fill" | "stroke" | "color") => (field, "color"),
                    field @ ("fontFamily" | "fontStyle") => (field, "string"),
                    "characters" => ("text", "string"),
                    "visible" => ("visible", "boolean"),
                    field @ ("width" | "height" | "fontSize" | "strokeWidth" | "opacity"
                    | "cornerRadius" | "fontWeight" | "lineHeight" | "letterSpacing"
                    | "wordSpacing") => (field, "number"),
                    field if variable_ops::path_type(field).is_some() => {
                        (field, variable_ops::path_type(field).unwrap())
                    }
                    _ => {
                        return Err(unsupported(
                            "The native node model does not yet support binding this field",
                        ));
                    }
                };
                let value = match params.get("variable") {
                    Some(Value::Null) => None,
                    Some(Value::String(variable)) => {
                        let token = entry(&tokens, variable)?;
                        if token["type"] != kind {
                            return Err(EngineError::invalid(
                                "Variable and property types do not match",
                            ));
                        }
                        Some(json!({"$token":token["id"]}))
                    }
                    _ => {
                        return Err(EngineError::invalid(
                            "variable must be an ID, a name, or null",
                        ));
                    }
                };
                let references = omc_style::ReferenceContext::new(snapshot);
                for node_id in self.catalog_targets(session, snapshot, params, selection)? {
                    let node = &snapshot.nodes[&node_id];
                    if let Some(properties) =
                        variable_ops::nested_binding(&references, node, requested, value.as_ref())?
                    {
                        commands.push(Command::NodeSet {
                            node_id,
                            properties,
                        });
                        continue;
                    }
                    if field == "text" && node.kind != NodeKind::Text {
                        return Err(EngineError::invalid(
                            "Only a text layer can bind characters",
                        ));
                    }
                    if kind == "number" || field == "text" {
                        let mut bindings = node
                            .properties
                            .get("figcraftVariableBindings")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        let mut properties = Properties::new();
                        if let Some(value) = &value {
                            bindings.insert(field.into(), value.clone());
                        } else if bindings.remove(field).is_some() {
                            let (effective, diagnostics) = references.properties(node);
                            if field == "text" {
                                if diagnostics.iter().any(|diagnostic| {
                                    diagnostic.property.as_deref() == Some("text")
                                }) {
                                    return Err(EngineError::invalid(
                                        "Cannot unbind an unresolved text variable",
                                    ));
                                }
                                if let Some(text) = effective.get(field).and_then(Value::as_str)
                                    && node.string("text") != Some(text)
                                {
                                    commands.push(Command::TextReplace {
                                        node_id: node_id.clone(),
                                        text: text.into(),
                                    });
                                }
                            } else if let Some(value) = effective.get(field) {
                                properties.insert(field.into(), value.clone());
                            }
                        }
                        properties.insert("figcraftVariableBindings".into(), json!(bindings));
                        commands.push(Command::NodeSet {
                            node_id,
                            properties,
                        });
                        continue;
                    }
                    let new_value = if let Some(value) = &value {
                        Some(value.clone())
                    } else if node
                        .properties
                        .get(field)
                        .is_some_and(|value| value.get("$token").is_some())
                    {
                        let (effective, diagnostics) = references.properties(node);
                        if !diagnostics.is_empty() {
                            return Err(EngineError::invalid(
                                "Cannot unbind an unresolved variable",
                            ));
                        }
                        effective.get(field).cloned()
                    } else {
                        None
                    };
                    if let Some(value) = new_value {
                        commands.push(Command::NodeSet {
                            node_id,
                            properties: Properties::from([(field.into(), value)]),
                        });
                    }
                }
                json!({"ok":true})
            }
            _ => return Err(unsupported("Unknown variable command")),
        };
        variable_ops::sync_extensions(snapshot, &mut commands)?;
        self.catalog_commit(session, snapshot, commands)?;
        Ok(result)
    }
}

pub(super) fn node_page<'a>(snapshot: &'a DocumentSnapshot, id: &str) -> Option<&'a omc_model::Page> {
    let mut node = snapshot.nodes.get(id)?;
    while let Some(parent) = &node.parent_id {
        node = snapshot.nodes.get(parent)?;
    }
    snapshot
        .pages
        .iter()
        .find(|page| page.root_node_id == node.id)
}

fn wrap_component(snapshot: &DocumentSnapshot, ids: &[String]) -> Result<(String, Vec<Command>)> {
    let first = &snapshot.nodes[&ids[0]];
    let parent = first
        .parent_id
        .as_deref()
        .ok_or_else(|| EngineError::invalid("A page cannot become a component"))?;
    let mut source = ids.iter().map(|id| &snapshot.nodes[id]).collect::<Vec<_>>();
    if source.iter().any(|node| {
        node.parent_id.as_deref() != Some(parent)
            || matches!(node.kind, NodeKind::Component | NodeKind::Instance)
    }) {
        return Err(unsupported(
            "Select sibling layers outside of components or instances to create a component",
        ));
    }
    let mut ancestor = Some(parent);
    while let Some(id) = ancestor {
        let node = &snapshot.nodes[id];
        if node.kind == NodeKind::Instance {
            return Err(EngineError::invalid(
                "Layers inside instances cannot become components",
            ));
        }
        ancestor = node.parent_id.as_deref();
    }
    source.sort_by_key(|node| &node.rank);
    let top = source[0];
    let mut component = Node::new(NodeKind::Component);
    component.home_shard = top.home_shard.clone();
    component.parent_id = Some(parent.into());
    component.rank = top.rank.clone();
    let replacement = source.len() == 1 && matches!(top.kind, NodeKind::Frame | NodeKind::Group);
    let (offset_x, offset_y) = if replacement {
        component.properties = top.properties.clone();
        (0., 0.)
    } else {
        let x = source
            .iter()
            .map(|node| node.number("x", 0.))
            .fold(f64::INFINITY, f64::min);
        let y = source
            .iter()
            .map(|node| node.number("y", 0.))
            .fold(f64::INFINITY, f64::min);
        let width = source
            .iter()
            .map(|node| node.number("x", 0.) + node.number("width", 0.) - x)
            .fold(0_f64, f64::max);
        let height = source
            .iter()
            .map(|node| node.number("y", 0.) + node.number("height", 0.) - y)
            .fold(0_f64, f64::max);
        component.properties = properties(&json!({"x":x,"y":y,"width":width,"height":height}))?;
        (x, y)
    };
    let label = if source.len() == 1 {
        top.string("name").unwrap_or("Component")
    } else {
        "Component"
    };
    component.properties.insert("name".into(), json!(label));
    component
        .properties
        .insert("componentDefinition".into(), json!(true));
    let root = component.id.clone();
    let mut commands = vec![Command::NodeCreate { node: component }];
    let moved = if replacement {
        children(snapshot, &top.id)
    } else {
        source
    };
    for node in moved {
        commands.push(Command::NodeMove {
            node_id: node.id.clone(),
            parent_id: Some(root.clone()),
            rank: node.rank.clone(),
        });
        if !replacement {
            commands.push(Command::NodeSet {
                node_id: node.id.clone(),
                properties: properties(&json!({"x":node.number("x", 0.) - offset_x,"y":node.number("y", 0.) - offset_y}))?,
            });
        }
    }
    if replacement {
        commands.push(Command::NodeDelete {
            node_ids: vec![top.id.clone()],
        });
    }
    Ok((root, commands))
}

impl ToolRouter {
    fn fig_component_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        command: &str,
        params: &Value,
    ) -> Result<Value> {
        let document = &snapshot.id;
        let key = (session.to_owned(), document.clone());
        if command == "component.list" {
            let items: Vec<_> = snapshot.nodes.values().filter(|node| node.kind == NodeKind::Component).map(|node| {
                let title = node.string("name").unwrap_or("Component");
                let page = node_page(snapshot, &node.id);
                let (folder, label) = title.rsplit_once('/').unwrap_or(("", title));
                let mut parts = Vec::new();
                if let Some(page) = page { parts.push(page.title.as_str()); }
                parts.extend(folder.split('/').filter(|part| !part.is_empty()));
                let library = node.string("libraryId");
                let mut item = json!({
                    "id":self.fig_alias(session, document, &node.id), "name":title, "type":"component",
                    "page":page.filter(|_| library.is_none()).map(|page| self.fig_alias(session, document, &page.root_node_id)),
                    "instances":snapshot.nodes.values().filter(|candidate| candidate.string("componentId") == Some(&node.id)).count(),
                    "folder":parts.join("/"), "label":label,
                });
                if let Some(library) = library { item["library"] = json!(library); }
                item
            }).collect();
            return Ok(json!(items));
        }
        if matches!(command, "instance.place" | "instance.swapAt") {
            let mut component = self.fig_layer(session, snapshot, &params["component"])?;
            if snapshot.nodes[&component].properties.get("isVariantSet") == Some(&Value::Bool(true))
            {
                component = children(snapshot, &component)
                    .into_iter()
                    .find(|node| node.kind == NodeKind::Component)
                    .map(|node| node.id.clone())
                    .ok_or_else(|| EngineError::invalid("The component set has no variants"))?;
            }
            if snapshot.nodes[&component].kind != NodeKind::Component {
                return Err(EngineError::invalid("Expected a component definition"));
            }
            let point = |key| {
                params[key]
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| EngineError::invalid(format!("{key} required")))
            };
            let (x, y) = (point("x")?, point("y")?);
            let (raw, edit) = if command == "instance.place" {
                let node = library_swap::place(snapshot, state, &component, x, y, None)?;
                (node.id.clone(), Command::NodeCreate { node })
            } else {
                let node = library_swap::at_point(snapshot, state, &component, x, y)?;
                let mut properties =
                    library_swap::instance_patch(snapshot, node, &component, true)?;
                if node.string("libraryId").is_some()
                    || snapshot.nodes[&component].string("libraryId").is_some()
                {
                    properties.insert(
                        "libraryId".into(),
                        json!(snapshot.nodes[&component].string("libraryId")),
                    );
                }
                (
                    node.id.clone(),
                    Command::NodeSet {
                        node_id: node.id.clone(),
                        properties,
                    },
                )
            };
            self.catalog_commit(session, snapshot, vec![edit])?;
            let id = json!(self.fig_alias(session, document, &raw));
            self.fig_selection(&key, &[id.clone()]);
            return Ok(json!({"id":id}));
        }
        if command == "instance.create" {
            let mut source = self.fig_layer(session, snapshot, &params["component"])?;
            if snapshot.nodes[&source].properties.get("isVariantSet") == Some(&Value::Bool(true)) {
                source = children(snapshot, &source)
                    .into_iter()
                    .find(|node| node.kind == NodeKind::Component)
                    .map(|node| node.id.clone())
                    .ok_or_else(|| EngineError::invalid("The component set has no variants"))?;
            }
            let component = &snapshot.nodes[&source];
            if component.kind != NodeKind::Component {
                return Err(EngineError::invalid("component must be a component layer"));
            }
            let parent = params
                .get("parent")
                .map(|id| self.fig_layer(session, snapshot, id))
                .transpose()?
                .unwrap_or_else(|| state.root.clone());
            let mut instance = Node::new(NodeKind::Instance);
            instance.parent_id = Some(parent.clone());
            instance.home_shard = snapshot.nodes[&parent].home_shard.clone();
            instance.rank = rank_between(
                children(snapshot, &parent)
                    .last()
                    .map(|node| node.rank.as_str()),
                None,
            )
            .ok_or_else(|| EngineError::new("resource_limit", "Sibling ranks need rebalancing"))?;
            let x = params["x"]
                .as_f64()
                .unwrap_or_else(|| component.number("x", 0.) + component.number("width", 0.) + 40.);
            let y = params["y"]
                .as_f64()
                .unwrap_or_else(|| component.number("y", 0.));
            instance.properties = properties(
                &json!({"name":component.string("name").unwrap_or("Component"),"componentId":source,"x":x,"y":y}),
            )?;
            let raw = instance.id.clone();
            self.catalog_commit(
                session,
                snapshot,
                vec![Command::NodeCreate { node: instance }],
            )?;
            let id = json!(self.fig_alias(session, document, &raw));
            self.fig_selection(&key, &[id.clone()]);
            return Ok(json!({"id":id}));
        }
        let targets = self.catalog_targets(session, snapshot, params, selection)?;
        if matches!(command, "component.create" | "component.createMultiple") {
            let mut roots = Vec::new();
            let mut commands = Vec::new();
            if command == "component.create" {
                let (id, edits) = wrap_component(snapshot, &targets)?;
                roots.push(id);
                commands = edits;
            } else {
                let selected: BTreeSet<_> = targets.iter().collect();
                for id in &targets {
                    let mut parent = snapshot.nodes[id].parent_id.as_ref();
                    while let Some(ancestor) = parent {
                        if selected.contains(ancestor) {
                            return Err(EngineError::invalid(
                                "Select separate roots to create multiple components",
                            ));
                        }
                        parent = snapshot.nodes[ancestor].parent_id.as_ref();
                    }
                    let (id, edits) = wrap_component(snapshot, std::slice::from_ref(id))?;
                    roots.push(id);
                    commands.extend(edits);
                }
            }
            self.catalog_commit(session, snapshot, commands)?;
            let ids: Vec<_> = roots
                .iter()
                .map(|id| json!(self.fig_alias(session, document, id)))
                .collect();
            self.fig_selection(&key, &ids);
            return Ok(if command == "component.create" {
                json!({"id":ids[0]})
            } else {
                json!({"ids":ids})
            });
        }
        if command == "component.goToMain" {
            let mut candidate = Some(targets[0].as_str());
            let mut component = None;
            while let Some(id) = candidate {
                let node = &snapshot.nodes[id];
                if let Some(raw) = node.string("componentId") {
                    component = snapshot.nodes.get(raw);
                    break;
                }
                candidate = node.parent_id.as_deref();
            }
            let component = component
                .ok_or_else(|| EngineError::invalid("Instance has no live component definition"))?;
            if component.string("libraryId").is_some() {
                return Err(unsupported("The main definition is in an external library"));
            }
            let page = node_page(snapshot, &component.id)
                .ok_or_else(|| EngineError::invalid("Component page missing"))?;
            if let Some(view) = self.states.lock().unwrap().get_mut(&key) {
                view.page_id = page.id.clone();
                view.root = page.root_node_id.clone();
            }
            let id = json!(self.fig_alias(session, document, &component.id));
            self.fig_selection(&key, &[id.clone()]);
            return Ok(json!({"id":id}));
        }
        if command == "component.detach" && targets.len() == 1 {
            let raw = &targets[0];
            if snapshot.nodes[raw].kind != NodeKind::Instance
                || snapshot.nodes[raw].string("componentId").is_none()
            {
                return Err(EngineError::invalid("Expected a linked instance"));
            }
            self.mutate(
                session,
                document,
                "component",
                &json!({"action":"detach","id":raw}),
                &Value::Null,
            )?;
            return Ok(json!({"ok":true}));
        }
        let source = if command == "instance.swap" {
            let component = self.fig_layer(session, snapshot, &params["component"])?;
            if snapshot.nodes[&component].kind != NodeKind::Component {
                return Err(EngineError::invalid("component must be a component layer"));
            }
            Some(component)
        } else {
            None
        };
        let mut commands = Vec::new();
        for node_id in targets {
            let node = &snapshot.nodes[&node_id];
            if node.kind != NodeKind::Instance || node.string("componentId").is_none() {
                return Err(EngineError::invalid("Expected linked instances"));
            }
            match command {
                "component.resetInstance" => commands.push(Command::NodeUnset {
                    node_id,
                    properties: vec!["overrides".into()],
                }),
                "instance.swap" => {
                    if node
                        .properties
                        .get("overrides")
                        .and_then(Value::as_object)
                        .is_some_and(|overrides| !overrides.is_empty())
                    {
                        return Err(unsupported(
                            "Swapping an overridden instance requires matching its property overrides",
                        ));
                    }
                    commands.push(Command::NodeSet {
                        node_id,
                        properties: Properties::from([("componentId".into(), json!(source))]),
                    });
                }
                _ => {
                    return Err(unsupported(
                        "Detaching multiple instances requires a native multi-instance transaction",
                    ));
                }
            }
        }
        self.catalog_commit(session, snapshot, commands)?;
        Ok(json!({"ok":true}))
    }

    fn fig_attach_library(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        path: &str,
        publication: Value,
    ) -> Result<Value> {
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        let id = string(&publication, "id")?;
        if library_ops::published(&snapshot.metadata).is_some_and(|ours| ours["id"] == id) {
            return Err(EngineError::invalid("This file is the published library"));
        }
        let existing = libraries.get(id);
        if let Some(existing) = existing {
            if existing["path"] != path || existing["enabled"] != true {
                self.catalog_commit(
                    session,
                    snapshot,
                    vec![catalog(
                        "libraries",
                        id,
                        json!({"path":path,"enabled":true}),
                    )?],
                )?;
            }
        } else {
            self.library_tool(
                session,
                &snapshot.id,
                json!({
                    "action":"add","id":id,"_path":path,"snapshot":publication,
                }),
                Value::Null,
            )?;
        }
        let mut response = library_ops::summary(&publication)["assets"].clone();
        for key in ["id", "name", "version"] {
            response[key] = publication[key].clone();
        }
        response["path"] = json!(library_team::display_path(path));
        Ok(response)
    }

    fn fig_library_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        action: &str,
        params: &Value,
    ) -> Result<Value> {
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        if action == "usage" {
            return self.fig_local_library_usage(snapshot, params);
        }
        if action == "publish" {
            let mut request = params.clone();
            for key in ["include", "exclude"] {
                if let Some(ids) = request.get_mut(key).and_then(Value::as_array_mut) {
                    for id in ids {
                        if id.is_u64() {
                            *id = json!(self.fig_layer(session, snapshot, id)?);
                        }
                    }
                }
            }
            let (publication, command) = library_ops::publication(snapshot, &request)?;
            self.catalog_commit(session, snapshot, vec![command])?;
            let mut summary = library_ops::summary(&publication);
            summary.as_object_mut().unwrap().remove("assets");
            return Ok(summary);
        }
        if action == "add" {
            let (path, publication) = self.fig_library_source(string(params, "path")?, true)?;
            return self.fig_attach_library(session, snapshot, &path, publication);
        }
        if action == "list" {
            let entries: Vec<_> = libraries.values().filter(|library| library["enabled"] != false).map(|library| {
                let mut info = json!({"id":library["id"],"name":library["name"],
                    "path":library["path"].as_str().map(library_team::display_path),
                    "server":library["path"].as_str().is_some_and(library_team::is_link),
                    "seenVersion":library["version"],"version":library["version"],"description":library["snapshot"]["description"]});
                if params["assets"] == true {
                    let summary = library_ops::summary(&library["snapshot"]);
                    for key in ["components", "styles", "variables", "collections"] {
                        info[key] = if library["path"].is_string() { summary["assets"][key].clone() }
                            else { library["snapshot"][key].clone() };
                    }
                }
                if let Some(path) = library["path"].as_str() {
                    match self.fig_library_source(path, false) {
                        Ok((_, publication)) if publication["id"] == library["id"] => {
                            info["version"] = publication["version"].clone();
                            info["updates"] = json!(publication["version"] != library["version"]);
                        }
                        Ok(_) => info["error"] = json!("The file now holds another library"),
                        Err(error) => info["error"] = json!(error.message),
                    }
                }
                info
            }).collect();
            let publication = library_ops::published(&snapshot.metadata).map(|library| {
                let mut summary = library_ops::summary(library);
                if params["assets"] != true {
                    summary.as_object_mut().unwrap().remove("assets");
                }
                summary
            });
            let mut result = json!({"libraries":entries,"published":publication});
            if params["assets"] == true {
                result["publishable"] = library_ops::publishable(snapshot);
            }
            return Ok(result);
        }
        if matches!(action, "updates" | "acceptUpdates") {
            let requested = params["ids"]
                .as_array()
                .map(|ids| {
                    ids.iter()
                        .map(|id| {
                            let id = id
                                .as_str()
                                .ok_or_else(|| EngineError::invalid("Expected library IDs"))?;
                            library_ops::library(&libraries, id)
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .transpose()?;
            let entries = requested.clone().unwrap_or_else(|| {
                libraries
                    .values()
                    .filter(|library| library["enabled"] != false)
                    .collect()
            });
            let mut changes = Vec::new();
            let mut errors = Vec::new();
            let mut counts = [0; 4];
            for library in entries {
                let Some(path) = library["path"].as_str() else {
                    continue;
                };
                let publication = match self.fig_library_source(path, action == "acceptUpdates") {
                    Ok((_, published)) if published["id"] == library["id"] => published,
                    Ok(_) => {
                        errors.push(json!({"id":library["id"],"error":"The file now holds another library"}));
                        continue;
                    }
                    Err(error) if requested.is_none() => {
                        errors.push(json!({"id":library["id"],"error":error.message}));
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                if publication["version"].as_u64() <= library["version"].as_u64() {
                    continue;
                }
                let mut item = json!({"id":library["id"],"name":library["name"],"version":publication["version"]});
                for (index, (asset, mapping)) in [
                    ("components", "componentMap"),
                    ("styles", "styleMap"),
                    ("collections", "collectionMap"),
                    ("variables", "variableMap"),
                ]
                .into_iter()
                .enumerate()
                {
                    let rows:Vec<_> = publication[asset].as_object().into_iter().flatten()
                        .filter(|(id,row)| library["snapshot"][asset].get(*id) != Some(*row))
                        .map(|(id,row)| json!({"id":library[mapping][id],"key":id,"name":row["name"]})).collect();
                    counts[index] += rows.len();
                    item[asset] = json!(rows);
                }
                if action == "acceptUpdates" {
                    self.library_tool(session, &snapshot.id, json!({
                        "action":"update","id":library["id"],"_path":path,"snapshot":publication,
                    }), Value::Null)?;
                }
                changes.push(item);
            }
            return Ok(if action == "updates" {
                json!({"count":counts.iter().sum::<usize>(),"libraries":changes,"errors":errors})
            } else {
                json!({"components":counts[0],"styles":counts[1],"collections":counts[2],"variables":counts[3],"skipped":errors})
            });
        }
        if action == "swap" {
            let source = library_ops::library(&libraries, string(params, "from")?)?;
            let destination = library_ops::library(&libraries, string(params, "to")?)?;
            let mut commands = Vec::new();
            let result = library_swap::swap(snapshot, source, destination, &mut commands)?;
            variable_ops::sync_extensions(snapshot, &mut commands)?;
            self.catalog_commit(session, snapshot, commands)?;
            return Ok(result);
        }
        let reference = params["library"]
            .as_str()
            .or_else(|| params["id"].as_str())
            .ok_or_else(|| EngineError::invalid("Library ID, name or path required"))?;
        let library = library_ops::library(&libraries, reference)?;
        let id = string(library, "id")?;
        match action {
            "remove" => {
                self.catalog_commit(
                    session,
                    snapshot,
                    vec![catalog(
                        "libraries",
                        id,
                        json!({"deleted":true,"enabled":false}),
                    )?],
                )?;
                Ok(json!({"ok":true}))
            }
            "applyStyle" => {
                let (key, style) = library_ops::asset(library, "styles", string(params, "style")?)?;
                let local = library["styleMap"][key]
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Linked style is not installed"))?;
                let target = style_target(string(style, "type")?, params["target"].as_str())?;
                let mut commands = Vec::new();
                for node_id in self.catalog_targets(session, snapshot, params, selection)? {
                    if target == "text" && snapshot.nodes[&node_id].kind != NodeKind::Text {
                        return Err(EngineError::invalid("A text style requires a text layer"));
                    }
                    append_style_apply(&mut commands, node_id, local, target)?;
                }
                self.catalog_commit(session, snapshot, commands)?;
                Ok(json!({"style":local}))
            }
            "importVariable" | "bindVariable" | "aliasVariable" => {
                let name = string(
                    params,
                    if action == "aliasVariable" {
                        "alias"
                    } else {
                        "variable"
                    },
                )?;
                let (key, _) = library_ops::asset(library, "variables", name)?;
                let local = library["variableMap"][key]
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Linked variable is not installed"))?;
                if action == "bindVariable" {
                    let mut request = params.clone();
                    request["variable"] = json!(local);
                    self.fig_variable_command(session, snapshot, selection, "bind", &request)?;
                } else if action == "aliasVariable" {
                    let mut request = params.clone();
                    request["value"] = json!({"alias":local});
                    self.fig_variable_command(session, snapshot, selection, "set", &request)?;
                }
                Ok(json!({"variable":local}))
            }
            "extendCollection" => {
                let (key, _) =
                    library_ops::asset(library, "collections", string(params, "collection")?)?;
                let local = library["collectionMap"][key]
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Linked collection is not installed"))?;
                let collections = resources::catalogs(&snapshot.metadata, "figcraftCollections");
                let source = entry(&collections, local)?;
                let mut commands = Vec::new();
                let result = variable_ops::extension(&collections, source, params, &mut commands)?;
                variable_ops::sync_extensions(snapshot, &mut commands)?;
                self.catalog_commit(session, snapshot, commands)?;
                Ok(result)
            }
            "setVariableMode" => {
                let (key, _) =
                    library_ops::asset(library, "collections", string(params, "collection")?)?;
                let local = library["collectionMap"][key]
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Linked collection is not installed"))?;
                let mut request = params.clone();
                request["collection"] = json!(local);
                self.fig_variable_command(session, snapshot, &[], "setMode", &request)?;
                Ok(json!({"collection":local}))
            }
            "place" | "import" | "swapAt" => {
                let requested = params["component"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| params["component"].as_u64().map(|id| id.to_string()))
                    .ok_or_else(|| EngineError::invalid("Component ID or name required"))?;
                let (key, _) = library_ops::asset(library, "components", &requested)?;
                let raw = library["componentMap"][key]
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Linked component is not installed"))?;
                let component = self.fig_alias(session, &snapshot.id, raw);
                if action == "import" {
                    return Ok(json!({"component":component}));
                }
                if action == "swapAt" {
                    let number = |key| {
                        params[key]
                            .as_f64()
                            .filter(|number| number.is_finite())
                            .ok_or_else(|| EngineError::invalid(format!("{key} is required")))
                    };
                    let node =
                        library_swap::at_point(snapshot, state, raw, number("x")?, number("y")?)?;
                    let mut patch = library_swap::instance_patch(snapshot, node, raw, true)?;
                    patch.insert("libraryId".into(), json!(id));
                    self.catalog_commit(
                        session,
                        snapshot,
                        vec![Command::NodeSet {
                            node_id: node.id.clone(),
                            properties: patch,
                        }],
                    )?;
                    let alias = json!(self.fig_alias(session, &snapshot.id, &node.id));
                    self.fig_selection(&(session.into(), snapshot.id.clone()), &[alias.clone()]);
                    return Ok(json!({"id":alias,"component":component}));
                }
                let x = params["x"]
                    .as_f64()
                    .or_else(|| state.view["x"].as_f64())
                    .unwrap_or(0.);
                let y = params["y"]
                    .as_f64()
                    .or_else(|| state.view["y"].as_f64())
                    .unwrap_or(0.);
                let result = self.library_tool(
                    session,
                    &snapshot.id,
                    json!({
                        "action":"insert","id":id,"componentId":key,"x":x,"y":y,
                    }),
                    Value::Null,
                )?;
                let raw = result["rawIds"]
                    .get(0)
                    .and_then(Value::as_str)
                    .ok_or_else(|| EngineError::invalid("No instance was created"))?;
                let alias = json!(self.fig_alias(session, &snapshot.id, raw));
                self.fig_selection(&(session.into(), snapshot.id.clone()), &[alias.clone()]);
                Ok(json!({"id":alias,"component":component}))
            }
            _ => Err(unsupported("Unknown library command")),
        }
    }
}

pub(super) fn comment_id(raw: &str) -> u64 {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(raw);
    // Numeric aliases stay stable across MCP sessions and fit exactly in JavaScript numbers.
    u64::from_le_bytes(hash[..8].try_into().unwrap()) & ((1 << 53) - 1)
}

pub(super) fn comment_alias(raw: &str, wire: Option<u64>) -> u64 {
    wire.filter(|id| *id <= (1u64 << 53) - 1)
        .unwrap_or_else(|| comment_id(raw))
}

fn comment_link(id: u64) -> String {
    format!("figcraft://comment/{id}")
}

fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub(super) fn comment_replies<'a>(entries: &'a Entries, thread: &str) -> Vec<&'a Value> {
    let mut replies: Vec<_> = entries
        .values()
        .filter(|reply| reply["threadId"] == thread)
        .collect();
    replies.sort_by_key(|reply| comment_reply_order(reply));
    replies
}

pub(super) fn comment_reply_order(reply: &Value) -> (u64, u64, u64, &str) {
    (
        reply["wireReplyOrder"].as_u64().unwrap_or(u64::MAX),
        reply["createdAt"].as_u64().unwrap_or(0),
        reply["replyOrder"].as_u64().unwrap_or(0),
        reply["id"].as_str().unwrap_or(""),
    )
}

fn comment_text(params: &Value) -> Result<&str> {
    let value = string(params, "text")?.trim();
    if value.is_empty() || value.len() > 16_384 {
        return Err(EngineError::invalid("Comment text requires 1–16384 bytes"));
    }
    Ok(value)
}

fn comment_message(entry: &Value, people: &BTreeSet<&str>) -> Value {
    let body = entry["body"].as_str().unwrap_or_default();
    let mentions = body.split_whitespace().filter_map(|word| word.strip_prefix('@'))
        .map(|word| word.trim_end_matches(|character: char| !character.is_alphanumeric() && character != '_'))
        .filter(|name| !name.is_empty())
        .map(|name| json!({"name":name,"known":people.iter().any(|person| person.eq_ignore_ascii_case(name))}))
        .collect::<Vec<_>>();
    let mut reactions = entry["reactions"].as_array().cloned().unwrap_or_default();
    for reaction in &mut reactions {
        if let Some(users) = reaction["users"].as_array_mut() {
            for user in users {
                if let Some(name) = user.as_str().and_then(|id| entry["reactionNames"][id].as_str()) {
                    *user = json!(name);
                }
            }
        }
    }
    json!({"author":entry["authorName"].as_str().or(entry["authorId"].as_str()),"agent":entry["agent"].as_bool().unwrap_or(true),
        "text":body,"created":entry["createdAt"].as_u64().unwrap_or(0),"edited":entry["editedAt"].as_u64().unwrap_or(0),
        "reactions":reactions,"mentions":mentions})
}

fn comment_scene(snapshot: &DocumentSnapshot, page: &str) -> Result<omc_scene::Scene> {
    omc_scene::build_scene(
        snapshot,
        &omc_scene::SceneOptions {
            page_id: Some(page.into()),
            ..Default::default()
        },
    )
    .map_err(|error| EngineError::invalid(error.to_string()))
}

fn comment_page<'a>(snapshot: &'a DocumentSnapshot, entry: &Value) -> Option<&'a omc_model::Page> {
    entry["nodeId"]
        .as_str()
        .and_then(|node| node_page(snapshot, node))
        .or_else(|| match entry["pageId"].as_str() {
            Some(id) => snapshot.pages.iter().find(|page| page.id == id),
            None => snapshot.pages.first(),
        })
}

impl ToolRouter {
    fn fig_comment_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        action: &str,
        params: &Value,
    ) -> Result<Value> {
        let entries = resources::catalogs(&snapshot.metadata, "comments");
        let author = self.workspace.session(session)?.author;
        let preference = self.workspace.preferences().user_name;
        let display = if preference.is_empty() {
            "You"
        } else {
            &preference
        };
        let who = params["author"].as_str().unwrap_or(display);
        let author_id = params["author"].as_str().unwrap_or(&author);
        let authored = |entry: &Value| {
            if params["author"].is_string() {
                entry["authorName"] == who || entry["authorId"] == author_id
            } else {
                entry["authorId"]
                    .as_str()
                    .map_or(entry["authorName"] == who, |id| id == author_id)
            }
        };
        let unread = |entry: &Value| {
            entry["readBy"]
                .get(author_id)
                .or_else(|| entry["readBy"].get(who))
                .and_then(Value::as_bool)
                .map_or_else(|| entry["wireReadByAll"].as_bool().map_or(!authored(entry), |all| !all), |read| !read)
        };
        let resolve_page = |default: &str| -> Result<&omc_model::Page> {
            let root = params
                .get("page")
                .map(|id| self.fig_layer(session, snapshot, id))
                .transpose()?;
            snapshot
                .pages
                .iter()
                .find(|page| {
                    root.as_ref()
                        .map_or(page.id == default, |id| page.root_node_id == *id)
                })
                .ok_or_else(|| EngineError::invalid("Comment page not found"))
        };
        let mut people: BTreeSet<_> = entries
            .values()
            .filter_map(|entry| entry["authorName"].as_str().or(entry["authorId"].as_str()))
            .collect();
        if action == "people" {
            for entry in entries.values() {
                for reaction in entry["reactions"].as_array().into_iter().flatten() {
                    people.extend(
                        reaction["users"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(|id| entry["reactionNames"][id].as_str().unwrap_or(id)),
                    );
                }
                for word in entry["body"]
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                {
                    if let Some(name) = word.strip_prefix('@') {
                        let name = name.trim_end_matches(|character: char| {
                            !character.is_alphanumeric() && character != '_'
                        });
                        if !name.is_empty() {
                            people.insert(name);
                        }
                    }
                }
            }
            return Ok(json!({"people":people,"you":who}));
        }
        if action == "list" {
            let page = if params["page"] == "all" {
                None
            } else {
                Some(resolve_page(&state.page_id)?)
            };
            let query = params["query"].as_str().unwrap_or("").to_lowercase();
            let filter = params["filter"].as_str().unwrap_or("all");
            if !matches!(filter, "all" | "open" | "resolved" | "mine" | "unread") {
                return Err(unsupported("Unsupported comment filter"));
            }
            let sort = params["sort"].as_str().unwrap_or("date");
            if !matches!(sort, "date" | "page") {
                return Err(EngineError::invalid("sort must be date or page"));
            }
            let frame_filter = params
                .get("frame")
                .map(|id| self.fig_layer(session, snapshot, id))
                .transpose()?;
            let mentions = params
                .get("mentions")
                .map(|_| string(params, "mentions"))
                .transpose()?;
            let mentions_name = |entry: &Value, name: &str| {
                entry["body"]
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                    .filter_map(|word| word.strip_prefix('@'))
                    .map(|word| {
                        word.trim_end_matches(|character: char| {
                            !character.is_alphanumeric() && character != '_'
                        })
                    })
                    .any(|mention| mention.eq_ignore_ascii_case(name))
            };
            let mut scene_by_page = BTreeMap::new();
            let mut list = Vec::new();
            for (raw, entry) in entries
                .iter()
                .filter(|(_, entry)| entry["threadId"].is_null())
            {
                let Some(thread_page) = comment_page(snapshot, entry) else {
                    continue;
                };
                if page.is_some_and(|page| page.id != thread_page.id) {
                    continue;
                }
                let replies = comment_replies(&entries, raw);
                let thread = std::iter::once(entry).chain(replies.iter().copied());
                let resolved = entry["resolved"] == true;
                if (filter == "open" || params["resolved"] == false) && resolved
                    || filter == "resolved" && !resolved
                    || filter == "unread" && !unread(entry)
                    || filter == "mine"
                        && !thread
                            .clone()
                            .any(|entry| authored(entry) || mentions_name(entry, who))
                    || mentions
                        .is_some_and(|name| !thread.clone().any(|entry| mentions_name(entry, name)))
                    || !query.is_empty()
                        && !thread.clone().any(|entry| {
                            ["body", "authorName", "authorId"].iter().any(|key| {
                                entry[*key]
                                    .as_str()
                                    .is_some_and(|value| value.to_lowercase().contains(&query))
                            })
                        })
                {
                    continue;
                }
                let (mut x, mut y) = (
                    entry["x"].as_f64().unwrap_or(0.),
                    entry["y"].as_f64().unwrap_or(0.),
                );
                let node = entry["nodeId"]
                    .as_str()
                    .filter(|id| snapshot.nodes.contains_key(*id));
                if let Some((id, lx, ly)) = node
                    .zip(entry["localX"].as_f64())
                    .zip(entry["localY"].as_f64())
                    .map(|((id, lx), ly)| (id, lx, ly))
                {
                    if !scene_by_page.contains_key(&thread_page.id) {
                        scene_by_page.insert(
                            thread_page.id.clone(),
                            comment_scene(snapshot, &thread_page.id)?,
                        );
                    }
                    if let Some(item) = scene_by_page[&thread_page.id].item(id) {
                        (x, y) = item.world.point(lx, ly);
                    }
                }
                let top_frame = |id: &str| -> Option<&Node> {
                    let mut node = snapshot.nodes.get(id)?;
                    loop {
                        let parent = node.parent_id.as_deref()?;
                        if parent == thread_page.root_node_id {
                            break;
                        }
                        node = snapshot.nodes.get(parent)?;
                    }
                    matches!(
                        node.kind,
                        NodeKind::Frame | NodeKind::Component | NodeKind::Instance
                    )
                    .then_some(node)
                };
                let frame = if let Some(frame) = node.and_then(top_frame) {
                    Some(frame)
                } else {
                    if !scene_by_page.contains_key(&thread_page.id) {
                        scene_by_page.insert(
                            thread_page.id.clone(),
                            comment_scene(snapshot, &thread_page.id)?,
                        );
                    }
                    let scene = &scene_by_page[&thread_page.id];
                    scene.items[scene.root]
                        .children
                        .iter()
                        .rev()
                        .map(|index| &scene.items[*index])
                        .filter(|item| !item.hidden && item.contains(x, y))
                        .find_map(|item| top_frame(&item.id))
                };
                if frame_filter
                    .as_ref()
                    .is_some_and(|raw| frame.is_none_or(|frame| &frame.id != raw))
                {
                    continue;
                }
                let wire = entry["wireCommentId"].as_u64();
                let id = comment_alias(raw, wire);
                let mut value = comment_message(entry, &people);
                value["unread"] = json!(unread(entry));
                value["frame"] =
                    json!(frame.map(|node| self.fig_alias(session, &snapshot.id, &node.id)));
                value["frameName"] = json!(frame.and_then(|node| node.string("name")));
                value["id"] = json!(id);
                value["link"] = json!(comment_link(wire.unwrap_or(id)));
                value["page"] =
                    json!(self.fig_alias(session, &snapshot.id, &thread_page.root_node_id));
                value["pageName"] = json!(thread_page.title);
                value["x"] = json!(x);
                value["y"] = json!(y);
                value["anchor"] = json!(node.map(|id| self.fig_alias(session, &snapshot.id, id)));
                value["resolved"] = json!(resolved);
                value["replies"] = json!(
                    replies
                        .iter()
                        .map(|reply| comment_message(reply, &people))
                        .collect::<Vec<_>>()
                );
                let activity = thread
                    .flat_map(|entry| [entry["createdAt"].as_u64(), entry["editedAt"].as_u64()])
                    .flatten()
                    .max()
                    .unwrap_or(0);
                list.push((
                    if sort == "page" {
                        thread_page.rank.clone()
                    } else {
                        String::new()
                    },
                    std::cmp::Reverse(activity),
                    std::cmp::Reverse(id),
                    value,
                ));
            }
            list.sort_by(|a, b| (&a.0, a.1, a.2).cmp(&(&b.0, b.1, b.2)));
            return Ok(
                json!({"comments":list.into_iter().map(|(_,_,_,value)| value).collect::<Vec<_>>()}),
            );
        }
        let find_thread = || -> Result<&Value> {
            let input = params
                .get("id")
                .or_else(|| params.get("link"))
                .ok_or_else(|| EngineError::invalid("Comment id or link required"))?;
            if let Some(raw) = input.as_str() {
                if let Some(comment) = entries
                    .get(raw)
                    .filter(|comment| comment["threadId"].is_null())
                {
                    return Ok(comment);
                }
            }
            let id = input
                .as_u64()
                .or_else(|| {
                    let link = input.as_str()?;
                    link.strip_prefix("figcraft://comment/")
                        .unwrap_or(link)
                        .trim_end_matches('/')
                        .parse()
                        .ok()
                })
                .ok_or_else(|| EngineError::invalid("Invalid comment id or link"))?;
            let mut found = entries
                .iter()
                .filter(|(raw, comment)| {
                    let wire = comment["wireCommentId"].as_u64();
                    comment["threadId"].is_null() && (wire == Some(id) || comment_alias(raw, wire) == id)
                });
            let (_, comment) = found
                .next()
                .ok_or_else(|| EngineError::invalid("Comment thread not found"))?;
            if found.next().is_some() {
                return Err(EngineError::new(
                    "conflict",
                    "Numeric comment aliases collide; use the native comment ID",
                ));
            }
            Ok(comment)
        };
        if action == "markRead" {
            let read = params
                .get("read")
                .map(|value| {
                    value
                        .as_bool()
                        .ok_or_else(|| EngineError::invalid("read must be boolean"))
                })
                .transpose()?
                .unwrap_or(true);
            let only = if params.get("id").is_some() || params.get("link").is_some() {
                Some(string(find_thread()?, "id")?)
            } else {
                None
            };
            let mut commands = Vec::new();
            for (raw, entry) in entries.iter().filter(|(raw, entry)| {
                entry["threadId"].is_null()
                    && only.is_none_or(|id| id == *raw)
                    && unread(entry) == read
            }) {
                let mut readers = entry["readBy"].as_object().cloned().unwrap_or_default();
                if readers.len() >= 200 && !readers.contains_key(author_id) {
                    return Err(EngineError::new(
                        "resource_limit",
                        "Comment read state has too many readers",
                    ));
                }
                readers.insert(author_id.into(), json!(read));
                let mut names = entry["readerNames"].as_object().cloned().unwrap_or_default();
                names.insert(author_id.into(), json!(who));
                commands.push(catalog("comments", raw, json!({"readBy":readers,"readerNames":names}))?);
            }
            let changed = commands.len();
            self.catalog_commit(session, snapshot, commands)?;
            return Ok(json!({"changed":changed}));
        }
        let thread = if action == "add" {
            None
        } else {
            Some(find_thread()?)
        };
        let thread_id = thread
            .map(|thread| string(thread, "id"))
            .transpose()?
            .unwrap_or("");
        if action == "link" {
            let wire = thread.and_then(|thread| thread["wireCommentId"].as_u64());
            return Ok(json!({"link":comment_link(wire.unwrap_or_else(|| comment_id(thread_id)))}));
        }
        let mut commands = Vec::new();
        let mut result = json!({"ok":true});
        if matches!(action, "add" | "move") {
            let page = resolve_page(
                thread
                    .and_then(|entry| comment_page(snapshot, entry))
                    .map_or(state.page_id.as_str(), |page| page.id.as_str()),
            )?;
            let (x, y) = (
                params["x"]
                    .as_f64()
                    .ok_or_else(|| EngineError::invalid("Comment x required"))?,
                params["y"]
                    .as_f64()
                    .ok_or_else(|| EngineError::invalid("Comment y required"))?,
            );
            let mut patch =
                json!({"pageId":page.id,"x":x,"y":y,"nodeId":null,"localX":null,"localY":null});
            let anchor = params
                .get("anchor")
                .cloned()
                .unwrap_or(json!(action == "move"));
            if anchor != false && !anchor.is_null() {
                let scene = comment_scene(snapshot, &page.id)?;
                let item = if anchor == true {
                    scene.items.iter().rev().find(|item| {
                        !item.hidden
                            && matches!(
                                item.kind,
                                NodeKind::Frame | NodeKind::Component | NodeKind::Instance
                            )
                            && snapshot.nodes.contains_key(&item.id)
                            && item.contains(x, y)
                    })
                } else {
                    let raw = self.fig_layer(session, snapshot, &anchor)?;
                    Some(scene.item(&raw).ok_or_else(|| {
                        EngineError::invalid("Anchor layer is not on the comment page")
                    })?)
                };
                if let Some(item) = item {
                    let (lx, ly) = item
                        .world
                        .inverse()
                        .ok_or_else(|| {
                            EngineError::invalid("Comment anchor transform is singular")
                        })?
                        .point(x, y);
                    patch["nodeId"] = json!(item.id);
                    patch["localX"] = json!(lx);
                    patch["localY"] = json!(ly);
                }
            }
            if action == "add" {
                let id = new_id("comment");
                patch["body"] = json!(comment_text(params)?);
                patch["authorName"] = json!(who);
                patch["createdAt"] = json!(timestamp());
                patch["resolved"] = json!(false);
                result = json!({"id":comment_id(&id),"link":comment_link(comment_id(&id))});
                commands.push(catalog("comments", &id, patch)?);
            } else {
                commands.push(catalog("comments", thread_id, patch)?);
            }
        } else if action == "reply" {
            let id = new_id("comment");
            let replies = comment_replies(&entries, thread_id);
            let page = thread
                .and_then(|entry| comment_page(snapshot, entry))
                .ok_or_else(|| EngineError::invalid("Comment page not found"))?;
            commands.push(catalog("comments", &id, json!({"threadId":thread_id,"pageId":page.id,"body":comment_text(params)?,"authorName":who,"createdAt":timestamp(),"replyOrder":snapshot.sequence}))?);
            if thread.is_some_and(|thread| thread["resolved"] == true) {
                commands.push(catalog("comments", thread_id, json!({"resolved":false}))?);
            }
            result = json!({"reply":replies.len()});
        } else if action == "resolve" {
            commands.push(catalog(
                "comments",
                thread_id,
                json!({"resolved":params["resolved"].as_bool().unwrap_or(true)}),
            )?);
        } else {
            let message = match params.get("reply") {
                Some(index) => {
                    let index = index.as_u64().ok_or_else(|| {
                        EngineError::invalid("Reply index must be a nonnegative integer")
                    })?;
                    *comment_replies(&entries, thread_id)
                        .get(index as usize)
                        .ok_or_else(|| EngineError::invalid("Reply not found"))?
                }
                None => thread.unwrap(),
            };
            let id = string(message, "id")?;
            match action {
                "edit" => {
                    let body = comment_text(params)?;
                    if message["body"] != body {
                        commands.push(catalog(
                            "comments",
                            id,
                            json!({"body":body,"editedAt":timestamp()}),
                        )?);
                    }
                }
                "delete" => commands.push(catalog("comments", id, json!({"deleted":true}))?),
                "react" => {
                    let emoji = string(params, "emoji")?.trim();
                    if emoji.is_empty()
                        || emoji.len() > 32
                        || emoji.chars().any(|c| c.is_whitespace() || c.is_control())
                    {
                        return Err(EngineError::invalid("Expected one reaction emoji"));
                    }
                    let mut reactions =
                        message["reactions"].as_array().cloned().unwrap_or_default();
                    let position = reactions
                        .iter()
                        .position(|reaction| reaction["emoji"] == emoji);
                    let mut users = position
                        .and_then(|index| reactions[index]["users"].as_array())
                        .cloned()
                        .unwrap_or_default();
                    let has = users.iter().any(|user| user == &author);
                    let on = params["on"].as_bool().unwrap_or(!has);
                    if on != has {
                        if on {
                            users.push(json!(author));
                        } else {
                            users.retain(|user| user != &author);
                        }
                        if let Some(index) = position {
                            reactions.remove(index);
                        }
                        if !users.is_empty() {
                            reactions.push(json!({"emoji":emoji,"users":users}));
                        }
                        let mut names = message["reactionNames"].as_object().cloned().unwrap_or_default();
                        if on {
                            names.insert(author.clone(), json!(who));
                        } else if !reactions.iter().any(|reaction| reaction["users"].as_array()
                            .is_some_and(|users| users.iter().any(|user| user == &author)))
                        {
                            names.remove(&author);
                        }
                        commands.push(catalog("comments", id, json!({"reactions":reactions,"reactionNames":names}))?);
                    }
                    result = json!({"on":on});
                }
                _ => return Err(unsupported("Unknown comment command")),
            }
        }
        self.catalog_commit(session, snapshot, commands)?;
        Ok(result)
    }
}
