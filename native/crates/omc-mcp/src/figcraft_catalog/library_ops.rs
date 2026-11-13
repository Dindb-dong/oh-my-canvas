use super::*;
use serde_json::Map;
use sha2::{Digest, Sha256};
use std::path::Path;

const PUBLICATION: &str = "figcraftPublishedLibrary";
const MAX_FILE: usize = 16 * 1024 * 1024;

pub(super) fn published(metadata: &Properties) -> Option<&Value> {
    metadata
        .get(PUBLICATION)
        .and_then(|record| record.get("extensions"))
}

fn visible(row: &Value) -> bool {
    row["published"] != false
}

pub(super) fn summary(snapshot: &Value) -> Value {
    let mut output = json!({});
    for key in ["id", "name", "version", "description", "time"] {
        output[key] = snapshot[key].clone();
    }
    let mut assets = json!({});
    for key in ["components", "styles", "collections", "variables"] {
        let rows: Vec<_> = snapshot[key]
            .as_object()
            .into_iter()
            .flat_map(Map::values)
            .filter(|row| visible(row))
            .map(|row| {
                let mut result =
                    json!({"id":row["id"],"name":row["name"],"version":row.get("sourceVersion").unwrap_or(&snapshot["version"])});
                for key in ["type", "set", "modes", "collectionId"] {
                    if let Some(value) = row.get(key) {
                        result[if key == "collectionId" {
                            "collection"
                        } else {
                            key
                        }] = value.clone();
                    }
                }
                result
            })
            .collect();
        output[key] = json!(rows.len());
        assets[key] = json!(rows);
    }
    output["assets"] = assets;
    output
}

pub(super) fn asset<'a>(library: &'a Value, key: &str, name: &str) -> Result<(&'a str, &'a Value)> {
    let rows = library["snapshot"][key]
        .as_object()
        .ok_or_else(|| EngineError::invalid(format!("Library has no {key}")))?;
    if let Some((id, row)) = rows.get_key_value(name).filter(|(_, row)| visible(row)) {
        return Ok((id, row));
    }
    let mut matches = rows
        .iter()
        .filter(|(_, row)| visible(row) && row["name"] == name);
    let (id, result) = matches
        .next()
        .ok_or_else(|| EngineError::invalid(format!("Published {key} entry unavailable")))?;
    if matches.next().is_some() {
        return Err(EngineError::invalid(
            "Library asset name is ambiguous; use its ID",
        ));
    }
    Ok((id, result))
}

pub(super) fn library<'a>(entries: &'a Entries, reference: &str) -> Result<&'a Value> {
    let result = entries
        .values()
        .find(|row| row["path"] == reference)
        .map_or_else(|| entry(entries, reference), Ok)?;
    if result["enabled"] == false {
        return Err(EngineError::invalid("Library is disabled"));
    }
    Ok(result)
}

fn list_refs<'a>(params: &'a Value, key: &str) -> Result<Option<BTreeSet<&'a str>>> {
    params
        .get(key)
        .map(|value| {
            value
                .as_array()
                .ok_or_else(|| EngineError::invalid(format!("{key} must be an array")))?
                .iter()
                .map(|value| {
                    value.as_str().ok_or_else(|| {
                        EngineError::invalid(format!("{key} must contain asset IDs or names"))
                    })
                })
                .collect()
        })
        .transpose()
}

fn published_asset(
    row_id: &str,
    name: &str,
    include: &Option<BTreeSet<&str>>,
    exclude: &Option<BTreeSet<&str>>,
) -> bool {
    let in_list = |ids: &BTreeSet<&str>| ids.contains(row_id) || ids.contains(name);
    include
        .as_ref()
        .map_or(!name.starts_with(['.', '_']), in_list)
        && !exclude.as_ref().is_some_and(in_list)
}

fn references(key: &str, value: &Value, dependencies: &mut Dependencies) {
    if let Some(id) = value.as_str() {
        match key {
            "componentId" => {
                dependencies.components.insert(id.to_owned());
            }
            "fillStyleId" | "strokeStyleId" | "effectStyleId" | "textStyleId" => {
                dependencies.styles.insert(id.to_owned());
            }
            "$token" => {
                dependencies.tokens.insert(id.to_owned());
            }
            _ => {}
        }
    }
    match value {
        Value::Array(items) => {
            for value in items {
                references(key, value, dependencies);
            }
        }
        Value::Object(items) => {
            for (key, value) in items {
                references(key, value, dependencies);
            }
        }
        _ => {}
    }
}

#[derive(Default)]
struct Dependencies {
    components: BTreeSet<String>,
    styles: BTreeSet<String>,
    tokens: BTreeSet<String>,
}

