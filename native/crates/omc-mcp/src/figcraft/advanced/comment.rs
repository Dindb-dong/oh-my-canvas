use super::*;

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    match action {
        "markRead" => catalog(context, "comment.markRead", context.params),
        "open" => {
            let view = context.params["view"].as_str().unwrap_or("fit");
            if !matches!(view, "fit" | "center" | "keep") {
                return Err(EngineError::invalid("view must be fit, center or keep"));
            }
            let id = catalog(context, "comment.link", context.params)?["link"].clone();
            let list = list(
                context,
                &json!({"page":"all","author":context.params["author"]}),
            )?;
            let mut item = list
                .into_iter()
                .find(|comment| comment["link"] == id)
                .ok_or_else(|| EngineError::invalid("Comment not found"))?;
            reveal(context, &mut item, view)?;
            Ok(item)
        }
        "next" => {
            let list = list(context, context.params)?;
            let direction = context.params["dir"].as_f64().unwrap_or(1.);
            let current = context
                .params
                .get("id")
                .and_then(|id| list.iter().position(|comment| &comment["id"] == id));
            let position = if let Some(current) = current {
                if direction < 0. {
                    current.saturating_sub(1)
                } else {
                    (current + 1).min(list.len().saturating_sub(1))
                }
            } else if direction < 0. {
                list.len().saturating_sub(1)
            } else {
                0
            };
            let mut item = list
                .get(position)
                .cloned()
                .ok_or_else(|| EngineError::invalid("No comments in the list"))?;
            reveal(context, &mut item, "center")?;
            Ok(item)
        }
        "zoom" => {
            let ids = context.params["ids"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("ids must be an array of comment IDs"))?;
            let list = list(context, &json!({}))?;
            let bounds = list
                .iter()
                .filter(|item| ids.contains(&item["id"]))
                .map(point)
                .map(|(x, y)| [x, y, x, y])
                .reduce(union)
                .ok_or_else(|| EngineError::invalid("ids names no comments on the current page"))?;
            let current = context.state.view["viewport"]["zoom"]
                .as_f64()
                .unwrap_or(1.);
            let fit = fit_zoom(context, bounds);
            let zoom = current.mul_add(2., 0.).max(fit).clamp(0.01, 200.);
            viewport(context, None, bounds, zoom)?;
            Ok(json!({"zoom":zoom}))
        }
        "prompt" => prompt(context),
        _ => Err(EngineError::invalid("Unknown comment command")),
    }
}

impl ToolRouter {
    pub fn fig_comment_desktop_job(
        &self,
        session: &str,
        document: &str,
        command: &str,
        args: &Value,
        result: &Value,
    ) -> Result<Value> {
        let state = self.state(session, document)?;
        let thread = if let Some(id) = result["id"].as_u64() {
            let snapshot = self.workspace.snapshot(document)?;
            let entries = resources::catalogs(&snapshot.metadata, "comments");
            entries
                .iter()
                .find(|(raw, entry)| {
                    entry["threadId"].is_null() && crate::figcraft_catalog::comment_id(raw) == id
                })
                .map(|(raw, _)| raw.clone())
        } else {
            None
        };
        let viewport = &state.view["viewport"];
        let bounds = &viewport["vbox"];
        let center = bounds["x"]
            .as_f64()
            .zip(bounds["y"].as_f64())
            .and_then(|(x, y)| {
                Some([
                    x + bounds["width"].as_f64()? / 2.,
                    y + bounds["height"].as_f64()? / 2.,
                ])
            });
        Ok(
            json!({"document":document,"page":state.page_id,"thread":thread,"center":center,
            "zoom":viewport["zoom"],"keep":command == "comment.open" && args["params"]["view"] == "keep"}),
        )
    }
}

fn catalog(context: &Context, name: &str, params: &Value) -> Result<Value> {
    context.router.fig_catalog_command(
        context.session,
        context.snapshot,
        context.state,
        context.selection,
        name,
        params,
    )
}

fn list(context: &Context, params: &Value) -> Result<Vec<Value>> {
    Ok(array(
        catalog(context, "comment.list", params)?.get("comments"),
    ))
}

fn point(item: &Value) -> (f64, f64) {
    (
        item["x"].as_f64().unwrap_or_default(),
        item["y"].as_f64().unwrap_or_default(),
    )
}

fn union([x1, y1, x2, y2]: [f64; 4], [a, b, c, d]: [f64; 4]) -> [f64; 4] {
    [x1.min(a), y1.min(b), x2.max(c), y2.max(d)]
}

fn viewport_size(view: &Value) -> (f64, f64) {
    let viewport = &view["viewport"]["vport"];
    (
        viewport["width"].as_f64().unwrap_or(1000.),
        viewport["height"].as_f64().unwrap_or(800.),
    )
}

fn fit_zoom(context: &Context, [x1, y1, x2, y2]: [f64; 4]) -> f64 {
    let (width, height) = viewport_size(&context.state.view);
    ((width - 128.) / (x2 - x1).max(1.))
        .min((height - 128.) / (y2 - y1).max(1.))
        .clamp(0.01, 200.)
}

