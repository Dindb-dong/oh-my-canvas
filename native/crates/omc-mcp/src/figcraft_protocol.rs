use super::*;
use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::watch;

const EVENT_CAPACITY: usize = 1024;

#[derive(Default)]
struct EventLog {
    sequence: u64,
    events: VecDeque<Value>,
}

#[derive(Default)]
pub(super) struct Events {
    log: Mutex<EventLog>,
    changed: watch::Sender<u64>,
}

impl Events {
    fn record(&self, mut event: Value) {
        let mut log = self.log.lock().unwrap();
        log.sequence += 1;
        event["seq"] = log.sequence.into();
        if log.events.len() == EVENT_CAPACITY {
            log.events.pop_front();
        }
        log.events.push_back(event);
        self.changed.send_replace(log.sequence);
    }

    fn poll(&self, after: u64, limit: usize, comments: bool) -> Value {
        let log = self.log.lock().unwrap();
        let reset = after > log.sequence;
        let dropped = if comments && !reset {
            log.sequence
                .saturating_sub(log.events.len() as u64)
                .saturating_sub(after)
        } else {
            0
        };
        let events = if comments {
            log.events
                .iter()
                .filter(|event| reset || event["seq"].as_u64().unwrap_or(0) > after)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let cursor = events
            .last()
            .and_then(|event| event["seq"].as_u64())
            .unwrap_or_else(|| {
                if limit == 0 && !reset {
                    after
                } else {
                    log.sequence
                }
            });
        json!({"events":events,"cursor":cursor,"reset":reset,"dropped":dropped})
    }
}

fn event_tool() -> Value {
    json!({"name":"wait_for_changes","description":"Wait for new comment events, or read them after a cursor.",
    "inputSchema":{"type":"object","additionalProperties":false,"properties":{
        "after":{"type":"integer","minimum":0},
        "limit":{"type":"integer","minimum":0},
        "timeoutMs":{"type":"integer","minimum":0},
        "topics":{"type":"array","items":{"type":"string","enum":["comments","document","all"]}}
    }}})
}

pub fn figcraft_tools() -> Vec<Value> {
    let mut tools = figcraft::tools();
    tools.push(event_tool());
    tools
}

pub fn validate_figcraft_tool(name: &str, args: &Value) -> Result<()> {
    let tool = figcraft_tools()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .ok_or_else(|| EngineError::invalid("unknown FigCraft tool"))?;
    schema::check(&tool["inputSchema"], args, "args")
}

impl ToolRouter {
    pub async fn fig_wait_for_changes(
        &self,
        session: &str,
        args: Value,
        attached: bool,
    ) -> Result<Value> {
        self.workspace.session(session)?;
        schema::check(&event_tool()["inputSchema"], &args, "args")?;
        let after = args["after"].as_u64().unwrap_or(0);
        let limit = args["limit"].as_u64().unwrap_or(100).min(1000) as usize;
        let timeout = args["timeoutMs"].as_u64().unwrap_or(20_000).min(25_000);
        let comments = args["topics"].as_array().is_none_or(|topics| {
            topics
                .iter()
                .any(|topic| matches!(topic.as_str(), Some("comments" | "all")))
        });
        let mut changes = self.fig_events.changed.subscribe();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
        loop {
            let result = self.fig_events.poll(after, limit, comments);
            if !attached
                || !comments
                || limit == 0
                || result["reset"] == true
                || result["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
            {
                return Ok(result);
            }
            if tokio::time::timeout_at(deadline, changes.changed())
                .await
                .is_err()
            {
                return Ok(self.fig_events.poll(after, limit, comments));
            }
            self.workspace.session(session)?;
        }
    }

    pub fn execute_observed(&self, session: &str, envelope: CommandEnvelope) -> Result<Value> {
        let mut changes = Vec::new();
        comment_changes(&envelope.command, &mut changes);
        let document = envelope.document_id.clone();
        let receipt = self.workspace.execute(session, envelope)?;
        if !changes.is_empty()
            && receipt["replayed"] != true
            && receipt["status"] == "durable"
            && let Ok(context) = self.workspace.context(&document)
        {
            for (id, props) in changes {
                let field = format!("comments/{id}/threadId");
                let thread = context.metadata.get(&field).and_then(Value::as_str);
                let kind = if props.get("deleted") == Some(&Value::Bool(true)) {
                    "deleted"
                } else if props.contains_key("reactions") {
                    "reacted"
                } else if props.contains_key("threadId") && props.contains_key("body") {
                    "replied"
                } else if props.contains_key("body")
                    && (props.contains_key("createdAt") || props.contains_key("resolved"))
                {
                    "added"
                } else if props.contains_key("body") {
                    "edited"
                } else if props.contains_key("x")
                    || props.contains_key("y")
                    || props.contains_key("nodeId")
                {
                    "moved"
                } else if props.contains_key("resolved") {
                    "resolved"
                } else {
                    continue;
                };
                let action = match kind {
                    "added" => "add",
                    "replied" => "reply",
                    "edited" => "edit",
                    "reacted" => "react",
                    "resolved" => "resolve",
                    "moved" => "move",
                    _ => "delete",
                };
                let root = thread.unwrap_or(&id);
                let mut data = json!({"command":format!("comment.{action}"),"commentId":figcraft_catalog::comment_id(root)});
                if let Some(thread) = thread {
                    let comments = resources::catalogs(&context.metadata, "comments");
                    if let Some(index) = figcraft_catalog::comment_replies(&comments, thread)
                        .iter()
                        .position(|reply| reply["id"] == id)
                    {
                        data["reply"] = index.into();
                    } else {
                        data["rawReplyId"] = id.into();
                    }
                }
                self.fig_events
                    .record(json!({"kind":format!("comment.{kind}"),
                    "document":context.title,"documentId":external_id(&document),"data":data}));
            }
        }
        Ok(receipt)
    }

    pub fn fig_protocol(&self, session: &str, method: &str, args: &Value) -> Result<Value> {
        match method {
            "resources/list" => Ok(json!({"resources":[
                resource("document","Active document","The current editable document and layer tree."),
                resource("commands","Command catalog","The commands currently supported by this server."),
                resource("comments","Open comments","Unresolved threads in the current document.")
            ]})),
            "resources/templates/list" => Ok(json!({"resourceTemplates":[
                {"name":"node","title":"Layer","uriTemplate":"figcraft://node/{id}","mimeType":"application/json"},
                {"name":"command","title":"Command","uriTemplate":"figcraft://command/{id}","mimeType":"application/json"}
            ]})),
            "resources/read" => {
                let uri = string(args, "uri")?;
                let data = match uri {
                    "figcraft://document" => {
                        self.call_figcraft(session, "inspect_document", json!({}))?
                    }
                    "figcraft://commands" => {
                        self.call_figcraft(session, "list_commands", json!({}))?
                    }
                    "figcraft://comments" => self.call_figcraft(
                        session,
                        "run_command",
                        json!({"command":"comment.list","params":{"page":"all","filter":"open"}}),
                    )?,
                    _ if uri.starts_with("figcraft://node/") => {
                        let id = uri
                            .trim_start_matches("figcraft://node/")
                            .parse::<u64>()
                            .ok()
                            .filter(|id| *id > 0)
                            .ok_or_else(|| EngineError::invalid("invalid layer resource ID"))?;
                        self.call_figcraft(session, "get_node", json!({"id":id,"depth":2}))?
                    }
                    _ if uri.starts_with("figcraft://command/") => {
                        let id = uri.trim_start_matches("figcraft://command/");
                        self.call_figcraft(session, "list_commands", json!({"filter":id}))?
                            .as_array()
                            .and_then(|commands| {
                                commands.iter().find(|command| command["id"] == id)
                            })
                            .cloned()
                            .ok_or_else(|| {
                                EngineError::new("not_found", "command resource not found")
                            })?
                    }
                    _ => return Err(EngineError::new("not_found", "unknown resource URI")),
                };
                Ok(
                    json!({"contents":[{"uri":uri,"mimeType":"application/json","text":data.to_string()}]}),
                )
            }
            "prompts/list" => Ok(json!({"prompts":prompt_catalog()})),
            "prompts/get" => prompt(string(args, "name")?, &args["arguments"]),
            _ => Err(EngineError::new("method_not_found", "unknown MCP method")),
        }
    }
}

fn comment_changes(command: &Command, changes: &mut Vec<(String, Properties)>) {
    match command {
        Command::CatalogSet {
            namespace,
            entity_id,
            properties,
        } if namespace == "comments" => changes.push((entity_id.clone(), properties.clone())),
        Command::Batch { commands } => {
            for command in commands {
                comment_changes(command, changes);
            }
        }
        _ => {}
    }
}

fn resource(name: &str, title: &str, description: &str) -> Value {
    json!({"name":name,"title":title,"description":description,"uri":format!("figcraft://{name}"),"mimeType":"application/json"})
}

fn prompt_catalog() -> Vec<Value> {
    let argument = |name, required| json!({"name":name,"required":required});
    let prompt = |name, title, description, arguments: Vec<Value>| {
        json!({
            "name":name,"title":title,"description":description,"arguments":arguments
        })
    };
    vec![
        prompt(
            "mobile_screen",
            "Design a mobile screen",
            "Create a phone screen with a clear hierarchy.",
            vec![
                argument("screen", true),
                argument("device", false),
                argument("brand_color", false),
            ],
        ),
        prompt(
            "design_system",
            "Start a design system",
            "Create reusable colors, text styles and components.",
            vec![argument("name", false), argument("primary", false)],
        ),
        prompt(
            "landing_page",
            "Design a landing page",
            "Build a desktop marketing page.",
            vec![
                argument("product", true),
                argument("width", false),
                argument("accent", false),
            ],
        ),
        prompt(
            "prototype_flow",
            "Wire a prototype flow",
            "Connect existing screens into a flow.",
            vec![argument("screens", false), argument("transition", false)],
        ),
        prompt(
            "fix_comments",
            "Fix comments",
            "Review and address unresolved feedback.",
            vec![
                argument("page", false),
                argument("auto_resolve", false),
                argument("author", false),
            ],
        ),
        prompt(
            "watch_comments",
            "Watch comments",
            "Watch for new feedback.",
            vec![argument("minutes", false)],
        ),
    ]
}

fn prompt(name: &str, args: &Value) -> Result<Value> {
    let definition = prompt_catalog()
        .into_iter()
        .find(|prompt| prompt["name"] == name)
        .ok_or_else(|| EngineError::invalid("unknown prompt"))?;
    let argument = |key: &str, default: &str| {
        args[key]
            .as_str()
            .unwrap_or(default)
            .chars()
            .take(500)
            .collect::<String>()
    };
    if !args.is_null() && !args.is_object() {
        return Err(EngineError::invalid("prompt arguments must be an object"));
    }
    for item in definition["arguments"].as_array().unwrap() {
        let key = item["name"].as_str().unwrap();
        if item["required"] == true {
            string(args, key)?;
        }
        if args.get(key).is_some_and(|value| !value.is_string()) {
            return Err(EngineError::invalid(format!(
                "prompt argument {key} must be a string"
            )));
        }
    }
    let text = match name {
        "mobile_screen" => format!(
            "Create a {} screen for {}. Use {} as the primary color. Use editable text and frames, then inspect and render the result.",
            argument("screen", ""),
            argument("device", "iPhone 16"),
            argument("brand_color", "#3B5BDB")
        ),
        "design_system" => format!(
            "Build the {} design system around {}. Create reusable colors and text styles, light and dark values, and button variants. Verify the components in use.",
            argument("name", "Core"),
            argument("primary", "#3B5BDB")
        ),
        "landing_page" => format!(
            "Build a {}-wide landing page for {} with accent {}. Include a navigation bar, hero, feature grid, call to action and footer. Inspect and render the page.",
            argument("width", "1440"),
            argument("product", ""),
            argument("accent", "#7048E8")
        ),
        "prototype_flow" => format!(
            "Connect these screens in order: {}. Use {} transitions where available. Inspect the links and test the flow.",
            argument("screens", "Home, Details, Checkout"),
            argument("transition", "smartAnimate")
        ),
        "fix_comments" => format!(
            "Read unresolved comments for page {}. Inspect the relevant layers, fix and verify each issue, then reply as {}. Resolve after replying: {}.",
            argument("page", "all"),
            argument("author", "AI"),
            argument("auto_resolve", "yes")
        ),
        "watch_comments" => format!(
            "Watch for comment changes for {} minutes with wait_for_changes. Read each affected thread and verify any edits before replying.",
            argument("minutes", "5")
        ),
        _ => unreachable!(),
    };
    Ok(
        json!({"description":definition["description"],"messages":[{"role":"user","content":{"type":"text","text":text}}]}),
    )
}
