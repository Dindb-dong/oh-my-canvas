use super::*;
use omc_scene::{Affine, Scene};
use std::collections::BTreeSet;

mod appearance;
mod color_profile;
pub(super) use appearance::{paint as normalize_selection_paint, paint_stack};
pub(super) mod export;
mod guides;
mod layout;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("file.colorProfile", "Color profile", true, "profile?, convert?"),
    (
        "fill.pattern",
        "Pattern fill",
        true,
        "source, ids?, index?, tile?, scale?, spacing?, align?, opacity?, visible?, blend?",
    ),
    (
        "stroke.widthProfile",
        "Width profile",
        true,
        "ids?, preset? | points?",
    ),
    (
        "stroke.brush",
        "Brush",
        true,
        "ids?, preset?, spacing?, sizeJitter?, rotationJitter?, scatter?, seed?",
    ),
    ("arrange.packH", "Pack horizontal", true, "ids?"),
    ("arrange.packV", "Pack vertical", true, "ids?"),
    (
        "arrange.reorder",
        "Reorder selection",
        true,
        "ids?, source, target, swap?",
    ),
    (
        "arrange.spacing",
        "Spacing",
        true,
        "ids?, horizontal?, vertical?",
    ),
    (
        "distribute.horizontal",
        "Distribute horizontal spacing",
        true,
        "ids?, spacing?",
    ),
    (
        "distribute.vertical",
        "Distribute vertical spacing",
        true,
        "ids?, spacing?",
    ),
    ("frame.presets", "List frame presets", false, ""),
    ("frame.swapOrientation", "Swap orientation", true, "ids?"),
    (
        "shape.arrow",
        "Arrow",
        true,
        "x, y, width, parent?, index?, name?, props?, select?",
    ),
    ("layout.add", "Add auto layout", true, "ids?, direction?"),
    ("layout.remove", "Remove auto layout", true, "ids?"),
    ("layout.removeAll", "Remove all auto layout", true, "ids?"),
    (
        "layout.suggest",
        "Suggest auto layout",
        true,
        "ids?, direction?",
    ),
    (
        "layout.setTrack",
        "Set grid track size",
        true,
        "ids?, axis, index, sizing, value?",
    ),
    ("fill.add", "Add fill", true, "ids?, paint? | color?"),
    ("fill.copy", "Copy fill", false, "id?, index?"),
    ("fill.move", "Move fill", true, "ids?, from, to"),
    ("fill.paste", "Paste fill", true, "ids?, index?"),
    ("fill.remove", "Remove fill", true, "ids?, index"),
    (
        "fill.set",
        "Set fill",
        true,
        "ids?, index?, paint?, color?, opacity?, visible?, blend?",
    ),
    ("stroke.add", "Add stroke", true, "ids?, paint? | color?"),
    ("stroke.copy", "Copy stroke", false, "id?, index?"),
    ("stroke.move", "Move stroke", true, "ids?, from, to"),
    ("stroke.paste", "Paste stroke", true, "ids?, index?"),
    ("stroke.remove", "Remove stroke", true, "ids?, index"),
    (
        "stroke.set",
        "Set stroke",
        true,
        "ids?, index?, paint?, color?, opacity?, visible?, blend?",
    ),
    ("effect.add", "Add effect", true, "ids?, type? | effect?"),
    ("effect.copy", "Copy effect", false, "id?, index?"),
    ("effect.move", "Move effect", true, "ids?, from, to"),
    ("effect.paste", "Paste effect", true, "ids?, index?"),
    ("effect.remove", "Remove effect", true, "ids?, index"),
    ("effect.set", "Set effect", true, "ids?, index, effect"),
    ("export.add", "Add export setting", true, "ids?, setting?"),
    (
        "export.update",
        "Edit export setting",
        true,
        "ids?, index, size?, suffix?, format?, quality?",
    ),
    (
        "export.remove",
        "Remove export setting",
        true,
        "ids?, index",
    ),
    (
        "file.exportLayers",
        "Export layers",
        false,
        "ids?, assets?, dir?, zip?, overwrite?",
    ),
    (
        "guide.add",
        "Add guide",
        true,
        "vertical?, offset, frame? | page?",
    ),
    (
        "guide.move",
        "Move guide",
        true,
        "index, offset, frame? | page?",
    ),
    (
        "guide.remove",
        "Remove guide",
        true,
        "index?, frame? | page?",
    ),
    (
        "guide.select",
        "Select guide",
        false,
        "index?, frame? | page?",
    ),
    ("guide.clear", "Remove all guides", true, "frame? | page?"),
    ("grid.add", "Add layout grid", true, "ids?, grid?"),
    ("grid.remove", "Remove layout grid", true, "ids?, index"),
    ("grid.move", "Move layout grid", true, "ids?, from, to"),
    (
        "paint.documentColors",
        "Document colors",
        false,
        "page?, limit?",
    ),
];

