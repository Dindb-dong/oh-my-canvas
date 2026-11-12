use super::*;
use serde::{Deserialize, Serialize};

const MAX_THREADS: usize = 2_000;
const MAX_MESSAGES: usize = 10_000;
const MAX_READERS: usize = 2_000;
const MAX_TEXT: usize = 16_384;
const MAX_NAME: usize = 512;

#[derive(Clone, Default)]
pub struct WireComments {
    native: BTreeMap<u64, String>,
    wire: BTreeMap<String, u64>,
    order: BTreeMap<u64, usize>,
}

impl WireComments {
    fn bind(&mut self, wire: u64, native: String) -> Result<()> {
        if self.native.get(&wire).is_some_and(|id| id != &native)
            || self.wire.get(&native).is_some_and(|id| *id != wire)
        {
            return Err(invalid("conflicting comment identity"));
        }
        self.wire.insert(native.clone(), wire);
        self.native.insert(wire, native);
        Ok(())
    }

    fn wire_id(&mut self, entry: &Value, client: u32) -> Result<u64> {
        let native = string(entry, "id")?;
        if let Some(id) = self.wire.get(native) {
            return Ok(*id);
        }
        if let Some(id) = entry["wireCommentId"].as_u64() {
            self.bind(id, native.to_owned())?;
            return Ok(id);
        }
        let proposed = crate::figcraft_catalog::comment_id(native).max(1);
        let id = if self.native.contains_key(&proposed) {
            let first = (u64::from(client) << 32) + 1;
            (first..=first + u64::from(u32::MAX) - 1)
                .find(|id| !self.native.contains_key(id))
                .ok_or_else(|| invalid("FigCraft comment ID space exhausted"))?
        } else {
            proposed
        };
        self.bind(id, native.to_owned())?;
        Ok(id)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct Message {
    author: String,
    text: String,
    #[serde(default)]
    created: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    edited: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    reactions: Vec<Reaction>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    agent: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct Reaction {
    emoji: String,
    users: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Thread {
    id: u64,
    page: u64,
    x: f64,
    y: f64,
    #[serde(default)]
    anchor: Option<u64>,
    #[serde(flatten)]
    first: Message,
    #[serde(default)]
    resolved: bool,
    #[serde(default)]
    replies: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    read_by: Option<Vec<String>>,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

fn entries(metadata: &Properties) -> BTreeMap<String, Value> {
    let mut entries = BTreeMap::new();
    for (key, value) in metadata {
        if let Some((id, property)) = key
            .strip_prefix("comments/")
            .and_then(|key| key.split_once('/'))
        {
            let entry = entries
                .entry(id.to_owned())
                .or_insert_with(|| json!({"id":id}));
            entry[property] = value.clone();
        }
    }
    entries
}

fn replies(entries: &BTreeMap<String, Value>) -> BTreeMap<&str, Vec<&Value>> {
    let mut grouped = BTreeMap::<&str, Vec<&Value>>::new();
    for reply in entries.values().filter(|entry| entry["deleted"] != true) {
        if let Some(thread) = reply["threadId"].as_str() {
            grouped.entry(thread).or_default().push(reply);
        }
    }
    for replies in grouped.values_mut() {
        replies.sort_by_key(|reply| crate::figcraft_catalog::comment_reply_order(reply));
    }
    grouped
}

fn author(entry: &Value) -> &str {
    entry["authorName"]
        .as_str()
        .or(entry["authorId"].as_str())
        .unwrap_or_default()
}

fn display_names(entries: &BTreeMap<String, Value>) -> BTreeMap<&str, &str> {
    entries
        .values()
        .filter_map(|entry| {
            let id = entry["authorId"].as_str()?;
            Some((id, author(entry)))
        })
        .collect()
}

fn reader_name<'a>(reader: &'a str, entry: &'a Value, names: &'a BTreeMap<&str, &str>) -> &'a str {
    entry["readerNames"][reader]
        .as_str()
        .or_else(|| names.get(reader).copied())
        .unwrap_or(reader)
}

fn reaction_name<'a>(user: &'a str, entry: &'a Value, names: &'a BTreeMap<&str, &str>) -> &'a str {
    entry["reactionNames"][user]
        .as_str()
        .or_else(|| names.get(user).copied())
        .unwrap_or(user)
}

fn wire_message(entry: &Value, names: &BTreeMap<&str, &str>) -> Result<Message> {
    let mut message = message(entry)?;
    for reaction in &mut message.reactions {
        let previous = std::mem::take(&mut reaction.users);
        let mut seen = BTreeSet::new();
        reaction.users = previous
            .iter()
            .filter_map(|user| {
                let name = reaction_name(user, entry, names);
                seen.insert(name).then(|| name.to_owned())
            })
            .collect();
    }
    validate_message(&message)?;
    Ok(message)
}

fn message(entry: &Value) -> Result<Message> {
    let reactions = entry
        .get("reactions")
        .map(|value| serde_json::from_value(value.clone()).map_err(invalid))
        .transpose()?
        .unwrap_or_default();
    let message = Message {
        author: author(entry).into(),
        text: entry["body"].as_str().unwrap_or_default().into(),
        created: entry["createdAt"].as_u64().unwrap_or(0),
        edited: entry["editedAt"].as_u64().unwrap_or(0),
        reactions,
        agent: entry["agent"].as_bool().unwrap_or(true),
    };
    validate_message(&message)?;
    Ok(message)
}

fn validate_message(message: &Message) -> Result<()> {
    if message.text.len() > MAX_TEXT
        || message.author.len() > MAX_NAME
        || message.reactions.len() > 128
        || message.reactions.iter().any(|reaction| {
            reaction.emoji.is_empty()
                || reaction.emoji.len() > 64
                || reaction.users.len() > MAX_READERS
                || reaction.users.iter().any(|user| user.len() > MAX_NAME)
        })
    {
        return Err(invalid("invalid or oversized comment message"));
    }
    Ok(())
}

fn encode_readers(
    entry: &Value,
    names: &BTreeMap<&str, &str>,
    messages: impl Iterator<Item = String>,
) -> Option<Vec<String>> {
    let previous = entry["readBy"].as_object();
    let excluded = previous
        .into_iter()
        .flatten()
        .filter(|(_, read)| **read == false)
        .map(|(id, _)| reader_name(id, entry, names))
        .collect::<BTreeSet<_>>();
    let read_all = entry["wireReadByAll"] == true;
    if read_all && excluded.is_empty() {
        return None;
    }
    let mut read = BTreeSet::new();
    if read_all {
        read.extend(messages);
    } else if !entry["wireCommentId"].is_number() {
        read.insert(author(entry).to_owned());
    }
    read.extend(
        previous
            .into_iter()
            .flatten()
            .filter(|(_, value)| **value == true)
            .map(|(id, _)| reader_name(id, entry, names).to_owned()),
    );
    read.retain(|name| !name.is_empty() && !excluded.contains(name.as_str()));
    let mut ordered = Vec::new();
    for name in entry["wireReadOrder"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if read.remove(name) {
            ordered.push(name.to_owned());
        }
    }
    ordered.extend(read);
    Some(ordered)
}

pub(super) fn encode(
    snapshot: &DocumentSnapshot,
    node_ids: &BTreeMap<String, usize>,
    client: u32,
    state: &mut WireComments,
) -> Result<Value> {
    let entries = entries(&snapshot.metadata);
    if entries.len() > MAX_MESSAGES {
        return Err(invalid("too many comment messages in archive"));
    }
    let replies = replies(&entries);
    let names = display_names(&entries);
    let mut out = Vec::new();
    for entry in entries
        .values()
        .filter(|entry| entry["threadId"].is_null() && entry["deleted"] != true)
    {
        let raw = string(entry, "id")?;
        let mut anchor = entry["nodeId"]
            .as_str()
            .zip(entry["localX"].as_f64())
            .zip(entry["localY"].as_f64())
            .map(|((id, x), y)| (id, x, y));
        let page = anchor
            .and_then(|(node, _, _)| crate::figcraft_catalog::node_page(snapshot, node))
            .or_else(|| {
                anchor = None;
                match entry["pageId"].as_str() {
                    Some(id) => snapshot.pages.iter().find(|page| page.id == id),
                    None => snapshot.pages.first(),
                }
            });
        let Some(page) = page else {
            // Deleted pages retain their native comments for undo, but aren't on the wire.
            continue;
        };
        let page = *node_ids
            .get(&page.root_node_id)
            .ok_or_else(|| invalid("missing comment page mapping"))? as u64;
        let (anchor, x, y) = match anchor {
            Some((id, x, y)) => (node_ids.get(id).map(|id| *id as u64), x, y),
            None => (
                None,
                entry["x"].as_f64().unwrap_or(0.),
                entry["y"].as_f64().unwrap_or(0.),
            ),
        };
        let first = wire_message(entry, &names)?;
        let replies = replies
            .get(raw)
            .into_iter()
            .flatten()
            .map(|reply| wire_message(reply, &names))
            .collect::<Result<Vec<_>>>()?;
        let read_by = encode_readers(
            entry,
            &names,
            std::iter::once(first.author.clone())
                .chain(replies.iter().map(|reply| reply.author.clone())),
        );
        if read_by.as_ref().is_some_and(|readers| {
            readers.len() > MAX_READERS || readers.iter().any(|name| name.len() > MAX_NAME)
        }) {
            return Err(invalid("too many comment readers in archive"));
        }
        out.push(Thread {
            id: state.wire_id(entry, client)?,
            page,
            x,
            y,
            anchor,
            first,
            resolved: entry["resolved"] == true,
            replies,
            read_by,
        });
    }
    if out.len() > MAX_THREADS {
        return Err(invalid("too many comment threads in archive"));
    }
    out.sort_by_key(|thread| {
        (
            state.order.get(&thread.id).copied().unwrap_or(usize::MAX),
            thread.id,
        )
    });
    serde_json::to_value(out).map_err(invalid)
}

fn world_point(nodes: &Value, anchor: u64, page: u64, x: f64, y: f64) -> Option<(f64, f64)> {
    let mut transform = omc_scene::Affine::IDENTITY;
    let mut node = anchor;
    let mut count = 0;
    while node != page {
        let current = nodes.get(node.to_string())?;
        if let Some(matrix) = current.get("transform") {
            let [a, b, c, d, tx, ty] = serde_json::from_value::<[f64; 6]>(matrix.clone()).ok()?;
            transform = omc_scene::Affine([a, c, b, d, tx, ty]).multiply(transform);
        }
        node = current["parent"].as_u64()?;
        count += 1;
        if count > MAX_NODES {
            return None;
        }
    }
    let (x, y) = transform.point(x, y);
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

fn native_message(
    message: &Message,
    previous: Option<&Value>,
    names: &BTreeMap<&str, &str>,
) -> Properties {
    let old_reactions = previous.and_then(|entry| entry["reactions"].as_array());
    let mut reactions = message.reactions.clone();
    for reaction in &mut reactions {
        let previous = previous.zip(
            old_reactions.and_then(|old| old.iter().find(|entry| entry["emoji"] == reaction.emoji)),
        );
        let Some((entry, old)) = previous else {
            continue;
        };
        let mut identities = BTreeMap::<&str, Vec<&str>>::new();
        for user in old["users"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            identities
                .entry(reaction_name(user, entry, names))
                .or_default()
                .push(user);
        }
        let mut seen = BTreeSet::new();
        let wire_users = std::mem::take(&mut reaction.users);
        reaction.users = wire_users
            .iter()
            .flat_map(|name| {
                identities
                    .get(name.as_str())
                    .cloned()
                    .unwrap_or_else(|| vec![name.as_str()])
            })
            .filter(|user| seen.insert(*user))
            .map(str::to_owned)
            .collect();
    }
    let mut properties = Properties::from([
        ("authorName".into(), json!(message.author)),
        ("body".into(), json!(message.text)),
        ("createdAt".into(), json!(message.created)),
        ("editedAt".into(), json!(message.edited)),
        ("reactions".into(), json!(reactions)),
        ("agent".into(), json!(message.agent)),
        ("deleted".into(), json!(false)),
    ]);
    if previous.is_none_or(|entry| author(entry) != message.author) {
        let digest = Sha256::digest(message.author.as_bytes());
        properties.insert(
            "authorId".into(),
            json!(format!("figcraft-comment:{}", hex::encode(&digest[..16]))),
        );
    }
    // Existing native author IDs were copied with the old properties. Matching their display
    // name alone is sufficient for older comments that predate stable native author IDs.
    properties
}

fn matched_replies<'a>(incoming: &[Message], existing: &[&'a Value]) -> Vec<Option<&'a Value>> {
    use std::collections::VecDeque;
    let old = existing
        .iter()
        .map(|entry| message(entry).ok())
        .collect::<Vec<_>>();
    let mut exact = BTreeMap::<_, VecDeque<usize>>::new();
    let mut similar = BTreeMap::<_, VecDeque<usize>>::new();
    for (index, old) in old.iter().enumerate() {
        if let Some(old) = old {
            exact
                .entry((
                    old.author.as_str(),
                    old.created,
                    old.text.as_str(),
                    old.edited,
                ))
                .or_default()
                .push_back(index);
            similar
                .entry((old.author.as_str(), old.created))
                .or_default()
                .push_back(index);
        }
    }
    let mut used = vec![false; old.len()];
    let mut matches = incoming
        .iter()
        .map(|reply| {
            let key = (
                reply.author.as_str(),
                reply.created,
                reply.text.as_str(),
                reply.edited,
            );
            let index = exact.get_mut(&key)?.pop_front()?;
            used[index] = true;
            Some(existing[index])
        })
        .collect::<Vec<_>>();
    for (reply, matched) in incoming.iter().zip(&mut matches) {
        if matched.is_none()
            && let Some(indices) = similar.get_mut(&(reply.author.as_str(), reply.created))
            && let Some(index) =
                std::iter::from_fn(|| indices.pop_front()).find(|index| !used[*index])
        {
            used[index] = true;
            *matched = Some(existing[index]);
        }
    }
    matches
}