fn viewport(
    context: &Context,
    page: Option<&omc_model::Page>,
    [x1, y1, x2, y2]: [f64; 4],
    zoom: f64,
) -> Result<()> {
    let mut views = context.router.states.lock().unwrap();
    let state = views
        .get_mut(&(context.session.into(), context.snapshot.id.clone()))
        .ok_or_else(|| EngineError::invalid("Session document view has expired"))?;
    if let Some(page) = page.filter(|page| page.id != state.page_id) {
        state.page_id = page.id.clone();
        state.root = page.root_node_id.clone();
        state.aliases.clear();
        state.view["selection"] = json!([]);
    }
    let (width, height) = viewport_size(&state.view);
    let (w, h) = (width / zoom, height / zoom);
    state.view["viewport"] = json!({"zoom":zoom,"vport":{"width":width,"height":height},
        "vbox":{"x":(x1+x2-w)/2.,"y":(y1+y2-h)/2.,"width":w,"height":h}});
    Ok(())
}

fn reveal(context: &Context, item: &mut Value, view: &str) -> Result<()> {
    let page_id = context.resolve(&item["page"])?;
    let page = context
        .page(&page_id)
        .ok_or_else(|| EngineError::invalid("Comment page no longer exists"))?;
    let (x, y) = point(item);
    let previous = context.state.view["viewport"]["zoom"]
        .as_f64()
        .unwrap_or(1.);
    if view != "keep" || context.state.page_id != page.id {
        let mut bounds = [x, y, x, y];
        let mut zoom = previous;
        if view == "fit" {
            if !item["frame"].is_null() {
                let frame = context.resolve(&item["frame"])?;
                let scene = paths::scene(context.snapshot, &page.id)?;
                if let Some(layer) = scene.item(&frame) {
                    let [fx, fy, w, h] = layer.bounds;
                    bounds = union(bounds, [fx, fy, fx + w, fy + h]);
                    zoom = fit_zoom(context, bounds).min(1.);
                }
            } else {
                zoom = previous.max(1.);
            }
        }
        viewport(context, Some(page), bounds, zoom)?;
    }
    catalog(
        context,
        "comment.markRead",
        &json!({"id":item["id"],"author":context.params["author"]}),
    )?;
    item["unread"] = json!(false);
    Ok(())
}

fn prompt(context: &Context) -> Result<Value> {
    use std::fmt::Write;
    let params = context.params;
    let requested = params
        .get("ids")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_array()
                .filter(|ids| !ids.is_empty())
                .ok_or_else(|| EngineError::invalid("ids must be a nonempty array of comment IDs"))
        })
        .transpose()?;
    let filters = if requested.is_some() {
        json!({"page":"all","filter":"all"})
    } else {
        json!({"page":params.get("page").filter(|v| !v.is_null()).cloned().unwrap_or(json!("all")),
            "filter":params["filter"].as_str().unwrap_or(if params["includeResolved"] == true { "all" } else { "open" }),
            "sort":params["sort"].as_str().unwrap_or("date"),"query":params["query"]})
    };
    let mut entries = list(context, &filters)?;
    if let Some(requested) = requested {
        let mut unique = BTreeSet::new();
        let mut selected = Vec::new();
        for id in requested {
            let id = id
                .as_u64()
                .ok_or_else(|| EngineError::invalid("Expected a comment ID"))?;
            if unique.insert(id) {
                selected.push(
                    entries
                        .iter()
                        .find(|comment| comment["id"] == id)
                        .cloned()
                        .ok_or_else(|| EngineError::invalid("Comment not found"))?,
                );
            }
        }
        entries = selected;
    }
    let count = entries.len();
    let mut text = format!(
        "# Review comments for {}\n\n",
        context.snapshot.title.chars().take(200).collect::<String>()
    );
    let mut summary = Vec::new();
    let mut truncated = count > 200;
    for entry in entries.into_iter().take(200) {
        if text.len() > 240 * 1024 {
            truncated = true;
            break;
        }
        let _ = writeln!(
            text,
            "## Comment {} ({})\n{}\n",
            entry["id"],
            entry["pageName"],
            entry["link"].as_str().unwrap_or_default()
        );
        let add = |text: &mut String, entry: &Value| {
            let author = entry["author"].as_str().unwrap_or("Unknown");
            let message = entry["text"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(4096)
                .collect::<String>();
            let _ = writeln!(text, "**{}**", author.chars().take(80).collect::<String>());
            for line in message.lines() {
                let _ = writeln!(text, "> {line}");
            }
        };
        add(&mut text, &entry);
        let replies = entry["replies"].as_array().map_or(&[][..], Vec::as_slice);
        for reply in replies {
            if text.len() > 240 * 1024 {
                truncated = true;
                break;
            }
            add(&mut text, reply);
        }
        let mut brief = entry;
        brief["preview"] = json!(
            brief["text"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(160)
                .collect::<String>()
        );
        brief["replies"] = json!(brief["replies"].as_array().map_or(0, Vec::len));
        brief.as_object_mut().unwrap().remove("text");
        summary.push(brief);
    }
    if truncated {
        text.push_str("\nSome comments were omitted from this summary.\n");
    }
    Ok(json!({"count":count,"truncated":truncated,"text":text,"comments":summary}))
}
