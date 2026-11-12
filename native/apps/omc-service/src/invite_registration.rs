use super::*;

pub async fn command(app: &App, args: Value) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", &args)?;
    let empty = json!({});
    let params = args.get("params").unwrap_or(&empty);
    omc_mcp::schema::check(
        &json!({"type":"object","properties":{"on":{"type":"boolean"}},"additionalProperties":false}),
        params,
        "params",
    )?;
    #[cfg(windows)]
    {
        let workspace = app.workspace.clone();
        let on = params["on"].as_bool();
        tokio::task::spawn_blocking(move || windows::change(&workspace, on))
            .await
            .map_err(|_| EngineError::new("internal_error", "invite registration worker stopped"))?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(EngineError::new(
            "unsupported_feature",
            "Runtime invite-link registration is available on Windows. macOS and Linux use native package declarations.",
        ))
    }
}

#[cfg(any(windows, test))]
mod registration {
    use std::path::Path;

    pub(super) const KEY: &str = r"Software\Classes\omc-native";
    pub(super) trait Registry {
        fn get(&self, key: &str, name: &str) -> Option<String>;
        fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String>;
        fn remove_tree(&mut self, key: &str) -> Result<(), String>;
    }

    pub(super) struct UrlScheme<'a, R> {
        pub(super) registry: R,
        pub(super) executable: &'a Path,
    }

    impl<R: Registry> UrlScheme<'_, R> {
        fn command_key(&self) -> String {
            format!(r"{KEY}\shell\open\command")
        }

        fn command(&self) -> String {
            format!("\"{}\" \"%1\"", self.executable.display())
        }

        pub(super) fn registered(&self) -> bool {
            self.registry
                .get(&self.command_key(), "")
                .is_some_and(|value| value.eq_ignore_ascii_case(&self.command()))
        }

        pub(super) fn set(&mut self, on: bool) -> Result<bool, String> {
            if on {
                let values = [
                    (KEY.into(), "", "URL:Oh My Canvas invitation".into()),
                    (KEY.into(), "URL Protocol", String::new()),
                    (
                        format!(r"{KEY}\DefaultIcon"),
                        "",
                        format!("\"{}\",0", self.executable.display()),
                    ),
                    (self.command_key(), "", self.command()),
                ];
                for (key, name, value) in values {
                    self.registry.set(&key, name, &value)?;
                }
            } else if self.registered() {
                self.registry.remove_tree(KEY)?;
            }
            let actual = self.registered();
            if actual != on {
                return Err("the invite association did not reach the requested state".into());
            }
            Ok(actual)
        }
    }

    pub(super) fn requested(on: Option<bool>, preference: Option<bool>, installed: bool) -> bool {
        on.unwrap_or(!preference.unwrap_or(installed))
    }
}

#[cfg(windows)]
pub fn startup(workspace: &Workspace) {
    windows::startup(workspace);
}

