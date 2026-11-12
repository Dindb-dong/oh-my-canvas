//! A real native accessibility tree for controls and the active text buffer.
//! OS screen-reader journeys remain separate platform qualification gates.
use crate::{
    app::{Action, App, EditTarget, FOOTER, HEADER},
    geometry::Rect,
};
use accesskit::{
    Action as AxAction, ActionData, Node, NodeId, Rect as AxRect, Role, TextPosition,
    TextSelection, Toggled, TreeId, TreeInfo, TreeUpdate,
};

const ROOT: NodeId = NodeId(1);
const EDITOR: NodeId = NodeId(1_u64 << 60);
const TEXT_RUN: NodeId = NodeId((1_u64 << 60) + 1);
const STATUS: NodeId = NodeId((1_u64 << 60) + 2);
const INSPECTOR_DETAIL_START: u64 = (1_u64 << 60) + 100;

fn bounds(r: Rect, scale: f64) -> AxRect {
    AxRect::new(
        r.x * scale,
        r.y * scale,
        (r.x + r.width) * scale,
        (r.y + r.height) * scale,
    )
}

pub fn tree(app: &App) -> TreeUpdate {
    let scale = app.window.as_ref().map_or(1., |w| w.scale_factor());
    let mut root = Node::new(Role::Window);
    root.set_label("Oh My Canvas");
    root.set_bounds(AxRect::new(0., 0., app.width * scale, app.height * scale));
    let mut children = vec![];
    let mut nodes = vec![];
    for control in &app.controls {
        let id = NodeId(control.id);
        children.push(id);
        let layer_toggle = matches!(
            control.action,
            Action::LayerVisibility(_) | Action::LayerLock(_)
        );
        let mut node = Node::new(if control.field_value.is_some() {
            Role::TextInput
        } else if layer_toggle {
            Role::CheckBox
        } else if control.rect.y < HEADER && matches!(control.action, Action::Open(_)) {
            Role::Tab
        } else {
            Role::Button
        });
        node.set_label(control.label.clone());
        node.set_bounds(bounds(control.rect, scale));
        if !app.action_available(&control.action) {
            node.set_disabled();
        } else {
            node.add_action(AxAction::Focus);
            node.add_action(AxAction::Click);
        }
        if let Some(value) = &control.field_value {
            node.set_value(value.clone());
            node.add_action(AxAction::SetValue);
        }
        if layer_toggle {
            node.set_toggled(Toggled::from(control.selected));
        } else if control.selected {
            node.set_selected(true);
        }
        nodes.push((id, node));
    }
    for (index, (rect, label)) in crate::inspector::detail_text(app).into_iter().enumerate() {
        let id = NodeId(INSPECTOR_DETAIL_START + index as u64);
        let mut node = Node::new(Role::Label);
        node.set_label(label);
        node.set_bounds(bounds(rect, scale));
        children.push(id);
        nodes.push((id, node));
    }
    let focus = if let Some(edit) = &app.editing
        && let Some(r) = crate::text_ui::editor_rect(app)
    {
        let mut node = Node::new(if matches!(edit.target, EditTarget::Text { .. }) {
            Role::MultilineTextInput
        } else {
            Role::TextInput
        });
        node.set_label(match &edit.target {
            EditTarget::Text { .. } => "Canvas text",
            EditTarget::Title => "Document name",
            EditTarget::Page { .. } => "Page name",
            EditTarget::Catalog { property, .. } => property,
            EditTarget::Property { property, .. } => property,
        });
        node.set_bounds(bounds(r, scale));
        node.set_value(edit.buffer.display_text());
        node.set_children([TEXT_RUN]);
        node.add_action(AxAction::Focus);
        node.add_action(AxAction::SetTextSelection);
        node.add_action(AxAction::ReplaceSelectedText);
        node.add_action(AxAction::SetValue);
        let display = edit.buffer.display_text();
        let (anchor, caret) = if edit.buffer.preedit.is_empty() {
            (
                edit.buffer.text[..edit.buffer.anchor].chars().count(),
                edit.buffer.text[..edit.buffer.caret].chars().count(),
            )
        } else {
            node.set_description("Input method composition in progress");
            let prefix = edit.buffer.text[..edit.buffer.selection().start]
                .chars()
                .count();
            (prefix, prefix + edit.buffer.preedit.chars().count())
        };
        node.set_text_selection(TextSelection {
            anchor: TextPosition {
                node: TEXT_RUN,
                character_index: anchor,
            },
            focus: TextPosition {
                node: TEXT_RUN,
                character_index: caret,
            },
        });
        let mut run = Node::new(Role::TextRun);
        run.set_value(display.clone());
        run.set_character_lengths(
            display
                .chars()
                .map(|c| c.len_utf8() as u8)
                .collect::<Vec<_>>(),
        );
        run.set_bounds(bounds(r, scale));
        nodes.push((EDITOR, node));
        nodes.push((TEXT_RUN, run));
        children.push(EDITOR);
        EDITOR
    } else if children.contains(&NodeId(app.focus)) {
        NodeId(app.focus)
    } else {
        ROOT
    };
    let mut status = Node::new(Role::Label);
    status.set_label(app.error.as_deref().unwrap_or(&app.status));
    status.set_bounds(bounds(
        Rect::new(0., app.height - FOOTER, app.width, FOOTER),
        scale,
    ));
    children.push(STATUS);
    nodes.push((STATUS, status));
    root.set_children(children);
    nodes.push((ROOT, root));
    let mut info = TreeInfo::new(ROOT);
    info.toolkit_name = Some("Oh My Canvas native controls".into());
    info.toolkit_version = Some(env!("CARGO_PKG_VERSION").into());
    TreeUpdate {
        nodes,
        tree: Some(info),
        tree_id: TreeId::ROOT,
        focus,
    }
}

