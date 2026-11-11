use base64::{Engine, engine::general_purpose::STANDARD};
use omc_import::{ImportError, ImportOptions, ImportResult, import_bytes};
use omc_model::Node;
use serde_json::Value;

// Synthetic Kiwi 0.5.0 fixtures. Paint names, enum values, and the ColorStop/Matrix
// fields match the embedded schema in fixtures/design-files/iOS-and-iPadOS-27.fig.
const SCHEMA: &str = concat!(
    "dZHdTuMwEIXPuGnYLgihFS/BXbtv4G1CFZGmqH+3K5OarkViR7ZBhadfTYoibriy/enMzJnjq8od9Pa904CYy2ov",
    "NwBonc+3slqUOQDxqIyNZ8l4syqLDAAWa5kVebX9WxZVLtdcNCA+ZcmlA5LVYlf2stHAskIuVxV3Swobte9co6",
    "Jxdu4a5zedqtlTlt/LXbnlkauHUv7pB+2KDCSCDsE4W2S4ADWuVk1/FY/KaxsLe9AnkDi+mgNSUOeC4e64hNjrO",
    "joPEidMQO+YQCxV9OYEStvplGE7nTFup78xwaidMUzaGcNxO2OY9j5BiWf9kdVPrFWsPO8QXQcSda+7/mJh8hk",
    "qRBo5VwFynapNZCujNxPMU6NBSEJ0XcANpdErG56db3GFC/NNWgnu+Dfn/5Q9aoh0WP1LID8g+pHAKJgPjZ9In",
    "k3T9HYCftE4RO9e9PBOlzoExe3IDr0Dbon+Aw=="
);
const EDITABLE: &str = "nY87DoAwDEP9klDOyT1QwwJzj8yvAyu1ZA+WnixjgCMwg0VucUhtvzwFeJW2Yqlb9Unlx3P2fqU3EjZEvVuhv1yMcYWxd9IJ";
const INVALID_STOP: &str =
    "TYpBCoAwEAMzqdZ3+o/S9aJnn+wuXhqYMJBgoCGw4VTz9kjvney1TOnqDlXSNSiLhSPW6X/2rA8=";
const UNSUPPORTED: &str = "nYuxEYAwDAP1dgizMBZ7cDENqRmZEChoie6kQtJjgCMwg1VuqUrn0TwlzIu0ZwvdKj0VH8/x9hvPCP+QflsQPsCJNELlFhc=";

fn import(message: &str, strict: bool) -> Result<ImportResult, ImportError> {
    let mut fig = b"fig-kiwi".to_vec();
    fig.extend(106_u32.to_le_bytes());
    for chunk in [SCHEMA, message] {
        let chunk = STANDARD.decode(chunk).unwrap();
        fig.extend((chunk.len() as u32).to_le_bytes());
        fig.extend(chunk);
    }
    import_bytes(
        "fig",
        &fig,
        &ImportOptions {
            strict,
            ..Default::default()
        },
    )
}

fn rectangle(result: &ImportResult) -> &Node {
    &result.content.nodes[&result.source_map["fig:1:2"]]
}

fn pixel_handle(gradient: &Value, handle: &str) -> (f64, f64) {
    let point = &gradient[handle];
    (
        point["x"].as_f64().unwrap() * 200.,
        point["y"].as_f64().unwrap() * 100.,
    )
}

#[test]
fn imports_affine_linear_and_radial_gradients_as_editable_fills_and_strokes() {
    let result = import(EDITABLE, true).unwrap();
    assert!(result.diagnostics.is_empty());
    let rectangle = rectangle(&result);
    let fills = rectangle.properties["fills"].as_array().unwrap();
    assert_eq!(fills.len(), 3);
    assert_eq!(fills[2]["type"], "linear");
    assert_eq!(fills[2]["visible"], false);
    let linear = &fills[0];
    assert_eq!(linear["type"], "linear");
    assert_eq!(linear["opacity"], 0.75);
    assert_eq!(linear["gradient"]["stops"][0]["offset"], 0.);
    assert_eq!(linear["gradient"]["stops"][0]["color"], "rgba(255,0,0,0.5)");
    assert_eq!(linear["gradient"]["stops"][1]["offset"], 1.);
    assert_eq!(
        rectangle.properties["strokes"][0]["gradient"],
        linear["gradient"]
    );
    let start = pixel_handle(&linear["gradient"], "start");
    let end = pixel_handle(&linear["gradient"], "end");
    let axis = (end.0 - start.0, end.1 - start.1);
    let offset = ((120. - start.0) * axis.0 + (45. - start.1) * axis.1)
        / (axis.0 * axis.0 + axis.1 * axis.1);
    // FIG stop at (x, y): x/200 + 0.5*y/100 - 0.125.
    assert!((offset - 0.7).abs() < 1e-10);

    let radial = &fills[1];
    assert_eq!(radial["type"], "radial");
    let center = pixel_handle(&radial["gradient"], "start");
    assert_eq!(center, (75., 50.));
    let end = pixel_handle(&radial["gradient"], "end");
    let major = (end.0 - center.0, end.1 - center.1);
    let aspect = radial["gradient"]["aspect"].as_f64().unwrap();
    for axis in [major, (-major.1 * aspect, major.0 * aspect)] {
        let gradient_space = (axis.0 / 200. + 0.5 * axis.1 / 100., axis.1 / 100.);
        assert!((gradient_space.0.hypot(gradient_space.1) - 0.5).abs() < 1e-10);
    }
}

#[test]
fn rejects_malformed_gradient_stops_even_in_preview() {
    assert!(
        matches!(import(INVALID_STOP, false), Err(ImportError::Invalid(message)) if message.contains("gradient stops"))
    );
}

#[test]
fn diagnoses_unrepresentable_gradients_without_mislabeling_their_paint_type() {
    let preview = import(UNSUPPORTED, false).unwrap();
    let fills = rectangle(&preview).properties["fills"].as_array().unwrap();
    assert_eq!(fills.len(), 4);
    assert!(fills.iter().all(|paint| paint["type"] == "unsupported"));
    let sources = preview
        .diagnostics
        .iter()
        .map(|item| item.original.as_str())
        .collect::<Vec<_>>();
    assert!(
        sources
            .iter()
            .any(|source| source.contains("singular gradient transform"))
    );
    assert!(
        sources
            .iter()
            .any(|source| source.contains("interpolation"))
    );
    assert!(sources.contains(&"GRADIENT_ANGULAR"));
    assert!(sources.contains(&"GRADIENT_DIAMOND"));
    assert!(matches!(
        import(UNSUPPORTED, true),
        Err(ImportError::Unsupported(_))
    ));
}
