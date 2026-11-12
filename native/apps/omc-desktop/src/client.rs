//! The desktop is a protocol client. All authored state and durable writes belong
//! to omc-service; this module deliberately has no engine/storage dependency.
use base64::Engine as _;
use omc_model::DocumentSnapshot;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use winit::event_loop::EventLoopProxy;

const MAX_REPLY_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXPORT_REPLY_BYTES: usize = 96 * 1024 * 1024;
const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PASTE_HTML_BYTES: usize = 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntry {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug)]
pub enum Request {
    Refresh,
    Create {
        title: String,
    },
    Open {
        id: String,
    },
    Import,
    ImportHtml {
        html: String,
    },
    Export {
        id: String,
        page: Option<String>,
        title: String,
    },
    Snapshot {
        id: String,
    },
    Command {
        id: String,
        epoch: String,
        sequence: u64,
        command: Value,
        undo_group: String,
    },
    Undo {
        id: String,
        epoch: String,
        redo: bool,
    },
    CaptureText {
        id: String,
        node_id: String,
        epoch: String,
        sequence: u64,
        start: u32,
        end: u32,
    },
    Splice {
        id: String,
        epoch: String,
        selection: Value,
        text: String,
    },
    Save {
        id: String,
    },
    Close {
        id: String,
    },
    Collaboration {
        action: &'static str,
        args: Value,
    },
    Shutdown,
}

#[derive(Debug)]
pub enum Response {
    Connected,
    Collaboration {
        action: &'static str,
        result: Result<(Value, Option<DocumentSnapshot>), String>,
    },
    Documents(Vec<DocumentEntry>),
    Snapshot {
        document: DocumentSnapshot,
        mutation: bool,
        activate: bool,
    },
    TextAnchors {
        id: String,
        node_id: String,
        selection: Value,
    },
    Saved {
        id: String,
    },
    Closed {
        id: String,
    },
    FileOperation {
        message: String,
    },
    Error {
        message: String,
        mutation: bool,
    },
    Shutdown,
}

#[derive(Deserialize)]
struct Descriptor {
    protocol: String,
    endpoint: String,
    token: String,
}

impl Descriptor {
    fn ready(path: &Path, http: &reqwest::blocking::Client) -> Result<Option<Self>, String> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Could not read the service endpoint: {error}")),
        };
        if bytes.len() > 16 * 1024 {
            return Err("The service descriptor is too large.".into());
        }
        let mut descriptor: Self = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid service descriptor: {e}"))?;
        if descriptor.protocol != "omc.service/1" {
            return Err("This service uses an incompatible protocol.".into());
        }
        let url = reqwest::Url::parse(&descriptor.endpoint)
            .map_err(|_| "Invalid service endpoint.".to_string())?;
        if url.scheme() != "http"
            || !matches!(
                url.host_str(),
                Some("127.0.0.1") | Some("[::1]") | Some("::1")
            )
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(
                "The service endpoint must use an authenticated loopback connection.".into(),
            );
        }
        descriptor.endpoint = descriptor.endpoint.trim_end_matches('/').to_string();
        let healthy = http
            .get(format!("{}/health", descriptor.endpoint))
            .bearer_auth(&descriptor.token)
            .timeout(Duration::from_millis(200))
            .send()
            .is_ok_and(|response| response.status().is_success());
        Ok(healthy.then_some(descriptor))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn stale_descriptor_stops_being_ready_when_its_service_exits() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = BufReader::new(&stream);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), "GET /health HTTP/1.1");
            let authenticated = request
                .lines()
                .map_while(Result::ok)
                .take_while(|line| !line.is_empty())
                .any(|line| line.eq_ignore_ascii_case("authorization: Bearer test-token"));
            assert!(authenticated);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let file = tempfile::NamedTempFile::new().unwrap();
        let descriptor = serde_json::to_vec(
            &json!({"protocol":"omc.service/1","endpoint":endpoint,"token":"test-token"}),
        )
        .unwrap();
        fs::write(file.path(), &descriptor).unwrap();
        let http = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        assert!(Descriptor::ready(file.path(), &http).unwrap().is_some());
        server.join().unwrap();
        assert!(Descriptor::ready(file.path(), &http).unwrap().is_none());
        assert_eq!(fs::read(file.path()).unwrap(), descriptor);
    }
}

pub struct Bridge {
    pub sender: SyncSender<Request>,
}

