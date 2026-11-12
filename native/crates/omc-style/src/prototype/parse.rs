use super::*;

pub(super) fn parse(environment: &Environment, source: &str) -> Result<Expr, String> {
    if source.chars().count() > 4_000 {
        return Err("Keep expressions under 4000 characters".into());
    }
    let mut names = environment
        .variables
        .iter()
        .flat_map(|(id, value)| [Some(id.as_str()), value["name"].as_str()])
        .flatten()
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort_unstable_by_key(|name| std::cmp::Reverse(name.len()));
    let mut parser = Parser {
        environment,
        names,
        rest: source,
    };
    let expr = parser.expression(0, 0)?;
    if parser.rest.trim().is_empty() {
        Ok(expr)
    } else {
        Err(format!("Unexpected expression text: {}", parser.rest))
    }
}

struct Parser<'a, 'b> {
    environment: &'a Environment<'b>,
    names: Vec<&'a str>,
    rest: &'a str,
}

fn boundary(rest: &str) -> bool {
    rest.chars()
        .next()
        .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
}

impl Parser<'_, '_> {
    fn eat(&mut self, symbol: &str) -> bool {
        self.rest = self.rest.trim_start();
        let Some(rest) = self.rest.strip_prefix(symbol) else {
            return false;
        };
        if symbol.chars().all(char::is_alphabetic) && !boundary(rest) {
            return false;
        }
        self.rest = rest;
        true
    }

    fn expression(&mut self, minimum: u8, depth: u8) -> Result<Expr, String> {
        if depth > 32 {
            return Err("Expression nesting exceeds 32".into());
        }
        let mut left = self.primary(depth)?;
        let operators = [
            ("||", Op::Or, 1),
            ("or", Op::Or, 1),
            ("&&", Op::And, 2),
            ("and", Op::And, 2),
            ("==", Op::Equals, 4),
            ("!=", Op::NotEqual, 4),
            ("<=", Op::LessOrEqual, 4),
            (">=", Op::GreaterOrEqual, 4),
            ("=", Op::Equals, 4),
            ("<", Op::Less, 4),
            (">", Op::Greater, 4),
            ("+", Op::Add, 5),
            ("-", Op::Subtract, 5),
            ("*", Op::Multiply, 6),
            ("/", Op::Divide, 6),
        ];
        let mut terms = 1;
        loop {
            let Some((_, op, precedence)) = operators
                .iter()
                .find(|(symbol, _, precedence)| *precedence >= minimum && self.eat(symbol))
            else {
                break;
            };
            let right = self.expression(precedence + 1, depth + 1)?;
            left = Expr::Op {
                op: *op,
                args: vec![left, right],
            };
            terms += 1;
            if terms > 32 {
                return Err("Expression has too many chained operations".into());
            }
        }
        Ok(left)
    }

    fn primary(&mut self, depth: u8) -> Result<Expr, String> {
        self.rest = self.rest.trim_start();
        if self.eat("(") {
            let expr = self.expression(0, depth + 1)?;
            return if self.eat(")") {
                Ok(expr)
            } else {
                Err("Expected closing parenthesis".into())
            };
        }
        if self.rest.starts_with(['"', '\'']) {
            return Ok(Expr::Value(Literal::String(self.quoted()?)));
        }
        if self.eat("#") {
            let digits = self.rest.bytes().take_while(u8::is_ascii_hexdigit).count();
            let hex = color_hex(&json!(format!("#{}", &self.rest[..digits])))
                .ok_or("Invalid color literal")?;
            self.rest = &self.rest[digits..];
            return Ok(Expr::Value(Literal::from_value(Kind::Color, &json!(hex))?));
        }
        if self.eat("true") {
            return Ok(Expr::Value(Literal::Boolean(true)));
        }
        if self.eat("false") {
            return Ok(Expr::Value(Literal::Boolean(false)));
        }
        if self
            .rest
            .strip_prefix("mode")
            .is_some_and(|rest| rest.trim_start().starts_with('('))
        {
            self.eat("mode");
            self.eat("(");
            let name = self.name_arg(')')?;
            let collection = self
                .environment
                .collection(&name)
                .ok_or_else(|| format!("Unknown collection {name}"))?;
            return Ok(Expr::Mode {
                collection: collection.into(),
            });
        }
        if self
            .rest
            .starts_with(|ch: char| ch.is_ascii_digit() || ch == '.')
        {
            let mut end = 0;
            let mut exponent = false;
            let mut sign = false;
            for (index, ch) in self.rest.char_indices() {
                if ch.is_ascii_digit()
                    || (!exponent && ch == '.')
                    || (sign && matches!(ch, '+' | '-'))
                {
                    sign = false;
                } else if !exponent && matches!(ch, 'e' | 'E') {
                    exponent = true;
                    sign = true;
                } else {
                    break;
                }
                end = index + 1;
            }
            if let Ok(value) = self.rest[..end].parse::<f64>()
                && value.is_finite()
            {
                self.rest = &self.rest[end..];
                return Ok(Expr::Value(Literal::Number(value)));
            }
        }
        if self.eat("{") {
            let name = self.name_arg('}')?;
            return self.reference(&name);
        }
        if let Some(name) = self
            .names
            .iter()
            .copied()
            .find(|name| self.rest.strip_prefix(name).is_some_and(boundary))
        {
            self.rest = &self.rest[name.len()..];
            return self.reference(name);
        }
        if self.eat("not") || self.eat("!") {
            return Ok(Expr::Op {
                op: Op::Not,
                args: vec![self.expression(3, depth + 1)?],
            });
        }
        if self.eat("-") {
            return Ok(Expr::Op {
                op: Op::Negate,
                args: vec![self.expression(7, depth + 1)?],
            });
        }
        Err(format!("Expected a value or variable near {}", self.rest))
    }

    fn reference(&mut self, name: &str) -> Result<Expr, String> {
        let variable = self
            .environment
            .variable(name)
            .ok_or_else(|| format!("Unknown variable {name}"))?
            .0
            .to_owned();
        if self.eat("[") {
            let name = self.name_arg(']')?;
            let mode = self
                .environment
                .variable_mode(&variable, &name)
                .ok_or_else(|| format!("Unknown mode {name}"))?;
            Ok(Expr::InMode {
                variable,
                mode: mode.into(),
            })
        } else {
            Ok(Expr::Value(Literal::Alias(variable)))
        }
    }

    fn name_arg(&mut self, close: char) -> Result<String, String> {
        self.rest = self.rest.trim_start();
        if self.rest.starts_with(['"', '\'']) {
            let name = self.quoted()?;
            if self.rest.trim_start().starts_with(close) {
                self.rest = &self.rest.trim_start()[close.len_utf8()..];
                return Ok(name);
            }
        } else if let Some((name, rest)) = self.rest.split_once(close) {
            self.rest = rest;
            return Ok(name.trim().into());
        }
        Err(format!("Expected {close}"))
    }

    fn quoted(&mut self) -> Result<String, String> {
        let quote = self.rest.chars().next().ok_or("Expected quote")?;
        let mut escape = false;
        let mut output = String::new();
        for (index, ch) in self.rest.char_indices().skip(1) {
            if escape {
                output.push(match ch {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == quote {
                self.rest = &self.rest[index + 1..];
                return Ok(output);
            } else {
                output.push(ch);
            }
        }
        Err("Unclosed expression string".into())
    }
}