impl ToolRouter {
    pub(super) fn fig_design_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let (domain, action) = name.split_once('.').unwrap();
        if name == "file.colorProfile" {
            return self.fig_file_color_profile(session, snapshot, params);
        }
        if name == "frame.presets" {
            return Ok(frame_presets());
        }
        if name == "shape.arrow" {
            return self.fig_create_arrow(session, snapshot, state, selection, params);
        }
        if name == "paint.documentColors" {
            return self.fig_document_colors(session, snapshot, state, params);
        }
        if name == "file.exportLayers" {
            return self.fig_export_layers(session, snapshot, state, selection, params);
        }
        if domain == "guide" {
            return self.fig_guides(session, snapshot, state, action, params);
        }
        let targets = match params.get("id") {
            Some(id) => std::slice::from_ref(id),
            None => fig_ids(params, selection)?,
        };
        let mut ids = self.fig_layers(session, snapshot, targets)?;
        let mut seen = BTreeSet::new();
        ids.retain(|id| seen.insert(id.clone()));
        if ids.is_empty() {
            return Err(EngineError::invalid("select at least one layer"));
        }
        if ids.iter().any(|id| snapshot.nodes[id].parent_id.is_none()) {
            return Err(EngineError::invalid("cannot edit a page root as a layer"));
        }
        let mut commands = Vec::new();
        let result = match domain {
            "fill" | "stroke" | "effect" | "grid" => self.fig_appearance(
                session,
                snapshot,
                &ids,
                domain,
                action,
                params,
                &mut commands,
            )?,
            "export" => export::settings(snapshot, &ids, action, params, &mut commands)?,
            "layout" => self.fig_layout(
                session,
                snapshot,
                state,
                &ids,
                action,
                params,
                &mut commands,
            )?,
            "arrange" | "distribute" => {
                let scene = paths::scene(snapshot, &state.page_id)?;
                arrange(
                    snapshot,
                    &scene,
                    &ids,
                    name,
                    params,
                    |key| self.fig_layer(session, snapshot, &params[key]),
                    &mut commands,
                )?;
                json!({"ok":true})
            }
            "frame" => {
                let scene = paths::scene(snapshot, &state.page_id)?;
                for id in ids {
                    let item = scene.item(&id).ok_or_else(|| {
                        EngineError::invalid("layer is outside the selected page")
                    })?;
                    commands.push(set(&id, json!({"width":item.height,"height":item.width}))?);
                }
                json!({"ok":true})
            }
            _ => return Err(EngineError::invalid("unknown design command")),
        };
        if !commands.is_empty() {
            self.submit(
                session,
                &snapshot.id,
                Command::Batch { commands },
                &Value::Null,
                Some(snapshot.sequence),
            )?;
        }
        if let Some(selection) = result["ids"]
            .as_array()
            .filter(|_| name == "layout.add" || name == "layout.suggest")
        {
            self.fig_selection(&(session.into(), snapshot.id.clone()), selection);
        }
        Ok(result)
    }

    fn fig_create_arrow(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        params: &Value,
    ) -> Result<Value> {
        let mut params = params.clone();
        let fields = params
            .as_object_mut()
            .ok_or_else(|| EngineError::invalid("params must be an object"))?;
        fields.insert("type".into(), json!("line"));
        fields.entry("name").or_insert(json!("Arrow"));
        let mut draft = snapshot.clone();
        let mut selection = selection.to_vec();
        let mut commands = Vec::new();
        let result = self.fig_edit(
            session,
            &state.root,
            &mut draft,
            &mut selection,
            &mut commands,
            "node.create",
            &params,
        )?;
        let Some(Command::NodeCreate { node }) = commands.first_mut() else {
            return Err(EngineError::invalid("could not create arrow"));
        };
        node.properties.insert("arrowHead".into(), json!(true));
        let id = node.id.clone();
        draft.nodes.insert(id.clone(), node.clone());
        let result = json!({"id":result["id"],"node":self.fig_node(session,&draft,&draft.nodes[&id],0,&mut 1)});
        self.submit(
            session,
            &snapshot.id,
            Command::Batch { commands },
            &Value::Null,
            Some(snapshot.sequence),
        )?;
        self.fig_selection(&(session.into(), snapshot.id.clone()), &selection);
        Ok(result)
    }
}

