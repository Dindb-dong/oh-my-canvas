use super::*;
use omc_style::{ColorProfile, convert_color_catalog_entry, convert_color_property};

impl ToolRouter {
    pub(super) fn fig_file_color_profile(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        params: &Value,
    ) -> Result<Value> {
        let source = ColorProfile::from_metadata(&snapshot.metadata);
        let Some(value) = params.get("profile") else {
            return Ok(json!({"profile":source.name(),"changed":false}));
        };
        let target = value
            .as_str()
            .and_then(ColorProfile::parse)
            .ok_or_else(|| EngineError::invalid("profile must be srgb or displayP3"))?;
        let convert = params.get("convert").map_or(Ok(true), |value| {
            value
                .as_bool()
                .ok_or_else(|| EngineError::invalid("convert must be a boolean"))
        })?;
        if target == source {
            return Ok(json!({"profile":source.name(),"changed":false}));
        }
        let mut metadata = Properties::from([("colorProfile".into(), json!(target.name()))]);
        let mut commands = Vec::new();
        if convert {
            for (key, value) in &snapshot.metadata {
                if let Some((token, field)) = key
                    .strip_prefix("tokens/")
                    .and_then(|entry| entry.rsplit_once('/'))
                    && matches!(field, "value" | "values" | "modes" | "modeValues")
                    && snapshot
                        .metadata
                        .get(&format!("tokens/{token}/type"))
                        .is_none_or(|kind| kind != "color")
                {
                    continue;
                }
                let mut converted = value.clone();
                convert_color_catalog_entry(key, &mut converted, source, target);
                if converted != *value {
                    metadata.insert(key.clone(), converted);
                }
            }
            for node in snapshot.nodes.values() {
                let mut properties = Properties::new();
                for (key, value) in &node.properties {
                    let mut converted = value.clone();
                    convert_color_property(key, &mut converted, source, target);
                    if converted != *value {
                        properties.insert(key.clone(), converted);
                    }
                }
                if !properties.is_empty() {
                    commands.push(Command::NodeSet {
                        node_id: node.id.clone(),
                        properties,
                    });
                }
            }
        }
        commands.push(Command::DocumentMetadata {
            properties: metadata,
        });
        self.submit(
            session,
            &snapshot.id,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        Ok(json!({"profile":target.name(),"changed":true}))
    }
}
