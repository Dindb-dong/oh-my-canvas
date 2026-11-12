use omc_model::{DocumentSnapshot, Node, NodeKind};
use omc_scene::Scene;
use serde_json::{Value, json};

const CLICK_TARGET: &str = "prototypeClickTargetId";

fn page_root<'a>(document: &'a DocumentSnapshot, page_id: &str) -> Option<&'a str> {
    document
        .pages
        .iter()
        .find(|page| page.id == page_id)
        .map(|page| page.root_node_id.as_str())
}

fn top_layer<'a>(document: &'a DocumentSnapshot, root: &str, id: &str) -> Option<&'a Node> {
    let mut node = document.nodes.get(id)?;
    // The model bounds validated document ancestry at 256 edges.
    for _ in 0..256 {
        let parent = node.parent_id.as_deref()?;
        if parent == root {
            return Some(node);
        }
        node = document.nodes.get(parent)?;
    }
    None
}

fn is_visible_frame(node: &Node) -> bool {
    node.kind == NodeKind::Frame && !crate::commands::layer_hidden(node)
}

fn frames<'a>(document: &'a DocumentSnapshot, page_id: &str) -> impl Iterator<Item = &'a Node> {
    let root = page_root(document, page_id);
    document.nodes.values().filter(move |node| {
        root.is_some() && node.parent_id.as_deref() == root && is_visible_frame(node)
    })
}

pub fn can_set_target(document: &DocumentSnapshot, page_id: &str, source_id: &str) -> bool {
    page_root(document, page_id)
        .and_then(|root| top_layer(document, root, source_id))
        .is_some_and(|node| node.kind == NodeKind::Frame)
}

pub fn has_target(document: &DocumentSnapshot, source_id: &str) -> bool {
    document
        .nodes
        .get(source_id)
        .is_some_and(|node| node.properties.contains_key(CLICK_TARGET))
}

pub fn targets<'a>(
    document: &'a DocumentSnapshot,
    page_id: &str,
    source_id: &str,
) -> Vec<&'a Node> {
    let mut frames: Vec<_> = frames(document, page_id)
        .filter(|node| node.id != source_id)
        .collect();
    frames.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)));
    frames
}

fn eligible_target<'a>(
    document: &'a DocumentSnapshot,
    root: &str,
    source_id: &str,
    target_id: &str,
) -> Option<&'a Node> {
    document.nodes.get(target_id).filter(|node| {
        node.id != source_id && node.parent_id.as_deref() == Some(root) && is_visible_frame(node)
    })
}

pub fn target<'a>(
    document: &'a DocumentSnapshot,
    page_id: &str,
    source_id: &str,
) -> Option<&'a Node> {
    let root = page_root(document, page_id)?;
    if top_layer(document, root, source_id)?.kind != NodeKind::Frame {
        return None;
    }
    let target_id = document.nodes.get(source_id)?.string(CLICK_TARGET)?;
    eligible_target(document, root, source_id, target_id)
}

pub fn set_target(
    document: &DocumentSnapshot,
    page_id: &str,
    source_id: &str,
    target_id: Option<&str>,
) -> Result<Value, String> {
    let root = page_root(document, page_id).ok_or("The page is unavailable.")?;
    let source_frame =
        top_layer(document, root, source_id).ok_or("The layer is unavailable on this page.")?;
    let Some(target_id) = target_id else {
        return Ok(json!({"type":"node.unset","nodeId":source_id,"properties":[CLICK_TARGET]}));
    };
    if source_frame.kind != NodeKind::Frame {
        return Err("Choose a layer inside a top-level frame.".into());
    }
    eligible_target(document, root, source_id, target_id)
        .ok_or("Choose a visible top-level frame on this page.")?;
    Ok(json!({"type":"node.set","nodeId":source_id,"properties":{CLICK_TARGET:target_id}}))
}

pub fn preview_frame<'a>(
    document: &'a DocumentSnapshot,
    page_id: &str,
    selected_id: Option<&str>,
) -> Option<&'a Node> {
    let root = page_root(document, page_id)?;
    selected_id
        .and_then(|id| top_layer(document, root, id))
        .filter(|node| is_visible_frame(node))
        .or_else(|| {
            frames(document, page_id).min_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)))
        })
}

fn hit_item(scene: &Scene, index: usize, x: f64, y: f64) -> Option<usize> {
    let item = &scene.items[index];
    if item.hidden {
        return None;
    }
    let contains = item.contains(x, y);
    if item.clip && !contains {
        return None;
    }
    item.children
        .iter()
        .rev()
        .find_map(|child| hit_item(scene, *child, x, y))
        .or(contains.then_some(index))
}

