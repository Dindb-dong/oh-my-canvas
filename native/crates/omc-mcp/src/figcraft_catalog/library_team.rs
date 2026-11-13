//! FigCraft v0.17 team library archives and linked native catalog state.
mod assets;

use super::*;
use crate::figcraft_file::{read_properties, write_properties};
use serde_json::Map;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const MANIFEST: &str = "library/manifest.json";
const DOCUMENT: &str = "library/document.json";
const MAX_ARCHIVE: usize = 16 * 1024 * 1024;
const MAX_LINKS: usize = 32;
const SOURCE_PAGE: u64 = 1;

pub struct TeamLibraryPublication {
    pub document: Value,
    pub archive: Vec<u8>,
    pub manifest: Value,
}

pub(crate) fn is_link(path: &str) -> bool {
    let path = path.trim_start().to_ascii_lowercase();
    ["figcraft://", "ws://", "wss://"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

pub(crate) fn display_path(path: &str) -> String {
    let Some((base, query)) = path.split_once('?').filter(|_| is_link(path)) else {
        return path.to_owned();
    };
    let query = query
        .split('&')
        .map(|part| {
            if part.starts_with("token=") {
                "token=…"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{query}")
}

fn invalid(error: impl std::fmt::Display) -> EngineError {
    EngineError::invalid(error.to_string())
}

fn numeric_id(key: &str) -> u64 {
    let hash = Sha256::digest(key.as_bytes());
    (u64::from_be_bytes(hash[..8].try_into().expect("SHA-256 prefix")) & ((1 << 51) - 1)) + 2
}

fn rows<'a>(value: &'a Value, key: &str) -> Result<&'a Map<String, Value>> {
    value[key]
        .as_object()
        .ok_or_else(|| invalid(format!("Missing library {key}")))
}

fn archive_document(publication: &Value, assets: assets::Assets) -> Result<(Value, Vec<Value>)> {
    let components = rows(publication, "components")?;
    let objects = rows(publication, "objects")?;
    let ids = objects
        .keys()
        .map(|id| (id.as_str(), numeric_id(id)))
        .collect::<BTreeMap<_, _>>();
    if ids.values().copied().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err(invalid("Library node ID collision"));
    }
    let mut children: BTreeMap<u64, Vec<(String, u64)>> = BTreeMap::new();
    let mut records = Map::new();
    for (id, object) in objects {
        let kind: NodeKind = serde_json::from_value(object["type"].clone()).map_err(invalid)?;
        let mut node = Node::new(kind.clone());
        node.properties = serde_json::from_value(object["properties"].clone()).map_err(invalid)?;
        if matches!(kind, NodeKind::Component) {
            node.properties.remove("componentDefinition");

            if !components[id]["properties"]
                .as_array()
                .is_some_and(Vec::is_empty)
            {
                return Err(unsupported(
                    "Team archive export for typed component properties",
                ));
            }
            node.kind = NodeKind::Frame;
        }
        let component = if matches!(kind, NodeKind::Instance) {
            if node
                .properties
                .remove("componentProperties")
                .is_some_and(|props| props.as_object().is_none_or(|props| !props.is_empty()))
            {
                return Err(unsupported(
                    "Team archive export for component property overrides",
                ));
            }
            node.kind = NodeKind::Frame;
            Some(
                node.properties
                    .remove("componentId")
                    .and_then(|id| ids.get(id.as_str()?).copied())
                    .ok_or_else(|| invalid("Library instance has no component"))?,
            )
        } else {
            None
        };
        let numeric = ids[id.as_str()];
        let parent = object["parentId"]
            .as_str()
            .and_then(|parent| ids.get(parent).copied())
            .unwrap_or(SOURCE_PAGE);
        let style_links = assets::take_style_links(&mut node.properties);
        let mut record = write_properties(&node, numeric as usize)?;
        if !style_links.is_empty() {
            record["styles"] = json!(style_links);
        }
        record["parent"] = json!(parent);
        if kind == NodeKind::Component {
            record["type"] = json!("component");
        } else if let Some(component) = component {
            record["type"] = json!("instance");
            record["component"] = json!(component);
        }
        children
            .entry(parent)
            .or_default()
            .push((object["rank"].as_str().unwrap_or("").to_owned(), numeric));
        records.insert(numeric.to_string(), record);
    }
    records.insert(
        SOURCE_PAGE.to_string(),
        json!({"id":SOURCE_PAGE,"name":"Library components","type":"page","width":0,"height":0}),
    );
    for (id, mut children) in children {
        children.sort_unstable();
        records[&id.to_string()]["children"] =
            json!(children.into_iter().map(|(_, id)| id).collect::<Vec<_>>());
    }
    let component_assets = components
        .values()
        .map(|component| {
            let id = string(component, "id")?;
            Ok(json!({"id":ids[id],"name":component["name"],"set":false,
            "version":publication["version"],"published":component["published"]}))
        })
        .collect::<Result<Vec<_>>>()?;
    let document = json!({"format":"figcraft","version":1,"imageIndex":[],"name":publication["name"],
        "pages":[SOURCE_PAGE],"nodes":records,"next_id":ids.values().max().copied().unwrap_or(SOURCE_PAGE)+1,
        "styles":assets.styles,"variables":{"collections":assets.collections,"variables":assets.variables},"current_page":SOURCE_PAGE,
        "document_colors":[],"comments":[]});
    Ok((document, component_assets))
}

fn pack(publication: &Value, previous: Option<&(Value, Value)>) -> Result<TeamLibraryPublication> {
    let (assets, manifest_assets) = assets::encode(publication)?;
    let (document, components) = archive_document(publication, assets)?;
    let mut manifest = json!({"id":publication["id"],"name":publication["name"],"version":publication["version"],
        "description":publication["description"],"time":publication["time"],"components":components,
        "styles":manifest_assets.styles,"collections":manifest_assets.collections,"variables":manifest_assets.variables});
    if let Some((old_manifest, old_document)) = previous {
        keep_asset_versions(&mut manifest, &document, old_manifest, old_document)?;
    }
    let holder = json!({"format":"figcraft","version":1,"imageIndex":[],"name":publication["name"],
        "pages":[1],"nodes":{"1":{"id":1,"name":"Page 1","type":"page","width":0,"height":0}},"next_id":2,
        "styles":[],"variables":{"collections":[],"variables":[]},"current_page":1,"document_colors":[],"comments":[]});
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, value) in [
        ("document.json", &holder),
        (MANIFEST, &manifest),
        (DOCUMENT, &document),
    ] {
        zip.start_file(name, options).map_err(invalid)?;
        zip.write_all(&serde_json::to_vec(value).map_err(invalid)?)
            .map_err(invalid)?;
    }
    let archive = zip.finish().map_err(invalid)?.into_inner();
    Ok(TeamLibraryPublication {
        document,
        archive,
        manifest: library_ops::summary(publication),
    })
}

fn same_subtree(current: &Value, previous: &Value, root: u64) -> bool {
    let mut pending = vec![root];
    let mut seen = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) || seen.len() > 80 {
            return false;
        }
        let id = id.to_string();
        let Some(node) = current["nodes"].get(&id) else {
            return false;
        };
        if previous["nodes"].get(&id) != Some(node) {
            return false;
        }
        pending.extend(
            node["children"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64),
        );
    }
    true
}

