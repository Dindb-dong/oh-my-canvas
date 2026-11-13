//! Expressions shared by the native prototype player and its MCP authoring tools.
mod parse;

use crate::{catalog_entities, parse_color};
use omc_model::{DocumentSnapshot, Node};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const INTERACTIONS: &str = "prototypeInteractions";
pub const SETTINGS: &str = "prototypeSettings";
pub const CLICK: &str = "prototypeClickTargetId";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Expr {
    Value(Literal),
    Op { op: Op, args: Vec<Expr> },
    Mode { collection: String },
    InMode { variable: String, mode: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Literal {
    Color(Value),
    Number(f64),
    String(String),
    Boolean(bool),
    Alias(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Add,
    Subtract,
    Multiply,
    Divide,
    Equals,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    And,
    Or,
    Not,
    Negate,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Color,
    Number,
    String,
    Boolean,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Color => "color",
            Self::Number => "number",
            Self::String => "string",
            Self::Boolean => "boolean",
        }
    }

    fn from_id(value: &str) -> Option<Self> {
        Some(match value {
            "color" => Self::Color,
            "number" => Self::Number,
            "string" => Self::String,
            "boolean" => Self::Boolean,
            _ => return None,
        })
    }
}

pub type Overrides = BTreeMap<String, Value>;
pub type Modes = BTreeMap<String, String>;

pub struct Environment<'a> {
    snapshot: &'a DocumentSnapshot,
    variables: BTreeMap<String, Value>,
    collections: BTreeMap<String, Value>,
    values: Overrides,
    modes: Modes,
}

impl<'a> Environment<'a> {
    pub fn new(snapshot: &'a DocumentSnapshot) -> Self {
        Self {
            snapshot,
            variables: catalog_entities(snapshot, "tokens"),
            collections: catalog_entities(snapshot, "figcraftCollections"),
            values: Overrides::new(),
            modes: Modes::new(),
        }
    }

    pub fn set_overrides(&mut self, values: Overrides, modes: Modes) {
        self.values = values;
        self.modes = modes;
    }

