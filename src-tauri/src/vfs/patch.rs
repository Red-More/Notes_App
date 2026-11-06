//! Unified diff support for the version chain.
//!
//! History stores one full baseline plus a unified diff per later revision.
//! The diff is line based and self-contained: hunks use the standard
//! `@@ -old,count +new,count @@` header with three context lines, so it can be
//! replayed without touching the current head blob.

/// Number of unchanged lines kept around each change.
const CONTEXT_LINES: usize = 3;
/// Above this line count the Myers trace becomes too large, so fall back to a
/// single replace-everything hunk. Correctness is unchanged, only compactness.
const MYERS_LINE_LIMIT: usize = 4000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tag {
    Equal,
    Delete,
    Insert,
}

/// One rendered line: `old_pos` / `new_pos` are the 0-based insertion points
/// used to build the hunk header.
#[derive(Clone, Copy, Debug)]
struct Row {
    tag: Tag,
    old_pos: usize,
    new_pos: usize,
}

/// Produce a unified diff from `old` to `new`; identical inputs yield an empty
/// string.
pub fn unified_diff(old: &str, new: &str) -> String {
    let a: Vec<&str> = old.split('\n').collect();
    let b: Vec<&str> = new.split('\n').collect();
    let tags = if a.len() + b.len() > MYERS_LINE_LIMIT {
        coarse_tags(&a, &b)
    } else {
        myers_tags(&a, &b)
    };
    let rows = to_rows(&tags);
    render_hunks(&a, &b, &rows)
}

/// Apply a diff produced by [`unified_diff`]. Returns `None` when the patch is
/// malformed or the context no longer matches.
pub fn apply_unified(old: &str, patch: &str) -> Option<String> {
    if patch.trim().is_empty() {
        return Some(old.to_string());
    }
    let old_lines: Vec<&str> = old.split('\n').collect();
    let mut merged: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut index = 0usize;

    while index < lines.len() {
        if !lines[index].starts_with("@@") {
            index += 1;
            continue;
        }
        let header = lines[index];
        let ranges = header.split("@@").nth(1)?.trim();
        let mut parts = ranges.split_whitespace();
        let (old_start, old_count) = parse_range(parts.next()?.trim_start_matches('-'))?;
        let _new_range = parse_range(parts.next()?.trim_start_matches('+'))?;
        let start = if old_count > 0 {
            old_start.checked_sub(1)?
        } else {
            old_start
        };
        if start < cursor || start > old_lines.len() {
            return None;
        }
        merged.extend(old_lines[cursor..start].iter().map(|line| line.to_string()));
        cursor = start;

        index += 1;
        while index < lines.len() && !lines[index].starts_with("@@") {
            let line = lines[index];
            if line.is_empty() {
                index += 1;
                continue;
            }
            let (prefix, rest) = line.split_at(1);
            match prefix {
                " " => {
                    if old_lines.get(cursor)? != &rest {
                        return None;
                    }
                    merged.push(rest.to_string());
                    cursor += 1;
                }
                "-" => {
                    if old_lines.get(cursor)? != &rest {
                        return None;
                    }
                    cursor += 1;
                }
                "+" => merged.push(rest.to_string()),
                _ => return None,
            }
            index += 1;
        }
    }

    merged.extend(old_lines[cursor..].iter().map(|line| line.to_string()));
    Some(merged.join("\n"))
}

fn parse_range(value: &str) -> Option<(usize, usize)> {
    let mut parts = value.split(',');
    let start = parts.next()?.parse().ok()?;
    let count = match parts.next() {
        Some(raw) => raw.parse().ok()?,
        None => 1,
    };
    Some((start, count))
}

fn to_rows(tags: &[Tag]) -> Vec<Row> {
    let mut rows = Vec::with_capacity(tags.len());
    let mut old_pos = 0usize;
    let mut new_pos = 0usize;
    for tag in tags {
        rows.push(Row {
            tag: *tag,
            old_pos,
            new_pos,
        });
        match tag {
            Tag::Equal => {
                old_pos += 1;
                new_pos += 1;
            }
            Tag::Delete => old_pos += 1,
            Tag::Insert => new_pos += 1,
        }
    }
    rows
}

