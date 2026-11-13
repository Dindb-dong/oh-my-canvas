//! FigCraft v0.17.0 (5bc71c1a), crates/ui-egui/src/tabs.rs, adapted under MIT.

pub const HEIGHT: f64 = 40.;
pub const HOME_X: f64 = if cfg!(target_os = "macos") { 76. } else { 8. };
pub const HOME_WIDTH: f64 = 42.;
pub const MIN_TAB_WIDTH: f64 = 96.;
pub const OVERFLOW_WIDTH: f64 = 32.;
pub const CLOSE_WIDTH: f64 = 32.;
pub const BUTTON_WIDTH: f64 = 32.;

pub struct TabLayout {
    pub first: usize,
    pub widths: Vec<f64>,
    pub overflow: bool,
}

pub fn layout(preferred: &[f64], available: f64, active: Option<usize>) -> TabLayout {
    let count = preferred.len();
    let overflow = count as f64 * MIN_TAB_WIDTH > available;
    let visible = if overflow {
        ((available - OVERFLOW_WIDTH).max(0.) / MIN_TAB_WIDTH).floor() as usize
    } else {
        count
    }
    .min(count);
    let first = active
        .unwrap_or(0)
        .saturating_sub(visible / 2)
        .min(count - visible);
    let mut widths = preferred[first..first + visible].to_vec();
    let budget = (available - if overflow { OVERFLOW_WIDTH } else { 0. }).max(0.);
    let mut excess = (widths.iter().sum::<f64>() - budget).max(0.);
    while excess > 0.01 {
        let flexible = widths
            .iter()
            .filter(|width| **width > MIN_TAB_WIDTH + 0.01)
            .count();
        if flexible == 0 {
            break;
        }
        let share = excess / flexible as f64;
        let mut removed = 0.;
        for width in &mut widths {
            let shrink = (*width - MIN_TAB_WIDTH).max(0.).min(share);
            *width -= shrink;
            removed += shrink;
        }
        excess -= removed;
    }
    TabLayout {
        first,
        widths,
        overflow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_shrink_and_keep_the_active_document_in_view() {
        let two = layout(&[120., 158.], 240., Some(1));
        assert_eq!(two.widths.len(), 2);
        assert!(!two.overflow);
        assert_eq!(two.widths.iter().sum::<f64>(), 240.);
        let many = layout(&[140.; 12], 500., Some(11));
        assert!(many.overflow);
        assert!(many.first <= 11 && many.first + many.widths.len() > 11);
        assert!(many.widths.iter().sum::<f64>() + OVERFLOW_WIDTH <= 500.01);
    }
}
