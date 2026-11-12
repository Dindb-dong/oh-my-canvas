//! Values and discriminants from FigCraft v0.17.0's postcard wire.
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Access {
    Edit,
    View,
    Comment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(crate) enum Prop {
    Parent,
    Position,
    Name,
    Kind,
    Visible,
    Locked,
    Opacity,
    Blend,
    Transform,
    Width,
    Height,
    Fills,
    Strokes,
    Stroke,
    Effects,
    Corners,
    Constraints,
    Layout,
    ChildLayout,
    Clip,
    IsMask,
    MaskType,
    Grids,
    Guides,
    Exports,
    Interactions,
    Overflow,
    ScrollPosition,
    Styles,
    Bound,
    VarModes,
    BoolOp,
    ConstrainProportions,
    Source,
    Exposed,
    DevStatus,
    DevChanged,
    DevNote,
    Overrides,
    PropRefs,
    PluginData,
    Annotations,
    CodeLinks,
    DevResources,
    Measurements,
    Board,
}

const NODE_PROPS: &[(Prop, &str)] = &[
    (Prop::Name, "name"),
    (Prop::Visible, "visible"),
    (Prop::Locked, "locked"),
    (Prop::Opacity, "opacity"),
    (Prop::Blend, "blend"),
    (Prop::Transform, "transform"),
    (Prop::Width, "width"),
    (Prop::Height, "height"),
    (Prop::Fills, "fills"),
    (Prop::Strokes, "strokes"),
    (Prop::Stroke, "stroke"),
    (Prop::Effects, "effects"),
    (Prop::Corners, "corners"),
    (Prop::Constraints, "constraints"),
    (Prop::Layout, "layout"),
    (Prop::ChildLayout, "child_layout"),
    (Prop::Clip, "clip"),
    (Prop::IsMask, "is_mask"),
    (Prop::MaskType, "mask_type"),
    (Prop::Grids, "grids"),
    (Prop::Guides, "guides"),
    (Prop::Exports, "exports"),
    (Prop::Interactions, "interactions"),
    (Prop::Overflow, "overflow"),
    (Prop::ScrollPosition, "scroll_position"),
    (Prop::Styles, "styles"),
    (Prop::Bound, "bound"),
    (Prop::VarModes, "var_modes"),
    (Prop::BoolOp, "bool_op"),
    (Prop::ConstrainProportions, "constrain_proportions"),
    (Prop::Source, "source"),
    (Prop::Exposed, "exposed"),
    (Prop::DevStatus, "dev_status"),
    (Prop::DevChanged, "dev_changed"),
    (Prop::DevNote, "dev_note"),
    (Prop::Overrides, "overrides"),
    (Prop::PropRefs, "prop_refs"),
    (Prop::PluginData, "plugin_data"),
    (Prop::Annotations, "annotations"),
    (Prop::CodeLinks, "code_links"),
    (Prop::DevResources, "dev_resources"),
    (Prop::Measurements, "measurements"),
    (Prop::Board, "board"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(crate) enum DocProp {
    Name,
    CurrentPage,
    DocumentColors,
    ColorProfile,
    ImagePresets,
    AnnotationCategories,
    Libraries,
    Styles,
    StyleOrder,
    Comments,
    CommentOrder,
    Collections,
    CollectionOrder,
    Variables,
    VariableOrder,
    Kind,
    Timer,
    Vote,
    VoteHistory,
}

const DOC_PROPS: &[(DocProp, &str)] = &[
    (DocProp::Name, "name"),
    (DocProp::CurrentPage, "current_page"),
    (DocProp::DocumentColors, "document_colors"),
    (DocProp::ColorProfile, "color_profile"),
    (DocProp::ImagePresets, "image_presets"),
    (DocProp::AnnotationCategories, "annotation_categories"),
    (DocProp::Libraries, "libraries"),
    (DocProp::Styles, "styles"),
    (DocProp::Kind, "kind"),
    (DocProp::Timer, "timer"),
    (DocProp::Vote, "vote"),
    (DocProp::VoteHistory, "vote_history"),
];

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(crate) enum Entry {
    Style(String),
    Comment(u64),
    Collection(String),
    Variable(String),
    DevSnapshot(u64),
    Image(String),
    Ballot(String),
}

// The wire's Json newtype writes JSON text as a postcard string.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Change {
    Create {
        id: u64,
        kind: String,
        parent: Option<u64>,
        position: String,
        props: Vec<(Prop, String)>,
    },
    Set {
        id: u64,
        prop: Prop,
        value: String,
    },
    Delete {
        id: u64,
    },
    SetDoc {
        prop: DocProp,
        value: String,
    },
    Put {
        entry: Entry,
        value: String,
    },
    Remove {
        entry: Entry,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Node {
    kind: String,
    parent: Option<u64>,
    position: String,
    props: BTreeMap<Prop, String>,
}

#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub(crate) struct Document {
    nodes: BTreeMap<u64, Node>,
    props: BTreeMap<DocProp, String>,
    entries: BTreeMap<Entry, String>,
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::invalid(message)
}

fn value(raw: &str) -> Result<Value> {
    omc_protocol::decode_json_with_limit(raw.as_bytes(), 8 * 1024 * 1024)
}

impl Document {
    pub(crate) fn from_archive(archive: &Value) -> Result<Self> {
        let records = archive["nodes"]
            .as_object()
            .ok_or_else(|| invalid("FigCraft nodes must be an object"))?;
        if records.len() > 4_096 {
            return Err(invalid("online FigCraft snapshot exceeds 4096 nodes"));
        }
        let mut result = Self::default();
        let mut pending = vec![(
            None,
            archive["pages"]
                .as_array()
                .ok_or_else(|| invalid("FigCraft pages must be an array"))?,
        )];
        while let Some((parent, ids)) = pending.pop() {
            for (index, id) in ids.iter().enumerate() {
                let id = id
                    .as_u64()
                    .filter(|id| *id != 0)
                    .ok_or_else(|| invalid("invalid FigCraft id"))?;
                if result.nodes.contains_key(&id) {
                    return Err(invalid("duplicate FigCraft id"));
                }
                let mut kind = records
                    .get(&id.to_string())
                    .and_then(Value::as_object)
                    .cloned()
                    .ok_or_else(|| invalid("missing FigCraft node"))?;
                let mut props = BTreeMap::new();
                for &(prop, key) in NODE_PROPS {
                    if let Some(v) = kind.remove(key) {
                        props.insert(prop, v.to_string());
                    }
                }
                for key in ["id", "parent", "children"] {
                    kind.remove(key);
                }
                result.nodes.insert(
                    id,
                    Node {
                        kind: Value::Object(kind).to_string(),
                        parent,
                        position: position(index),
                        props,
                    },
                );
                if let Some(children) = records[&id.to_string()]["children"].as_array() {
                    pending.push((Some(id), children));
                }
            }
        }
        if records.len() != result.nodes.len() {
            return Err(invalid("unsupported detached FigCraft nodes"));
        }
        for &(prop, key) in DOC_PROPS {
            if let Some(v) = archive.get(key) {
                result.props.insert(prop, v.to_string());
            }
        }
        if let Some(comments) = archive.get("comments") {
            result.replace_comments(comments)?;
        }
        if let Some(variables) = archive.get("variables") {
            for (prop, key) in [
                (DocProp::Collections, "collections"),
                (DocProp::Variables, "variables"),
            ] {
                if let Some(v) = variables.get(key) {
                    result.props.insert(prop, v.to_string());
                }
            }
        }
        Ok(result)
    }

    fn replace_comments(&mut self, comments: &Value) -> Result<()> {
        let comments = comments
            .as_array()
            .filter(|comments| comments.len() <= 1000)
            .ok_or_else(|| invalid("invalid or oversized FigCraft comments"))?;
        self.entries
            .retain(|entry, _| !matches!(entry, Entry::Comment(_)));
        let mut order = Vec::with_capacity(comments.len());
        for comment in comments {
            let id = comment["id"]
                .as_u64()
                .filter(|id| *id != 0)
                .ok_or_else(|| invalid("invalid FigCraft comment id"))?;
            if self
                .entries
                .insert(Entry::Comment(id), comment.to_string())
                .is_some()
            {
                return Err(invalid("duplicate FigCraft comment"));
            }
            order.push(id);
        }
        if order.is_empty() {
            self.props.remove(&DocProp::CommentOrder);
        } else {
            self.props
                .insert(DocProp::CommentOrder, json!(order).to_string());
        }
        Ok(())
    }

    fn comments(&self) -> Result<Vec<Value>> {
        let mut comments = BTreeMap::new();
        for (entry, raw) in &self.entries {
            let Entry::Comment(id) = entry else {
                return Err(invalid(
                    "online snapshot includes entries outside the native portable subset",
                ));
            };
            let comment = value(raw)?;
            if comment["id"].as_u64() != Some(*id) {
                return Err(invalid("FigCraft comment identity mismatch"));
            }
            comments.insert(*id, comment);
        }
        let order = self
            .props
            .get(&DocProp::CommentOrder)
            .map(|raw| serde_json::from_str::<Vec<u64>>(raw).map_err(invalid_json))
            .transpose()?
            .unwrap_or_default();
        let mut ordered = Vec::with_capacity(comments.len());
        for id in order {
            if let Some(comment) = comments.remove(&id) {
                ordered.push(comment);
            }
        }
        ordered.extend(comments.into_values());
        Ok(ordered)
    }

    pub(crate) fn snapshot(&self) -> Vec<Change> {
        let mut changes = Vec::new();
        let children = self.children();
        let mut pending = children.get(&None).cloned().unwrap_or_default();
        pending.reverse();
        while let Some(id) = pending.pop() {
            let node = &self.nodes[&id];
            changes.push(Change::Create {
                id,
                kind: node.kind.clone(),
                parent: node.parent,
                position: node.position.clone(),
                props: node
                    .props
                    .iter()
                    .map(|(prop, value)| (*prop, value.clone()))
                    .collect(),
            });
            pending.extend(children.get(&Some(id)).into_iter().flatten().rev());
        }
        changes.extend(self.props.iter().map(|(prop, value)| Change::SetDoc {
            prop: *prop,
            value: value.clone(),
        }));
        changes.extend(self.entries.iter().map(|(entry, value)| Change::Put {
            entry: entry.clone(),
            value: value.clone(),
        }));
        changes
    }

    fn children(&self) -> BTreeMap<Option<u64>, Vec<u64>> {
        let mut children = BTreeMap::<Option<u64>, Vec<u64>>::new();
        for (id, node) in &self.nodes {
            children.entry(node.parent).or_default().push(*id);
        }
        for siblings in children.values_mut() {
            siblings.sort_by(|a, b| {
                self.nodes[a]
                    .position
                    .cmp(&self.nodes[b].position)
                    .then(a.cmp(b))
            });
        }
        children
    }

    pub(crate) fn from_snapshot(changes: Vec<Change>) -> Result<Self> {
        let mut doc = Self::default();
        doc.apply(changes)?;
        Ok(doc)
    }

    pub(crate) fn apply(&mut self, changes: Vec<Change>) -> Result<()> {
        for change in changes {
            match change {
                Change::Create {
                    id,
                    kind,
                    parent,
                    position,
                    props,
                } => {
                    if self.nodes.len() >= 4096 || id == 0 || position.len() > 128 {
                        return Err(invalid("invalid or oversized online snapshot"));
                    }
                    self.nodes.insert(
                        id,
                        Node {
                            kind,
                            parent,
                            position,
                            props: props.into_iter().collect(),
                        },
                    );
                }
                Change::Set {
                    id,
                    prop,
                    value: raw,
                } => {
                    let node = self
                        .nodes
                        .get_mut(&id)
                        .ok_or_else(|| invalid("online layer not found"))?;
                    match prop {
                        Prop::Parent => {
                            node.parent = serde_json::from_str(&raw).map_err(invalid_json)?
                        }
                        Prop::Position => {
                            node.position = serde_json::from_str(&raw).map_err(invalid_json)?
                        }
                        Prop::Kind => node.kind = raw,
                        prop => {
                            node.props.insert(prop, raw);
                        }
                    }
                }
                Change::Delete { id } => {
                    let children = self.children();
                    let mut pending = vec![id];
                    while let Some(id) = pending.pop() {
                        if self.nodes.remove(&id).is_some() {
                            pending.extend(children.get(&Some(id)).into_iter().flatten());
                        }
                    }
                }
                Change::SetDoc {
                    prop: DocProp::Comments,
                    value: raw,
                } => self.replace_comments(&value(&raw)?)?,
                Change::SetDoc { prop, value } => {
                    self.props.insert(prop, value);
                }
                Change::Put { entry, value } => {
                    self.entries.insert(entry, value);
                }
                Change::Remove { entry } => {
                    self.entries.remove(&entry);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn archive(&self) -> Result<Value> {
        let comments = self.comments()?;
        let children = self.children();
        let pages = children.get(&None).cloned().unwrap_or_default();
        let mut seen = BTreeSet::new();
        let mut pending = pages.clone();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                return Err(invalid("cyclic FigCraft snapshot"));
            }
            pending.extend(children.get(&Some(id)).into_iter().flatten());
        }
        if pages.is_empty() || seen.len() != self.nodes.len() {
            return Err(invalid("invalid online page tree"));
        }
        let mut records = Map::new();
        for (&id, node) in &self.nodes {
            let mut record = value(&node.kind)?;
            let fields = record
                .as_object_mut()
                .ok_or_else(|| invalid("invalid FigCraft layer type"))?;
            fields.insert("id".into(), json!(id));
            fields.insert("width".into(), json!(0.));
            fields.insert("height".into(), json!(0.));
            if let Some(parent) = node.parent {
                fields.insert("parent".into(), json!(parent));
            }
            if let Some(children) = children.get(&Some(id)) {
                fields.insert("children".into(), json!(children));
            }
            for &(prop, key) in NODE_PROPS {
                if let Some(raw) = node.props.get(&prop) {
                    fields.insert(key.into(), value(raw)?);
                }
            }
            fields.entry("name").or_insert_with(|| json!(""));
            records.insert(id.to_string(), record);
        }
        let mut archive = json!({"format":"figcraft","version":1,"imageIndex":[],"name":"Untitled",
            "pages":pages,"nodes":records,"next_id":self.nodes.keys().max().copied().unwrap_or(0).saturating_add(1),
            "styles":[],"variables":{"collections":[],"variables":[]},"current_page":pages[0],"document_colors":[],"comments":comments});
        for &(prop, key) in DOC_PROPS {
            if let Some(raw) = self.props.get(&prop) {
                archive[key] = value(raw)?;
            }
        }
        if !pages.iter().any(|page| archive["current_page"] == *page) {
            archive["current_page"] = json!(pages[0]);
        }
        for (prop, key) in [
            (DocProp::Collections, "collections"),
            (DocProp::Variables, "variables"),
        ] {
            if let Some(raw) = self.props.get(&prop) {
                archive["variables"][key] = value(raw)?;
            }
        }
        Ok(archive)
    }

    pub(crate) fn changes_to(&self, next: &Self) -> Result<Vec<Change>> {
        let mut changes = Vec::new();
        let before = self.children();
        let after = next.children();

        for change in next.snapshot() {
            match change {
                Change::Create {
                    id,
                    kind,
                    parent,
                    position,
                    props,
                } => {
                    let Some(previous) = self.nodes.get(&id) else {
                        changes.push(Change::Create {
                            id,
                            kind,
                            parent,
                            position,
                            props,
                        });
                        continue;
                    };
                    if previous.kind != kind {
                        changes.push(Change::Set {
                            id,
                            prop: Prop::Kind,
                            value: kind,
                        });
                    }
                    if previous.parent != parent {
                        changes.push(Change::Set {
                            id,
                            prop: Prop::Parent,
                            value: json!(parent).to_string(),
                        });
                    }
                    if before.get(&parent) != after.get(&parent) {
                        changes.push(Change::Set {
                            id,
                            prop: Prop::Position,
                            value: json!(position).to_string(),
                        });
                    }
                    for prop in previous
                        .props
                        .keys()
                        .filter(|prop| !next.nodes[&id].props.contains_key(prop))
                    {
                        changes.push(Change::Set {
                            id,
                            prop: *prop,
                            value: default_property(*prop)?.to_owned(),
                        });
                    }
                    for (prop, value) in props {
                        if previous.props.get(&prop) != Some(&value) {
                            changes.push(Change::Set { id, prop, value });
                        }
                    }
                }
                Change::SetDoc { prop, value } if self.props.get(&prop) != Some(&value) => {
                    changes.push(Change::SetDoc { prop, value });
                }
                Change::Put { entry, value } if self.entries.get(&entry) != Some(&value) => {
                    changes.push(Change::Put { entry, value });
                }
                _ => {}
            }
        }
        for (&id, node) in &self.nodes {
            if !next.nodes.contains_key(&id)
                && node
                    .parent
                    .is_none_or(|parent| next.nodes.contains_key(&parent))
            {
                changes.push(Change::Delete { id });
            }
        }
        for prop in self
            .props
            .keys()
            .filter(|prop| !next.props.contains_key(prop))
        {
            let value = match prop {
                DocProp::ColorProfile => r#""srgb""#,
                DocProp::AnnotationCategories => "null",
                DocProp::CommentOrder => "[]",
                _ => {
                    return Err(invalid(
                        "cannot clear this FigCraft document property online",
                    ));
                }
            };
            changes.push(Change::SetDoc {
                prop: *prop,
                value: value.to_owned(),
            });
        }
        changes.extend(
            self.entries
                .keys()
                .filter(|entry| !next.entries.contains_key(entry))
                .cloned()
                .map(|entry| Change::Remove { entry }),
        );
        Ok(changes)
    }
}

pub(super) fn conflicting(ours: &Change, theirs: &Change) -> bool {
    if ours == theirs {
        return false;
    }
    match (ours, theirs) {
        (Change::Set { id: a, prop: p, .. }, Change::Set { id: b, prop: q, .. }) => {
            a == b && p == q
        }
        (Change::Delete { id: a }, Change::Set { id: b, .. })
        | (Change::Set { id: b, .. }, Change::Delete { id: a })
        | (Change::Create { id: a, .. }, Change::Create { id: b, .. }) => a == b,
        (Change::SetDoc { prop: a, .. }, Change::SetDoc { prop: b, .. }) => {
            a == b && *a != DocProp::CommentOrder
        }
        (Change::Put { entry: a, .. }, Change::Put { entry: b, .. })
        | (Change::Remove { entry: a }, Change::Put { entry: b, .. })
        | (Change::Put { entry: a, .. }, Change::Remove { entry: b }) => a == b,
        _ => false,
    }
}

fn default_property(prop: Prop) -> Result<&'static str> {
    Ok(match prop {
        Prop::Visible => "true",
        Prop::Locked
        | Prop::Clip
        | Prop::IsMask
        | Prop::ConstrainProportions
        | Prop::Exposed
        | Prop::DevChanged => "false",
        Prop::Opacity => "1",
        Prop::Name | Prop::DevNote => r#""""#,
        Prop::Transform => "[1,0,0,1,0,0]",
        Prop::Width | Prop::Height => "0",
        Prop::Fills
        | Prop::Strokes
        | Prop::Effects
        | Prop::Grids
        | Prop::Guides
        | Prop::Exports
        | Prop::Interactions
        | Prop::Overrides
        | Prop::Annotations
        | Prop::CodeLinks
        | Prop::DevResources
        | Prop::Measurements => "[]",
        Prop::Bound
        | Prop::VarModes
        | Prop::PropRefs
        | Prop::PluginData
        | Prop::Stroke
        | Prop::Corners
        | Prop::Constraints
        | Prop::Styles
        | Prop::ChildLayout => "{}",
        Prop::Layout | Prop::BoolOp | Prop::Source | Prop::Board => "null",
        Prop::MaskType => r#""alpha""#,
        Prop::DevStatus | Prop::Overflow => r#""none""#,
        Prop::ScrollPosition => r#""scrolls""#,
        Prop::Blend => r#""passThrough""#,
        _ => return Err(invalid("cannot clear this FigCraft layer property online")),
    })
}

fn invalid_json(error: serde_json::Error) -> EngineError {
    invalid(error.to_string())
}

fn position(index: usize) -> String {
    const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut value = index;
    let mut rank = [b'0'; 3];
    for byte in rank.iter_mut().rev() {
        *byte = DIGITS[value % 62];
        value /= 62;
    }
    format!(
        "c{}{}{}",
        char::from(rank[0]),
        char::from(rank[1]),
        char::from(rank[2])
    )
}

#[allow(dead_code)] // Unused operations keep the pinned postcard discriminants.
#[derive(Serialize)]
pub(crate) enum Admin<'a> {
    Publish {
        name: &'a str,
        snapshot: Vec<Change>,
    },
    Files,
    Links {
        file: &'a str,
    },
    CreateLink {
        file: &'a str,
        access: Access,
        label: &'a str,
    },
    Revoke {
        file: &'a str,
        link: &'a str,
    },
    Remove {
        file: &'a str,
    },
    Rename {
        file: &'a str,
        name: &'a str,
    },
    Listing,
    Reports,
    Block {
        ip: &'a str,
    },
    Unblock {
        ip: &'a str,
    },
    Blocked,
    Code {
        file: &'a str,
        token: &'a str,
    },
    Owned {
        files: Vec<(&'a str, &'a str)>,
    },
    RemovePeer {
        file: &'a str,
        client: u32,
    },
    Team,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct FileInfo {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub updated: u64,
    pub seq: u64,
    pub bytes: u64,
    pub people: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct LinkInfo {
    pub id: String,
    pub file: String,
    pub access: Access,
    pub label: String,
    pub created: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct NewLink {
    pub link: LinkInfo,
    pub token: String,
}
#[derive(Deserialize)]
pub(crate) struct OwnedFile {
    pub name: String,
    _links: Vec<String>,
    pub expires: Option<u64>,
}
#[derive(Deserialize)]
pub(crate) struct TeamFile {
    pub file: FileInfo,
    pub access: Access,
}
#[allow(dead_code)] // Some replies preserve a wire position only.
#[derive(Deserialize)]
pub(crate) enum AdminReply {
    Ready,
    Published {
        file: FileInfo,
        edit: NewLink,
        view: NewLink,
    },
    Files(Vec<FileInfo>),
    Links(Vec<LinkInfo>),
    Link(NewLink),
    Done,
    Failed {
        reason: String,
    },
    Hosted {
        file: FileInfo,
        edit: NewLink,
        view: NewLink,
        owner: String,
        expires: Option<u64>,
    },
    Listing,
    Reports,
    Blocked,
    Code {
        code: String,
    },
    Owned(Vec<Option<OwnedFile>>),
    Team {
        web: String,
        files: Vec<TeamFile>,
    },
}