    fn lookup<'b>(
        entries: &'b BTreeMap<String, Value>,
        name: &str,
    ) -> Option<(&'b str, &'b Value)> {
        entries
            .get_key_value(name)
            .or_else(|| {
                let mut matches = entries.iter().filter(|(_, entry)| entry["name"] == name);
                matches.next().filter(|_| matches.next().is_none())
            })
            .map(|(id, value)| (id.as_str(), value))
    }

    pub fn variable(&self, name: &str) -> Option<(&str, Kind)> {
        let (id, value) = Self::lookup(&self.variables, name)?;
        Some((id, Kind::from_id(value["type"].as_str()?)?))
    }

    pub fn collection(&self, name: &str) -> Option<&str> {
        Self::lookup(&self.collections, name).map(|(id, _)| id)
    }

    pub fn mode(&self, collection: &str, mode: &str) -> Option<&str> {
        self.collections.get(collection)?["modes"]
            .as_array()?
            .iter()
            .find(|value| value["id"] == mode || value["name"] == mode)?["id"]
            .as_str()
    }

    pub fn variable_mode(&self, variable: &str, mode: &str) -> Option<&str> {
        let (id, _) = self.variable(variable)?;
        self.mode(self.variables[id]["collectionId"].as_str()?, mode)
    }

    pub fn default_condition(&self) -> Expr {
        if let Some((id, _)) = self
            .variables
            .iter()
            .find(|(id, _)| self.variable(id).is_some())
        {
            return Expr::Op {
                op: Op::Equals,
                args: vec![
                    Expr::Value(Literal::Alias(id.clone())),
                    Expr::Value(Literal::Alias(id.clone())),
                ],
            };
        }
        Expr::Value(Literal::Boolean(true))
    }

    fn mode_of<'b>(&'b self, collection: &str, mut node: Option<&'b Node>) -> Option<&'b str> {
        if let Some(mode) = self.modes.get(collection) {
            return Some(mode);
        }
        for _ in 0..256 {
            let Some(layer) = node else { break };
            if let Some(mode) = layer
                .properties
                .get("figcraftVariableModes")
                .and_then(|values| values[collection].as_str())
            {
                return Some(mode);
            }
            node = layer
                .parent_id
                .as_ref()
                .and_then(|id| self.snapshot.nodes.get(id));
        }
        self.collections.get(collection)?["modes"]
            .as_array()?
            .first()?["id"]
            .as_str()
    }

    fn token(
        &self,
        id: &str,
        node: Option<&Node>,
        explicit: Option<(&str, &str)>,
        seen: &mut BTreeSet<String>,
    ) -> Result<Literal, String> {
        if seen.len() > 32 || !seen.insert(id.into()) {
            return Err("Variable alias cycle or depth limit".into());
        }
        let token = self
            .variables
            .get(id)
            .ok_or_else(|| format!("Missing variable {id}"))?;
        let kind = Kind::from_id(token["type"].as_str().unwrap_or_default())
            .ok_or("Invalid variable type")?;
        let collection = token["collectionId"].as_str();
        let explicit_mode =
            explicit.and_then(|(id, mode)| (collection == Some(id)).then_some(mode));
        let authored_mode = collection.and_then(|id| self.mode_of(id, node));
        let value = explicit_mode
            .or(authored_mode)
            .or_else(|| token["activeMode"].as_str())
            .and_then(|mode| token["modes"].get(mode))
            .unwrap_or(&token["value"]);
        let value = if explicit_mode.is_none() {
            self.values.get(id).unwrap_or(value)
        } else {
            value
        };
        if let Some(alias) = value["$token"].as_str() {
            return self.token(alias, node, explicit, seen);
        }
        Literal::from_value(kind, value)
    }

    pub fn parse(&self, input: &str) -> Result<Expr, String> {
        parse::parse(self, input)
    }

    pub fn expression(&self, json: &Value) -> Result<Expr, String> {
        serde_json::from_value(json.clone()).map_err(|error| format!("Invalid expression: {error}"))
    }

    pub fn display(&self, expr: &Expr) -> String {
        self.display_at(expr, 0)
    }

    fn display_at(&self, expr: &Expr, depth: usize) -> String {
        if depth > 32 {
            return "…".into();
        }
        let quoted = |text: &str| serde_json::to_string(text).unwrap();
        let name = |entry: Option<&Value>, fallback: &str| {
            entry
                .and_then(|entry| entry["name"].as_str())
                .unwrap_or(fallback)
                .to_owned()
        };
        let variable = |id: &str| {
            self.variable(id)
                .map(|(id, _)| name(self.variables.get(id), id))
                .unwrap_or_else(|| id.to_owned())
        };
        let name_arg = |name: &str| {
            if name.contains(['"', '\'', '\\', '(', ')', '[', ']', '{', '}']) {
                quoted(name)
            } else {
                name.into()
            }
        };
        match expr {
            Expr::Value(Literal::String(value)) => quoted(value),
            Expr::Value(Literal::Alias(id)) => {
                let name = variable(id);
                if self.parse(&name).ok().as_ref() == Some(expr) {
                    name
                } else {
                    format!("{{{}}}", if name.contains('}') { id } else { &name })
                }
            }
            Expr::Value(value) => value.text(),
            Expr::Mode { collection } => {
                let name = name(
                    self.collection(collection)
                        .and_then(|id| self.collections.get(id)),
                    collection,
                );
                format!("mode({})", name_arg(&name))
            }
            Expr::InMode { variable, mode } => {
                let Some((id, _)) = self.variable(variable) else {
                    return format!("{{{variable}}}[{mode}]");
                };
                let name = self.variables[id]["collectionId"]
                    .as_str()
                    .and_then(|c| self.collections.get(c))
                    .and_then(|c| c["modes"].as_array())
                    .and_then(|modes| {
                        modes
                            .iter()
                            .find(|entry| entry["id"] == *mode || entry["name"] == *mode)
                    });
                format!(
                    "{}[{}]",
                    self.display_at(&Expr::Value(Literal::Alias(id.into())), depth + 1),
                    name_arg(
                        &name
                            .map(|entry| entry["name"].as_str().unwrap_or(mode))
                            .unwrap_or(mode)
                    )
                )
            }
            Expr::Op { op, args } => {
                let parts = args
                    .iter()
                    .map(|part| {
                        let text = self.display_at(part, depth + 1);
                        if matches!(part, Expr::Op { op: Op::Not, .. })
                            || matches!(part,Expr::Op{args,..} if args.len()>1)
                        {
                            format!("({text})")
                        } else {
                            text
                        }
                    })
                    .collect::<Vec<_>>();
                match (op, parts.as_slice()) {
                    (Op::Not, [part]) => format!("not {part}"),
                    (Op::Negate, [part]) => format!("-{part}"),
                    _ => parts.join(&format!(" {} ", op.symbol())),
                }
            }
        }
    }

    pub fn kind(&self, expr: &Expr) -> Result<Kind, String> {
        self.kind_at(expr, 0)
    }

    fn kind_at(&self, expr: &Expr, depth: usize) -> Result<Kind, String> {
        if depth > 32 {
            return Err("Expression nesting exceeds 32".into());
        }
        match expr {
            Expr::Value(Literal::Alias(id)) => self
                .variable(id)
                .map(|(_, kind)| kind)
                .ok_or_else(|| format!("Missing variable {id}")),
            Expr::Value(value) => value
                .kind()
                .ok_or_else(|| "Invalid expression value".into()),
            Expr::Mode { collection } => self
                .collection(collection)
                .map(|_| Kind::String)
                .ok_or_else(|| format!("Missing collection {collection}")),
            Expr::InMode { variable, mode } => self
                .variable_mode(variable, mode)
                .and_then(|_| self.variable(variable))
                .map(|(_, kind)| kind)
                .ok_or_else(|| format!("Unknown variable or mode {variable}[{mode}]")),
            Expr::Op { op, args } => {
                if args.len() > 100 {
                    return Err("Too many expression operands".into());
                }
                let kinds = args
                    .iter()
                    .map(|arg| self.kind_at(arg, depth + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                let all = |kind| kinds.iter().all(|current| *current == kind);
                let kind = match op {
                    Op::Add
                        if kinds.len() >= 2
                            && kinds.contains(&Kind::String)
                            && !kinds.contains(&Kind::Color) =>
                    {
                        Kind::String
                    }
                    Op::Add | Op::Subtract | Op::Multiply | Op::Divide
                        if kinds.len() >= 2 && all(Kind::Number) =>
                    {
                        Kind::Number
                    }
                    Op::Equals | Op::NotEqual if kinds.len() >= 2 && all(kinds[0]) => Kind::Boolean,
                    Op::Less | Op::LessOrEqual | Op::Greater | Op::GreaterOrEqual
                        if kinds.len() == 2 && (all(Kind::Number) || all(Kind::String)) =>
                    {
                        Kind::Boolean
                    }
                    Op::And | Op::Or if kinds.len() >= 2 && all(Kind::Boolean) => Kind::Boolean,
                    Op::Not if kinds == [Kind::Boolean] => Kind::Boolean,
                    Op::Negate if kinds == [Kind::Number] => Kind::Number,
                    _ => return Err("Expression operands do not match the operator".into()),
                };
                Ok(kind)
            }
        }
    }

    pub fn evaluate(&self, expr: &Expr, source: Option<&str>) -> Result<Literal, String> {
        self.kind(expr)?;
        let node = source.and_then(|id| self.snapshot.nodes.get(id));
        self.eval(expr, node)
    }

    fn eval(&self, expr: &Expr, node: Option<&Node>) -> Result<Literal, String> {
        match expr {
            Expr::Value(Literal::Alias(id)) => self.token(
                self.variable(id).ok_or("Missing variable")?.0,
                node,
                None,
                &mut BTreeSet::new(),
            ),
            Expr::Value(value) => Ok(value.clone()),
            Expr::Mode { collection } => {
                let collection = self.collection(collection).ok_or("Missing collection")?;
                let mode = self
                    .mode_of(collection, node)
                    .ok_or("Missing active mode")?;
                self.collections[collection]["modes"]
                    .as_array()
                    .and_then(|modes| modes.iter().find(|m| m["id"] == mode))
                    .and_then(|mode| mode["name"].as_str())
                    .map(|name| Literal::String(name.into()))
                    .ok_or_else(|| "Missing mode name".into())
            }
            Expr::InMode { variable, mode } => {
                let (id, _) = self.variable(variable).ok_or("Missing variable")?;
                let mode = self
                    .variable_mode(id, mode)
                    .ok_or("Missing variable mode")?;
                let collection = self.variables[id]["collectionId"]
                    .as_str()
                    .ok_or("Missing collection")?;
                self.token(id, node, Some((collection, mode)), &mut BTreeSet::new())
            }
            Expr::Op { op, args } => {
                let values = args
                    .iter()
                    .map(|arg| self.eval(arg, node))
                    .collect::<Result<Vec<_>, _>>()?;
                apply(*op, &values).ok_or_else(|| "Expression could not be evaluated".into())
            }
        }
    }
}

impl Op {
    fn symbol(self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Subtract => "-",
            Self::Multiply => "*",
            Self::Divide => "/",
            Self::Equals => "==",
            Self::NotEqual => "!=",
            Self::Less => "<",
            Self::LessOrEqual => "<=",
            Self::Greater => ">",
            Self::GreaterOrEqual => ">=",
            Self::And => "and",
            Self::Or => "or",
            Self::Not => "not",
            Self::Negate => "-",
        }
    }
}