fn keep_asset_versions(
    manifest: &mut Value,
    document: &Value,
    old_manifest: &Value,
    old_document: &Value,
) -> Result<()> {
    for section in ["components", "styles", "collections", "variables"] {
        let Some(previous) = old_manifest[section].as_array() else {
            continue;
        };
        let assets = manifest[section]
            .as_array_mut()
            .ok_or_else(|| invalid("Missing archive asset table"))?;
        for asset in assets {
            let id = &asset["id"];
            let Some(old) = previous.iter().find(|row| row["id"] == *id) else {
                continue;
            };
            let unchanged = if section == "components" {
                id.as_u64()
                    .is_some_and(|id| same_subtree(document, old_document, id))
            } else {
                let find = |doc: &Value| {
                    let list = if section == "styles" {
                        &doc[section]
                    } else {
                        &doc["variables"][section]
                    };
                    list.as_array()
                        .and_then(|rows| rows.iter().find(|row| row["id"] == *id))
                        .cloned()
                };
                find(document) == find(old_document)
            };
            if unchanged && old["version"].is_u64() {
                asset["version"] = old["version"].clone();
            }
        }
    }
    Ok(())
}

fn unpack(bytes: &[u8]) -> Result<(Value, Value)> {
    if bytes.len() > MAX_ARCHIVE {
        return Err(invalid("Team library archive exceeds 16 MiB"));
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(invalid)?;
    let mut budget = MAX_ARCHIVE as u64;
    let mut read = |name| {
        let member = zip.by_name(name).map_err(invalid)?;
        if member.size() > budget {
            return Err(invalid("Team library archive exceeds 16 MiB expanded"));
        }
        let mut decoded = Vec::new();
        member
            .take(budget + 1)
            .read_to_end(&mut decoded)
            .map_err(invalid)?;
        budget = budget
            .checked_sub(decoded.len() as u64)
            .ok_or_else(|| invalid("Team library archive exceeds 16 MiB expanded"))?;
        omc_protocol::decode_json_with_limit(&decoded, MAX_ARCHIVE)
    };
    Ok((read(MANIFEST)?, read(DOCUMENT)?))
}

pub(super) fn decode_publication(bytes: &[u8]) -> Result<Value> {
    let (manifest, doc) = unpack(bytes)?;
    let id = string(&manifest, "id")?;
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(invalid("Invalid team library ID"));
    }
    if doc["format"] != "figcraft" || doc["version"] != 1 {
        return Err(invalid("FigCraft v1 team library document required"));
    }
    let catalog = assets::decode(&doc, &manifest)?;
    let nodes = rows(&doc, "nodes")?;
    if nodes.len() > 80 {
        return Err(invalid("Team library contains more than 80 layers"));
    }
    let assets = manifest["components"]
        .as_array()
        .ok_or_else(|| invalid("Missing team library components"))?;
    let mut components = Map::new();
    let mut objects = Map::new();
    let key = |id: u64| format!("figcraft-{id}");
    for asset in assets {
        let id = asset["id"]
            .as_u64()
            .ok_or_else(|| invalid("Invalid library component ID"))?;
        let root = &doc["nodes"][id.to_string()];
        if asset["set"] == true || root["type"] != "component" {
            return Err(unsupported("Team archive import for variant sets"));
        }
        let raw = key(id);
        components.insert(
            raw.clone(),
            json!({"id":raw,"name":asset["name"],"mainId":raw,
            "published":asset["published"]!=false,"properties":[],"sourceVersion":asset["version"],
            "fingerprint":asset["version"].as_u64().unwrap_or_default().to_string()}),
        );
    }
    let ranks: BTreeMap<u64, String> = nodes
        .values()
        .flat_map(|node| {
            let mut previous = None;
            node["children"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |child| {
                    let rank = rank_between(previous.as_deref(), None)?;
                    previous = Some(rank.clone());
                    Some((child.as_u64()?, rank))
                })
        })
        .collect();
    for node in nodes.values().filter(|node| node["type"] != "page") {
        let id = node["id"]
            .as_u64()
            .ok_or_else(|| invalid("Invalid library layer ID"))?;
        let raw = key(id);
        let kind = match node["type"].as_str() {
            Some("frame") => NodeKind::Frame,
            Some("group") => NodeKind::Group,
            Some("component") => NodeKind::Component,
            Some("instance") => NodeKind::Instance,
            Some("rectangle") => NodeKind::Rect,
            Some("ellipse") => NodeKind::Ellipse,
            Some("line") => NodeKind::Line,
            Some("text") => NodeKind::Text,
            _ => return Err(unsupported("Layer kind in FigCraft team library")),
        };
        let mut record = node.clone();
        let styles = record
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid library node"))?
            .remove("styles");
        if matches!(kind, NodeKind::Component | NodeKind::Instance) {
            let record = record.as_object_mut().unwrap();
            if record
                .remove("props")
                .is_some_and(|props| props.as_object().is_none_or(|props| !props.is_empty()))
            {
                return Err(unsupported("Typed component properties in team library"));
            }
            record.remove("description");
            record.remove("prop_order");
            record.remove("component");
        }
        let props_kind = if matches!(kind, NodeKind::Component | NodeKind::Instance) {
            "frame"
        } else {
            string(node, "type")?
        };
        let mut properties = read_properties(&record, props_kind)?;
        if let Some(styles) = styles {
            assets::insert_style_links(&styles, &mut properties);
        }
        if kind == NodeKind::Instance {
            properties.insert(
                "componentId".into(),
                json!(key(node["component"]
                    .as_u64()
                    .ok_or_else(|| invalid("Invalid instance component"))?)),
            );
        }
        let parent = node["parent"]
            .as_u64()
            .filter(|id| {
                nodes
                    .get(&id.to_string())
                    .is_some_and(|node| node["type"] != "page")
            })
            .map(key);
        objects.insert(raw.clone(), json!({"id":raw,"type":kind,"parentId":parent,
            "rank":ranks.get(&id).cloned().unwrap_or_else(omc_model::initial_rank),"properties":properties}));
    }
    Ok(
        json!({"id":id,"name":manifest["name"],"version":manifest["version"],"description":manifest["description"],
        "time":manifest["time"],"components":components,"objects":objects,"styles":catalog.styles,"collections":catalog.collections,"variables":catalog.variables}),
    )
}

