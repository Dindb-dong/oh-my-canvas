use super::*;
use std::collections::BTreeSet;

mod board;
mod code_connect;
mod comment;
mod component;
mod component_playground;
pub(crate) mod dev_diff;
pub(crate) mod dev_status;
mod handoff;
mod inspect_code;
mod prototype;
pub(super) mod prototype_actions;
pub(crate) mod prototype_settings;
mod variant_property;
mod vote;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    (
        "annotation.add",
        "Add annotation",
        true,
        "{id?, label? | text?, properties?, category?}",
    ),
    (
        "annotation.edit",
        "Edit annotation",
        true,
        "{id?, index, label? | text?, properties?, category?}",
    ),
    (
        "annotation.remove",
        "Remove annotation",
        true,
        "{id?, index?}",
    ),
    (
        "annotation.list",
        "List annotations",
        false,
        "{ids? | id?, page?, category?}",
    ),
    (
        "annotation.categories",
        "Annotation categories",
        false,
        "{}",
    ),
    (
        "annotation.addCategory",
        "Add annotation category",
        true,
        "{name, color?}",
    ),
    (
        "annotation.editCategory",
        "Edit annotation category",
        true,
        "{id, name?, color?}",
    ),
    (
        "annotation.removeCategory",
        "Delete annotation category",
        true,
        "{id}",
    ),
    (
        "devResource.add",
        "Add dev resource",
        true,
        "{id?, url, name?}",
    ),
    (
        "devResource.edit",
        "Edit dev resource",
        true,
        "{id?, index, url?, name?}",
    ),
    (
        "devResource.remove",
        "Remove dev resource",
        true,
        "{id?, index?}",
    ),
    ("devResource.list", "List dev resources", false, "{id?}"),
    (
        "dev.compare",
        "Compare changes",
        false,
        "{id?, version?, show?}",
    ),
    (
        "dev.resolveChange",
        "Resolve change",
        true,
        "{ids?, reason?}",
    ),
    (
        "inspect.readyForDev",
        "Ready for dev",
        false,
        "{status?, page?}",
    ),
    (
        "inspect.code",
        "Code for layer",
        false,
        "{id?, language?, mobile?, unit?, rootFontSize?}",
    ),
    (
        "inspect.componentCode",
        "Component code",
        false,
        "{id?, language?}",
    ),
    (
        "codeConnect.set",
        "Connect to code",
        true,
        "{id?, language?, importPath?, name?, template?}",
    ),
    (
        "codeConnect.remove",
        "Disconnect from code",
        true,
        "{id?, language?}",
    ),
    (
        "codeConnect.export",
        "Export code connections",
        false,
        "{path?, overwrite?}",
    ),
    (
        "codeConnect.import",
        "Import code connections",
        true,
        "{json | path}",
    ),
    (
        "proto.interaction.add",
        "Add interaction",
        true,
        "{id?, dest | action | actions, trigger?, transition?, durationMs?, delayMs?, easing?}",
    ),
    (
        "proto.interaction.set",
        "Edit interaction",
        true,
        "{id?, index, interaction?, dest?, action?, actions?, trigger?, transition?, durationMs?, delayMs?, easing?}",
    ),
    (
        "proto.interaction.clear",
        "Remove all interactions",
        true,
        "{ids?}",
    ),
    (
        "proto.interaction.remove",
        "Remove interaction",
        true,
        "{id?, index}",
    ),
    (
        "proto.flow.add",
        "Add flow starting point",
        true,
        "{start?, name?}",
    ),
    (
        "proto.flow.rename",
        "Rename flow",
        true,
        "{start, name?, description?}",
    ),
    ("proto.flow.remove", "Remove flow", true, "{start}"),
    (
        "proto.settings",
        "Prototype settings",
        true,
        "{device?, background?, rotation?, color?, width?, height?, responsive?}",
    ),
    (
        "proto.linkNotice",
        "Prototype link notice",
        false,
        "{show?}",
    ),
    (
        "proto.presentOptions",
        "Presentation options",
        false,
        "{scale?, deviceFrame?, hotspotHints?, inspect?, hideUi?}",
    ),
    (
        "proto.action.add",
        "Add prototype action",
        true,
        "{id?, index, path?, action}",
    ),
    (
        "proto.action.set",
        "Edit prototype action",
        true,
        "{id?, index, path, action}",
    ),
    (
        "proto.action.remove",
        "Remove prototype action",
        true,
        "{id?, index, path}",
    ),
    (
        "proto.action.move",
        "Reorder prototype action",
        true,
        "{id?, index, path, to}",
    ),
    (
        "proto.conditional.addBlock",
        "Add conditional block",
        true,
        "{id?, index, path, else?, expression?, condition?}",
    ),
    (
        "proto.conditional.setCondition",
        "Edit condition",
        true,
        "{id?, index, path, block, expression | condition}",
    ),
    (
        "proto.conditional.removeBlock",
        "Remove conditional block",
        true,
        "{id?, index, path, block}",
    ),
    (
        "proto.evaluate",
        "Evaluate prototype expression",
        false,
        "{expression | expr, id?}",
    ),
    (
        "component.exposeInstance",
        "Expose nested instance",
        true,
        "{id?, exposed?}",
    ),
    (
        "instance.exposed",
        "Exposed nested instances",
        false,
        "{id?}",
    ),
    (
        "component.playground",
        "Component playground",
        false,
        "{id?, properties?, language?, path?, scale?}",
    ),
    (
        "component.combineVariants",
        "Combine as variants",
        true,
        "{ids?}",
    ),
    (
        "component.addVariant",
        "Add variant",
        true,
        "{id?, property?, value?}",
    ),
    (
        "component.hideWhenPublishing",
        "Hide when publishing",
        true,
        "{ids?, on?}",
    ),
    (
        "component.resetOverride",
        "Reset override",
        true,
        "{id?, group?}",
    ),
    (
        "component.properties",
        "Component properties",
        false,
        "{id?}",
    ),
    (
        "component.addProperty",
        "Add component property",
        true,
        "{id?, name, type, default?, layer?}",
    ),
    (
        "component.editProperty",
        "Edit component property",
        true,
        "{id?, name, newName?, default?}",
    ),
    (
        "component.deleteProperty",
        "Delete component property",
        true,
        "{id?, name}",
    ),
    (
        "component.bindProperty",
        "Bind layer to property",
        true,
        "{layer?, property, field?}",
    ),
    (
        "instance.setProperties",
        "Set instance properties",
        true,
        "{ids?, properties}",
    ),
    (
        "comment.markRead",
        "Mark comment as read",
        false,
        "{id? | link?, read?, author?}",
    ),
    (
        "comment.open",
        "Open comment",
        false,
        "{id | link, view?, author?}",
    ),
    (
        "comment.next",
        "Next comment",
        false,
        "{id?, dir?, page?, filter?, sort?, query?, frame?, resolved?, mentions?, author?}",
    ),
    ("comment.zoom", "Zoom to comments", false, "{ids}"),
    (
        "comment.prompt",
        "Copy comments for AI",
        false,
        "{ids?, page?, filter?, sort?, query?, includeResolved?}",
    ),
    (
        "board.sticky",
        "Sticky note",
        true,
        "{x?, y?, text?, color?, author?, parent?}",
    ),
    (
        "board.connector",
        "Connector",
        true,
        "from, to, fromSide?, toSide?, fromAt?, toAt?, style?, startCap?, endCap?, label?",
    ),
    (
        "board.reattach",
        "Reattach connector",
        true,
        "id?, end, target, side?, at?",
    ),
    (
        "board.reshape",
        "Reshape connector",
        true,
        "id?, portion, x, y",
    ),
    ("board.label", "Connector label", true, "id?, text"),
    (
        "board.addConnected",
        "Add connected shape",
        true,
        "id?, side?, at?, edit?",
    ),
    (
        "board.table",
        "Table",
        true,
        "rows?, columns?, cells?, x?, y?",
    ),
    ("board.tableEdit", "Edit table", true, "id?, action, index?"),
    (
        "board.grid",
        "Board grid",
        false,
        "style?, spacing?, major?, size?, contrast?, reset?",
    ),
    ("board.template", "Board template", true, "name, x?, y?"),
    ("board.templates", "List board templates", false, ""),
    ("board.nextSticky", "Next sticky note", true, "{id?, side?}"),
    (
        "board.shape",
        "Shape with text",
        true,
        "{shape, x, y, width?, height?, text?, color?, parent?}",
    ),
    (
        "board.ink",
        "Marker stroke",
        true,
        "{path | points, highlighter?, color?, select?}",
    ),
    ("board.stamp", "Stamp", true, "{x, y, stamp?}"),
    ("board.setColor", "Board color", true, "{ids?, color}"),
    (
        "board.setStyle",
        "Board style",
        true,
        "{ids?, shape?, fontSize?}",
    ),
    ("board.timer", "Timer", false, "{action, minutes?}"),
    ("board.timerState", "Timer state", false, "{}"),
    (
        "board.vote",
        "Voting session",
        false,
        "{action, votes?, on?, ids?, id?, index?, voter?}",
    ),
    ("board.voteResults", "Voting results", false, "{voter?}"),
];