impl Literal {
    pub fn wire(&self) -> Value {
        match self {
            Self::Color(value) => {
                let color = color_hex(value).as_deref().and_then(parse_color);
                json!({"type":"color","value":color})
            }
            other => json!(other),
        }
    }

    pub fn kind(&self) -> Option<Kind> {
        Some(match self {
            Self::Color(color) if color_hex(color).is_some() => Kind::Color,
            Self::Number(number) if number.is_finite() => Kind::Number,
            Self::String(_) => Kind::String,
            Self::Boolean(_) => Kind::Boolean,
            _ => return None,
        })
    }

    pub fn from_value(kind: Kind, value: &Value) -> Result<Self, String> {
        let literal = match kind {
            Kind::Number => value.as_f64().filter(|n| n.is_finite()).map(Self::Number),
            Kind::String => value
                .as_str()
                .map(|s| Self::String(s.chars().take(10_000).collect())),
            Kind::Boolean => value.as_bool().map(Self::Boolean),
            Kind::Color => color_hex(value)
                .as_deref()
                .and_then(parse_color)
                .map(|color| Self::Color(json!(color))),
        };
        literal.ok_or_else(|| format!("Expected a {} value", kind.id()))
    }

    pub fn json(&self) -> Value {
        match self {
            Self::Color(color) => json!(color_hex(color)),
            Self::Number(number) => json!(number),
            Self::String(text) => json!(text),
            Self::Boolean(value) => json!(value),
            Self::Alias(id) => json!({"alias":id}),
        }
    }