impl ToolRouter {
    pub fn fig_team_publish_link(
        &self,
        session: &str,
        document: &str,
        remember: Option<&str>,
    ) -> Option<String> {
        let mut links = self.fig_team_publish_links.lock().unwrap();
        let key = (session.to_owned(), document.to_owned());
        if let Some(link) = remember {
            links.insert(key, link.to_owned())
        } else {
            links.get(&key).cloned()
        }
    }

    pub fn fig_team_library_document(
        &self,
        session: &str,
        args: &Value,
    ) -> Result<DocumentSnapshot> {
        let document = args["document"].as_str().map(native_id).transpose()?;
        self.workspace
            .snapshot(&self.workspace.target(session, document.as_deref())?)
    }

    pub fn fig_team_library_publish(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        params: &Value,
        previous: Option<&[u8]>,
    ) -> Result<TeamLibraryPublication> {
        let mut request = params.clone();
        if self.state(session, &snapshot.id).is_err() {
            self.context_from(session, snapshot)?;
        }
        for field in ["include", "exclude"] {
            if let Some(ids) = request.get_mut(field).and_then(Value::as_array_mut) {
                for id in ids {
                    if id.is_u64() {
                        *id = json!(self.fig_layer(session, snapshot, id)?);
                    }
                }
            }
        }
        let previous = previous.map(unpack).transpose()?;
        if let Some((manifest, _)) = &previous {
            if request.get("description").is_none() {
                request["description"] = manifest["description"].clone();
            }
        }
        let (mut publication, _) = library_ops::publication(snapshot, &request)?;
        if let Some((previous, _)) = &previous {
            publication["id"] = json!(string(previous, "id")?);
            let version = previous["version"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid server library version"))?;
            publication["version"] = json!(
                version
                    .checked_add(1)
                    .ok_or_else(|| invalid("Library version exhausted"))?
            );
        } else {
            publication["version"] = json!(1);
        }
        if ["components", "styles", "collections"]
            .into_iter()
            .all(|key| publication[key].as_object().is_none_or(Map::is_empty))
        {
            return Err(invalid(
                "There are no components, styles or variable collections to publish",
            ));
        }
        pack(&publication, previous.as_ref())
    }

    pub fn fig_team_library_instance_counts(
        &self,
        snapshot: &DocumentSnapshot,
        id: &str,
    ) -> Vec<(u64, u32)> {
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        let Some(mapping) = libraries
            .get(id)
            .and_then(|row| row["componentMap"].as_object())
        else {
            return Vec::new();
        };
        let roots: BTreeMap<_, _> = mapping
            .iter()
            .filter_map(|(key, value)| {
                Some((
                    value.as_str()?,
                    key.strip_prefix("figcraft-")?.parse::<u64>().ok()?,
                ))
            })
            .collect();
        let mut counts = BTreeMap::<u64, u32>::new();
        for node in snapshot
            .nodes
            .values()
            .filter(|node| node.kind == NodeKind::Instance && node.string("sourceNodeId").is_none())
        {
            if let Some(root) = node
                .string("componentId")
                .and_then(|component| roots.get(component))
            {
                let count = counts.entry(*root).or_default();
                *count = count.saturating_add(1);
            }
        }
        counts.into_iter().take(1000).collect()
    }

    pub fn fig_team_library_asset_counts(
        &self,
        snapshot: &DocumentSnapshot,
        id: &str,
    ) -> Option<(Vec<(String, u32)>, Vec<(String, u32)>)> {
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        let library = libraries.get(id)?;
        let reverse = |key| {
            library[key]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(source, local)| Some((local.as_str()?, source.as_str())))
                .collect::<BTreeMap<_, _>>()
        };
        let styles = reverse("styleMap");
        let variables = reverse("variableMap");
        if styles.is_empty() && variables.is_empty() {
            return None;
        }
        let mut style_totals = BTreeMap::<&str, u32>::new();
        let mut variable_totals = BTreeMap::<&str, u32>::new();
        for node in snapshot
            .nodes
            .values()
            .filter(|node| node.kind != NodeKind::Instance && node.string("sourceNodeId").is_none())
        {
            let styles = [
                "fillStyleId",
                "strokeStyleId",
                "textStyleId",
                "effectStyleId",
            ]
            .into_iter()
            .filter_map(|key| node.string(key).and_then(|id| styles.get(id)).copied())
            .collect::<BTreeSet<_>>();
            for style in styles {
                *style_totals.entry(style).or_default() += 1;
            }
            let mut references = Vec::new();
            for value in node.properties.values() {
                variable_ops::references(value, &mut references);
            }
            let variables = references
                .into_iter()
                .filter_map(|id| variables.get(id).copied())
                .collect::<BTreeSet<_>>();
            for variable in variables {
                *variable_totals.entry(variable).or_default() += 1;
            }
        }
        let most_used = |counts: BTreeMap<&str, u32>| {
            let mut counts = counts
                .into_iter()
                .map(|(id, count)| (id.to_owned(), count))
                .collect::<Vec<_>>();
            counts.sort_by(|(a, aa), (b, bb)| bb.cmp(aa).then(a.cmp(b)));
            counts.truncate(250);
            counts
        };
        Some((most_used(style_totals), most_used(variable_totals)))
    }

