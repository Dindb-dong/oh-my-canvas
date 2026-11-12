//! Client for the FigCraft v0.17.0 native WebSocket protocol.
use futures_util::{SinkExt, StreamExt};
use omc_protocol::{EngineError, Result};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, client_async_tls_with_config,
    tungstenite::{Bytes, Error as WebSocketError, Message, protocol::WebSocketConfig},
};

pub(crate) const PROTOCOL: u32 = 2;
const WIRE_VERSION: u8 = 1;
// Enum discriminants from crates/collab/src/message.rs at the v0.17.0 tag.
const OPEN_HOSTING: u8 = 12;
const HOSTING: u8 = 12;
const REFUSED: u8 = 6;
const PONG: u8 = 7;
const QUERY_TIMEOUT: Duration = Duration::from_secs(8);
const INFO_LIMIT: usize = 64 * 1024;

pub(crate) struct Reply {
    pub(crate) kind: u8,
    body: Bytes,
}

impl Reply {
    pub(crate) fn decode<T: DeserializeOwned>(&self) -> Result<T> {
        let (result, trailing) = postcard::take_from_bytes(&self.body)
            .map_err(|_| protocol_error("Invalid binary response from FigCraft server"))?;
        if !trailing.is_empty() {
            return Err(protocol_error(
                "Unexpected data after FigCraft server response",
            ));
        }
        Ok(result)
    }
}

pub(crate) struct FigcraftServer {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    limit: usize,
}

impl FigcraftServer {
    pub(crate) async fn connect(server: &str, limit: usize) -> Result<Self> {
        let endpoint = omc_mcp::normalize_figcraft_endpoint(server)?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(limit))
            .max_frame_size(Some(limit))
            .read_buffer_size(8 * 1024);
        let host = endpoint
            .host_str()
            .expect("endpoint validated")
            .trim_matches(['[', ']']);
        let port = endpoint
            .port_or_known_default()
            .expect("endpoint validated");
        let (socket, _) = timeout(QUERY_TIMEOUT, async {
            let tcp = TcpStream::connect((host, port))
                .await
                .map_err(WebSocketError::Io)?;
            client_async_tls_with_config(endpoint.as_str(), tcp, Some(config), None).await
        })
        .await
        .map_err(|_| deadline())?
        .map_err(network)?;
        Ok(Self { socket, limit })
    }

    pub(crate) async fn send(&mut self, kind: u8, request: &impl Serialize) -> Result<()> {
        let bytes = postcard::to_extend(request, vec![WIRE_VERSION, kind])
            .map_err(|_| EngineError::invalid("Cannot encode FigCraft server request"))?;
        if bytes.len() > self.limit {
            return Err(too_large());
        }
        timeout(
            QUERY_TIMEOUT,
            self.socket.send(Message::Binary(bytes.into())),
        )
        .await
        .map_err(|_| deadline())?
        .map_err(network)
    }

    pub(crate) async fn receive(&mut self) -> Result<Reply> {
        timeout(QUERY_TIMEOUT, async {
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Binary(mut bytes))) => {
                        if bytes.len() < 2 || bytes[0] != WIRE_VERSION || bytes[1] > 127 {
                            return Err(protocol_error("Unsupported FigCraft server wire header"));
                        }
                        let header = bytes.split_to(2);
                        let reply = Reply {
                            kind: header[1],
                            body: bytes,
                        };
                        match reply.kind {
                            REFUSED => {
                                let reason: String = reply.decode()?;
                                return Err(EngineError::new("collaboration_error", reason));
                            }
                            PONG if reply.body.is_empty() => (),
                            _ => return Ok(reply),
                        }
                    }
                    Some(Ok(Message::Ping(_))) => self.socket.flush().await.map_err(network)?,
                    Some(Ok(Message::Pong(_))) => (),
                    Some(Ok(Message::Close(_))) | None => {
                        return Err(protocol_error("FigCraft server closed before replying"));
                    }
                    Some(Ok(_)) => {
                        return Err(protocol_error(
                            "Expected a binary reply from FigCraft server",
                        ));
                    }
                    Some(Err(error)) => return Err(network(error)),
                }
            }
        })
        .await
        .map_err(|_| deadline())?
    }
}

#[derive(Deserialize)]
pub(crate) struct Hosting {
    pub(crate) open: bool,
    operator: String,
    terms: String,
    idle_secs: u64,
    max_file_mb: u64,
    expires: Option<u64>,
}

#[derive(Serialize)]
struct OpenHosting<'a> {
    protocol: u32,
    client_version: &'a str,
    file: &'a str,
    owner: &'a str,
}

pub(crate) async fn server_info(arguments: &Value) -> Result<Value> {
    omc_mcp::validate_figcraft_tool("run_command", arguments)?;
    let server = arguments["params"]["server"]
        .as_str()
        .ok_or_else(|| EngineError::invalid("server must be a ws:// or wss:// endpoint"))?;
    timeout(QUERY_TIMEOUT, read_hosting(server))
        .await
        .map_err(|_| deadline())?
}

async fn read_hosting(server: &str) -> Result<Value> {
    let (_, info) = open_hosting(server, "", "", INFO_LIMIT).await?;
    Ok(json!({
        "open":info.open,
        "operator":info.operator,
        "terms":info.terms,
        "idleDays":(info.idle_secs != 0).then_some(info.idle_secs as f64 / 86400.),
        "maxFileMb":info.max_file_mb,
        "expires":info.expires,
    }))
}

pub(crate) async fn open_hosting(
    server: &str,
    file: &str,
    owner: &str,
    limit: usize,
) -> Result<(FigcraftServer, Hosting)> {
    let mut client = FigcraftServer::connect(server, limit).await?;
    client
        .send(
            OPEN_HOSTING,
            &OpenHosting {
                protocol: PROTOCOL,
                client_version: "0.17.0 hosting comments",
                file,
                owner,
            },
        )
        .await?;
    let reply = client.receive().await?;
    if reply.kind != HOSTING {
        return Err(protocol_error(
            "FigCraft server did not return hosting information",
        ));
    }
    Ok((client, reply.decode()?))
}

fn deadline() -> EngineError {
    EngineError::new(
        "dependency_unavailable",
        "FigCraft server request timed out",
    )
}

fn too_large() -> EngineError {
    EngineError::new(
        "resource_limit",
        "FigCraft server message exceeds its size limit",
    )
}

fn protocol_error(message: &str) -> EngineError {
    EngineError::new("collaboration_error", message)
}

fn network(error: WebSocketError) -> EngineError {
    match error {
        WebSocketError::Capacity(_) => too_large(),
        _ => protocol_error("Could not exchange messages with the FigCraft server"),
    }
}