    pub fn text(&self) -> String {
        match self {
            Self::Color(color) => color_hex(color).unwrap_or_default(),
            Self::Number(n) => n.to_string(),
            Self::String(s) | Self::Alias(s) => s.clone(),
            Self::Boolean(b) => b.to_string(),
        }
    }
}

pub fn color_hex(value: &Value) -> Option<String> {
    let (r, g, b, a) = if let Some(hex) = value.as_str() {
        let color = parse_color(hex)?;
        (
            (color.r * 255.).round() as u8,
            (color.g * 255.).round() as u8,
            (color.b * 255.).round() as u8,
            (color.a * 255.).round() as u8,
        )
    } else {
        let channel = |key: &str| {
            value[key]
                .as_f64()
                .filter(|v| (0. ..=1.).contains(v))
                .map(|n| (n * 255.).round() as u8)
        };
        (
            channel("r")?,
            channel("g")?,
            channel("b")?,
            channel("a").unwrap_or(255),
        )
    };
    Some(if a == 255 {
        format!("#{r:02X}{g:02X}{b:02X}")
    } else {
        format!("#{r:02X}{g:02X}{b:02X}{a:02X}")
    })
}

fn apply(op: Op, values: &[Literal]) -> Option<Literal> {
    let (first, rest) = values.split_first()?;
    let number = |value: &Literal| {
        if let Literal::Number(n) = value {
            Some(*n)
        } else {
            None
        }
    };
    let same = |a: &Literal, b: &Literal| match (a, b) {
        (Literal::Number(a), Literal::Number(b)) => {
            (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.)
        }
        (Literal::Color(a), Literal::Color(b)) => color_hex(a) == color_hex(b),
        _ => a == b,
    };
    Some(match op {
        Op::Add
            if values
                .iter()
                .any(|value| matches!(value, Literal::String(_))) =>
        {
            let text = values
                .iter()
                .flat_map(|value| value.text().chars().collect::<Vec<_>>())
                .take(10_000)
                .collect();
            Literal::String(text)
        }
        Op::Add | Op::Subtract | Op::Multiply | Op::Divide | Op::Negate => {
            let initial = number(first)?;
            let answer = rest.iter().try_fold(
                if op == Op::Negate { -initial } else { initial },
                |acc, value| {
                    let n = number(value)?;
                    Some(match op {
                        Op::Add => acc + n,
                        Op::Subtract => acc - n,
                        Op::Multiply => acc * n,
                        Op::Divide if n != 0. => acc / n,
                        _ => return None,
                    })
                },
            )?;
            Literal::Number(answer.is_finite().then_some(answer)?)
        }
        Op::Equals | Op::NotEqual => {
            Literal::Boolean(rest.iter().all(|value| same(first, value)) == (op == Op::Equals))
        }
        Op::And => Literal::Boolean(values.iter().all(|value| *value == Literal::Boolean(true))),
        Op::Or => Literal::Boolean(values.iter().any(|value| *value == Literal::Boolean(true))),
        Op::Not => Literal::Boolean(*first == Literal::Boolean(false)),
        Op::Less | Op::LessOrEqual | Op::Greater | Op::GreaterOrEqual => {
            use std::cmp::Ordering::*;
            let order = match (first, &rest[0]) {
                (Literal::Number(a), Literal::Number(b)) => a.partial_cmp(b)?,
                (Literal::String(a), Literal::String(b)) => a.cmp(b),
                _ => return None,
            };
            Literal::Boolean(match op {
                Op::Less => order == Less,
                Op::LessOrEqual => order != Greater,
                Op::Greater => order == Greater,
                _ => order != Less,
            })
        }
    })
}