pub(super) fn publishable(snapshot: &DocumentSnapshot) -> Value {
    let previous = published(&snapshot.metadata);
    let candidate = |section: &str, id: &str, name: &str| {
        json!({"id":id,"name":name,"selected":previous.map_or(!name.starts_with(['.', '_']), |previous| {
            previous[section].get(id).is_some_and(visible)
        })})
    };
    let components: Vec<_> = snapshot
        .nodes
        .values()
        .filter(|node| node.kind == NodeKind::Component && node.string("libraryId").is_none())
        .map(|node| {
            candidate(
                "components",
                &node.id,
                node.string("name").unwrap_or("Component"),
            )
        })
        .collect();
    let catalog = |namespace: &str, section: &str| -> Vec<Value> {
        resources::catalogs(&snapshot.metadata, namespace)
            .into_iter()
            .filter(|(_, entry)| entry["libraryId"].is_null())
            .map(|(id, entry)| candidate(section, &id, entry["name"].as_str().unwrap_or("")))
            .collect()
    };
    json!({"components":components,"styles":catalog("styles","styles"),"collections":catalog("figcraftCollections","collections")})
}

pub(super) fn publication(snapshot: &DocumentSnapshot, params: &Value) -> Result<(Value, Command)> {
    let include = list_refs(params, "include")?;
    let exclude = list_refs(params, "exclude")?;
    let previous = published(&snapshot.metadata);
    let choose = |section: &str, id: &str, name: &str| {
        if include.is_none()
            && exclude.is_none()
            && let Some(row) = previous.and_then(|previous| previous[section].get(id))
        {
            visible(row)
        } else {
            published_asset(id, name, &include, &exclude)
        }
    };
    let entries = resources::catalogs(&snapshot.metadata, "styles");
    let collections = resources::catalogs(&snapshot.metadata, "figcraftCollections");
    let tokens = resources::catalogs(&snapshot.metadata, "tokens");
    let explicit_components: BTreeSet<_> = snapshot
        .nodes
        .values()
        .filter(|node| node.kind == NodeKind::Component && node.string("libraryId").is_none())
        .filter(|node| {
            choose(
                "components",
                &node.id,
                node.string("name").unwrap_or("Component"),
            )
        })
        .map(|node| node.id.clone())
        .collect();
    let explicit_styles: BTreeSet<_> = entries
        .iter()
        .filter(|(id, row)| {
            row["libraryId"].is_null()
                && choose("styles", id, row["name"].as_str().unwrap_or("Style"))
        })
        .map(|(id, _)| id.clone())
        .collect();
    let explicit_collections: BTreeSet<_> = collections
        .iter()
        .filter(|(id, row)| {
            row["libraryId"].is_null()
                && choose(
                    "collections",
                    id,
                    row["name"].as_str().unwrap_or("Collection"),
                )
        })
        .map(|(id, _)| id.clone())
        .collect();
    let explicit_tokens: BTreeSet<_> = tokens
        .iter()
        .filter(|(_, row)| {
            row["hiddenFromPublishing"] != true
                && row["collectionId"]
                    .as_str()
                    .is_some_and(|id| explicit_collections.contains(id))
        })
        .map(|(id, _)| id.clone())
        .collect();
    let mut deps = Dependencies {
        components: explicit_components.clone(),
        styles: explicit_styles.clone(),
        tokens: explicit_tokens.clone(),
    };
    let mut components = Map::new();
    let mut objects = Map::new();
    while let Some(id) = deps.components.pop_first() {
        if components.contains_key(&id) {
            continue;
        }
        let node = snapshot
            .nodes
            .get(&id)
            .filter(|node| node.kind == NodeKind::Component)
            .ok_or_else(|| EngineError::invalid("Published component dependency is missing"))?;
        let properties = node
            .properties
            .get("componentPropertyDefinitions")
            .cloned()
            .unwrap_or(json!([]));
        for property in properties.as_array().into_iter().flatten() {
            if property["type"] == "swap"
                && let Some(target) = property["default"].as_str().filter(|s| !s.is_empty())
            {
                deps.components.insert(target.into());
            }
        }
        components.insert(
            id.clone(),
            json!({
                "id":id,"name":node.string("name").unwrap_or("Component"),"mainId":id,
                "properties":properties,"published":explicit_components.contains(&id)
            }),
        );
        let mut queue = vec![node];
        let mut subtree = BTreeMap::new();
        while let Some(node) = queue.pop() {
            subtree.insert(&node.id, node);
            queue.extend(children(snapshot, &node.id));
            if objects.contains_key(&node.id) {
                continue;
            }
            if objects.len() == 40 {
                return Err(EngineError::new(
                    "resource_limit",
                    "A native publication can contain up to 40 layers",
                ));
            }
            let mut data = node.properties.clone();
            data.remove("componentPropertyDefinitions");
            data.remove("libraryId");
            for (key, value) in &data {
                references(key, value, &mut deps);
            }
            if let Some(values) = data.get("componentProperties").and_then(Value::as_object) {
                for value in values.values().filter_map(Value::as_str) {
                    if snapshot
                        .nodes
                        .get(value)
                        .is_some_and(|node| node.kind == NodeKind::Component)
                    {
                        deps.components.insert(value.into());
                    }
                }
            }
            objects.insert(node.id.clone(), json!({
                "id":node.id,"type":node.kind,"parentId":node.parent_id,"rank":node.rank,"properties":data,
            }));
        }
        let bytes = serde_json::to_vec(&subtree)
            .map_err(|error| EngineError::invalid(error.to_string()))?;
        components.get_mut(&id).unwrap()["fingerprint"] = json!(hex::encode(Sha256::digest(bytes)));
    }
    let mut styles = Map::new();
    for id in std::mem::take(&mut deps.styles) {
        let mut row = entries
            .get(&id)
            .ok_or_else(|| EngineError::invalid("Published style dependency is missing"))?
            .clone();
        row["published"] = json!(explicit_styles.contains(&id));
        references("value", &row["value"], &mut deps);
        styles.insert(id, row);
    }
    let mut variables = Map::new();
    let mut copied_collections = explicit_collections.clone();
    while let Some(id) = deps.tokens.pop_first() {
        if variables.contains_key(&id) {
            continue;
        }
        let mut row = tokens
            .get(&id)
            .ok_or_else(|| EngineError::invalid("Published variable dependency is missing"))?
            .clone();
        row["published"] = json!(explicit_tokens.contains(&id));
        references("value", &row["value"], &mut deps);
        references("modes", &row["modes"], &mut deps);
        copied_collections.insert(string(&row, "collectionId")?.into());
        variables.insert(id, row);
    }
    let collections: Map<_, _> = copied_collections
        .into_iter()
        .map(|id| {
            let mut row = collections
                .get(&id)
                .cloned()
                .ok_or_else(|| EngineError::invalid("Published variable collection is missing"))?;
            row["published"] = json!(explicit_collections.contains(&id));
            Ok((id, row))
        })
        .collect::<Result<_>>()?;
    let id = previous
        .and_then(|row| row["id"].as_str())
        .map_or_else(|| new_id("library"), str::to_owned);
    let version = previous
        .and_then(|row| row["version"].as_u64())
        .unwrap_or(0)
        .saturating_add(1);
    let library = json!({"id":id,"name":snapshot.title,"version":version,
        "description":params["description"].as_str().unwrap_or(""),"time":timestamp(),
        "components":components,"objects":objects,"styles":styles,"collections":collections,"variables":variables});
    let command = Command::DocumentMetadata {
        properties: Properties::from([(PUBLICATION.into(), json!({"extensions":library}))]),
    };
    Ok((library, command))
}