impl Bridge {
    pub fn start(profile: PathBuf, proxy: EventLoopProxy<crate::Event>) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Request>(32);
        thread::spawn(move || {
            let mut client = match Client::connect(&profile) {
                Ok(client) => client,
                Err(message) => {
                    let _ = proxy.send_event(crate::Event::Service(Response::Error {
                        message,
                        mutation: false,
                    }));
                    return;
                }
            };
            let _ = proxy.send_event(crate::Event::Service(Response::Connected));
            let mut leases = BTreeSet::new();
            while let Ok(request) = receiver.recv() {
                if matches!(request, Request::Shutdown) {
                    for id in leases {
                        let _ = client.call("workspace.close", json!({"documentId":id}));
                    }
                    let _ = client.call("session.close", json!({}));
                    let _ = proxy.send_event(crate::Event::Service(Response::Shutdown));
                    break;
                }
                let mutation = matches!(
                    request,
                    Request::Command { .. }
                        | Request::Undo { .. }
                        | Request::Splice { .. }
                        | Request::Import
                        | Request::ImportHtml { .. }
                        | Request::Export { .. }
                );
                let response = client
                    .handle(request, &mut leases)
                    .unwrap_or_else(|message| Response::Error { message, mutation });
                if proxy.send_event(crate::Event::Service(response)).is_err() {
                    break;
                }
            }
        });
        Self { sender }
    }

    pub fn send(&self, request: Request) -> Result<(), String> {
        self.sender.try_send(request).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => {
                "The document service is busy. Try again after the pending edit completes."
                    .to_string()
            }
            mpsc::TrySendError::Disconnected(_) => {
                "The document service connection ended. Reopen the app to reconnect.".to_string()
            }
        })
    }
}

struct Client {
    http: reqwest::blocking::Client,
    endpoint: String,
    token: String,
    session: Option<String>,
}