    pub fn fig_team_library_usage_link(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        selected: Option<&str>,
    ) -> Result<Option<(Option<String>, String)>> {
        let Some(selected) = selected else {
            return Ok(self
                .fig_team_publish_link(session, &snapshot.id, None)
                .map(|path| (None, path)));
        };
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        let Some(library) = libraries
            .values()
            .find(|row| row["enabled"] != false && row["path"] == selected)
            .or_else(|| library_ops::library(&libraries, selected).ok())
        else {
            return Ok(None);
        };
        Ok(library["path"]
            .as_str()
            .filter(|path| is_link(path))
            .map(|path| (library["id"].as_str().map(str::to_owned), path.to_owned())))
    }

    pub fn fig_team_library_links(
        &self,
        snapshot: &DocumentSnapshot,
        selected: Option<&str>,
    ) -> Result<Vec<(String, String)>> {
        let libraries = resources::catalogs(&snapshot.metadata, "libraries");
        let links = if let Some(selected) = selected {
            let library = libraries
                .values()
                .find(|row| row["enabled"] != false && row["path"] == selected)
                .map_or_else(|| library_ops::library(&libraries, selected), Ok)?;
            let path = library["path"]
                .as_str()
                .filter(|path| is_link(path))
                .ok_or_else(|| invalid("The selected library is a local file"))?;
            vec![(string(library, "id")?.to_owned(), path.to_owned())]
        } else {
            libraries
                .values()
                .filter(|row| row["enabled"] != false)
                .filter_map(|row| {
                    Some((
                        row["id"].as_str()?.to_owned(),
                        row["path"].as_str()?.to_owned(),
                    ))
                })
                .filter(|(_, path)| is_link(path))
                .collect::<Vec<_>>()
        };
        if links.len() > MAX_LINKS {
            return Err(invalid("Check at most 32 team libraries per call"));
        }
        Ok(links)
    }

    pub fn fig_team_library_cache(
        &self,
        path: &str,
        expected: Option<&str>,
        version: u64,
        bytes: &[u8],
    ) -> Result<Value> {
        let publication = decode_publication(bytes)?;
        if publication["version"] != version || expected.is_some_and(|id| publication["id"] != id) {
            return Err(invalid(
                "Team library identity or version changed unexpectedly",
            ));
        }
        let mut cached = self.fig_team_libraries.lock().unwrap();
        if let Some(current) = cached.get(path)
            && current["id"] == publication["id"]
            && current["version"].as_u64() > Some(version)
        {
            return Ok(current.clone());
        }
        if cached.len() >= MAX_LINKS
            && !cached.contains_key(path)
            && let Some(first) = cached.keys().next().cloned()
        {
            cached.remove(&first);
        }
        cached.insert(path.to_owned(), publication.clone());
        Ok(publication)
    }

    pub fn fig_team_library_attach(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        path: &str,
        publication: Value,
    ) -> Result<Value> {
        let snapshot = self.workspace.snapshot(&snapshot.id)?;
        self.context_from(session, &snapshot)?;
        self.fig_attach_library(session, &snapshot, path, publication)
    }
}