impl ToolRouter {
    pub(super) fn fig_library_source(&self, path: &str, ingest: bool) -> Result<(String, Value)> {
        if library_team::is_link(path) {
            return self
                .fig_team_libraries
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .map(|publication| (path.to_owned(), publication))
                .ok_or_else(|| {
                    EngineError::invalid("Run library.check to refresh this team library")
                });
        }
        let canonical = std::fs::canonicalize(path).map_err(resources::io_error)?;
        let path = canonical
            .to_str()
            .ok_or_else(|| EngineError::invalid("Library path must be UTF-8"))?;
        let bytes = resources::read_explicit(path, MAX_FILE)?;
        let source = match Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
        {
            Some("figcraft") => {
                let content = self.fig_decode_catalog_archive_with_resources(&bytes, ingest)?;
                let Some((content, _)) = content else {
                    return Ok((path.to_owned(), library_team::decode_publication(&bytes)?));
                };
                content
            }
            Some("omc") => self.fig_decode_native_catalog_bytes(&bytes, ingest)?,
            _ => {
                return Err(EngineError::invalid(
                    "Library path must end in .figcraft or .omc",
                ));
            }
        };
        let snapshot = published(&source.metadata)
            .ok_or_else(|| EngineError::invalid("File has not been published as a library"))?;
        let id = string(snapshot, "id")?;
        if !omc_model::valid_id(id, "library") {
            return Err(EngineError::invalid("Invalid native library ID"));
        }
        Ok((path.into(), snapshot.clone()))
    }
}

