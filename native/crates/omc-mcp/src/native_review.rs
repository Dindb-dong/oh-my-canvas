use crate::{ToolRouter, figcraft_catalog::comment_reply_order, resources, string};
use omc_model::DocumentSnapshot;
use omc_protocol::{EngineError, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

impl ToolRouter {
    pub(super) fn review_threads(
        &self,
        session: &str,
        document: &str,
        args: &Value,
    ) -> Result<Value> {
        let offset = args.get("offset").map_or(Ok(0), |value| {
            value
                .as_u64()
                .and_then(|offset| usize::try_from(offset).ok())
                .ok_or_else(|| EngineError::invalid("offset must be nonnegative"))
        })?;
        let limit = args["limit"].as_u64().unwrap_or(20);
        if !(1..=200).contains(&limit) {
            return Err(EngineError::invalid("limit must be between 1 and 200"));
        }
        let action = string(args, "action")?;
        if action == "changes" {
            return self.read_review_changes(document, args["cursor"].as_str(), limit as usize);
        }
        let snapshot = self.workspace.snapshot(document)?;
        let entries = resources::catalogs(&snapshot.metadata, "comments");
        let (items, thread) = match action {
            "list_threads" => {
                let node = args["nodeId"]
                    .as_str()
                    .map(|node| self.resolve(session, document, node))
                    .transpose()?;
                let resolved = args["resolved"].as_bool();
                let author = args["authorId"].as_str();
                let items = entries
                    .values()
                    .filter(|entry| {
                        entry["threadId"].is_null()
                            && node.as_ref().is_none_or(|node| entry["nodeId"] == *node)
                            && resolved.is_none_or(|resolved| {
                                entry["resolved"].as_bool().unwrap_or(false) == resolved
                            })
                            && author.is_none_or(|author| entry["authorId"] == author)
                    })
                    .collect();
                (items, None)
            }
            "get_thread" => {
                let id = string(args, "threadId")?;
                let thread = entries
                    .get(id)
                    .filter(|entry| entry["threadId"].is_null())
                    .ok_or_else(|| EngineError::invalid("comment thread not found"))?;
                (thread_replies(&entries, id), Some(thread))
            }
            _ => return Err(EngineError::invalid("unknown review action")),
        };
        let total = items.len();
        let page: Vec<_> = items
            .into_iter()
            .skip(offset)
            .take(limit as usize)
            .map(|entry| with_anchor_status(&snapshot, entry))
            .collect();
        let next = offset + page.len();
        let mut result = json!({
            "revision": snapshot.revision(),
            "total": total,
            "nextOffset": (next < total).then_some(next),
        });
        if let Some(thread) = thread {
            result["thread"] = with_anchor_status(&snapshot, thread);
            result["replies"] = json!(page);
        } else {
            result["items"] = json!(page);
        }
        Ok(result)
    }
}

fn with_anchor_status(snapshot: &DocumentSnapshot, entry: &Value) -> Value {
    let mut entry = entry.clone();
    entry["orphaned"] = json!(
        entry["nodeId"]
            .as_str()
            .is_some_and(|node| !snapshot.nodes.contains_key(node))
    );
    entry
}

fn thread_replies<'a>(entries: &'a BTreeMap<String, Value>, id: &str) -> Vec<&'a Value> {
    let mut children: BTreeMap<&str, Vec<_>> = BTreeMap::new();
    for (id, entry) in entries {
        if let Some(parent) = entry["threadId"].as_str() {
            children
                .entry(parent)
                .or_default()
                .push((id.as_str(), entry));
        }
    }
    // Native clients can reply to an existing reply as well as to the root.
    let mut pending = vec![id];
    let mut replies = Vec::new();
    while let Some(current) = pending.pop() {
        if let Some(children) = children.remove(current) {
            for (id, entry) in children {
                pending.push(id);
                replies.push(entry);
            }
        }
    }
    replies.sort_by(|left, right| comment_reply_order(left).cmp(&comment_reply_order(right)));
    replies
}

#[cfg(test)]
mod tests {
    use super::*;
    use omc_workspace::Workspace;
    use std::sync::Arc;

    #[test]
    fn lists_document_review_threads_and_reads_paginated_nested_replies() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let registration = workspace.session_open(None).unwrap();
        let session = registration["sessionId"].as_str().unwrap();
        let author = workspace.session(session).unwrap().author;
        let router = Arc::new(ToolRouter::new(workspace));
        let call = |name, args| router.call(session, name, args, Value::Null).unwrap();
        let doc = call("create_document", json!({"title":"Review fixture"}));
        let id = doc["documentId"].as_str().unwrap();
        let rect = call("create_shape", json!({"documentId":id,"type":"rect"}));
        let node = &rect["rawIds"][0];
        let comment = |action, mut args: Value| {
            args["version"] = "1".into();
            args["documentId"] = id.into();
            args["action"] = action;
            call("native_comments", args)
        };
        let root = comment(
            "create".into(),
            json!({"body":"Check the anchor","nodeId":node}),
        );
        let thread = &root["id"];
        let reply = comment("reply".into(), json!({"body":"Checking","threadId":thread}));
        let nested = comment(
            "reply".into(),
            json!({"body":"Done","threadId":reply["id"]}),
        );
        comment("create".into(), json!({"body":"Unresolved document note"}));
        comment("resolve".into(), json!({"id":thread}));

