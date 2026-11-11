use super::*;
use omc_model::{DocumentSnapshot, Node, NodeKind};
use serde_json::{Value, json};

pub fn import_json(source: &str, options: &ImportOptions) -> Result<ImportResult, ImportError> {
    validate_input(source.as_bytes(), options)?;
    let value: Value =
        serde_json::from_str(source).map_err(|e| ImportError::Invalid(e.to_string()))?;
    if let Some(format) = value.get("format").and_then(Value::as_str) {
        if format != "omc.native/1" {
            return Err(ImportError::Unsupported(format!("native format {format}")));
        }
    }
    if value.get("format").and_then(Value::as_str) == Some("omc.native/1") {
        let content: DocumentContent = serde_json::from_value(
            value
                .get("content")
                .cloned()
                .ok_or_else(|| ImportError::Invalid("native package has no content".into()))?,
        )
        .map_err(|e| ImportError::Invalid(e.to_string()))?;
        let content_digest = value
            .get("contentSha256")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ImportError::Invalid("native package content checksum missing".into())
            })?;
        if digest(&serde_jcs::to_vec(&content).map_err(|e| ImportError::Invalid(e.to_string()))?)
            != content_digest
        {
            return Err(ImportError::Invalid(
                "native content checksum mismatch".into(),
            ));
        }
        let mut result = ImportResult {
            content,
            resources: Vec::new(),
            diagnostics: Vec::new(),
            source_map: BTreeMap::new(),
        };
        if let Some(assets) = value.get("assets").and_then(Value::as_array) {
            for asset in assets {
                let hash = asset
                    .get("hash")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ImportError::Invalid("asset hash missing".into()))?;
                let media = asset
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ImportError::Invalid("asset mediaType missing".into()))?;
                let encoded = asset
                    .get("base64")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ImportError::Invalid("asset bytes missing".into()))?;
                let resource = resource(&format!("data:{media};base64,{encoded}"))?;
                if resource.hash != hash {
                    return Err(ImportError::Invalid("asset digest mismatch".into()));
                }
                result.resources.push(resource);
            }
        }
        let mut bytes = 0usize;
        let mut hashes = std::collections::BTreeSet::new();
        for asset in &result.resources {
            bytes = bytes
                .checked_add(asset.bytes.len())
                .ok_or_else(|| ImportError::ResourceLimit("asset size overflow".into()))?;
            if bytes > options.max_input_bytes || !hashes.insert(&asset.hash) {
                return Err(ImportError::Invalid(
                    "duplicate asset or excessive decoded resource bytes".into(),
                ));
            }
        }
        remap(&mut result);
        return finish(result, options);
    }
    if value.get("nodes").is_some() {
        let content = if value.get("epoch").is_some() {
            let s: DocumentSnapshot =
                serde_json::from_value(value).map_err(|e| ImportError::Invalid(e.to_string()))?;
            DocumentContent {
                title: s.title,
                pages: s.pages,
                nodes: s.nodes,
                metadata: s.metadata,
            }
        } else {
            serde_json::from_value(value).map_err(|e| ImportError::Invalid(e.to_string()))?
        };
        let mut result = ImportResult {
            content,
            resources: Vec::new(),
            diagnostics: Vec::new(),
            source_map: BTreeMap::new(),
        };
        remap(&mut result);
        return finish(result, options);
    }
    legacy(value, options)
}

