//! Bounded native reader for the embedded Kiwi schema/wire format used by FIG.
//! Wire semantics were cross-checked with kiwi-schema 0.5.0 (MIT, see licenses).
use super::ImportError;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Debug)]
struct Field {
    name: String,
    kind: i32,
    array: bool,
}
#[derive(Debug)]
struct Definition {
    name: String,
    kind: u8,
    fields: Vec<Field>,
    tags: BTreeMap<u32, usize>,
}
#[derive(Debug, Clone)]
pub(super) struct NonFiniteFloat {
    pub schema_type: String,
    pub field: String,
    pub offset: usize,
    pub bits: u32,
}
impl NonFiniteFloat {
    pub fn kind(&self) -> &'static str {
        if f32::from_bits(self.bits).is_nan() {
            "NaN"
        } else if self.bits >> 31 != 0 {
            "negative infinity"
        } else {
            "positive infinity"
        }
    }
}
pub(super) struct Decoded {
    pub root: Value,
    pub arrays: Vec<Vec<u8>>,
    pub allocation: usize,
    // Only actual wire float primitives can populate this provenance list. Never
    // recognize a nonfinite float by matching a source object's member names.
    pub nonfinite: Vec<NonFiniteFloat>,
}
impl Decoded {
    pub fn bytes(&self, value: &Value) -> Option<&[u8]> {
        let index = value.get("$kiwiBytes")?.as_u64()? as usize;
        self.arrays.get(index).map(Vec::as_slice)
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, ImportError> {
        let byte = *self
            .bytes
            .get(self.offset)
            .ok_or_else(|| invalid("truncated Kiwi input"))?;
        self.offset += 1;
        Ok(byte)
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], ImportError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or_else(|| invalid("Kiwi byte count overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid("truncated Kiwi bytes"))?;
        self.offset = end;
        Ok(bytes)
    }
    fn uint(&mut self) -> Result<u32, ImportError> {
        let mut result = 0u32;
        for shift in [0, 7, 14, 21, 28] {
            let byte = self.byte()?;
            if shift == 28 && byte > 15 {
                return Err(invalid("Kiwi uint overflow"));
            }
            result |= ((byte & 127) as u32) << shift;
            if byte & 128 == 0 {
                return Ok(result);
            }
        }
        Err(invalid("invalid Kiwi uint"))
    }
    fn int(&mut self) -> Result<i32, ImportError> {
        let value = self.uint()?;
        Ok(((value >> 1) as i32) ^ -((value & 1) as i32))
    }
    fn uint64(&mut self) -> Result<u64, ImportError> {
        let mut result = 0u64;
        for shift in [0, 7, 14, 21, 28, 35, 42, 49] {
            let byte = self.byte()?;
            result |= ((byte & 127) as u64) << shift;
            if byte & 128 == 0 {
                return Ok(result);
            }
        }
        result |= (self.byte()? as u64) << 56;
        Ok(result)
    }
    fn string_ref(&mut self) -> Result<&'a str, ImportError> {
        let rest = &self.bytes[self.offset..];
        let length = rest
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| invalid("unterminated Kiwi string"))?;
        if length > 16 * 1024 * 1024 {
            return Err(limit("Kiwi string limit"));
        }
        let value =
            std::str::from_utf8(self.take(length)?).map_err(|_| invalid("invalid Kiwi UTF-8"))?;
        self.byte()?;
        Ok(value)
    }
    fn float(&mut self) -> Result<f32, ImportError> {
        let first = self.byte()?;
        if first == 0 {
            return Ok(0.);
        }
        let tail = self.take(3)?;
        let bits = u32::from_le_bytes([first, tail[0], tail[1], tail[2]]).rotate_left(23);
        // IEEE NaN/infinity are valid Kiwi wire floats. Geometry/style validation
        // happens in the FIG converter; keep the exact f32 bits until then.
        Ok(f32::from_bits(bits))
    }
}

pub(super) fn decode(
    schema_bytes: &[u8],
    message_bytes: &[u8],
    max_bytes: usize,
) -> Result<Decoded, ImportError> {
    decode_inner(schema_bytes, message_bytes, max_bytes, false)
}

