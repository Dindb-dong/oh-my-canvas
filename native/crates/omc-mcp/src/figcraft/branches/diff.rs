use super::*;
use omc_model::Page;
use serde_json::Map;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Review {
    pub content: DocumentContent,
    pub conflicts: Vec<Value>,
}

const REVIEW_LIMIT: usize = 500;

struct Merge<'a> {
    resolutions: &'a Map<String, Value>,
    conflicts: Vec<Value>,
}

#[derive(Clone, Copy)]
struct Field<'a> {
    section: &'a str,
    id: &'a str,
    name: &'a str,
    property: &'a str,
}

impl Merge<'_> {
    fn value(
        &mut self,
        field: Field<'_>,
        base: Option<&Value>,
        branch: Option<&Value>,
        main: Option<&Value>,
    ) -> Option<Value> {
        if branch == main || main == base {
            return branch.cloned();
        }
        if branch == base {
            return main.cloned();
        }
        let key = format!("{}/{}/{}", field.section, field.id, field.property);
        let mut conflict = json!({
            "key":key,"name":field.name,"property":field.property,"branch":branch,"main":main,
        });
        if field.section != "document" {
            conflict["id"] = json!(field.id);
        }
        if field.property == "existence" {
            if let Some(deleted) = branch
                .is_none()
                .then_some("branch")
                .or(main.is_none().then_some("main"))
            {
                conflict["deletedBy"] = json!(deleted);
            }
        }
        self.conflicts.push(conflict);
        if self.resolutions.get(&key).and_then(Value::as_str) == Some("branch") {
            branch.cloned()
        } else {
            main.cloned()
        }
    }

    fn object(
        &mut self,
        field: Field<'_>,
        base: &Map<String, Value>,
        branch: &Map<String, Value>,
        main: &Map<String, Value>,
    ) -> Map<String, Value> {
        let keys = base
            .keys()
            .chain(branch.keys())
            .chain(main.keys())
            .collect::<BTreeSet<_>>();
        keys.into_iter()
            .filter_map(|key| {
                let value = self.value(
                    Field {
                        property: key,
                        ..field
                    },
                    base.get(key),
                    branch.get(key),
                    main.get(key),
                )?;
                Some((key.clone(), value))
            })
            .collect()
    }
}

fn node_values(node: &Node) -> Map<String, Value> {
    let mut properties: Map<_, _> = node
        .properties
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let text = properties.remove("text");
    let runs = properties.remove("textRuns");
    if text.is_some() || runs.is_some() {
        properties.insert("$text".into(), json!({"text":text,"textRuns":runs}));
    }
    properties.insert(
        "$placement".into(),
        json!({"parentId":node.parent_id,"rank":node.rank}),
    );
    properties
}

