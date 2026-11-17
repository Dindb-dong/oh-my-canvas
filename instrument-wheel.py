"""Add a disposable input injector to an isolated native QA build."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
start = '        if self.background\n            && self.shows_library()'
assert source.count(start) == 1
injection = """        if self.background
            && !self.shows_library()
            && job.method == "pointer"
            && job.arguments["kind"] == "hover"
            && let (Some(mode), Some(distance)) =
                (job.arguments["x"].as_f64(), job.arguments["y"].as_f64())
        {
            let viewport = crate::paint::layer_viewport(self);
            self.cursor = (viewport.x + viewport.width / 2., viewport.y + 5.);
            if mode == 3. {
                self.cursor.1 = viewport.y - 5.;
            }
            if mode != 4. {
                let delta = if mode == 2. {
                    MouseScrollDelta::LineDelta(0., -distance as f32)
                } else {
                    MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition::new(0., -distance))
                };
                self.wheel(delta, 2., TouchPhase::Started);
                self.redraw();
            }
            let mut state = self.inspect_automation();
            state["qaLayerScroll"] = json!({
                "offset": self.layer_scroll,
                "rows": self.visible_layers.len(),
                "viewport": viewport.height
            });
            let _ = reply.try_send(Ok(state));
            return;
        }
"""
path.write_text(source.replace(start, injection + start, 1))