fn set(id: &str, patch: Value) -> Result<Command> {
    Ok(Command::NodeSet {
        node_id: id.into(),
        properties: properties(&patch)?,
    })
}

fn optional_number(params: &Value, key: &str) -> Result<Option<f64>> {
    params
        .get(key)
        .map(|value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && value.abs() <= 1e6)
                .ok_or_else(|| {
                    EngineError::invalid(format!(
                        "{key} must be a finite number between -1000000 and 1000000"
                    ))
                })
        })
        .transpose()
}

fn optional_index(params: &Value, key: &str) -> Result<Option<usize>> {
    params
        .get(key)
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    EngineError::invalid(format!("{key} must be a non-negative integer"))
                })
        })
        .transpose()
}

fn union_bounds(items: impl IntoIterator<Item = [f64; 4]>) -> [f64; 4] {
    let [l, t, r, b] = items.into_iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |[l, t, r, b], [x, y, w, h]| [l.min(x), t.min(y), r.max(x + w), b.max(y + h)],
    );
    [l, t, r - l, b - t]
}

fn root_targets(snapshot: &DocumentSnapshot, ids: &[String]) -> Vec<String> {
    let set = ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
    ids.iter()
        .filter(|id| {
            let mut parent = snapshot.nodes[*id].parent_id.as_deref();
            while let Some(id) = parent {
                if set.contains(id) {
                    return false;
                }
                parent = snapshot.nodes[id].parent_id.as_deref();
            }
            true
        })
        .cloned()
        .collect()
}

fn move_delta(
    scene: &Scene,
    snapshot: &DocumentSnapshot,
    id: &str,
    dx: f64,
    dy: f64,
) -> Result<Command> {
    let item = scene
        .item(id)
        .ok_or_else(|| EngineError::invalid("layer is outside the selected page"))?;
    let parent = item
        .parent
        .map(|index| &scene.items[index])
        .ok_or_else(|| EngineError::invalid("layer has no parent"))?;
    if matches!(parent.style.get("display"), Some("flex" | "grid"))
        && item.style.get("position") != Some("absolute")
    {
        return Err(EngineError::invalid(
            "auto-layout children must be reordered within their layout",
        ));
    }
    let inverse = parent
        .world
        .inverse()
        .ok_or_else(|| EngineError::invalid("parent transform is singular"))?;
    let [a, b, c, d, _, _] = inverse.0;
    let node = &snapshot.nodes[id];
    set(
        id,
        json!({"x":node.number("x",0.) + a*dx + c*dy,"y":node.number("y",0.) + b*dx + d*dy}),
    )
}