fn remap(result: &mut ImportResult) {
    let mut mapping = BTreeMap::new();
    for id in result.content.nodes.keys() {
        mapping.insert(id.clone(), omc_model::new_id("node"));
    }
    for page in &result.content.pages {
        mapping.insert(page.id.clone(), omc_model::new_id("page"));
    }
    let nodes = std::mem::take(&mut result.content.nodes);
    for (old, mut node) in nodes {
        node.id = mapping[&old].clone();
        node.home_shard = omc_model::new_id("shard");
        node.parent_id = node
            .parent_id
            .map(|p| mapping.get(&p).cloned().unwrap_or(p));
        for (key, value) in &mut node.properties {
            remap_value(key, value, &mapping);
        }
        result
            .source_map
            .insert(format!("native:{old}"), node.id.clone());
        result.content.nodes.insert(node.id.clone(), node);
    }
    for page in &mut result.content.pages {
        page.id = mapping[&page.id].clone();
        page.root_node_id = mapping
            .get(&page.root_node_id)
            .cloned()
            .unwrap_or_else(|| page.root_node_id.clone());
    }
    for (key, value) in &mut result.content.metadata {
        remap_value(key, value, &mapping);
    }
}
fn remap_value(key: &str, value: &mut Value, mapping: &BTreeMap<String, String>) {
    if matches!(
        key,
        "text" | "name" | "title" | "css" | "style" | "extensions" | "attributes"
    ) {
        return;
    }
    match value {
        Value::String(s)
            if matches!(
                key,
                "nodeId"
                    | "pageId"
                    | "rootNodeId"
                    | "componentId"
                    | "definitionId"
                    | "maskId"
                    | "targetId"
                    | "sourceNodeId"
                    | "nodeIds"
                    | "operandIds"
            ) =>
        {
            if let Some(id) = mapping.get(s) {
                *s = id.clone();
            }
        }
        Value::Array(values) => {
            for value in values {
                remap_value(key, value, mapping)
            }
        }
        Value::Object(values) => {
            if key == "overrides" {
                let old = std::mem::take(values);
                for (k, mut v) in old {
                    remap_value("override", &mut v, mapping);
                    values.insert(mapping.get(&k).cloned().unwrap_or(k), v);
                }
            } else {
                for (k, v) in values {
                    remap_value(k, v, mapping);
                }
            }
        }
        _ => (),
    }
}