fn merge_node(
    merge: &mut Merge<'_>,
    field: Field<'_>,
    base: Option<&Node>,
    branch: Option<&Node>,
    main: Option<&Node>,
) -> Result<Option<Node>> {
    if let (Some(base), Some(branch), Some(main)) = (base, branch, main) {
        let mut values = merge.object(
            field,
            &node_values(base),
            &node_values(branch),
            &node_values(main),
        );
        let mut node = main.clone();
        if let Some(placement) = values.remove("$placement") {
            node.parent_id = placement["parentId"].as_str().map(str::to_owned);
            node.rank = string(&placement, "rank")?.into();
        }
        if let Some(text) = values.remove("$text") {
            values.extend(
                text.as_object()
                    .unwrap()
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
        node.properties = values.into_iter().collect();
        return Ok(Some(node));
    }
    let base = base.map(|value| json!(value));
    let branch = branch.map(|value| json!(value));
    let main = main.map(|value| json!(value));
    merge
        .value(
            Field {
                property: "existence",
                ..field
            },
            base.as_ref(),
            branch.as_ref(),
            main.as_ref(),
        )
        .map(|value| {
            serde_json::from_value(value).map_err(|error| EngineError::invalid(error.to_string()))
        })
        .transpose()
}

fn page_map(content: &DocumentContent) -> BTreeMap<&str, &Page> {
    content
        .pages
        .iter()
        .map(|page| (page.id.as_str(), page))
        .collect()
}

pub(super) fn review(
    base: &DocumentContent,
    branch: &DocumentContent,
    main: &DocumentContent,
    resolutions: &Map<String, Value>,
) -> Result<Review> {
    let mut merge = Merge {
        resolutions,
        conflicts: Vec::new(),
    };
    let nodes = base
        .nodes
        .keys()
        .chain(branch.nodes.keys())
        .chain(main.nodes.keys())
        .collect::<BTreeSet<_>>();
    let mut merged_nodes = BTreeMap::new();
    for id in nodes {
        let base = base.nodes.get(id);
        let branch = branch.nodes.get(id);
        let main = main.nodes.get(id);
        let name = main
            .or(branch)
            .or(base)
            .and_then(|node| node.string("name"))
            .unwrap_or("Layer");
        let field = Field {
            section: "layer",
            id,
            name,
            property: "",
        };
        if let Some(node) = merge_node(&mut merge, field, base, branch, main)? {
            merged_nodes.insert(id.clone(), node);
        }
        if merge.conflicts.len() > REVIEW_LIMIT {
            return Err(EngineError::new(
                "resource_limit",
                "more than 500 branch conflicts",
            ));
        }
    }
    let base_pages = page_map(base);
    let branch_pages = page_map(branch);
    let main_pages = page_map(main);
    let ids = base_pages
        .keys()
        .chain(branch_pages.keys())
        .chain(main_pages.keys())
        .collect::<BTreeSet<_>>();
    let mut pages = Vec::new();
    for id in ids {
        let base = base_pages.get(id).map(|value| json!(value));
        let branch = branch_pages.get(id).map(|value| json!(value));
        let main = main_pages.get(id).map(|value| json!(value));
        let name = main
            .as_ref()
            .or(branch.as_ref())
            .or(base.as_ref())
            .and_then(|page| page["title"].as_str())
            .unwrap_or("Page");
        let field = Field {
            section: "page",
            id,
            name,
            property: "existence",
        };
        let value = if let (Some(base), Some(branch), Some(main)) = (&base, &branch, &main) {
            Some(Value::Object(merge.object(
                field,
                base.as_object().unwrap(),
                branch.as_object().unwrap(),
                main.as_object().unwrap(),
            )))
        } else {
            merge.value(field, base.as_ref(), branch.as_ref(), main.as_ref())
        };
        if let Some(page) = value {
            pages.push(
                serde_json::from_value::<Page>(page)
                    .map_err(|error| EngineError::invalid(error.to_string()))?,
            );
        }
    }
    pages.sort_by(|a, b| (&a.rank, &a.id).cmp(&(&b.rank, &b.id)));
    let metadata = merge.object(
        Field {
            section: "document",
            id: "metadata",
            name: "Document",
            property: "",
        },
        &base.metadata.clone().into_iter().collect(),
        &branch.metadata.clone().into_iter().collect(),
        &main.metadata.clone().into_iter().collect(),
    );
    if merge.conflicts.len() > REVIEW_LIMIT {
        return Err(EngineError::new(
            "resource_limit",
            "more than 500 branch conflicts",
        ));
    }
    Ok(Review {
        content: DocumentContent {
            title: main.title.clone(),
            pages,
            nodes: merged_nodes,
            metadata: metadata.into_iter().collect(),
        },
        conflicts: merge.conflicts,
    })
}

pub(super) fn changes(base: &DocumentContent, current: &DocumentContent) -> Value {
    let ids = base
        .nodes
        .keys()
        .chain(current.nodes.keys())
        .collect::<BTreeSet<_>>();
    let layers = ids
        .into_iter()
        .filter_map(|id| {
            let before = base.nodes.get(id);
            let after = current.nodes.get(id);
            if before == after {
                return None;
            }
            let name = after
                .or(before)
                .and_then(|node| node.string("name"))
                .unwrap_or("Layer");
            let mut change = json!({"id":id,"name":name,"change":match (before, after) {
                (None, _) => "added",
                (_, None) => "deleted",
                _ => "modified",
            }});
            if let (Some(before), Some(after)) = (before, after) {
                let before = node_values(before);
                let after = node_values(after);
                let keys = before.keys().chain(after.keys()).collect::<BTreeSet<_>>();
                change["properties"] = json!(
                    keys.into_iter()
                        .filter(|key| before.get(*key) != after.get(*key))
                        .collect::<Vec<_>>()
                );
            }
            Some(change)
        })
        .take(REVIEW_LIMIT + 1)
        .collect::<Vec<_>>();
    let mut document = Vec::new();
    if base.title != current.title {
        document.push("name");
    }
    if base.pages != current.pages {
        document.push("pages");
    }
    if base.metadata != current.metadata {
        document.push("metadata");
    }
    json!({"layers":&layers[..layers.len().min(REVIEW_LIMIT)],"document":document,"truncated":layers.len()>REVIEW_LIMIT})
}
