use super::*;

pub(super) const COMMANDS: &[(&str, &str, bool, &str)] = &[
    ("pref.autoSave", "Save files automatically", false, "on?"),
    ("pref.language", "Interface language", false, "language"),
    ("pref.userName", "Your name", false, "name"),
];

impl ToolRouter {
    pub(super) fn fig_profile_preference(&self, name: &str, args: &Value) -> Result<Value> {
        let (key, format, required) = match name {
            "pref.autoSave" => ("on", json!({"type":"boolean"}), json!([])),
            "pref.language" => (
                "language",
                json!({"type":"string","maxLength":35}),
                json!(["language"]),
            ),
            "pref.userName" => (
                "name",
                json!({"type":"string","maxLength":1024}),
                json!(["name"]),
            ),
            _ => unreachable!(),
        };
        schema::check(
            &json!({"type":"object","properties":{(key):format},"required":required,"additionalProperties":false}),
            args,
            "params",
        )?;
        match name {
            "pref.autoSave" => self.workspace.update_preference(|prefs| {
                prefs.auto_save = args["on"].as_bool().unwrap_or(!prefs.auto_save);
                json!({"on":prefs.auto_save})
            }),
            "pref.language" => {
                let tag = args["language"].as_str().unwrap().trim();
                if !tag.split(['-', '_']).all(|part| {
                    !part.is_empty()
                        && part.len() <= 8
                        && part.bytes().all(|b| b.is_ascii_alphanumeric())
                }) {
                    return Err(EngineError::invalid(format!(
                        "`{tag}` is not a language code"
                    )));
                }
                self.workspace.update_preference(|prefs| {
                    prefs.language = tag.into();
                    json!({"language":prefs.language})
                })
            }
            "pref.userName" => {
                let name: String = args["name"]
                    .as_str()
                    .unwrap()
                    .trim()
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(omc_workspace::PROFILE_NAME_LIMIT)
                    .collect();
                self.workspace.update_preference(|prefs| {
                    prefs.user_name = name;
                    json!({"name":if prefs.user_name.is_empty() {"You"} else {&prefs.user_name}})
                })
            }
            _ => unreachable!(),
        }
    }
}