fn render_hunks(a: &[&str], b: &[&str], rows: &[Row]) -> String {
    let mut included = vec![false; rows.len()];
    for (index, row) in rows.iter().enumerate() {
        if row.tag == Tag::Equal {
            continue;
        }
        let from = index.saturating_sub(CONTEXT_LINES);
        let to = (index + CONTEXT_LINES).min(rows.len().saturating_sub(1));
        for slot in included.iter_mut().take(to + 1).skip(from) {
            *slot = true;
        }
    }

    let mut out = String::new();
    let mut index = 0usize;
    while index < rows.len() {
        if !included[index] {
            index += 1;
            continue;
        }
        let start = index;
        while index < rows.len() && included[index] {
            index += 1;
        }
        let group = &rows[start..index];
        let old_count = group
            .iter()
            .filter(|row| matches!(row.tag, Tag::Equal | Tag::Delete))
            .count();
        let new_count = group
            .iter()
            .filter(|row| matches!(row.tag, Tag::Equal | Tag::Insert))
            .count();
        let old_start = if old_count > 0 {
            group[0].old_pos + 1
        } else {
            group[0].old_pos
        };
        let new_start = if new_count > 0 {
            group[0].new_pos + 1
        } else {
            group[0].new_pos
        };
        out.push_str(&format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
        ));
        for row in group {
            let (prefix, line) = match row.tag {
                Tag::Equal => (' ', a[row.old_pos]),
                Tag::Delete => ('-', a[row.old_pos]),
                Tag::Insert => ('+', b[row.new_pos]),
            };
            out.push(prefix);
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn myers_tags(a: &[&str], b: &[&str]) -> Vec<Tag> {
    let n = a.len();
    let m = b.len();
    let max = n + m;
    if max == 0 {
        return Vec::new();
    }
    let offset = max as isize;
    let size = 2 * max + 1;
    let mut frontier = vec![0isize; size];
    let mut trace: Vec<Vec<isize>> = Vec::new();

    for depth in 0..=max {
        trace.push(frontier.clone());
        for step in 0..=depth {
            let diagonal = -(depth as isize) + 2 * step as isize;
            let slot = (diagonal + offset) as usize;
            let mut x = if diagonal == -(depth as isize)
                || (diagonal != depth as isize && frontier[slot - 1] < frontier[slot + 1])
            {
                frontier[slot + 1]
            } else {
                frontier[slot - 1] + 1
            };
            let mut y = x - diagonal;
            while (x as usize) < n && (y as usize) < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            frontier[slot] = x;
            if x as usize >= n && y as usize >= m {
                return backtrack(&trace, depth, offset, n, m);
            }
        }
    }
    Vec::new()
}

fn backtrack(trace: &[Vec<isize>], found: usize, offset: isize, n: usize, m: usize) -> Vec<Tag> {
    let mut tags = Vec::new();
    let mut x = n as isize;
    let mut y = m as isize;

    for depth in (0..=found).rev() {
        let frontier = &trace[depth];
        let diagonal = x - y;
        let slot = (diagonal + offset) as usize;
        let prev_diagonal = if diagonal == -(depth as isize)
            || (diagonal != depth as isize && frontier[slot - 1] < frontier[slot + 1])
        {
            diagonal + 1
        } else {
            diagonal - 1
        };
        let prev_x = frontier[(prev_diagonal + offset) as usize];
        let prev_y = prev_x - prev_diagonal;
        while x > prev_x && y > prev_y {
            tags.push(Tag::Equal);
            x -= 1;
            y -= 1;
        }
        if depth > 0 {
            if x == prev_x {
                tags.push(Tag::Insert);
                y -= 1;
            } else {
                tags.push(Tag::Delete);
                x -= 1;
            }
        }
    }
    tags.reverse();
    tags
}

/// Cheap fallback: keep the common prefix/suffix and replace the middle block
/// in one hunk. It is still a valid unified diff, just less compact.
fn coarse_tags(a: &[&str], b: &[&str]) -> Vec<Tag> {
    let mut prefix = 0usize;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix + prefix < a.len()
        && suffix + prefix < b.len()
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let mut tags = vec![Tag::Equal; prefix];
    tags.extend(std::iter::repeat_n(Tag::Delete, a.len() - prefix - suffix));
    tags.extend(std::iter::repeat_n(Tag::Insert, b.len() - prefix - suffix));
    tags.extend(std::iter::repeat_n(Tag::Equal, suffix));
    tags
}

#[cfg(test)]
mod tests {
    use super::{apply_unified, unified_diff};

    fn round_trip(old: &str, new: &str) {
        let patch = unified_diff(old, new);
        let replayed = apply_unified(old, &patch).expect("patch must apply");
        assert_eq!(
            replayed, new,
            "patch failed for {old:?} -> {new:?}\n{patch}"
        );
    }

    #[test]
    fn identical_text_produces_empty_patch() {
        let patch = unified_diff("same\nlines\n", "same\nlines\n");
        assert!(patch.is_empty());
    }

    #[test]
    fn round_trips_single_line_edits() {
        round_trip("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
        round_trip("alpha\nbeta\n", "alpha\nbeta\ngamma\n");
        round_trip("alpha\nbeta\ngamma\n", "alpha\ngamma\n");
    }

    #[test]
    fn round_trips_multiple_hunks() {
        let old = (0..20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let new = old
            .replace("line 2", "changed 2")
            .replace("line 17", "changed 17");
        round_trip(&old, &new);
    }

    #[test]
    fn round_trips_empty_documents() {
        round_trip("", "first line\n");
        round_trip("first line\n", "");
        round_trip("", "");
    }

    #[test]
    fn rejects_patch_with_wrong_context() {
        let patch = unified_diff("alpha\nbeta\n", "alpha\nBETA\n");
        assert!(apply_unified("different\ntext\n", &patch).is_none());
    }
}
