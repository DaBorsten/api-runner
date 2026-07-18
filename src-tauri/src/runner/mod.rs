//! Postman-collection runner. Currently a single adapter (`newman`, shelling
//! out to the globally installed newman CLI) behind `report`'s shared result
//! types — add another module + a branch in `lib.rs`'s `run_newman` to bring
//! back a second engine.

pub mod newman;
pub mod report;
