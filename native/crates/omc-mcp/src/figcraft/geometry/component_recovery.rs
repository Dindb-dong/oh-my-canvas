use super::*;

use omc_model::component_push_field as pushable;
use omc_protocol::node_override_commands;

fn within(snapshot: &DocumentSnapshot, id: &str, main: &str) -> bool {
    let mut node = snapshot.nodes.get(id);
    while let Some(next) = node {
        if next.id == main {
            return true;
        }
        node = next
            .parent_id
            .as_ref()
            .and_then(|parent| snapshot.nodes.get(parent));
    }
    false
}

impl ToolRouter {
    pub(in crate::figcraft) fn fig_set_component_override(
        &self,
        session: &str,
        root: &str,
        snapshot: &mut DocumentSnapshot,
        alias: &Value,
        patch: &Properties,
        commands: &mut Vec<Command>,
    ) -> Result<Value> {
        let projected = omc_scene::resolve_components(snapshot, Some(root));
        let id = self.fig_layer(session, &projected.snapshot, alias)?;
        let mut layer = projected.snapshot.nodes[&id].clone();
        if layer.properties.get("locked") == Some(&Value::Bool(true)) {
            return Err(EngineError::invalid("instance layer is locked"));
        }
        let source = layer
            .string("sourceNodeId")
            .map(str::to_owned)
            .ok_or_else(|| EngineError::invalid("instance layer has no source"))?;
        let owner = layer
            .string("instanceId")
            .map(str::to_owned)
            .filter(|id| {
                snapshot
                    .nodes
                    .get(id)
                    .is_some_and(|node| node.kind == NodeKind::Instance)
            })
            .ok_or_else(|| EngineError::invalid("choose a layer owned by an editable instance"))?;
        if patch
            .get("text")
            .is_some_and(|value| layer.kind != NodeKind::Text || !value.is_string())
        {
            return Err(EngineError::invalid(
                "characters require a text layer and a string",
            ));
        }
        let supported = |key: &str| {
            pushable(key)
                || matches!(
                    key,
                    "x" | "y" | "width" | "height" | "rotation" | "transform"
                )
        };
        if patch.keys().any(|key| !supported(key)) {
            return Err(EngineError::invalid(
                "property cannot be overridden on an instance layer",
            ));
        }
        drop(projected);
        let mut patch = patch.clone();
        if patch.contains_key("text") {
            patch.insert("textRuns".into(), Value::Null);
        }
        let instance = snapshot.nodes.get_mut(&owner).unwrap();
        let mut overrides = instance
            .properties
            .get("overrides")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut fields = overrides
            .get(&source)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in patch {
            if value.is_null() {
                layer.properties.remove(&key);
            } else {
                layer.properties.insert(key.clone(), value.clone());
            }
            fields.insert(key, value);
        }
        overrides.insert(source, Value::Object(fields));
        let overrides = Value::Object(overrides);
        instance
            .properties
            .insert("overrides".into(), overrides.clone());
        commands.push(Command::NodeSet {
            node_id: owner,
            properties: Properties::from([("overrides".into(), overrides)]),
        });
        Ok(self.fig_node(session, snapshot, &layer, 0, &mut 1))
    }

    pub(super) fn fig_component_recovery(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let target = params
            .get("id")
            .or_else(|| selection.first())
            .ok_or_else(|| EngineError::invalid("select an instance"))?;
        let projected = omc_scene::resolve_components(snapshot, Some(&state.root));
        let raw = self.fig_layer(session, &projected.snapshot, target)?;
        let mut node = &projected.snapshot.nodes[&raw];
        let mut outer = None;
        loop {
            if snapshot
                .nodes
                .get(&node.id)
                .is_some_and(|node| node.kind == NodeKind::Instance)
            {
                outer = Some(&snapshot.nodes[&node.id]);
            }
            let Some(parent) = node
                .parent_id
                .as_ref()
                .and_then(|id| projected.snapshot.nodes.get(id))
            else {
                break;
            };
            node = parent;
        }
        let instance = outer.ok_or_else(|| EngineError::invalid("select an instance"))?;
        let main = instance
            .string("componentId")
            .ok_or_else(|| EngineError::invalid("instance has no main component"))?;
        if name == "component.restoreMain" {
            if instance.id != raw {
                return Err(EngineError::invalid("select the outer instance"));
            }
            self.submit(
                session,
                &snapshot.id,
                Command::ComponentRestoreMain {
                    instance_id: instance.id.clone(),
                },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
            let alias = self.fig_alias(session, &snapshot.id, main);
            self.fig_selection(&(session.into(), snapshot.id.clone()), &[json!(alias)]);
            return Ok(json!({"id":alias}));
        }
        let definition = snapshot.nodes.get(main).ok_or_else(|| {
            EngineError::invalid("the main component was deleted; restore it first")
        })?;
        if definition.string("libraryId").is_some() {
            return Err(EngineError::invalid(
                "linked library components are read-only",
            ));
        }
        let mut commands = Vec::new();
        let mut changed = BTreeSet::new();
        let mut direct = instance
            .properties
            .iter()
            .filter(|(key, _)| key.as_str() != "name" && pushable(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Properties>();
        for (scalar, stack) in [("fill", "fills"), ("stroke", "strokes")] {
            if direct.contains_key(scalar) && !direct.contains_key(stack) {
                direct.insert(stack.into(), Value::Null);
            }
        }
        if !direct.is_empty() {
            commands.extend(node_override_commands(main, &direct)?);
            commands.push(Command::NodeUnset {
                node_id: instance.id.clone(),
                properties: direct
                    .keys()
                    .filter(|key| instance.properties.contains_key(*key))
                    .cloned()
                    .collect(),
            });
            changed.insert(main.to_owned());
        }
        if let Some(mut overrides) = instance
            .properties
            .get("overrides")
            .and_then(Value::as_object)
            .cloned()
        {
            let before = overrides.clone();
            for (source, fields) in &mut overrides {
                if !within(snapshot, source, main) {
                    continue;
                }
                let Some(fields) = fields.as_object_mut() else {
                    continue;
                };
                let patch = fields
                    .iter()
                    .filter(|(key, _)| pushable(key) && (source != main || key.as_str() != "name"))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Properties>();
                if patch.is_empty() {
                    continue;
                }
                commands.extend(node_override_commands(source, &patch)?);
                changed.insert(source.clone());
                fields.retain(|key, _| !patch.contains_key(key));
            }
            overrides
                .retain(|_, fields| fields.as_object().is_none_or(|fields| !fields.is_empty()));
            if overrides != before {
                commands.push(Command::NodeSet {
                    node_id: instance.id.clone(),
                    properties: Properties::from([("overrides".into(), Value::Object(overrides))]),
                });
            }
        }
        if !commands.is_empty() {
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        Ok(json!({"layers":changed.len()}))
    }
}