        let matching = comment(
            "list_threads".into(),
            json!({"nodeId":node,"authorId":author,"resolved":true}),
        );
        assert_eq!(matching["total"], 1);
        assert_eq!(matching["items"][0]["id"], *thread);
        assert_eq!(matching["items"][0]["orphaned"], false);
        let flat = comment("list".into(), json!({}));
        assert_eq!(flat["items"].as_array().unwrap().len(), 4);

        let first = comment("get_thread".into(), json!({"threadId":thread,"limit":1}));
        assert_eq!(first["total"], 2);
        assert_eq!(first["nextOffset"], 1);
        assert_eq!(first["thread"]["id"], *thread);
        let second = comment(
            "get_thread".into(),
            json!({"threadId":thread,"limit":1,"offset":first["nextOffset"]}),
        );
        assert!(second["nextOffset"].is_null());
        let ids = [&first["replies"][0]["id"], &second["replies"][0]["id"]];
        assert!(ids.contains(&&reply["id"]) && ids.contains(&&nested["id"]));

        call("delete", json!({"documentId":id,"ids":[node]}));
        assert_eq!(
            comment("get_thread".into(), json!({"threadId":thread}))["thread"]["orphaned"],
            true
        );
        let separate = call("create_document", json!({"title":"Unrelated document"}));
        let result = router.call(
            session,
            "native_comments",
            json!({"version":"1","documentId":separate["documentId"],"action":"get_thread","threadId":thread}),
            Value::Null,
        );
        assert!(result.is_err());
    }
}

#[cfg(test)]
mod change_tests {
    use super::*;
    use omc_workspace::Workspace;
    use std::sync::Arc;

    #[test]
    fn review_changes_follow_only_the_target_document_across_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(directory.path(), None).unwrap();
        let session = || {
            workspace.session_open(None).unwrap()["sessionId"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let writer = session();
        let reader = session();
        let router = Arc::new(ToolRouter::new(workspace));
        let call =
            |session: &str, name, args| router.call(session, name, args, Value::Null).unwrap();
        let first = call(&writer, "create_document", json!({"title":"First review"}));
        let second = call(&writer, "create_document", json!({"title":"Second review"}));
        let comments = |session: &str, doc: &Value, action: &str, mut args: Value| {
            args["version"] = json!("1");
            args["documentId"] = doc["documentId"].clone();
            args["action"] = json!(action);
            call(session, "native_comments", args)
        };
        let idle = comments(&reader, &first, "changes", json!({}));
        assert_eq!(idle["events"], json!([]));
        let thread = comments(&writer, &first, "create", json!({"body":"First comment"}));
        let hidden = comments(&writer, &second, "create", json!({"body":"Other document"}));
        let reply = comments(
            &writer,
            &first,
            "reply",
            json!({"threadId":thread["id"],"body":"Reply"}),
        );
        let nested = comments(
            &writer,
            &first,
            "reply",
            json!({"threadId":reply["id"],"body":"Nested"}),
        );
        comments(&writer, &first, "undo", json!({}));

        let first_event = comments(
            &reader,
            &first,
            "changes",
            json!({"cursor":idle["cursor"],"limit":1}),
        );
        assert_eq!(first_event["events"][0]["commentId"], thread["id"]);
        assert_eq!(first_event["events"][0]["sequence"], 1);
        assert_eq!(first_event["hasMore"], true);
        let rest = comments(
            &reader,
            &first,
            "changes",
            json!({"cursor":first_event["cursor"]}),
        );
        assert_eq!(rest["events"].as_array().unwrap().len(), 3);
        assert_eq!(rest["events"][0]["sequence"], 2);
        assert_eq!(rest["events"][1]["commentId"], nested["id"]);
        assert_eq!(rest["events"][1]["threadId"], thread["id"]);
        assert_eq!(rest["events"][2]["kind"], "comment.undo");
        assert_eq!(rest["hasMore"], false);
        assert!(!rest.to_string().contains(hidden["id"].as_str().unwrap()));

        let wrong = comments(
            &reader,
            &second,
            "changes",
            json!({"cursor":rest["cursor"]}),
        );
        assert_eq!(wrong["reset"], true);
        assert_eq!(wrong["events"], json!([]));
        assert_eq!(wrong["dropped"], 0);
        let no_change = comments(&reader, &first, "changes", json!({"cursor":rest["cursor"]}));
        assert_eq!(no_change["events"], json!([]));
        assert_eq!(no_change["cursor"], rest["cursor"]);
    }
}