fn decode_readers(
    thread: &Thread,
    previous: Option<&Value>,
    names: &BTreeMap<&str, &str>,
) -> serde_json::Map<String, Value> {
    let mut result = serde_json::Map::new();
    let incoming = thread
        .read_by
        .as_ref()
        .map(|items| items.iter().map(String::as_str).collect::<BTreeSet<_>>());
    let mut represented = BTreeSet::new();
    if let Some(previous) = previous {
        for (id, read) in previous["readBy"].as_object().into_iter().flatten() {
            let name = reader_name(id, previous, names);
            if *read == false || incoming.as_ref().is_none_or(|names| names.contains(name)) {
                represented.insert(name);
                result.insert(id.clone(), read.clone());
            }
        }
    }
    for name in incoming.into_iter().flatten() {
        if !represented.contains(name) {
            result.insert(name.into(), json!(true));
        }
    }
    result
}

fn append(metadata: &mut Properties, id: &str, values: Properties) {
    metadata.extend(
        values
            .into_iter()
            .map(|(name, value)| (format!("comments/{id}/{name}"), value)),
    );
}

pub(super) fn decode(
    file: &Value,
    content: &mut DocumentContent,
    nodes: &BTreeMap<u64, String>,
    pages: &BTreeMap<u64, String>,
    state: &mut WireComments,
    current: Option<&DocumentSnapshot>,
) -> Result<()> {
    let threads = match file.get("comments") {
        Some(items) => {
            let items = items
                .as_array()
                .filter(|items| items.len() <= MAX_THREADS)
                .ok_or_else(|| invalid("invalid or oversized comment threads"))?;
            items
                .iter()
                .map(|item| serde_json::from_value::<Thread>(item.clone()).map_err(invalid))
                .collect::<Result<Vec<_>>>()?
        }
        None => Vec::new(),
    };
    if threads
        .iter()
        .map(|thread| thread.replies.len() + 1)
        .sum::<usize>()
        > MAX_MESSAGES
    {
        return Err(invalid("too many comment messages in archive"));
    }
    let previous = current.map_or_else(BTreeMap::new, |snapshot| entries(&snapshot.metadata));
    let old_replies = replies(&previous);
    let names = display_names(&previous);
    if let Some(current) = current {
        content.metadata.extend(
            current
                .metadata
                .iter()
                .filter(|(key, _)| key.starts_with("comments/"))
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    for old in previous
        .values()
        .filter(|entry| entry["threadId"].is_null())
    {
        let id = string(old, "id")?;
        if let Some(wire) = old["wireCommentId"].as_u64() {
            state.bind(wire, id.into())?;
        }
    }
    let mut used = previous.keys().cloned().collect::<BTreeSet<_>>();
    let mut keep = BTreeSet::new();
    let mut order = BTreeMap::new();
    for (index, thread) in threads.iter().enumerate() {
        validate_message(&thread.first)?;
        if thread.id == 0
            || order.insert(thread.id, index).is_some()
            || thread.read_by.as_ref().is_some_and(|users| {
                users.len() > MAX_READERS || users.iter().any(|user| user.len() > MAX_NAME)
            })
        {
            return Err(invalid("invalid comment identity or read state"));
        }
        let page = pages
            .get(&thread.page)
            .filter(|id| content.pages.iter().any(|page| page.id == **id))
            .ok_or_else(|| invalid("comment references an unknown page"))?;
        let raw = state
            .native
            .get(&thread.id)
            .cloned()
            .unwrap_or_else(|| format!("comment_{:032x}", thread.id));
        state.bind(thread.id, raw.clone())?;
        keep.insert(raw.clone());
        used.insert(raw.clone());
        let previous_thread = previous.get(&raw);
        let (x, y, anchor) = match thread.anchor.and_then(|id| {
            nodes.get(&id).zip(world_point(
                &file["nodes"],
                id,
                thread.page,
                thread.x,
                thread.y,
            ))
        }) {
            Some((node, (x, y))) => (x, y, Some(node)),
            None => (thread.x, thread.y, None),
        };
        let mut values = native_message(&thread.first, previous_thread, &names);
        values.extend([
            ("threadId".into(), Value::Null),
            ("pageId".into(), json!(page)),
            ("x".into(), json!(x)),
            ("y".into(), json!(y)),
            ("nodeId".into(), json!(anchor)),
            ("localX".into(), json!(anchor.map(|_| thread.x))),
            ("localY".into(), json!(anchor.map(|_| thread.y))),
            ("resolved".into(), json!(thread.resolved)),
            ("wireCommentId".into(), json!(thread.id)),
            ("wireReadByAll".into(), json!(thread.read_by.is_none())),
            ("wireReadOrder".into(), json!(thread.read_by)),
            (
                "readBy".into(),
                json!(decode_readers(thread, previous_thread, &names)),
            ),
        ]);
        append(&mut content.metadata, &raw, values);
        let old = old_replies
            .get(raw.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let matched = matched_replies(&thread.replies, old);
        for (index, (reply, existing)) in thread.replies.iter().zip(matched).enumerate() {
            validate_message(reply)?;
            let id = existing
                .map(|entry| string(entry, "id"))
                .transpose()?
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    (0u64..)
                        .find_map(|salt| {
                            let digest = Sha256::digest(format!(
                                "figcraft-reply:{}:{index}:{}:{}:{salt}",
                                thread.id, reply.created, reply.author
                            ));
                            let id = format!("comment_{}", hex::encode(&digest[..16]));
                            used.insert(id.clone()).then_some(id)
                        })
                        .unwrap()
                });
            keep.insert(id.clone());
            let mut values = native_message(reply, existing, &names);
            values.extend([
                ("threadId".into(), json!(raw)),
                ("pageId".into(), json!(page)),
                ("wireReplyOrder".into(), json!(index)),
            ]);
            append(&mut content.metadata, &id, values);
        }
    }
    for raw in previous.keys().filter(|id| !keep.contains(*id)) {
        content
            .metadata
            .insert(format!("comments/{raw}/deleted"), json!(true));
    }
    state.order = order;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(content: DocumentContent) -> DocumentSnapshot {
        DocumentSnapshot {
            id: omc_model::new_id("doc"),
            epoch: "fixture".into(),
            sequence: 0,
            title: content.title,
            pages: content.pages,
            nodes: content.nodes,
            metadata: content.metadata,
        }
    }

    #[test]
    fn preserves_comment_identity_anchors_and_legacy_read_state() {
        let mut content = DocumentContent::empty("Comment archive");
        let page = content.pages[0].id.clone();
        let mut anchor = Node::new(NodeKind::Rect);
        anchor.parent_id = Some(content.pages[0].root_node_id.clone());
        anchor.properties.extend([
            ("name".into(), json!("Anchor")),
            ("x".into(), json!(30)),
            ("y".into(), json!(40)),
            ("width".into(), json!(100)),
            ("height".into(), json!(50)),
        ]);
        let anchor_id = anchor.id.clone();
        content.nodes.insert(anchor_id.clone(), anchor);
        let thread = omc_model::new_id("comment");
        let first_reply = omc_model::new_id("comment");
        let second_reply = omc_model::new_id("comment");
        append(
            &mut content.metadata,
            &thread,
            Properties::from([
                ("pageId".into(), json!(page)),
                ("nodeId".into(), json!(anchor_id)),
                ("localX".into(), json!(7)),
                ("localY".into(), json!(8)),
                ("x".into(), json!(37)),
                ("y".into(), json!(48)),
                ("authorName".into(), json!("Owner")),
                ("authorId".into(), json!("local-owner")),
                ("body".into(), json!("First message")),
                ("createdAt".into(), json!(42)),
                ("readBy".into(), json!({"native_reader":false,"Alice":true})),
                ("readerNames".into(), json!({"native_reader":"Reader"})),
                (
                    "reactions".into(),
                    json!([{"emoji":"✅","users":["native_reader"]}]),
                ),
                ("reactionNames".into(), json!({"native_reader":"Reader"})),
            ]),
        );
        for (reply, text, order) in [
            (&first_reply, "First reply", 1),
            (&second_reply, "Second reply", 2),
        ] {
            append(
                &mut content.metadata,
                reply,
                Properties::from([
                    ("pageId".into(), json!(page)),
                    ("threadId".into(), json!(thread)),
                    ("authorName".into(), json!("Bob")),
                    ("authorId".into(), json!("local-bob")),
                    ("body".into(), json!(text)),
                    ("createdAt".into(), json!(43)),
                    ("replyOrder".into(), json!(order)),
                ]),
            );
        }
        let current = snapshot(content);
        let mut node_ids = BTreeMap::new();
        let mut state = WireComments::default();
        let mut file = super::super::encode_wire_document_with_comments(
            &current,
            &page,
            &mut node_ids,
            7,
            &mut state,
        )
        .unwrap();
        let wire_id = file["comments"][0]["id"].as_u64().unwrap();
        assert_eq!(wire_id, crate::figcraft_catalog::comment_id(&thread));
        assert_eq!(file["comments"][0]["anchor"], node_ids[&anchor_id]);
        assert_eq!(file["comments"][0]["x"], 7.);
        assert_eq!(file["comments"][0]["y"], 8.);
        assert_eq!(file["comments"][0]["read_by"], json!(["Alice", "Owner"]));
        assert_eq!(
            file["comments"][0]["reactions"][0]["users"],
            json!(["Reader"])
        );

        let mut reversed = node_ids
            .iter()
            .map(|(raw, id)| (*id as u64, raw.clone()))
            .collect();
        let mut pages = BTreeMap::from([(
            node_ids[&current.pages[0].root_node_id] as u64,
            page.clone(),
        )]);
        file["comments"][0]
            .as_object_mut()
            .unwrap()
            .remove("read_by");
        file["comments"][0]["resolved"] = json!(true);
        file["comments"][0]["agent"] = json!(false);
        file["comments"][0]["reactions"] = json!([{"emoji":"✅","users":["Reader"]}]);
        let replies = file["comments"][0]["replies"].as_array_mut().unwrap();
        replies.swap(0, 1);
        replies[1]["text"] = json!("First reply edited");
        replies[1]["edited"] = json!(44);

        let (next, _) = super::super::decode_wire_document_with_comments(
            &file,
            &mut reversed,
            &mut pages,
            &mut state,
            Some(&current),
        )
        .unwrap();
        let decoded = entries(&next.metadata);
        let restored = &decoded[&thread];
        assert_eq!(restored["x"], 37.);
        assert_eq!(restored["y"], 48.);
        assert_eq!(restored["nodeId"], anchor_id);
        assert_eq!(restored["authorId"], "local-owner");
        assert_eq!(restored["wireCommentId"], wire_id);
        assert_eq!(restored["wireReadByAll"], true);
        assert_eq!(restored["readBy"]["native_reader"], false);
        assert_eq!(restored["resolved"], true);
        assert_eq!(restored["agent"], false);
        assert_eq!(restored["reactions"][0]["emoji"], "✅");
        assert_eq!(restored["reactions"][0]["users"], json!(["native_reader"]));
        assert_eq!(decoded[&second_reply]["wireReplyOrder"], 0);
        assert_eq!(decoded[&first_reply]["wireReplyOrder"], 1);
        assert_eq!(decoded[&first_reply]["body"], "First reply edited");
        assert_eq!(decoded[&first_reply]["authorId"], "local-bob");

        let next = snapshot(next);
        let outgoing = super::super::encode_wire_document(&next, &page, &mut node_ids, 9).unwrap();
        assert_eq!(outgoing["comments"][0]["id"], wire_id);
        assert_eq!(
            outgoing["comments"][0]["replies"][0]["text"],
            "Second reply"
        );
        assert_eq!(
            outgoing["comments"][0]["replies"][1]["text"],
            "First reply edited"
        );
        assert!(
            !outgoing["comments"][0]["read_by"]
                .as_array()
                .unwrap()
                .contains(&json!("Reader"))
        );

        file["comments"] = json!([]);
        let (deleted, _) = super::super::decode_wire_document_with_comments(
            &file,
            &mut reversed,
            &mut pages,
            &mut state,
            Some(&next),
        )
        .unwrap();
        let deleted = entries(&deleted.metadata);
        assert_eq!(deleted[&thread]["deleted"], true);
        assert_eq!(deleted[&thread]["body"], "First message");
        assert_eq!(deleted[&first_reply]["deleted"], true);
        assert_eq!(deleted[&second_reply]["deleted"], true);
    }

    #[test]
    fn imports_large_wire_ids_without_alias_precision_loss() {
        let empty = snapshot(DocumentContent::empty("External comments"));
        let mut archive =
            super::super::encode_wire_document(&empty, &empty.pages[0].id, &mut BTreeMap::new(), 0)
                .unwrap();
        archive["comments"] = json!([{
            "id":u64::MAX - 1,"page":archive["pages"][0],"x":5,"y":6,
            "author":"Foreign author","text":"Pinned note","read_by":[],
            "replies":[{"author":"Second person","text":"Hello"}],
        }]);
        let (decoded, _) = super::super::decode_wire_document(
            &archive,
            &mut BTreeMap::new(),
            &mut BTreeMap::new(),
        )
        .unwrap();
        let entries = entries(&decoded.metadata);
        let (id, thread) = entries
            .iter()
            .find(|(_, entry)| entry["threadId"].is_null())
            .unwrap();
        assert_eq!(thread["wireCommentId"], u64::MAX - 1);
        assert_eq!(thread["wireReadByAll"], false);
        assert!(
            thread["authorId"]
                .as_str()
                .unwrap()
                .starts_with("figcraft-comment:")
        );
        assert!(
            crate::figcraft_catalog::comment_alias(id, thread["wireCommentId"].as_u64())
                <= (1u64 << 53) - 1
        );
        let decoded = snapshot(decoded);
        let reencoded = super::super::encode_wire_document(
            &decoded,
            &decoded.pages[0].id,
            &mut BTreeMap::new(),
            0,
        )
        .unwrap();
        assert_eq!(reencoded["comments"][0]["id"], u64::MAX - 1);
        assert_eq!(reencoded["comments"][0]["read_by"], json!([]));
    }
}
