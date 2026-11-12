use super::*;

const PAGE_SIZE: usize = 4;

#[derive(Default)]
pub(super) struct Panel {
    lease: Option<String>,
    plugins: Vec<Value>,
    page: usize,
    ticket: u64,
    pending: bool,
    message: Option<String>,
}

impl Panel {
    fn pages(&self) -> usize {
        self.plugins.len().div_ceil(PAGE_SIZE).max(1)
    }

    fn receive(&mut self, payload: &Value) -> Result<(), String> {
        let lease = payload["lease"]
            .as_str()
            .ok_or("Plugin manager session was not provided.")?;
        let plugins = payload["listing"]["plugins"]
            .as_array()
            .ok_or("Plugin list was not provided.")?;
        self.lease = Some(lease.to_owned());
        self.plugins = plugins.clone();
        self.page = self.page.min(self.pages() - 1);
        Ok(())
    }
}

impl App {
    pub(super) fn show_plugin_manager(&mut self, payload: &Value) -> Result<Value, String> {
        let panel = &mut self.automation.plugin_manager;
        let ticket = panel.ticket.wrapping_add(1);
        *panel = Panel {
            ticket,
            ..Panel::default()
        };
        panel.receive(payload)?;
        self.popup = Some(Popup::Utility(UtilityPopup::Plugins));
        self.focus = crate::paint::POPUP_FIRST;
        self.redraw();
        Ok(json!({"shown":true}))
    }

    pub(in crate::app) fn open_native_plugin_manager(&mut self) {
        let ticket = self.automation.plugin_manager.ticket;
        self.automation.plugin_manager = Panel {
            ticket,
            ..Panel::default()
        };
        self.send_plugin_manager("open", None);
    }

    pub(in crate::app) fn send_plugin_manager(
        &mut self,
        operation: &'static str,
        plugin: Option<String>,
    ) {
        self.popup = Some(Popup::Utility(UtilityPopup::Plugins));
        let panel = &mut self.automation.plugin_manager;
        if panel.pending {
            return;
        }
        if self.background && operation == "import" {
            panel.message = Some("The file picker is unavailable in background automation.".into());
            self.redraw();
            return;
        }
        panel.ticket = panel.ticket.wrapping_add(1);
        let document = self
            .active
            .as_deref()
            .and_then(|id| Uuid::parse_str(id.strip_prefix("doc_")?).ok())
            .map(|id| id.to_string());
        let request = Request::PluginManager {
            window: self.proxy.id,
            ticket: panel.ticket,
            operation,
            arguments: json!({"lease":panel.lease,"plugin":plugin,"document":document,
                "page":self.page,"selection":self.selected}),
        };
        panel.pending = true;
        panel.message = None;
        if let Err(error) = self
            .plugin_bridge
            .as_ref()
            .unwrap_or(&self.bridge)
            .send(request)
        {
            panel.pending = false;
            panel.message = Some(error);
        }
        self.redraw();
    }

    pub(in crate::app) fn page_plugin_manager(&mut self, next: bool) {
        let panel = &mut self.automation.plugin_manager;
        panel.page = if next {
            (panel.page + 1).min(panel.pages() - 1)
        } else {
            panel.page.saturating_sub(1)
        };
        self.popup = Some(Popup::Utility(UtilityPopup::Plugins));
        self.redraw();
    }

    pub(in crate::app) fn plugin_manager_key(&mut self, key: &Key) -> bool {
        if self.popup != Some(Popup::Utility(UtilityPopup::Plugins)) {
            return false;
        }
        let controls = crate::paint::controls(self)
            .into_iter()
            .filter(|control| {
                control.id >= crate::paint::POPUP_FIRST && self.action_available(&control.action)
            })
            .collect::<Vec<_>>();
        match key {
            Key::Named(NamedKey::Escape) => self.action(Action::ClosePopup),
            Key::Named(NamedKey::Tab) if !controls.is_empty() => {
                let backward = self.modifiers.shift_key();
                let index = controls
                    .iter()
                    .position(|control| control.id == self.focus)
                    .map_or(if backward { controls.len() - 1 } else { 0 }, |current| {
                        (current + if backward { controls.len() - 1 } else { 1 }) % controls.len()
                    });
                self.focus = controls[index].id;
                self.keyboard_focus_visible = true;
            }
            Key::Named(NamedKey::Enter) => {
                if let Some(control) = controls
                    .into_iter()
                    .find(|control| control.id == self.focus)
                {
                    self.action(control.action);
                }
            }
            _ => (),
        }
        self.redraw();
        true
    }

    pub(in crate::app) fn finish_plugin_manager(
        &mut self,
        ticket: u64,
        operation: &str,
        result: Result<Value, String>,
    ) {
        let panel = &mut self.automation.plugin_manager;
        if ticket != panel.ticket {
            return;
        }
        panel.pending = false;
        panel.message = match result {
            Ok(value) if value.is_null() => None,
            Ok(value) => panel.receive(&value).err(),
            Err(error) => Some(error),
        };
        if operation == "run" && panel.message.is_none() {
            panel.message = Some("Plugin ran successfully.".into());
            if let Some(id) = self.active.clone() {
                self.send(Request::Snapshot { id });
            }
        }
        self.redraw();
    }

    pub(crate) fn plugin_manager_entries(&self) -> (&[Value], usize, usize, bool, Option<&str>) {
        let panel = &self.automation.plugin_manager;
        let start = panel.page * PAGE_SIZE;
        let entries = &panel.plugins[start..(start + PAGE_SIZE).min(panel.plugins.len())];
        (
            entries,
            panel.page,
            panel.pages(),
            panel.pending,
            panel.message.as_deref(),
        )
    }

    pub(super) fn plugin_manager_state(&self) -> Value {
        if self.popup != Some(Popup::Utility(UtilityPopup::Plugins)) {
            return Value::Null;
        }
        let panel = &self.automation.plugin_manager;
        let controls = crate::paint::controls(self)
            .iter()
            .filter_map(|control| {
                let Action::PluginManager(operation, plugin) = &control.action else {
                    return None;
                };
                let area = control.rect;
                Some(
                    json!({"id":control.id,"operation":operation,"plugin":plugin,"label":control.label,
                "rect":[area.x,area.y,area.width,area.height]}),
                )
            })
            .collect::<Vec<_>>();
        json!({"plugins":panel.plugins.iter().map(|plugin| json!({
            "id":plugin["id"],"name":plugin["name"],"version":plugin["version"],
        })).collect::<Vec<_>>(),"page":panel.page,"pending":panel.pending,"message":panel.message,
            "focusedControl":self.focus,"controls":controls})
    }
}