impl ToolRouter {
    pub fn native_board_tool(&self, session: &str, args: &Value) -> Result<Value> {
        let command = string(args, "command")?;
        if !matches!(command, "board.sticky" | "board.shape" | "board.stamp" | "board.connector") {
            return Err(EngineError::invalid("Unknown board creation tool"));
        }
        let document = self.workspace.target(session, Some(string(args, "documentId")?))?;
        let snapshot = self.workspace.snapshot(&document)?;
        let sequence = string(args, "sequence")?.parse::<u64>()
            .map_err(|_| EngineError::invalid("sequence must be a native revision number"))?;
        if string(args, "epoch")? != snapshot.epoch || sequence != snapshot.sequence {
            return Err(EngineError::new("stale_revision", "The canvas changed during the gesture"));
        }
        let page = snapshot.pages.iter().find(|page| page.id == args["page"])
            .ok_or_else(|| EngineError::invalid("The board page is unavailable"))?;
        self.context_from(session, &snapshot)?;
        let mut state = self.state(session, &document)?;
        state.page_id = page.id.clone();
        state.root = page.root_node_id.clone();
        let mut params = args["params"].as_object().cloned()
            .ok_or_else(|| EngineError::invalid("Expected board tool parameters"))?;
        params.remove("edit");
        if command == "board.connector" {
            for key in ["from", "to"] {
                if let Some(raw) = params.get(key).and_then(Value::as_str) {
                    if !snapshot.nodes.contains_key(raw) {
                        return Err(EngineError::invalid("The connector target is unavailable"));
                    }
                    params.insert(key.into(), json!(self.fig_alias(session, &document, raw)));
                }
            }
        }
        let result = self.fig_advanced_command(session, &snapshot, &state, &[], command, &Value::Object(params))?;
        let current = self.workspace.snapshot(&document)?;
        let selected = self.fig_layer(session, &current, &result["id"])?;
        let edit_label = result.get("text")
            .map(|id| self.fig_layer(session, &current, id))
            .transpose()?;
        Ok(json!({"nativeSelection":[selected],"editLabel":edit_label}))
    }