pub(super) fn decode_reserved(
    schema_bytes: &[u8],
    message_bytes: &[u8],
    max_bytes: usize,
) -> Result<Decoded, ImportError> {
    decode_inner(schema_bytes, message_bytes, max_bytes, true)
}

fn decode_inner(
    schema_bytes: &[u8],
    message_bytes: &[u8],
    max_bytes: usize,
    reserved: bool,
) -> Result<Decoded, ImportError> {
    let (definitions, schema_allocation) = schema(schema_bytes, max_bytes)?;
    // Schema and graph share the reader reservation; the byte API keeps independent ceilings.
    let max_bytes = if reserved {
        max_bytes
            .checked_sub(schema_allocation)
            .ok_or_else(|| limit("FIG schema reservation exceeded"))?
    } else {
        max_bytes
    };
    let root = definitions
        .iter()
        .position(|d| d.name == "Message")
        .ok_or_else(|| invalid("FIG schema has no Message type"))?;
    let mut decoder = Decoder {
        reader: Reader {
            bytes: message_bytes,
            offset: 0,
        },
        definitions: &definitions,
        arrays: Vec::new(),
        allocation: 0,
        max_bytes,
        values: 0,
        float_field: None,
        nonfinite: Vec::new(),
    };
    let root = decoder.value(root as i32, 0)?;
    if decoder.reader.offset != message_bytes.len() {
        return Err(invalid("trailing FIG message bytes"));
    }
    Ok(Decoded {
        root,
        arrays: decoder.arrays,
        allocation: decoder.allocation,
        nonfinite: decoder.nonfinite,
    })
}
struct SchemaBudget {
    used: usize,
    maximum: usize,
}
impl SchemaBudget {
    fn charge(&mut self, bytes: usize) -> Result<(), ImportError> {
        self.used = self
            .used
            .checked_add(bytes)
            .filter(|used| *used <= self.maximum)
            .ok_or_else(|| limit("FIG schema reservation exceeded"))?;
        Ok(())
    }
}
fn schema(bytes: &[u8], maximum: usize) -> Result<(Vec<Definition>, usize), ImportError> {
    let mut reader = Reader { bytes, offset: 0 };
    let count = reader.uint()? as usize;
    if count > 10000 {
        return Err(limit("Kiwi schema definition limit"));
    }
    if count > (bytes.len() - reader.offset) / 3 {
        return Err(invalid("truncated Kiwi schema definitions"));
    }
    let mut budget = SchemaBudget { used: 0, maximum };
    budget.charge(count.saturating_mul(std::mem::size_of::<Definition>()))?;
    let mut definitions = Vec::with_capacity(count);
    let mut names = std::collections::BTreeSet::new();
    let mut total_fields = 0usize;
    for _ in 0..count {
        let source_name = reader.string_ref()?;
        budget.charge(source_name.len().saturating_add(64))?;
        if !names.insert(source_name) {
            return Err(invalid("duplicate Kiwi definition"));
        }
        let name = source_name.to_owned();
        let kind = reader.byte()?;
        if kind > 2 {
            return Err(invalid("unknown Kiwi definition kind"));
        }
        let count = reader.uint()? as usize;
        total_fields = total_fields
            .checked_add(count)
            .ok_or_else(|| limit("Kiwi aggregate field limit"))?;
        if count > 10000 || total_fields > 100_000 {
            return Err(limit("Kiwi field limit"));
        }
        // A field needs at least a NUL name, type, array bit and tag.
        if count > (bytes.len() - reader.offset) / 4 {
            return Err(invalid("truncated Kiwi schema fields"));
        }
        budget.charge(count.saturating_mul(std::mem::size_of::<Field>()))?;
        let mut fields = Vec::with_capacity(count);
        let mut tags = BTreeMap::new();
        for _ in 0..count {
            let source_name = reader.string_ref()?;
            budget.charge(source_name.len().saturating_add(64))?;
            let name = source_name.to_owned();
            let field_type = reader.int()?;
            let array = reader.byte()? & 1 != 0;
            let tag = reader.uint()?;
            if tags.insert(tag, fields.len()).is_some() {
                return Err(invalid("duplicate Kiwi field tag"));
            }
            fields.push(Field {
                name,
                kind: field_type,
                array,
            });
        }
        definitions.push(Definition {
            name,
            kind,
            fields,
            tags,
        });
    }
    for definition in &definitions {
        if definition.kind != 0 {
            for field in &definition.fields {
                if field.kind >= definitions.len() as i32 || field.kind < -8 {
                    return Err(invalid("Kiwi field type out of range"));
                }
            }
        }
    }
    if reader.offset != bytes.len() {
        return Err(invalid("trailing Kiwi schema bytes"));
    }
    // The borrowed-name index is released before graph allocation.
    Ok((definitions, budget.used.saturating_sub(names.len() * 64)))
}
struct Decoder<'a> {
    reader: Reader<'a>,
    definitions: &'a [Definition],
    arrays: Vec<Vec<u8>>,
    allocation: usize,
    max_bytes: usize,
    values: usize,
    float_field: Option<(&'a str, &'a str)>,
    nonfinite: Vec<NonFiniteFloat>,
}
impl<'a> Decoder<'a> {
    fn charge(&mut self, bytes: usize) -> Result<(), ImportError> {
        self.allocation = self
            .allocation
            .checked_add(bytes)
            .ok_or_else(|| limit("Kiwi allocation overflow"))?;
        if self.allocation > self.max_bytes {
            return Err(limit("decoded FIG allocation reservation exceeded"));
        }
        Ok(())
    }
    fn field(&mut self, field: &Field, depth: usize) -> Result<Value, ImportError> {
        if !field.array {
            return self.value(field.kind, depth + 1);
        }
        let count = self.reader.uint()? as usize;
        if count > 16_000_000 {
            return Err(limit("Kiwi array element limit"));
        }
        if field.kind == -2 {
            self.charge(count + 32)?;
            let bytes = self.reader.take(count)?.to_vec();
            let index = self.arrays.len();
            self.arrays.push(bytes);
            return Ok(json!({"$kiwiBytes":index}));
        }
        self.charge(count.saturating_mul(32))?;
        let mut values = Vec::with_capacity(count);
        for _ in 0..count {
            values.push(self.value(field.kind, depth + 1)?);
        }
        Ok(Value::Array(values))
    }
    fn named_field(
        &mut self,
        definition: &'a Definition,
        field: &'a Field,
        depth: usize,
    ) -> Result<Value, ImportError> {
        let previous = self.float_field.replace((&definition.name, &field.name));
        let value = self.field(field, depth);
        self.float_field = previous;
        value
    }
    fn float_value(&mut self) -> Result<Value, ImportError> {
        let offset = self.reader.offset;
        let value = self.reader.float()?;
        if value.is_finite() {
            return Ok(json!(value as f64));
        }
        let bits = value.to_bits();
        let (schema_type, field) = self.float_field.unwrap_or(("Message", "<root>"));
        if self.nonfinite.len() == self.nonfinite.capacity() {
            let previous = self.nonfinite.capacity();
            let capacity = previous.saturating_mul(2).max(4);
            self.charge(
                (capacity - previous).saturating_mul(std::mem::size_of::<NonFiniteFloat>()),
            )?;
            self.nonfinite
                .try_reserve_exact(capacity - self.nonfinite.len())
                .map_err(|_| limit("Kiwi float provenance allocation failed"))?;
            self.charge(
                self.nonfinite
                    .capacity()
                    .saturating_sub(capacity)
                    .saturating_mul(std::mem::size_of::<NonFiniteFloat>()),
            )?;
        }
        self.charge(schema_type.len() + field.len() + "$kiwiFloatBits".len() + 64)?;
        self.nonfinite.push(NonFiniteFloat {
            schema_type: schema_type.into(),
            field: field.into(),
            offset,
            bits,
        });
        // serde_json would silently turn nonfinite numbers into null. An explicit
        // nonnumeric value keeps number() strict without losing the source bits.
        Ok(json!({"$kiwiFloatBits":bits}))
    }
    fn value(&mut self, kind: i32, depth: usize) -> Result<Value, ImportError> {
        self.values += 1;
        if depth > 128 || self.values > 16_000_000 {
            return Err(limit("Kiwi value/depth limit"));
        }
        if kind < 0 {
            return match kind {
                -1 => Ok(json!(self.reader.byte()? != 0)),
                -2 => Ok(json!(self.reader.byte()?)),
                -3 => Ok(json!(self.reader.int()?)),
                -4 => Ok(json!(self.reader.uint()?)),
                -5 => self.float_value(),
                -6 => {
                    let text = self.reader.string_ref()?;
                    self.charge(text.len() + 24)?;
                    Ok(Value::String(text.to_owned()))
                }
                -7 => {
                    let value = self.reader.uint64()?;
                    Ok(json!(((value >> 1) as i64) ^ -((value & 1) as i64)))
                }
                -8 => Ok(json!(self.reader.uint64()?)),
                _ => Err(invalid("unknown Kiwi primitive")),
            };
        }
        let definition = self
            .definitions
            .get(kind as usize)
            .ok_or_else(|| invalid("unknown Kiwi type"))?;
        if definition.kind == 0 {
            let value = self.reader.uint()?;
            let field = definition
                .tags
                .get(&value)
                .and_then(|i| definition.fields.get(*i))
                .ok_or_else(|| invalid("unknown Kiwi enum value"))?;
            self.charge(field.name.len() + 24)?;
            return Ok(json!(field.name));
        }
        let mut object = Map::new();
        if definition.kind == 1 {
            for field in &definition.fields {
                self.charge(field.name.len() + 64)?;
                object.insert(
                    field.name.clone(),
                    self.named_field(definition, field, depth + 1)?,
                );
            }
        } else {
            loop {
                let tag = self.reader.uint()?;
                if tag == 0 {
                    break;
                }
                let field = definition
                    .tags
                    .get(&tag)
                    .and_then(|i| definition.fields.get(*i))
                    .ok_or_else(|| invalid("unknown Kiwi message field"))?;
                self.charge(field.name.len() + 64)?;
                object.insert(
                    field.name.clone(),
                    self.named_field(definition, field, depth + 1)?,
                );
            }
        }
        Ok(Value::Object(object))
    }
}
fn invalid(message: &str) -> ImportError {
    ImportError::Invalid(message.into())
}
fn limit(message: &str) -> ImportError {
    ImportError::ResourceLimit(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kiwi_wire_floats_preserve_ieee_bits_and_truncation_guards() {
        // Golden exponent-first wire bytes from the upstream Kiwi readVarFloat
        // contract. Its writer represents zero/denormals (including -0) as [0].
        for (wire, bits) in [
            (&[0][..], 0),
            (&[0x7f, 0, 0, 0][..], 0x3f800000),
            (&[0x7f, 1, 0, 0][..], 0xbf800000),
            (&[0xff, 0, 0, 0][..], 0x7f800000),
            (&[0xff, 1, 0, 0][..], 0xff800000),
            (&[0xff, 0, 0, 0x80][..], 0x7fc00000),
            (&[0xff, 0x68, 0x24, 0x80][..], 0x7fc01234),
        ] {
            let mut reader = Reader {
                bytes: wire,
                offset: 0,
            };
            assert_eq!(reader.float().unwrap().to_bits(), bits);
            assert_eq!(reader.offset, wire.len());
        }
        assert!(matches!(
            Reader {
                bytes: &[0xff, 0, 0],
                offset: 0
            }
            .float(),
            Err(ImportError::Invalid(_))
        ));
    }

    #[test]
    fn nonfinite_float_provenance_is_not_inferred_from_object_member_names() {
        let float_schema = b"\x01Message\0\x02\x01n\0\x09\0\x01";
        let decoded = decode(float_schema, &[1, 0xff, 0, 0, 0x80, 0], 4096).unwrap();
        assert_eq!(decoded.root["n"], json!({"$kiwiFloatBits":0x7fc00000_u32}));
        assert!(!decoded.root["n"].is_null());
        assert_eq!(decoded.nonfinite.len(), 1);
        let source = &decoded.nonfinite[0];
        assert_eq!(
            (
                &*source.schema_type,
                &*source.field,
                source.offset,
                source.bits
            ),
            ("Message", "n", 1, 0x7fc00000)
        );
        assert_eq!(source.kind(), "NaN");
        assert!(matches!(
            decode(float_schema, &[1, 0xff, 0, 0, 0x80, 0], 256),
            Err(ImportError::ResourceLimit(_))
        ));
        let object_schema = b"\x01Message\0\x02\x01$kiwiFloatBits\0\x07\0\x01";
        let mut message = vec![1];
        let mut bits = 0x7fc00000_u32;
        while bits >= 128 {
            message.push((bits as u8 & 127) | 128);
            bits >>= 7;
        }
        message.extend([bits as u8, 0]);
        let object = decode(object_schema, &message, 4096).unwrap();
        assert_eq!(object.root, decoded.root["n"]);
        assert!(object.nonfinite.is_empty());
    }

    #[test]
    fn nonfinite_array_elements_keep_the_declaring_field_context() {
        let schema = b"\x01Message\0\x02\x01values\0\x09\x01\x01";
        let message = [1, 2, 0x7f, 0, 0, 0, 0xff, 1, 0, 0, 0];
        let decoded = decode(schema, &message, 4096).unwrap();
        assert_eq!(decoded.root["values"][0], json!(1.));
        assert_eq!(decoded.nonfinite.len(), 1);
        assert_eq!(decoded.nonfinite[0].field, "values");
        assert_eq!(decoded.nonfinite[0].offset, 6);
        assert_eq!(decoded.nonfinite[0].kind(), "negative infinity");
    }
    #[test]
    fn schema_checks_capacities_and_strings_before_materializing_them() {
        let mut definitions = vec![0x90, 0x4e]; // 10000 definitions
        definitions.resize(30002, 0);
        assert!(matches!(
            schema(&definitions, 128),
            Err(ImportError::ResourceLimit(_))
        ));
        let fields = b"\x01Message\0\x02\x90\x4e";
        assert!(matches!(
            schema(fields, 1024 * 1024),
            Err(ImportError::Invalid(_))
        ));
        let mut name = vec![1];
        name.extend(std::iter::repeat_n(b'x', 4096));
        name.extend([0, 2, 0]);
        assert!(matches!(
            schema(&name, 1024),
            Err(ImportError::ResourceLimit(_))
        ));
    }
    #[test]
    fn schema_has_an_aggregate_field_limit() {
        fn uint(bytes: &mut Vec<u8>, mut value: u32) {
            while value >= 128 {
                bytes.push((value as u8 & 127) | 128);
                value >>= 7;
            }
            bytes.push(value as u8);
        }
        let mut bytes = vec![11];
        for index in 0..11 {
            bytes.extend(format!("Type{index}\0").as_bytes());
            bytes.push(2);
            uint(&mut bytes, 10000);
            for tag in 0..10000 {
                bytes.extend([0, 7, 0]);
                uint(&mut bytes, tag);
            }
        }
        assert!(
            matches!(schema(&bytes, 32 * 1024 * 1024), Err(ImportError::ResourceLimit(message)) if message == "Kiwi field limit")
        );
    }
    #[test]
    fn byte_reader_rejects_overflow_and_decodes_rotated_float() {
        let value = 12.5f32;
        let bytes = value.to_bits().rotate_right(23).to_le_bytes();
        assert_eq!(
            Reader {
                bytes: &bytes,
                offset: 0
            }
            .float()
            .unwrap(),
            12.5
        );
        assert!(
            Reader {
                bytes: &[255, 255, 255, 255, 31],
                offset: 0
            }
            .uint()
            .is_err()
        );
    }
    #[test]
    fn schema_driven_message_without_code_generation() {
        let schema = b"\x01Message\0\x02\x01name\0\x0b\0\x01";
        let result = decode(schema, b"\x01Native\0\0", 1024).unwrap();
        assert_eq!(result.root["name"], json!("Native"));
        assert!(decode(schema, b"\x02Native\0\0", 1024).is_err());
    }
}
