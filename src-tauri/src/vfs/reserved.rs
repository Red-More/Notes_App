//! Reserved per-directory config folders and files.
//!
//! Two independent systems live next to user documents:
//! - `.agent`               — model-internal configuration (rules, skills);
//! - `.lifeos/ai.policy`    — folder visibility permissions;
//! - `<dir>/ai.policy`      — alternative visibility location at the folder root.
//!
//! None of them is ever model-visible or model-writable, and no configuration
//! can grant them. This module only owns the shared path conventions; each
//! system keeps its own parser and semantics.

use super::cap_gate::ROOT;

/// Model-internal configuration folder.
pub const AGENT_DIR: &str = ".agent";
/// Folder visibility configuration.
pub const LIFEOS_DIR: &str = ".lifeos";
/// Config file inside `.agent`.
pub const CONFIG_FILE: &str = ".meta.json";
/// Visibility policy file; looked up inside `.lifeos` and at the folder root.
pub const POLICY_FILE: &str = "ai.policy";

/// True when the segment names one of the reserved config folders.
pub fn is_config_segment(segment: &str) -> bool {
    segment == AGENT_DIR || segment == LIFEOS_DIR
}

/// True when any path segment equals `segment`.
pub fn has_segment(path: &str, segment: &str) -> bool {
    path.split('/').any(|part| part == segment)
}

/// True when any path segment is reserved, e.g. `/life/notes/.agent/x`.
pub fn is_config_path(path: &str) -> bool {
    path.split('/').any(is_config_segment)
}

/// True when the file name is the visibility policy.
pub fn is_policy_file(path: &str) -> bool {
    path.rsplit('/').next() == Some(POLICY_FILE)
}

/// Any path the model may never read or write.
pub fn is_reserved_path(path: &str) -> bool {
    is_config_path(path) || is_policy_file(path)
}

/// Folder that hosts the `.agent` directory on this path, e.g.
/// `/life/notes/.agent/skills/x` → `/life/notes`.
///
/// Returns `None` when the path has no `.agent` segment or starts with it.
pub fn agent_owner(path: &str) -> Option<&str> {
    let marker = "/.agent";
    let mut from = 0;
    while let Some(offset) = path[from..].find(marker) {
        let start = from + offset;
        let after = start + marker.len();
        // Only a full segment counts: `/.agent` or `/.agent/...`.
        if after == path.len() || path.as_bytes().get(after) == Some(&b'/') {
            return if start == 0 {
                None
            } else {
                Some(&path[..start])
            };
        }
        from = after;
    }
    None
}

/// Directory that owns a config file, e.g.
/// `/life/notes/.lifeos/ai.policy` + (`lifeos`, `ai.policy`) → `/life/notes`.
pub fn owner_of_config(path: &str, folder: &str, file: &str) -> Option<String> {
    path.strip_suffix(&format!("/{folder}/{file}"))
        .filter(|owner| !owner.is_empty())
        .map(str::to_string)
}

/// Ancestor chain from `/life` down to the path itself.
///
/// A file path is included as its own last element; it never owns a config and
/// therefore has no effect.
pub fn lineage(path: &str) -> Vec<String> {
    if path == ROOT {
        return vec![ROOT.to_string()];
    }
    if !path.starts_with("/life/") {
        return Vec::new();
    }
    let mut result = vec![ROOT.to_string()];
    let mut current = ROOT.to_string();
    for segment in path["/life/".len()..].split('/').filter(|s| !s.is_empty()) {
        current.push('/');
        current.push_str(segment);
        result.push(current.clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_owner_returns_the_folder_before_the_segment() {
        assert_eq!(
            agent_owner("/life/.agent/skills/global/SKILL.md"),
            Some("/life")
        );
        assert_eq!(agent_owner("/life/.agent"), Some("/life"));
        assert_eq!(
            agent_owner("/life/notes/.agent/skills/x/SKILL.md"),
            Some("/life/notes")
        );
    }

    #[test]
    fn agent_owner_rejects_partial_segments_and_rootless_paths() {
        assert_eq!(agent_owner("/life/.agentx/file"), None);
        assert_eq!(agent_owner("/life/notes"), None);
        assert_eq!(agent_owner("/.agent/skills/x"), None);
    }
}
