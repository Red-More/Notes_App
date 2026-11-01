//! Layer 1 deterministic recognizers.
//!
//! These are checksum-validated, microsecond-level detectors for high-precision
//! entity types. They run on every outbound payload and on document reads, so
//! they must stay allocation-light and predictable. No generative model is used
//! here: an encoder/generative classifier belongs to later phases.

use serde::Serialize;

use super::policy::Level;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedKind {
    GovtId,
    BankCard,
    Phone,
    Email,
    Plate,
    Uscc,
    Secret,
}

impl DetectedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GovtId => "govt_id",
            Self::BankCard => "bank_card",
            Self::Phone => "phone",
            Self::Email => "email",
            Self::Plate => "plate",
            Self::Uscc => "uscc",
            Self::Secret => "secret",
        }
    }

    /// Govt IDs, bank cards and credentials are S0; quasi-identifiers are S1.
    pub fn level(self) -> Level {
        match self {
            Self::GovtId | Self::BankCard | Self::Secret => Level::S0,
            Self::Phone | Self::Email | Self::Plate | Self::Uscc => Level::S1,
        }
    }

    /// Higher priority wins when two recognizers cover the same span.
    fn priority(self) -> u8 {
        match self {
            Self::Secret => 7,
            Self::GovtId => 6,
            Self::Uscc => 5,
            Self::BankCard => 4,
            Self::Phone => 3,
            Self::Email => 2,
            Self::Plate => 1,
        }
    }
}

/// A detected span in character offsets of the original text.
#[derive(Debug, Clone, Copy)]
pub struct Span {
    pub kind: DetectedKind,
    pub start: usize,
    pub end: usize,
}

/// Fold full-width ASCII and the ideographic space into normal ASCII.
/// The mapping is one char to one char, so character offsets stay stable.
pub fn to_halfwidth(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect()
}

/// Scan a text block for all supported entity types.
pub fn scan(text: &str) -> Vec<Span> {
    let chars: Vec<char> = to_halfwidth(text).chars().collect();
    // Separators between digits are folded away so grouped card/ID forms
    // (`4111 1111 ...`, `138-0013-8000`) are detected like plain digits.
    let compact = compact_digits(&chars);
    let runs = compact_digit_runs(&compact);
    let mut spans = Vec::new();
    spans.extend(scan_secrets(&chars));
    spans.extend(scan_government_ids(&compact, &runs));
    spans.extend(scan_bank_cards(&compact, &runs));
    spans.extend(scan_uscc(&chars));
    spans.extend(scan_phones(&compact));
    spans.extend(scan_emails(&chars));
    spans.extend(scan_plates(&chars));
    resolve_overlaps(spans)
}

/// Generic comparison key used by the EDM vault: half-width, lowercase,
/// and with separators removed so variants collapse to one value.
pub fn normalize_generic(text: &str) -> String {
    to_halfwidth(text)
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '—' | '·' | '_'))
        .collect()
}