    pub(super) fn fig_advanced_command(
        &self,
        session: &str,
        snapshot: &DocumentSnapshot,
        state: &ViewState,
        selection: &[Value],
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let (family, action) = name
            .split_once('.')
            .ok_or_else(|| EngineError::invalid("Unknown command"))?;
        let command = Context {
            router: self,
            session,
            snapshot,
            state,
            selection,
            params,
        };
        match family {
            "annotation" => handoff::annotation(&command, action),
            "dev" if action == "compare" => dev_diff::compare(&command),
            "dev" if action == "resolveChange" => dev_diff::resolve(&command),
            "devResource" => handoff::dev_resource(&command, action),
            "inspect" if action == "readyForDev" => dev_status::ready(&command),
            "inspect" if action == "code" || action == "componentCode" => {
                inspect_code::command(&command, action == "componentCode")
            }
            "codeConnect" => code_connect::command(&command, action),
            "proto" => prototype::command(&command, action),
            "comment" => comment::command(&command, action),
            "board" => board::command(&command, action),
            "component" if action == "playground" => component_playground::command(&command),
            "component" => component::command(&command, action),
            "instance" if action == "exposed" => component::exposed(&command),
            "instance" if action == "setProperties" => component::set_properties(&command),
            _ => Err(EngineError::invalid("Unknown command")),
        }
    }
}

struct Context<'a> {
    router: &'a ToolRouter,
    session: &'a str,
    snapshot: &'a DocumentSnapshot,
    state: &'a ViewState,
    selection: &'a [Value],
    params: &'a Value,
}

impl Context<'_> {
    fn resolve(&self, id: &Value) -> Result<String> {
        self.router.fig_layer(self.session, self.snapshot, id)
    }

    fn alias(&self, raw: &str) -> u64 {
        self.router.fig_alias(self.session, &self.snapshot.id, raw)
    }

    fn one(&self) -> Result<String> {
        self.params
            .get("id")
            .or_else(|| self.selection.first())
            .ok_or_else(|| EngineError::invalid("Select a layer or pass id"))
            .and_then(|id| self.resolve(id))
    }

    fn many(&self) -> Result<Vec<String>> {
        let ids = if let Some(ids) = self.params.get("ids") {
            ids.as_array()
                .ok_or_else(|| EngineError::invalid("ids must be an array"))?
                .as_slice()
        } else if let Some(id) = self.params.get("id") {
            std::slice::from_ref(id)
        } else {
            self.selection
        };
        if ids.is_empty() || ids.len() > 100 {
            return Err(EngineError::invalid("Select between 1 and 100 layers"));
        }
        let ids = ids
            .iter()
            .map(|id| self.resolve(id))
            .collect::<Result<Vec<_>>>()?;
        if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
            return Err(EngineError::invalid("Layer IDs must be unique"));
        }
        Ok(ids)
    }

    fn commit(&self, mut commands: Vec<Command>) -> Result<()> {
        let command = match commands.len() {
            0 => return Ok(()),
            1 => commands.pop().unwrap(),
            _ => Command::Batch { commands },
        };
        self.router.submit(
            self.session,
            &self.snapshot.id,
            command,
            &Value::Null,
            Some(self.snapshot.sequence),
        )?;
        Ok(())
    }

    fn patch(&self, node_id: &str, key: &str, value: Value) -> Command {
        Command::NodeSet {
            node_id: node_id.into(),
            properties: Properties::from([(key.into(), value)]),
        }
    }

    fn page(&self, id: &str) -> Option<&omc_model::Page> {
        let mut root = self.snapshot.nodes.get(id)?;
        while let Some(parent) = root.parent_id.as_ref() {
            root = self.snapshot.nodes.get(parent)?;
        }
        self.snapshot
            .pages
            .iter()
            .find(|page| page.root_node_id == root.id)
    }
}

fn index(params: &Value, key: &str) -> Result<usize> {
    params[key]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .ok_or_else(|| EngineError::invalid(format!("{key} must be a nonnegative integer")))
}

fn array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}
