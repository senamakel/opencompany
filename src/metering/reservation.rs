//! Promises against the plan's total token ceiling, held while priced work is
//! in flight.
//!
//! The meter only reports work that has **finished**. A gate that compares the
//! meter's `spent` against the ceiling and then dispatches is a check-then-act:
//! several callers read the same `spent`, each finds room, and each dispatches.
//! The ceiling is then exceeded by as many turns as happened to race, and
//! nothing reports it — the console goes on rendering a cap that stopped
//! binding.
//!
//! A promise recorded here is visible to the next caller before that caller
//! looks, because the read and the promise happen under one lock. Overshoot is
//! bounded by the reservation size rather than by how many callers raced.
//!
//! **Process-global, and that is the limit worth stating.** It bounds spend
//! within one host, which is the whole population for a desktop or a
//! single-container tenant. Replicas of one company each hold their own map, so
//! this narrows the window rather than closing it everywhere; closing it across
//! replicas needs a reservation the *meter* can see.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::ports::CompanyId;

use super::CapabilityPlan;

/// One map for every kind of priced work, on purpose: a profile draft and an
/// agent turn spend against the same ceiling, so a promise either of them holds
/// has to be visible to the other. Separate maps would leave exactly the gap
/// this module exists to close.
static IN_FLIGHT: LazyLock<Mutex<HashMap<CompanyId, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A promise to spend at most this many tokens, released when it is dropped.
///
/// Held across the model call and dropped when the work finishes — including on
/// the paths that never reached a provider, because `Drop` does not care why the
/// call ended. A leaked promise would refuse a company its own budget until the
/// process restarted, so nothing here returns a raw number to release by hand.
#[derive(Debug)]
pub struct TokenReservation {
    company: CompanyId,
    tokens: u64,
}

impl Drop for TokenReservation {
    fn drop(&mut self) {
        let mut in_flight = match IN_FLIGHT.lock() {
            Ok(guard) => guard,
            // A poisoned map means another thread panicked mid-update. Taking
            // the inner value is right for a counter of *in-flight* work: the
            // alternative is to leak this reservation forever and refuse the
            // company its budget until restart.
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(total) = in_flight.get_mut(&self.company) {
            *total = total.saturating_sub(self.tokens);
            if *total == 0 {
                in_flight.remove(&self.company);
            }
        }
    }
}

/// Promises `tokens` against the ceiling, or `None` when there is no room.
///
/// `spent` is what the meter reported, which counts only finished work; the
/// promises other callers are holding are added to it here. The check and the
/// promise happen under one lock, which is the whole point: two callers that
/// both read the same `spent` cannot both find room, because the first has
/// recorded its claim before the second looks.
pub fn reserve(
    company: &CompanyId,
    tokens: u64,
    spent: u64,
    plan: &CapabilityPlan,
) -> Option<TokenReservation> {
    let mut in_flight = match IN_FLIGHT.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let promised = in_flight.get(company).copied().unwrap_or(0);
    if plan.total_exhausted(spent.saturating_add(promised)) {
        return None;
    }
    *in_flight.entry(company.clone()).or_insert(0) += tokens;
    Some(TokenReservation {
        company: company.clone(),
        tokens,
    })
}
