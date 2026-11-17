"""Inject native cursor and mouse events in the disposable background test build."""
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
old = "            Event::Automation(job, reply) => self.handle_automation(job, reply),"
new = """            Event::Automation(job, reply)
                if self.background
                    && job.method == "pointer"
                    && job.arguments["kind"] == "click"
                    && self.window.is_some() =>
            {
                let window = self.window.clone().unwrap();
                let canvas = self.canvas_rect();
                let x = canvas.x + self.camera.x
                    + job.arguments["x"].as_f64().unwrap() * self.camera.zoom;
                let y = canvas.y + self.camera.y
                    + job.arguments["y"].as_f64().unwrap() * self.camera.zoom;
                assert!(canvas.contains(x, y), "QA click must land in the native canvas");
                self.controls = crate::paint::controls(self);
                let scale = window.scale_factor() * self.ui_scale();
                let id = window.id();
                let device_id = winit::event::DeviceId::dummy();
                self.window_event(event_loop, id, WindowEvent::CursorMoved {
                    device_id,
                    position: winit::dpi::PhysicalPosition::new(x * scale, y * scale),
                });
                for state in [ElementState::Pressed, ElementState::Released] {
                    self.window_event(event_loop, id, WindowEvent::MouseInput {
                        device_id, state, button: MouseButton::Left,
                    });
                }
                eprintln!("Background QA dispatched CursorMoved and MouseInput");
                let _ = reply.try_send(Ok(self.inspect_automation()));
            }
""" + old
assert source.count(old) == 1
path.write_text(source.replace(old, new))