/// Kind-specific normalization for stored entity values.
pub fn normalize_value(kind: DetectedKind, raw: &str) -> String {
    match kind {
        DetectedKind::Phone | DetectedKind::BankCard => {
            let digits: String = to_halfwidth(raw)
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            if kind == DetectedKind::Phone && digits.len() == 13 && digits.starts_with("86") {
                digits[2..].to_string()
            } else {
                digits
            }
        }
        DetectedKind::Email => to_halfwidth(raw).trim().to_lowercase(),
        DetectedKind::GovtId | DetectedKind::Uscc | DetectedKind::Plate => {
            normalize_generic(raw).to_uppercase()
        }
        DetectedKind::Secret => to_halfwidth(raw).trim().to_string(),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn compact_digit_runs(compact: &[(char, usize)]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut start = None;
    for (i, (c, _)) in compact.iter().enumerate() {
        if c.is_ascii_digit() {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            runs.push((s, i));
        }
    }
    if let Some(s) = start {
        runs.push((s, compact.len()));
    }
    runs
}

fn slice_eq(chars: &[char], start: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    if start + needle.len() > chars.len() {
        return false;
    }
    chars[start..start + needle.len()] == needle[..]
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}')
}

// ---------------------------------------------------------------------------
// Government ID (GB 11643 check digit)
// ---------------------------------------------------------------------------

const ID_WEIGHTS: [u32; 17] = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK: [char; 11] = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

fn gb11643_valid(candidate: &str) -> bool {
    let chars: Vec<char> = candidate.chars().collect();
    if chars.len() != 18 || !chars[..17].iter().all(char::is_ascii_digit) {
        return false;
    }
    let last = chars[17].to_ascii_uppercase();
    if !last.is_ascii_digit() && last != 'X' {
        return false;
    }
    let sum: u32 = chars[..17]
        .iter()
        .enumerate()
        .map(|(i, c)| c.to_digit(10).unwrap_or(0) * ID_WEIGHTS[i])
        .sum();
    ID_CHECK[(sum % 11) as usize] == last
}

fn scan_government_ids(compact: &[(char, usize)], runs: &[(usize, usize)]) -> Vec<Span> {
    let mut spans = Vec::new();
    for &(start, end) in runs {
        let digits = |range: std::ops::Range<usize>| -> String {
            compact[range].iter().map(|(c, _)| *c).collect()
        };
        match end - start {
            18 => {
                let candidate = digits(start..end);
                if gb11643_valid(&candidate) {
                    spans.push(Span {
                        kind: DetectedKind::GovtId,
                        start: compact[start].1,
                        end: compact[end - 1].1 + 1,
                    });
                }
            }
            17 => {
                // The check digit may be `X`, which is not part of the digit run.
                if end < compact.len() && matches!(compact[end].0, 'x' | 'X') {
                    let candidate = format!("{}X", digits(start..end));
                    if gb11643_valid(&candidate) {
                        spans.push(Span {
                            kind: DetectedKind::GovtId,
                            start: compact[start].1,
                            end: compact[end].1 + 1,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    spans
}

// ---------------------------------------------------------------------------
// Bank card (Luhn)
// ---------------------------------------------------------------------------

fn luhn_valid(digits: &[char]) -> bool {
    let mut sum = 0u32;
    let mut double = false;
    for c in digits.iter().rev() {
        let Some(mut value) = c.to_digit(10) else {
            return false;
        };
        if double {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
        double = !double;
    }
    sum % 10 == 0
}

fn scan_bank_cards(compact: &[(char, usize)], runs: &[(usize, usize)]) -> Vec<Span> {
    let mut spans = Vec::new();
    for &(start, end) in runs {
        let digits: Vec<char> = compact[start..end].iter().map(|(c, _)| *c).collect();
        // A CN mobile number must never be reclassified as a bank card.
        if cn_mobile(&digits) {
            continue;
        }
        if (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
            spans.push(Span {
                kind: DetectedKind::BankCard,
                start: compact[start].1,
                end: compact[end - 1].1 + 1,
            });
        }
    }
    spans
}

// ---------------------------------------------------------------------------
// Unified social credit code (GB 32100)
// ---------------------------------------------------------------------------

const USCC_ALPHABET: [char; 31] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J',
    'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'T', 'U', 'W', 'X', 'Y',
];
const USCC_WEIGHTS: [u32; 17] = [
    1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28,
];

fn uscc_valid(window: &[char]) -> bool {
    if window.len() != 18 {
        return false;
    }
    let mut sum = 0u32;
    for (i, c) in window[..17].iter().enumerate() {
        let Some(index) = USCC_ALPHABET
            .iter()
            .position(|x| *x == c.to_ascii_uppercase())
        else {
            return false;
        };
        sum += index as u32 * USCC_WEIGHTS[i];
    }
    let expect = (31 - sum % 31) % 31;
    window[17].to_ascii_uppercase() == USCC_ALPHABET[expect as usize]
}

fn scan_uscc(chars: &[char]) -> Vec<Span> {
    let mut spans = Vec::new();
    if chars.len() < 18 {
        return spans;
    }
    for start in 0..=chars.len() - 18 {
        let end = start + 18;
        let boundary_before = start == 0 || !chars[start - 1].is_ascii_alphanumeric();
        let boundary_after = end == chars.len() || !chars[end].is_ascii_alphanumeric();
        if boundary_before && boundary_after && uscc_valid(&chars[start..end]) {
            spans.push(Span {
                kind: DetectedKind::Uscc,
                start,
                end,
            });
        }
    }
    spans
}

// ---------------------------------------------------------------------------
// Phone (with optional separators)
// ---------------------------------------------------------------------------

/// Drop separators that sit *between* digits so `138-0013-8000`,
/// `138 0013 8000` and `13800138000` collapse into one run.
fn compact_digits(chars: &[char]) -> Vec<(char, usize)> {
    let mut out = Vec::new();
    for (i, &c) in chars.iter().enumerate() {
        let separator = matches!(c, ' ' | '-' | '—' | '·' | '(' | ')');
        if separator {
            let prev_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let next_digit = i + 1 < chars.len() && chars[i + 1].is_ascii_digit();
            if prev_digit && next_digit {
                continue;
            }
        }
        out.push((c, i));
    }
    out
}

fn cn_mobile(digits: &[char]) -> bool {
    match digits.len() {
        11 => digits[0] == '1' && ('3'..='9').contains(&digits[1]),
        13 => {
            digits[0] == '8'
                && digits[1] == '6'
                && digits[2] == '1'
                && ('3'..='9').contains(&digits[3])
        }
        _ => false,
    }
}

fn scan_phones(compact: &[(char, usize)]) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut start = None;
    for (i, (c, _)) in compact.iter().enumerate() {
        if c.is_ascii_digit() {
            start.get_or_insert(i);
            continue;
        }
        if let Some(s) = start.take() {
            push_phone(compact, s, i, &mut spans);
        }
    }
    if let Some(s) = start {
        push_phone(compact, s, compact.len(), &mut spans);
    }
    spans
}

fn push_phone(compact: &[(char, usize)], start: usize, end: usize, spans: &mut Vec<Span>) {
    let digits: Vec<char> = compact[start..end].iter().map(|(c, _)| *c).collect();
    if cn_mobile(&digits) {
        spans.push(Span {
            kind: DetectedKind::Phone,
            start: compact[start].1,
            end: compact[end - 1].1 + 1,
        });
    }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

fn is_local_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

fn is_domain_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-')
}

fn scan_emails(chars: &[char]) -> Vec<Span> {
    let mut spans = Vec::new();
    for (i, &c) in chars.iter().enumerate() {
        if c != '@' {
            continue;
        }
        let mut start = i;
        while start > 0 && is_local_char(chars[start - 1]) {
            start -= 1;
        }
        let mut end = i + 1;
        while end < chars.len() && is_domain_char(chars[end]) {
            end += 1;
        }
        if start == i || end == i + 1 {
            continue;
        }
        let domain = &chars[i + 1..end];
        let Some(dot) = domain.iter().rposition(|c| *c == '.') else {
            continue;
        };
        let tld = &domain[dot + 1..];
        let valid_local = i - start <= 64 && !chars[start].eq(&'.') && !chars[i - 1].eq(&'.');
        let valid_tld = tld.len() >= 2 && tld.iter().all(|c| c.is_ascii_alphabetic());
        if valid_local && valid_tld {
            spans.push(Span {
                kind: DetectedKind::Email,
                start,
                end,
            });
        }
    }
    spans
}

// ---------------------------------------------------------------------------
// License plate
// ---------------------------------------------------------------------------

const PROVINCES: [char; 31] = [
    '京', '津', '沪', '渝', '冀', '豫', '云', '辽', '黑', '湘', '皖', '鲁', '新', '苏', '浙', '赣',
    '鄂', '桂', '甘', '晋', '蒙', '陕', '吉', '闽', '贵', '粤', '青', '藏', '川', '宁', '琼',
];

fn scan_plates(chars: &[char]) -> Vec<Span> {
    let mut spans = Vec::new();
    for (i, &c) in chars.iter().enumerate() {
        if !PROVINCES.contains(&c) {
            continue;
        }
        let Some(&next) = chars.get(i + 1) else {
            continue;
        };
        if !next.is_ascii_uppercase() {
            continue;
        }
        let mut end = i + 2;
        while end < chars.len() && (chars[end].is_ascii_alphanumeric() || is_cjk(chars[end])) {
            end += 1;
        }
        let len = end - i - 2;
        if (5..=6).contains(&len) {
            spans.push(Span {
                kind: DetectedKind::Plate,
                start: i,
                end,
            });
        }
    }
    spans
}

// ---------------------------------------------------------------------------
// Secrets: PEM private keys, well-known API key prefixes, URL credentials
// ---------------------------------------------------------------------------

const KEY_PREFIXES: [&str; 8] = [
    "sk-", "sk_live_", "ghp_", "xoxb-", "xapp-", "AKIA", "AIza", "hf_",
];

fn scan_secrets(chars: &[char]) -> Vec<Span> {
    let mut spans = Vec::new();
    scan_pem(&mut spans, chars);
    scan_api_keys(&mut spans, chars);
    scan_url_credentials(&mut spans, chars);
    spans
}

fn scan_pem(spans: &mut Vec<Span>, chars: &[char]) {
    for i in 0..chars.len() {
        if !slice_eq(chars, i, "-----BEGIN") {
            continue;
        }
        let limit = (i + 80).min(chars.len());
        for j in i..limit {
            if slice_eq(chars, j, "PRIVATE KEY-----") {
                spans.push(Span {
                    kind: DetectedKind::Secret,
                    start: i,
                    end: j + "PRIVATE KEY-----".chars().count(),
                });
                break;
            }
        }
    }
}

fn scan_api_keys(spans: &mut Vec<Span>, chars: &[char]) {
    for prefix in KEY_PREFIXES {
        let needle: Vec<char> = prefix.chars().collect();
        for i in 0..chars.len() {
            if !slice_eq(chars, i, prefix) {
                continue;
            }
            let token_start = i + needle.len();
            let mut end = token_start;
            while end < chars.len()
                && (chars[end].is_ascii_alphanumeric() || matches!(chars[end], '_' | '-'))
            {
                end += 1;
            }
            if end - token_start >= 16 {
                spans.push(Span {
                    kind: DetectedKind::Secret,
                    start: i,
                    end,
                });
            }
        }
    }
}

fn scan_url_credentials(spans: &mut Vec<Span>, chars: &[char]) {
    for i in 0..chars.len() {
        if !slice_eq(chars, i, "://") {
            continue;
        }
        let mut end = i + 3;
        while end < chars.len() && !chars[end].is_whitespace() && !matches!(chars[end], '"' | '\'')
        {
            end += 1;
        }
        let authority = &chars[i + 3..end];
        if let Some(at) = authority.iter().position(|c| *c == '@') {
            if authority[..at].contains(&':') {
                spans.push(Span {
                    kind: DetectedKind::Secret,
                    start: i,
                    end,
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Overlap resolution
// ---------------------------------------------------------------------------

fn resolve_overlaps(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(|a, b| {
        b.kind
            .priority()
            .cmp(&a.kind.priority())
            .then_with(|| (b.end - b.start).cmp(&(a.end - a.start)))
            .then(a.start.cmp(&b.start))
    });
    let mut kept: Vec<Span> = Vec::new();
    for candidate in spans {
        let overlaps = kept
            .iter()
            .any(|s| candidate.start < s.end && s.start < candidate.end);
        if !overlaps {
            kept.push(candidate);
        }
    }
    kept.sort_by_key(|s| s.start);
    kept
}
