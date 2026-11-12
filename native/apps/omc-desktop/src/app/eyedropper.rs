use super::*;
use skia_safe::{AlphaType, ColorSpace, ColorType, ImageInfo};

impl App {
    pub(super) fn begin_color_pick(&mut self, args: &Value) -> Result<(), String> {
        let apply = args
            .get("apply")
            .map_or(Some(true), Value::as_bool)
            .ok_or("apply must be a boolean.")?;
        self.action(Action::Tool(Tool::Eyedropper));
        self.automation.pick_only = !apply;
        self.automation.picked_color = None;
        Ok(())
    }

    pub(super) fn pick_canvas_color(&mut self, world: (f64, f64)) -> Result<(), String> {
        let scene = self
            .scene
            .as_ref()
            .ok_or("The active canvas did not render.")?;
        let color_info = ImageInfo::new(
            (1, 1),
            ColorType::RGBA8888,
            AlphaType::Premul,
            ColorSpace::new_srgb(),
        );
        let mut surface = skia_safe::surfaces::raster(&color_info, None, None)
            .ok_or("The eyedropper sample surface is unavailable.")?;
        let canvas = surface.canvas();
        canvas.clear(crate::paint::workspace_color());
        let zoom = self.camera.zoom.max(0.01) as f32;
        canvas.translate((0.5, 0.5));
        canvas.scale((zoom, zoom));
        canvas.translate((-world.0 as f32, -world.1 as f32));
        if self.dev_focus_active() {
            if let Some(index) = self.focused_scene_index(scene) {
                omc_render::paint_scene_layers(canvas, scene, &[index], self.resources.as_ref())
                    .map_err(|error| error.to_string())?;
            }
        } else {
            omc_render::paint_scene(canvas, scene, self.resources.as_ref())
                .map_err(|error| error.to_string())?;
        }
        let mut pixel = [0u8; 4];
        if !surface.read_pixels(&color_info, &mut pixel, 4, (0, 0)) {
            return Err("The rendered canvas color could not be read.".into());
        }
        let [red, green, blue, _] = pixel;
        let color = format!("#{red:02X}{green:02X}{blue:02X}");
        self.status = format!("Picked {color}");
        self.automation.picked_color = Some(color.clone());
        self.tool = Tool::Select;
        if self.automation.pick_only {
            return Ok(());
        }
        if self.modifiers.shift_key()
            && (self.modifiers.control_key() || self.modifiers.super_key())
        {
            self.action(Action::Utility(UtilityPopup::PickedColor));
            return Ok(());
        }
        let root = self.current_root();
        let commands: Vec<_> = self
            .selected
            .iter()
            .filter(|id| self.layer_transformable(id) && root.as_ref() != Some(id))
            .flat_map(|id| {
                [
                    json!({"type":"node.unset","nodeId":id,"properties":["fills","fillStyleId"]}),
                    json!({"type":"node.set","nodeId":id,"properties":{"fill":color}}),
                ]
            })
            .collect();
        if !commands.is_empty() {
            self.mutate(json!({"type":"batch","commands":commands}), "pick-color");
        }
        Ok(())
    }

    pub(super) fn create_picked_color(&mut self, namespace: &str) {
        let (Some(document), Some(color)) = (self.document(), self.picked_color()) else {
            return;
        };
        let entries = omc_style::catalog_entities(document, namespace);
        let name = format!("Color {}", entries.len() + 1);
        let command = if namespace == "styles" {
            let order = entries
                .values()
                .filter_map(|style| style["order"].as_u64())
                .max()
                .unwrap_or_default()
                .saturating_add(1);
            json!({"type":"catalog.set","namespace":"styles","entityId":omc_model::new_id("style"),
                "properties":{"name":name,"type":"paint","order":order,
                    "value":[{"type":"solid","color":color}]}})
        } else {
            picked_color_variable(document, &name, color)
        };
        self.mutate(command, "catalog");
    }

    pub(crate) fn picked_color(&self) -> Option<&str> {
        self.automation.picked_color.as_deref()
    }
}

fn picked_color_variable(document: &DocumentSnapshot, name: &str, color: &str) -> Value {
    let collections = omc_style::catalog_entities(document, "figcraftCollections");
    let editable = collections.values().find(|collection| {
        !collection["libraryId"].is_string()
            && !collection["extendsCollection"].is_string()
            && collection["modes"]
                .as_array()
                .is_some_and(|modes| modes.iter().any(|mode| mode["id"].is_string()))
    });
    let mut commands = Vec::new();
    let (collection, modes) = if let Some(collection) = editable {
        (
            collection["id"].as_str().unwrap().to_owned(),
            collection["modes"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|mode| mode["id"].as_str().map(str::to_owned))
                .collect::<Vec<_>>(),
        )
    } else {
        let collection = omc_model::new_id("collection");
        let mode = omc_model::new_id("mode");
        commands.push(json!({"type":"document.metadata","properties":{
            (format!("figcraftCollections/{collection}/name")):"Colors",
            (format!("figcraftCollections/{collection}/modes")):[{"id":mode,"name":"Mode 1"}]
        }}));
        (collection, vec![mode])
    };
    let values: serde_json::Map<String, Value> =
        modes.into_iter().map(|mode| (mode, json!(color))).collect();
    commands.push(json!({"type":"catalog.set","namespace":"tokens","entityId":omc_model::new_id("token"),
        "properties":{"name":name,"type":"color","value":color,"collectionId":collection,"modes":values}}));
    json!({"type":"batch","commands":commands})
}