fn arrange(
    snapshot: &DocumentSnapshot,
    scene: &Scene,
    ids: &[String],
    name: &str,
    params: &Value,
    resolve: impl Fn(&str) -> Result<String>,
    commands: &mut Vec<Command>,
) -> Result<()> {
    if params["fromGesture"] == true {
        return Err(EngineError::invalid("no active spacing or reorder gesture"));
    }
    let ids = root_targets(snapshot, ids);
    let items = ids
        .iter()
        .map(|id| {
            scene
                .bounds(id)
                .map(|bounds| (id.as_str(), bounds))
                .ok_or_else(|| EngineError::invalid("layer is outside the selected page"))
        })
        .collect::<Result<Vec<_>>>()?;
    if name == "arrange.reorder" {
        let source = resolve("source")?;
        let target = resolve("target")?;
        let mut rows = bands(&items, 1);
        if rows
            .iter()
            .map(Vec::len)
            .any(|count| count != rows[0].len())
        {
            return Err(EngineError::invalid(
                "select a regular row, column or complete aligned grid",
            ));
        }
        let order = rows
            .iter_mut()
            .flat_map(|row| {
                row.sort_by(|a, b| a.1[0].total_cmp(&b.1[0]));
                row.iter().copied()
            })
            .collect::<Vec<_>>();
        let index = |id: &str| {
            order.iter().position(|item| item.0 == id).ok_or_else(|| {
                EngineError::invalid("source and target must belong to the selection")
            })
        };
        let (from, to) = (index(&source)?, index(&target)?);
        let mut moved = order.clone();
        if params["swap"] == true {
            moved.swap(from, to);
        } else {
            let item = moved.remove(from);
            moved.insert(to, item);
        }
        for ((id, before), (_, after)) in moved.into_iter().zip(order) {
            if before[..2] != after[..2] {
                commands.push(move_delta(
                    scene,
                    snapshot,
                    id,
                    after[0] - before[0],
                    after[1] - before[1],
                )?);
            }
        }
        return Ok(());
    }
    let mut offsets = BTreeMap::<&str, [f64; 2]>::new();
    for (axis, key) in [(0, "horizontal"), (1, "vertical")] {
        let spacing = if name == "arrange.spacing" {
            optional_number(params, key)?
        } else if matches!((axis, name), (0, "arrange.packH") | (1, "arrange.packV")) {
            Some(0.)
        } else if matches!(
            (axis, name),
            (0, "distribute.horizontal") | (1, "distribute.vertical")
        ) {
            let spacing = optional_number(params, "spacing")?;
            if spacing.is_none() && items.len() < 3 {
                continue;
            }
            spacing
        } else {
            continue;
        };
        if name == "arrange.spacing" && spacing.is_none() {
            continue;
        }
        let tracks = if name == "arrange.spacing" {
            let tracks = bands(&items, axis);
            if tracks.len() < 2 {
                return Err(EngineError::invalid(
                    "selection has no spacing on this axis",
                ));
            }
            tracks
        } else {
            let mut items = items.clone();
            items.sort_by(|a, b| a.1[axis].total_cmp(&b.1[axis]));
            items.into_iter().map(|item| vec![item]).collect()
        };
        let extents = tracks
            .iter()
            .map(|track| union_bounds(track.iter().map(|item| item.1)))
            .collect::<Vec<_>>();
        let extent = |bounds: &[f64; 4]| bounds[axis] + bounds[axis + 2];
        let start = extents[0][axis];
        let end = extents.iter().map(extent).fold(start, f64::max);
        let size: f64 = extents.iter().map(|bounds| bounds[axis + 2]).sum();
        let gap =
            spacing.unwrap_or_else(|| (end - start - size) / (tracks.len() - 1).max(1) as f64);
        let mut pos = start;
        for (track, bounds) in tracks.into_iter().zip(extents) {
            for (id, _) in track {
                offsets.entry(id).or_default()[axis] = pos - bounds[axis];
            }
            pos += bounds[axis + 2] + gap;
        }
    }
    if name == "arrange.spacing"
        && params.get("horizontal").is_none()
        && params.get("vertical").is_none()
    {
        return Err(EngineError::invalid("pass horizontal or vertical spacing"));
    }
    for (id, [dx, dy]) in offsets {
        if dx.abs() > 1e-9 || dy.abs() > 1e-9 {
            commands.push(move_delta(scene, snapshot, id, dx, dy)?);
        }
    }
    Ok(())
}

fn bands<'a>(items: &[(&'a str, [f64; 4])], axis: usize) -> Vec<Vec<(&'a str, [f64; 4])>> {
    let mut order = items.to_vec();
    order.sort_by(|a, b| a.1[axis].total_cmp(&b.1[axis]));
    let mut tracks = Vec::new();
    let mut end = f64::NEG_INFINITY;
    for item in order {
        let start = item.1[axis];
        let right = start + item.1[axis + 2];
        if start >= end - 1e-6 {
            tracks.push(Vec::new());
            end = right.max(start + 1e-5);
        } else {
            end = end.max(right);
        }
        tracks.last_mut().unwrap().push(item);
    }
    tracks
}

