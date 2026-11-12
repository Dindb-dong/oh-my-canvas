use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(in crate::figcraft) fn commands(before: &DocumentContent, after: &DocumentContent) -> Result<Vec<Command>> {
    let mut changes = Vec::new();
    let old_pages: BTreeMap<_, _> = before.pages.iter().map(|page| (&page.id, page)).collect();
    let new_pages: BTreeMap<_, _> = after.pages.iter().map(|page| (&page.id, page)).collect();
    for page in &after.pages {
        if let Some(old) = old_pages.get(&page.id) {
            if old.title != page.title {
                changes.push(Command::PageRename {
                    page_id: page.id.clone(),
                    title: page.title.clone(),
                });
            }
            if old.rank != page.rank {
                changes.push(Command::PageMove {
                    page_id: page.id.clone(),
                    rank: page.rank.clone(),
                });
            }
        } else {
            changes.push(Command::PageCreate {
                page: page.clone(),
                root: after.nodes[&page.root_node_id].clone(),
            });
        }
    }
    let new_roots: BTreeSet<_> = after.pages.iter().map(|page| &page.root_node_id).collect();
    let mut nodes: Vec<_> = after
        .nodes
        .values()
        .filter(|node| before.nodes.contains_key(&node.id) || !new_roots.contains(&node.id))
        .collect();
    nodes.sort_by_cached_key(|node| {
        let mut depth = 0;
        let mut parent = &node.parent_id;
        while let Some(id) = parent {
            depth += 1;
            parent = &after.nodes[id].parent_id;
        }
        depth
    });
    for node in nodes {
        let Some(old) = before.nodes.get(&node.id) else {
            changes.push(Command::NodeCreate { node: node.clone() });
            continue;
        };
        if node.kind != old.kind || node.home_shard != old.home_shard {
            return Err(EngineError::new(
                "unsupported_feature",
                "a branch cannot replace an existing node identity",
            ));
        }
        if node.parent_id != old.parent_id || node.rank != old.rank {
            changes.push(Command::NodeMove {
                node_id: node.id.clone(),
                parent_id: node.parent_id.clone(),
                rank: node.rank.clone(),
            });
        }
        if node.kind == NodeKind::Text
            && (old.properties.get("text") != node.properties.get("text")
                || old.properties.get("textRuns") != node.properties.get("textRuns"))
        {
            crate::libraries::update_text(old, node, &mut changes)?;
        }
        let structural =
            |key: &str| !matches!(key, "text" | "textRuns") || node.kind != NodeKind::Text;
        let changed: Properties = node
            .properties
            .iter()
            .filter(|(key, value)| structural(key) && old.properties.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if !changed.is_empty() {
            changes.push(Command::NodeSet {
                node_id: node.id.clone(),
                properties: changed,
            });
        }
        let removed: Vec<_> = old
            .properties
            .keys()
            .filter(|key| structural(key) && !node.properties.contains_key(*key))
            .cloned()
            .collect();
        if !removed.is_empty() {
            changes.push(Command::NodeUnset {
                node_id: node.id.clone(),
                properties: removed,
            });
        }
    }
    let deleted: Vec<_> = before
        .nodes
        .values()
        .filter(|node| {
            !after.nodes.contains_key(&node.id)
                && node
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent| after.nodes.contains_key(parent))
        })
        .map(|node| node.id.clone())
        .collect();
    if !deleted.is_empty() {
        changes.push(Command::NodeDelete { node_ids: deleted });
    }
    for page in &before.pages {
        if !new_pages.contains_key(&page.id) {
            changes.push(Command::PageDelete {
                page_id: page.id.clone(),
            });
        }
    }
    if before.title != after.title {
        changes.push(Command::DocumentRename {
            title: after.title.clone(),
        });
    }
    let metadata: Properties = after
        .metadata
        .iter()
        .filter(|(key, value)| before.metadata.get(*key) != Some(*value))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if before
        .metadata
        .keys()
        .any(|key| !after.metadata.contains_key(key))
    {
        return Err(EngineError::new(
            "unsupported_feature",
            "branch metadata removal is unavailable",
        ));
    }
    if !metadata.is_empty() {
        changes.push(Command::DocumentMetadata {
            properties: metadata,
        });
    }
    Ok(changes)
}
