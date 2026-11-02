//! Token budget maths for the local engine.
//!
//! Pure functions so the rules can be tested without llama.cpp or the database.

/// Tokens kept free so the sampler always has room for a few more tokens.
const RESERVED_TOKENS: usize = 32;
/// Smallest prompt budget we are willing to work with.
const MIN_PROMPT_TOKENS: usize = 64;

/// Output may use at most half the window, otherwise the prompt has no room.
pub fn output_budget(max_tokens: u32, ctx_window: usize) -> usize {
    (max_tokens as usize).min(ctx_window / 2).max(1)
}

/// Remaining tokens for rendering the prompt and history.
pub fn prompt_budget(ctx_window: usize, output_budget: usize) -> usize {
    ctx_window
        .saturating_sub(output_budget + RESERVED_TOKENS)
        .max(MIN_PROMPT_TOKENS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_capped_at_half_the_window() {
        assert_eq!(output_budget(512, 4096), 512);
        assert_eq!(output_budget(4096, 4096), 2048);
        assert_eq!(output_budget(8192, 2048), 1024);
        assert_eq!(output_budget(1, 2048), 1);
    }

    #[test]
    fn prompt_budget_reserves_output_and_keeps_a_floor() {
        assert_eq!(prompt_budget(4096, 512), 3552);
        assert_eq!(prompt_budget(512, 256), 224);
        assert_eq!(prompt_budget(100, 100), 64);
    }
}