pub fn handle(app: &mut App, event: accesskit_winit::Event) {
    if app
        .window
        .as_ref()
        .is_none_or(|w| w.id() != event.window_id)
    {
        return;
    }
    match event.window_event {
        accesskit_winit::WindowEvent::InitialTreeRequested => {
            let update = tree(app);
            if let Some(adapter) = &mut app.access {
                adapter.update_if_active(|| update);
            }
        }
        accesskit_winit::WindowEvent::ActionRequested(request) => {
            if request.target_node == EDITOR {
                if let Some(edit) = &mut app.editing {
                    if edit.buffer.composing {
                        return;
                    }
                    match (request.action, request.data) {
                        (
                            AxAction::SetTextSelection,
                            Some(ActionData::SetTextSelection(selection)),
                        ) if selection.anchor.node == TEXT_RUN
                            && selection.focus.node == TEXT_RUN =>
                        {
                            let offset = |index: usize| {
                                edit.buffer
                                    .text
                                    .char_indices()
                                    .nth(index)
                                    .map_or(edit.buffer.text.len(), |(i, _)| i)
                            };
                            edit.buffer.anchor = offset(selection.anchor.character_index);
                            edit.buffer.caret = offset(selection.focus.character_index);
                        }
                        (AxAction::ReplaceSelectedText, Some(ActionData::Value(value))) => {
                            edit.buffer.insert(&value)
                        }
                        (AxAction::SetValue, Some(ActionData::Value(value))) => {
                            edit.buffer.select_all();
                            edit.buffer.insert(&value);
                        }
                        _ => {}
                    }
                }
            } else if let Some(control) = app
                .controls
                .iter()
                .find(|c| c.id == request.target_node.0)
                .cloned()
            {
                match (request.action, request.data) {
                    (AxAction::Focus, _) => {
                        app.focus = control.id;
                        app.keyboard_focus_visible = true;
                    }
                    (AxAction::Click, _) => app.action(control.action),
                    (AxAction::SetValue, Some(ActionData::Value(value))) => {
                        if matches!(control.action, Action::Field(_)) {
                            app.action(control.action);
                            if let Some(edit) = &mut app.editing {
                                edit.buffer.select_all();
                                edit.buffer.insert(&value);
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Some(window) = &app.window {
                window.request_redraw();
            }
        }
        accesskit_winit::WindowEvent::AccessibilityDeactivated => {}
    }
}
