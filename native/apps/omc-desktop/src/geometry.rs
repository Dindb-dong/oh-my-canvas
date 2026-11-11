#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
impl Default for Camera {
    fn default() -> Self {
        Self {
            x: 56.0,
            y: 56.0,
            zoom: 1.0,
        }
    }
}
impl Camera {
    pub fn world(&self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.x) / self.zoom, (y - self.y) / self.zoom)
    }
    pub fn zoom_at(&mut self, factor: f64, x: f64, y: f64) {
        let (wx, wy) = self.world(x, y);
        self.zoom = (self.zoom * factor).clamp(0.05, 16.0);
        self.x = x - wx * self.zoom;
        self.y = y - wy * self.zoom;
    }
    pub fn fit(&mut self, bounds: [f64; 4], width: f64, height: f64) {
        let [x, y, w, h] = bounds;
        self.zoom = ((width - 64.0) / w.max(1.0))
            .min((height - 64.0) / h.max(1.0))
            .clamp(0.05, 4.0);
        self.x = width * 0.5 - (x + w * 0.5) * self.zoom;
        self.y = height * 0.5 - (y + h * 0.5) * self.zoom;
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
pub fn resize(
    original: [f64; 4],
    delta: (f64, f64),
    west: bool,
    north: bool,
    aspect: bool,
) -> [f64; 4] {
    let mut width = (original[2] + if west { -delta.0 } else { delta.0 }).max(1.);
    let mut height = (original[3] + if north { -delta.1 } else { delta.1 }).max(1.);
    if aspect {
        let ratio = original[2].max(1.) / original[3].max(1.);
        if width / original[2].max(1.) > height / original[3].max(1.) {
            height = width / ratio;
        } else {
            width = height * ratio;
        }
    }
    [
        if west {
            original[0] + original[2] - width
        } else {
            original[0]
        },
        if north {
            original[1] + original[3] - height
        } else {
            original[1]
        },
        width,
        height,
    ]
}
impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn anchored_zoom_keeps_world_point() {
        let mut c = Camera::default();
        let before = c.world(430.0, 210.0);
        c.zoom_at(2.1, 430.0, 210.0);
        let after = c.world(430.0, 210.0);
        assert!((before.0 - after.0).abs() < 1e-10);
        assert!((before.1 - after.1).abs() < 1e-10);
    }
    #[test]
    fn resize_keeps_opposite_corner_and_aspect() {
        let result = resize([10., 20., 100., 50.], (-30., -4.), true, true, true);
        assert!((result[0] + result[2] - 110.).abs() < 1e-9);
        assert!((result[1] + result[3] - 70.).abs() < 1e-9);
        assert_eq!(result[2] / result[3], 2.);
    }
}
