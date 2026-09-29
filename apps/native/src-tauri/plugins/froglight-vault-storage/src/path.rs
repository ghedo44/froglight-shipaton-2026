use crate::error::VaultStorageError;

pub fn normalize_relative_path(input: &str) -> Result<String, VaultStorageError> {
    // Strict portable semantics: `.`, `..`, repeated empty
    // segments, NUL, and backslash are rejected — never silently normalized.
    // The TS portable layer (`isValidWorkspacePath`) enforces the same rule,
    // so the native boundary must agree or providers diverge.
    let trimmed = input.trim().replace('\\', "/");
    if trimmed.contains('\0') || input.contains('\0') || input.contains('\\') {
        return Err(VaultStorageError::InvalidPath(input.to_string()));
    }
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        return Err(VaultStorageError::InvalidPath(input.to_string()));
    }
    let mut out = Vec::new();
    for (index, segment) in trimmed.split('/').enumerate() {
        if segment.is_empty() || segment == "." {
            return Err(VaultStorageError::InvalidPath(input.to_string()));
        }
        if segment == ".." || (index == 0 && segment.contains(':')) {
            return Err(VaultStorageError::InvalidPath(input.to_string()));
        }
        out.push(segment);
    }
    Ok(out.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_traversal_and_nul_paths() {
        for bad in ["/a", "/a/b", "a/../b", "a/./b", "..", "a/..", "a\\b", "\\", "a\0b", "~/x"] {
            assert!(
                normalize_relative_path(bad).is_err(),
                "path {bad:?} must be INVALID_PATH"
            );
        }
    }

    #[test]
    fn accepts_root_and_nested_portable_paths() {
        assert_eq!(normalize_relative_path("").unwrap(), "");
        assert_eq!(normalize_relative_path("a/b/c").unwrap(), "a/b/c");
    }

    #[test]
    fn rejects_dot_and_empty_segments_strictly() {
        // `.` And `a//b` are INVALID_PATH, never normalized.
        for bad in ["a//b", "a/./b", "./a", "a/."] {
            assert!(
                normalize_relative_path(bad).is_err(),
                "path {bad:?} must be INVALID_PATH"
            );
        }
    }

    #[test]
    fn preserves_unicode_and_case_exactly() {
        let name = "MixedCase-你好-😀.txt";
        assert_eq!(normalize_relative_path(name).unwrap(), name);
    }

    #[test]
    fn error_code_is_invalid_path() {
        let err = normalize_relative_path("../escape").unwrap_err();
        assert_eq!(err.code(), "INVALID_PATH");
    }
}