pub fn hit_target<'a>(
    document: &'a DocumentSnapshot,
    page_id: &str,
    scene: &Scene,
    frame_id: &str,
    x: f64,
    y: f64,
) -> Option<&'a Node> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let frame = scene.items.iter().position(|item| item.id == frame_id)?;
    if !scene.items[frame].contains(x, y) {
        return None;
    }
    let mut index = hit_item(scene, frame, x, y)?;
    loop {
        let item = &scene.items[index];
        if let Some(target) = target(document, page_id, &item.id)
            && scene.item(&target.id).is_some_and(|frame| !frame.hidden)
        {
            return Some(target);
        }
        if index == frame {
            return None;
        }
        index = item.parent?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_model::DocumentContent;
    use omc_scene::{SceneOptions, build_scene};

    fn document() -> DocumentSnapshot {
        let content = DocumentContent::empty("Prototype");
        DocumentSnapshot {
            id: "d".into(),
            title: content.title,
            epoch: "e".into(),
            sequence: 0,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        }
    }

    fn layer(document: &mut DocumentSnapshot, parent: &str, kind: NodeKind, x: f64) -> String {
        let mut node = Node::new(kind);
        node.parent_id = Some(parent.into());
        node.properties.extend([
            ("x".into(), json!(x)),
            ("y".into(), json!(10)),
            ("width".into(), json!(80)),
            ("height".into(), json!(80)),
        ]);
        let id = node.id.clone();
        document.nodes.insert(id.clone(), node);
        id
    }

    #[test]
    fn navigates_from_a_nested_hit_and_ignores_design_lock() {
        let mut document = document();
        let page_id = document.pages[0].id.clone();
        let root = document.pages[0].root_node_id.clone();
        let start = layer(&mut document, &root, NodeKind::Frame, 10.);
        let destination = layer(&mut document, &root, NodeKind::Frame, 120.);
        let button = layer(&mut document, &start, NodeKind::Group, 10.);
        let label = layer(&mut document, &button, NodeKind::Rect, 10.);
        let mutation = set_target(&document, &page_id, &button, Some(&destination)).unwrap();
        assert_eq!(mutation["type"], "node.set");
        assert_eq!(mutation["nodeId"], button);
        let button = document.nodes.get_mut(&button).unwrap();
        button.properties.extend([
            (
                CLICK_TARGET.into(),
                mutation["properties"][CLICK_TARGET].clone(),
            ),
            ("locked".into(), json!(true)),
        ]);
        let scene = build_scene(&document, &SceneOptions::default()).unwrap();
        let [x, y, _, _] = scene.item(&label).unwrap().bounds;
        assert_eq!(
            preview_frame(&document, &page_id, Some(&label)).unwrap().id,
            start
        );
        assert_eq!(
            hit_target(&document, &page_id, &scene, &start, x + 2., y + 2.)
                .unwrap()
                .id,
            destination
        );
        assert!(hit_target(&document, &page_id, &scene, &start, 130., 30.).is_none());
    }

    #[test]
    fn invalid_destinations_cannot_play_and_dangling_links_remain_removable() {
        let mut document = document();
        let page_id = document.pages[0].id.clone();
        let root = document.pages[0].root_node_id.clone();
        let start = layer(&mut document, &root, NodeKind::Frame, 10.);
        let destination = layer(&mut document, &root, NodeKind::Frame, 120.);
        let nested = layer(&mut document, &start, NodeKind::Frame, 10.);
        let unrelated = layer(&mut document, &root, NodeKind::Rect, 40.);
        assert_eq!(targets(&document, &page_id, &start).len(), 1);
        assert!(set_target(&document, &page_id, &start, Some(&start)).is_err());
        assert!(set_target(&document, &page_id, &start, Some(&nested)).is_err());
        assert!(set_target(&document, &page_id, &unrelated, Some(&destination)).is_err());
        document
            .nodes
            .get_mut(&start)
            .unwrap()
            .properties
            .insert(CLICK_TARGET.into(), json!(destination));
        document.nodes.remove(&destination);
        assert!(has_target(&document, &start));
        assert!(target(&document, &page_id, &start).is_none());
        assert_eq!(
            set_target(&document, &page_id, &start, None).unwrap(),
            json!({"type":"node.unset","nodeId":start,"properties":[CLICK_TARGET]})
        );
    }
}
