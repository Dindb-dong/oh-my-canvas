use base64::Engine;
use omc_import::{ImportError, ImportOptions, import_fig, import_fig_reader};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};

fn editable() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(include_str!("fixtures/editable-fig.base64").trim())
        .unwrap()
}
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn read(bytes: &[u8], working: usize) -> Result<omc_import::ImportResult, ImportError> {
    import_fig_reader(
        Cursor::new(bytes),
        &ImportOptions::default(),
        working,
        &mut |_, _, _| panic!("fixture has no referenced assets"),
        &mut || Ok(()),
    )
}

#[test]
fn reader_preserves_raw_conversion_and_source_identity() {
    let bytes = editable();
    let expected = import_fig(&bytes, &ImportOptions::default()).unwrap();
    let actual = read(&bytes, 1024 * 1024).unwrap();
    assert_eq!(actual.content.metadata, expected.content.metadata);
    assert_eq!(actual.content.nodes.len(), expected.content.nodes.len());
    for (source, target) in &actual.source_map {
        let node = &actual.content.nodes[target];
        let before = &expected.content.nodes[&expected.source_map[source]];
        assert_eq!(node.kind, before.kind);
        assert_eq!(node.properties, before.properties);
    }
    assert!(actual.resources.is_empty());
    assert!(actual.diagnostics.is_empty());
}

#[test]
fn archive_can_exceed_working_reservation_without_retaining_unused_assets() {
    let canvas = editable();
    let unused = vec![0x5a; 2 * 1024 * 1024];
    let bytes = zip(&[("canvas.fig", &canvas), ("images/unused", &unused)]);
    assert!(bytes.len() > 1024 * 1024);
    let actual = read(&bytes, 1024 * 1024).unwrap();
    let expected = import_fig(&bytes, &ImportOptions::default()).unwrap();
    assert_eq!(actual.content.metadata, expected.content.metadata);
    assert_eq!(actual.content.nodes.len(), 3);
    assert!(actual.resources.is_empty());
}

#[test]
fn validates_unused_entry_crc_and_archive_names_before_returning_candidate() {
    let canvas = editable();
    let marker = b"unused-crc-payload-0123456789";
    let mut bytes = zip(&[("canvas.fig", &canvas), ("images/unused", marker)]);
    let at = bytes
        .windows(marker.len())
        .position(|part| part == marker)
        .unwrap();
    bytes[at] ^= 1;
    assert!(read(&bytes, 1024 * 1024).is_err());
    let bytes = zip(&[("canvas.fig", &canvas), ("../escape", b"x")]);
    assert!(matches!(
        read(&bytes, 1024 * 1024),
        Err(ImportError::Invalid(_))
    ));
}

#[test]
fn enforces_input_and_working_limits_and_propagates_cancellation() {
    let bytes = editable();
    assert!(matches!(
        read(&bytes, 8),
        Err(ImportError::ResourceLimit(_))
    ));
    let error = import_fig_reader(
        Cursor::new(&bytes),
        &ImportOptions::default(),
        1024 * 1024,
        &mut |_, _, _| Ok(()),
        &mut || Err(ImportError::Invalid("cancel sentinel".into())),
    );
    assert!(matches!(error, Err(ImportError::Invalid(message)) if message == "cancel sentinel"));
    let options = ImportOptions {
        max_input_bytes: bytes.len() - 1,
        ..Default::default()
    };
    assert!(matches!(
        import_fig_reader(
            Cursor::new(&bytes),
            &options,
            1024 * 1024,
            &mut |_, _, _| Ok(()),
            &mut || Ok(())
        ),
        Err(ImportError::ResourceLimit(_))
    ));
}

// Read+Seek is allowed to return short reads even when more bytes are available.
struct ShortRead(Cursor<Vec<u8>>);
impl Read for ShortRead {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let size = output.len().min(3);
        self.0.read(&mut output[..size])
    }
}
impl Seek for ShortRead {
    fn seek(&mut self, at: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(at)
    }
}
#[test]
fn accumulates_header_across_short_reads() {
    let result = import_fig_reader(
        ShortRead(Cursor::new(editable())),
        &ImportOptions::default(),
        1024 * 1024,
        &mut |_, _, _| Ok(()),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(result.content.metadata["figVersion"], 1);
}

struct ChangedSource {
    reader: Cursor<Vec<u8>>,
    rewinds: usize,
}
impl Read for ChangedSource {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.reader.read(output)
    }
}
impl Seek for ChangedSource {
    fn seek(&mut self, at: SeekFrom) -> std::io::Result<u64> {
        if at == SeekFrom::Start(0) {
            self.rewinds += 1;
            if self.rewinds == 3 {
                self.reader.get_mut()[8] ^= 1;
            }
        }
        self.reader.seek(at)
    }
}
#[test]
fn rejects_source_changes_before_returning_candidate() {
    let result = import_fig_reader(
        ChangedSource {
            reader: Cursor::new(editable()),
            rewinds: 0,
        },
        &ImportOptions::default(),
        1024 * 1024,
        &mut |_, _, _| Ok(()),
        &mut || Ok(()),
    );
    assert!(
        matches!(result, Err(ImportError::Invalid(message)) if message == "FIG source changed during import")
    );
}

