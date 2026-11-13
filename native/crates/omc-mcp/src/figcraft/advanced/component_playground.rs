use super::*;
use std::collections::BTreeMap;

pub(super) fn command(context: &Context) -> Result<Value> {
    let selected = context.one()?;
    let selected = &context.snapshot.nodes[&selected];
    let instance = selected.kind == NodeKind::Instance;
    let source = if instance {
        selected
            .string("componentId")
            .and_then(|id| context.snapshot.nodes.get(id))
    } else if selected.properties.get("isVariantSet") == Some(&Value::Bool(true)) {
        children(context.snapshot, &selected.id)
            .into_iter()
            .find(|node| node.kind == NodeKind::Component)
    } else {
        Some(selected).filter(|node| node.kind == NodeKind::Component)
    }
    .ok_or_else(|| EngineError::invalid("Choose a component, component set or instance"))?;
    let mut snapshot = context.snapshot.clone();
    let id = if instance {
        selected.id.clone()
    } else {
        let mut node = Node::new(NodeKind::Instance);
        node.parent_id = Some(context.state.root.clone());
        node.home_shard = snapshot.nodes[&context.state.root].home_shard.clone();
        node.properties = Properties::from([
            (
                "name".into(),
                json!(source.string("name").unwrap_or("Component")),
            ),
            ("componentId".into(), json!(source.id)),
            ("x".into(), json!(0.)),
            ("y".into(), json!(0.)),
        ]);
        let id = node.id.clone();
        snapshot.nodes.insert(id.clone(), node);
        id
    };
    if let Some(properties) = context.params.get("properties") {
        let values = properties
            .as_object()
            .ok_or_else(|| EngineError::invalid("properties must be an object"))?;
        let preview = Context {
            snapshot: &snapshot,
            ..*context
        };
        let operations = component::property_operations(&preview, &[id.clone()], values)?;
        snapshot =
            context
                .router
                .preview_component_operations(context.session, snapshot, operations)?;
    }
    let preview = Context {
        snapshot: &snapshot,
        ..*context
    };
    let description = component::describe_layer(&preview, &id)?;
    let properties = description["properties"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|property| {
            let mut output = json!({"name":property["name"],"type":property["type"],
            "value":property.get("value").unwrap_or(&property["default"])});
            if let Some(options) = property.get("options") {
                output["options"] = options.clone();
            }
            output
        })
        .collect::<Vec<_>>();
    let language = context
        .params
        .get("language")
        .map_or(Ok("react"), |value| {
            value
                .as_str()
                .and_then(inspect_code::language_id)
                .filter(|lang| {
                    matches!(
                        *lang,
                        "css"
                            | "html"
                            | "react"
                            | "leptos"
                            | "vue"
                            | "swiftui"
                            | "compose"
                            | "arkui"
                            | "flutter"
                    )
                })
                .ok_or_else(|| EngineError::invalid("Unsupported playground language"))
        })?;
    let owner = code_connect::owner(&snapshot, &id).ok();
    let link = owner
        .into_iter()
        .flat_map(code_connect::links)
        .find(|link| link["language"] == language);
    let code = if let Some(link) = link {
        code_connect::render(&link, description["properties"].as_array().unwrap())?.0
    } else {
        let params = BTreeMap::new();
        let name = inspect_code::symbol(source.string("name").unwrap_or("Component"));
        inspect_code::generate(&preview, &id, language, None, Some((&name, &params)))?
    };
    let scene = crate::paths::scene(&snapshot, &context.state.page_id)?;
    let [x, y, width, height] = scene
        .bounds(&id)
        .ok_or_else(|| EngineError::invalid("The component has no visible bounds"))?;
    let mut result = json!({"component":context.alias(&source.id),"properties":properties,
        "language":language,"code":code,"width":width,"height":height});
    if let Some(path) = context.params.get("path") {
        let path = path
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| EngineError::invalid("path must be a file path"))?;
        let scale = context
            .params
            .get("scale")
            .map_or(Some(2.), Value::as_f64)
            .filter(|scale| scale.is_finite() && *scale >= 0.05 && *scale <= 16.)
            .ok_or_else(|| EngineError::invalid("scale must be between 0.05 and 16"))?;
        let args = json!({"format":"png","pageId":context.state.page_id,"ids":[id],"scale":scale,"strict":false,
            "bounds":{"x":x,"y":y,"width":width,"height":height}});
        let bytes = context
            .router
            .export_snapshot_native(snapshot, &args)?
            .bytes;
        crate::interchange::write_explicit(path, &bytes, false)?;
        result["path"] = json!(path);
    }
    Ok(result)
}
