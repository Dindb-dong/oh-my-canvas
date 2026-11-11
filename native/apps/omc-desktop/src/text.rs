//! Native edit buffer. The buffer is a private preview, never a saved document.
//! Its commit is a strict-revision range transaction; a conflicting remote edit
//! preserves the preview as recoverable text instead of replacing shared state.
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug)]
pub struct EditBuffer {
    pub text: String,
    pub original: String,
    pub caret: usize,
    pub anchor: usize,
    pub preedit: String,
    pub preedit_selection: Option<(usize, usize)>,
    pub composing: bool,
}

impl EditBuffer {
    pub fn new(text: String, select_all: bool) -> Self {
        let end = text.len();
        Self {
            original: text.clone(),
            text,
            caret: end,
            anchor: if select_all { 0 } else { end },
            preedit: String::new(),
            preedit_selection: None,
            composing: false,
        }
    }
    pub fn selection(&self) -> std::ops::Range<usize> {
        self.caret.min(self.anchor)..self.caret.max(self.anchor)
    }
    pub fn insert(&mut self, input: &str) {
        let range = self.selection();
        let caret = range.start + input.len();
        self.text.replace_range(range, input);
        self.caret = caret;
        self.anchor = caret;
    }
    pub fn backspace(&mut self) {
        if self.selection().is_empty() {
            self.anchor = previous_grapheme(&self.text, self.caret);
        }
        self.insert("");
    }
    pub fn delete(&mut self) {
        if self.selection().is_empty() {
            self.anchor = next_grapheme(&self.text, self.caret);
        }
        self.insert("");
    }
    pub fn move_left(&mut self, extend: bool) {
        self.caret = if !extend && !self.selection().is_empty() {
            self.selection().start
        } else {
            previous_grapheme(&self.text, self.caret)
        };
        if !extend {
            self.anchor = self.caret;
        }
    }
    pub fn move_right(&mut self, extend: bool) {
        self.caret = if !extend && !self.selection().is_empty() {
            self.selection().end
        } else {
            next_grapheme(&self.text, self.caret)
        };
        if !extend {
            self.anchor = self.caret;
        }
    }
    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.caret = self.text.len();
    }
    pub fn selected_text(&self) -> &str {
        &self.text[self.selection()]
    }
    #[cfg(test)]
    pub fn utf16_caret(&self) -> usize {
        self.text[..self.caret].encode_utf16().count()
    }
    pub fn set_preedit(&mut self, text: String, selection: Option<(usize, usize)>) {
        self.composing = !text.is_empty();
        self.preedit = text;
        self.preedit_selection = selection;
    }
    pub fn commit_ime(&mut self, text: &str) {
        self.preedit.clear();
        self.preedit_selection = None;
        self.composing = false;
        self.insert(text);
    }
    pub fn display_text(&self) -> String {
        let mut display = self.text.clone();
        if !self.preedit.is_empty() {
            display.replace_range(self.selection(), &self.preedit);
        }
        display
    }
    /// Smallest scalar-boundary replacement. The engine captures observed
    /// character identities at the strict source revision when applying it.
    pub fn replacement(&self) -> (u32, u32, String) {
        let mut start = 0;
        for (a, b) in self.original.chars().zip(self.text.chars()) {
            if a != b {
                break;
            }
            start += a.len_utf8();
        }
        let mut old_end = self.original.len();
        let mut new_end = self.text.len();
        for (a, b) in self.original[start..]
            .chars()
            .rev()
            .zip(self.text[start..].chars().rev())
        {
            if a != b {
                break;
            }
            old_end -= a.len_utf8();
            new_end -= b.len_utf8();
        }
        (
            self.original[..start].encode_utf16().count() as u32,
            self.original[..old_end].encode_utf16().count() as u32,
            self.text[start..new_end].to_string(),
        )
    }
}

fn previous_grapheme(text: &str, offset: usize) -> usize {
    text[..offset]
        .grapheme_indices(true)
        .next_back()
        .map_or(0, |(i, _)| i)
}
fn next_grapheme(text: &str, offset: usize) -> usize {
    text[offset..]
        .graphemes(true)
        .next()
        .map_or(text.len(), |s| offset + s.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_and_delete_respect_grapheme_clusters() {
        let mut b = EditBuffer::new("가👩‍💻e\u{301}".into(), false);
        b.backspace();
        assert_eq!(b.text, "가👩‍💻");
        b.move_left(false);
        assert_eq!(b.utf16_caret(), 1);
        b.delete();
        assert_eq!(b.text, "가");
    }
    #[test]
    fn replacement_uses_utf16_without_splitting_surrogates() {
        let mut b = EditBuffer::new("A😀Z".into(), false);
        b.move_left(false);
        b.insert("한글");
        assert_eq!(b.replacement(), (3, 3, "한글".into()));
    }
    #[test]
    fn ime_preedit_is_private_until_commit() {
        let mut b = EditBuffer::new("hello".into(), true);
        b.set_preedit("안녕".into(), Some((3, 6)));
        assert_eq!(b.text, "hello");
        assert_eq!(b.display_text(), "안녕");
        b.commit_ime("안녕");
        assert_eq!(b.replacement(), (0, 5, "안녕".into()));
    }
    #[test]
    fn no_change_and_middle_deletion_have_minimal_ranges() {
        let b = EditBuffer::new("abcd".into(), false);
        assert_eq!(b.replacement(), (4, 4, String::new()));
        let mut b = b;
        b.text = "ad".into();
        assert_eq!(b.replacement(), (1, 3, String::new()));
    }
}