pub(super) fn apply_frame_preset(params: &mut Value) -> Result<()> {
    let fields = params
        .as_object_mut()
        .ok_or_else(|| EngineError::invalid("params must be an object"))?;
    let Some(name) = fields.remove("preset") else {
        return Ok(());
    };
    let name = name
        .as_str()
        .ok_or_else(|| EngineError::invalid("preset must be a string"))?;
    let (_, name, width, height) = FRAME_PRESETS
        .iter()
        .find(|(_, preset, _, _)| preset.eq_ignore_ascii_case(name))
        .ok_or_else(|| EngineError::invalid("unknown frame preset"))?;
    fields.entry("width").or_insert(json!(width));
    fields.entry("height").or_insert(json!(height));
    fields.entry("name").or_insert(json!(name));
    Ok(())
}

fn frame_presets() -> Value {
    json!(FRAME_PRESETS.iter().map(|(category,name,width,height)|
        json!({"category":category,"name":name,"width":width,"height":height})
    ).collect::<Vec<_>>())
}

// Device dimensions match the FigCraft v0.17.0 frame picker.
const FRAME_PRESETS: &[(&str, &str, f64, f64)] = &[
    ("Phone", "iPhone 17", 402.0, 874.0),
    ("Phone", "iPhone 17 Pro", 402.0, 874.0),
    ("Phone", "iPhone 17 Pro Max", 440.0, 956.0),
    ("Phone", "iPhone Air", 420.0, 912.0),
    ("Phone", "iPhone 16", 393.0, 852.0),
    ("Phone", "iPhone 16 Pro", 402.0, 874.0),
    ("Phone", "iPhone 16 Pro Max", 440.0, 956.0),
    ("Phone", "iPhone 16 Plus", 430.0, 932.0),
    ("Phone", "iPhone SE", 320.0, 568.0),
    ("Phone", "Android Compact", 412.0, 917.0),
    ("Phone", "Android Medium", 700.0, 840.0),
    ("Tablet", "iPad mini 8.3", 744.0, 1133.0),
    ("Tablet", "iPad Pro 11\"", 834.0, 1194.0),
    ("Tablet", "iPad Pro 12.9\"", 1024.0, 1366.0),
    ("Tablet", "Surface Pro 8", 1440.0, 960.0),
    ("Tablet", "Android Expanded", 1280.0, 800.0),
    ("Desktop", "MacBook Air", 1280.0, 832.0),
    ("Desktop", "MacBook Pro 14\"", 1512.0, 982.0),
    ("Desktop", "MacBook Pro 16\"", 1728.0, 1117.0),
    ("Desktop", "Desktop", 1440.0, 1024.0),
    ("Desktop", "Wireframe", 1440.0, 1024.0),
    ("Desktop", "TV", 1280.0, 720.0),
    ("Presentation", "Slide 16:9", 1920.0, 1080.0),
    ("Presentation", "Slide 4:3", 1024.0, 768.0),
    ("Watch", "Apple Watch Series 10 42mm", 187.0, 223.0),
    ("Watch", "Apple Watch 41mm", 176.0, 215.0),
    ("Watch", "Apple Watch 45mm", 198.0, 242.0),
    ("Paper", "A4", 595.0, 842.0),
    ("Paper", "A5", 420.0, 595.0),
    ("Paper", "A6", 297.0, 420.0),
    ("Paper", "Letter", 612.0, 792.0),
    ("Paper", "Tabloid", 792.0, 1224.0),
    ("Social media", "Instagram post", 1080.0, 1350.0),
    ("Social media", "Instagram story", 1080.0, 1920.0),
    ("Social media", "Facebook post", 1200.0, 630.0),
    ("Social media", "X post", 1200.0, 675.0),
    ("Social media", "LinkedIn post", 1200.0, 1200.0),
    ("Social media", "YouTube thumbnail", 1280.0, 720.0),
    ("Social media", "Dribbble shot", 1600.0, 1200.0),
];
