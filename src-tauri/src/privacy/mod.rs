//! Privacy core (Phase A): data tiers, deterministic recognizers, EDM vault,
//! and the single egress gate used before any cloud request leaves the app.
//!
//! Hard rules:
//! - S0 documents never leave the device; detection can only raise a level.
//! - Every decision is audited with counts only, never document text.
//! - The WebView cannot bypass the gate: judgment happens inside Rust.

pub mod egress;
pub mod entity;
pub mod policy;
pub mod recognizers;