impl ToolRouter {
    pub(super) fn fig_local_library_usage(
        &self,
        snapshot: &DocumentSnapshot,
        params: &Value,
    ) -> Result<Value> {
        let days = params["days"]
            .as_f64()
            .map_or(30, |days| days.round().clamp(1., 365.) as u64);
        let links = resources::catalogs(&snapshot.metadata, "libraries");
        let own = published(&snapshot.metadata);
        let (id, publication) = if let Some(reference) = params["library"].as_str() {
            if let Some(own) = own.filter(|own| own["id"] == reference || own["name"] == reference)
            {
                (string(own, "id")?, own)
            } else {
                let library = library(&links, reference)?;
                (string(library, "id")?, &library["snapshot"])
            }
        } else {
            let own =
                own.ok_or_else(|| EngineError::invalid("This document has no published library"))?;
            (string(own, "id")?, own)
        };
        let listing = self.workspace.list(false)?;
        let documents = listing["documents"].as_array().unwrap();
        if documents.len() > 256 {
            return Err(EngineError::new(
                "resource_limit",
                "Local library usage scans up to 256 documents",
            ));
        }
        let mut files = Vec::new();
        let mut components: BTreeMap<String, (String, u64, u64)> = publication["components"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, row)| visible(row))
            .map(|(id, row)| {
                (
                    id.clone(),
                    (row["name"].as_str().unwrap_or("Component").to_owned(), 0, 0),
                )
            })
            .collect();
        let mut instances = 0;
        for doc in documents {
            let document = self.workspace.snapshot(string(doc, "id")?)?;
            let libraries = resources::catalogs(&document.metadata, "libraries");
            let component_map = libraries
                .get(id)
                .and_then(|library| library["componentMap"].as_object());
            let mut reverse: BTreeMap<&str, &str> = component_map
                .into_iter()
                .flatten()
                .filter_map(|(key, value)| value.as_str().map(|raw| (raw, key.as_str())))
                .collect();
            if published(&document.metadata).is_some_and(|publication| publication["id"] == id) {
                reverse.extend(components.keys().map(|key| (key.as_str(), key.as_str())));
            }
            let mut counts = BTreeMap::<String, u64>::new();
            for node in document.nodes.values().filter(|node| {
                node.kind == NodeKind::Instance && node.string("sourceNodeId").is_none()
            }) {
                let Some(source) = node.string("componentId") else {
                    continue;
                };
                if let Some(key) = reverse.get(source) {
                    *counts.entry((*key).into()).or_default() += 1;
                } else if node.string("libraryId") == Some(id)
                    && let Some(key) = document
                        .nodes
                        .get(source)
                        .and_then(|node| node.string("sourceNodeId"))
                {
                    // A removed library's already-used definitions stay in the document.
                    *counts.entry(key.into()).or_default() += 1;
                }
            }
            let count: u64 = counts.values().sum();
            if count == 0 {
                continue;
            }
            instances += count;
            files
                .push(json!({"name":document.title,"updated":null,"instances":count,"detached":0}));
            for (key, count) in counts {
                let (_, total, files) = components.entry(key).or_default();
                *total += count;
                *files += 1;
            }
        }
        files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let mut used: Vec<_> = components
            .into_iter()
            .filter(|(_, (_, instances, _))| *instances > 0)
            .collect();
        used.sort_by(|(a, (_, a_total, _)), (b, (_, b_total, _))| {
            b_total.cmp(a_total).then(a.cmp(b))
        });
        let components = used.into_iter().map(|(id,(name,instances,files))| {
            let name = (!name.is_empty()).then_some(name);
            json!({"id":id,"name":name,"instances":instances,"files":files,"detached":0,"insertions":0,"detachments":0})
        }).collect::<Vec<_>>();
        Ok(json!({
            "id":id,"name":publication["name"],"scope":"local","instances":instances,
            "detached":0,"detachesKnown":false,"days":days,"insertions":0,"detachments":0,
            "actionsKnown":false,"weeks":[],"files":files,"components":components,
            "assetsKnown":false,"styles":[],"variables":[],
        }))
    }

    pub fn publish_library_from_desktop(
        &self,
        session: &str,
        document: &str,
        revision: &omc_model::Revision,
        description: &str,
    ) -> Result<Value> {
        let snapshot = self.workspace.snapshot(document)?;
        if &snapshot.revision() != revision {
            return Err(EngineError::new(
                "stale_revision",
                "Document changed before library publication",
            ));
        }
        let (publication, command) = publication(&snapshot, &json!({"description":description}))?;
        let mut envelope = CommandEnvelope::new(document, &revision.epoch, command);
        envelope.preconditions = Preconditions::Revision {
            revision: revision.clone(),
        };
        self.execute_observed(session, envelope)?;
        Ok(summary(&publication))
    }
}