fn uint(bytes: &mut Vec<u8>, mut value: u32) {
    while value >= 128 {
        bytes.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
}
fn text(bytes: &mut Vec<u8>, value: &str) {
    bytes.extend(value.as_bytes());
    bytes.push(0);
}
fn definition(schema: &mut Vec<u8>, name: &str, kind: u8, fields: &[(&str, i32, bool)]) {
    text(schema, name);
    schema.push(kind);
    uint(schema, fields.len() as u32);
    for (index, (name, kind, array)) in fields.iter().enumerate() {
        text(schema, name);
        uint(schema, ((*kind << 1) ^ (*kind >> 31)) as u32);
        schema.push(u8::from(*array));
        uint(schema, index as u32 + 1);
    }
}
fn image_fig() -> Vec<u8> {
    let mut schema = vec![6];
    definition(&mut schema, "Message", 2, &[("nodeChanges", 1, true)]);
    definition(
        &mut schema,
        "Node",
        2,
        &[
            ("guid", 2, false),
            ("type", -6, false),
            ("name", -6, false),
            ("parentIndex", 3, false),
            ("fillPaints", 4, true),
        ],
    );
    definition(
        &mut schema,
        "Guid",
        1,
        &[("sessionID", -4, false), ("localID", -4, false)],
    );
    definition(
        &mut schema,
        "Parent",
        1,
        &[("guid", 2, false), ("position", -6, false)],
    );
    definition(
        &mut schema,
        "Paint",
        2,
        &[("type", -6, false), ("image", 5, false)],
    );
    definition(&mut schema, "Image", 2, &[("hash", -6, false)]);
    let mut message = vec![1, 2, 1, 1, 1, 2]; // nodeChanges count2, canvas guid1:1, type
    text(&mut message, "CANVAS");
    message.push(3);
    text(&mut message, "Page");
    message.push(0);
    message.extend([1, 1, 2, 2]);
    text(&mut message, "RECTANGLE");
    message.extend([4, 1, 1]);
    text(&mut message, "a");
    message.extend([5, 2]);
    for _ in 0..2 {
        message.push(1);
        text(&mut message, "IMAGE");
        message.extend([2, 1]);
        text(&mut message, "abc");
        message.extend([0, 0]);
    }
    message.extend([0, 0]);
    let mut fig = b"fig-kiwi".to_vec();
    fig.extend(106_u32.to_le_bytes());
    for bytes in [schema, message] {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&bytes).unwrap();
        let compressed = encoder.finish().unwrap();
        fig.extend((compressed.len() as u32).to_le_bytes());
        fig.extend(compressed);
    }
    fig
}
#[test]
fn streams_referenced_assets_once_and_preserves_paint_hashes() {
    let canvas = image_fig();
    let image = b"\x89PNG\r\n\x1a\nsynthetic";
    let bytes = zip(&[("canvas.fig", &canvas), ("images/abc", image)]);
    let expected = import_fig(&bytes, &ImportOptions::default()).unwrap();
    assert_eq!(expected.resources.len(), 1);
    let mut staged = Vec::new();
    let actual = import_fig_reader(
        Cursor::new(&bytes),
        &ImportOptions::default(),
        1024 * 1024,
        &mut |bytes, media, hash| {
            staged.push((bytes.to_vec(), media.to_owned(), hash.to_owned()));
            Ok(())
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].0, image);
    assert_eq!(staged[0].1, "image/png");
    assert_eq!(staged[0].2, expected.resources[0].hash);
    assert!(actual.resources.is_empty());
    assert_eq!(
        actual.content.nodes[&actual.source_map["fig:1:2"]].properties,
        expected.content.nodes[&expected.source_map["fig:1:2"]].properties
    );
    let failure = import_fig_reader(
        Cursor::new(&bytes),
        &ImportOptions::default(),
        1024 * 1024,
        &mut |_, _, _| Err(ImportError::Invalid("sink sentinel".into())),
        &mut || Ok(()),
    );
    assert!(matches!(failure, Err(ImportError::Invalid(message)) if message == "sink sentinel"));
}