impl Client {
    fn connect(profile: &Path) -> Result<Self, String> {
        let path = profile.join("native-v1/service.json");
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let descriptor = if let Some(descriptor) = Descriptor::ready(&path, &http)? {
            descriptor
        } else {
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            let name = if cfg!(windows) {
                "omc-service.exe"
            } else {
                "omc-service"
            };
            let service = executable.with_file_name(name);
            if !service.is_file() {
                return Err("The document service is not running. Build omc-service beside omc-desktop, or start it with the same --profile path.".into());
            }
            Command::new(service)
                .arg("--profile")
                .arg(profile)
                .arg("--port")
                .arg("0")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Could not start the document service: {e}"))?;
            let until = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(descriptor) = Descriptor::ready(&path, &http)? {
                    break descriptor;
                }
                if Instant::now() >= until {
                    return Err(
                        "The document service did not become ready for this profile.".into(),
                    );
                }
                thread::sleep(Duration::from_millis(100));
            }
        };
        let mut client = Self {
            http,
            endpoint: descriptor.endpoint,
            token: descriptor.token,
            session: None,
        };
        let response = client.call("session.open", json!({"client":"desktop"}))?;
        client.session = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if client.session.is_none() {
            return Err("The service did not establish an editor session.".into());
        }
        Ok(client)
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_limit(method, params, MAX_REPLY_BYTES)
    }
    fn call_limit(&self, method: &str, params: Value, limit: usize) -> Result<Value, String> {
        use std::io::Read;
        let id = Uuid::new_v4().to_string();
        let mut request = self
            .http
            .post(format!("{}/rpc", self.endpoint))
            .bearer_auth(&self.token)
            .json(&json!({"id":id,"method":method,"params":params}));
        if let Some(session) = &self.session {
            request = request.header("X-OMC-Session", session);
        }
        let response = request.send().map_err(|e| format!("The service request could not finish ({e}). Check the saved document before retrying a write."))?;
        let status = response.status();
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err("The service reply exceeds the desktop memory limit.".into());
        }
        let mut bytes = Vec::new();
        response
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > limit {
            return Err("The service reply exceeds the desktop memory limit.".into());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| format!("The service returned an invalid reply ({status})."))?;
        if let Some(error) = value.get("error") {
            return Err(format!(
                "{}: {}",
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("service_error"),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The request could not be completed.")
            ));
        }
        if !status.is_success() {
            return Err(format!("The service returned HTTP {status}."));
        }
        if value.get("id").and_then(Value::as_str) != Some(&id) {
            return Err("The service response has a mismatched request identity.".into());
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| "The service returned no result.".to_string())
    }

    fn snapshot(&self, id: &str, mutation: bool) -> Result<Response, String> {
        let value = self.call("document.snapshot", json!({"documentId":id}))?;
        let document =
            serde_json::from_value(value).map_err(|e| format!("Invalid document snapshot: {e}"))?;
        Ok(Response::Snapshot {
            document,
            mutation,
            activate: false,
        })
    }

    fn import_design(
        &self,
        format: &str,
        bytes: &[u8],
        title: &str,
        leases: &mut BTreeSet<String>,
    ) -> Result<Response, String> {
        let value = self.call(
            "document.import",
            json!({
                "format": format,
                "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
                "title": title,
                "strict": true,
            }),
        )?;
        let document: DocumentSnapshot =
            serde_json::from_value(value).map_err(|e| format!("Invalid imported document: {e}"))?;
        leases.insert(document.id.clone());
        Ok(Response::Snapshot {
            document,
            mutation: true,
            activate: true,
        })
    }

    fn handle(
        &mut self,
        request: Request,
        leases: &mut BTreeSet<String>,
    ) -> Result<Response, String> {
        match request {
            Request::Collaboration { action, mut args } => {
                args["action"] = if action == "host-lan" { "host" } else { action }.into();
                let result = (|| {
                    if action == "host-lan" {
                        // A UDP connect queries the route without sending a packet.
                        let socket =
                            std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
                        socket
                            .connect("192.0.2.1:9")
                            .map_err(|e| format!("No LAN route: {e}"))?;
                        let address = socket.local_addr().map_err(|e| e.to_string())?.ip();
                        if address.is_loopback() || address.is_unspecified() {
                            return Err("No usable LAN interface was found.".into());
                        }
                        args["address"] = address.to_string().into();
                    }
                    let state = self.call("collaboration", args)?;
                    let document = if action == "join" {
                        let id = state["documentId"]
                            .as_str()
                            .ok_or("Joined room returned no document ID.")?;
                        let id = format!(
                            "doc_{}",
                            Uuid::parse_str(id).map_err(|e| e.to_string())?.simple()
                        );
                        let snapshot = self.call("document.snapshot", json!({"documentId":id}))?;
                        let document: DocumentSnapshot =
                            serde_json::from_value(snapshot).map_err(|e| e.to_string())?;
                        leases.insert(document.id.clone());
                        Some(document)
                    } else {
                        None
                    };
                    Ok((state, document))
                })();
                Ok(Response::Collaboration { action, result })
            }
            Request::Refresh => {
                let value = self.call("workspace.list", json!({}))?;
                let documents = serde_json::from_value(
                    value.get("documents").cloned().unwrap_or_else(|| json!([])),
                )
                .map_err(|e| e.to_string())?;
                Ok(Response::Documents(documents))
            }
            Request::Create { title } => {
                let value = self.call("workspace.create", json!({"title":title}))?;
                let document: DocumentSnapshot =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                leases.insert(document.id.clone());
                Ok(Response::Snapshot {
                    document,
                    mutation: false,
                    activate: true,
                })
            }
            Request::Open { id } => {
                let value = self.call("workspace.open", json!({"documentId":id}))?;
                let document = serde_json::from_value(value).map_err(|e| e.to_string())?;
                leases.insert(id);
                Ok(Response::Snapshot {
                    document,
                    mutation: false,
                    activate: true,
                })
            }
            Request::Import => {
                use std::io::Read;
                let Some(path) = rfd::FileDialog::new()
                    .set_title("Import a design")
                    .add_filter(
                        "Supported designs",
                        &["omc", "json", "svg", "html", "htm", "fig", "sketch"],
                    )
                    .add_filter("HTML with CSS", &["html", "htm"])
                    .pick_file()
                else {
                    return Ok(Response::FileOperation {
                        message: "Import dialog closed without a file selection".into(),
                    });
                };
                let format = path
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let format = if format == "htm" {
                    "html"
                } else {
                    format.as_str()
                };
                if !["omc", "json", "svg", "html", "fig", "sketch"].contains(&format) {
                    return Err("Choose a supported design file.".into());
                }
                let file = fs::File::open(&path)
                    .map_err(|e| format!("Could not read the selected design: {e}"))?;
                if file.metadata().map_err(|e| e.to_string())?.len() > MAX_IMPORT_BYTES {
                    return Err("This preview accepts imports up to 32 MiB. The selected file was not imported.".into());
                }
                let mut bytes = Vec::new();
                file.take(MAX_IMPORT_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() as u64 > MAX_IMPORT_BYTES {
                    return Err("The selected design exceeds the 32 MiB import limit.".into());
                }
                let title = path
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .unwrap_or("Imported design");
                self.import_design(format, &bytes, title, leases)
            }
            Request::ImportHtml { html } => {
                let markup = html.trim_start_matches('\u{feff}').trim();
                if !markup.starts_with('<') {
                    return Err("Copy HTML source with its CSS, then choose Paste HTML.".into());
                }
                if markup.len() > MAX_PASTE_HTML_BYTES {
                    return Err(
                        "Paste HTML accepts up to one MiB. Import larger HTML files from disk."
                            .into(),
                    );
                }
                self.import_design("html", markup.as_bytes(), "Imported HTML", leases)
            }
            Request::Export { id, page, title } => {
                use std::io::Write;
                let safe_title: String = title
                    .chars()
                    .map(|c| {
                        if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .take(120)
                    .collect();
                let Some(mut path) = rfd::FileDialog::new()
                    .set_title("Export as .omc, .png, .svg or .pdf")
                    .set_file_name(format!(
                        "{}.omc",
                        if safe_title.is_empty() {
                            "Design"
                        } else {
                            &safe_title
                        }
                    ))
                    .add_filter("Oh My Canvas", &["omc"])
                    .add_filter("PNG image", &["png"])
                    .add_filter("SVG image", &["svg"])
                    .add_filter("PDF document", &["pdf"])
                    .save_file()
                else {
                    return Ok(Response::FileOperation {
                        message: "Export dialog closed without a file selection".into(),
                    });
                };
                if path.extension().is_none() {
                    path.set_extension("omc");
                }
                let format = path
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if !["omc", "png", "svg", "pdf"].contains(&format.as_str()) {
                    return Err("Use .omc, .png, .svg or .pdf for the export file name.".into());
                }
                let value = self.call_limit(
                    "document.export",
                    json!({"documentId":id,"format":format,"pageId":page,"scale":1,"strict":true}),
                    MAX_EXPORT_REPLY_BYTES,
                )?;
                let encoded = value
                    .get("contentBase64")
                    .and_then(Value::as_str)
                    .ok_or("Export returned no file content.")?;
                if encoded.len() > MAX_EXPORT_BYTES.div_ceil(3) * 4 {
                    return Err("The export exceeds this preview's 64 MiB file limit.".into());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| "Export returned invalid file content.")?;
                if bytes.len() > MAX_EXPORT_BYTES {
                    return Err("The export exceeds this preview's 64 MiB file limit.".into());
                }
                let parent = path.parent().unwrap_or(Path::new("."));
                let mut temporary = tempfile::NamedTempFile::new_in(parent)
                    .map_err(|e| format!("Could not prepare the export: {e}"))?;
                temporary
                    .write_all(&bytes)
                    .map_err(|e| format!("Could not write the export: {e}"))?;
                temporary
                    .as_file()
                    .sync_all()
                    .map_err(|e| format!("Could not finish writing the export: {e}"))?;
                temporary
                    .persist(&path)
                    .map_err(|e| format!("Could not install the export file: {e}"))?;
                let diagnostic_count = value
                    .get("diagnostics")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                Ok(Response::FileOperation {
                    message: format!(
                        "Exported {}{}",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        if diagnostic_count == 0 {
                            String::new()
                        } else {
                            format!(" · {diagnostic_count} diagnostics")
                        }
                    ),
                })
            }
            Request::Snapshot { id } => self.snapshot(&id, false),
            Request::Command {
                id,
                epoch,
                sequence,
                command,
                undo_group,
            } => {
                let envelope = json!({"protocol":"omc.engine/1","requestId":Uuid::new_v4().to_string(),"documentId":id,"targetEpoch":epoch,"idempotencyKey":Uuid::new_v4().to_string(),"preconditions":{"revision":{"epoch":epoch,"sequence":sequence.to_string()}},"undoGroup":undo_group,"command":command});
                self.call("document.command", json!({"envelope":envelope}))?;
                self.snapshot(&id, true)
            }
            Request::Undo { id, epoch, redo } => {
                self.call(
                    if redo {
                        "document.redo"
                    } else {
                        "document.undo"
                    },
                    json!({"documentId":id,"targetEpoch":epoch}),
                )?;
                self.snapshot(&id, true)
            }
            Request::CaptureText {
                id,
                node_id,
                epoch,
                sequence,
                start,
                end,
            } => {
                let selection = self.call("document.text_selection", json!({"documentId":id,"nodeId":node_id,"start":start,"end":end,"revision":{"epoch":epoch,"sequence":sequence.to_string()}}))?;
                Ok(Response::TextAnchors {
                    id,
                    node_id,
                    selection,
                })
            }
            Request::Splice {
                id,
                epoch,
                selection,
                text,
            } => {
                let envelope = json!({"protocol":"omc.engine/1","requestId":Uuid::new_v4().to_string(),"documentId":id,"targetEpoch":epoch,"idempotencyKey":Uuid::new_v4().to_string(),"preconditions":{"basis":"latest"},"undoGroup":format!("ime_{}",Uuid::new_v4()),"command":{"type":"text.splice","selection":selection,"text":text,"attributes":{}}});
                self.call("document.command", json!({"envelope":envelope}))?;
                self.snapshot(&id, true)
            }
            Request::Save { id } => {
                self.call("document.save", json!({"documentId":id}))?;
                Ok(Response::Saved { id })
            }
            Request::Close { id } => {
                self.call("workspace.close", json!({"documentId":id}))?;
                leases.remove(&id);
                Ok(Response::Closed { id })
            }
            Request::Shutdown => Ok(Response::Shutdown),
        }
    }
}
