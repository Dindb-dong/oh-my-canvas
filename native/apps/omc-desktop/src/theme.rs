use skia_safe::Color;
use std::cell::Cell;

thread_local! {
    static DARK: Cell<bool> = const { Cell::new(false) };
}

pub struct Scope(bool);

impl Drop for Scope {
    fn drop(&mut self) {
        DARK.set(self.0);
    }
}

pub fn enter(dark: bool) -> Scope {
    Scope(DARK.replace(dark))
}

pub fn color(color: Color) -> Color {
    let rgb = [color.r(), color.g(), color.b()];
    let (darkest, lightest) = (
        rgb.into_iter().min().unwrap(),
        rgb.into_iter().max().unwrap(),
    );
    if !DARK.get() || lightest - darkest > 24 {
        return color;
    }
    let [r, g, b] = rgb.map(|channel| {
        let value = f32::from(channel) / 255.;
        (23. + (1. - value.powf(1.25)) * 219.).round() as u8
    });
    Color::from_argb(color.a(), r, g, b)
}