#[cfg(windows)]
mod windows {
    use super::{registration::*, *};
    use std::{path::PathBuf, ptr, sync::Mutex};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{
            HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegCloseKey, RegCreateKeyW, RegDeleteTreeW,
            RegGetValueW, RegSetValueExW,
        },
    };

    static SERIALIZE: Mutex<()> = Mutex::new(());

    struct CurrentUser;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(code: u32) -> std::result::Result<(), String> {
        if code == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(code as i32).to_string())
        }
    }

    impl Registry for CurrentUser {
        fn get(&self, key: &str, name: &str) -> Option<String> {
            let key = wide(key);
            let name = wide(name);
            let mut length = 0;
            // The two UTF-16 strings are NUL-terminated and the size pointer is writable.
            check(unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut length,
                )
            })
            .ok()?;
            if length == 0 || length > 128 * 1024 || length % 2 != 0 {
                return None;
            }
            let mut value = vec![0u16; length as usize / 2];
            // The buffer contains length bytes and the API reports the written byte length.
            check(unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ,
                    ptr::null_mut(),
                    value.as_mut_ptr().cast(),
                    &mut length,
                )
            })
            .ok()?;
            value.truncate(length as usize / 2);
            String::from_utf16(value.strip_suffix(&[0]).unwrap_or(&value)).ok()
        }

        fn set(&mut self, key: &str, name: &str, value: &str) -> std::result::Result<(), String> {
            let key = wide(key);
            let name = wide(name);
            let value = wide(value);
            let mut handle = ptr::null_mut();
            // Windows writes a key handle into the supplied pointer when opening succeeds.
            check(unsafe { RegCreateKeyW(HKEY_CURRENT_USER, key.as_ptr(), &mut handle) })?;
            // This handle was just acquired and the data is NUL-terminated UTF-16, including in
            // the empty URL Protocol value.
            let result = check(unsafe {
                RegSetValueExW(
                    handle,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            });
            // The handle remains valid until closed, regardless of the write result.
            unsafe { RegCloseKey(handle) };
            result
        }

        fn remove_tree(&mut self, key: &str) -> std::result::Result<(), String> {
            let key = wide(key);
            // Deletion uses only the app's fixed, NUL-terminated key under the current user.
            check(unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr()) })
        }
    }

    fn application() -> std::result::Result<(PathBuf, bool), String> {
        let executable = std::env::current_exe()
            .map_err(|error| error.to_string())?
            .with_file_name("omc-desktop.exe");
        if !executable.is_file() {
            return Err("omc-desktop.exe must be installed beside omc-service.exe".into());
        }
        let installed = !cfg!(debug_assertions)
            && !executable
                .ancestors()
                .skip(1)
                .any(|parent| parent.join("CACHEDIR.TAG").is_file());
        Ok((executable, installed))
    }

    pub(super) fn change(workspace: &Workspace, on: Option<bool>) -> Result<Value> {
        let _lock = SERIALIZE.lock().unwrap();
        let (executable, installed) = application().map_err(registration_error)?;
        let mut association = UrlScheme {
            registry: CurrentUser,
            executable: &executable,
        };
        let on = requested(on, workspace.preferences().invite_links, installed);
        let registered = association.set(on).map_err(registration_error)?;
        workspace.update_preference(|prefs| {
            prefs.invite_links = Some(on);
            json!({"on":on,"registered":registered})
        })
    }

    pub(super) fn startup(workspace: &Workspace) {
        let Ok((executable, installed)) = application() else {
            return;
        };
        let Some(on) = workspace
            .preferences()
            .invite_links
            .or(installed.then_some(true))
        else {
            return;
        };
        let mut association = UrlScheme {
            registry: CurrentUser,
            executable: &executable,
        };
        if association.registered() != on
            && let Err(error) = association.set(on)
        {
            eprintln!("Native invitation registration: {error}");
        }
    }

    fn registration_error(error: String) -> EngineError {
        EngineError::new("registration_failed", error)
    }
}

#[cfg(test)]
mod tests {
    use super::registration::*;
    use std::{collections::BTreeMap, path::Path};

    #[derive(Default)]
    struct MemoryRegistry(BTreeMap<(String, String), String>);

    impl Registry for MemoryRegistry {
        fn get(&self, key: &str, name: &str) -> Option<String> {
            self.0.get(&(key.into(), name.into())).cloned()
        }

        fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
            self.0.insert((key.into(), name.into()), value.into());
            Ok(())
        }

        fn remove_tree(&mut self, key: &str) -> Result<(), String> {
            let subtree = format!(r"{key}\");
            self.0
                .retain(|(path, _), _| path != key && !path.starts_with(&subtree));
            Ok(())
        }
    }

    #[test]
    fn invite_scheme_registration_uses_shell_uri_and_preserves_other_copies() {
        let mut owner = UrlScheme {
            registry: MemoryRegistry::default(),
            executable: Path::new(r"C:\Program Files\Oh My Canvas\omc-desktop.exe"),
        };
        assert!(!owner.registered());
        assert!(owner.set(true).unwrap());
        assert_eq!(
            owner
                .registry
                .get(&format!(r"{KEY}\shell\open\command"), "")
                .as_deref(),
            Some(r#""C:\Program Files\Oh My Canvas\omc-desktop.exe" "%1""#)
        );
        assert_eq!(owner.registry.get(KEY, "URL Protocol").as_deref(), Some(""));
        let mut different = UrlScheme {
            registry: owner.registry,
            executable: Path::new(r"D:\Oh My Canvas\omc-desktop.exe"),
        };
        assert!(!different.set(false).unwrap());
        assert_eq!(different.registry.0.len(), 4);
        owner.registry = different.registry;
        assert!(!owner.set(false).unwrap());
        assert!(owner.registry.0.is_empty());
        assert!(requested(None, None, false));
        assert!(!requested(None, None, true));
        assert!(!requested(None, Some(true), false));
        assert!(requested(Some(true), Some(true), false));
    }
}
