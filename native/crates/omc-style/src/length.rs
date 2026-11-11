#[derive(Clone, Copy, Debug)]
pub struct LengthContext {
    pub percent_basis: f64,
    pub font_size: f64,
    pub root_font_size: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}
impl Default for LengthContext {
    fn default() -> Self {
        Self {
            percent_basis: 0.,
            font_size: 16.,
            root_font_size: 16.,
            viewport_width: 1440.,
            viewport_height: 900.,
        }
    }
}

/// Evaluates bounded length arithmetic. Unitless numbers are accepted for native design-pixel properties.
pub fn resolve_length(input: &str, context: LengthContext) -> Option<f64> {
    if input.len() > 4096 {
        return None;
    }
    let mut parser = Parser {
        source: input.trim().as_bytes(),
        at: 0,
        context,
        depth: 0,
    };
    let value = parser.expression()?;
    parser.space();
    (parser.at == parser.source.len() && value.is_finite()).then_some(value)
}
struct Parser<'a> {
    source: &'a [u8],
    at: usize,
    context: LengthContext,
    depth: u8,
}
impl Parser<'_> {
    fn space(&mut self) {
        while self
            .source
            .get(self.at)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.at += 1;
        }
    }
    fn expression(&mut self) -> Option<f64> {
        let mut value = self.term()?;
        loop {
            self.space();
            let op = *self.source.get(self.at).unwrap_or(&0);
            if op != b'+' && op != b'-' {
                break;
            }
            self.at += 1;
            let rhs = self.term()?;
            value = if op == b'+' { value + rhs } else { value - rhs };
        }
        Some(value)
    }
    fn term(&mut self) -> Option<f64> {
        let mut value = self.atom()?;
        loop {
            self.space();
            let op = *self.source.get(self.at).unwrap_or(&0);
            if op != b'*' && op != b'/' {
                break;
            }
            self.at += 1;
            let rhs = self.atom()?;
            value = if op == b'*' {
                value * rhs
            } else {
                if rhs == 0. {
                    return None;
                }
                value / rhs
            };
        }
        Some(value)
    }
    fn atom(&mut self) -> Option<f64> {
        self.space();
        self.depth += 1;
        if self.depth > 24 {
            return None;
        }
        let result = self.atom_inner();
        self.depth -= 1;
        result
    }
    fn atom_inner(&mut self) -> Option<f64> {
        let first = *self.source.get(self.at)?;
        if first == b'+' || first == b'-' {
            self.at += 1;
            return self.atom().map(|v| if first == b'-' { -v } else { v });
        }
        if first == b'(' {
            self.at += 1;
            let v = self.expression()?;
            self.space();
            if self.source.get(self.at) != Some(&b')') {
                return None;
            }
            self.at += 1;
            return Some(v);
        }
        if first.is_ascii_alphabetic() {
            let start = self.at;
            while self
                .source
                .get(self.at)
                .is_some_and(u8::is_ascii_alphabetic)
            {
                self.at += 1;
            }
            let name = std::str::from_utf8(&self.source[start..self.at]).ok()?;
            self.space();
            if self.source.get(self.at) != Some(&b'(') {
                return None;
            }
            self.at += 1;
            let mut values = Vec::new();
            loop {
                values.push(self.expression()?);
                self.space();
                match self.source.get(self.at) {
                    Some(b',') => {
                        self.at += 1;
                    }
                    Some(b')') => {
                        self.at += 1;
                        break;
                    }
                    _ => return None,
                }
            }
            return match name {
                "calc" if values.len() == 1 => Some(values[0]),
                "min" => values.into_iter().reduce(f64::min),
                "max" => values.into_iter().reduce(f64::max),
                "clamp" if values.len() == 3 => Some(values[1].min(values[2]).max(values[0])),
                _ => None,
            };
        }
        let start = self.at;
        while self
            .source
            .get(self.at)
            .is_some_and(|c| c.is_ascii_digit() || *c == b'.')
        {
            self.at += 1;
        }
        if start == self.at {
            return None;
        }
        let v = std::str::from_utf8(&self.source[start..self.at])
            .ok()?
            .parse::<f64>()
            .ok()?;
        let start = self.at;
        while self
            .source
            .get(self.at)
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'%')
        {
            self.at += 1;
        }
        let unit = std::str::from_utf8(&self.source[start..self.at]).ok()?;
        let c = self.context;
        Some(
            v * match unit {
                "" | "px" => 1.,
                "%" => c.percent_basis / 100.,
                "em" => c.font_size,
                "rem" => c.root_font_size,
                "vw" => c.viewport_width / 100.,
                "vh" => c.viewport_height / 100.,
                "vmin" => c.viewport_width.min(c.viewport_height) / 100.,
                "vmax" => c.viewport_width.max(c.viewport_height) / 100.,
                _ => return None,
            },
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn responsive_arithmetic_is_not_frozen() {
        let mut c = LengthContext {
            percent_basis: 400.,
            ..Default::default()
        };
        assert_eq!(resolve_length("calc(50% - 2 * 8px)", c), Some(184.));
        c.percent_basis = 800.;
        assert_eq!(
            resolve_length("clamp(100px, calc(50% - 16px), 300px)", c),
            Some(300.)
        );
        assert!(resolve_length("calc(10px / 0)", c).is_none());
        assert!(resolve_length("url(http://example.org)", c).is_none());
    }
}
