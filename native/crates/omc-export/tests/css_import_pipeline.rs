use omc_export::{ExportOptions, export};
use omc_import::{ImportOptions, import_bytes};
use omc_model::{DocumentSnapshot, new_id};
use omc_render::EmptyResources;
use omc_scene::{SceneOptions, build_scene};
use skia_safe::{Color, Data, Image};

#[test]
fn imported_grid_selectors_survive_layout_and_png_export() {
    let html = br##"
        <style>
            .grid { display: grid; width: 200px; gap: 10px;
                    grid-template-columns: 40px repeat(2, minmax(0, 1fr)); }
            .card { height: 20px; background-color: #0000ff; }
            .grid > .card:nth-child(2n+1) { background-color: #ff0000; }
            .wide { grid-column: 2 / span 2; }
        </style>
        <body style="margin: 0">
          <div class="grid">
            <div class="card" id="first"></div>
            <div class="card" id="second"></div>
            <div class="card" id="third"></div>
            <div class="card wide" id="fourth"></div>
          </div>
        </body>
    "##;
    let imported = import_bytes(
        "html",
        html,
        &ImportOptions {
            width: 200.,
            height: 60.,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        imported.diagnostics.is_empty(),
        "{:?}",
        imported.diagnostics
    );
    let snapshot = DocumentSnapshot {
        id: new_id("doc"),
        title: imported.content.title,
        epoch: "epoch".into(),
        sequence: 1,
        pages: imported.content.pages,
        nodes: imported.content.nodes,
        metadata: imported.content.metadata,
    };
    let scene = build_scene(
        &snapshot,
        &SceneOptions {
            width: 200.,
            height: 60.,
            strict: true,
            ..Default::default()
        },
    )
    .unwrap();
    for (name, bounds) in [
        ("first", [0., 0., 40., 20.]),
        ("second", [50., 0., 70., 20.]),
        ("third", [130., 0., 70., 20.]),
        ("fourth", [50., 30., 150., 20.]),
    ] {
        assert_eq!(
            scene.bounds(&imported.source_map[&format!("html:#{name}")]),
            Some(bounds),
            "{name}"
        );
    }

    let png = export(
        &snapshot,
        &ExportOptions {
            width: 200.,
            height: 60.,
            ..Default::default()
        },
        &EmptyResources,
    )
    .unwrap();
    assert_eq!(png.media_type, "image/png");
    assert!(png.diagnostics.is_empty(), "{:?}", png.diagnostics);
    let image = Image::from_encoded(Data::new_copy(&png.bytes))
        .unwrap()
        .make_raster_image(None, None)
        .unwrap();
    let pixels = image.peek_pixels().unwrap();
    assert_eq!(pixels.get_color((20, 10)), Color::RED);
    assert_eq!(pixels.get_color((80, 10)), Color::BLUE);
    assert_eq!(pixels.get_color((160, 10)), Color::RED);
    assert_eq!(pixels.get_color((180, 40)), Color::BLUE);
}