fn legacy(value: Value, options: &ImportOptions) -> Result<ImportResult, ImportError> {
    let value = value
        .get("document")
        .or_else(|| value.get("state"))
        .unwrap_or(&value);
    let pages = value
        .get("pagesById")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ImportError::Unsupported(
                "unrecognized OMC JSON; binary Yjs/ZIP migration requires the legacy converter"
                    .into(),
            )
        })?;
    let mut result = ImportResult {
        content: DocumentContent {
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Converted legacy document")
                .into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            metadata: BTreeMap::new(),
        },
        resources: Vec::new(),
        diagnostics: Vec::new(),
        source_map: BTreeMap::new(),
    };
    let ordered: Vec<_> = value
        .get("pages")
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(Value::as_str).collect())
        .unwrap_or_else(|| pages.keys().map(String::as_str).collect());
    for (page_index, old_page_id) in ordered.into_iter().enumerate() {
        let page = pages
            .get(old_page_id)
            .ok_or_else(|| ImportError::Invalid("legacy page missing".into()))?;
        let objects = page
            .get("objects")
            .and_then(Value::as_object)
            .ok_or_else(|| ImportError::Invalid("legacy objects missing".into()))?;
        let mut root = Node::new(NodeKind::Frame);
        root.properties.extend([
            ("width".into(), json!(options.width)),
            ("height".into(), json!(options.height)),
        ]);
        let root_id = root.id.clone();
        result.content.nodes.insert(root_id.clone(), root);
        let mut new_page = omc_model::Page::new(
            page.get("name").and_then(Value::as_str).unwrap_or("Page"),
            &root_id,
        );
        new_page.rank = rank(page_index);
        result
            .source_map
            .insert(format!("legacy:{old_page_id}"), new_page.id.clone());
        result.content.pages.push(new_page);
        let mapping: BTreeMap<_, _> = objects
            .keys()
            .map(|id| {
                (
                    id.clone(),
                    if id == "root" {
                        root_id.clone()
                    } else {
                        omc_model::new_id("node")
                    },
                )
            })
            .collect();
        for (index, (old_id, source)) in objects
            .iter()
            .filter(|(id, _)| id.as_str() != "root")
            .enumerate()
        {
            let kind = match source.get("type").and_then(Value::as_str).unwrap_or("rect") {
                "frame" => NodeKind::Frame,
                "group" => NodeKind::Group,
                "rect" => NodeKind::Rect,
                "ellipse" => NodeKind::Ellipse,
                "path" => NodeKind::Path,
                "text" => NodeKind::Text,
                "image" => NodeKind::Image,
                other => {
                    result.diagnostics.push(Diagnostic::unsupported(
                        None,
                        Some("legacy-type"),
                        other,
                    ));
                    NodeKind::Group
                }
            };
            let mut node = Node::new(kind);
            node.id = mapping[old_id].clone();
            node.parent_id = Some(
                source
                    .get("parentId")
                    .and_then(Value::as_str)
                    .and_then(|p| mapping.get(p))
                    .cloned()
                    .unwrap_or_else(|| root_id.clone()),
            );
            node.rank = rank(index);
            node.properties = source
                .as_object()
                .ok_or_else(|| ImportError::Invalid("legacy node is not an object".into()))?
                .iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "id" | "type"
                            | "parentId"
                            | "childIds"
                            | "enclosingFrameId"
                            | "box"
                            | "corners"
                            | "inverseTransform"
                    )
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if node.kind == NodeKind::Text {
                if let Some(content) = source.get("content") {
                    let mut text = String::new();
                    collect_text(content, &mut text);
                    node.properties.insert("text".into(), json!(text));
                    result.diagnostics.push(Diagnostic::unsupported(
                        Some(&node.id),
                        Some("legacy-rich-text"),
                        "Legacy text formatting requires range conversion",
                    ));
                }
            }
            if let Some(fills) = source.get("fills").and_then(Value::as_array) {
                if let Some(color) = fills
                    .first()
                    .and_then(|f| f.get("color"))
                    .and_then(Value::as_str)
                {
                    node.properties.insert("fill".into(), json!(color));
                }
            }
            if let Some(strokes) = source.get("strokes").and_then(Value::as_array) {
                if let Some(stroke) = strokes.first() {
                    if let Some(color) = stroke.get("color") {
                        node.properties.insert("stroke".into(), color.clone());
                    }
                    if let Some(width) = stroke.get("width") {
                        node.properties.insert("strokeWidth".into(), width.clone());
                    }
                }
            }
            result
                .source_map
                .insert(format!("legacy:{old_page_id}:{old_id}"), node.id.clone());
            result.content.nodes.insert(node.id.clone(), node);
        }
    }
    result.content.metadata.insert(
        "migration".into(),
        json!({"source":"legacy-json","independentCopy":true,"sourceRetainedByCaller":true}),
    );
    finish(result, options)
}
fn collect_text(value: &Value, out: &mut String) {
    match value {
        Value::String(s) => out.push_str(s),
        Value::Array(values) => {
            for v in values {
                collect_text(v, out)
            }
        }
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                out.push_str(text);
            } else if let Some(children) = object.get("children") {
                collect_text(children, out);
            }
        }
        _ => (),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_import_remaps_identity() {
        let content = DocumentContent::empty("native");
        let root = content.pages[0].root_node_id.clone();
        let result=import_json(&serde_json::to_string(&json!({"format":"omc.native/1","contentSha256":digest(&serde_jcs::to_vec(&content).unwrap()),"content":content,"assets":[]})).unwrap(),&ImportOptions::default()).unwrap();
        assert_ne!(result.content.pages[0].root_node_id, root);
        assert!(
            result
                .content
                .nodes
                .contains_key(&result.content.pages[0].root_node_id)
        );
    }
    #[test]
    fn rejects_unknown_major_format() {
        assert!(import_json("{\"format\":\"omc.native/2\"}", &ImportOptions::default()).is_err());
    }
}
